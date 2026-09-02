import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve as dnsResolve } from 'node:dns/promises'
import path from 'node:path'
import { AlarmLatch } from '../AlarmLatch'
import { TaskProgress, type TaskReportInput } from './TaskProgress'

/**
 * NotificationsService — the answer to "far too many things can fail silently
 * in the background and I have no way of knowing" (Travis, 2026-08-30).
 *
 * Three surfaces, one service:
 *  - EVENTS: a persisted running list of warnings/errors/criticals. Anything in
 *    the backend can call notify(); anything OUTSIDE it (systemd timers, prune
 *    scripts, audits) can POST /api/notifications/emit. Events survive restarts —
 *    a silent failure that evaporates on reboot is still silent.
 *  - DEBUG: an in-memory ring of informational messages for the live console.
 *    Deliberately not persisted and deliberately not part of the badge count.
 *  - HEALTH: a config-driven prober over the estate's dependencies. States are
 *    honest: ok / down(reason) / UNKNOWN. Unknown means "the check itself could
 *    not run" and renders grey — an unreachable prober is not evidence the
 *    dependency is down (the failover-watcher lesson). A wrong severity trains
 *    the operator to ignore the panel, which is worse than no panel.
 *
 * Live updates ride the EXISTING gateway raw-broadcast channel (notify:event /
 * notify:debug / notify:health) — no second transport.
 *
 * Dependency endpoints live in <dataDir>/notifications-health.json, seeded once
 * from defaults VERIFIED against the running estate (claude1's probe sweep,
 * 2026-08-30 — two of his first guesses 404'd against healthy services, hence
 * the rule: endpoints are config, verified, never inferred).
 */

export type NotifySeverity = 'info' | 'warning' | 'error' | 'critical'

export interface NotifyEvent {
  id: string
  ts: string
  severity: NotifySeverity
  source: string
  message: string
  detail?: string
  acked?: boolean
  /** How many times this exact event has been raised while unacked (≥2 = a repeat). */
  occurrences?: number
  /** Occurrences whose wake-up was suppressed by the coalesce window (recorded, not silent). */
  routeCoalesced?: number
  /** Route to the maintainer even at info severity. Reserved for events about
   *  the maintainer's OWN alert path (the RESUMED notice) — the one info the
   *  recipient must not have to discover by watching a panel it doesn't watch. */
  routeInfo?: boolean
  /** When the most recent occurrence arrived (ts stays the FIRST). */
  lastTs?: string
}

export interface HealthCheckConfig {
  id: string
  label: string
  kind: 'http' | 'dns'
  /** http: URL to GET. dns: hostname to resolve. */
  target: string
  /** http only: acceptable statuses. 'any-response' = any HTTP response proves liveness. */
  expect?: number[] | '2xx3xx' | 'any-response'
  timeoutMs?: number
  /**
   * Consecutive failed probes required before this dependency is declared DOWN.
   * A single missed probe is a blip, not an outage: the alarm wakes a maintainer,
   * so it must cost more than one slow response to raise. The status board still
   * shows the live result immediately -- only the EVENT waits for confirmation.
   */
  confirmations?: number
  /**
   * Another check this one is reached THROUGH. When the transport is already
   * confirmed down, this check's own DOWN event is suppressed — one dead
   * dependency used to page CRITICAL + ERROR + WARNING for a single fault
   * (proxy + embeddings + reranker, 2026-08-31). The board still shows this
   * dot red with the dependency named; only the redundant EVENT is withheld.
   */
  dependsOn?: string
  /** Severity of the event raised when this dependency goes down. */
  downSeverity: 'warning' | 'error' | 'critical'
}

export interface HealthState {
  id: string
  label: string
  status: 'ok' | 'down' | 'unknown'
  reason?: string
  checkedAt: string
  downSeverity: HealthCheckConfig['downSeverity']
}

/**
 * A dependency must fail this many probes in a row before it is called DOWN.
 * At the default 30s interval that is a minute of real failure, which a genuine
 * outage survives easily and a slow response does not.
 *
 * Read per call, not once at module load: an env value captured at import time
 * cannot be overridden by a test that imports the module, which quietly makes the
 * knob untestable from the only place that needs to turn it.
 */
function defaultConfirmations(): number {
  const n = Number(process.env.AILAB_HEALTH_CONFIRMATIONS ?? 2)
  return Number.isFinite(n) && n >= 1 ? n : 2
}

const EVENT_CAP = 1000
// How many ACKED events the panel carries alongside EVERY unacked one. Unacked events are never
// windowed out: an acked event is one somebody has already seen, an unacked one is outstanding
// work, and only the first is safe to hide.
const ACKED_VIEW = 200
const DEBUG_CAP = 500

/**
 * Down-events raised soon after the backend's own start carry BOOT CONTEXT —
 * "the backend started Ns ago and this dependency never came up with it" —
 * because that is a different fault (a listener that did not bind, likely a
 * broken deploy) than a service that fell over. DELIBERATELY NO quiet period:
 * a suppression window was drafted here and reverted the same hour — the one
 * episode that motivated it (2026-08-31 20:43) turned out to be a parse error
 * shipped to civitai.js, the CRITICAL was the only correct alert of the day,
 * and a grace window would have delayed exactly it. The confirmations
 * debounce (2 probes ≈ 60s) is the whole delay an alert gets.
 */
const BOOT_CONTEXT_WINDOW_MS = 5 * 60_000

/**
 * Defaults verified live on CT152 2026-08-30. Weaviate is 8087 (8081 is
 * dynacat); hippocampai health is /healthz not /health; unified-memory has no
 * health route — a 406 to a bare GET is its liveness proof.
 */
