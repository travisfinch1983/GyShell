import { makeAutoObservable, runInAction } from 'mobx'

// Direct same-origin calls to the native imagegen router (binary thumb/image go straight through the
// Vite /api proxy → :17890, same as the TTS audio; JSON via the same base).
const BASE = '/api/imagegen'
export const igThumb = (rel: string, v?: number) => `${BASE}/thumb?path=${encodeURIComponent(rel)}${v ? `&v=${v}` : ''}`
export const igImage = (rel: string, bust?: number) => `${BASE}/image?path=${encodeURIComponent(rel)}${bust ? `&t=${bust}` : ''}`

async function ig(path: string, opts?: { method?: string; body?: any }): Promise<any> {
  const r = await fetch(BASE + path, {
    method: opts?.method || 'GET',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await r.text()
  // Parse AFTER checking ok, tolerantly: a proxy's HTML error page used to
  // surface as "Unexpected token '<'" — a JSON parser complaining about the
  // shape of a failure instead of the failure. The HTTP status is the fact.
  let data: any = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!r.ok) throw new Error(data?.error || `${r.status} ${r.statusText} — ${path}`)
  return data
}

export interface IgImage {
  name: string; rel: string; mtime: number; ctime: number; birthtime: number; size: number
  w: number; h: number; cropped: boolean; has_alt: boolean; has_caption: boolean; has_nl_caption: boolean
  score: number | null; comment: string
}
export interface IgFolder { name: string; n_images: number; n_subfolders: number; is_training_set: boolean; has_training_set: boolean; is_training_batch?: boolean }
export interface IgCrumb { name: string; path: string }

type SortKey = 'name' | 'created' | 'modified' | 'added' | 'size'

export class TrainingImagesStore {
  cwd = ''
  loading = false
  error = ''
  images: IgImage[] = []
  folders: IgFolder[] = []
  crumbs: IgCrumb[] = []
  inTrainingSet = false
  hasCollage = false
  collageFirst = ''
  sortKey: SortKey = (localStorage.getItem('aig-sort-key') as SortKey) || 'name'
  sortDir: 'asc' | 'desc' = (localStorage.getItem('aig-sort-dir') as 'asc' | 'desc') || 'asc'
  // selection
  selectionMode = false
  selected = new Set<string>()
  lastIndex: number | null = null
  msg = ''
  /** The API root is ALL of /ai-assets/imagegen — deliberately, so agents can reach their own
   *  ComfyUI outputs (see 4b33347). For a human curating training data that root is 81 folders
   *  of checkpoints, vae, controlnet and friends. This narrows the TOP LEVEL to the folders that
   *  actually hold training data; everything below the top level is untouched, and the toggle
   *  restores the full tree rather than hiding it. */
  showAllRoots = localStorage.getItem('aig-show-all-roots') === '1'
  /** Crop-status filter: trim the grid to what still NEEDS cropping, then page through
   *  just those in the editor. Persisted — a cropping session survives a reload. */
  cropFilter: 'all' | 'uncropped' | 'cropped' = (localStorage.getItem('aig-crop-filter') as any) || 'all'

  constructor() { makeAutoObservable(this) }

  /** Top-level folders that hold training data. Anything else at the root is model storage. */
  static readonly TRAINING_ROOTS = ['training', 'training_images']

  toggleShowAllRoots(): void {
    this.showAllRoots = !this.showAllRoots
    localStorage.setItem('aig-show-all-roots', this.showAllRoots ? '1' : '0')
    void this.browse(this.cwd)
  }

  /** True when the current view is the narrowed root — used to explain itself in the UI. */
  get atNarrowedRoot(): boolean { return this.cwd === '' && !this.showAllRoots }

  async browse(p = ''): Promise<void> {
    this.cwd = p || ''
    this.exitSelection()
    this.loading = true; this.error = ''
    try {
      const d = await ig(`/browse?path=${encodeURIComponent(this.cwd)}`)
      runInAction(() => {
        this.inTrainingSet = !!d.is_training_set
        this.hasCollage = !!d.has_collage
        this.collageFirst = d.collage_first || '_collage.jpg'
        this.crumbs = d.crumbs || []
        const roots = TrainingImagesStore.TRAINING_ROOTS
        this.folders = (this.cwd === '' && !this.showAllRoots)
          ? (d.folders || []).filter((f: any) => roots.includes(f.name))
          : (d.folders || [])
        const prefix = d.path ? d.path + '/' : ''
        // Loose files at the imagegen root are strays, not training data — hide them with the
        // folders rather than leaving one orphan image to imply this is a real image directory.
        this.images = ((this.cwd === '' && !this.showAllRoots) ? [] : (d.images || [])).map((im: any) => ({
          name: im.name, rel: prefix + im.name, mtime: im.mtime || 0, ctime: im.ctime || 0,
          birthtime: im.birthtime || 0, size: im.size || 0, w: im.w || 0, h: im.h || 0,
          cropped: !!im.cropped, has_alt: !!im.has_alt, has_caption: !!im.has_caption,
          has_nl_caption: !!im.has_nl_caption, score: im.score != null ? im.score : null, comment: im.comment || '',
        }))
        this.sortImages()
        this.loading = false
      })
    } catch (e: any) {
      runInAction(() => { this.error = e?.message || String(e); this.loading = false })
    }
  }

  setSort(key: SortKey) { this.sortKey = key; localStorage.setItem('aig-sort-key', key); this.sortImages() }
  toggleDir() { this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc'; localStorage.setItem('aig-sort-dir', this.sortDir); this.sortImages() }
  sortImages() {
    const dir = this.sortDir === 'desc' ? -1 : 1
    const cmp: Record<SortKey, (a: IgImage, b: IgImage) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      created: (a, b) => (a.birthtime || 0) - (b.birthtime || 0),
      modified: (a, b) => (a.mtime || 0) - (b.mtime || 0),
      added: (a, b) => (a.ctime || 0) - (b.ctime || 0),
      size: (a, b) => (a.size || 0) - (b.size || 0),
    }
    const f = cmp[this.sortKey]
    this.images = this.images.slice().sort((a, b) => {
      const c = f(a, b) * dir
      return c || a.name.localeCompare(b.name, undefined, { numeric: true })
    })
  }

  // ── selection ──
  setCropFilter(f: 'all' | 'uncropped' | 'cropped') {
    this.cropFilter = f
    localStorage.setItem('aig-crop-filter', f)
    // Selection indices are positions in the VISIBLE list; a filter change re-numbers
    // them, so a kept selection would silently point at different images.
    this.exitSelection()
  }

  /** What the grid shows and the editor pages through. All index-based selection ops
   *  (toggleOne/selectRange) are positions in THIS list, never in the raw one. */
  get visibleImages(): IgImage[] {
    if (this.cropFilter === 'all') return this.images
    return this.images.filter((im) => (this.cropFilter === 'cropped' ? im.cropped : !im.cropped))
  }

  enterSelection() { this.selectionMode = true }
  exitSelection() { this.selectionMode = false; this.lastIndex = null; this.selected.clear() }
  toggleOne(i: number) {
    const name = this.visibleImages[i].name
    if (this.selected.has(name)) this.selected.delete(name); else this.selected.add(name)
    this.selected = new Set(this.selected)
    if (!this.selected.size) this.exitSelection()
  }
  selectRange(a: number, b: number) {
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    for (let i = lo; i <= hi; i++) this.selected.add(this.visibleImages[i].name)
    this.selected = new Set(this.selected); this.lastIndex = b
  }
  selectAll() { this.visibleImages.forEach((im) => this.selected.add(im.name)); this.selected = new Set(this.selected) }

  // ── actions ──
  async sendToTrainingSet(suffix: string): Promise<any> {
    const files = [...this.selected]
    return ig('/send-to-training-set', { method: 'POST', body: { path: this.cwd, files, suffix } })
  }
  /** Batch rename to <base>-1..N. Order = display order; sidecars + ratings travel. */
  async renameFiles(files: string[], base: string): Promise<any> {
    return ig('/rename-files', { method: 'POST', body: { path: this.cwd, files, base } })
  }

  async deleteFiles(files: string[]): Promise<any> {
    return ig('/delete', { method: 'POST', body: { path: this.cwd, files } })
  }

  async deleteSelected(): Promise<any> {
    return this.deleteFiles([...this.selected])
  }
  async transfer(op: 'move' | 'copy', dest: string, files: string[]): Promise<any> {
    return ig('/transfer', { method: 'POST', body: { op, src: this.cwd, dest, files } })
  }
  async renameSet(path: string, suffix: string): Promise<any> { return ig('/rename-set', { method: 'POST', body: { path, suffix } }) }
  async genCollage(): Promise<any> { return ig('/collage', { method: 'POST', body: { path: this.cwd } }) }
  async stripTags(files?: string[]): Promise<any> {
    const body: any = { path: this.cwd }; if (files && files.length) body.files = files
    return ig('/strip-tags', { method: 'POST', body })
  }
  /** Wipe all ratings + comments (the whole _ratings.json) for this folder/set, or just the named files. */
  async wipeRatings(files?: string[]): Promise<any> {
    const body: any = { path: this.cwd }; if (files && files.length) body.files = files
    return ig('/wipe-ratings', { method: 'POST', body })
  }
  /** Count of images in the current view that carry a rating/comment. */
  get ratedCount(): number { return this.images.filter((im) => im.score != null || (im.comment || '').trim()).length }
  async listTrainingSets(): Promise<any> { return ig('/training-sets') }
  async listTrainingBatches(): Promise<any> { return ig('/training-batches') }
  /** Additive: copies the images + their .txt/.caption sidecars into the batch. */
  async batchAdd(batch: string, files: string[], create = false): Promise<any> {
    return ig('/batch-add', { method: 'POST', body: { path: this.cwd, files, batch, create } })
  }
  async merge(name: string, sources: string[]): Promise<any> { return ig('/merge', { method: 'POST', body: { name, sources } }) }
  async browseRaw(p: string): Promise<any> { return ig(`/browse?path=${encodeURIComponent(p)}`) }

  // ── crop editor + captions + ratings + auto-caption (phase 2c) ──
  async getCaption(rel: string, ext: 'txt' | 'caption'): Promise<any> { return ig(`/caption?path=${encodeURIComponent(rel)}&ext=${ext}`) }
  async setCaption(rel: string, caption: string, ext: 'txt' | 'caption'): Promise<any> { return ig('/caption', { method: 'POST', body: { path: rel, caption, ext } }) }
  async setRating(file: string, score: number, comment: string): Promise<any> { return ig('/rating', { method: 'POST', body: { path: this.cwd, file, score, comment } }) }
  async crop(body: any): Promise<any> { return ig('/crop', { method: 'POST', body }) }
  async resetCrop(rel: string): Promise<any> { return ig('/reset-crop', { method: 'POST', body: { path: rel } }) }
  async upscale(rel: string): Promise<any> { return ig('/upscale', { method: 'POST', body: { path: rel } }) }
  async upscaleStatus(jobId: string): Promise<any> { return ig(`/upscale-status?jobId=${jobId}`) }
  async swapUpscale(rel: string): Promise<any> { return ig('/swap-upscale', { method: 'POST', body: { path: rel } }) }
  /** Blanket add/remove the same tags across a whole folder (or a selection) in ONE call.
   *  `position` defaults to 'start' because kohya reads the leading token as the trigger word,
   *  so a blanket trigger has to prepend. Per-image POST /tags would be 650+ round-trips. */
  async tagsBatch(body: { add?: string[]; remove?: string[]; files?: string[]; position?: 'start' | 'end' }): Promise<any> {
    return ig('/tags-batch', { method: 'POST', body: { path: this.cwd, ...body } })
  }
  async taggers(): Promise<any> { return ig('/taggers') }
  async autoCaption(body: any): Promise<any> { return ig('/auto-caption', { method: 'POST', body }) }
  async autoCaptionStatus(jobId: string): Promise<any> { return ig(`/auto-caption-status?jobId=${jobId}`) }

  // ── live auto-caption job, tracked HERE so the modal can close the moment the job starts.
  // Progress used to live only inside the greyed-out popup: closing it to keep working meant
  // flying blind until the GPUs went quiet. The browser page renders this as a progress bar.
  captionJob: { jobId: string; label: string; state: 'running' | 'done' | 'failed' | 'lost'
                total: number; done: number; wrote: number; skipped: number; errors: number
                provider?: string; error?: string } | null = null
  private capTimer: ReturnType<typeof setInterval> | null = null
  trackCaptionJob(jobId: string, label: string): void {
    if (this.capTimer) { clearInterval(this.capTimer); this.capTimer = null }
    this.captionJob = { jobId, label, state: 'running', total: 0, done: 0, wrote: 0, skipped: 0, errors: 0 }
    let failures = 0
    this.capTimer = setInterval(async () => {
      let s: any
      try { s = await this.autoCaptionStatus(jobId); failures = 0 } catch {
        // Same cap as the old modal poll: a dead status endpoint must not leave a
        // "running" bar on screen forever — but it is reported as LOST, not done.
        if (++failures >= 15 && this.capTimer) {
          clearInterval(this.capTimer); this.capTimer = null
          runInAction(() => {
            if (this.captionJob?.jobId === jobId) {
              this.captionJob.state = 'lost'
              this.captionJob.error = 'status endpoint unreachable — the job may still finish server-side; refresh to see results'
            }
          })
        }
        return
      }
      runInAction(() => {
        if (this.captionJob?.jobId !== jobId) return
        Object.assign(this.captionJob, {
          total: s.total || 0, done: s.done || 0, wrote: s.wrote || 0,
          skipped: s.skipped || 0, errors: s.errors || 0, provider: s.provider,
        })
        if (s.state !== 'running' && this.capTimer) {
          clearInterval(this.capTimer); this.capTimer = null
          this.captionJob.state = s.state === 'done' ? 'done' : 'failed'
          if (s.state !== 'done') this.captionJob.error = s.error || s.lastError || 'unknown'
          void this.browse(this.cwd)   // sidecar badges refresh without a manual reload
        }
      })
    }, 2000)
  }
  /** Hide the bar. A still-running job keeps running server-side — this only stops watching. */
  dismissCaptionJob(): void {
    if (this.capTimer) { clearInterval(this.capTimer); this.capTimer = null }
    this.captionJob = null
  }
}

export const trainingImagesStore = new TrainingImagesStore()
export { ig as igCall }
