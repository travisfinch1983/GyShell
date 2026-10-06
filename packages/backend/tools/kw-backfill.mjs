// Usage: node packages/backend/tools/kw-backfill.mjs [collection]  (skips __bnb4 archives)
// Build/refresh "<col>__kw" BM25 companions for every docs_*/codebase_* qdrant collection from the
// text already stored in qdrant (no re-embedding). Idempotent: same point ids, upsert overwrites.
import { kwUpsert, KW_PREFIXES, KW_SUFFIX } from '/opt/ai-lab/packages/backend/src/services/Cluster/proxy/vector-proxy.js';
const Q = 'http://127.0.0.1:6333';
const only = process.argv[2];
const cols = (await (await fetch(`${Q}/collections`)).json()).result.collections.map((c) => c.name)
  .filter((n) => KW_PREFIXES.test(n) && !n.endsWith(KW_SUFFIX) && !n.includes('__bnb4') && (!only || n === only)).sort();
let grand = 0;
for (const col of cols) {
  let off = null, n = 0; const t0 = Date.now();
  for (;;) {
    const r = await (await fetch(`${Q}/collections/${col}/points/scroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 512, with_payload: true, with_vector: false, ...(off !== null ? { offset: off } : {}) }) })).json();
    const pts = r.result?.points || [];
    if (pts.length) n += await kwUpsert(Q, col, pts.map((p) => ({ id: p.id, payload: p.payload })));
    off = r.result?.next_page_offset;
    if (off === null || off === undefined) break;
  }
  const kc = (await (await fetch(`${Q}/collections/${col}${KW_SUFFIX}`)).json()).result?.points_count;
  console.log(`${col.padEnd(48)} indexed ${String(n).padStart(6)}  kw_count ${kc}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  grand += n;
}
console.log('DONE', cols.length, 'collections,', grand, 'points');
