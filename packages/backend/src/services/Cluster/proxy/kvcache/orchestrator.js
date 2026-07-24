// ─────────────────────────────────────────────────────────────────────────────
// KvOrchestrator  — the tiered KV request handler
// ─────────────────────────────────────────────────────────────────────────────
// One instance per llama.cpp service (keyed by stable fingerprint). Ties together
// fingerprint (the shared-pool key + boundary salt), boundaries (content-addressed
// prefix hashes over the tokens llama really processes), the SQLite index (persistent
// Optane snapshot rows), and the SlotPool (per-slot mutexes).
//
// Request lifecycle (called from handleChatWithTools in proxy.js):
//   const ticket = await orch.prepare(body);   // mutates body: sets id_slot + cache_prompt
//   … proxy forwards body to llama (stream or buffered) …
//   orch.release(ticket, { completed, totalTokens }); // bg: save (scheme B) + release slot
//
// Tiering (plan §2, one-directional VRAM → RAM → Optane):
//   • Tier 0/1 (VRAM + llama --cache-ram): warm-slot affinity. If a slot still holds this
//     prefix from a prior turn, reuse THAT slot and SKIP the Optane restore — llama matches
//     its resident KV natively. Never clobber a warm slot with an Optane restore.
//   • Tier 2 (Optane): only when no warm slot covers it — a genuinely cold prefix, a fresh
//     slot, post-restart, or a prefix ANOTHER instance computed (cross-instance, §4a).
//
// Save gate fixes Fable bug #2 (warm-path save suppression): the save baseline (parentN)
// comes from the persisted index match, NOT the previous turn's boundary — so an
// interactive conversation keeps saving as it grows, even on the warm (no-restore) path.

import { chunkBoundaryHashes, hasMultimodalContent, capMessagesAtFirstImage } from './boundaries.js';
import { SlotPool } from './slot-pool.js';
import { CloneWorker } from './clone-worker.js';

export const DEFAULT_CONFIG = {
  chunkSize: 256,              // boundary granularity (tokens)
  minMatchTokens: 2048,        // don't bother restoring/affinity below this
  minSaveDeltaTokens: 4096,    // only save when the prefix grew this much past the baseline
  costBenefitRatio: 0.5,       // require match_n / file_total_n ≥ this to restore (guards legacy rows)
  bytesPerToken: 38912,        // ~38 KB/token @ 27B q8 (Fable budget) — for LRU/budget accounting
  staleReleaseSec: 300,        // safety sweep: force-release a slot held longer than this
  // Background clone worker (step 4): materialize shared boundaries as exact snapshots.
  cloneEnabled: true,          // master switch for the clone worker (KV-on implies this)
  cloneMinShareCount: 2,       // materialize a boundary once seen in ≥ this many requests
  cloneStride: 8192,           // ONLY materialize boundaries whose token-count is a multiple of this (coarse; kills the 256-tok cascade). 0/falsy = every chunk.
  cloneMinTokens: 2048,        // ...only if it's a substantial prefix (align w/ minMatchTokens)
  cloneMaxPending: 512,        // candidate frequency-map cap
  cloneMaxQueue: 32,           // in-flight clone-queue cap
  cloneIdleWaitMs: 1500,       // backoff when no idle slot is available for a clone
  // Reaper (step 5): keep the per-fp Optane pool within budget + purge stale-version rows.
  optaneBudgetBytes: 100 * 2 ** 30,  // per-fp Optane byte budget (byte-accurate LRU target)
  initialBudgetFraction: 0.2,        // fraction of the Optane budget reserved for 'initial' prefixes (rest → 'running')
  deferToLlama: false,               // 2a (flag-gated, per-service): don't pin id_slot — defer slot pick to llama-native (--slot-prompt-similarity + --cache-ram); Optane seeds cold slots only. Default off = unchanged pinning behavior.
  seedDedupTtlMs: 120000,            // 2a defer path: skip re-seeding a prefix already seeded within this window (llama --cache-ram very likely still resident → avoid redundant Optane restore + slot contention).
  reaperIntervalSec: 300,            // reaper sweep cadence (seconds)
};

