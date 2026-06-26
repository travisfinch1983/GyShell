import { makeAutoObservable, runInAction } from 'mobx'

/**
 * AiServicesStore — AI Services tab (migrated from ProxLab ai.js).
 *
 * Phase 1: GPU pool view + running-services management (status + lifecycle). Reads via the
 * cluster:request bridge to /api/ai (already allowlisted). Launch UI / model cache / HF / RAG /
 * MCP land in later phases. Lifecycle (kill/suspend/start/restart) is bridged HTTP for now; the
 * native SSH/systemd path can replace it later via AI-Lab's own key.
 */
export interface AiService {
  id: string
  providerId?: string
  providerName?: string
  node?: string
  vmid?: number
  port?: number
  containerName?: string
  containerIp?: string
  endpoint?: string
  model?: string
  modelFamily?: string
  modelVariant?: string
  quantFormat?: string
  contextSize?: number
  serviceType?: string // llm | tts | stt | image | tools | embed | rerank | training
  isSystemService?: boolean
  systemdUnit?: string
  tmuxSession?: string
  gpuPciIds?: string[]
  reservedVramMB?: number | null
  proxySlot?: string
  startedAt?: number
}
interface PoolEntry {
  mode?: string // ai-pool | reserved
}
interface AgentCfg {
  vmid?: number
  providers?: Record<string, { installed?: boolean; version?: string }>
  cache?: Record<string, unknown>
  lastSyncTs?: number
}
export interface AiConfig {
  pools: Record<string, PoolEntry> // key "node:pci"
  agents: Record<string, AgentCfg>
}
export interface Provider {
  id: string
  category?: string
  name: string
}

export type AiView = 'services' | 'pool'
type Lifecycle = 'kill' | 'suspend' | 'start' | 'restart'

let pollTimer: ReturnType<typeof setInterval> | null = null

export class AiServicesStore {
  services: AiService[] = []
  config: AiConfig = { pools: {}, agents: {} }
  providers: Provider[] = []
  loading = false
  error: string | null = null
  busyId: string | null = null
  view: AiView = 'services'
  typeFilter = 'all'
  loaded = false

  constructor() {
    makeAutoObservable(this)
  }

  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }

  setView(v: AiView): void {
    this.view = v
  }
  setTypeFilter(t: string): void {
    this.typeFilter = t
  }

  async load(): Promise<void> {
    this.loading = true
    try {
      const api = this.cluster()
      const [svc, cfg, prov] = await Promise.all([
        api.request('GET', '/api/ai/active-services'),
        api.request('GET', '/api/ai/config'),
        api.request('GET', '/api/ai/providers').catch(() => ({ providers: [] })),
      ])
      const rawSvc = (svc as any)?.services ?? svc ?? {}
      const services: AiService[] = Array.isArray(rawSvc) ? rawSvc : Object.values(rawSvc)
      services.sort((a, b) => (a.node || '').localeCompare(b.node || '') || (a.port ?? 0) - (b.port ?? 0))
      runInAction(() => {
        this.services = services
        this.config = { pools: (cfg as any)?.pools ?? {}, agents: (cfg as any)?.agents ?? {} }
        this.providers = ((prov as any)?.providers ?? []) as Provider[]
        this.error = null
        this.loaded = true
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }

  get serviceTypes(): string[] {
    return [...new Set(this.services.map((s) => s.serviceType || 'other'))].sort()
  }
  get filteredServices(): AiService[] {
    if (this.typeFilter === 'all') return this.services
    return this.services.filter((s) => (s.serviceType || 'other') === this.typeFilter)
  }

  async lifecycle(id: string, action: Lifecycle): Promise<void> {
    this.busyId = id
    try {
      await this.cluster().request('POST', `/api/ai/active-services/${encodeURIComponent(id)}/${action}`)
      await this.load()
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.busyId = null
      })
    }
  }

  /** Pool GPUs grouped by node (from config.pools keyed "node:pci"). */
  poolByNode(node: string): Array<{ pci: string; mode: string }> {
    return Object.entries(this.config.pools)
      .filter(([k]) => k.startsWith(node + ':'))
      .map(([k, v]) => ({ pci: k.slice(node.length + 1), mode: v?.mode || 'reserved' }))
      .sort((a, b) => a.pci.localeCompare(b.pci))
  }

  startPolling(intervalMs = 15000): void {
    void this.load()
    if (pollTimer) return
    pollTimer = setInterval(() => void this.load(), intervalMs)
  }
  stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

export const aiServicesStore = new AiServicesStore()
