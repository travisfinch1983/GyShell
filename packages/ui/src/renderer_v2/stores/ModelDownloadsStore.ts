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
  hfMaxActive = 3
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
  civVariables: any = null // /civitai/variables (template vars, grouped or flat)
  civFolderTypes: any[] = [] // /civitai/folder-types
  civTplType = '_global' // which type's template is being edited
  civExtrasLoaded = false

  // Review model/version browser
  civModel: any = null // fetched civitai model JSON
  civModelLoading = false
  civModelError: string | null = null
  civSelVersionId: number | null = null
  civSelFiles = new Set<string>() // file names selected in the current version
  civResolvedDir = '' // resolved target dir from /resolve-paths
  civReviewUserDefined = ''
  civReviewFnOverride = ''

  // history (immutable download records)
  hfHistory: any[] = []
  civHistory: any[] = []
  // CivitAI mode toggle + history view state
  civMode: 'downloader' | 'review' | 'renamer' = 'downloader'
  histText = ''
  histHiddenTypes = new Set<string>()
  histHiddenFlags = new Set<string>() // 'located' | 'customPath' | 'customFilename'
  histSelected = new Set<string>() // `${modelId}:${versionId}`
  histPageSize = 50
  histPage = 0
  histSyncing = false

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
        maxActive: this.hfMaxActive,
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

  /** Template variables + folder types for the template builder (loaded once). */
  async loadCivExtras(): Promise<void> {
    if (this.civExtrasLoaded) return
    const api = this.cluster()
    const [vars, types] = await Promise.all([
      api.request('GET', '/api/civitai/variables').catch(() => null),
      api.request('GET', '/api/civitai/folder-types').catch(() => []),
    ])
    runInAction(() => {
      this.civVariables = vars
      this.civFolderTypes = Array.isArray(types) ? types : (types as any)?.types ?? []
      this.civExtrasLoaded = true
    })
  }

  setCivTplType(t: string): void {
    this.civTplType = t
  }
  get currentTpl(): string {
    const tt = this.civConfig.typeTemplates?.[this.civTplType]
    if (this.civTplType !== '_global' && tt?.pathTemplate) return tt.pathTemplate
    return this.civConfig.pathTemplate || '$REPO_NAME/$MODEL_FILE_NAME$EXTENSION'
  }
  get currentSep(): string {
    return this.civConfig.typeTemplates?.[this.civTplType]?.separator || this.civConfig.separator || '-'
  }
  get currentCase(): string {
    return this.civConfig.typeTemplates?.[this.civTplType]?.caseMode || this.civConfig.caseMode || 'standard'
  }
  private writeTpl(patch: { pathTemplate?: string; separator?: string; caseMode?: string }): void {
    const cfg = { ...this.civConfig }
    if (this.civTplType === '_global') {
      Object.assign(cfg, patch)
    } else {
      const tt = { ...(cfg.typeTemplates || {}) }
      tt[this.civTplType] = { ...(tt[this.civTplType] || {}), ...patch }
      cfg.typeTemplates = tt
    }
    this.civConfig = cfg
  }
  setTpl(str: string): void {
    this.writeTpl({ pathTemplate: str })
  }
  insertTplVar(v: string): void {
    this.writeTpl({ pathTemplate: this.currentTpl + v })
  }
  setTplField(k: 'separator' | 'caseMode', v: string): void {
    this.writeTpl({ [k]: v })
  }
  async saveTemplate(): Promise<void> {
    await this.saveCivConfig()
  }

  async loadHistories(): Promise<void> {
    const api = this.cluster()
    const [hf, civ] = await Promise.all([
      api.request('GET', '/api/ai/hf/history').catch(() => ({ items: [] })),
      api.request('GET', '/api/civitai/history').catch(() => ({ items: [] })),
    ])
    runInAction(() => {
      this.hfHistory = ((hf as any)?.items ?? []) as any[]
      this.civHistory = ((civ as any)?.items ?? (civ as any)?.history ?? []) as any[]
    })
  }

  // ── CivitAI history view (filters/selection/pagination) ──
  setCivMode(m: 'downloader' | 'review' | 'renamer'): void {
    this.civMode = m
  }
  private histKey(i: any): string {
    return `${i.modelId}:${i.versionId || ''}`
  }
  get histTypeCounts(): Record<string, number> {
    const c: Record<string, number> = {}
    for (const i of this.civHistory) c[i.modelType] = (c[i.modelType] || 0) + 1
    return c
  }
  get histFlagCounts(): { located: number; customPath: number; customFilename: number } {
    let located = 0, customPath = 0, customFilename = 0
    for (const i of this.civHistory) {
      if (i.hasFiles || i.locatedFiles?.length) located++
      if (i.pathOverride) customPath++
      if (i.fileNameOverride) customFilename++
    }
    return { located, customPath, customFilename }
  }
  get filteredHistory(): any[] {
    let f = this.civHistory
    if (this.histHiddenTypes.size) f = f.filter((i) => !this.histHiddenTypes.has(i.modelType))
    if (this.histHiddenFlags.has('located')) f = f.filter((i) => !(i.hasFiles || i.locatedFiles?.length))
    if (this.histHiddenFlags.has('customPath')) f = f.filter((i) => !i.pathOverride)
    if (this.histHiddenFlags.has('customFilename')) f = f.filter((i) => !i.fileNameOverride)
    if (this.histText.trim()) {
      const q = this.histText.toLowerCase()
      f = f.filter((i) => (i.modelName || '').toLowerCase().includes(q))
    }
    return f
  }
  get histTotalPages(): number {
    return this.histPageSize === 0 ? 1 : Math.max(1, Math.ceil(this.filteredHistory.length / this.histPageSize))
  }
  get histPageItems(): any[] {
    if (this.histPageSize === 0) return this.filteredHistory
    const start = Math.min(this.histPage, this.histTotalPages - 1) * this.histPageSize
    return this.filteredHistory.slice(start, start + this.histPageSize)
  }
  get histAllOn(): boolean {
    return this.histHiddenTypes.size === 0 && this.histHiddenFlags.size === 0
  }
  isHistSelected(i: any): boolean {
    return this.histSelected.has(this.histKey(i))
  }
  toggleHistType(t: string): void {
    this.histHiddenTypes.has(t) ? this.histHiddenTypes.delete(t) : this.histHiddenTypes.add(t)
    this.histPage = 0
  }
  toggleHistFlag(flag: string): void {
    this.histHiddenFlags.has(flag) ? this.histHiddenFlags.delete(flag) : this.histHiddenFlags.add(flag)
    this.histPage = 0
  }
  histShowAll(): void {
    this.histHiddenTypes.clear()
    this.histHiddenFlags.clear()
    this.histPage = 0
  }
  setHistText(v: string): void {
    this.histText = v
    this.histPage = 0
  }
  setHistPageSize(n: number): void {
    this.histPageSize = n
    this.histPage = 0
  }
  histPrev(): void {
    if (this.histPage > 0) this.histPage--
  }
  histNext(): void {
    if (this.histPage < this.histTotalPages - 1) this.histPage++
  }
  toggleHistSelect(i: any): void {
    const k = this.histKey(i)
    this.histSelected.has(k) ? this.histSelected.delete(k) : this.histSelected.add(k)
  }
  histSelectPage(): void {
    for (const i of this.histPageItems) this.histSelected.add(this.histKey(i))
  }
  histSelectAll(): void {
    for (const i of this.filteredHistory) this.histSelected.add(this.histKey(i))
  }
  histDeselectAll(): void {
    this.histSelected.clear()
  }
  private selectedKeysToIds(): Array<{ modelId: string; versionId: string }> {
    return [...this.histSelected].map((k) => {
      const [modelId, versionId] = k.split(':')
      return { modelId, versionId }
    })
  }
  async histSync(): Promise<void> {
    this.histSyncing = true
    try {
      await this.cluster().request('POST', '/api/civitai/history/sync', {})
      // poll sync-status briefly, then reload
      for (let n = 0; n < 40; n++) {
        await new Promise((r) => setTimeout(r, 1500))
        const s = (await this.cluster().request('GET', '/api/civitai/history/sync-status').catch(() => null)) as any
        if (s && !s.running && !s.syncing) break
      }
      await this.loadHistories()
    } catch (e) {
      runInAction(() => { this.civError = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.histSyncing = false })
    }
  }
  async histLocate(): Promise<void> {
    await this.cluster().request('POST', '/api/civitai/history/locate', {}).catch(() => undefined)
    await this.loadHistories()
  }
  async histAction(path: string): Promise<void> {
    const ids = this.selectedKeysToIds()
    if (!ids.length) return
    await this.cluster().request('POST', path, { items: ids, modelIds: ids.map((x) => x.modelId) }).catch(() => undefined)
    await Promise.all([this.loadHistories(), this.loadDownloads()])
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

  // ── Review model/version browser ──
  private parseModelId(input: string): { modelId: string; versionId?: string } | null {
    const s = (input || '').trim()
    if (/^\d+$/.test(s)) return { modelId: s }
    const m = s.match(/\/models\/(\d+)/)
    if (!m) return null
    const vid = s.match(/[?&]modelVersionId=(\d+)/)
    return { modelId: m[1], versionId: vid?.[1] }
  }
  get civVersions(): any[] {
    return this.civModel?.modelVersions ?? []
  }
  get civCurrentVersion(): any | null {
    return this.civVersions.find((v) => v.id === this.civSelVersionId) ?? this.civVersions[0] ?? null
  }
  async reviewLoad(input?: string): Promise<void> {
    const parsed = this.parseModelId(input ?? this.civUrl)
    if (!parsed) {
      runInAction(() => { this.civModelError = 'Paste a valid CivitAI model URL' })
      return
    }
    this.civModelLoading = true
    this.civModelError = null
    try {
      const api = (window as any).gyshell?.civitai
      const model = await api.model(parsed.modelId)
      runInAction(() => {
        this.civModel = model
        this.civMode = 'review'
        const versions = model?.modelVersions ?? []
        const v = (parsed.versionId && versions.find((x: any) => String(x.id) === parsed.versionId)) || versions[0]
        this.civSelVersionId = v?.id ?? null
        this.civSelFiles = new Set((v?.files ?? []).map((f: any) => f.name))
      })
      await this.resolveReviewPath()
    } catch (e) {
      runInAction(() => { this.civModelError = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.civModelLoading = false })
    }
  }
  selectVersion(vid: number): void {
    this.civSelVersionId = vid
    const v = this.civCurrentVersion
    this.civSelFiles = new Set((v?.files ?? []).map((f: any) => f.name))
    void this.resolveReviewPath()
  }
  toggleReviewFile(name: string): void {
    this.civSelFiles.has(name) ? this.civSelFiles.delete(name) : this.civSelFiles.add(name)
  }
  async resolveReviewPath(): Promise<void> {
    const m = this.civModel
    const v = this.civCurrentVersion
    if (!m || !v) return
    try {
      const r = (await this.cluster().request('POST', '/api/civitai/resolve-paths', {
        modelId: String(m.id),
        versionId: String(v.id),
        modelType: m.type,
        modelName: m.name,
        versionName: v.name,
        baseModel: v.baseModel,
        creatorName: m.creator?.username || '',
        primaryTag: (m.tags || [])[0] || '',
        tags: m.tags || [],
        files: (v.files || []).map((f: any) => ({ name: f.name })),
        userDefined: this.civReviewUserDefined || undefined,
        fileNameOverride: this.civReviewFnOverride || undefined,
      })) as any
      runInAction(() => { this.civResolvedDir = r?.targetDir || '' })
    } catch {
      runInAction(() => { this.civResolvedDir = '' })
    }
  }
  async reviewDownload(): Promise<void> {
    const m = this.civModel
    const v = this.civCurrentVersion
    if (!m || !v) return
    this.busy = true
    this.civModelError = null
    try {
      const body: any = { modelId: String(m.id), versionId: String(v.id), pageUrl: `https://civitai.com/models/${m.id}?modelVersionId=${v.id}` }
      if (this.civReviewUserDefined) body.userDefined = this.civReviewUserDefined
      if (this.civReviewFnOverride) body.fileNameOverride = this.civReviewFnOverride
      await this.cluster().request('POST', '/api/civitai/download', body)
      runInAction(() => { this.subTab = 'queue' })
      await Promise.all([this.loadDownloads(), this.loadHistories()])
    } catch (e) {
      runInAction(() => { this.civModelError = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.busy = false })
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
