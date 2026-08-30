import { makeAutoObservable, runInAction } from 'mobx'

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

export interface HealthState {
  id: string
  label: string
  status: 'ok' | 'down' | 'unknown'
  reason?: string
  checkedAt: string
  downSeverity: 'warning' | 'error' | 'critical'
}

export interface DebugEntry {
  ts: string
  source: string
  message: string
}

const EVENT_CAP = 300
const DEBUG_CAP = 500
const FALLBACK_POLL_MS = 30_000

function cluster(): { request: (m: string, p: string, b?: unknown) => Promise<any> } | undefined {
  return (window as any).gyshell?.cluster
}

function liveChannels(): any {
  return (window as any).gyshell?.notifications
}

/**
 * Notifications: health board + running warnings/errors + live debug console.
 * Initial state via /api/notifications/state, then live over the gateway raw
 * channels (notify:*). If the live channels are unavailable (old shim), a slow
 * poll keeps the panel honest rather than frozen.
 */
class NotificationsStore {
  events: NotifyEvent[] = []
  health: HealthState[] = []
  debug: DebugEntry[] = []
  loaded = false
  available = true
  error: string | null = null
  /**
   * Whether warnings/errors are being forwarded to the maintenance agent. Held in the store
   * so the panel can SAY when forwarding is off — a quiet panel and a switched-off panel
   * look identical otherwise, and that is the false all-clear this system exists to avoid.
   */
  routing: {
    suspended: boolean; reason: string; since: string; suppressed: number
    envDisabled: boolean; recipient: string
  } | null = null

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private cleanups: Array<() => void> = []

  constructor() {
    makeAutoObservable(this)
  }

  /** Unacked counts per severity — drives the header badge. */
  get unacked(): { warning: number; error: number; critical: number } {
    const c = { warning: 0, error: 0, critical: 0 }
    for (const e of this.events) {
      if (!e.acked && e.severity !== 'info') c[e.severity]++
    }
    return c
  }

  /** Worst active signal: health outages count even when their event was acked. */
  get worstSeverity(): NotifySeverity | null {
    const downSev = this.health
      .filter((h) => h.status === 'down')
      .map((h) => h.downSeverity)
    const u = this.unacked
    if (u.critical > 0 || downSev.includes('critical')) return 'critical'
    if (u.error > 0 || downSev.includes('error')) return 'error'
    if (u.warning > 0 || downSev.includes('warning')) return 'warning'
    return null
  }

  get badgeCount(): number {
    const u = this.unacked
    return u.warning + u.error + u.critical + this.health.filter((h) => h.status === 'down').length
  }

  get hasUnknown(): boolean {
    return this.health.some((h) => h.status === 'unknown')
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!cluster()) {
      this.available = false
      this.loaded = true
      return
    }
    await this.refresh()
    runInAction(() => {
      this.loaded = true
    })
    const live = liveChannels()
    if (live?.onEvent) {
      this.cleanups.push(
        live.onEvent((evt: NotifyEvent) => this.ingestEvent(evt)),
        live.onDebug((entry: DebugEntry) => this.ingestDebug(entry)),
        live.onHealth((health: HealthState[]) => runInAction(() => { this.health = health })),
        live.onAcked(() => void this.refresh()),
      )
      // Belt over braces: a very slow poll heals any missed broadcast.
      this.pollTimer = setInterval(() => void this.refresh(), 5 * 60_000)
    } else {
      this.pollTimer = setInterval(() => void this.refresh(), FALLBACK_POLL_MS)
    }
  }

  dispose(): void {
    for (const c of this.cleanups) c()
    this.cleanups = []
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private ingestEvent(evt: NotifyEvent): void {
    runInAction(() => {
      if (this.events.some((e) => e.id === evt.id)) return
      this.events.push(evt)
      if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP)
    })
  }

  private ingestDebug(entry: DebugEntry): void {
    runInAction(() => {
      this.debug.push(entry)
      if (this.debug.length > DEBUG_CAP) this.debug.splice(0, this.debug.length - DEBUG_CAP)
    })
  }

  async refresh(): Promise<void> {
    try {
      const s = await cluster()!.request('GET', '/api/notifications/state')
      runInAction(() => {
        this.events = s.events ?? []
        this.health = s.health ?? []
        this.debug = s.debug ?? []
        this.routing = s.routing ?? null
        this.error = null
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  /** Suspend or resume forwarding to the maintenance agent. */
  async setRouting(suspended: boolean, reason = ''): Promise<void> {
    try {
      const r = await cluster()!.request('POST', '/api/notifications/routing', { suspended, reason })
      runInAction(() => {
        this.routing = r
        this.error = null
      })
      // Resuming raises an info event summarising what was missed; pull it in immediately
      // rather than waiting for the next poll.
      await this.refresh()
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  async ack(ids: string[] | 'all'): Promise<void> {
    try {
      await cluster()!.request('POST', '/api/notifications/ack', { ids })
      runInAction(() => {
        for (const e of this.events) {
          if (ids === 'all' || ids.includes(e.id)) e.acked = true
        }
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    }
  }
}

export const notificationsStore = new NotificationsStore()
