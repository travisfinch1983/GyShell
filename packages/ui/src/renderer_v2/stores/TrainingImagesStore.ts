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
  /** Subsection folder this image lives in ('' = the browsed folder itself). */
  dir?: string
}

/** Selection key: the same filename can exist in two subsections, so bare names collide. */
export interface CorrectCaptionsBody {
  /** what to fix, e.g. "every image here is a CUTE bulge; fix any that say large or huge" */
  instruction: string
  /** catalog id from llmCatalog() */
  model: string
  /** default ['caption'] — only sidecars that already exist are touched */
  exts?: Array<'txt' | 'caption'>
  files?: string[]
  /** propose only; writes nothing. Still a real job, so progress and samples stream in. */
  dry_run?: boolean
  /** 0 / omitted = every sidecar in scope */
  max_files?: number
}
export interface CatalogModel { id: string; displayName?: string; tag?: string; kind?: string }

export interface FindReplaceBody {
  find: string
  replace: string
  /** which sidecars to touch; default both */
  exts?: Array<'txt' | 'caption'>
  /** .txt only — match a whole comma token rather than a substring. Ignored for .caption,
   *  which is prose and has no token boundaries. */
  whole_tag?: boolean
  case_sensitive?: boolean
  dry_run?: boolean
  files?: string[]
}
export interface FindReplaceSample { file: string; ext: string; before: string; after: string }
export interface FindReplaceResult {
  ok: boolean
  dry_run: boolean
  files_scanned: number
  files_changed: number
  occurrences: number
  samples: FindReplaceSample[]
  errors: string[]
}

export const imKey = (im: Pick<IgImage, 'name' | 'dir'>): string => (im.dir ? `${im.dir}/${im.name}` : im.name)