export class KvOrchestrator {
  /**
   * @param {object} o
   * @param {import('./upstream.js').Upstream} o.upstream
   * @param {import('./index-store.js').KvIndex} o.index
   * @param {string}   o.fp              stable fingerprint (index model_fp + boundary salt)
   * @param {string}   o.slotName        fp dir name (llama --slot-save-path basename)
   * @param {number}   o.stateSeqVersion LLAMA_STATE_SEQ_VERSION carried per row
   * @param {number[]} o.slotIds         llama slot ids (from --parallel)
   * @param {number}   o.slotNCtx        destination slot n_ctx (runtime over-restore guard)
   * @param {object}   [o.config]        overrides for DEFAULT_CONFIG
   * @param {object}   [o.log]           logger with .info/.warn (optional)
   */
  constructor(o) {
    this.upstream = o.upstream;
    this.index = o.index;
    this.fp = o.fp;
    this.slotName = o.slotName;
    this.stateSeqVersion = o.stateSeqVersion;
    this.slotNCtx = o.slotNCtx || Infinity;
    this.cfg = { ...DEFAULT_CONFIG, ...(o.config || {}) };
    this.log = o.log || null;

    this.pool = new SlotPool(o.slotIds);
    this.slotHolds = new Map();   // slotId → boundaries (warm affinity, VRAM tier)
    this._recentSeeds = new Map(); // hash → ms of last defer-path seed (seed-dedup TTL)
    this._bg = new Set();         // STRONG refs to background tasks (shim deadlocked without this)
    this._sweeper = null;

    this.stats = {
      requests: 0, vramHits: 0, optaneHits: 0, misses: 0,
      saves: 0, saveBytes: 0, restoreMsTotal: 0, skipped: 0,
    };

    // Instantiated last so it captures the initialized this.stats object.
    this.cloneWorker = new CloneWorker({
      upstream: this.upstream, index: this.index, pool: this.pool, fp: this.fp,
      stateSeqVersion: this.stateSeqVersion, config: this.cfg, stats: this.stats,
      fireAndForget: (fn) => this._fireAndForget(fn), log: this.log,
    });
  }

  _log(level, ...a) { try { this.log?.[level]?.(...a); } catch { /* noop */ } }

  /** Keep a strong reference to a background task so it can't be GC'd mid-await. */
  _fireAndForget(factory) {
    const p = Promise.resolve()
      .then(factory)
      .catch((e) => this._log('warn', `[kv ${this.slotName}] bg task failed: ${e?.message || e}`))
      .finally(() => this._bg.delete(p));
    this._bg.add(p);
    return p;
  }

  /** FREE slot whose resident prefix shares the longest boundary-prefix with `boundaries`. */
  _findWarmSlot(boundaries) {
    if (!boundaries.length) return null;
    const reqHashes = boundaries.map(([, h]) => h);
    let best = null;
    for (const [sid, held] of this.slotHolds) {
      const lock = this.pool.locks.get(sid);
      if (!lock || lock.locked || !held || !held.length) continue;
      const heldHashes = held.map(([, h]) => h);
      let common = 0;
      const lim = Math.min(heldHashes.length, reqHashes.length);
      for (let i = 0; i < lim; i++) { if (heldHashes[i] === reqHashes[i]) common++; else break; }
      if (common === 0) continue;
      const [n, hsh] = held[common - 1];
      if (!best || n > best.n) best = { slot: sid, n, hash: hsh };
    }
    return best && best.n >= this.cfg.minMatchTokens ? best : null;
  }

  /**
   * Compute boundaries, pick a slot (tiered), restore from Optane if cold, and pin the
   * request to the slot. MUTATES body (id_slot, cache_prompt). Always returns a ticket;
   * ticket.slotId===null means "not cached — forward untouched, nothing to release".
   */
  async prepare(body) {
    this.stats.requests++;
    const messages = body && body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      this.stats.skipped++;
      return { slotId: null, boundaries: [] };
    }

