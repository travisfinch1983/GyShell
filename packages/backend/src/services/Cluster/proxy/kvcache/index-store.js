// ─────────────────────────────────────────────────────────────────────────────
// KV-cache prefix index  (built-in node:sqlite; requires --experimental-sqlite)
// ─────────────────────────────────────────────────────────────────────────────
// Central, proxy-owned index of Optane boundary snapshots, keyed on the STABLE
// fingerprint (kvcache/fingerprint.js) so multiple llama.cpp instances sharing a fp
// share one pool (plan §4a). The .bin bytes live on the llama host's Optane; this table
// only tracks (prefix-hash → filename, n_tokens, bytes, version, kind). File deletion is
// done by the reaper via SSH-exec on the llama host using the filenames returned here.
//
// Content-addressed: a row's primary key `hash` is the rolling hash of the exact token
// prefix the snapshot covers. Identical prefix ⇒ identical hash ⇒ one row. This
// structurally prevents Fable bug (b): an existing prefix row is NEVER re-pointed at a
// different file (same content = same file semantics; we keep the first filename and only
// refresh last_used/hit_count). Scheme B: every row is an EXACT boundary, so
// `file_total_n == n_tokens` and a hash match is a guaranteed exact-prefix match — no
// over-restore (Fable bug a) is possible by construction; the cost/benefit gate (§3c)
// still applies on top.
//
// kind (rearchitecture 1b): 'initial' = agent system+tools prefix, before any user msg
// (materialized eagerly by the clone-worker, never overwritten); 'running' = a live
// conversation prefix (re-saved each turn). Eviction is PARTITIONED by kind into two
// independent byte-LRU pools (plan §"Eviction — partitioned quotas") so a burst of
// running snapshots can never evict an initial prefix.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS caches (
  hash              TEXT PRIMARY KEY,   -- rolling hash of the exact token prefix
  model_fp          TEXT NOT NULL,      -- stable fingerprint (shared-pool key)
  n_tokens          INTEGER NOT NULL,   -- tokens this snapshot covers (the boundary length)
  file_total_n      INTEGER NOT NULL,   -- total tokens in the .bin (==n_tokens for scheme-B rows)
  filename          TEXT NOT NULL,      -- .bin filename on the llama host Optane (basename)
  bytes             INTEGER NOT NULL,   -- file size, for byte-accurate LRU + budget
  state_seq_version INTEGER NOT NULL,   -- LLAMA_STATE_SEQ_VERSION at save time (restore gate)
  kind              TEXT NOT NULL DEFAULT 'running',  -- 'initial' | 'running' (partitioned eviction)
  created_at        INTEGER NOT NULL,
  last_used         INTEGER NOT NULL,
  hit_count         INTEGER NOT NULL DEFAULT 0,
  parent_hash       TEXT                -- the shorter boundary this one extends (chain)
);
CREATE INDEX IF NOT EXISTS idx_model_n    ON caches(model_fp, n_tokens DESC);
CREATE INDEX IF NOT EXISTS idx_lru        ON caches(model_fp, last_used);
CREATE INDEX IF NOT EXISTS idx_filename   ON caches(filename);
-- idx_kind_lru is created in _migrate(), AFTER the kind column is guaranteed to exist
-- (a legacy table lacks it, so referencing kind here would throw before migration runs).
`;

export class KvIndex {
  /** @param {string} dbPath  path to the SQLite file (e.g. /opt/kvcache-proxy/index.db) */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this._migrate();
    this._prep();
  }

  // Guarded migration for DBs created before `kind` existed. SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so probe table_info first. Pre-existing rows are all
  // full-prefix saves from the legacy path ⇒ default them to 'running' (correct: initial
  // prefixes get re-materialized fresh as 'initial' by the clone-worker's ensureInitial).
  _migrate() {
    // Bulletproof: attempt ADD COLUMN unconditionally. SQLite throws "duplicate column name"
    // if it already exists (fresh DB via SCHEMA, or an already-migrated DB) — ignore ONLY that.
    // Avoids PRAGMA table_info via prepare().all(), which is unreliable in node:sqlite and
    // silently left legacy DBs unmigrated (→ "no such column: kind" at _prep time).
    try { this.db.exec("ALTER TABLE caches ADD COLUMN kind TEXT NOT NULL DEFAULT 'running'"); }
    catch (e) { if (!/duplicate column/i.test(e?.message || '')) throw e; }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_kind_lru ON caches(model_fp, kind, last_used)'); }
    catch { /* index is an optimization; safe to skip */ }
  }

  _prep() {
    this._bumpHit = this.db.prepare(
      'UPDATE caches SET hit_count = hit_count + 1, last_used = ? WHERE hash = ?'
    );
    this._insert = this.db.prepare(`
      INSERT INTO caches (hash, model_fp, n_tokens, file_total_n, filename, bytes,
                          state_seq_version, kind, created_at, last_used, hit_count, parent_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,?)
      ON CONFLICT(hash) DO UPDATE SET last_used = excluded.last_used
    `);
    this._byHash   = this.db.prepare('SELECT * FROM caches WHERE hash = ?');
    this._delHash  = this.db.prepare('DELETE FROM caches WHERE hash = ?');
    this._fpRows   = this.db.prepare('SELECT * FROM caches WHERE model_fp = ? ORDER BY last_used ASC');
    this._fpRowsKind = this.db.prepare('SELECT * FROM caches WHERE model_fp = ? AND kind = ? ORDER BY last_used ASC');
    this._fpBytes  = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS b, COUNT(*) AS n FROM caches WHERE model_fp = ?');
    this._fpBytesKind = this.db.prepare('SELECT kind, COALESCE(SUM(bytes),0) AS b, COUNT(*) AS n FROM caches WHERE model_fp = ? GROUP BY kind');
    this._verMis   = this.db.prepare('SELECT * FROM caches WHERE state_seq_version != ?');
    this._initRows = this.db.prepare("SELECT * FROM caches WHERE model_fp = ? AND kind = 'initial' ORDER BY last_used DESC LIMIT ?");
    this._updSize  = this.db.prepare('UPDATE caches SET file_total_n = ?, bytes = ?, last_used = ? WHERE hash = ?');
    this._setKind  = this.db.prepare('UPDATE caches SET kind = ? WHERE hash = ?');
  }

  /**
   * Longest exact-prefix match for a request.  (kind-agnostic: any snapshot may match.)
   * @param {string} modelFp
   * @param {Array<[number,string]>} boundaries  request's [(n_tokens, hash), ...] boundary list
   * @param {number} stateSeqVersion  current LLAMA_STATE_SEQ_VERSION (rows of other versions ignored)
   * @param {object} [gate]  cost/benefit gate: { minMatchTokens=0 }
   * @returns {object|null}  the best row, or null
   */
  longestMatch(modelFp, boundaries, stateSeqVersion, gate = {}) {
    if (!boundaries || boundaries.length === 0) return null;
    const minMatch = gate.minMatchTokens || 0;
    const hashes = boundaries.map(([, h]) => h);
    const ph = hashes.map(() => '?').join(',');
    // Exact-prefix + version-gated + cost/benefit(min) match, longest first.
    const row = this.db
      .prepare(
        `SELECT * FROM caches
          WHERE model_fp = ? AND state_seq_version = ? AND n_tokens >= ?
            AND hash IN (${ph})
          ORDER BY n_tokens DESC LIMIT 1`
      )
      .get(modelFp, stateSeqVersion, minMatch, ...hashes);
    return row || null;
  }

  /**
   * Record a freshly-saved boundary snapshot (dedup on hash; never re-points a file).
   * @param {object} row  { hash, model_fp, n_tokens, file_total_n?, filename, bytes,
   *                         state_seq_version, kind?, parent_hash? }  kind defaults 'running'.
   */
  put(row, now) {
    this._insert.run(
      row.hash, row.model_fp, row.n_tokens, row.file_total_n ?? row.n_tokens,
      row.filename, row.bytes, row.state_seq_version, row.kind ?? 'running',
      now, now, row.parent_hash ?? null
    );
  }

  bumpHit(hash, now) { this._bumpHit.run(now, hash); }

  /** Upgrade a row in place (e.g. clone worker replaces a legacy-shape file with an exact one). */
  updateSize(hash, fileTotalN, bytes, now) { this._updSize.run(fileTotalN, bytes, now, hash); }

  /** Re-tag a row's kind (self-heal legacy/mislabeled rows; does NOT touch last_used/LRU). */
  markKind(hash, kind) { this._setKind.run(kind, hash); }
  get(hash) { return this._byHash.get(hash) || null; }
  del(hash) { this._delHash.run(hash); }

  /** Aggregate stats for a fp: total bytes/count plus a per-kind breakdown. */
  stats(modelFp) {
    const total = this._fpBytes.get(modelFp);
    const byKind = { initial: { b: 0, n: 0 }, running: { b: 0, n: 0 } };
    for (const r of this._fpBytesKind.all(modelFp)) {
      byKind[r.kind] = { b: r.b, n: r.n };
    }
    return { b: total.b, n: total.n, byKind };
  }

  /**
   * PARTITIONED byte-accurate LRU eviction plan for a fp. Each kind is evicted only to fit
   * its OWN budget (independent byte-LRU within the kind), so a burst of 'running' snapshots
   * can never evict an 'initial' prefix (plan §"Eviction — partitioned quotas"). Caller
   * deletes the .bin files (reaper) then calls del(hash) for each. Never partial-frees a
   * multi-row file (scheme-B = 1 file/row).
   *
   * Back-compat: if passed a bare number, it is treated as the 'running' budget with no
   * 'initial' cap (initial prefixes are never evicted) — matches the old single-pool call
   * shape defensively, though the reaper now always passes the object form.
   *
   * @param {string} modelFp
   * @param {{initialBudgetBytes:number, runningBudgetBytes:number}|number} budgets
   * @returns {object[]} rows to delete (oldest-first within each kind), combined
   */
  evictionPlan(modelFp, budgets) {
    const initialBudget = typeof budgets === 'number' ? Infinity : (budgets?.initialBudgetBytes ?? Infinity);
    const runningBudget = typeof budgets === 'number' ? budgets : (budgets?.runningBudgetBytes ?? Infinity);
    const plan = [];
    plan.push(...this._planForKind(modelFp, 'initial', initialBudget));
    plan.push(...this._planForKind(modelFp, 'running', runningBudget));
    return plan;
  }

  _planForKind(modelFp, kind, budgetBytes) {
    if (!Number.isFinite(budgetBytes)) return [];
    const rows = this._fpRowsKind.all(modelFp, kind);   // oldest last_used first
    let total = 0;
    for (const r of rows) total += r.bytes;
    if (total <= budgetBytes) return [];
    const plan = [];
    let freed = 0;
    for (const r of rows) {
      if (total - freed <= budgetBytes) break;
      plan.push(r);
      freed += r.bytes;
    }
    return plan;
  }

  /** Initial-prefix rows for a fp, most-recently-used first (cold-start seeder, increment 2a). */
  initialRows(modelFp, limit = 8) {
    return this._initRows.all(modelFp, limit);
  }

  /** Rows whose state_seq_version != current — stale after a llama upgrade; regenerate. */
  versionMismatched(currentVersion) { return this._verMis.all(currentVersion); }

  close() { this.db.close(); }

  /**
   * Snapshots ranked by how often each has ACTUALLY been restored (hit_count), not by size or
   * age. This is the ordering the Optane dashboard is built around: the snapshots earning their
   * Optane space belong at the top, and the never-restored ones are the eviction candidates.
   */
  topSnapshots(modelFp, limit = 100) {
    return this.db.prepare(
      "SELECT hash, model_fp, n_tokens, bytes, kind, created_at, last_used, hit_count " +
      "FROM caches WHERE model_fp = ? ORDER BY hit_count DESC, last_used DESC LIMIT ?"
    ).all(modelFp, limit);
  }

  /** Every model_fp present in this DB (one file can hold more than one after a rekey). */
  modelFps() {
    return this.db.prepare("SELECT DISTINCT model_fp FROM caches").all().map((r) => r.model_fp);
  }

}
