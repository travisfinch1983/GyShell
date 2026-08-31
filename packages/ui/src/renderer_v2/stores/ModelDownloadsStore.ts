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
  analysisLabel?: string
  ggufQuants?: HFFile[]
  weightFiles?: HFFile[]
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
  hfDestTypeOverride = '' // user-picked model type (dropdown); overrides the auto-derived default
  hfFamilies: string[] = []                       // existing family folders under the category root
  hfHiddenQuants: Record<string, boolean> = {}    // quant badge → hidden (filter the file list)

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
  civSelVersionId: number | null = null // the version currently BEING VIEWED (not the download set)
  civResolvedDir = '' // resolved target dir from /resolve-paths
  civResolvedFiles: Array<{ originalName: string; newName: string }> = [] // per-file resolved names

  // ── Per-version review state (parity with ProxLab's pathOverrides/fileNameOverrides maps) ──
  //
  // These were previously single shared fields (civReviewUserDefined / civReviewFnOverride), so
  // whatever you typed while viewing one version was still applied when you switched to another —
  // every version resolved to the same filename and they overwrote each other on disk.
  //
  // The folder box maps to `pathOverride`, NOT `userDefined`: userDefined only sets a
  // $USER_DEFINED template variable and does nothing unless the path template references it,
  // whereas pathOverride literally replaces the folder segment
  // (final dir = basePath/typeFolder/folderPart). It holds the RELATIVE folder, e.g. "Pony_XL".
  civVerFolder = new Map<number, string>() // versionId → pathOverride (relative folder)
  civVerFilename = new Map<number, string>() // versionId → fileNameOverride (base name, no extension)
  civVerSeeded = new Set<number>() // versions whose boxes have been pre-filled from the resolver
  civVerSelected = new Set<number>() // versions ticked for download
  // versionId → selected CivitAI FILE IDs (scoped per version).
  // 🛑 Was a Set of file NAMES. One version routinely ships several files with the same
  // name (fp8 / bf16 / GGUF quants), so the Set collapsed them to one entry: ticking or
  // unticking any of them moved all of them together, and there was no way to choose one.
  civVerFiles = new Map<number, Set<string>>()
  /** versionId → fileId → per-file naming options.
   *  A version can hold several genuinely different files that the template cannot tell
   *  apart, because the template only sees VERSION-level variables: Krea 2 Identity Edit
   *  v1.2 ships the full LoRA plus r128 and r64 ranks, and all three resolve to one name.
   *  `noRename` keeps the upstream filename verbatim; `suffix` is appended to the generated
   *  name before the extension. Naming them yourself also suppresses the automatic
   *  `-<fileId>` disambiguation, which exists only as a last-resort guard. */
  civFileOpts = new Map<number, Map<string, { noRename?: boolean; suffix?: string }>>()
  civQueue: any[] = [] // /api/civitai/queue — items sent from the browser extension's "Review" button
  civQueueItemId: string | null = null // the queue item currently loaded into the browser
  civQueueIndex = 0 // position in the review queue (navigated with prev/next arrows)
  civVersionStatus: Record<string, any> = {} // versionId → {inHistory, allExist, someExist, noneExist} from /check-existing (on-disk)

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

  // download scheduler (per source: mode auto/manual, manualState running/paused, schedule[7][24])
  scheduler: Record<string, any> = {}

  // renamer queue
  renamerItems: any[] = []
  renamerDetails: Record<string, any> = {} // modelId → {currentDir, locatedFiles, newDir, moves}
  renamerLoading = false

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
        this.hfDestTypeOverride = ''; this.hfSuggestedSubfolder = r?.suggestedFamily ? `${r.suggestedFamily}${r.suggestedVariant ? '/' + r.suggestedVariant : ''}` : r?.analysis?.suggestedName || ''
        this.hfSelected = {}
        this.hfHiddenQuants = {}
        // preselect GGUF quants + diffusers components by default
        for (const q of r?.analysis?.ggufQuants ?? []) this.hfSelected[q.path] = false
      })
      void this.loadFamilies()
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
  /** Bulk select/deselect — backs the All/None buttons in the picker. */
  setHfFiles(paths: string[], on: boolean): void {
    for (const p of paths) this.hfSelected[p] = on
  }
  /** Files actually visible in the picker. GGUF quants hidden by the badge
   *  filter are excluded, so "All" can never select something off-screen. */
  get hfVisibleFiles(): HFFile[] {
    const a = this.hfAnalysis
    if (!a) return []
    const all: HFFile[] = [
      ...(a.ggufQuants ?? []).filter((f) => !this.hfHiddenQuants[f.quant || 'other']),
      ...(a.weightFiles ?? []),
      ...Object.values(a.components ?? {}).flatMap((c) => c.files ?? []),
    ]
    const seen = new Set<string>()
    return all.filter((f) => !seen.has(f.path) && seen.add(f.path))
  }
  toggleQuant(q: string): void {
    this.hfHiddenQuants[q] = !this.hfHiddenQuants[q]
  }
  async loadFamilies(): Promise<void> {
    try {
      const r = (await this.cluster().request('GET', `/api/ai/hf/families?category=${encodeURIComponent(this.hfCategory)}`)) as any
      runInAction(() => { this.hfFamilies = Array.isArray(r?.families) ? r.families : [] })
    } catch { /* non-fatal — picker just stays empty */ }
  }
  /** Auto-derived destination type from the detected repo type (the default suggestion). */
  get hfDefaultDestType(): string {
    const rt = this.hfAnalysis?.repoType || ''
    if (this.hfCategory === 'llm') return /gguf/.test(rt) ? 'gguf' : 'full-weights'
    if (this.hfCategory === 'tts') return 'tts-model'
    const map: Record<string, string> = {
      diffusers: 'diffusers', lora: 'lora', gguf: 'diffusion-model', 'gguf-llm': 'diffusion-model',
      vae: 'vae', 'text-encoder': 'text-encoder', unet: 'diffusion-model', safetensors: 'checkpoint',
    }
    return map[rt] || 'checkpoint'
  }
  /** Effective destination type sent to /hf/download: user dropdown override wins, else the default. */
  get hfDestType(): string { return this.hfDestTypeOverride || this.hfDefaultDestType }
  /** Selectable model-type options for the current category (each maps to a resolveSmartDest folder). */
  get hfDestTypeOptions(): Array<{ value: string; label: string }> {
    if (this.hfCategory === 'llm') return [
      { value: 'full-weights', label: 'Full weights \u2192 family folder' },
      { value: 'gguf', label: 'GGUF \u2192 family folder' },
      { value: 'lora', label: 'LoRA \u2192 loras/' },
    ]
    if (this.hfCategory === 'tts') return [
      { value: 'tts-model', label: 'TTS model' }, { value: 'rvc-model', label: 'RVC model' }, { value: 'whisper', label: 'Whisper' },
    ]
    return [
      { value: 'checkpoint', label: 'Checkpoint \u2192 checkpoints/' },
      { value: 'diffusion-model', label: 'Diffusion model / UNET \u2192 diffusion-models/' },
      { value: 'diffusers', label: 'Diffusers pipeline \u2192 diffusers/' },
      { value: 'lora', label: 'LoRA \u2192 loras/' },
      { value: 'vae', label: 'VAE \u2192 vae/' },
      { value: 'text-encoder', label: 'Text encoder \u2192 text-encoders/' },
      { value: 'controlnet', label: 'ControlNet \u2192 controlnet/' },
      { value: 'upscaler', label: 'Upscaler \u2192 upscale-models/' },
      { value: 'embedding', label: 'Embedding \u2192 embeddings/' },
    ]
  }
  get hfSelectedFiles(): HFFile[] {
    const a = this.hfAnalysis
    if (!a) return []
    const all: HFFile[] = [
      ...(a.ggufQuants ?? []),
      ...(a.weightFiles ?? []),
      ...Object.values(a.components ?? {}).flatMap((c) => c.files ?? []),
    ]
    const seen = new Set<string>()
    return all.filter((f) => this.hfSelected[f.path] && !seen.has(f.path) && seen.add(f.path))
  }
  async downloadHf(): Promise<void> {
    const files = this.hfSelectedFiles
    if (!files.length) return
    // The native /hf/download requires category + destType + subfolder all set, else it falls back
    // to the legacy /models/<family> path. Derive destType from the detected repo type.
    const subfolder = this.hfSuggestedSubfolder.trim() || this.hfAnalysis?.suggestedName || this.hfRepo.split('/').pop() || 'misc'
    this.busy = true
    try {
      await this.cluster().request('POST', '/api/ai/hf/download', {
        repo: this.hfRepo,
        revision: this.hfRevision,
        files,
        node: '_local',
        category: this.hfCategory,
        destType: this.hfDestType,
        subfolder,
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
  /** Variable Config popup: base models seen in history + their current $BASE_MODEL_LONG mapping. */
  async loadBaseModels(): Promise<Array<{ short: string; long: string }>> {
    try {
      const r = await this.cluster().request('GET', '/api/civitai/base-models')
      return Array.isArray(r) ? (r as any[]) : []
    } catch { return [] }
  }
  async saveBaseModelMap(map: Record<string, string>): Promise<void> {
    runInAction(() => { this.civConfig = { ...this.civConfig, baseModelMap: map } })
    await this.cluster().request('PUT', '/api/civitai/config', this.civConfig)
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
    if (m === 'renamer') void this.loadRenamer()
    if (m === 'review') void this.loadCivQueue(true)
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
    if (!ids.length) {
      runInAction(() => { this.civError = 'Nothing selected — tick one or more history rows first.' })
      return
    }
    // This used to be `.catch(() => undefined)`, so a rejected request (or a 4xx from the route)
    // produced no state change and no message: the button simply appeared to do nothing. Surface
    // the failure instead — a silently dropped error is a bug, not a tidy default.
    runInAction(() => { this.civError = null })
    try {
      const r = (await this.cluster().request('POST', path, {
        items: ids,
        modelIds: ids.map((x) => x.modelId),
      })) as any
      if (r && r.error) throw new Error(String(r.error))
      if (r && typeof r.added === 'number' && r.added === 0) {
        runInAction(() => { this.civError = `${path.split('/').pop()}: nothing was added (${ids.length} selected).` })
      }
    } catch (e) {
      runInAction(() => { this.civError = `${path.split('/').pop()} failed: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    await Promise.all([this.loadHistories(), this.loadDownloads()])
    if (path.includes('renamer')) {
      runInAction(() => { this.civMode = 'renamer' })
      await this.loadRenamer()
    }
  }

  // ── Download Scheduler ──
  async loadScheduler(): Promise<void> {
    const s = (await this.cluster().request('GET', '/api/civitai/download-scheduler').catch(() => null)) as any
    if (s) runInAction(() => { this.scheduler = s })
  }
  schedOf(source: 'hf' | 'civ'): { mode: string; manualState: string; schedule: boolean[][] } {
    const s = this.scheduler[source]
    return {
      mode: s?.mode || 'manual',
      manualState: s?.manualState || 'running',
      schedule: s?.schedule || Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => true)),
    }
  }
  schedAllowed(source: 'hf' | 'civ'): boolean {
    const s = this.schedOf(source)
    if (s.mode === 'manual') return s.manualState === 'running'
    const now = new Date()
    return !!s.schedule?.[now.getDay()]?.[now.getHours()]
  }
  async putScheduler(source: 'hf' | 'civ', patch: Record<string, any>): Promise<void> {
    const next = { ...this.scheduler, [source]: { ...this.schedOf(source), ...patch } }
    runInAction(() => { this.scheduler = next })
    await this.cluster().request('PUT', `/api/civitai/download-scheduler/${source}`, patch).catch(() => undefined)
  }
  toggleManual(source: 'hf' | 'civ'): void {
    void this.putScheduler(source, { manualState: this.schedOf(source).manualState === 'running' ? 'paused' : 'running' })
  }
  toggleAuto(source: 'hf' | 'civ'): void {
    void this.putScheduler(source, { mode: this.schedOf(source).mode === 'auto' ? 'manual' : 'auto' })
  }
  async saveSchedule(source: 'hf' | 'civ', schedule: boolean[][]): Promise<void> {
    await this.putScheduler(source, { schedule })
  }

  // ── Renamer queue ──
  async loadRenamer(): Promise<void> {
    this.renamerLoading = true
    try {
      const r = (await this.cluster().request('GET', '/api/civitai/renamer').catch(() => ({ items: [] }))) as any
      const items = (r?.items ?? []) as any[]
      runInAction(() => { this.renamerItems = items })
      // fetch details (located files + current dir) for the queued models, then resolve new paths
      const modelIds = [...new Set(items.map((i) => String(i.modelId)))]
      if (modelIds.length) {
        const det = (await this.cluster().request('POST', '/api/civitai/history/details', { modelIds }).catch(() => null)) as any
        const byId: Record<string, any> = {}
        const list = det?.items ?? det?.details ?? det ?? []
        for (const d of Array.isArray(list) ? list : Object.values(list || {})) {
          if (d && (d.modelId != null)) byId[String(d.modelId)] = d
        }
        runInAction(() => { this.renamerDetails = byId })
        await Promise.all(items.map((it) => this.resolveRenamerItem(it)))
      }
    } finally {
      runInAction(() => { this.renamerLoading = false })
    }
  }
  private async resolveRenamerItem(item: any): Promise<void> {
    const d = this.renamerDetails[String(item.modelId)]
    const located = d?.locatedFiles || []
    const currentDir = d?.currentDir || d?.targetDir || (located[0]?.path ? located[0].path.replace(/\/[^/]+$/, '') : '')
    if (!located.length) return
    try {
      const r = (await this.cluster().request('POST', '/api/civitai/resolve-paths', {
        modelId: String(item.modelId),
        versionId: String(item.versionId || ''),
        modelType: d?.modelType,
        modelName: d?.modelName,
        versionName: d?.versionName,
        baseModel: d?.baseModel,
        creatorName: d?.creator || '',
        files: located.map((f: any) => ({ name: f.name })),
      })) as any
      const newDir = r?.targetDir || ''
      const fileMap: Record<string, string> = {}
      for (const f of r?.files || []) fileMap[f.originalName] = f.newName
      const moves = located.map((f: any) => ({
        from: f.path || `${currentDir}/${f.name}`,
        to: `${newDir}/${fileMap[f.name] || f.name}`,
      }))
      runInAction(() => {
        this.renamerDetails[String(item.modelId)] = { ...d, currentDir, newDir, moves }
      })
    } catch {
      /* ignore */
    }
  }
  async applyRename(item: any): Promise<void> {
    const d = this.renamerDetails[String(item.modelId)]
    if (!d?.moves?.length) return
    await this.cluster().request('POST', '/api/civitai/rename', {
      modelId: String(item.modelId),
      versionId: String(item.versionId || ''),
      pathOverride: d.newDir,
      moves: d.moves,
      downloadMeta: true,
    }).catch((e: unknown) => { runInAction(() => { this.civError = e instanceof Error ? e.message : String(e) }) })
    await this.removeRenamer(item.id)
    await this.loadHistories()
  }
  async removeRenamer(id: string): Promise<void> {
    await this.cluster().request('DELETE', `/api/civitai/renamer/${encodeURIComponent(id)}`).catch(() => undefined)
    await this.loadRenamer()
  }
  async clearRenamer(): Promise<void> {
    await this.cluster().request('POST', '/api/civitai/renamer/clear', {}).catch(() => undefined)
    await this.loadRenamer()
  }
  async downloadCiv(): Promise<void> {
    const url = this.civUrl.trim()
    if (!url) return
    const parsed = this.parseModelId(url)
    if (!parsed) {
      runInAction(() => { this.civError = 'Paste a valid CivitAI model URL (…/models/<id>)' })
      return
    }
    this.busy = true
    this.civError = null
    try {
      const body: any = { modelId: parsed.modelId, pageUrl: url }
      if (parsed.versionId) body.versionId = parsed.versionId
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
  /** Version IDs of the loaded model already in the download history (so the UI can green them). */
  get ownedVersionIds(): Set<string> {
    const set = new Set<string>()
    const mid = String(this.civModel?.id ?? '')
    if (!mid) return set
    for (const h of this.civHistory) {
      if (String(h.modelId) !== mid) continue
      if (h.versionId) set.add(String(h.versionId))
      if (Array.isArray(h.downloadedVersions)) for (const v of h.downloadedVersions) set.add(String(v))
      // some history rows record the version only by name — match those too
      if (h.versionName) for (const ver of this.civVersions) if (ver.name === h.versionName) set.add(String(ver.id))
    }
    return set
  }
  isVersionOwned(vid: number | string): boolean {
    if (this.ownedVersionIds.has(String(vid))) return true
    const st = this.civVersionStatus[String(vid)]
    return !!(st && (st.allExist || st.inHistory))
  }
  /** On-disk presence state for a version pill: 'all' | 'partial' | 'history' | 'none'. */
  versionDiskState(vid: number | string): 'all' | 'partial' | 'history' | 'none' {
    const st = this.civVersionStatus[String(vid)]
    if (st?.allExist) return 'all'
    if (st?.someExist) return 'partial'
    if (st?.inHistory || this.ownedVersionIds.has(String(vid))) return 'history'
    return 'none'
  }
  /** Ask the native router which versions already exist on disk (checks /ai-assets via resolveTargetPath). */
  async checkVersionsOnDisk(): Promise<void> {
    const m = this.civModel
    if (!m?.id || !Array.isArray(m.modelVersions)) return
    try {
      const r = (await this.cluster().request('POST', '/api/civitai/check-existing', {
        modelId: String(m.id),
        modelType: m.type,
        modelName: m.name,
        versions: m.modelVersions.map((v: any) => ({ id: v.id, name: v.name, baseModel: v.baseModel, files: v.files || [] })),
      })) as any
      const result = r?.versions ?? r?.result ?? {}
      runInAction(() => { this.civVersionStatus = result })
    } catch {
      runInAction(() => { this.civVersionStatus = {} })
    }
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
        this.civVersionStatus = {}
        this.civMode = 'review'
        const versions = model?.modelVersions ?? []
        const v = (parsed.versionId && versions.find((x: any) => String(x.id) === parsed.versionId)) || versions[0]
        this.resetReviewVersionState()
        this.civSelVersionId = v?.id ?? null
        if (v) {
          this.civVerFiles.set(v.id, new Set((v.files ?? []).map((f: any) => String(f.id))))
          this.civVerSelected.add(v.id) // the version you land on starts ticked
        }
      })
      await this.resolveReviewPath()
      void this.checkVersionsOnDisk()
    } catch (e) {
      runInAction(() => { this.civModelError = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.civModelLoading = false })
    }
  }
  /** Clear all per-version review state. Called whenever a different model is loaded. */
  resetReviewVersionState(): void {
    this.civVerFolder.clear()
    this.civVerFilename.clear()
    this.civVerSeeded.clear()
    this.civVerSelected.clear()
    this.civVerFiles.clear()
    this.civFileOpts.clear()
  }

  /** View a version. Viewing is separate from selecting it for download (ProxLab: badge vs checkbox). */
  selectVersion(vid: number): void {
    this.civSelVersionId = vid
    const v = this.civCurrentVersion
    if (v && !this.civVerFiles.has(vid)) {
      this.civVerFiles.set(vid, new Set((v.files ?? []).map((f: any) => String(f.id))))
    }
    void this.resolveReviewPath()
  }

  // ── Version download selection ──
  isVersionSelected(vid: number): boolean {
    return this.civVerSelected.has(vid)
  }
  toggleVersionSelected(vid: number): void {
    if (this.civVerSelected.has(vid)) this.civVerSelected.delete(vid)
    else {
      this.civVerSelected.add(vid)
      const v = this.civVersions.find((x: any) => x.id === vid)
      if (v && !this.civVerFiles.has(vid)) {
        this.civVerFiles.set(vid, new Set((v.files ?? []).map((f: any) => String(f.id))))
      }
    }
  }
  get selectedVersionIds(): number[] {
    return this.civVersions.map((v: any) => v.id).filter((id: number) => this.civVerSelected.has(id))
  }

  // ── Per-version file selection ──
  filesForVersion(vid: number | null): Set<string> {
    if (vid == null) return new Set()
    let s = this.civVerFiles.get(vid)
    if (!s) { s = new Set(); this.civVerFiles.set(vid, s) }
    return s
  }
  isFileSelected(fileId: string | number): boolean {
    return this.filesForVersion(this.civSelVersionId).has(String(fileId))
  }

  // ── Per-version Folder / Filename boxes ──
  // Read the CURRENT version's value. Seeded from the resolver on first view, so the boxes show
  // what the template actually produces instead of sitting empty behind a placeholder.
  get curFolder(): string {
    return this.civSelVersionId == null ? '' : (this.civVerFolder.get(this.civSelVersionId) ?? '')
  }
  get curFilename(): string {
    return this.civSelVersionId == null ? '' : (this.civVerFilename.get(this.civSelVersionId) ?? '')
  }
  setCurFolder(v: string): void {
    if (this.civSelVersionId == null) return
    this.civVerFolder.set(this.civSelVersionId, v)
    this.resolveReviewPathLive()
  }
  setCurFilename(v: string): void {
    if (this.civSelVersionId == null) return
    this.civVerFilename.set(this.civSelVersionId, v)
    this.resolveReviewPathLive()
  }
  /** Review queue — items the browser extension's "Review" button POSTed to /queue/add. */
  async loadCivQueue(showCurrent = false): Promise<void> {
    const r = (await this.cluster().request('GET', '/api/civitai/queue').catch(() => null)) as any
    const items = Array.isArray(r) ? r : r?.items ?? []
    runInAction(() => {
      this.civQueue = items
      if (this.civQueueIndex >= items.length) this.civQueueIndex = Math.max(0, items.length - 1)
    })
    if (showCurrent && items.length) this.showQueueItem(this.civQueueIndex)
  }
  get currentQueueItem(): any | null {
    return this.civQueue[this.civQueueIndex] ?? null
  }
  /** Load the queue item at index into the Review browser (cached modelData, no re-fetch). */
  showQueueItem(index: number): void {
    const item = this.civQueue[index]
    if (!item) return
    runInAction(() => { this.civQueueIndex = index })
    const model = item.modelData
    if (!model) {
      this.civUrl = item.pageUrl || `https://civitai.com/models/${item.modelId}`
      void this.reviewLoad()
      return
    }
    runInAction(() => {
      this.civModel = model
      this.civVersionStatus = {}
      this.civQueueItemId = item.id
      this.resetReviewVersionState()
      const versions = model.modelVersions ?? []
      const v = (item.versionId && versions.find((x: any) => String(x.id) === String(item.versionId))) || versions[0]
      this.civSelVersionId = v?.id ?? null
      if (v) {
        this.civVerFiles.set(v.id, new Set((v.files ?? []).map((f: any) => String(f.id))))
        this.civVerSelected.add(v.id)
      }
    })
    void this.resolveReviewPath()
    void this.checkVersionsOnDisk()
  }
  /** Navigate the review queue (delta = -1 / +1). */
  queueNav(delta: number): void {
    if (!this.civQueue.length) return
    const next = Math.min(this.civQueue.length - 1, Math.max(0, this.civQueueIndex + delta))
    this.showQueueItem(next)
  }
  async removeFromQueue(id: string): Promise<void> {
    await this.cluster().request('DELETE', `/api/civitai/queue/${encodeURIComponent(id)}`).catch(() => undefined)
    if (this.civQueueItemId === id) runInAction(() => { this.civQueueItemId = null })
    await this.loadCivQueue()
    // advance to the item now occupying this slot (or the new last), else clear the browser
    if (this.civQueue.length) this.showQueueItem(Math.min(this.civQueueIndex, this.civQueue.length - 1))
    else runInAction(() => { this.civModel = null })
  }
  private optsFor(vid: number | null): Map<string, { noRename?: boolean; suffix?: string }> {
    if (vid == null) return new Map()
    let m = this.civFileOpts.get(vid)
    if (!m) { m = new Map(); this.civFileOpts.set(vid, m) }
    return m
  }
  fileOpt(fileId: string | number): { noRename?: boolean; suffix?: string } {
    return this.optsFor(this.civSelVersionId).get(String(fileId)) ?? {}
  }
  /** Ticked = the template renames this file (the default). Unticked = keep its own name. */
  isFileRenamed(fileId: string | number): boolean {
    return !this.fileOpt(fileId).noRename
  }
  toggleFileRename(fileId: string | number): void {
    const vid = this.civSelVersionId
    const m = this.optsFor(vid)
    const k = String(fileId)
    const cur = m.get(k) ?? {}
    m.set(k, { ...cur, noRename: !cur.noRename })
    if (vid != null) this.civFileOpts.set(vid, m)
    this.resolveReviewPathLive()
  }
  setFileSuffix(fileId: string | number, suffix: string): void {
    const vid = this.civSelVersionId
    const m = this.optsFor(vid)
    const k = String(fileId)
    m.set(k, { ...(m.get(k) ?? {}), suffix })
    if (vid != null) this.civFileOpts.set(vid, m)
    this.resolveReviewPathLive()
  }
  /** Plain object for the wire; omitted entirely when nothing is customised. */
  private fileOptsPayload(vid: number | null): Record<string, any> | undefined {
    const m = vid == null ? null : this.civFileOpts.get(vid)
    if (!m || !m.size) return undefined
    const out: Record<string, any> = {}
    for (const [k, v] of m) {
      const e: any = {}
      if (v.noRename) e.noRename = true
      if (v.suffix) e.suffix = v.suffix
      if (Object.keys(e).length) out[k] = e
    }
    return Object.keys(out).length ? out : undefined
  }
  toggleReviewFile(fileId: string | number): void {
    const s = this.filesForVersion(this.civSelVersionId)
    const k = String(fileId)
    s.has(k) ? s.delete(k) : s.add(k)
    // Map values are observed by reference; re-set so mobx sees the mutation.
    if (this.civSelVersionId != null) this.civVerFiles.set(this.civSelVersionId, s)
  }
  async resolveReviewPath(): Promise<void> {
    const m = this.civModel
    const v = this.civCurrentVersion
    if (!m || !v) return
    const vid: number = v.id
    const seeded = this.civVerSeeded.has(vid)
    try {
      const r = (await this.cluster().request('POST', '/api/civitai/resolve-paths', {
        modelId: String(m.id),
        versionId: String(vid),
        modelType: m.type,
        modelName: m.name,
        versionName: v.name,
        baseModel: v.baseModel,
        creatorName: m.creator?.username || '',
        primaryTag: (m.tags || [])[0] || '',
        tags: m.tags || [],
        files: (v.files || []).map((f: any) => ({ id: f.id, name: f.name, sizeKB: f.sizeKB, metadata: f.metadata })),
        fileOpts: this.fileOptsPayload(vid),
        // The preview must disambiguate over exactly the files that will be written.
        // Without this the server counted every file in the version, so ticking one of
        // three same-named files still looked like a collision and appended a file id.
        fileIds: Array.from(this.civVerFiles.get(vid) ?? []),
        // Send this version's own overrides. Before seeding, both are absent so the server
        // resolves purely from the template — that result is what we then seed the boxes with.
        pathOverride: seeded ? (this.civVerFolder.get(vid) ?? '') : undefined,
        fileNameOverride: seeded ? (this.civVerFilename.get(vid) || undefined) : undefined,
      })) as any
      runInAction(() => {
        this.civResolvedDir = r?.targetDir || ''
        this.civResolvedFiles = Array.isArray(r?.files) ? r.files : []
        if (!seeded) {
          // Pre-fill from what the template produced: folderPart is exactly what pathOverride
          // consumes, and the filename box holds the base name (the backend re-adds the extension).
          this.civVerFolder.set(vid, String(r?.folderPart ?? ''))
          // Seed from the template's UNDECORATED name, never from files[0].newName —
          // that one carries the auto-disambiguation tag, which would then be sent back
          // as fileNameOverride and could not be removed from the box.
          const seedName = String(r?.fileNameOverride || '')
            || String((r?.baseFileName ?? '')).replace(/\.[^.]+$/, '')
          this.civVerFilename.set(vid, seedName)
          this.civVerSeeded.add(vid)
        }
      })
    } catch {
      runInAction(() => { this.civResolvedDir = ''; this.civResolvedFiles = [] })
    }
  }
  private resolveTimer: ReturnType<typeof setTimeout> | null = null
  /** Live (debounced) re-resolve as the user types subfolder / filename overrides. */
  resolveReviewPathLive(): void {
    if (this.resolveTimer) clearTimeout(this.resolveTimer)
    this.resolveTimer = setTimeout(() => void this.resolveReviewPath(), 350)
  }
  resolvedNameFor(originalName: string): string {
    return this.civResolvedFiles.find((f) => f.originalName === originalName)?.newName || originalName
  }
  /** Preview name for ONE file, matched by id. Matching on originalName is wrong whenever
   *  a version ships several files under the same upstream name — every row would show
   *  the first match. Falls back to name matching for older payloads without ids. */
  resolvedNameForId(fileId: string | number | undefined, originalName: string): string {
    if (fileId != null) {
      const hit = this.civResolvedFiles.find((f: any) => String(f.fileId) === String(fileId))
      if (hit?.newName) return hit.newName
    }
    return this.resolvedNameFor(originalName)
  }
  /** Download every ticked version, each with ITS OWN folder/filename overrides. Falls back to the
   *  version being viewed if nothing is ticked, so the button is never a no-op. */
  async reviewDownload(): Promise<void> {
    const m = this.civModel
    if (!m) return
    const ids = this.selectedVersionIds.length
      ? this.selectedVersionIds
      : (this.civCurrentVersion ? [this.civCurrentVersion.id] : [])
    if (!ids.length) return
    this.busy = true
    this.civModelError = null
    try {
      const failures: string[] = []
      for (const vid of ids) {
        const ver = this.civVersions.find((x: any) => x.id === vid)
        const body: any = {
          modelId: String(m.id),
          versionId: String(vid),
          pageUrl: `https://civitai.com/models/${m.id}?modelVersionId=${vid}`,
        }
        const folder = this.civVerFolder.get(vid)
        const fname = this.civVerFilename.get(vid)
        if (folder !== undefined) body.pathOverride = folder
        if (fname) body.fileNameOverride = fname
        // Send the tick state. Until now the body carried only modelId/versionId, so the
        // checkboxes were decorative and the backend downloaded EVERY file in the version.
        // Omitted when nothing is explicitly deselected, so "download the lot" still works.
        const picked = this.civVerFiles.get(vid)
        const total = (this.civVersions.find((x: any) => x.id === vid)?.files ?? []).length
        if (picked && picked.size && picked.size < total) body.fileIds = [...picked]
        const opts = this.fileOptsPayload(vid)
        if (opts) body.fileOpts = opts
        try {
          await this.cluster().request('POST', '/api/civitai/download', body)
        } catch (e) {
          // One bad version must not abandon the rest of the batch.
          failures.push(`${ver?.name ?? vid}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (failures.length) throw new Error(`${failures.length}/${ids.length} failed — ${failures.join(' · ')}`)
      // if this came from the review queue, clear it out + advance to the next queued item
      const fromQueueId = this.civQueueItemId
      await Promise.all([this.loadDownloads(), this.loadHistories()])
      if (fromQueueId) {
        await this.removeFromQueue(fromQueueId)
      } else {
        runInAction(() => { this.subTab = 'queue' })
      }
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