    // Multimodal option B: cache only the pure-text prefix before the first image.
    let effMessages = messages;
    if (hasMultimodalContent(messages)) {
      const capped = capMessagesAtFirstImage(messages);
      effMessages = capped.messages;
      if (!effMessages.length) { this.stats.skipped++; return { slotId: null, boundaries: [] }; }
    }

    // Tokens llama actually processes → content-correct boundaries (fixes Fable bug d).
    let boundaries = [];
    let tokensN = 0;
    let tokens = [];
    let promptStr = '';
    try {
      promptStr = await this.upstream.applyTemplate(effMessages, body.tools);
      tokens = await this.upstream.tokenize(promptStr);
      tokensN = tokens.length;
      boundaries = chunkBoundaryHashes(tokens, this.cfg.chunkSize, this.fp);
    } catch (e) {
      // Tokenize/template failed → serve without caching rather than fail the request.
      this._log('warn', `[kv ${this.slotName}] boundary compute failed: ${e?.message || e}`);
      this.stats.skipped++;
      return { slotId: null, boundaries: [] };
    }

    // Persistent baseline (used for BOTH the restore decision and the save gate).
    let cacheRow = boundaries.length
      ? this.index.longestMatch(this.fp, boundaries, this.stateSeqVersion, { minMatchTokens: this.cfg.minMatchTokens })
      : null;
    // Runtime over-restore guard (Fable Q1): never restore more tokens than the slot's ctx.
    if (cacheRow && cacheRow.n_tokens > this.slotNCtx) cacheRow = null;
    // Cost/benefit gate (Fable bug c): skip a match that drags too much extra file.
    if (cacheRow && cacheRow.file_total_n > 0 &&
        cacheRow.n_tokens / cacheRow.file_total_n < this.cfg.costBenefitRatio) cacheRow = null;

    let parentHash = cacheRow ? cacheRow.hash : null;
    let parentN = cacheRow ? cacheRow.n_tokens : 0;

    // Tier 0/1 first: warm slot beats an Optane restore if it covers at least as much.
    const warm = this._findWarmSlot(boundaries);

    // Increment 2a (flag-gated, default off): defer slot selection to llama-native.
    if (this.cfg.deferToLlama) {
      return this._prepareDeferred(body, { tokens, boundaries, promptStr, cacheRow, warm });
    }
    let slotId = null;
    let usedWarm = false;
    let cacheHit = false;

    if (warm && warm.n >= parentN && this.pool.acquireSpecific(warm.slot)) {
      slotId = warm.slot;
      usedWarm = true;
      cacheHit = true;
      this.stats.vramHits++;
      this._log('info', `[kv ${this.slotName}] WARM slot=${slotId} reuse ${warm.n} resident tokens (no restore)`);
    } else {
      slotId = await this.pool.acquire();
      if (cacheRow) {
        const t0 = Date.now();
        try {
          await this.upstream.slotRestore(slotId, cacheRow.filename);
          const dt = Date.now() - t0;
          this.stats.optaneHits++;
          this.stats.restoreMsTotal += dt;
          this.index.bumpHit(cacheRow.hash, Math.floor(Date.now() / 1000));
          cacheHit = true;
          this._log('info', `[kv ${this.slotName}] HIT slot=${slotId} ${cacheRow.n_tokens} tok restored ${dt}ms (${String(cacheRow.filename).slice(0, 16)})`);
        } catch (e) {
          // Restore failed (e.g. the .bin was reaped, or no KV space): treat as a true cold
          // miss — reset the save baseline so the full prefix we're about to reprocess gets saved
          // (otherwise a stale parentN suppresses the re-save; also drop the dangling index row).
          this._log('warn', `[kv ${this.slotName}] restore failed (miss): ${e?.message || e}`);
          try { if (cacheRow) this.index.del(cacheRow.hash); } catch { /* best-effort */ }
          parentHash = null; parentN = 0;
          this.stats.misses++;
        }
      } else {
        this.stats.misses++;
      }
    }

