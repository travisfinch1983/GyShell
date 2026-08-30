/**
 * "Load failed" must never render as "nothing exists" — store-level behaviour.
 * Run: tsx packages/ui/src/renderer_v2/stores/loadFailedNotEmpty.extreme.spec.ts
 *
 * 🛑 Why this is CHECKED IN and not a scratch harness (claude1, 2026-08-30,
 * after batch 6 shipped with its verification uncommitted): these behaviours
 * are invisible by construction. If stale-list retention or error naming
 * regresses, the UI looks FINE — it renders a plausible empty list — so no
 * amount of using the app can catch the regression. An uncommitted
 * verification is a claim; this file is the artifact anyone can re-run.
 */
async function main(): Promise<void> {
  let n = 0
  const ok = (c: boolean, m: string) => { if (!c) { console.error('FAILED:', m); process.exit(1) } n++; console.log('  ok —', m) }

  // Routable stub bridge: per-path behaviour, switchable mid-test.
  const routes: Record<string, () => any> = {}
  ;(globalThis as any).window = {
    gyshell: { cluster: { request: async (_m: string, path: string) => {
      for (const k of Object.keys(routes)) if (path.startsWith(k)) return routes[k]()
      return {}
    } } },
  }

  // ── MCP store: per-fetch failure isolation ──────────────────────────────────
  const { mcpServersStore: mcp } = await import('./McpServersStore.ts')
  routes['/api/mcp/health'] = () => ({ status: 'ok' })
  routes['/api/mcp/servers'] = () => [{ name: 'srv-a' }]
  routes['/api/mcp/tools'] = () => []
  routes['/api/mcp/settings'] = () => ({ maxToolRounds: 20 })
  await mcp.load()
  ok(mcp.servers.length === 1 && mcp.err === '', 'healthy load: one server, no error')

  routes['/api/mcp/servers'] = () => { throw new Error('boom 502') }
  await mcp.load()
  ok(mcp.err.includes('servers'), 'a dead /servers route sets err NAMING the failed fetch')
  ok(mcp.servers.length === 1 && mcp.servers[0].name === 'srv-a',
    'and the PREVIOUS list is kept — a stale list beats a wrong "No MCP servers registered"')
  ok(mcp.connected, 'while health, which succeeded, still reads connected — the two no longer contradict silently')

  routes['/api/mcp/servers'] = () => [{ name: 'srv-a' }, { name: 'srv-b' }]
  await mcp.load()
  ok(mcp.err === '' && mcp.servers.length === 2, 'recovery clears err and refreshes the list')

  // ── Pages store: zod on the two newest lists ────────────────────────────────
  const { pagesStore } = await import('./PagesStore.ts')
  const ps = pagesStore as any
  const goodReport = {
    id: 'r1', type: 'maintenance', title: 'T', createdAt: 'x', updatedAt: 'y',
    currentVersion: 1, authors: [], links: [], versionCount: 1,
  }
  routes['/api/reports/types'] = () => ({ types: [] })
  routes['/api/reports'] = () => ({ reports: [goodReport] })
  await ps.loadReports()
  ok(ps.reportList.length === 1 && ps.reportList[0].versionCount === 1,
    'a valid report list parses — including versionCount, which reportMetaSchema would have REFUSED')

  routes['/api/reports'] = () => ({ reports: [{ id: 'r2', title: 42 }] })   // drifted shape
  await ps.loadReports()
  ok(ps.error && String(ps.error).length > 0, 'a drifted report shape surfaces as a LOUD error')
  ok(ps.reportList.length === 1 && ps.reportList[0].id === 'r1',
    'and the previous list is kept — drift does not render as quietly-wrong rows')

  ps.error = null
  const goodEntry = {
    id: 'j-1', issue: 'x', originalIssue: 'x', keys: [], status: 'open', notes: '',
    reportIds: [], links: [], createdAt: 'a', updatedAt: 'b', revisions: [],
  }
  routes['/api/journal'] = () => ({ entries: [goodEntry] })
  await ps.loadJournal()
  ok(ps.journal.length === 1, 'a valid journal list parses')
  routes['/api/journal'] = () => ({ entries: [{ id: 'j-2' }] })            // missing required fields
  await ps.loadJournal()
  ok(ps.error && ps.journal.length === 1 && ps.journal[0].id === 'j-1',
    'a drifted journal shape errors loudly and keeps the previous entries')

  console.log(`\n${n} assertions passed`)
}

main().catch((e) => { console.error(e); process.exit(1) })

export {}