const DEFAULT_CHECKS: HealthCheckConfig[] = [
  { id: 'ailab-proxy', label: 'AI-Lab proxy', kind: 'http', target: 'http://127.0.0.1:17890/api/proxy/llm/v1/models', expect: '2xx3xx', downSeverity: 'critical' },
  { id: 'mcpjungle', label: 'MCPJungle gateway', kind: 'http', target: 'http://127.0.0.1:8080/api/v0/servers', expect: '2xx3xx', downSeverity: 'critical' },
  { id: 'fleetd', label: 'fleetd (fleet messaging)', kind: 'http', target: 'http://127.0.0.1:17900/health', expect: '2xx3xx', downSeverity: 'error' },
  { id: 'qdrant', label: 'Qdrant', kind: 'http', target: 'http://127.0.0.1:6333/readyz', expect: '2xx3xx', downSeverity: 'error' },
  { id: 'weaviate', label: 'Weaviate', kind: 'http', target: 'http://127.0.0.1:8087/v1/.well-known/ready', expect: '2xx3xx', downSeverity: 'error' },
  { id: 'chroma', label: 'ChromaDB', kind: 'http', target: 'http://127.0.0.1:8000/api/v2/heartbeat', expect: '2xx3xx', downSeverity: 'error' },
  { id: 'hippocampai', label: 'HippocampAI memory', kind: 'http', target: 'http://127.0.0.1:8010/healthz', expect: '2xx3xx', downSeverity: 'error' },
  { id: 'openviking', label: 'OpenViking memory', kind: 'http', target: 'http://127.0.0.1:1933/health', expect: '2xx3xx', downSeverity: 'error' },
  // Fans out to five vector DBs behind MCPJungle, so a busy moment can outlast the
  // default deadline without anything being wrong. Longer timeout AND an extra
  // confirmation: this one is the most likely to be slow rather than dead.
  { id: 'unified-memory', label: 'Unified memory MCP', kind: 'http', target: 'http://127.0.0.1:9847/u/healthprobe/mcp', expect: 'any-response', timeoutMs: 15_000, confirmations: 3, downSeverity: 'error' },
  { id: 'pages-mcp', label: 'Pages MCP', kind: 'http', target: 'http://127.0.0.1:9848/health', expect: '2xx3xx', downSeverity: 'warning' },
  // ── Sweep additions (claude1's continuous-dependence rule, 2026-08-30): a dot
  // earns its place when something depends on the service CONTINUOUSLY and its
  // failure is otherwise SILENT. All three targets verified live before adding.
  // Rejected under the same rule (recorded on the roadmap, not re-litigated
  // here): searxng, sftpgo (intermittent — fail loudly at point of use),
  // Prometheus, ProxLab upstream (not load-bearing for AI-Lab's own function).
  // /models exercises the POOL behind the proxy route, not just the listener —
  // the proxy answering while the pool is down was the whole point.
  { id: 'embeddings', label: 'Embeddings pool', kind: 'http', target: 'http://127.0.0.1:17890/api/proxy/embed/v1/models', expect: '2xx3xx', downSeverity: 'error', dependsOn: 'ailab-proxy' },
  { id: 'reranker', label: 'Recall reranker', kind: 'http', target: 'http://127.0.0.1:17890/api/proxy/rerank/v1/models', expect: '2xx3xx', downSeverity: 'warning', dependsOn: 'ailab-proxy' },
  { id: 'instance-manager', label: 'Claude instance manager', kind: 'http', target: 'http://10.0.0.161:7700/instances', expect: '2xx3xx', downSeverity: 'error' },
  { id: 'internet', label: 'Internet reachability', kind: 'http', target: 'https://1.1.1.1', expect: 'any-response', downSeverity: 'warning' },
  { id: 'dns', label: 'DNS resolution', kind: 'dns', target: 'github.com', downSeverity: 'warning' },
]

export class NotificationsService {
  private events: NotifyEvent[] = []
  private debugRing: Array<{ ts: string; source: string; message: string }> = []
  private health = new Map<string, HealthState>()
  /** Consecutive down-probes per check id. Reset by any ok, untouched by unknown. */
  private downStreak = new Map<string, number>()
  /** Check ids we have actually raised a DOWN event for, so recovery pairs with it. */
  /** Health-dot alarm latch — PERSISTED (shared AlarmLatch): a backend restart
   *  must be silent about dots it already announced and loud only about new
   *  faults. Same disease as the hermes-tools set, same cure, one definition.
   *  Assigned in the CONSTRUCTOR BODY, not a field initializer: class fields
   *  initialize before parameter properties are assigned, so `this.dataDir`
   *  is undefined here — the spec caught the crash before production did. */
  private readonly alarmLatch: AlarmLatch
  private checks: HealthCheckConfig[] = []
  private readonly bootAt = Date.now()
  private timer: ReturnType<typeof setInterval> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistFailedReported = false
  private seq = 0

  /** Deferred self-reports queued during construction — raised only AFTER the
   *  routing (suspension) state has loaded, so a config problem found at boot
   *  can never wake the maintainer through a not-yet-loaded suspension. */
  private readonly bootReports: Array<{ severity: NotifySeverity; source: string; message: string; detail?: string }> = []

  constructor(
    private readonly dataDir: string,
    /** gatewayService.broadcastRaw — the one live transport. */
    private readonly broadcast: (channel: string, data: unknown) => void,
    intervalMs = Number(process.env.AILAB_HEALTH_INTERVAL_MS ?? 30_000),
  ) {
    // 🛑 Clamp, never trust: Number('30s') is NaN, and setInterval(fn, NaN)
    // fires every ~1ms — a probe STORM from a typo'd env var, with state()
    // reporting NaN to the panel. Below 5s the probes overlap their own
    // timeouts. Both are config mistakes the board must survive, not obey.
    this.alarmLatch = new AlarmLatch(path.join(dataDir, 'notifications-alarms.json'))
    // Constructed HERE, not as a field initializer: class fields run before parameter
    // properties are assigned, and `broadcast` would be undefined (the AlarmLatch
    // lesson, same class of crash).
    this.tasks = new TaskProgress((ch, data) => this.broadcast(ch, data))
    if (!Number.isFinite(intervalMs) || intervalMs < 5_000) {
      const bad = intervalMs
      intervalMs = 30_000
      this.bootReports.push({
        severity: 'warning', source: 'health-board',
        message: 'Health probe interval was invalid — clamped to 30s',
        detail: `AILAB_HEALTH_INTERVAL_MS resolved to ${String(bad)}; anything non-numeric or under 5000ms would probe-storm or overlap timeouts. Running at 30000ms instead.`,
      })
      console.warn(`[notifications] invalid AILAB_HEALTH_INTERVAL_MS (${String(bad)}) — clamped to 30000`)
    }
    this.intervalMs = intervalMs
    mkdirSync(this.dir(), { recursive: true })
    // Routing FIRST: everything after this may queue a boot report, and the
    // flush below must see the persisted suspension before anything routes.
    this.loadRouting()
    this.loadEvents()
    this.loadChecks()
    setTimeout(() => {
      for (const r of this.bootReports) this.notify(r)
      this.bootReports.length = 0
    }, 1_000)
  }