    // DIAGNOSTIC (2026-07-24, Optane restore investigation): whenever a LARGE prompt gets only a
    // SMALL prefix match (the "full reprocess" symptom), log exactly how much matched vs total so a
    // repro is unambiguous — tells us if it's a real content mismatch vs a legit cold/other-agent miss.
    try {
      const bestMatch = Math.max(parentN || 0, (warm && warm.n) || 0);
      if (tokensN >= 8192 && bestMatch < tokensN * 0.5) {
        const idxCount = (this.index && typeof this.index.stats === 'function') ? (this.index.stats(this.fp) || {}).n : '?';
        this._log('info', `[kv ${this.slotName}] LOWMATCH tokensN=${tokensN} bestMatch=${bestMatch} (warm=${(warm && warm.n) || 0} optane=${parentN || 0}) boundaries=${boundaries.length} poolRows=${idxCount} → reprocessing ${tokensN - bestMatch} tok, decision=${usedWarm ? 'WARM' : (cacheHit ? 'HIT' : 'MISS')}`);
      }
    } catch { /* diag must never break the request */ }

    // Pin the request to our slot so we know what to save afterward.
    body.id_slot = slotId;
    body.cache_prompt = true;

    // Feed the clone worker: frequency-count boundaries, materialize shared ones as exact rows.
    try { this.cloneWorker.observe(tokens, boundaries); } catch { /* best-effort */ }

    // EAGER initial-prefix (off-path): materialize the agent's always-shared system+tools cut.
    this._ensureInitialPrefix(promptStr, tokens, boundaries);

