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

  constructor() {
    makeAutoObservable(this)
  }

  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (!this.loading) this.loading = this.reload()
    return this.loading
  }

  async reload(): Promise<void> {
    try {
      // Re-probe whenever we're on the mock: a tab that loads during a backend
      // restart window used to get the mock FOREVER (`??=` probed once) — the
      // "stale old version" Travis saw was this banner stuck until a lucky
      // manual reload. Now the mock is a transparent stand-in that self-heals.
      if (!this.api || this.api.mocked) this.api = await resolveInstanceManagerApi()
      const instances = await this.api.list()
      runInAction(() => {
        this.instances = instances
        this.mocked = this.api!.mocked
        this.loaded = true
        this.err = ''
      })
      if (this.api.mocked) this.scheduleMockRetry()
    } catch (e: any) {
      runInAction(() => {
        this.err = e?.message || 'instance list failed'
        this.loaded = true
      })
    }
  }

  private mockRetryTimer: ReturnType<typeof setTimeout> | null = null
  /** While on the mock, quietly re-probe the real API every 8s so a tab that
   *  loaded mid-restart recovers by itself once the backend is back. */
  private scheduleMockRetry(): void {
    if (this.mockRetryTimer) return
    this.mockRetryTimer = setTimeout(() => {
      this.mockRetryTimer = null
      void this.reload()
    }, 8000)
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
