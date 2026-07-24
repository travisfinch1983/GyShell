// ─────────────────────────────────────────────────────────────────────────────
// Reaper  — byte-accurate LRU eviction + version-mismatch sweep (step 5)
// ─────────────────────────────────────────────────────────────────────────────
// Keeps a fingerprint's Optane snapshot pool within a byte budget and purges snapshots a
// llama upgrade would mis-restore. The index is one SQLite db per fp, so a sweep here covers
// exactly that fp's shared pool. The .bin bytes live on the llama host's Optane; deletion is
// an SSH `rm` (bytes never transit the proxy) via the injected deleteFiles(host, paths).
//
// Two things get reaped:
//   1) version-mismatch — rows whose state_seq_version != the current LLAMA_STATE_SEQ_VERSION.
//      After a llama upgrade these would restore into an incompatible layout, so they're dead
//      weight: delete file + row, let them regenerate.  (kind-agnostic.)
//   2) over-budget — PARTITIONED byte-accurate LRU (oldest last_used first) within each kind:
//      'initial' prefixes evict only to fit the initial budget, 'running' prefixes only to fit
//      the running budget. Split from the per-fp total via initialBudgetFraction (default 0.2 /
//      0.8). This structurally guarantees a burst of running snapshots can NEVER evict an
//      initial prefix. Uses real n_written bytes recorded at save time (~150 MB fixed +
//      ~34.6 KB/token @27B q8), NOT a token estimate, so the budget is honest.

/**
 * Sweep one fingerprint's pool. Pure w.r.t. I/O except the injected deleteFiles.
 * @param {object} o
 * @param {import('./index-store.js').KvIndex} o.index    the per-fp index
 * @param {string}   o.fp
 * @param {string}   o.host        llama host (SSH target)
 * @param {string}   o.savePath    physical --slot-save-path dir on that host
 * @param {number}   o.budgetBytes per-fp Optane budget (total; split by kind below)
 * @param {number}   [o.initialBudgetFraction=0.2]  fraction of the budget reserved for 'initial' prefixes
 * @param {number}   o.currentVersion  STATE_SEQ_VERSION now
 * @param {function} o.deleteFiles async (host, absPaths[]) => void   (SSH rm -f, batched)
 * @param {object}   [o.log]
 * @returns {Promise<{deleted:number, freedBytes:number, versionStale:number, overBudget:number}>}
 */
export async function reapFp(o) {
  const { index, fp, host, savePath, budgetBytes, currentVersion, deleteFiles, log } = o;
  const frac = Math.min(0.9, Math.max(0.01, o.initialBudgetFraction ?? 0.2));
  const initialBudgetBytes = Math.floor(budgetBytes * frac);
  const runningBudgetBytes = budgetBytes - initialBudgetBytes;
  const seen = new Set();
  const toDelete = [];

  // 1) version-mismatch (dead after a llama upgrade)
  const stale = index.versionMismatched(currentVersion);
  for (const r of stale) { if (!seen.has(r.hash)) { seen.add(r.hash); toDelete.push(r); } }
  const versionStale = toDelete.length;

  // 2) partitioned byte-LRU eviction within each kind's budget. evictionPlan is computed on
  //    current totals (a safe upper bound — deleting version-stale rows first only frees more).
  const plan = index.evictionPlan(fp, { initialBudgetBytes, runningBudgetBytes });
  for (const r of plan) { if (!seen.has(r.hash)) { seen.add(r.hash); toDelete.push(r); } }
  const overBudget = toDelete.length - versionStale;

  if (!toDelete.length) return { deleted: 0, freedBytes: 0, versionStale: 0, overBudget: 0 };

  const paths = toDelete.map((r) => joinPath(savePath, r.filename));
  try {
    await deleteFiles(host, paths);          // SSH rm -f (best-effort; missing files are fine)
  } catch (e) {
    log?.warn?.(`[kv reaper] delete failed fp=${fp}: ${e?.message || e}`);
    return { deleted: 0, freedBytes: 0, versionStale, overBudget, error: true };
  }

  let freed = 0;
  for (const r of toDelete) { index.del(r.hash); freed += r.bytes; }
  log?.info?.(`[kv reaper] fp=${fp} purged ${toDelete.length} (${versionStale} stale-version, ` +
    `${overBudget} over-budget) freed ${(freed / 2 ** 30).toFixed(2)}GB`);
  return { deleted: toDelete.length, freedBytes: freed, versionStale, overBudget };
}

function joinPath(dir, file) {
  if (!dir) return file;
  return dir.replace(/\/+$/, '') + '/' + file;
}