    return { slotId, boundaries, parentHash, parentN, tokensN, usedWarm, cacheHit };
  }

  /**
   * Post-forward: record what the slot now holds (warm affinity) and, on a CLEAN completion,
   * background-save the grown prefix (scheme B live path). Always releases the slot.
   * @param {object} ticket  from prepare()
   * @param {object} [o]  { completed=true, totalTokens }  totalTokens = prompt+generated if known
   */
  release(ticket, o = {}) {
    if (!ticket || ticket.slotId == null) return;   // nothing was acquired
    const completed = o.completed !== false;
    const slotId = ticket.slotId;

    // Record VRAM residency for next-request affinity (even on a miss — the slot now holds it).
    if (ticket.boundaries && ticket.boundaries.length) this.slotHolds.set(slotId, ticket.boundaries);

    // Background: (optional) save, then ALWAYS release. Strong-ref'd so it can't be GC'd
    // mid-await (the shim's prod deadlock: GC'd hook never released → slot wedged forever).
    this._fireAndForget(async () => {
      try {
        if (!completed || !ticket.boundaries || !ticket.boundaries.length) return;
        const [longestN, longestHash] = ticket.boundaries[ticket.boundaries.length - 1];
        const grew = longestN - (ticket.parentN || 0) >= this.cfg.minSaveDeltaTokens;
        const isNew = longestHash !== ticket.parentHash && !this.index.get(longestHash);
        if (!grew || !isNew) return;

        // Live-path save = full slot state (prompt + generation), keyed by the prompt's
        // longest boundary. n_tokens = longestN (the indexed boundary); file_total_n = the
        // real file length (≥ full prompt, + generation). n_tokens < file_total_n ⇒ this is a
        // legacy-shape row protected by the cost/benefit gate; the step-4 background worker
        // materializes the EXACT (n==file_total_n) rows via prime-to-boundary.
        const filename = `${longestHash}.bin`;
        const saveResp = await this.upstream.slotSave(slotId, filename);
        // Authoritative sizes from llama's save response: n_saved = real tokens in the file,
        // n_written = real bytes. Empirically bytes ≈ ~150 MB FIXED (spec-draft-mtp / ctx-checkpoint
        // state) + ~34.6 KB/token @ 27B q8 — estimating from token count alone is ~23× low and would
        // wreck the reaper's byte budget, so always prefer the real numbers; estimate is fallback only.
        const fileTotalN = Number(saveResp?.n_saved) || Math.max(longestN, ticket.tokensN || 0, o.totalTokens || 0);
        const bytes = Number(saveResp?.n_written) || (fileTotalN * this.cfg.bytesPerToken);
        this.index.put({
          hash: longestHash, model_fp: this.fp, n_tokens: longestN, file_total_n: fileTotalN,
          filename, bytes, state_seq_version: this.stateSeqVersion, kind: 'running', parent_hash: ticket.parentHash || null,
        }, Math.floor(Date.now() / 1000));
        this.stats.saves++;
        this.stats.saveBytes += bytes;
        this._log('info', `[kv ${this.slotName}] SAVE slot=${slotId} n=${longestN} file_total=${fileTotalN} (${filename.slice(0, 16)})`);
      } finally {
        this.pool.release(slotId);
      }
    });
  }

  /**
   * EAGER initial-prefix materializer (off the request path). The agent's system+tools prefix,
   * BEFORE the first user message, is the always-shared cross-conversation cut. Materialize it
   * immediately so the NEXT conversation restores ~all of it. Shared by the pin + defer paths.
   */
  _ensureInitialPrefix(promptStr, tokens, boundaries) {
    if (!promptStr || !boundaries || !boundaries.length) return;
    const _prompt = promptStr, _tokens = tokens, _boundaries = boundaries;
    this._fireAndForget(async () => {
      try {
        const uIdx = _prompt.indexOf('<|im_start|>user');
        if (uIdx <= 0) return;
        const initTokens = await this.upstream.tokenize(_prompt.slice(0, uIdx));
        const initN = initTokens.length;
        let initHash = null, initBN = 0;
        for (const [bn, bh] of _boundaries) { if (bn <= initN) { initHash = bh; initBN = bn; } else break; }
        if (initHash && initBN >= this.cfg.minMatchTokens) this.cloneWorker.ensureInitial(initHash, initBN, _tokens);
      } catch (e) { this._log('warn', `[kv ${this.slotName}] initial-prefix ensure: ${e?.message || e}`); }
    });
  }

  /** A currently-free slot that still leaves >=1 slot for live traffic; else null. No blocking. */
  _tryAcquireIdleSlot() {
    const free = this.pool.slotIds.filter((id) => !this.pool.locks.get(id).locked);
    if (free.length <= 1) return null;                 // never take the last free slot
    return this.pool.acquireSpecific(free[0]) ? free[0] : null;
  }

  /** Record a defer-path seed timestamp for hash-based dedup; prune stale entries when it grows. */
  _recordSeed(hash, nowMs) {
    this._recentSeeds.set(hash, nowMs);
    if (this._recentSeeds.size > 256) {
      const cutoff = nowMs - this.cfg.seedDedupTtlMs;
      for (const [h, t] of this._recentSeeds) if (t < cutoff) this._recentSeeds.delete(h);
    }
  }

  /**
   * DEFER-TO-LLAMA request path (increment 2a, gated by cfg.deferToLlama). Do NOT pin id_slot —
   * let llama pick the slot via --slot-prompt-similarity and reuse its VRAM + --cache-ram tiers.
   * We only SEED the best Optane snapshot into a free slot when llama looks cold (no warm coverage
   * we can see), then forward unpinned; llama's similarity adopts the seeded slot. No live per-turn
   * save (we can't know which slot llama served from — /slots promptlen is redacted); initial +
   * shared boundaries are still materialized off-path by the clone worker. Ticket slotId=null ⇒
   * release() is a no-op. Fully reversible: flag off ⇒ never entered.
   */
  async _prepareDeferred(body, { tokens, boundaries, promptStr, cacheRow, warm }) {
    let decision;
    if (warm) {
      decision = `DEFER warm-visible(${warm.n})`;      // llama very likely resident; don't seed
    } else if (cacheRow) {
      const nowMs = Date.now();
      const lastSeed = this._recentSeeds.get(cacheRow.hash) || 0;
      if (nowMs - lastSeed < this.cfg.seedDedupTtlMs) {
        // Seeded this exact prefix recently → llama's --cache-ram almost certainly still holds it.
        // Skip the redundant Optane restore + slot grab; let similarity reuse the resident copy.
        decision = `DEFER seed-fresh(${cacheRow.n_tokens}) ${Math.round((nowMs - lastSeed) / 1000)}s ago`;
      } else {
        const sid = this._tryAcquireIdleSlot();
        if (sid != null) {
          const t0 = Date.now();
          try {
            await this.upstream.slotRestore(sid, cacheRow.filename);
            this.stats.optaneHits++;
            this.stats.restoreMsTotal += Date.now() - t0;
            this.index.bumpHit(cacheRow.hash, Math.floor(Date.now() / 1000));
            this._recordSeed(cacheRow.hash, nowMs);
            decision = `DEFER seed slot=${sid} ${cacheRow.n_tokens}tok ${Date.now() - t0}ms`;
          } catch (e) {
            this._log('warn', `[kv ${this.slotName}] defer seed restore failed: ${e?.message || e}`);
            decision = 'DEFER seed-failed';
          } finally {
            this.pool.release(sid);                     // release now; llama owns slot selection
          }
        } else {
          decision = 'DEFER no-idle-slot (llama native)';
        }
      }
    } else {
      this.stats.misses++;
      decision = 'DEFER cold (llama native)';
    }

    body.cache_prompt = true;                            // NB: intentionally NOT setting body.id_slot
    try { this.cloneWorker.observe(tokens, boundaries); } catch { /* best-effort */ }
    this._ensureInitialPrefix(promptStr, tokens, boundaries);
    this._log('info', `[kv ${this.slotName}] ${decision} tokensN=${tokens.length}`);
    return { slotId: null, boundaries, deferred: true };
  }

  /**
   * Cold-start seeder (increment 2a): pre-warm slots from Optane initial-prefix snapshots so the
   * first request (post-restart, or a twin instance sharing this fp) finds llama already warm.
   * Only meaningful on the defer path (the pin path restores on-request). Best-effort.
   */
  async seedColdStart() {
    if (!this.cfg.deferToLlama) return;
    try {
      const rows = this.index.initialRows(this.fp, Math.max(1, this.pool.slotIds.length - 1));
      if (!rows || !rows.length) return;
      for (const row of rows) {
        if (row.n_tokens > this.slotNCtx) continue;
        const sid = this._tryAcquireIdleSlot();
        if (sid == null) break;
        const t0 = Date.now();
        try {
          await this.upstream.slotRestore(sid, row.filename);
          this._log('info', `[kv ${this.slotName}] COLD-SEED slot=${sid} ${row.n_tokens}tok ${Date.now() - t0}ms (${String(row.filename).slice(0, 16)})`);
        } catch (e) {
          this._log('warn', `[kv ${this.slotName}] cold-seed failed: ${e?.message || e}`);
        } finally {
          this.pool.release(sid);
        }
      }
    } catch (e) { this._log('warn', `[kv ${this.slotName}] seedColdStart: ${e?.message || e}`); }
  }

  startSweeper(intervalSec = 60) {
    if (this._sweeper) return;
    this._sweeper = setInterval(() => {
      const freed = this.pool.forceReleaseStale(this.cfg.staleReleaseSec);
      if (freed.length) this._log('warn', `[kv ${this.slotName}] stale-swept slots ${freed.join(',')}`);
    }, intervalSec * 1000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  stopSweeper() { if (this._sweeper) { clearInterval(this._sweeper); this._sweeper = null; } this.cloneWorker.stop(); }

  getStats() { return { ...this.stats, slots: this.pool.status(), holds: this.slotHolds.size, clone: this.cloneWorker.status() }; }
}
