import { makeAutoObservable, runInAction } from 'mobx'

/**
 * ModelDownloadsStore — HF + CivitAI downloaders + the unified download queue (migrated from
 * ProxLab's file-manager downloader sub-tabs). Bridged via cluster:request: HF under /api/ai/hf/*,
 * CivitAI under /api/civitai/*. Downloads execute on ProxLab/the ZFS host for now (native
 * downloader port is a finalization item); this is the UI + queue management over those endpoints.
 */
export type DLSubTab = 'queue' | 'hf' | 'civitai'

export interface DLItem {
  id: string
  status?: string // downloading | queued | pending | complete | failed
  progress?: number
  size?: number
  speed?: number
  error?: string | null
  fileName?: string
  repo?: string
  modelName?: string
  modelType?: string
  targetDir?: string
}
export interface HFFile {
  path: string
  size?: number
  quant?: string
}
interface HFAnalysis {
  repoType?: string
  ggufQuants?: HFFile[]
  components?: Record<string, { files: HFFile[]; totalSize?: number }>
  extras?: HFFile[]
  suggestedName?: string
}

const CATEGORIES = ['image-gen', 'llm', 'tts'] as const

export class ModelDownloadsStore {
  subTab: DLSubTab = 'queue'

  // HF browse/select
  hfRepo = ''
  hfRevision = 'main'
  hfBranches: string[] = []
  hfCategory: (typeof CATEGORIES)[number] = 'llm'
  hfAnalysis: HFAnalysis | null = null
  hfSelected: Record<string, boolean> = {} // path → selected
  hfIncludeExtras = false
  hfBrowsing = false
  hfError: string | null = null
  hfSuggestedSubfolder = ''

  // CivitAI
  civUrl = ''
  civConfig: Record<string, any> = {}
  civPathOverride = ''
  civError: string | null = null
  civConfigLoaded = false

  // queue
  hfDownloads: DLItem[] = []
  civDownloads: DLItem[] = []
  busy = false

  private poll: ReturnType<typeof setInterval> | null = null

  constructor() {
    makeAutoObservable(this)
  }
  get categories() {
    return CATEGORIES
  }
  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }
  setSubTab(t: DLSubTab): void {
    this.subTab = t
  }

  // ── HF ──
  async browseHf(): Promise<void> {
    const repo = this.hfRepo.trim().replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/+$/, '')
    if (!repo) return
    this.hfBrowsing = true
    this.hfError = null
    try {
      const r = (await this.cluster().request('POST', '/api/ai/hf/tree', { repo, revision: this.hfRevision })) as any
      runInAction(() => {
        this.hfRepo = repo
        this.hfAnalysis = r?.analysis ?? null
        this.hfBranches = r?.branches ?? []
        this.hfSuggestedSubfolder = r?.suggestedFamily ? `${r.suggestedFamily}${r.suggestedVariant ? '/' + r.suggestedVariant : ''}` : r?.analysis?.suggestedName || ''
        this.hfSelected = {}
        // preselect GGUF quants + diffusers components by default
        for (const q of r?.analysis?.ggufQuants ?? []) this.hfSelected[q.path] = false
      })
    } catch (e) {
      runInAction(() => {
        this.hfError = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.hfBrowsing = false
      })
    }
  }
  toggleHfFile(path: string): void {
    this.hfSelected[path] = !this.hfSelected[path]
  }
  get hfSelectedFiles(): HFFile[] {
    const a = this.hfAnalysis
    if (!a) return []
    const all: HFFile[] = [
      ...(a.ggufQuants ?? []),
      ...Object.values(a.components ?? {}).flatMap((c) => c.files ?? []),
    ]
    const seen = new Set<string>()
    return all.filter((f) => this.hfSelected[f.path] && !seen.has(f.path) && seen.add(f.path))
  }
  async downloadHf(): Promise<void> {
    const files = this.hfSelectedFiles
    if (!files.length) return
    this.busy = true
    try {
      await this.cluster().request('POST', '/api/ai/hf/download', {
        repo: this.hfRepo,
        revision: this.hfRevision,
        files,
        node: '_local',
        category: this.hfCategory,
        subfolder: this.hfSuggestedSubfolder,
        includeExtras: this.hfIncludeExtras,
      })
      runInAction(() => {
        this.subTab = 'queue'
      })
      await this.loadDownloads()
    } catch (e) {
      runInAction(() => {
        this.hfError = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.busy = false
      })
    }
  }

  // ── CivitAI ──
  async loadCivConfig(): Promise<void> {
    try {
      const c = (await this.cluster().request('GET', '/api/civitai/config')) as any
      runInAction(() => {
        this.civConfig = c ?? {}
        this.civConfigLoaded = true
      })
    } catch {
      runInAction(() => {
        this.civConfigLoaded = true
      })
    }
  }
  setCivConfig(k: string, v: any): void {
    this.civConfig = { ...this.civConfig, [k]: v }
  }
  async saveCivConfig(): Promise<void> {
    await this.cluster().request('PUT', '/api/civitai/config', this.civConfig)
  }
  async downloadCiv(): Promise<void> {
    const url = this.civUrl.trim()
    if (!url) return
    this.busy = true
    this.civError = null
    try {
      const body: any = { pageUrl: url }
      if (this.civPathOverride.trim()) body.pathOverride = this.civPathOverride.trim()
      await this.cluster().request('POST', '/api/civitai/download', body)
      runInAction(() => {
        this.subTab = 'queue'
        this.civUrl = ''
      })
      await this.loadDownloads()
    } catch (e) {
      runInAction(() => {
        this.civError = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.busy = false
      })
    }
  }

  // ── queue ──
  async loadDownloads(): Promise<void> {
    const api = this.cluster()
    const [hf, civ] = await Promise.all([
      api.request('GET', '/api/ai/hf/downloads').catch(() => ({ downloads: [] })),
      api.request('GET', '/api/civitai/downloads').catch(() => ({ downloads: [] })),
    ])
    runInAction(() => {
      this.hfDownloads = ((hf as any)?.downloads ?? []) as DLItem[]
      this.civDownloads = ((civ as any)?.downloads ?? []) as DLItem[]
    })
  }
  async action(source: 'hf' | 'civ', id: string, act: 'stop' | 'force' | 'cancel'): Promise<void> {
    const api = this.cluster()
    const base = source === 'hf' ? '/api/ai/hf/downloads' : '/api/civitai/downloads'
    try {
      if (act === 'cancel') await api.request('DELETE', `${base}/${encodeURIComponent(id)}`)
      else await api.request('POST', `${base}/${encodeURIComponent(id)}/${act}`)
      await this.loadDownloads()
    } catch {
      /* ignore */
    }
  }
  async clearCompleted(source: 'hf' | 'civ'): Promise<void> {
    const api = this.cluster()
    try {
      if (source === 'hf') await api.request('POST', '/api/ai/hf/clear-completed')
      else await api.request('POST', '/api/civitai/downloads/clear')
      await this.loadDownloads()
    } catch {
      /* ignore */
    }
  }

  startPolling(intervalMs = 3000): void {
    void this.loadDownloads()
    if (this.poll) return
    this.poll = setInterval(() => void this.loadDownloads(), intervalMs)
  }
  stopPolling(): void {
    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
  }
}

export const modelDownloadsStore = new ModelDownloadsStore()
