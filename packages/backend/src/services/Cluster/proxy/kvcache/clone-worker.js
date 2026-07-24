// ─────────────────────────────────────────────────────────────────────────────
// CloneWorker  — materializes shared boundaries as EXACT snapshots (scheme B, step 4)
// ─────────────────────────────────────────────────────────────────────────────
// The live path (orchestrator.release) saves ONE row per request at its longest boundary,
// as a legacy-shape file (holds prompt + generated tail). That does nothing for a DIFFERENT
// conversation that shares only the system-prompt / context prefix and then diverges — its
// shorter shared boundary has no row, so it misses.
//
// This worker fixes that. It counts boundary-hash frequency across requests; when a boundary
// is seen in ≥ cloneMinShareCount distinct requests (⇒ genuinely shared) and has no EXACT row
// yet, it primes a scratch slot to EXACTLY that boundary (n_predict:0 = prefill only, using
// the retained token prefix) and full-state-saves it → a `file_total_n == n_tokens` row.
// Content-addressing then guarantees any request whose prefix IS that boundary matches it and
// restores exactly it. This is where cross-conversation AND cross-instance (plan §4a) reuse
// come from: whichever instance is idle materializes the boundary into the SHARED pool.
//
// Yields hard to live traffic: runs one clone at a time, only on a genuinely idle slot, and
// NEVER consumes the last free slot (always leaves one for a real request).

export class CloneWorker {
  /**
   * @param {object} o
   * @param {import('./upstream.js').Upstream} o.upstream
   * @param {import('./index-store.js').KvIndex} o.index
   * @param {import('./slot-pool.js').SlotPool} o.pool
   * @param {string}   o.fp
   * @param {number}   o.stateSeqVersion
   * @param {object}   o.config       merged orchestrator config (clone* keys)
   * @param {object}   o.stats        shared orchestrator stats object (adds clones/cloneFails)
   * @param {function} o.fireAndForget  orchestrator's strong-ref task launcher
   * @param {object}   [o.log]
   */
  constructor(o) {
    this.upstream = o.upstream;
    this.index = o.index;
    this.pool = o.pool;
    this.fp = o.fp;
    this.stateSeqVersion = o.stateSeqVersion;
    this.cfg = o.config;
    this.stats = o.stats;
    this._fireAndForget = o.fireAndForget;
    this.log = o.log || null;

    this._cand = new Map();   // hash → { n, count, seq, tokens|null, queued }
    this._queue = [];         // hashes awaiting a clone
    this._draining = false;
    this._seq = 0;
    this._stopped = false;
  }

  _log(level, ...a) { try { this.log?.[level]?.(...a); } catch { /* noop */ } }

  /**
   * Observe a served request's boundaries (called from orchestrator.prepare, tokens in scope).
   * Counts frequency and enqueues a materialization job once a boundary is shared enough.
   */
  observe(tokens, boundaries) {
    if (this._stopped || !this.cfg.cloneEnabled || !boundaries || !boundaries.length) return;
    const minTok = this.cfg.cloneMinTokens;
    for (const [n, hash] of boundaries) {
      if (n < minTok) continue;
      if (this.cfg.cloneStride && (n % this.cfg.cloneStride) !== 0) continue;   // coarse granularity: skip fine boundaries
      let e = this._cand.get(hash);
      if (!e) {
        if (this._cand.size >= this.cfg.cloneMaxPending) this._evictOneCand();
        e = { n, count: 0, seq: 0, tokens: null, queued: false, done: false };
        this._cand.set(hash, e);
      }
      e.count++;
      e.seq = ++this._seq;
      if (!e.done && !e.queued && e.count >= this.cfg.cloneMinShareCount &&
          this._queue.length < this.cfg.cloneMaxQueue) {
        e.tokens = tokens.slice(0, n);   // retained only until the job runs, then dropped
        e.queued = true;
        this._queue.push(hash);
        this._kick();
      }
    }
  }

