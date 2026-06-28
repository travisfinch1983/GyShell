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
  /** Merge a live { results: { node: {status, version, updateAvailable} } } into a provider's agents.
   *  We trust the LIVE check over the persisted ai-config flags (which go stale — version null,
   *  phantom updateAvailable, installed:true after a manual removal, etc.). */
  private mergeStatus(id: string, results: Record<string, any>): void {
    const p = this.providers.find((x) => x.id === id)
    if (!p || !results) return
    runInAction(() => {
      const agents = { ...(p.agents ?? {}) }
      for (const [node, r] of Object.entries(results)) {
        if (!r || (r as any).ok === false) continue
        const prev = agents[node] ?? {}
        const installed = (r as any).status === 'installed'
        agents[node] = {
          ...prev,
          installed,
          version: installed ? ((r as any).version ?? prev.version ?? null) : null,
          updateAvailable: (r as any).updateAvailable || null,
        }
      }
      p.agents = agents
      this.providers = [...this.providers] // trigger observers
    })
  }
  /** Live status re-check (reads /opt/<id>/.version on each node). Merges live result; does NOT reload stale data. */
  async refreshStatus(id: string): Promise<void> {
    this.busyId = `${id}:status`
    try {
      const r = (await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/status`, {})) as any
      this.mergeStatus(id, r?.results ?? {})
    } catch {
      /* ignore */
    } finally {
      runInAction(() => { this.busyId = null })
    }
  }
  async checkUpdate(id: string): Promise<void> {
    this.busyId = `${id}:update`
    try {
      const r = (await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/check-update`, {})) as any
      this.mergeStatus(id, r?.results ?? {})
    } catch {
      /* ignore */
    } finally {
      runInAction(() => { this.busyId = null })
    }
  }
  /** Live-verify a set of providers in parallel (used on tab open so cards reflect reality, not stale config). */
  async liveVerify(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.refreshStatusQuiet(id)))
  }
  private async refreshStatusQuiet(id: string): Promise<void> {
    try {
      const r = (await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/status`, {})) as any
      this.mergeStatus(id, r?.results ?? {})
    } catch {
      /* ignore */
    }
  }
  async uninstall(id: string, node: string): Promise<void> {
    this.busyId = `${id}:${node}`
    try {
      const r = (await this.cluster().request('POST', `/api/ai/providers/${encodeURIComponent(id)}/uninstall`, { node })) as any
      // merge the uninstall result; if it didn't report status, force this node not-installed
      const results = r?.results ?? { [node]: { ok: true, status: 'not_installed' } }
      this.mergeStatus(id, results)
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.busyId = null })
    }
  }
}

export const aiProvidersStore = new AiProvidersStore()
