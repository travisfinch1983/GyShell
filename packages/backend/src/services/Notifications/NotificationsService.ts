import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  { id: 'unified-memory', label: 'Unified memory MCP', kind: 'http', target: 'http://127.0.0.1:9847/u/healthprobe/mcp', expect: 'any-response', downSeverity: 'error' },
  { id: 'pages-mcp', label: 'Pages MCP', kind: 'http', target: 'http://127.0.0.1:9848/health', expect: '2xx3xx', downSeverity: 'warning' },
  { id: 'internet', label: 'Internet reachability', kind: 'http', target: 'https://1.1.1.1', expect: 'any-response', downSeverity: 'warning' },
  { id: 'dns', label: 'DNS resolution', kind: 'dns', target: 'github.com', downSeverity: 'warning' },
]

export class NotificationsService {
  private events: NotifyEvent[] = []
  private debugRing: Array<{ ts: string; source: string; message: string }> = []
  private health = new Map<string, HealthState>()
  private checks: HealthCheckConfig[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private seq = 0

  constructor(
    private readonly dataDir: string,
    /** gatewayService.broadcastRaw — the one live transport. */
    private readonly broadcast: (channel: string, data: unknown) => void,
    private readonly intervalMs = Number(process.env.AILAB_HEALTH_INTERVAL_MS ?? 30_000),
  ) {
    mkdirSync(this.dir(), { recursive: true })
    this.loadEvents()
    this.loadChecks()
  }

  private dir(): string {
    return path.join(this.dataDir, 'notifications')
  }

  private eventsFile(): string {
    return path.join(this.dir(), 'events.json')
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
      console.warn('[notifications] events file unreadable, starting empty:', (e as Error).message)
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
    } catch (e) {
      console.warn('[notifications] health config unreadable, using defaults:', (e as Error).message)
      this.checks = DEFAULT_CHECKS
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      try {
        writeFileSync(this.eventsFile(), JSON.stringify(this.events.slice(-EVENT_CAP), null, 2))
      } catch (e) {
        console.warn('[notifications] persist failed:', (e as Error).message)
      }
    }, 500)
  }

  /** Record + broadcast a warning/error/critical (or info) event. */
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
    return evt
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

  state(): { health: HealthState[]; events: NotifyEvent[]; debug: Array<{ ts: string; source: string; message: string }>; intervalMs: number } {
    return {
      health: [...this.health.values()],
      events: this.events.slice(-200),
      debug: [...this.debugRing],
      intervalMs: this.intervalMs,
    }
  }

  start(): void {
    if (this.timer) return
    void this.probeAll()
    this.timer = setInterval(() => void this.probeAll(), this.intervalMs)
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
    for (const r of results) {
      const prev = this.health.get(r.id)
      this.health.set(r.id, r)
      // Transitions become events; steady state stays quiet (an always-on alarm
      // is ignored by week two).
      if (prev && prev.status !== r.status) {
        if (r.status === 'down') {
          this.notify({
            severity: r.downSeverity, source: 'health',
            message: `${r.label} is DOWN`, detail: r.reason,
          })
        } else if (r.status === 'ok' && prev.status === 'down') {
          this.notify({ severity: 'info', source: 'health', message: `${r.label} recovered` })
        } else if (r.status === 'unknown') {
          this.debug('health', `${r.label}: check could not run (${r.reason})`)
        }
      }
    }
    this.broadcast('notify:health', [...this.health.values()])
  }
}