  /**
   * EAGER, freq-1 materialization of a SPECIFIC boundary — the agent's initial prefix
   * (system + tools, before the first user message). Unlike observe(), this bypasses the
   * share-count threshold AND the cloneStride grid, and jumps the queue. The initial prefix
   * is the always-shared cross-conversation cut; materializing it immediately (not lazily
   * after N sightings) is what lets the NEXT conversation restore ~all of it instead of
   * reprocessing. Idempotent: skips if the exact prefix is already indexed or in flight.
   */
  ensureInitial(hash, n, tokens) {
    if (this._stopped || !this.cfg.cloneEnabled || !hash || !tokens || !tokens.length || n <= 0) return;
    const _existing = this.index.get(hash);
    if (_existing) {
      // Already materialized. Self-heal: a legacy/pre-`kind` row (or one first saved by the
      // running-path) must be re-tagged 'initial' so partitioned eviction protects it.
      if (_existing.kind !== 'initial') {
        this.index.markKind(hash, 'initial');
        this._log('info', `[kv clone] re-tagged existing prefix → initial n=${_existing.n_tokens} (${hash.slice(0, 16)})`);
      }
      return;
    }
    const ex = this._cand.get(hash);
    if (ex && (ex.queued || ex.done)) return;         // already queued/done this run
    const e = { n, count: this.cfg.cloneMinShareCount, seq: ++this._seq,
                tokens: tokens.slice(0, n), queued: true, done: false, initial: true };
    this._cand.set(hash, e);
    this._queue.unshift(hash);                         // highest value → jump the queue
    this._log('info', `[kv clone] EAGER initial-prefix queued n=${n} (${hash.slice(0, 16)})`);
    this._kick();
  }

  _evictOneCand() {
    // drop the least-recently-seen candidate that isn't queued
    let victim = null, oldest = Infinity;
    for (const [h, e] of this._cand) {
      if (e.queued) continue;
      if (e.seq < oldest) { oldest = e.seq; victim = h; }
    }
    if (victim) this._cand.delete(victim);
  }

  _kick() { this._fireAndForget(() => this._drain()); }

  /** True idle slot that still leaves ≥1 slot free for live traffic; else null. */
  _tryAcquireIdle() {
    const free = this.pool.slotIds.filter((id) => !this.pool.locks.get(id).locked);
    if (free.length <= 1) return null;              // never take the last free slot
    return this.pool.acquireSpecific(free[0]) ? free[0] : null;
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (!this._stopped && this._queue.length) {
        const hash = this._queue[0];
        const e = this._cand.get(hash);
        if (!e || !e.tokens) { this._queue.shift(); continue; }

        // Already exact? (someone — maybe another instance — beat us to it.) Skip.
        const existing = this.index.get(hash);
        if (existing && existing.file_total_n <= existing.n_tokens) {
          this._queue.shift(); e.tokens = null; e.queued = false; e.done = true; continue;
        }

        const slotId = this._tryAcquireIdle();
        if (slotId == null) {                       // no idle slot → yield, retry later
          await sleep(this.cfg.cloneIdleWaitMs);
          continue;
        }

        this._queue.shift();
        try {
          await this.upstream.prime(e.tokens, slotId, { nPredict: 0 });   // exact prefill
          const saveResp = await this.upstream.slotSave(slotId, `${hash}.bin`);
          const fileTotalN = Number(saveResp?.n_saved) || e.n;
          const bytes = Number(saveResp?.n_written) || 0;
          const now = Math.floor(Date.now() / 1000);
          if (existing) {
            this.index.updateSize(hash, fileTotalN, bytes, now);          // upgrade legacy → exact
          } else {
            this.index.put({
              hash, model_fp: this.fp, n_tokens: e.n, file_total_n: fileTotalN,
              filename: `${hash}.bin`, bytes, state_seq_version: this.stateSeqVersion, kind: e.initial ? 'initial' : 'running', parent_hash: null,
            }, now);
          }
          this.stats.clones = (this.stats.clones || 0) + 1;
          this._log('info', `[kv clone] materialized n=${e.n} file_total=${fileTotalN} bytes=${bytes} (${hash.slice(0, 16)})`);
          e.done = true;
        } catch (err) {
          this.stats.cloneFails = (this.stats.cloneFails || 0) + 1;
          this._log('warn', `[kv clone] failed n=${e.n} (${hash.slice(0, 16)}): ${err?.message || err}`);
        } finally {
          this.pool.release(slotId);
          e.tokens = null; e.queued = false;
        }
      }
    } finally {
      this._draining = false;
    }
  }

  stop() { this._stopped = true; this._queue.length = 0; this._cand.clear(); }

  status() { return { pending: this._cand.size, queued: this._queue.length, draining: this._draining }; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