  private readonly intervalMs: number

  private dir(): string {
    return path.join(this.dataDir, 'notifications')
  }

  private eventsFile(): string {
    return path.join(this.dir(), 'events.json')
  }

  private routingFile(): string {
    return path.join(this.dir(), 'routing.json')
  }

  private loadRouting(): void {
    try {
      if (!existsSync(this.routingFile())) return
      const raw = JSON.parse(readFileSync(this.routingFile(), 'utf8'))
      // Suspension must survive a restart. A toggle that quietly re-arms on the next deploy
      // would wake the agent mid-build, which is the thing being switched off.
      this.routing = { ...this.routing, ...raw, suppressedEvents: raw.suppressedEvents ?? [] }
    } catch (e) {
      console.warn('[notify] could not read routing state, defaulting to ACTIVE:', (e as Error)?.message)
    }
  }

  private saveRouting(): void {
    try {
      mkdirSync(this.dir(), { recursive: true })
      writeFileSync(this.routingFile(), JSON.stringify(this.routing, null, 2))
    } catch (e) {
      console.warn('[notify] could not persist routing state:', (e as Error)?.message)
    }
  }

  /**
   * The maintainer name is config pointing at an agent — and config naming
   * something that does not exist is this estate's oldest silent failure: a
   * renamed or deleted agent turns every alarm into a console.warn. Checked
   * once at start against the fleet directory. Cannot-check ≠ failed: an
   * unreachable directory is not evidence about the agent, so it stays quiet.
   */
  private async validateMaintainer(): Promise<void> {
    if (this.envDisabled()) return
    const to = process.env.AILAB_MAINTAINER_AGENT || 'maintenance-claude'
    const fleetd = process.env.FLEETD_URL || 'http://127.0.0.1:17900'
    try {
      const r = await fetch(`${fleetd}/directory`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) return
      // fleetd returns agent_id / display_name. The previous annotation declared id / name,
        // so TypeScript validated field names that were ASSUMED rather than observed — every row
        // compared undefined and the check could never succeed on a non-empty directory.
        // id/name kept as fallbacks in case the payload shape ever changes.
        type DirRow = { agent_id?: string; display_name?: string; id?: string; name?: string }
        const dir = await r.json() as { agents?: DirRow[] } | DirRow[]
      const rows = Array.isArray(dir) ? dir : (dir.agents ?? [])
      if (!rows.length) return   // an empty listing is not proof of absence
      const known = rows.some((a) => a.agent_id === to || a.display_name === to || a.id === to || a.name === to)
      if (!known) {
        this.notify({
          severity: 'warning', source: 'health-board',
          message: `Alarm recipient '${to}' is not in the fleet directory`,
          detail: `Every warning+ event routes to '${to}', but fleetd's directory does not list it — a renamed or deleted agent means alarms deliver to nobody while looking sent. Fix AILAB_MAINTAINER_AGENT or restore the agent.`,
        })
      }
    } catch { /* directory unreachable — the fleetd health dot owns that story */ }
  }

  /** Whether the env var hard-disables routing regardless of the runtime toggle. */
  private envDisabled(): boolean {
    const to = process.env.AILAB_MAINTAINER_AGENT
    return to === 'off' || to === ''
  }

  routingState(): {
    suspended: boolean; reason: string; since: string; suppressed: number
    envDisabled: boolean; recipient: string
    suppressedEvents: Array<{ id: string; severity: NotifySeverity; source: string; message: string; ts: string }>
  } {
    return {
      ...this.routing,
      envDisabled: this.envDisabled(),
      recipient: process.env.AILAB_MAINTAINER_AGENT || 'maintenance-claude',
    }
  }

  /**
   * Suspend or resume forwarding. On RESUME, the agent is told what it missed in one
   * message rather than replaying the backlog — the point of the pause was not to wake it,
   * and replaying would defeat that at the exact moment it comes back.
   */
  setRouting(suspended: boolean, reason = ''): ReturnType<NotificationsService['routingState']> {
    const was = this.routing.suspended
    if (suspended) {
      if (!was) this.routing = { ...this.routing, suspended: true, reason, since: new Date().toISOString(), suppressed: 0, suppressedEvents: [] }
      else this.routing.reason = reason || this.routing.reason
    } else if (was) {
      const missed = this.routing.suppressed
      const worst = this.routing.suppressedEvents.reduce<NotifySeverity | null>(
        (acc, e) => (acc === 'critical' || e.severity === 'critical' ? 'critical'
          : acc === 'error' || e.severity === 'error' ? 'error' : acc ?? e.severity), null)
      const since = this.routing.since
      this.routing = { suspended: false, reason: '', since: '', suppressed: 0, suppressedEvents: [] }
      this.notify({
        severity: 'info', source: 'notify-routing',
        // routeInfo: the agent whose alert path just reopened must hear it ON that path —
        // maintenance-claude only learned resumption had happened when unrelated alerts started
        // arriving (2026-08-31), and the missed-while-suspended summary below is exactly what it
        // needs on wake.
        //
        // 🛑 ONLY WHEN SOMETHING WAS ACTUALLY WITHHELD. With missed === 0 the entire content is
        // "an event occurred that had no effect on you", and it still costs a wake. That was
        // rare until ailab-restart made short controlled suspensions routine — every restart
        // would now page the maintainer to report an absence. The event is still recorded and
        // badged, so the resumption stays visible in the panel; it just stops waking anyone.
        // Raised by maintenance-claude about his own alert path, with the four-event history
        // behind it: the two informative notices carried counts of 2 and 54; the two empty ones
        // were 35-second windows from the restart tool.
        routeInfo: missed > 0,
        message: `Forwarding to the maintenance agent RESUMED`,
        detail: missed
          ? `${missed} event(s) were raised while suspended since ${since} and were NOT forwarded (worst: ${worst}). They are in the panel; the agent was not woken for them.`
          : `Nothing was suppressed while suspended since ${since}.`,
      })
    }
    this.saveRouting()
    this.broadcast('notify:routing', this.routingState())
    return this.routingState()
  }

