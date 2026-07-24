import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

export interface KvEligibleSvc {
  id: string
  name?: string
  model?: string
  port?: number
  containerIp?: string
  node?: string
  slots?: number
}

export interface KvSvcConfig {
  minMatchTokens?: number
  minSaveDeltaTokens?: number
  chunkSize?: number
  costBenefitRatio?: number
  optaneBudgetBytes?: number
  /** Fraction of the Optane budget reserved for `initial` prefixes (0.05-0.5, default 0.2). */
  initialBudgetFraction?: number
  [k: string]: any
}

export interface KvPerSvcSettings { enabled?: boolean; config?: KvSvcConfig }
export interface KvSettings { defaultEnabled?: boolean; perService?: Record<string, KvPerSvcSettings> }

export interface KvOrchStats {
  requests?: number
  vramHits?: number
  optaneHits?: number
  misses?: number
  saves?: number
  saveBytes?: number
  clones?: number
  cloneFails?: number
  restoreMsTotal?: number
  skipped?: number
  holds?: number
  slots?: Array<{ id: number; locked: boolean; heldMs: number | null }>
  clone?: { pending: number; queued: number; draining: boolean }
}

export interface KvPoolStats {
  bytes?: number
  count?: number
  budgetBytes?: number | null
  host?: string | null
  savePath?: string | null
  /** Partitioned-eviction split (increment 1b): fraction of budget reserved for initial prefixes. */
  initialBudgetFraction?: number
  byKind?: { initial?: { b?: number; n?: number }; running?: { b?: number; n?: number } }
}

export class KvCacheStore {
  eligible: KvEligibleSvc[] = []
  services: Record<string, KvOrchStats> = {}
  pools: Record<string, KvPoolStats> = {}
  settings: KvSettings = { defaultEnabled: false, perService: {} }
  loaded = false
  error = ''
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const r = await bridge().request('GET', '/api/proxy/kvcache/stats')
      runInAction(() => {
        this.eligible = (r as any)?.eligible ?? []
        this.services = (r as any)?.services ?? {}
        this.pools = (r as any)?.pools ?? {}
        this.settings = (r as any)?.settings ?? { defaultEnabled: false, perService: {} }
        this.loaded = true
        this.error = ''
      })
    } catch (e: any) {
      runInAction(() => { this.error = e?.message || 'load failed'; this.loaded = true })
    }
  }

  startPolling(ms = 15000): void {
    if (this.timer) return
    void this.load()
    this.timer = setInterval(() => void this.load(), ms)
  }
  stopPolling(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  isEnabled(svcId: string): boolean {
    const per = this.settings.perService?.[svcId]
    return per?.enabled != null ? !!per.enabled : !!this.settings.defaultEnabled
  }

  configOf(svcId: string): KvSvcConfig { return this.settings.perService?.[svcId]?.config || {} }

  private async post(body: any): Promise<void> {
    await bridge().request('POST', '/api/proxy/kvcache/settings', body)
    await this.load()
  }

  async setEnabled(svcId: string, enabled: boolean): Promise<void> {
    await this.post({ perService: { [svcId]: { enabled } } })
  }

  async setConfigValue(svcId: string, key: string, value: number | null): Promise<void> {
    const config: KvSvcConfig = {}
    config[key] = value as any
    await this.post({ perService: { [svcId]: { config } } })
  }

  async reap(fp: string): Promise<any> {
    const r = await bridge().request('POST', `/api/proxy/kvcache/reap/${encodeURIComponent(fp)}`, {})
    await this.load()
    return r
  }
}

export const kvCacheStore = new KvCacheStore()
