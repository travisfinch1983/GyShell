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
  pveHostIp?: string
  vmid?: number
  port?: number
  containerName?: string
  containerIp?: string
  endpoint?: string
  model?: string
  modelFamily?: string
  modelVariant?: string
  quantFormat?: string
  quantSize?: string
  aliasOverride?: string
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

const IMAGE_GEN_PROVIDERS = new Set(['comfyui', 'sdnext', 'fooocus', 'invokeai'])
const STT_PROVIDERS = new Set(['faster-whisper'])
/**
 * Baseline type from reliable signals only (provider / isTts) — NO model-name guessing.
 * The ambiguous 'llm' bucket (vLLM can be chat OR embed OR rerank) is refined by a live
 * capability probe of the endpoint (ai:probeTypes); this is just the fallback until that returns.
 */
function classifyServiceType(s: AiService): string {
  if ((s as any).isTools) return 'tools'
  if (s.providerId && IMAGE_GEN_PROVIDERS.has(s.providerId)) return 'image'
  if (s.providerId && STT_PROVIDERS.has(s.providerId)) return 'stt'
  if (s.serviceType && s.serviceType !== 'llm') return s.serviceType // trust explicit tts/etc
  return 'llm'
}

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
  // live enrichment
  proxyState:
    | { port?: number; basePath?: string; lanIp?: string; lastRefresh?: number; types?: Record<string, any[]>; services?: any; vector?: any[] | null }
    | null = null
  gpuIndex: Record<string, { name: string; index: number; util: number; memUsed: number; memTotal: number; node: string }> = {}
  statsById: Record<string, { alive?: boolean; tps?: number; systemdState?: string; modelIdentifier?: string }> = {}
  utilHistory: Record<string, number[]> = {} // pciId → last N gpuUtil samples (%)
  vramHistory: Record<string, number[]> = {} // pciId → last N memUsed samples (MB)
  typeProbeCache: Record<string, string> = {} // endpoint → capability-detected type (llm/embed/rerank)

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
      const [svc, cfg, prov, gpu] = await Promise.all([
        api.request('GET', '/api/ai/active-services'),
        api.request('GET', '/api/ai/config'),
        api.request('GET', '/api/ai/providers').catch(() => ({ providers: [] })),
        api.request('GET', '/api/gpu').catch(() => ({})),
      ])
      const rawSvc = (svc as any)?.services ?? svc ?? {}
      const services: AiService[] = Array.isArray(rawSvc) ? rawSvc : Object.values(rawSvc)
      // Baseline type (provider/isTts); apply any cached capability-probe result over the 'llm' bucket.
      for (const s of services) {
        s.serviceType = classifyServiceType(s)
        if (s.serviceType === 'llm' && s.endpoint && this.typeProbeCache[s.endpoint]) {
          s.serviceType = this.typeProbeCache[s.endpoint]
        }
      }
      services.sort((a, b) => (a.node || '').localeCompare(b.node || '') || (a.port ?? 0) - (b.port ?? 0))
      // GPU inventory → per-pci {name, util, mem} + push util history
      const gpuIndex: typeof this.gpuIndex = {}
      for (const entry of Object.values((gpu as any) || {}) as any[]) {
        for (const g of entry?.gpus ?? []) {
          gpuIndex[g.pciId] = {
            name: g.friendlyName || g.name || g.productName || g.pciId,
            index: g.index ?? 0,
            util: g.gpuUtil ?? 0,
            memUsed: g.memUsed ?? 0,
            memTotal: g.memTotal ?? 0,
            node: entry.hostName || entry.hostId || '',
          }
        }
      }
      runInAction(() => {
        this.services = services
        this.config = { pools: (cfg as any)?.pools ?? {}, agents: (cfg as any)?.agents ?? {} }
        this.providers = ((prov as any)?.providers ?? []) as Provider[]
        this.gpuIndex = gpuIndex
        for (const [pci, g] of Object.entries(gpuIndex)) {
          this.utilHistory[pci] = (this.utilHistory[pci] ?? []).concat(g.util).slice(-24)
          this.vramHistory[pci] = (this.vramHistory[pci] ?? []).concat(g.memUsed).slice(-24)
        }
        this.error = null
        this.loaded = true
      })
      // proxy routing state (best-effort)
      try {
        const ps = await (window as any).gyshell?.proxy?.getState?.()
        if (ps) runInAction(() => { this.proxyState = ps })
      } catch {
        /* ignore */
      }
      // per-service status/tps (parallel; best-effort)
      void Promise.all(
        services.map(async (s) => {
          try {
            const st = await api.request('GET', `/api/ai/active-services/${encodeURIComponent(s.id)}/stats`)
            runInAction(() => {
              this.statsById[s.id] = st as any
            })
          } catch {
            /* ignore per-service stat errors */
          }
        }),
      )
      // Capability-probe the ambiguous 'llm' bucket (backend hits the endpoints) → refine to embed/rerank.
      void this.refineTypes(services)
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

  /** Running | suspended | down | unknown — derived from /stats. */
  statusOf(id: string): 'running' | 'suspended' | 'down' | 'unknown' {
    const st = this.statsById[id]
    if (!st) return 'unknown'
    if (st.alive) return 'running'
    if (st.systemdState === 'inactive') return 'suspended'
    return 'down'
  }

  async setAlias(id: string, identifier: string): Promise<void> {
    this.busyId = id
    try {
      await this.cluster().request('POST', `/api/ai/active-services/${encodeURIComponent(id)}/identifier`, { identifier })
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

  /** Capability-probe the 'llm' bucket via the backend; cache + apply embed/rerank refinements. */
  async refineTypes(services: AiService[]): Promise<void> {
    const api = (window as any).gyshell?.ai
    if (!api?.probeTypes) return
    const todo = services.filter((s) => s.serviceType === 'llm' && s.endpoint && !this.typeProbeCache[s.endpoint])
    if (!todo.length) return
    try {
      const res = (await api.probeTypes(todo.map((s) => ({ id: s.id, endpoint: s.endpoint })))) as Record<string, string>
      runInAction(() => {
        let changed = false
        for (const s of services) {
          const t = res?.[s.id]
          if (!t || !s.endpoint) continue
          this.typeProbeCache[s.endpoint] = t // cache even 'llm' so we don't re-probe
          if (t !== 'llm' && s.serviceType !== t) {
            s.serviceType = t
            changed = true
          }
        }
        if (changed) this.services = [...this.services]
      })
    } catch {
      /* ignore */
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
