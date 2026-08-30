import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve as dnsResolve } from 'node:dns/promises'
import path from 'node:path'

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
const DEBUG_CAP = 500

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
  private alarmed = new Set<string>()
  private checks: HealthCheckConfig[] = []
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
      const dir = await r.json() as { agents?: Array<{ id?: string; name?: string }> } | Array<{ id?: string; name?: string }>
      const rows = Array.isArray(dir) ? dir : (dir.agents ?? [])
      if (!rows.length) return   // an empty listing is not proof of absence
      const known = rows.some((a) => a.id === to || a.name === to)
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
        if (Array.isArray(raw)) this.events = raw.slice(-EVENT_CAP)
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

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      try {
        writeFileSync(this.eventsFile(), JSON.stringify(this.events.slice(-EVENT_CAP), null, 2))
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
    const evt: NotifyEvent = {
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      ts: new Date().toISOString(),
      acked: false,
      ...input,
    }
    this.events.push(evt)
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP)
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
    if (evt.severity === 'info') return
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
    if (now - last < windowMs) return
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
        if (!r.ok) console.warn(`[notify-route] ${to}: fleetd HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`)
      })
      .catch((e) => console.warn(`[notify-route] ${to}: not delivered — ${(e as Error)?.message || e}`))
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

  state(): { health: HealthState[]; events: NotifyEvent[]; debug: Array<{ ts: string; source: string; message: string }>; intervalMs: number; routing: ReturnType<NotificationsService['routingState']> } {
    return {
      health: [...this.health.values()],
      events: this.events.slice(-200),
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
          // Latched: re-raising every 30s for one ongoing outage is a pager loop.
          if (!this.alarmed.has(r.id)) {
            this.alarmed.add(r.id)
            this.notify({
              severity: r.downSeverity, source: 'health',
              message: `${r.label} is DOWN`,
              detail: `${r.reason} (failed ${streak} consecutive checks)`,
            })
          }
        } else {
          this.debug('health', `${r.label}: probe failed (${streak}/${needed}) - ${r.reason}`)
        }
        continue
      }

      this.downStreak.set(r.id, 0)
      // Only announce recovery from an outage we actually announced, or the panel
      // fills with "recovered" lines for failures nobody was ever told about.
      if (this.alarmed.delete(r.id)) {
        this.notify({ severity: 'info', source: 'health', message: `${r.label} recovered` })
      }
    }
    this.broadcast('notify:health', [...this.health.values()])
  }
}
