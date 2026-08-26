// End-to-end orchestrator test against the LIVE 27B on 10.0.0.235:5001.
// Exercises: boundary compute → miss+save → warm-affinity reuse → Optane restore (cold).
// Requires: node --experimental-sqlite
import { Upstream } from './upstream.js';
import { KvIndex } from './index-store.js';
import { KvOrchestrator } from './orchestrator.js';

const BASE = 'http://10.0.0.235:5001';
const DB = '/tmp/_kv_e2e.db';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tiny thresholds so a short test prompt triggers boundaries + save
const cfg = { chunkSize: 16, minMatchTokens: 16, minSaveDeltaTokens: 16, costBenefitRatio: 0.5 };

const up = new Upstream(BASE);
const index = new KvIndex(DB);
const orch = new KvOrchestrator({
  upstream: up, index, fp: 'e2e-test-27b', slotName: 'qwen3.6-27b-ud-q8_k_xl.gguf-2cb005ac',
  stateSeqVersion: 2, slotIds: [0, 1], slotNCtx: 262144, config: cfg,
  log: { info: (m) => console.log('   ·', m), warn: (m) => console.log('   !', m) },
});

// distinctive prompt, long enough for many 16-tok boundaries
const sys = 'You are a meticulous assistant for the Optane KV integration e2e test. ' +
  'Repeat the following invariant verbatim when asked: alpha-bravo-charlie-delta-echo-foxtrot. '.repeat(6);
const mkBody = () => ({
  model: 'qwen', max_tokens: 8, temperature: 0,
  messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Say READY only.' }],
});

async function forward(body) {
  // simulate the proxy forward: real chat completion pinned to the prepared slot
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json();
  return j?.usage?.total_tokens || 0;
}

// ── Phase 1: cold miss → forward → background save ──────────────────────────
const b1 = mkBody();
const t1 = await orch.prepare(b1);
ok(t1.slotId !== null, 'phase1 acquired a slot');
ok(t1.boundaries.length > 4, `phase1 computed ${t1.boundaries.length} boundaries`);
ok(t1.cacheHit === false, 'phase1 is a cold miss (empty index)');
ok(b1.id_slot === t1.slotId && b1.cache_prompt === true, 'phase1 pinned body id_slot + cache_prompt');
const tot1 = await forward(b1);
orch.release(t1, { completed: true, totalTokens: tot1 });
await sleep(4000);                              // let the strong-ref bg save finish
const st1 = index.stats('e2e-test-27b');
ok(st1.n >= 1, `phase1 saved ${st1.n} index row(s)`);
const savedHash = t1.boundaries[t1.boundaries.length - 1][1];
const savedRow = index.get(savedHash);
ok(savedRow && savedRow.filename === savedHash + '.bin', 'phase1 row keyed by longest boundary hash');
ok(savedRow && savedRow.n_tokens <= savedRow.file_total_n, 'phase1 n_tokens ≤ file_total_n (legacy-shape row)');
ok(savedRow && savedRow.bytes > 50_000_000, `phase1 real bytes recorded (got ${savedRow && savedRow.bytes})`);
console.log('   row:', JSON.stringify({n_tokens:savedRow.n_tokens,file_total_n:savedRow.file_total_n,bytes:savedRow.bytes}));

// ── Phase 2: warm-slot affinity (VRAM tier) — same prompt, holds still set ──
const b2 = mkBody();
const t2 = await orch.prepare(b2);
ok(t2.usedWarm === true, 'phase2 reused the warm slot (VRAM tier, no restore)');
ok(t2.cacheHit === true, 'phase2 counted a hit');
await forward(b2);
orch.release(t2, { completed: true, totalTokens: 0 });
await sleep(500);

// ── Phase 3: Optane restore (cold slot / cross-instance) — clear holds ──────
orch.slotHolds.clear();                         // simulate a second instance w/ cold VRAM
const b3 = mkBody();
const t3 = await orch.prepare(b3);
ok(t3.usedWarm === false, 'phase3 did NOT use warm (holds cleared)');
ok(t3.cacheHit === true, 'phase3 restored from Optane (cross-instance shared pool)');
await forward(b3);
orch.release(t3, { completed: true, totalTokens: 0 });
await sleep(500);

const s = orch.getStats();
ok(s.vramHits >= 1, `stats.vramHits=${s.vramHits}`);
ok(s.optaneHits >= 1, `stats.optaneHits=${s.optaneHits}`);
ok(s.saves >= 1, `stats.saves=${s.saves}`);
console.log('   stats:', JSON.stringify({ vramHits: s.vramHits, optaneHits: s.optaneHits, misses: s.misses, saves: s.saves, restoreMsTotal: s.restoreMsTotal }));

// ── cleanup: report the .bin we created so the caller can rm it ─────────────
console.log('   CLEANUP_FILE=' + savedHash + '.bin');
index.close();
console.log(`\norchestrator e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
