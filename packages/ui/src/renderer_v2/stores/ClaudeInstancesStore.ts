import { makeAutoObservable, runInAction } from 'mobx'
import {
  resolveInstanceManagerApi,
  type ClaudeInstance,
  type ClusterPermissions,
  type ControlAction,
  type InstanceManagerApi,
} from './instanceManager'

/**
 * Consolidated Claude instances (fleet-consolidation Phase 3).
 * All calls go through the InstanceManagerApi adapter; whether it's the real
 * backend or the pre-contract mock is surfaced via `mocked`.
 */
class ClaudeInstancesStore {
  instances: ClaudeInstance[] = []
  loaded = false
  mocked = false
  err = ''
  busyIds = new Set<string>()

  private api: InstanceManagerApi | null = null
  private loading: Promise<void> | null = null

  // ── live refresh ──────────────────────────────────────────────────────────
  // reload() only rescheduled itself while stuck on the MOCK, so once the real backend was
  // reached the list froze until a manual page refresh. Re-logging in an instance changed its
  // status and login badge on the server and the header kept showing the old colour — the panel
  // was a snapshot pretending to be a live view.
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private watchers = 0
  private refreshing = false

  /** Reload without stacking: on a slow backend a 20s poll would otherwise queue requests
   *  faster than they complete, and two in-flight lists can resolve out of order and show
   *  older data than what is already on screen. */
  private async refreshOnce(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try { await this.reload() } finally { this.refreshing = false }
  }

  private readonly onVisibility = (): void => {
    // Coming back to the tab is the moment the user most expects current data — it is exactly
    // when they have just re-logged in an instance in a terminal and switched back to look.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') void this.refreshOnce()
  }

  /**
   * Keep the list live while a view is mounted. Returns an unsubscribe function, so the caller
   * can hand it straight to a React effect. Refcounted: several mounted views share ONE timer.
   * Hidden tabs skip the poll — a background tab that keeps polling costs a request every 20s
   * for a view nobody is looking at, and the visibility handler refreshes it on return anyway.
   */
  startAutoRefresh(intervalMs = 20000): () => void {
    this.watchers += 1
    if (this.watchers === 1) {
      this.pollTimer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') void this.refreshOnce()
      }, intervalMs)
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility)
    }
    return () => {
      this.watchers = Math.max(0, this.watchers - 1)
      if (this.watchers === 0) {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility)
      }
    }
  }

  constructor() {
    makeAutoObservable(this)
  }

  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (!this.loading) this.loading = this.reload()
    return this.loading
  }

  /** Cap a probe so a stuck WS reconnect (flaky link) can never leave reload() pending forever. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('instance probe timeout')), ms)),
    ])
  }

  async reload(): Promise<void> {
    let real = false
    try {
      // Re-probe whenever we're on the mock. The probe + list are time-capped: on a flaky link the
      // underlying WS reconnect (ensureConnected) could otherwise stay pending, so reload() never
      // reached the retry scheduler below and the mock banner got stuck until a manual page refresh
      // (the "stale old version / still in development" state Travis saw). Now it always settles.
      if (!this.api || this.api.mocked) this.api = await this.withTimeout(resolveInstanceManagerApi(), 6000)
      const instances = await this.withTimeout(this.api.list(), 6000)
      real = !this.api.mocked
      runInAction(() => {
        this.instances = instances
        this.mocked = this.api!.mocked
        this.loaded = true
        this.err = ''
      })
    } catch (e: any) {
      // Probe/list failed or timed out (backend mid-restart, or a lost response over packet loss).
      // Stay in degraded/mock mode so the UI is usable, and KEEP RETRYING (rescheduled in finally).
      runInAction(() => {
        this.err = e?.message || 'instance list failed'
        this.loaded = true
        if (!this.api || this.api.mocked) this.mocked = true
      })
    } finally {
      // ALWAYS reschedule until we reach the real backend — in a finally so a hung/failed probe
      // can never kill the retry loop (that was the "never recovers" bug).
      if (!real) this.scheduleMockRetry()
    }
  }

  private mockRetryTimer: ReturnType<typeof setTimeout> | null = null
  /** While degraded/on the mock, quietly re-probe the real API every 3s so a tab that loaded during
   *  a backend restart or a connection blip recovers by itself within a few seconds. */
  private scheduleMockRetry(): void {
    if (this.mockRetryTimer) return
    this.mockRetryTimer = setTimeout(() => {
      this.mockRetryTimer = null
      void this.reload()
    }, 3000)
  }

  private async withBusy<T>(id: string, fn: () => Promise<T>): Promise<T> {
    runInAction(() => this.busyIds.add(id))
    try {
      return await fn()
    } finally {
      runInAction(() => this.busyIds.delete(id))
    }
  }

  async create(name: string): Promise<ClaudeInstance> {
    if (!this.api) throw new Error('not loaded')
    const instance = await this.api.create(name)
    await this.reload()
    return instance
  }

  async remove(id: string): Promise<void> {
    if (!this.api) return
    await this.withBusy(id, () => this.api!.remove(id))
    await this.reload()
  }

  async rename(id: string, name: string): Promise<void> {
    if (!this.api) return
    await this.withBusy(id, () => this.api!.rename(id, name))
    await this.reload()
  }

  async control(id: string, action: ControlAction): Promise<{ ok: boolean; error?: string }> {
    if (!this.api) return { ok: false, error: 'not loaded' }
    const result = await this.withBusy(id, () => this.api!.control(id, action))
    await this.reload()
    return result
  }

  async setPermissions(id: string, permissions: ClusterPermissions): Promise<void> {
    if (!this.api) return
    await this.withBusy(id, () => this.api!.setPermissions(id, permissions))
    await this.reload()
  }
}

export const claudeInstancesStore = new ClaudeInstancesStore()