  private checksFile(): string {
    return path.join(this.dataDir, 'notifications-health.json')
  }

  private loadEvents(): void {
    try {
      if (existsSync(this.eventsFile())) {
        const raw = JSON.parse(readFileSync(this.eventsFile(), 'utf8'))
        // Load everything, then trim under the acked-first policy. A recency slice here
        // would drop unacked events across a restart -- the exact window this fixes.
        if (Array.isArray(raw)) {
          this.events = raw
          this.trimEvents()
        }
      }
    } catch (e) {
      // Starting empty LOSES unacked events — including criticals nobody has
      // seen — which defeats the stated "events survive restarts" guarantee.
      // Keep the corrupt bytes and say what happened, in-band: the panel
      // showing a fresh empty list is otherwise indistinguishable from a
      // healthy quiet night.
      let saved = ''
      try { copyFileSync(this.eventsFile(), `${this.eventsFile()}.corrupt-${Date.now()}`); saved = 'preserved beside it' } catch { saved = 'and backing it up ALSO failed' }
      console.warn('[notifications] events file unreadable, starting empty:', (e as Error).message)
      this.bootReports.push({
        severity: 'warning', source: 'health-board',
        message: 'Event history was unreadable and has been reset',
        detail: `events.json failed to parse (${(e as Error).message}); the corrupt file is ${saved}. Any unacked events from before this restart — including criticals — are no longer badged. An empty panel right now means LOST, not quiet.`,
      })
    }
  }

  private loadChecks(): void {
    try {
      if (!existsSync(this.checksFile())) {
        // Seed ONCE — after that the file is the truth, so ports/paths are
        // operator-editable and never hardcoded in behaviour.
        writeFileSync(this.checksFile(), JSON.stringify({ checks: DEFAULT_CHECKS }, null, 2))
      }
      const raw = JSON.parse(readFileSync(this.checksFile(), 'utf8'))
      this.checks = Array.isArray(raw?.checks) ? raw.checks : DEFAULT_CHECKS
      if (this.checks.length === 0) {
        // [] is valid JSON and a dead board: probeAll() iterates nothing,
        // forever, and no dot ever turns any colour again. Respect the file
        // (an operator may truly want it off) but never silently.
        this.bootReports.push({
          severity: 'warning', source: 'health-board',
          message: 'Health board has ZERO checks configured — nothing is being probed',
          detail: `${this.checksFile()} holds an empty checks array. Every dependency dot is gone and no down-detection is running. If this is deliberate, ack this; if not, delete the file to re-seed the defaults on next restart.`,
        })
      } else {
        // Seed-once means a dependency added to DEFAULT_CHECKS later is never
        // probed on an existing install — the board looks complete and simply
        // lacks a dot for the new thing, which nobody notices by looking.
        // 🛑 BACK-FILL `dependsOn` FROM THE DEFAULTS. Seed-once is correct for ports and
        // targets — an operator tunes those. It is wrong for a field describing a STRUCTURAL
        // relationship between two checks: the operator did not decide to omit it, it did not
        // exist when their file was seeded. Without this the dependency suppression below is
        // dead code on every existing install, which is exactly what happened — on
        // 2026-09-02 one dead proxy port raised CRITICAL + ERROR + WARNING in a single pass,
        // for embeddings and reranker that only fail BECAUSE they route through that proxy.
        // Only fills where absent, so an explicit operator value always wins.
        const defDep = new Map(DEFAULT_CHECKS.filter((c) => c.dependsOn).map((c) => [c.id, c.dependsOn]))
        const filled: string[] = []
        for (const c of this.checks) {
          if (!c.dependsOn && defDep.has(c.id)) {
            c.dependsOn = defDep.get(c.id)
            filled.push(`${c.id}->${c.dependsOn}`)
          }
        }
        if (filled.length) {
          console.log(`[notifications] back-filled dependsOn from defaults: ${filled.join(', ')}`)
        }

        const present = new Set(this.checks.map((c) => c.id))
        const missing = DEFAULT_CHECKS.filter((c) => !present.has(c.id)).map((c) => c.id)
        if (missing.length) {
          console.warn(`[notifications] default checks absent from on-disk config (operator-removed or added since seeding): ${missing.join(', ')}`)
          this.bootReports.push({
            severity: 'info', source: 'health-board',
            message: 'Default health checks are absent from the configured set',
            detail: `Not probed: ${missing.join(', ')}. The config was seeded once and is operator-owned, so these are either deliberately removed (fine — ack this) or were added to the defaults AFTER this install seeded and silently never started running. Add them to ${this.checksFile()} if wanted.`,
          })
        }
      }
      // Subject-gone pruning (AlarmLatch contract: a TRUSTED roster only).
      // This branch means the operator's config file PARSED — the checks list
      // is the deliberate roster, so a check removed from it takes its latch
      // along (subject gone ≠ fault gone ≠ cannot-check). The corrupt-file
      // path below deliberately does NOT prune: falling back to defaults is a
      // best-effort roster, and pruning against it would wipe latches for
      // operator-added checks — the exact trap the method's contract names.
      const pruned = this.alarmLatch.pruneSubjects(this.checks.map((c) => c.id))
      if (pruned.length) {
        this.alarmLatch.save()
        console.log(`[notifications] dropped alarm latches for removed checks: ${pruned.join(', ')}`)
      }
    } catch (e) {
      let saved = ''
      try { copyFileSync(this.checksFile(), `${this.checksFile()}.corrupt-${Date.now()}`); saved = `; the file is preserved beside it` } catch { /* reported below regardless */ }
      console.warn('[notifications] health config unreadable, using defaults:', (e as Error).message)
      this.checks = DEFAULT_CHECKS
      this.bootReports.push({
        severity: 'warning', source: 'health-board',
        message: 'Health config was unreadable — running on built-in defaults',
        detail: `${this.checksFile()} failed to parse (${(e as Error).message})${saved}. Any operator edits (custom targets, removed checks) are NOT in effect until the file is repaired.`,
      })
    }
  }

