import { SlotPool } from './slot-pool.js';
import { Upstream } from './upstream.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── SlotPool ──────────────────────────────────────────────────────────────
const pool = new SlotPool([0, 1]);
const a = await pool.acquire();
const b = await pool.acquire();
ok(a !== b && [0, 1].includes(a) && [0, 1].includes(b), `two acquires give distinct slots (${a},${b})`);

// specific acquire on a held slot fails without blocking
ok(pool.acquireSpecific(a) === false, 'acquireSpecific on held slot → false');

// third acquire must WAIT until one frees; prove it blocks then resolves
let gotThird = null;
const p = pool.acquire().then((s) => { gotThird = s; });
await sleep(30);
ok(gotThird === null, 'third acquire blocks while pool full');
pool.release(a);
await p;
ok(gotThird === a, `third acquire got the freed slot ${a}`);

// specific acquire now works on the free slot after we release both
pool.release(b);
pool.release(gotThird);
ok(pool.acquireSpecific(1) === true, 'acquireSpecific on free slot → true');
pool.release(1);

// stale sweep
const pool2 = new SlotPool([5]);
await pool2.acquire();
ok(pool2.forceReleaseStale(1000).length === 0, 'fresh hold not swept');
await sleep(20);
ok(pool2.forceReleaseStale(0.01).length === 1, 'stale hold swept');
ok(pool2.acquireSpecific(5) === true, 'slot reusable after sweep');

// ── Upstream (live 5001) ─────────────────────────────────────────────────
const up = new Upstream('http://10.0.0.235:5001');
const prompt = await up.applyTemplate([
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'hi' },
]);
ok(prompt.includes('<|im_start|>system') && prompt.includes('<|im_start|>assistant'), 'apply-template returns templated prompt');

const toks = await up.tokenize(prompt);
ok(Array.isArray(toks) && toks.length > 5, `tokenize returns ${toks.length} ints`);
ok(toks[0] === 248045, `first token is <|im_start|> special id (got ${toks[0]})`);

const slots = await up.slotList();
ok(Array.isArray(slots) && slots.length >= 1, `slotList → ${slots.length} slots`);

console.log(`\npool+upstream: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
