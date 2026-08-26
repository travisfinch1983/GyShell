// CloneWorker test against live 27B @5001: two requests sharing a 200-token prefix but
// diverging → the shared boundary is materialized as an EXACT snapshot (n==file_total_n).
// Requires: node --experimental-sqlite (harmless; not required on 22.22 but kept explicit)
import { Upstream } from './upstream.js';
import { KvIndex } from './index-store.js';
import { KvOrchestrator } from './orchestrator.js';
import { chunkBoundaryHashes } from './boundaries.js';

const BASE = 'http://10.0.0.235:5001';
const DB = '/tmp/_kv_clone.db';
const FP = 'e2e-clone-27b';
const CHUNK = 64;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const up = new Upstream(BASE);
const index = new KvIndex(DB);
const orch = new KvOrchestrator({
  upstream: up, index, fp: FP, slotName: 'qwen3.6-27b-ud-q8_k_xl.gguf-2cb005ac',
  stateSeqVersion: 2, slotIds: [0, 1], slotNCtx: 262144,
  config: { chunkSize: CHUNK, minMatchTokens: 16, cloneMinShareCount: 2, cloneMinTokens: 150,
            cloneIdleWaitMs: 400 },
  log: { info: (m) => console.log('   ·', m), warn: (m) => console.log('   !', m) },
});

// shared 200-token prefix (safe, common token ids), then two divergent tails
const shared = Array.from({ length: 200 }, (_, i) => (i * 3 + 10));
const tokA = shared.concat(Array.from({ length: 100 }, (_, i) => 1000 + i));
const tokB = shared.concat(Array.from({ length: 100 }, (_, i) => 5000 + i));
const bndA = chunkBoundaryHashes(tokA, CHUNK, FP);
const bndB = chunkBoundaryHashes(tokB, CHUNK, FP);

// target = the largest shared boundary ≥ cloneMinTokens (150) → boundary @192
const target = bndA.find(([n]) => n === 192);
ok(!!target, 'boundary @192 exists in A');
ok(bndB.some(([n, h]) => n === 192 && h === target[1]), 'A and B share the @192 boundary hash (prefix property)');
ok(!bndA.some(([n, h]) => n === 256 && bndB.some(([n2, h2]) => n2 === 256 && h2 === h)), '@256 boundary differs (divergent tail)');

// observe both → shared @192 hits count 2 → enqueue → clone
orch.cloneWorker.observe(tokA, bndA);
orch.cloneWorker.observe(tokB, bndB);

// poll for the exact clone row
const targetHash = target[1];
let row = null;
for (let i = 0; i < 40 && !row; i++) { await sleep(500); row = index.get(targetHash); }
ok(!!row, `clone row for @192 materialized (waited ${row ? '' : '≥20s'})`);
if (row) {
  ok(row.n_tokens === 192, `n_tokens=192 (got ${row.n_tokens})`);
  ok(row.file_total_n === 192, `EXACT: file_total_n==n_tokens==192 (got ${row.file_total_n})`);
  ok(row.filename === targetHash + '.bin', 'filename content-addressed');
  ok(row.bytes > 50_000_000, `real bytes recorded (${row.bytes})`);
  console.log('   row:', JSON.stringify({ n: row.n_tokens, ft: row.file_total_n, bytes: row.bytes }));
}
// a divergent-only boundary (@256 of A) must NOT be cloned (seen once)
const a256 = bndA.find(([n]) => n === 256);
ok(a256 && !index.get(a256[1]), '@256 (unshared) NOT cloned');

const st = orch.getStats();
ok((st.clones || 0) >= 1, `stats.clones=${st.clones}`);
console.log('   clone stats:', JSON.stringify({ clones: st.clones, cloneFails: st.cloneFails, clone: st.clone }));

console.log('   CLEANUP_FILE=' + targetHash + '.bin');
orch.stopSweeper();
index.close();
console.log(`\nclone-worker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
