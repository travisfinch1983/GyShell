import { KvIndex } from './index-store.js';
import { reapFp } from './reaper.js';

const DB = '/tmp/_kv_reaper.db';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

import { rmSync } from 'fs';
try { rmSync(DB); rmSync(DB + '-wal'); rmSync(DB + '-shm'); } catch {}

const index = new KvIndex(DB);
const MB = 2 ** 20, FP = 'reap-fp';
const mk = (hash, lastUsed, bytes, ver = 2) => index.put(
  { hash, model_fp: FP, n_tokens: 1000, file_total_n: 1000, filename: `${hash}.bin`, bytes, state_seq_version: ver, parent_hash: null },
  lastUsed);
mk('h_old', 100, 200 * MB);
mk('h_mid', 200, 200 * MB);
mk('h_new', 300, 200 * MB);
mk('h_stale', 400, 200 * MB, 1);   // newest but wrong state_seq_version → dead

const deleted = [];
const deleteFiles = async (host, paths) => { deleted.push(...paths); };

const r = await reapFp({
  index, fp: FP, host: '10.0.0.235', savePath: '/optane-sock0/kvcache/reap-fp',
  budgetBytes: 450 * MB, currentVersion: 2, deleteFiles,
  log: { info: (m) => console.log('   ·', m), warn: (m) => console.log('   !', m) },
});

ok(r.versionStale === 1, `versionStale=1 (got ${r.versionStale})`);
ok(r.deleted === 3, `deleted 3 total (got ${r.deleted})`);
ok(deleted.length === 3, `deleteFiles got 3 paths (got ${deleted.length})`);
ok(deleted.every((p) => p.startsWith('/optane-sock0/kvcache/reap-fp/')), 'paths are absolute under savePath');
ok(deleted.includes('/optane-sock0/kvcache/reap-fp/h_stale.bin'), 'stale-version file deleted');
ok(deleted.includes('/optane-sock0/kvcache/reap-fp/h_old.bin'), 'oldest LRU file deleted');
ok(!index.get('h_stale') && !index.get('h_old') && !index.get('h_mid'), 'their index rows removed');
ok(!!index.get('h_new'), 'newest survives (under budget)');
ok(index.stats(FP).b <= 450 * MB, `pool now ≤ budget (${(index.stats(FP).b / MB).toFixed(0)}MB)`);

// idempotent: second sweep with everything fitting → no-op
const r2 = await reapFp({ index, fp: FP, host: 'x', savePath: '/x', budgetBytes: 450 * MB, currentVersion: 2, deleteFiles: async () => {} });
ok(r2.deleted === 0, 'second sweep is a no-op');

index.close();
console.log(`\nreaper: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
