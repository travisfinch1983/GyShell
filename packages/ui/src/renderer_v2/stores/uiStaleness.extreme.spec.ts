/**
 * UI staleness family — store-level contracts.
 * Run: tsx packages/ui/src/renderer_v2/stores/uiStaleness.extreme.spec.ts
 *
 * The family's shape: cached data cannot fake an AGE, and a failure must not
 * wear another surface's clean bill. Pairs throughout: lastGoodAt moves only
 * on success; the log-list error survives a log-fetch success; envelope drift
 * returns [] loudly instead of a silent empty or a raw object.
 */
let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}

const routes: Record<string, () => unknown> = {}
;(globalThis as any).window = {
  gyshell: { cluster: { request: async (_m: string, path: string) => {
    for (const k of Object.keys(routes)) if (path.startsWith(k)) {
      const r = routes[k]()
      if (r instanceof Error) throw r
      return r
    }
    return {}
  } } },
}

async function main(): Promise<void> {
  // ── lastGoodAt: only success moves the clock ──────────────────────────────
  const { kvCacheStore } = await import('./KvCacheStore') as any
  const kv: any = kvCacheStore ?? new (await import('./KvCacheStore') as any).KvCacheStore()
  routes['/api/proxy/kvcache'] = () => ({ services: [], stats: {} })
  routes['/api/ai'] = () => ({ services: [], stats: {} })
  await kv.load()
  const t1 = kv.lastGoodAt
  ok(typeof t1 === 'number' && t1 > 0, 'a successful load stamps lastGoodAt')
  routes['/api/proxy/kvcache'] = () => new Error('backend down')
  routes['/api/ai'] = () => new Error('backend down')
  await kv.load()
  ok(kv.lastGoodAt === t1, 'a FAILED load leaves lastGoodAt alone — cached data cannot fake freshness')
  ok(!!kv.error, 'and the error is set alongside the honest age')

  // ── Logs: the two error fields are independent ────────────────────────────
  const { logsStore } = await import('./LogsStore') as any
  const logs: any = logsStore
  routes['/api/system/logs/services'] = () => new Error('list route down')
  await logs.loadServices()
  ok(!!logs.listError, 'a failed service-list load sets listError')
  logs.selectedId = 'svc-a'
  routes['/api/system/logs/svc-a'] = () => ({ output: 'line', source: 'journald', alive: true })
  await logs.fetchLog()
  ok(!!logs.listError, "a SUCCEEDING log fetch does not clear the list's failure — one poll cannot mask the other")
  ok(logs.error == null, 'while the per-log error stays clean for the healthy fetch')
  routes['/api/system/logs/services'] = () => ([{ id: 'svc-a', name: 'A' }])
  await logs.loadServices()
  ok(logs.listError === null, 'a succeeding list load clears its own field')

  // ── unwrapList: drift is loud, never a silent [] or a raw object ──────────
  const { unwrapList } = await import('./fleetFeedApi')
  ok(unwrapList({ categories: [1, 2] }, 'spec-a', 'categories').length === 2, 'the named envelope key unwraps')
  ok(unwrapList([3], 'spec-b', 'categories').length === 1, 'a bare array passes through')
  const drifted = unwrapList({ cats: [1] }, 'spec-c', 'categories')
  ok(Array.isArray(drifted) && drifted.length === 0, 'a renamed key returns [] — never the raw envelope object')
  ok(unwrapList(null, 'spec-d', 'categories').length === 0, 'null returns [] without warning (no response is not drift)')

  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
