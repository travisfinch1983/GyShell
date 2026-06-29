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
  const data = text ? JSON.parse(text) : {}
  if (!r.ok) throw new Error(data?.error || `${r.status} ${r.statusText}`)
  return data
}

export interface IgImage {
  name: string; rel: string; mtime: number; ctime: number; birthtime: number; size: number
  w: number; h: number; cropped: boolean; has_alt: boolean; has_caption: boolean; has_nl_caption: boolean
  score: number | null; comment: string
}
export interface IgFolder { name: string; n_images: number; n_subfolders: number; is_training_set: boolean; has_training_set: boolean }
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

  constructor() { makeAutoObservable(this) }

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
        this.folders = d.folders || []
        const prefix = d.path ? d.path + '/' : ''
        this.images = (d.images || []).map((im: any) => ({
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
  enterSelection() { this.selectionMode = true }
  exitSelection() { this.selectionMode = false; this.lastIndex = null; this.selected.clear() }
  toggleOne(i: number) {
    const name = this.images[i].name
    if (this.selected.has(name)) this.selected.delete(name); else this.selected.add(name)
    this.selected = new Set(this.selected)
    if (!this.selected.size) this.exitSelection()
  }
  selectRange(a: number, b: number) {
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    for (let i = lo; i <= hi; i++) this.selected.add(this.images[i].name)
    this.selected = new Set(this.selected); this.lastIndex = b
  }
  selectAll() { this.images.forEach((im) => this.selected.add(im.name)); this.selected = new Set(this.selected) }

  // ── actions ──
  async sendToTrainingSet(suffix: string): Promise<any> {
    const files = [...this.selected]
    return ig('/send-to-training-set', { method: 'POST', body: { path: this.cwd, files, suffix } })
  }
  async deleteSelected(): Promise<any> {
    return ig('/delete', { method: 'POST', body: { path: this.cwd, files: [...this.selected] } })
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
  async listTrainingSets(): Promise<any> { return ig('/training-sets') }
  async merge(name: string, sources: string[]): Promise<any> { return ig('/merge', { method: 'POST', body: { name, sources } }) }
  async browseRaw(p: string): Promise<any> { return ig(`/browse?path=${encodeURIComponent(p)}`) }
}

export const trainingImagesStore = new TrainingImagesStore()
export { ig as igCall }