export interface BatchSection {
  folder: string; concept: string; repeats: number; count: number
  hasCollage: boolean; collageFirst: string
}
export interface IgFolder { name: string; n_images: number; n_subfolders: number; is_training_set: boolean; has_training_set: boolean; is_training_batch?: boolean; is_batch_subsection?: boolean; repeats?: number; concept?: string }
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
  /** Subsections of the browsed training batch (their images are inlined into `images`). */
  sections: BatchSection[] = []
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
  // _batches: UI-assembled training batches land here (the Add-to-batch modal's
  // new-batch path) — without it a batch created there was unreachable in the
  // default narrowed view (Travis, 2026-09-02).
  static readonly TRAINING_ROOTS = ['training', 'training_images', '_batches']

  toggleShowAllRoots(): void {
    this.showAllRoots = !this.showAllRoots
    localStorage.setItem('aig-show-all-roots', this.showAllRoots ? '1' : '0')
    void this.browse(this.cwd)
  }

  /** True when the current view is the narrowed root — used to explain itself in the UI. */
  get atNarrowedRoot(): boolean { return this.cwd === '' && !this.showAllRoots }

  async browse(p = ''): Promise<void> {
    const next = p || ''
    // A FOLDER CHANGE invalidates the selection outright -- different images. A REFRESH of
    // the folder already open does not: `selected` is keyed by imKey(), not by index, so
    // every key survives a reload. Clearing unconditionally meant any onChanged() from the
    // crop editor wiped a curation pile mid-flight; the reconcile after the load below
    // handles the only thing a refresh can actually invalidate (an image that went away).
    if (next !== this.cwd) this.exitSelection()
    this.cwd = next
    this.loading = true; this.error = ''
    try {
      const d = await ig(`/browse?path=${encodeURIComponent(this.cwd)}`)
      // A training batch renders as ONE page: each subsection's browse is fetched and its
      // images inlined under a divider — sidecar flags and ratings come from the
      // subsection's own browse, so they are as correct as a direct visit.
      const parts0 = (this.cwd || '').split('/').filter(Boolean)
      const lastSeg = parts0[parts0.length - 1] || ''
      const isBatchRoot = lastSeg === 'training_batch' || lastSeg.startsWith('training_batch_')
      let subPayloads: Array<{ f: any; sd: any }> = []
      if (isBatchRoot) {
        const subs = (d.folders || []).filter((f: any) => f.is_batch_subsection)
        subPayloads = (await Promise.all(subs.map(async (f: any) => {
          try { return { f, sd: await ig(`/browse?path=${encodeURIComponent(this.cwd + '/' + f.name)}`) } }
          catch { return null }   // one unreadable subsection must not blank the whole batch
        }))).filter(Boolean) as Array<{ f: any; sd: any }>
      }
      runInAction(() => {
        this.inTrainingSet = !!d.is_training_set
        this.hasCollage = !!d.has_collage
        this.collageFirst = d.collage_first || '_collage.jpg'
        this.crumbs = d.crumbs || []
        const roots = TrainingImagesStore.TRAINING_ROOTS
        this.folders = (this.cwd === '' && !this.showAllRoots)
          ? (d.folders || []).filter((f: any) => roots.includes(f.name))
          : (d.folders || [])
        if (isBatchRoot) this.folders = this.folders.filter((f: any) => !f.is_batch_subsection)
        const prefix = d.path ? d.path + '/' : ''
        const mapIm = (pre: string, sub: string) => (im: any): IgImage => ({
          name: im.name, rel: pre + im.name, mtime: im.mtime || 0, ctime: im.ctime || 0,
          birthtime: im.birthtime || 0, size: im.size || 0, w: im.w || 0, h: im.h || 0,
          cropped: !!im.cropped, has_alt: !!im.has_alt, has_caption: !!im.has_caption,
          has_nl_caption: !!im.has_nl_caption, score: im.score != null ? im.score : null,
          comment: im.comment || '', dir: sub,
        })
        // Loose files at the imagegen root are strays, not training data — hide them with the
        // folders rather than leaving one orphan image to imply this is a real image directory.
        this.images = ((this.cwd === '' && !this.showAllRoots) ? [] : (d.images || [])).map(mapIm(prefix, ''))
        const sections: BatchSection[] = []
        for (const { f, sd } of subPayloads) {
          const spre = sd.path ? sd.path + '/' : ''
          sections.push({ folder: f.name, concept: f.concept || f.name, repeats: f.repeats || 0,
                          count: (sd.images || []).length, hasCollage: !!sd.has_collage,
                          collageFirst: sd.collage_first || '_collage.jpg' })
          this.images.push(...(sd.images || []).map(mapIm(spre, f.name)))
        }
        this.sections = sections
        this.sortImages()
        // Reconcile a selection carried across a same-folder refresh: drop keys whose image
        // is no longer here (deleted, moved out, hidden by a root narrowing). lastIndex is a
        // position in visibleImages and cannot survive a reload -- a stale one would anchor a
        // shift-range at the wrong image -- so it always resets.
        if (this.selected.size) {
          const live = new Set(this.images.map(imKey))
          const kept = new Set([...this.selected].filter((k) => live.has(k)))
          if (kept.size !== this.selected.size) this.selected = kept
          this.lastIndex = null
          if (!this.selected.size) this.selectionMode = false
        }
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
    // Section-stable: images sort WITHIN their subsection; sections keep their listed
    // order — a date sort must never interleave 20_blue into 5_red.
    const rank = new Map<string, number>([['', 0]])
    this.sections.forEach((s, ix) => rank.set(s.folder, ix + 1))
    this.images = this.images.slice().sort((a, b) => {
      const r = (rank.get(a.dir || '') ?? 0) - (rank.get(b.dir || '') ?? 0)
      if (r) return r
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
    const name = imKey(this.visibleImages[i])
    if (this.selected.has(name)) this.selected.delete(name); else this.selected.add(name)
    this.selected = new Set(this.selected)
    if (!this.selected.size) this.exitSelection()
  }
  selectRange(a: number, b: number) {
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    for (let i = lo; i <= hi; i++) this.selected.add(imKey(this.visibleImages[i]))
    this.selected = new Set(this.selected); this.lastIndex = b
  }
  selectAll() { this.visibleImages.forEach((im) => this.selected.add(imKey(im))); this.selected = new Set(this.selected) }
  /** Empty the selection but STAY in selection mode (Clear/X is the exit). */
  deselectAll() { this.selected = new Set(); this.lastIndex = null }

  // ── actions ──
  async sendToTrainingSet(suffix: string): Promise<any> {
    const files = [...this.selected]
    return ig('/send-to-training-set', { method: 'POST', body: { path: this.cwd, files, suffix } })
  }
  /** cwd's training-batch context: the batch root when cwd IS a batch or a kohya
   *  <repeats>_<concept> subsection inside one; null anywhere else. */
  get batchContext(): { root: string; inSubsection: boolean } | null {
    const parts = this.cwd.split('/').filter(Boolean)
    const last = parts[parts.length - 1] || ''
    const isBatch = (n: string) => n === 'training_batch' || n.startsWith('training_batch_')
    if (isBatch(last)) return { root: this.cwd, inSubsection: false }
    if (/^\d+_.+/.test(last) && parts.length >= 2 && isBatch(parts[parts.length - 2])) {
      return { root: parts.slice(0, -1).join('/'), inSubsection: true }
    }
    return null
  }

  /** Selection KEYS ('20_blue/img.png' | 'img.png') grouped per subsection. Every bulk
   *  action fans out through this: one backend call per directory, so the per-folder
   *  contracts (ratings files, name guards) stay untouched. */
  splitKeys(keys: string[]): Array<{ sub: string; names: string[] }> {
    const valid = new Set(this.sections.map((s) => s.folder))
    const gs = new Map<string, string[]>()
    for (const k of keys) {
      const cut = k.indexOf('/')
      const sub = cut > 0 && valid.has(k.slice(0, cut)) ? k.slice(0, cut) : ''
      const name = sub ? k.slice(cut + 1) : k
      const g = gs.get(sub) || []
      g.push(name)
      gs.set(sub, g)
    }
    return [...gs].map(([sub, names]) => ({ sub, names }))
  }

  async deleteKeys(keys: string[]): Promise<{ deleted: number }> {
    let deleted = 0
    for (const g of this.splitKeys(keys)) deleted += (await this.deleteFiles(g.names, g.sub)).deleted || 0
    return { deleted }
  }

  async stripKeys(keys: string[]): Promise<{ removed: number }> {
    let removed = 0
    for (const g of this.splitKeys(keys)) removed += (await this.stripTags(g.names, g.sub)).removed || 0
    return { removed }
  }

  async wipeKeys(keys: string[]): Promise<{ cleared: number }> {
    let cleared = 0
    for (const g of this.splitKeys(keys)) cleared += (await this.wipeRatings(g.names, g.sub)).cleared || 0
    return { cleared }
  }

  /** Numbering restarts per subsection — names only need uniqueness per folder. */
  async renameKeys(keys: string[], base: string): Promise<{ renamed: number; ratings_moved: number; groups: number }> {
    const gs = this.splitKeys(keys)
    let renamed = 0, ratings = 0
    for (const g of gs) {
      const r = await this.renameFiles(g.names, base, g.sub)
      renamed += (r.renamed || []).length; ratings += r.ratings_moved || 0
    }
    return { renamed, ratings_moved: ratings, groups: gs.length }
  }

  async transferKeys(op: 'move' | 'copy', dest: string, keys: string[]): Promise<{ done: number; dest: string }> {
    let done = 0; let d = dest
    for (const g of this.splitKeys(keys)) { const r = await this.transfer(op, dest, g.names, g.sub); done += r.done || 0; d = r.dest || d }
    return { done, dest: d }
  }

  async batchAddKeys(batch: string, keys: string[], create = false): Promise<any> {
    const out: any = { copied: 0, replaced: 0, missing_tags: [], not_found: [], batch }
    let first = create
    for (const g of this.splitKeys(keys)) {
      const r = await this.batchAdd(batch, g.names, first, g.sub)
      first = false   // created on the first group; the rest append
      out.copied += r.copied || 0; out.replaced += r.replaced || 0
      out.missing_tags.push(...(r.missing_tags || [])); out.not_found.push(...(r.not_found || []))
      out.batch = r.batch || out.batch
    }
    return out
  }

  async subsectionKeys(keys: string[], name: string, repeats: number): Promise<{ moved: number; subsection: string; reused: boolean }> {
    let moved = 0; let subsection = ''; let reused = false
    for (const g of this.splitKeys(keys)) {
      const r = await this.subsection(g.names, name, repeats, g.sub)
      moved += r.moved || 0; subsection = r.subsection || subsection; reused = reused || !!r.reused
    }
    return { moved, subsection, reused }
  }

  async tagsBatchKeys(body: { add?: string[]; remove?: string[]; position?: 'start' | 'after_trigger' | 'end'; exts?: Array<'txt' | 'caption'> }, keys: string[]): Promise<{ changed: number; unchanged: number; cleared: number; errors: string[] }> {
    const out = { changed: 0, unchanged: 0, cleared: 0, errors: [] as string[] }
    for (const g of this.splitKeys(keys)) {
      const r = await this.tagsBatch({ ...body, files: g.names }, g.sub)
      out.changed += r.changed || 0; out.unchanged += r.unchanged || 0
      out.cleared += r.cleared || 0; out.errors.push(...(r.errors || []))
    }
    return out
  }

  /** cwd, or a subsection under it. */
  dirPath(sub = ''): string { return sub ? `${this.cwd}/${sub}` : this.cwd }

  /** Move selected images into a <repeats>_<concept> subsection of the current batch. */
  async subsection(files: string[], name: string, repeats: number, sub = ''): Promise<any> {
    return ig('/subsection', { method: 'POST', body: { path: this.dirPath(sub), files, name, repeats } })
  }

  async setSubsectionRepeats(rel: string, repeats: number): Promise<any> {
    return ig('/subsection-repeats', { method: 'POST', body: { path: rel, repeats } })
  }

  /** Batch rename to <base>-1..N. Order = display order; sidecars + ratings travel. */
  async renameFiles(files: string[], base: string, sub = ''): Promise<any> {
    return ig('/rename-files', { method: 'POST', body: { path: this.dirPath(sub), files, base } })
  }

  async deleteFiles(files: string[], sub = ''): Promise<any> {
    return ig('/delete', { method: 'POST', body: { path: this.dirPath(sub), files } })
  }

  async deleteSelected(): Promise<any> {
    return this.deleteKeys([...this.selected])
  }
  async transfer(op: 'move' | 'copy', dest: string, files: string[], sub = ''): Promise<any> {
    return ig('/transfer', { method: 'POST', body: { op, src: this.dirPath(sub), dest, files } })
  }
  async renameSet(path: string, suffix: string): Promise<any> { return ig('/rename-set', { method: 'POST', body: { path, suffix } }) }
  async genCollage(sub = ''): Promise<any> { return ig('/collage', { method: 'POST', body: { path: this.dirPath(sub) } }) }
  async stripTags(files?: string[], sub = ''): Promise<any> {
    const body: any = { path: this.dirPath(sub) }; if (files && files.length) body.files = files
    return ig('/strip-tags', { method: 'POST', body })
  }
  /** Wipe all ratings + comments (the whole _ratings.json) for this folder/set, or just the named files. */
  async wipeRatings(files?: string[], sub = ''): Promise<any> {
    const body: any = { path: this.dirPath(sub) }; if (files && files.length) body.files = files
    return ig('/wipe-ratings', { method: 'POST', body })
  }
  /** Count of images in the current view that carry a rating/comment. */
  get ratedCount(): number { return this.images.filter((im) => im.score != null || (im.comment || '').trim()).length }
  async listTrainingSets(): Promise<any> { return ig('/training-sets') }
  async listTrainingBatches(): Promise<any> { return ig('/training-batches') }
  /** Additive: copies the images + their .txt/.caption sidecars into the batch. */
  async batchAdd(batch: string, files: string[], create = false, sub = ''): Promise<any> {
    return ig('/batch-add', { method: 'POST', body: { path: this.dirPath(sub), files, batch, create } })
  }
  async merge(name: string, sources: string[]): Promise<any> { return ig('/merge', { method: 'POST', body: { name, sources } }) }
  async browseRaw(p: string): Promise<any> { return ig(`/browse?path=${encodeURIComponent(p)}`) }

  // ── crop editor + captions + ratings + auto-caption (phase 2c) ──
  async getCaption(rel: string, ext: 'txt' | 'caption'): Promise<any> { return ig(`/caption?path=${encodeURIComponent(rel)}&ext=${ext}`) }
  async setCaption(rel: string, caption: string, ext: 'txt' | 'caption'): Promise<any> { return ig('/caption', { method: 'POST', body: { path: rel, caption, ext } }) }
  /** Takes the image's FULL rel path — a subsection image's rating must land in that
   *  subsection's _ratings.json, not the batch root's. */
  async setRating(fileRel: string, score: number, comment: string): Promise<any> {
    const cut = fileRel.lastIndexOf('/')
    const body = { path: cut >= 0 ? fileRel.slice(0, cut) : '', file: cut >= 0 ? fileRel.slice(cut + 1) : fileRel, score, comment }
    return ig('/rating', { method: 'POST', body })
  }
  async crop(body: any): Promise<any> { return ig('/crop', { method: 'POST', body }) }
  async resetCrop(rel: string): Promise<any> { return ig('/reset-crop', { method: 'POST', body: { path: rel } }) }
  async upscale(rel: string): Promise<any> { return ig('/upscale', { method: 'POST', body: { path: rel } }) }
  async upscaleStatus(jobId: string): Promise<any> { return ig(`/upscale-status?jobId=${jobId}`) }
  async swapUpscale(rel: string): Promise<any> { return ig('/swap-upscale', { method: 'POST', body: { path: rel } }) }
  /** Blanket add/remove the same tags across a whole folder (or a selection) in ONE call.
   *  `position` defaults to 'start' because kohya reads the leading token as the trigger word,
   *  so a blanket trigger has to prepend. Per-image POST /tags would be 650+ round-trips. */
  async tagsBatch(body: { add?: string[]; remove?: string[]; files?: string[]; position?: 'start' | 'after_trigger' | 'end'; exts?: Array<'txt' | 'caption'> }, sub = ''): Promise<any> {
    return ig('/tags-batch', { method: 'POST', body: { path: this.dirPath(sub), ...body } })
  }

  /** Literal find & replace across .txt and/or .caption sidecars.
   *  `dry_run` writes nothing and returns counts plus a few before/after pairs — a preview
   *  reporting only "142 occurrences" is a number the user has to take on faith, and
   *  substring mode is exactly where a match can land somewhere nobody intended. */
  async findReplace(body: FindReplaceBody, sub = ''): Promise<FindReplaceResult> {
    return ig('/caption-replace', { method: 'POST', body: { path: this.dirPath(sub), ...body } })
  }

  /** Same, for a selection that may span subsections. Counts sum; samples come from the
   *  first subfolders that produced any, capped so a big selection cannot flood the modal. */
  async findReplaceKeys(body: FindReplaceBody, keys: string[]): Promise<FindReplaceResult> {
    const out: FindReplaceResult = { ok: true, dry_run: !!body.dry_run, files_scanned: 0,
                                     files_changed: 0, occurrences: 0, samples: [], errors: [] }
    for (const g of this.splitKeys(keys)) {
      const r = await this.findReplace({ ...body, files: g.names }, g.sub)
      out.files_scanned += r.files_scanned || 0
      out.files_changed += r.files_changed || 0
      out.occurrences += r.occurrences || 0
      out.errors.push(...(r.errors || []))
      for (const sm of r.samples || []) if (out.samples.length < 5) out.samples.push(sm)
    }
    return out
  }
  /** Model-based caption correction. Returns a jobId tracked by the SAME machinery as
   *  auto-caption — trackCaptionJob(jobId, label) and /auto-caption-status both work
   *  unchanged, so a correction and a caption run can be in flight together. */
  async correctCaptions(body: CorrectCaptionsBody, sub = ''): Promise<{ jobId: string }> {
    return ig('/caption-correct', { method: 'POST', body: { path: this.dirPath(sub), ...body } })
  }

  /** TEXT models from the LLM proxy catalog — NOT the tagger list, which is a different
   *  pipeline entirely (ONNX/BLIP/VLM on the GPU host). */
  async llmCatalog(): Promise<CatalogModel[]> {
    const r = await fetch('/api/proxy/llm/catalog')
    if (!r.ok) throw new Error(`catalog: HTTP ${r.status}`)
    const d = await r.json()
    return (d?.data || []) as CatalogModel[]
  }

  async taggers(): Promise<any> { return ig('/taggers') }
  async autoCaption(body: any): Promise<any> { return ig('/auto-caption', { method: 'POST', body }) }
  async autoCaptionStatus(jobId: string): Promise<any> { return ig(`/auto-caption-status?jobId=${jobId}`) }

  // ── live auto-caption job, tracked HERE so the modal can close the moment the job starts.
  // Progress used to live only inside the greyed-out popup: closing it to keep working meant
  // flying blind until the GPUs went quiet. The browser page renders this as a progress bar.
  // EVERY tracked job, not just the newest. Travis captions several folders at once and
  // watches the badges fill in across them; the old single-object + single-timer version
  // abandoned each previous job the moment the next one started, so only the LAST job's
  // completion refreshed the grid. (The jobs themselves were always fine, and the bell's
  // Task Progress rows were always correct — imagegen.js reports each one independently.
  // What was lost was purely the client-side "and now re-read the folder" step.)
  captionJobs: Array<{ jobId: string; label: string; state: 'running' | 'done' | 'failed' | 'lost'
                       total: number; done: number; wrote: number; skipped: number; errors: number
                       provider?: string; error?: string }> = []
  /** Bumped whenever ANY tracked job finishes, so consumers can react without knowing which. */
  captionDoneTick = 0
  private capTimers = new Map<string, ReturnType<typeof setInterval>>()

  get captionRunning(): number { return this.captionJobs.filter((j) => j.state === 'running').length }

  private clearCapTimer(jobId: string): void {
    const t = this.capTimers.get(jobId)
    if (t) { clearInterval(t); this.capTimers.delete(jobId) }
  }

  trackCaptionJob(jobId: string, label: string): void {
    if (this.capTimers.has(jobId)) return          // already watching this one
    this.captionJobs.push({ jobId, label, state: 'running', total: 0, done: 0, wrote: 0, skipped: 0, errors: 0 })
    let failures = 0
    this.capTimers.set(jobId, setInterval(async () => {
      let s: any
      try { s = await this.autoCaptionStatus(jobId); failures = 0 } catch {
        // A dead status endpoint must not leave a job "running" forever — but it is
        // reported as LOST, not done: the work may well have finished server-side.
        if (++failures >= 15) {
          this.clearCapTimer(jobId)
          runInAction(() => {
            const j = this.captionJobs.find((x) => x.jobId === jobId)
            if (j) {
              j.state = 'lost'
              j.error = 'status endpoint unreachable — the job may still finish server-side; refresh to see results'
            }
          })
        }
        return
      }
      runInAction(() => {
        const j = this.captionJobs.find((x) => x.jobId === jobId)
        if (!j) { this.clearCapTimer(jobId); return }    // dismissed while in flight
        Object.assign(j, {
          total: s.total || 0, done: s.done || 0, wrote: s.wrote || 0,
          skipped: s.skipped || 0, errors: s.errors || 0, provider: s.provider,
        })
        if (s.state !== 'running') {
          this.clearCapTimer(jobId)
          j.state = s.state === 'done' ? 'done' : 'failed'
          if (s.state !== 'done') j.error = s.error || s.lastError || 'unknown'
          this.captionDoneTick++
          // Refresh whatever folder is open NOW. Each job finishing repeats this, so with
          // several running the badges land set by set instead of only for the last one.
          void this.browse(this.cwd)
          // Keep the list from growing across a long session; the bell keeps the history.
          if (this.captionJobs.length > 20) this.captionJobs = this.captionJobs.slice(-20)
        }
      })
    }, 2000))
  }

  /** Stop WATCHING. Jobs keep running server-side and keep reporting to the bell. */
  dismissCaptionJob(jobId?: string): void {
    if (jobId) {
      this.clearCapTimer(jobId)
      this.captionJobs = this.captionJobs.filter((j) => j.jobId !== jobId)
      return
    }
    for (const id of [...this.capTimers.keys()]) this.clearCapTimer(id)
    this.captionJobs = []
  }
}

export const trainingImagesStore = new TrainingImagesStore()
export { ig as igCall }
