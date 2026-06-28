import { makeAutoObservable, runInAction } from 'mobx'

/**
 * AiProvidersStore — provider install/uninstall management (migrated from ProxLab's AI Pool
 * "Providers" section). Bridged via cluster:request (/api/ai/providers + per-provider actions);
 * the install itself runs in a live PTY (InstallTerminal) over AI-Lab's catalogInstall relay:
 * prepare-install returns {vmid, pveHostIp, command}, we run `pct exec <vmid> -- <command>`.
 */
export interface ProviderAgent {
  installed?: boolean
  version?: string | null
  installedAt?: number | null
  updateAvailable?: string | null
}
export interface Provider {
  id: string
  name: string
  description?: string
  category: string // llm | tts | stt | image | training | tools
  website?: string
  complexity?: string
  defaultPort?: number
  supportedArchs?: string[]
  supportedFormats?: string[]
  installExtras?: Array<{ id: string; label: string; size?: string }>
  installModels?: Array<{ id: string; label: string; size?: string; hfRepo?: string }>
  agents?: Record<string, ProviderAgent>
}

export interface PrepareInstallResult {
  vmid: number
  pveHostIp: string
  node: string
  providerId: string
  command: string
}

export class AiProvidersStore {
  providers: Provider[] = []
  loading = false
  error: string | null = null
  busyId: string | null = null // `${id}:${node}` currently acting

  constructor() {
    makeAutoObservable(this)
  }
  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }
  /** Union of agent/node names across all providers (install targets). */
  get nodes(): string[] {
    const set = new Set<string>()
    for (const p of this.providers) for (const n of Object.keys(p.agents ?? {})) set.add(n)
    return [...set].sort()
  }
  byCategory(categories: string[]): Provider[] {
    const set = new Set(categories)
    return this.providers.filter((p) => set.has(p.category))
  }

  async load(): Promise<void> {
    this.loading = true
    try {
      const r = (await this.cluster().request('GET', '/api/ai/providers')) as any
      runInAction(() => {
        this.providers = (r?.providers ?? []) as Provider[]
      })
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  async prepareInstall(id: string, node: string, extras: string[] = [], models: string[] = []): Promise<PrepareInstallResult | null> {
    try {
      const r = (await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/prepare-install`, {
        node,
        installExtras: extras,
        downloadModels: models,
      })) as PrepareInstallResult
      return r
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
      return null
    }
  }
  async prepareUpdate(id: string, node: string): Promise<PrepareInstallResult | null> {
    try {
      return (await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/prepare-update`, { node })) as PrepareInstallResult
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
      return null
    }
  }
  /** Live status re-check (reads /opt/<id>/.version on each node + persists to ai-config). */
  async refreshStatus(id: string): Promise<void> {
    this.busyId = `${id}:status`
    try {
      await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/status`, {})
      await this.load()
    } catch {
      /* ignore */
    } finally {
      runInAction(() => { this.busyId = null })
    }
  }
  async checkUpdate(id: string): Promise<void> {
    this.busyId = `${id}:update`
    try {
      await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/check-update`, {})
      await this.load()
    } catch {
      /* ignore */
    } finally {
      runInAction(() => { this.busyId = null })
    }
  }
  async uninstall(id: string, node: string): Promise<void> {
    this.busyId = `${id}:${node}`
    try {
      await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/uninstall`, { node })
      await this.load()
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.busyId = null })
    }
  }
}

export const aiProvidersStore = new AiProvidersStore()
