/**
 * memory_recall honesty — "no memories matched" must never describe a failure.
 * Run: tsx packages/backend/src/services/AgentHelper/tools/memoryRecallHonesty.extreme.spec.ts
 *
 * The confident-negative shape: when every collection query FAILED, the tool
 * answered `No memories matched "<query>"` — indistinguishable from a
 * genuinely empty store, in the mirrored vector-proxy lane the composite
 * emitter does not cover. The pairs here: a real empty result stays a calm
 * negative (scoped to what was searched), a total failure says FAILED and
 * forbids the absence conclusion, a partial failure names the unsearched
 * collections. Driven through the real function with a stubbed fetch.
 */
import { runMemoryRecall } from './memory_tools'

let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}

type Route = (url: string) => { ok: boolean; status?: number; body?: unknown } | 'throw'
let route: Route = () => ({ ok: true, body: {} })
;(globalThis as any).fetch = async (url: string) => {
  const r = route(String(url))
  if (r === 'throw') throw new Error('lane transport down')
  return {
    ok: r.ok, status: r.status ?? (r.ok ? 200 : 500),
    json: async () => r.body ?? {},
  } as Response
}

async function main(): Promise<void> {
  // Stub speaks the OBSERVED shapes (checked against the live route, not
  // guessed — the list endpoint returns {results:[{collections:[…]}]}, and a
  // guessed {collections:[…]} made every test walk the wrong branch).
  const LIST = { ok: true, body: { results: [{ collections: ['notes', 'lore'] }] } }

  // ── all lanes healthy, genuinely empty ────────────────────────────────────
  route = (u) => u.endsWith('/collections') ? LIST : { ok: true, body: { fused: [] } }
  let r: any = await runMemoryRecall({ query: 'anything' } as any)
  ok(r.kind === 'text' && r.message.includes('No memories matched'),
    'a genuinely empty result is still a calm negative')
  ok(!r.message.includes('⚠'), 'and carries no warning — nothing failed')

  // ── every lane fails: the confident negative is forbidden ─────────────────
  route = (u) => u.endsWith('/collections') ? LIST : 'throw'
  r = await runMemoryRecall({ query: 'anything' } as any)
  ok(r.message.includes('FAILED') && !r.message.startsWith('No memories matched'),
    'ALL lanes failing says FAILED — never "no memories matched"')
  ok(r.message.includes('NOT') && r.message.toLowerCase().includes('absent'),
    'and explicitly forbids concluding the information is absent')

  // ── partial failure: absence is scoped to what was searched ───────────────
  route = (u) => {
    if (u.endsWith('/collections')) return LIST
    if (u.includes('/notes/search')) return { ok: true, body: { fused: [] } }
    return { ok: false, status: 502 }
  }
  r = await runMemoryRecall({ query: 'anything' } as any)
  ok(r.message.includes('No memories matched') && r.message.includes('notes'),
    'a partial search reports the negative scoped to the collections actually searched')
  ok(r.message.includes('⚠') && r.message.includes('lore'),
    'and NAMES the collection that could not be searched — absence is only proven for the searched ones')

  console.log(`\n${n} assertions passed`)
}

main().catch((e) => { console.error(e); process.exit(1) })
