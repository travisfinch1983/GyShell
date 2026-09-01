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
import { existsSync, mkdirSync, rmSync } from 'fs'
import { AlarmLatch } from '../AlarmLatch'
import { HermesManagementService } from './HermesManagementService'

// The latch is now PERSISTED, so the spec must own its file or it would read real fleet state
// and leave its own behind. Set before any service is constructed.
const LATCH = `/tmp/hermes-tool-alarms.spec.${process.pid}.json`
process.env.HERMES_TOOL_ALARMS_FILE = LATCH
const resetLatch = (): void => { if (existsSync(LATCH)) rmSync(LATCH) }
resetLatch()

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
    alpha: { groupTools: 5, registeredTools: null, gaveUp: true, gatewayActive: true, known: true, healthy: false, detail: 'gave up' },
    beta: { groupTools: 5, registeredTools: 5, gaveUp: false, gatewayActive: true, known: true, healthy: true, detail: 'ok' },
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
  health.gamma = { groupTools: 0, registeredTools: null, gaveUp: true, gatewayActive: false, known: true, healthy: false, detail: 'x' }
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
  health.delta = { groupTools: 60, registeredTools: 58, gaveUp: false, parkedServers: 1, parkedNames: ['view-screen'], gatewayActive: true, known: true, healthy: false, detail: 'parked' }
  const bp = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === bp + 1 && emitted[bp].severity === 'error' && emitted[bp].message.includes('parked after failed connections'),
    'a parked server alarms at ERROR with its own message — permanence, not staleness')

  // ── UNKNOWN: an unread check is neither a pass nor a fault ───────────────
  // The old code set healthy=true when no registration line was found, so a rotated
  // or truncated log read as a clean bill of health — and, worse, satisfied the
  // recovery branch, letting an unreadable log RETRACT a live alarm. m-c saw the
  // effect from outside: cinder-kyla was absent from a batch of five true alerts.
  svc.listAgentsStrict = async () => ['zeta']
  health.zeta = { groupTools: 60, registeredTools: null, gaveUp: false, parkedServers: 0, gatewayActive: true, known: false, healthy: false, detail: 'unknown' }
  const bu = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === bu + 1 && emitted[bu].severity === 'warning' && emitted[bu].message.includes('cannot be determined'),
    'an unreadable registration warns that health is UNKNOWN — it does not pass silently')
  await svc.sweepToolHealth()
  ok(emitted.length === bu + 1, 'the unknown state latches on its own — no repeat every sweep')

  // The load-bearing one: a real alarm must survive a blind check.
  svc.listAgentsStrict = async () => ['eta']
  health.eta = { groupTools: 5, registeredTools: null, gaveUp: true, parkedServers: 0, gatewayActive: true, known: true, healthy: false, detail: 'gave up' }
  const bs = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === bs + 1 && emitted[bs].severity === 'error', 'eta alarms for real')
  health.eta = { ...health.eta, known: false, detail: 'log rotated' }
  await svc.sweepToolHealth()
  const last = emitted[emitted.length - 1]
  ok(last.severity === 'warning' && last.message.includes('cannot be determined'),
    'when the log then becomes unreadable, the sweep says UNKNOWN — it does NOT emit "recovered"')
  ok(!emitted.slice(bs).some((e) => e.message.includes('recovered')),
    'no false recovery: an alarm is retracted only by positive evidence of health')
  ok(svc.toolAlarms().has('eta', 'gaveup'), 'and the original alarm stays latched/open underneath')
  ok((last as any).detail.includes('REMAINS OPEN'),
    'the unknown warning tells the reader the earlier alarm is still open')

  // Recovery still works when the evidence actually returns.
  health.eta = { ...health.eta, known: true, gaveUp: false, healthy: true, detail: 'ok now' }
  const br = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === br + 1 && emitted[br].severity === 'info' && emitted[br].message.includes('recovered'),
    'a readable, healthy registration DOES clear the alarm')

  // ── the latch is PERSISTED: a restart must not re-announce what has not changed ──
  // 28 ai-lab.service restarts in one dev day each re-announced every still-true condition.
  // Nothing new had happened; the observer had forgotten. A notification must describe a change
  // in the WORLD, not a change in the watcher.
  svc.listAgentsStrict = async () => ['theta']
  health.theta = { groupTools: 5, registeredTools: null, gaveUp: true, parkedServers: 0, gatewayActive: true, known: true, healthy: false, detail: 'gave up' }
  const bth = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === bth + 1, 'theta alarms once')

  // A brand-new service instance = a process restart, reading the same on-disk latch.
  const svcRestart: any = new HermesManagementService({ user: 'spec', notify: (e: any) => emitted.push(e) } as any)
  svcRestart.listAgentsStrict = svc.listAgentsStrict
  svcRestart.getToolHealth = svc.getToolHealth
  await svcRestart.sweepToolHealth()
  ok(emitted.length === bth + 1, 'ACROSS A RESTART the same still-true condition is NOT re-announced')

  // Condition classes latch independently — a parked latch must not swallow a later give-up.
  const latch = new AlarmLatch(LATCH)
  ok(latch.has('theta', 'gaveup') && !latch.has('theta', 'parked'),
    'the latch is keyed on (subject, condition-class), not subject alone')

  // Expiry: a long-standing condition re-announces occasionally rather than going silent forever,
  // and SAYS it is a restatement — repetition presented as news is its own kind of lie.
  let fakeNow = Date.now()
  const expiring = new AlarmLatch(`${LATCH}.exp`, 1000, () => fakeNow)
  ok(expiring.claim('x', 'gaveup') === '', 'first claim announces, with no restatement note')
  ok(expiring.claim('x', 'gaveup') === null, 'second claim inside the window is suppressed')
  fakeNow += 2000
  const again = expiring.claim('x', 'gaveup')
  ok(typeof again === 'string' && again.includes('re-stated because it is still true'),
    'after the window it re-announces AND labels itself a restatement, not news')

  // Positive evidence still clears — persistence must not reopen the false-recovery door.
  health.theta = { ...health.theta, gaveUp: false, healthy: true, registeredTools: 5, detail: 'ok' }
  const bcl = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === bcl + 1 && emitted[bcl].message.includes('recovered'),
    'positive evidence clears the persisted latch and reports recovery once')
  ok(!new AlarmLatch(LATCH).has('theta', 'gaveup'), 'and the cleared state is persisted, not just in memory')

  // ── a departed subject keeps no latch ─────────────────────────────────────
  // m-c traced the clear-path and found the one real hole: an agent deleted and RECREATED with
  // the same id inside the re-announce window inherits the old latch, so a genuine first fault
  // on the new agent is silent. Leaving the roster is a THIRD kind of evidence — not "healthy"
  // and not "unknown", but "this subject no longer exists".
  const pl = new AlarmLatch(`${LATCH}.prune`)
  pl.claim('gone-agent', 'gaveup')
  pl.claim('kept-agent', 'parked')
  pl.claim('weird:id:with:colons', 'stale')
  const removed = pl.pruneSubjects(['kept-agent', 'weird:id:with:colons'])
  ok(removed.length === 1 && removed[0] === 'gone-agent:gaveup',
    'pruning drops ONLY the departed subject')
  ok(pl.has('kept-agent', 'parked'), 'a subject still on the roster keeps its latch')
  ok(pl.has('weird:id:with:colons', 'stale'),
    'subject ids containing colons survive — the key splits on the LAST colon, not the first')
  // A recreated id now starts clean, which is the whole point.
  ok(pl.claim('gone-agent', 'gaveup') === '',
    'a recreated id announces its first fault as NEW, not as a suppressed restatement')

  // The dangerous misuse the contract warns about, asserted so the guarantee is checked and not
  // merely documented: an EMPTY roster wipes everything. This is why the caller must pass a
  // roster whose enumeration threw on failure — a catch-to-[] would silently disarm every alarm.
  const pl2 = new AlarmLatch(`${LATCH}.prune2`)
  pl2.claim('a', 'gaveup'); pl2.claim('b', 'parked')
  ok(pl2.pruneSubjects([]).length === 2,
    'an EMPTY roster removes every entry — proving why only a TRUSTED (throwing) enumeration may be passed')

  // ── listAgentsStrict must EARN its name (real method, real filesystem) ────
  // It carried `|| true` and `2>/dev/null`, which forced exit 0 for every failure — so it could
  // never throw, and returned [] instead. Five call sites documented the opposite guarantee
  // ("a failed enumeration must surface as an error, not as {agents:0} ok") and none of them had
  // it. The guarantee lived in the NAME and in comments, never in the body. These run the REAL
  // method against the REAL filesystem, because a stubbed ssh() would have passed either way.
  const emptyDir = `/tmp/hermes-profiles-empty.${process.pid}`
  mkdirSync(emptyDir, { recursive: true })
  const svcEnum: any = new HermesManagementService({ user: 'spec', profileHomeBase: emptyDir } as any)
  ok((await svcEnum.listAgentsStrict()).length === 0,
    'an EMPTY profiles dir returns [] and does NOT throw — "no agents" stays a legitimate answer')

  svcEnum.profileHomeBase = `/tmp/hermes-profiles-missing.${process.pid}`
  let enumThrew = false
  try { await svcEnum.listAgentsStrict() } catch { enumThrew = true }
  ok(enumThrew, 'an UNREADABLE profiles dir THROWS — cannot-check must never collapse into zero')
  rmSync(emptyDir, { recursive: true, force: true })

  // …and the sweep must not destroy state on that path. This is the bug that shipped in 8a36dfa:
  // enumeration returning [] meant the loop iterated nothing and pruneSubjects([]) wiped every
  // latch, persisting the disarmed state. Two guards now; assert BOTH hold.
  const survivor = new AlarmLatch(`${LATCH}.survive`)
  survivor.claim('someone', 'gaveup')
  survivor.save()
  const svcWipe: any = new HermesManagementService({ user: 'spec', notify: () => {} } as any)
  svcWipe.toolAlarmsLatch = new AlarmLatch(`${LATCH}.survive`)
  svcWipe.listAgentsStrict = async () => { throw new Error('profiles unreadable') }
  await svcWipe.sweepToolHealth()
  ok(new AlarmLatch(`${LATCH}.survive`).has('someone', 'gaveup'),
    'a THROWING enumeration leaves every latch intact — the sweep returns before pruning')

  const svcEmpty: any = new HermesManagementService({ user: 'spec', notify: () => {} } as any)
  svcEmpty.toolAlarmsLatch = new AlarmLatch(`${LATCH}.survive`)
  svcEmpty.listAgentsStrict = async () => []
  await svcEmpty.sweepToolHealth()
  ok(new AlarmLatch(`${LATCH}.survive`).has('someone', 'gaveup'),
    'and an EMPTY roster prunes NOTHING — the second guard, which would have contained the damage on its own')

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
  health.echo = { groupTools: 60, registeredTools: 58, gaveUp: false, parkedServers: 0, pending: true, gatewayRestartedAt: recent, gatewayActive: true, known: true, healthy: false, detail: 'pending' }
  const bpend = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === bpend, 'PENDING EMITS NOTHING — a stale registration after a reconnect is the normal RESTING state of an agent nobody has messaged, not a fault')

  // The escalation that used to live here fired on five agents for a system working exactly as
  // designed. A Hermes agent is always online; its ACP session simply is not connected until
  // something messages it, and the refresh loads on first contact. There is no idle duration
  // that separates "dormant by design" from "stranded", because stranded-after-reconnect does
  // not exist — so a longer threshold would be the same bug firing less often.
  health.echo = { ...health.echo, gatewayRestartedAt: '2026-08-20 10:00:00' }
  await svc.sweepToolHealth()
  ok(emitted.length === bpend, 'and it still emits nothing after DAYS of idling — no threshold resurrects a signal with no referent')

  // Restore the real fetch — the block above stubs it, and leaving the stub installed would
  // silently poison every later test in this process. I deleted this line while rewriting the
  // pending assertions, and tsc surfaced it only as "realFetch is unused" — a dangling
  // teardown reads as a trivial lint warning right up until it isn't.
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

  resetLatch()
  if (existsSync(`${LATCH}.exp`)) rmSync(`${LATCH}.exp`)
  for (const x of ['.prune', '.prune2', '.survive']) if (existsSync(`${LATCH}${x}`)) rmSync(`${LATCH}${x}`)
  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
