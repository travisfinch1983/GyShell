/**
 * Tool-health sweep + strict enumeration — batch 20.
 * Run: tsx packages/backend/src/services/Hermes/toolHealthSweep.extreme.spec.ts
 *
 * getToolHealth existed and detected "Hermes gave up — running with no tools";
 * NOTHING polled it, so the condition was permanent until a human opened the
 * right panel. The sweep latches per agent (one error on gave-up, silence
 * while latched, one info on recovery). And listAgentsStrict closes the
 * catch→[] family: a failed enumeration used to become a successful
 * fleet-wide no-op — worst as applyEffectiveModel's "failed over to X" notify
 * about an action applied to NOBODY. All stubs; no ssh, no live fleet.
 */
import { HermesManagementService } from './HermesManagementService'

let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}

async function main(): Promise<void> {
  const emitted: Array<{ severity: string; source: string; message: string }> = []
  const svc: any = new HermesManagementService({ user: 'spec', notify: (e: any) => emitted.push(e) } as any)

  // ── sweep latch ───────────────────────────────────────────────────────────
  svc.listAgentsStrict = async () => ['alpha', 'beta']
  const health: Record<string, any> = {
    alpha: { groupTools: 5, registeredTools: null, gaveUp: true, gatewayActive: true, healthy: false, detail: 'gave up' },
    beta: { groupTools: 5, registeredTools: 5, gaveUp: false, gatewayActive: true, healthy: true, detail: 'ok' },
  }
  svc.getToolHealth = async (id: string) => health[id]

  await svc.sweepToolHealth()
  ok(emitted.length === 1 && emitted[0].severity === 'error' && emitted[0].message.includes("'alpha'"),
    'a gave-up agent raises ONE error naming it; the healthy agent raises nothing')
  await svc.sweepToolHealth()
  ok(emitted.length === 1, 'latched — the permanent condition does not re-fire every 10 minutes')
  health.alpha = { ...health.alpha, gaveUp: false, healthy: true, detail: 'recovered' }
  await svc.sweepToolHealth()
  ok(emitted.length === 2 && emitted[1].severity === 'info', 'recovery raises one info and re-arms')
  health.alpha = { ...health.alpha, gaveUp: true, healthy: false }
  await svc.sweepToolHealth()
  ok(emitted.length === 3, 'a NEW give-up after recovery fires again')

  // gateway-less agents are not watched (no unit = nothing to be down)
  health.gamma = { groupTools: 0, registeredTools: null, gaveUp: true, gatewayActive: false, healthy: false, detail: 'x' }
  svc.listAgentsStrict = async () => ['gamma']
  const before = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === before, 'an agent with no gateway unit never alarms — absence of a gateway is not a fault')

  // enumeration failure: the sweep skips silently (cannot-check ≠ failed)
  svc.listAgentsStrict = async () => { throw new Error('ssh down') }
  await svc.sweepToolHealth()
  ok(emitted.length === before, 'an unlistable fleet skips the pass — no alarm manufactured from a blind check')

  // ── parked servers: permanence must not read as mere staleness ───────────
  // m-c's catch: "parking until a reconnect is requested" never matched the
  // give-up regex, so an agent with a permanently parked server alarmed as
  // "stale — reconnect to resync". The (K failed) count on the registration
  // line is the structured signal.
  svc.listAgentsStrict = async () => ['delta']
  health.delta = { groupTools: 60, registeredTools: 58, gaveUp: false, parkedServers: 1, parkedNames: ['view-screen'], gatewayActive: true, healthy: false, detail: 'parked' }
  const bp = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === bp + 1 && emitted[bp].severity === 'error' && emitted[bp].message.includes('parked after failed connections'),
    'a parked server alarms at ERROR with its own message — permanence, not staleness')

  // ── getToolHealth parser + honest arithmetic (real method, stubbed I/O) ───
  const svc3: any = new HermesManagementService({ user: 'spec' } as any)
  const groupToolNames = Array.from({ length: 60 }, (_, i) => `srv__t${i}`)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ included_tools: groupToolNames }) })) as any
  let logLines = "2026-08-31 INFO tools.mcp_tool: MCP: registered 58 tool(s) from 1 server(s) (1 failed)"
  svc3.ssh = async (cmd: string) => (cmd.includes('is-active') ? 'active' : logLines)
  let th = await svc3.getToolHealth('cinder')
  ok(th.parkedServers === 1 && th.healthy === false,
    'the (1 failed) registration count surfaces as parkedServers and fails health')
  ok(th.detail.includes('PARKED') && th.detail.includes('permanent'),
    'the detail says the parked tools are GONE until reconnect, not stale')
  ok(th.detail.includes('real shortfall is ~6') && !/not 2\b.*not 2\b/.test(th.detail),
    'HONEST ARITHMETIC: 60-vs-58 is reported as a ~6-tool shortfall — the 4 protocol built-ins net in the comparison, never in the numbers shown')
  logLines = "2026-08-31 INFO tools.mcp_tool: MCP: registered 64 tool(s) from 1 server(s)"
  th = await svc3.getToolHealth('cinder')
  ok(th.parkedServers === 0 && th.healthy === true && th.detail.startsWith('Serving'),
    'a clean registration (group + extras, no failed count) is healthy with no parked note')

  // ── stranded vs pending: the 83-minute scenario ──────────────────────────
  // Gateways reconnected 15:24; the sweep alerted 16:47 saying "reconnect to
  // resync" about agents ALREADY reconnected and merely awaiting their next
  // turn (Hermes registers lazily). m-c nearly restarted six live gateways on
  // that prescription. The unit's ActiveEnterTimestamp against the
  // registration line's timestamp is the discriminator — same host, same
  // clock, same format, so string comparison is exact.
  const mkShow = (ts: string) => `ActiveState=active\nActiveEnterTimestamp=Sun ${ts} UTC`
  let showResp = mkShow('2026-08-31 15:24:36')
  svc3.ssh = async (cmd: string) => (cmd.includes('systemctl show') ? showResp : logLines)
  logLines = "2026-08-30 15:15:19,116 INFO tools.mcp_tool: MCP: registered 58 tool(s) from 1 server(s)"
  th = await svc3.getToolHealth('cinder')
  ok(th.pending === true && th.healthy === false,
    'PENDING: stale registration + LATER gateway restart = remedy already applied, still not healthy')
  ok(th.detail.includes('NEXT TURN') && th.detail.includes('do NOT reconnect again'),
    'the pending detail prescribes waiting, never a second reconnect')
  showResp = mkShow('2026-08-30 14:00:00')   // restart BEFORE the registration
  th = await svc3.getToolHealth('cinder')
  ok(th.pending === false && th.detail.includes('Reconnect to resync'),
    'STRANDED: registration after the last restart keeps the reconnect prescription')

  // ── ONE remedy per composed message (m-c's defect + claude1's invariant) ──
  // Each half was individually correct; only the COMPOSITION contradicted
  // itself ("do NOT reconnect" + "Reconnect to restore"). Per-half tests pass
  // on that bug — the assertion has to look at the whole message.
  const countRemedies = (d: string) => {
    const doNot = /do NOT reconnect/i.test(d) ? 1 : 0
    const doRe = (d.match(/[Rr]econnect (to resync|from the agent|retries)/g) ?? []).length
    return doNot + (doRe > 0 ? 1 : 0)
  }
  showResp = mkShow('2026-08-31 15:24:36')   // pending again…
  logLines = "2026-08-31 15:20:00,000 INFO tools.mcp_tool: MCP server 'view-screen' failed initial connection after 3 attempts, parking until a reconnect is requested\n"
    + "2026-08-30 15:15:19,116 INFO tools.mcp_tool: MCP: registered 58 tool(s) from 1 server(s) (1 failed)"
  th = await svc3.getToolHealth('cinder')
  // STALE parked evidence: both the parking line and the registration predate the
  // reconnect, so the parked observation may already be fixed. Real case that forced
  // this — view-screen was removed from config 2026-08-30 19:24 while the alarm kept
  // asserting it 21h later off a 15:15 registration made BEFORE the removal.
  ok(th.parkedStale === true,
    'parked evidence older than the reconnect is marked STALE — the config can have changed since')
  ok(countRemedies(th.detail) === 1 && /do NOT reconnect/.test(th.detail),
    'when the parked evidence is stale the PENDING half keeps the single remedy (wait) — a stale observation must not prescribe an action')
  ok(!/re-parks immediately/.test(th.detail) && /may already be resolved/.test(th.detail),
    'the stale parked note is PRESCRIPTION-FREE and says so — reported, never suppressed, at its true weight')
  ok(th.parkedNames.includes('view-screen') && th.detail.includes('view-screen'),
    'the parked server is NAMED even when stale — a name matches against known-dead shims, a count cannot')

  // FRESH parked evidence: the registration POST-DATES the reconnect, so the failure is
  // current and owns the remedy exactly as before.
  showResp = mkShow('2026-08-31 15:24:36')
  logLines = "2026-08-31 15:30:00,000 INFO tools.mcp_tool: MCP server 'view-screen' failed initial connection after 3 attempts, parking until a reconnect is requested\n"
    + "2026-08-31 15:31:10,000 INFO tools.mcp_tool: MCP: registered 58 tool(s) from 1 server(s) (1 failed)"
  th = await svc3.getToolHealth('cinder')
  ok(th.parkedStale === false && th.parkedServers === 1,
    'parked evidence NEWER than the reconnect is NOT stale — a current failure stays current')
  ok(countRemedies(th.detail) === 1 && /re-parks immediately/.test(th.detail),
    'fresh parked evidence owns the single remedy, with the re-park caveat intact')

  // THE GENERALISATION, above any one field: an alarm must never assert a LIVE fault
  // from evidence it has itself declared stale. This covers registration-derived fields
  // neither of us has added yet.
  showResp = mkShow('2026-08-31 15:24:36')
  logLines = "2026-08-31 15:20:00,000 INFO tools.mcp_tool: MCP server 'view-screen' failed initial connection after 3 attempts, parking until a reconnect is requested\n"
    + "2026-08-30 15:15:19,116 INFO tools.mcp_tool: MCP: registered 58 tool(s) from 1 server(s) (1 failed)"
  th = await svc3.getToolHealth('cinder')
  ok(!(th.pending && th.parkedStale && /are PARKED —/.test(th.detail)),
    'INVARIANT: no live-fault assertion is made from evidence the same message calls stale')
  logLines = "2026-08-30 15:15:19,116 INFO tools.mcp_tool: MCP: registered 58 tool(s) from 1 server(s)"
  th = await svc3.getToolHealth('cinder')
  ok(countRemedies(th.detail) === 1 && /do NOT reconnect/.test(th.detail),
    'pending WITHOUT parked keeps its own single remedy: wait, do not reconnect')

  // sweep severities: pending → one INFO; >24h-old restart → warning backstop
  svc.listAgentsStrict = async () => ['echo']
  // Local-time strings, matching production where systemctl and the parser run
  // on the same box (an earlier draft used toISOString — UTC — and the 25h case
  // silently became 18h on a UTC-7 host).
  const localTs = (msAgo: number) => {
    const d = new Date(Date.now() - msAgo)
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }
  const recent = localTs(3600_000)
  health.echo = { groupTools: 60, registeredTools: 58, gaveUp: false, parkedServers: 0, pending: true, gatewayRestartedAt: recent, gatewayActive: true, healthy: false, detail: 'pending' }
  const bq = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === bq + 1 && emitted[bq].severity === 'info' && emitted[bq].message.includes('pending its next turn'),
    'a pending agent raises INFO, not the stale-set warning — no one is sent to re-run the remedy')
  svc.toolHealthAlarmed.delete('echo')
  health.echo.gatewayRestartedAt = localTs(25 * 3600_000)
  await svc.sweepToolHealth()
  ok(emitted[emitted.length - 1].severity === 'warning' && emitted[emitted.length - 1].message.includes('24h+'),
    'pending with a restart >24h old escalates — an agent that never speaks is stranded in effect')
  globalThis.fetch = realFetch

  // ── strict enumeration: the failover no-op family ─────────────────────────
  const svc2: any = new HermesManagementService({ user: 'spec', notify: (e: any) => emitted.push(e), supportModelsFile: undefined } as any)
  svc2.loadSupportModels = () => ({ tts: { model: 'primary-x', primaryModel: 'primary-x' } })
  svc2.listAgentsStrict = async () => { throw new Error('enumeration down') }
  const b2 = emitted.length
  await svc2.applyEffectiveModel('tts', 'backup-y', "primary 'primary-x' unreachable")
  ok(emitted.length === b2,
    'applyEffectiveModel with a dead enumeration emits NO failover notify — no alarm asserting an action that did not happen')
  ok(svc2.loadSupportModels().tts.model === 'primary-x',
    'and the role file is untouched — the failover genuinely did not happen')

  let threw = false
  try { await svc2.setGlobalNativeTools([]) } catch { threw = true }
  ok(threw, 'setGlobalNativeTools with a dead enumeration THROWS instead of returning agents:0 ok')

  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
