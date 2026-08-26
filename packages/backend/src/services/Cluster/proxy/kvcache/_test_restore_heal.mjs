// Directly exercises the restore-FAILURE fix: a stale index row pointing at a missing .bin
// must (1) fail the restore, (2) self-heal (delete the dangling row), (3) reset the save
// baseline so the reprocessed prefix gets re-saved. Against live 27B @5001.
import { Upstream } from './upstream.js';
import { KvIndex } from './index-store.js';
import { KvOrchestrator } from './orchestrator.js';
import { chunkBoundaryHashes } from './boundaries.js';

const BASE = 'http://10.0.0.235:5001';
const DB = '/tmp/_kv_heal.db';
const FP = 'heal-test-27b';
const CHUNK = 64;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const up = new Upstream(BASE);
const index = new KvIndex(DB);
const orch = new KvOrchestrator({
  upstream: up, index, fp: FP, slotName: 'qwen3.6-27b-ud-q8_k_xl.gguf-2cb005ac',
  stateSeqVersion: 2, slotIds: [0, 1], slotNCtx: 262144,
  config: { chunkSize: CHUNK, minMatchTokens: 64, minSaveDeltaTokens: 64, cloneEnabled: false },
  log: { info: (m) => console.log('   ·', m), warn: (m) => console.log('   !', m) },
});

const sys = 'You are the restore-failure self-heal validation assistant. Marker phrase repeated for length. '.repeat(20);
const body = { model: 'x', max_tokens: 8, temperature: 0,
  messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Reply HEAL only.' }] };

// Pre-compute this request's boundaries so we can plant a poisoned row at its longest boundary.
const prompt = await up.applyTemplate(body.messages, undefined);
const tokens = await up.tokenize(prompt);
const bnds = chunkBoundaryHashes(tokens, CHUNK, FP);
ok(bnds.length > 2, `computed ${bnds.length} boundaries`);
const [Nlong, Hlong] = bnds[bnds.length - 1];

// Plant a POISONED row: correct hash, but filename points at a .bin that does not exist.
index.put({ hash: Hlong, model_fp: FP, n_tokens: Nlong, file_total_n: Nlong,
  filename: 'does-not-exist-heal-test.bin', bytes: 12345, state_seq_version: 2, parent_hash: null }, 1);
ok(!!index.get(Hlong), 'poisoned row planted');

// prepare() will match the poisoned row, attempt the restore, and it MUST fail → self-heal.
const t = await orch.prepare(body);
ok(t.slotId != null, 'slot acquired despite poisoned row');
ok(t.parentN === 0 && t.parentHash === null, `save baseline reset to cold (parentN=${t.parentN}, parentHash=${t.parentHash})`);
ok(index.get(Hlong) == null, 'poisoned row self-healed (deleted after failed restore)');
ok((orch.getStats().misses || 0) >= 1, 'counted as a miss');

// forward for real so the slot holds the prefix, then release → should SAVE (baseline was reset)
const res = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
await res.json();
orch.release(t, { completed: true });
await sleep(6000);   // let the bg save land

const healed = index.get(Hlong);
ok(!!healed, 'row re-saved after self-heal (would NOT happen with the old bug — parentN stuck at Nlong)');
ok(healed && healed.filename === Hlong + '.bin', `re-saved with real content-addressed filename (${healed && healed.filename})`);
ok(healed && healed.filename !== 'does-not-exist-heal-test.bin', 'no longer the poisoned filename');
ok(healed && healed.bytes > 50_000_000, `real bytes recorded (${healed && healed.bytes})`);
console.log('   healed row:', JSON.stringify({ n: healed?.n_tokens, ft: healed?.file_total_n, file: healed?.filename?.slice(0, 12), bytes: healed?.bytes }));

console.log('   CLEANUP_FILE=' + Hlong + '.bin');
orch.stopSweeper();
index.close();
console.log(`\nrestore-heal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
