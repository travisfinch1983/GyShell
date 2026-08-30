import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

export interface OptaneEngineMetrics {
  storedBytes?: number
  restoredBytes?: number
  storedSec?: number
  restoredSec?: number
  extHits?: number
  extQueries?: number
  error?: string
}

export interface OptaneEngine {
  pid: number
  engine: 'vllm' | 'llama.cpp'
  /** Read from the running process, not from config — see the backend module for why. */
  kvEnabled: boolean
  kvDir?: string | null
  port?: string | null
  model?: string | null
  specName?: string | null
  cpuBytes?: number | null
  configError?: string
  metrics?: OptaneEngineMetrics
  serviceId?: string
  name?: string
  providerId?: string
}

export interface OptaneHotBlock { block: string; hits: number; lastHit: number }

export interface OptanePool {
  path: string
  name: string
  files: number
  bytes: number
  oldest?: number | null
  newest?: number | null
  hotness?: {
    tracked: number
    totalHits: number
    reusedBlocks: number
    lastHit: number | null
    top: OptaneHotBlock[]
  } | null
  hotnessError?: string
  usedBy?: Array<{ pid: number; port?: string | null; engine: string }>
}

export interface OptaneFs { mount: string; sizeBytes: number; usedBytes: number; availBytes: number }

export interface OptaneNode {
  host: string
  node?: string | null
  error?: string
  engines?: OptaneEngine[]
  pools?: OptanePool[]
  filesystems?: OptaneFs[]
  shmRegions?: { count: number; bytes: number }
}

export interface OptaneSnapshot {
  hash: string
  modelFp: string
  tokens: number
  bytes: number
  kind: string
  createdAt: number
  lastRestoredAt: number
  restoreCount: number
  engine: string
  db?: string
  error?: string
}

export class OptaneCacheStore {
  nodes: OptaneNode[] = []
  snapshots: OptaneSnapshot[] = []
  vllmOptaneBase = ''
  generatedAt = 0
  loaded = false
  loading = false
  error = ''
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    runInAction(() => { this.loading = true })
    try {
      const r = await bridge().request('GET', '/api/proxy/kvcache/optane')
      runInAction(() => {
        this.nodes = (r as any)?.nodes ?? []
        this.snapshots = (r as any)?.snapshots ?? []
        this.vllmOptaneBase = (r as any)?.vllmOptaneBase ?? ''
        this.generatedAt = (r as any)?.generatedAt ?? 0
        this.error = (r as any)?.error ?? ''
        this.loaded = true
        this.loading = false
      })
    } catch (e: any) {
      runInAction(() => { this.error = e?.message || 'load failed'; this.loaded = true; this.loading = false })
    }
  }

  // The collector walks whole pool directories, so this is heavier than the other metric polls.
  // 60s is frequent enough for a health panel and cheap enough to leave running.
  startPolling(ms = 60000): void {
    if (this.timer) return
    void this.load()
    this.timer = setInterval(() => void this.load(), ms)
  }
  stopPolling(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  get engines(): OptaneEngine[] { return this.nodes.flatMap((n) => n.engines ?? []) }
  get pools(): OptanePool[] { return this.nodes.flatMap((n) => n.pools ?? []) }
  get wired(): OptaneEngine[] { return this.engines.filter((e) => e.kvEnabled) }

  /**
   * The single question this panel exists to answer.
   *
   * 'dead' is the important state and the reason for the whole dashboard: the cache is attached
   * and storing, but nothing has ever been restored from it. That is exactly how it sat broken
   * for months while looking configured.
   */
  get health(): { state: 'ok' | 'dead' | 'idle' | 'off' | 'unknown'; detail: string } {
    if (this.nodes.some((n) => n.error) && this.engines.length === 0) {
      return { state: 'unknown', detail: this.nodes.find((n) => n.error)?.error || 'node unreachable' }
    }
    if (this.engines.length === 0) return { state: 'unknown', detail: 'no LLM services running' }
    const wired = this.wired
    if (wired.length === 0) return { state: 'off', detail: 'no running service has the KV cache attached' }
    const stored = wired.reduce((a, e) => a + (e.metrics?.storedBytes || 0), 0)
    const restored = wired.reduce((a, e) => a + (e.metrics?.restoredBytes || 0), 0)
    const llamaRestores = this.snapshots.reduce((a, s) => a + (s.restoreCount || 0), 0)
    if (restored > 0 || llamaRestores > 0) {
      return { state: 'ok', detail: `${wired.length} service${wired.length === 1 ? '' : 's'} wired · cache is being restored from` }
    }
    if (stored > 0) {
      return { state: 'dead', detail: 'storing but NOTHING restored — cache is attached but not being read' }
    }
    return { state: 'idle', detail: 'wired, but no traffic through the cache yet' }
  }
}

export const optaneCacheStore = new OptaneCacheStore()