  /**
   * Trim to EVENT_CAP by dropping the OLDEST ACKED events first.
   *
   * 🛑 The previous form was `splice(0, length - EVENT_CAP)` -- acked-blind, oldest-first. A
   * sustained flood of routine info could therefore evict an unacked CRITICAL that nobody had
   * seen, and nothing said so. Acked means somebody looked at it; that is the only thing safe
   * to discard under pressure.
   *
   * If the overflow is entirely unacked we still have to drop something, and that IS data loss
   * -- so it is announced, never silent. An eviction nobody is told about turns a full store
   * into a false all-clear.
   */
  private trimEvents(): void {
    if (this.events.length <= EVENT_CAP) return

    const overflow = this.events.length - EVENT_CAP
    let dropped = 0
    const kept: NotifyEvent[] = []
    for (const e of this.events) {
      if (dropped < overflow && e.acked) {
        dropped++
        continue
      }
      kept.push(e)
    }
    this.events = kept
    if (this.events.length <= EVENT_CAP) return

    // Still over cap: everything left is UNACKED, so something outstanding has to go.
    // 🛑 Drop the LEAST SEVERE first, oldest within a severity. Purely oldest-first (my first
    // version) let a flood of routine `info` evict an older unacked CRITICAL — the same failure
    // one step along. Age is the right tiebreak within a severity, never across them.
    const still = this.events.length - EVENT_CAP
    let need = still
    const doomed = new Set<string>()
    for (const sev of ['info', 'warning', 'error', 'critical'] as NotifySeverity[]) {
      if (need <= 0) break
      for (const e of this.events) {
        if (need <= 0) break
        if (!e.acked && e.severity === sev && !doomed.has(e.id)) {
          doomed.add(e.id)
          need--
        }
      }
    }
    const lost = this.events.filter((e) => doomed.has(e.id))
    this.events = this.events.filter((e) => !doomed.has(e.id))

    const worstLost: NotifySeverity =
      lost.some((e) => e.severity === 'critical') ? 'critical'
        : lost.some((e) => e.severity === 'error') ? 'error'
          : 'warning'
    const sources = [...new Set(lost.map((e) => e.source))].slice(0, 6).join(', ')
    // Pushed directly rather than through emit(): emit() calls trimEvents(), which would recurse.
    // Going one over the cap here is harmless -- the next trim reclaims it from an acked event.
    const evt: NotifyEvent = {
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      ts: new Date().toISOString(),
      acked: false,
      severity: worstLost,
      source: 'notify-store',
      message: `Dropped ${still} UNACKED event(s) at the store cap`,
      detail: `The store holds ${EVENT_CAP} events and the overflow was entirely unacked, so `
        + `${still} outstanding event(s) were discarded least-severe-first. Worst severity lost: `
        + `${worstLost}. Sources: ${sources || 'unknown'}. This is real loss, not housekeeping — `
        + `something is producing events faster than they are being acked.`,
    }
    this.events.push(evt)
    this.broadcast('notify:event', evt)
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      try {
        // trimEvents() already holds the cap, and it keeps unacked events preferentially --
          // re-slicing here by recency would silently undo that on the way to disk.
          writeFileSync(this.eventsFile(), JSON.stringify(this.events, null, 2))
        this.persistFailedReported = false
      } catch (e) {
        console.warn('[notifications] persist failed:', (e as Error).message)
        if (!this.persistFailedReported) {
          // Once per outage, in-band: with persistence down, every event lives
          // only in memory and the next restart erases the record — the
          // "survives restarts" guarantee is off and the panel cannot tell.
          this.persistFailedReported = true
          this.notify({
            severity: 'warning', source: 'health-board',
            message: 'Event persistence is failing — history will not survive a restart',
            detail: `writeFileSync(${this.eventsFile()}) failed: ${(e as Error).message}. Events keep working in memory; a restart during this condition loses them.`,
          })
        }
      }
    }, 500)
  }

  /** Record + broadcast a warning/error/critical (or info) event. */
  /**
   * Record an event, badge it, and -- for anything above info -- fleet-DM the
   * maintenance agent.
   *
   * ⚠ This has an OUTBOUND SIDE EFFECT. Any code that constructs this service and
   * calls notify() will wake a real agent, including a test harness pointed at a
   * scratch dataDir: the data is isolated, the network call is not. A probe test
   * did exactly that and delivered a synthetic "Test dep is DOWN" to the
   * maintenance agent. Set AILAB_MAINTAINER_AGENT=off in any non-production
   * instantiation.
   */
  notify(input: { severity: NotifySeverity; source: string; message: string; detail?: string }): NotifyEvent {
    // Identical-while-unacked DEDUP. A per-process latch (emitOnce) cannot see
    // across restarts, and tonight's deploy cadence proved it: every backend
    // restart re-raised the inventory-stub startup warning until the panel held
    // ten copies of one fact (Travis, 2026-08-30). A standing condition gets ONE
    // row that counts its recurrences; acking it re-arms the row, so the next
    // occurrence after an ack is a fresh event — silence after acking still
    // means "stopped", never "hidden".
    const dup = this.events.find(
      (e) => !e.acked && e.source === input.source && e.message === input.message && e.severity === input.severity,
    )
    if (dup) {
      dup.occurrences = (dup.occurrences ?? 1) + 1
      dup.lastTs = new Date().toISOString()
      if (input.detail) dup.detail = input.detail   // latest detail wins; it carries the varying facts
      this.schedulePersist()
      this.broadcast('notify:event', dup)
      // Still offered to routing: its own coalesce window decides, and while
      // suspended the suppressed counter keeps counting honestly.
      this.routeToMaintainer(dup)
      return dup
    }
    const evt: NotifyEvent = {
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      ts: new Date().toISOString(),
      acked: false,
      ...input,
    }
    this.events.push(evt)
    this.trimEvents()
    this.schedulePersist()
    this.broadcast('notify:event', evt)
    this.routeToMaintainer(evt)
    return evt
  }

  /**
   * Wake the maintenance agent for anything actionable.
   *
   * A panel only helps someone who is looking at it. Routing the event as a fleet message is what
   * turns "visible if you check" into "someone is told" — which is the actual complaint these
   * systems exist to answer.
   *
   * Three deliberate limits:
   *  - info is NOT routed. Only warning/error/critical. Waking an agent for "proxy recovered"
   *    would make the channel worthless within a day.
   *  - identical events are coalesced. A failing dependency re-raises on every probe cycle, and a
   *    hundred wake-ups for one fault is indistinguishable from an attack on the agent's context.
   *  - failure to route is logged and swallowed. Notification delivery must never be able to
   *    break the thing that raised the notification.
   */
  private recentRoutes = new Map<string, number>()
  /**
   * Forwarding to the maintenance agent, suspendable at RUNTIME.
   *
   * Needed because building out emitters raises a lot of premature and wrong alerts, and
   * every one of them would wake a live agent to investigate nothing. The env var was the
   * only existing off switch: it needs a restart, and — worse — it suppresses SILENTLY,
   * which makes "no alerts" and "alerts are switched off" look identical. That is the
   * failure this whole subsystem exists to prevent, so suspension is counted and surfaced.
   *
   * Events are still raised, recorded and badged while suspended. Only the wake-up stops.
   */
  private routing: {
    suspended: boolean
    reason: string
    since: string
    suppressed: number
    suppressedEvents: Array<{ id: string; severity: NotifySeverity; source: string; message: string; ts: string }>
  } = { suspended: false, reason: '', since: '', suppressed: 0, suppressedEvents: [] }
  private routeToMaintainer(evt: NotifyEvent): void {
    if (evt.severity === 'info' && !evt.routeInfo) return
    const to = process.env.AILAB_MAINTAINER_AGENT || 'maintenance-claude'
    if (!to || to === 'off') return

    // Suspended: count and record rather than dropping. A suppressed alert that leaves no
    // trace is indistinguishable from one that never happened, and the resume message is
    // only honest if it can say what was missed.
    if (this.routing.suspended) {
      this.routing.suppressed += 1
      this.routing.suppressedEvents.push({ id: evt.id, severity: evt.severity, source: evt.source, message: evt.message, ts: evt.ts })
      if (this.routing.suppressedEvents.length > 200) this.routing.suppressedEvents.shift()
      this.debug('notify-routing', `suspended — not forwarding [${evt.severity}] ${evt.source}: ${evt.message}`)
      this.saveRouting()
      return
    }

    const key = `${evt.source}::${evt.message}`
    const now = Date.now()
    const last = this.recentRoutes.get(key) ?? 0
    const windowMs = Number(process.env.AILAB_MAINTAINER_COALESCE_MS || 30 * 60 * 1000)
    if (now - last < windowMs) {
      // The skip used to be silent, so "suppressed by the window" and "routed"
      // looked identical afterwards. Record it ON the event and in the ring —
      // the panel can then say this occurrence did not wake anyone.
      evt.routeCoalesced = (evt.routeCoalesced ?? 0) + 1
      this.schedulePersist()
      this.debug('notify-routing', `coalesced (window ${Math.round(windowMs / 60000)}m) — not re-waking for [${evt.severity}] ${key}`)
      return
    }
    this.recentRoutes.set(key, now)
    if (this.recentRoutes.size > 500) {
      for (const [k, t] of this.recentRoutes) if (now - t > windowMs) this.recentRoutes.delete(k)
    }

    const fleetd = process.env.FLEETD_URL || 'http://127.0.0.1:17900'
    const body = [
      `[${evt.severity.toUpperCase()}] ${evt.message}`,
      evt.detail ? `\n${evt.detail}` : '',
      `\n\nsource: ${evt.source}   raised: ${evt.ts}   event id: ${evt.id}`,
      `\n\nThis is an automated notification, not a person asking. Triage it: fix it, defer it to`,
      ` Travis on Telegram if you need his input, or journal-and-ack it if it is real but not`,
      ` actionable. Ack it either way so it stops badging.`,
      // This identity can send but not receive: fleetd dispatches inbound by agent kind, and
      // the kind this emitter is registered under has no adapter. Saying so costs two lines
      // and saves the reader discovering it by having a reply vanish.
      `\n\nDo not reply to this thread — this emitter is send-only and your reply will not`,
      ` route. Report outcomes to claude1 instead.`,
    ].join('')

    void fetch(`${fleetd}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: process.env.AILAB_NOTIFY_SENDER || 'ai-lab-notifications',
        to: [to], kind: 'dm', body,
      }),
      signal: AbortSignal.timeout(8000),
    })
      .then(async (r) => {
        if (!r.ok) {
          console.warn(`[notify-route] ${to}: fleetd HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`)
          this.reportRouteFailure(`fleetd answered HTTP ${r.status} for the wake-up about [${evt.severity}] ${evt.source}: ${evt.message}`)
          return
        }
        // r.ok only means the HTTP call landed. The per-recipient receipt in the
        // body is where delivery actually lives — read it, under the HARD RULE:
        //   failed    → a real failure, report it (locally).
        //   delivered → success.
        //   queued    → SUCCESS WITH LATENCY, silent (debug at most). Travis's
        //               standing rule: fleetd says "queued — recipient offline"
        //               for agents that answer within the minute, so treating it
        //               as undelivered would manufacture a steady stream of
        //               false alarms about working agents — the exact class this
        //               sweep removes, added by the emitter meant to detect it.
        //               The honest deeper signal is fleetd's own wake-inference
        //               sweep; no second one is invented here.
        try {
          const resp = await r.json() as { recipients?: Record<string, { state?: string; detail?: string }> }
          const receipt = resp?.recipients?.[to]
          if (!receipt) { this.routeSucceeded(); return }
          if (receipt.state === 'failed') {
            console.warn(`[notify-route] ${to}: receipt FAILED — ${receipt.detail ?? 'no detail'}`)
            this.reportRouteFailure(`fleetd accepted the send but the receipt for '${to}' came back failed (${receipt.detail ?? 'no detail'}) for [${evt.severity}] ${evt.source}: ${evt.message}`)
          } else {
            if (receipt.state === 'queued') this.debug('notify-routing', `receipt queued for ${to} (normal latency, not a failure)`)
            this.routeSucceeded()
          }
        } catch { this.routeSucceeded() /* an unparseable receipt is not evidence of failure */ }
      })
      .catch((e) => {
        console.warn(`[notify-route] ${to}: not delivered — ${(e as Error)?.message || e}`)
        this.reportRouteFailure(`fleetd was unreachable for the wake-up about [${evt.severity}] ${evt.source}: ${evt.message} (${(e as Error)?.message || e})`)
      })
  }

  /** Latch for route-failure self-reports: one event per outage, re-armed by success. */
  private routeFailureReported = false

  private routeSucceeded(): void {
    this.routeFailureReported = false
  }

  /**
   * The alarm path failing must become a VISIBLE event — console.warn was the
   * exact FAIL-into-an-unread-file shape this system exists to remove — but a
   * LOCAL-ONLY one: an alarm about the alarm path must not attempt the alarm
   * path. Tonight's field-name false positive is the worked example — had it
   * routed, it would have travelled through the channel it claimed was broken.
   * Latched: one event per outage, re-armed when a route succeeds again.
   */
  private reportRouteFailure(detail: string): void {
    if (this.routeFailureReported) return
    this.routeFailureReported = true
    const evt: NotifyEvent = {
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      ts: new Date().toISOString(),
      acked: false,
      severity: 'warning',
      source: 'notify-route',
      message: 'Forwarding to the maintenance agent is failing',
      detail: `${detail}. Events keep recording and badging here; only the wake-up is affected. This event is deliberately local-only.`,
    }
    this.events.push(evt)
    this.trimEvents()
    this.schedulePersist()
    this.broadcast('notify:event', evt)
    // Deliberately NO routeToMaintainer call.
  }

  /** Informational debug line for the live console — ring only, never badged. */
  debug(source: string, message: string): void {
    const entry = { ts: new Date().toISOString(), source, message }
    this.debugRing.push(entry)
    if (this.debugRing.length > DEBUG_CAP) this.debugRing.splice(0, this.debugRing.length - DEBUG_CAP)
    this.broadcast('notify:debug', entry)
  }

  /** ai.js broadcast() sink — the previously consumer-less watchdog events, plus
   *  anything else the proxy emits; unrecognised types pass through as debug. */
  ingestAiEvent(msg: { type?: string; [k: string]: unknown }): void {
    const type = String(msg?.type ?? 'unknown')
    if (type === 'notify') {
      // Generic passthrough: the ported JS routers (ai.js and everything it owns —
      // metrics poller, watchdog, cache reconciler) can raise a real notification
      // through the transport they already have, with no new dependency and no HTTP hop.
      const sev = String(msg.severity ?? 'warning')
      this.notify({
        severity: (['info', 'warning', 'error', 'critical'].includes(sev) ? sev : 'warning') as NotifySeverity,
        source: String(msg.source ?? 'ai'),
        message: String(msg.message ?? '(no message)'),
        detail: msg.detail === undefined ? undefined : String(msg.detail),
      })
    } else if (type === 'watchdog-never-healthy') {
      this.notify({
        severity: 'error', source: 'watchdog',
        message: `service ${msg.name ?? msg.serviceId} never became healthy`,
        detail: JSON.stringify(msg),
      })
    } else if (type === 'watchdog-restart') {
      this.notify({
        severity: 'warning', source: 'watchdog',
        message: `service ${msg.name ?? msg.serviceId} was restarted by the watchdog`,
        detail: JSON.stringify(msg),
      })
    } else {
      this.debug('ai', `${type}: ${JSON.stringify(msg).slice(0, 300)}`)
    }
  }

  ack(ids: string[] | 'all'): number {
    let n = 0
    for (const e of this.events) {
      if (!e.acked && (ids === 'all' || ids.includes(e.id))) {
        e.acked = true
        n++
      }
    }
    if (n) {
      this.schedulePersist()
      this.broadcast('notify:acked', { ids: ids === 'all' ? 'all' : ids })
    }
    return n
  }

  /** Task Progress registry (panel section + bell pip). Public: routers and pollers report into it. */
  readonly tasks: TaskProgress
  /** In-process reporting hook for routers that predate this service (imagegen.js etc.). */
  taskReport(t: TaskReportInput): void { this.tasks.report(t) }

  state(): { health: HealthState[]; events: NotifyEvent[]; debug: Array<{ ts: string; source: string; message: string }>; intervalMs: number; routing: ReturnType<NotificationsService['routingState']>; tasks: ReturnType<TaskProgress['state']> } {
    return {
      health: [...this.health.values()],
      tasks: this.tasks.state(),
      // EVERY unacked event, plus the newest ACKED_VIEW acked ones, in original order.
      // slice(-200) hid outstanding events behind a burst of routine ones, and this is
      // the surface maintenance-claude triages from.
      events: (() => {
        const keepAcked = new Set(
          this.events.filter((e) => e.acked).slice(-ACKED_VIEW).map((e) => e.id),
        )
        return this.events.filter((e) => !e.acked || keepAcked.has(e.id))
      })(),
      debug: [...this.debugRing],
      intervalMs: this.intervalMs,
      // Carried in the main state payload so the panel can SAY it is suspended. A silent
      // off switch turns a quiet panel into a false all-clear.
      routing: this.routingState(),
    }
  }

  start(): void {
    if (this.timer) return
    void this.probeAll()
    this.timer = setInterval(() => void this.probeAll(), this.intervalMs)
    void this.validateMaintainer()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async probeOne(c: HealthCheckConfig): Promise<HealthState> {
    const base: Omit<HealthState, 'status' | 'reason'> = {
      id: c.id, label: c.label, checkedAt: new Date().toISOString(), downSeverity: c.downSeverity,
    }
    try {
      if (c.kind === 'dns') {
        try {
          await dnsResolve(c.target)
          return { ...base, status: 'ok' }
        } catch (e) {
          return { ...base, status: 'down', reason: `cannot resolve ${c.target}: ${(e as Error).message}` }
        }
      }
      if (c.kind !== 'http') {
        // A kind we don't implement is a CONFIG problem, not a dependency problem.
        return { ...base, status: 'unknown', reason: `unrecognised check kind ${JSON.stringify(c.kind)}` }
      }
      try {
        new URL(c.target)
      } catch {
        return { ...base, status: 'unknown', reason: `invalid target URL ${JSON.stringify(c.target)}` }
      }
      let res: Response
      try {
        res = await fetch(c.target, { signal: AbortSignal.timeout(c.timeoutMs ?? 5000), redirect: 'manual' })
      } catch (e) {
        const msg = (e as Error).message
        return { ...base, status: 'down', reason: `no response: ${msg}` }
      }
      if (c.expect === 'any-response') return { ...base, status: 'ok' }
      const okStatus = Array.isArray(c.expect)
        ? c.expect.includes(res.status)
        : res.status >= 200 && res.status < 400
      return okStatus
        ? { ...base, status: 'ok' }
        : { ...base, status: 'down', reason: `HTTP ${res.status}` }
    } catch (e) {
      // The CHECK itself failed (bad config, unexpected throw) — that is not
      // evidence about the dependency. Grey, never red.
      return { ...base, status: 'unknown', reason: `check failed: ${(e as Error).message}` }
    }
  }

  private async probeAll(): Promise<void> {
    const results = await Promise.all(this.checks.map((c) => this.probeOne(c)))
    const byId = new Map(this.checks.map((c) => [c.id, c]))
    for (const r of results) {
      // The board always shows the live result. Only the EVENT is debounced --
      // hiding a red dot would be dishonest, but waking a maintainer for one slow
      // response is how a notification channel earns the right to be ignored.
      this.health.set(r.id, r)

      if (r.status === 'unknown') {
        // The CHECK could not run. That says nothing about the dependency, so it
        // must neither advance nor clear the streak.
        this.debug('health', `${r.label}: check could not run (${r.reason})`)
        continue
      }

      if (r.status === 'down') {
        const streak = (this.downStreak.get(r.id) ?? 0) + 1
        this.downStreak.set(r.id, streak)
        const needed = byId.get(r.id)?.confirmations ?? defaultConfirmations()
        if (streak >= needed) {
          const sinceBoot = Date.now() - this.bootAt
          // Transport already down: this failure is the SAME fault seen through
          // a dependent — one accurate root-cause alert beats three severities
          // for one dead port. Streaks keep advancing so a dependent that stays
          // down after its transport recovers alarms on the next pass.
          const dep = byId.get(r.id)?.dependsOn
          if (dep && this.health.get(dep)?.status === 'down') {
            this.debug('health', `${r.label}: down, but its transport '${dep}' is already reported down — event suppressed as duplicate of the root cause`)
            continue
          }
          // Latched AND persisted: re-raising every 30s is a pager loop, and
          // re-raising on every backend restart was the same loop on a deploy
          // cadence (~28 restarts in one dev day). claim() suppresses within
          // the window, marks a 7-day restatement as a restatement, and a
          // fresh process inherits what was already announced.
          const suffix = this.alarmLatch.claim(r.id, 'down')
          if (suffix !== null) {
            const bootNote = sinceBoot < BOOT_CONTEXT_WINDOW_MS
              ? ` The backend itself started ${Math.round(sinceBoot / 1000)}s ago and this dependency never came up with it — a listener that did not bind (check the last deploy), not a service that fell over.`
              : ''
            this.notify({
              severity: r.downSeverity, source: 'health',
              message: `${r.label} is DOWN`,
              detail: `${r.reason} (failed ${streak} consecutive checks)` + bootNote + suffix,
            })
            this.alarmLatch.save()
          }
        } else {
          this.debug('health', `${r.label}: probe failed (${streak}/${needed}) - ${r.reason}`)
        }
        continue
      }

      this.downStreak.set(r.id, 0)
      // Only announce recovery from an outage we actually announced, or the panel
      // fills with "recovered" lines for failures nobody was ever told about.
      // An OK probe IS positive evidence — the only thing allowed to clear the
      // latch. This also fires correctly for a dot that healed while the
      // backend was down: the persisted latch survives the restart, the first
      // good probe clears it, the recovery is announced exactly once.
      if (this.alarmLatch.clear(r.id, ['down']).length > 0) {
        this.alarmLatch.save()
        this.notify({ severity: 'info', source: 'health', message: `${r.label} recovered` })
      }
    }
    this.broadcast('notify:health', [...this.health.values()])
  }
}
