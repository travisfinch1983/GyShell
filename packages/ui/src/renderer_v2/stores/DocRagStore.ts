import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

interface PickedFile { name: string; size: number; file: File }
interface ServerFile { name: string; path: string; size: number }
interface DirEntry { name: string; path: string }
interface BrowseState {
  open: boolean
  path: string
  parent: string | null
  dirs: DirEntry[]
  files: ServerFile[]
  selected: string[]
  loading: boolean
  error: string | null
}

/** Document RAG — index files into vector DBs, either uploaded from the browser or
 *  browsed directly on the AI-Lab container's filesystem (its NAS mounts). */
export class DocRagStore {
  collections: any[] = []
  status: any = { active: false, phase: '', progress: 0, detail: '' }
  loaded = false
  err = ''
  collection = ''
  description = ''
  files: PickedFile[] = []
  serverFiles: ServerFile[] = []
  busy = false
  browse: BrowseState = { open: false, path: '/nas', parent: null, dirs: [], files: [], selected: [], loading: false, error: null }
  private timer: any = null
  private wasActive = false

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const c = await bridge().request('GET', '/api/ai/docrag/collections').catch(() => [])
      runInAction(() => { this.collections = Array.isArray(c) ? c : []; this.loaded = true })
    } catch (e: any) { runInAction(() => { this.err = e?.message || 'load failed' }) }
    void this.refreshStatus()
  }
  setCollection(v: string): void { this.collection = v }
  setDescription(v: string): void { this.description = v }

  async addFiles(fileList: FileList | File[]): Promise<void> {
    // Keep the File itself: it is streamed as multipart at index time. Reading it into base64 up
    // front (the old way) held the whole document in memory 1.33x over and pushed it through the
    // websocket bridge, where a large manual hit the 100 MB message cap / 20 s proxy timeout and
    // the job silently never reached the backend (Travis, 2026-10-06: 2012 Juke service manual).
    const arr = Array.from(fileList).map((f) => ({ name: f.name, size: f.size, file: f }))
    runInAction(() => { this.files = [...this.files, ...arr] })
  }
  removeFile(i: number): void { this.files = this.files.filter((_, j) => j !== i) }
  removeServerFile(i: number): void { this.serverFiles = this.serverFiles.filter((_, j) => j !== i) }

  // ─── Server-side file browser ──────────────────────────────────────────────
  openBrowse(): void {
    runInAction(() => { this.browse.open = true; this.browse.error = null; this.browse.selected = [] })
    void this.browseTo(this.browse.path || '/nas')
  }
  closeBrowse(): void { this.browse.open = false }

  async browseTo(path: string): Promise<void> {
    runInAction(() => { this.browse.loading = true; this.browse.error = null })
    try {
      const d = await bridge().request('GET', `/api/ai/docrag/browse?path=${encodeURIComponent(path)}`)
      runInAction(() => {
        if (d?.error) { this.browse.error = d.error }
        else {
          this.browse.path = d.path
          this.browse.parent = d.parent ?? null
          this.browse.dirs = Array.isArray(d.dirs) ? d.dirs : []
          this.browse.files = Array.isArray(d.files) ? d.files : []
        }
      })
    } catch (e: any) {
      runInAction(() => { this.browse.error = e?.message || String(e) })
    } finally {
      runInAction(() => { this.browse.loading = false })
    }
  }

  toggleSelect(path: string): void {
    const i = this.browse.selected.indexOf(path)
    if (i >= 0) this.browse.selected.splice(i, 1)
    else this.browse.selected.push(path)
  }
  selectAllInFolder(): void {
    const all = this.browse.files.map((f) => f.path)
    const everySelected = all.length > 0 && all.every((p) => this.browse.selected.includes(p))
    this.browse.selected = everySelected ? [] : all
  }

  /** Move the checked files into the staged serverFiles list (dedup by path) and close. */
  addSelected(): void {
    runInAction(() => {
      const bySelected = this.browse.files.filter((f) => this.browse.selected.includes(f.path))
      const have = new Set(this.serverFiles.map((f) => f.path))
      for (const f of bySelected) if (!have.has(f.path)) this.serverFiles.push(f)
      this.browse.open = false
      this.browse.selected = []
    })
  }

  async refreshStatus(): Promise<void> {
    const s = await bridge().request('GET', '/api/ai/docrag/index/status').catch(() => null)
    if (!s) return
    const justFinished = this.wasActive && !s.active
    runInAction(() => { this.status = s; this.wasActive = !!s.active })
    if (s.active) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.refreshStatus(), 1500)
    } else if (justFinished) {
      runInAction(() => { this.files = []; this.serverFiles = [] })
      void this.load()
    }
  }

  get totalStaged(): number { return this.files.length + this.serverFiles.length }

  async index(): Promise<void> {
    if (!this.collection.trim()) { this.err = 'Collection name is required.'; return }
    if (!this.totalStaged) { this.err = 'Add at least one file (upload or browse the server).'; return }
    this.err = ''; this.busy = true
    try {
      if (this.serverFiles.length) {
        await bridge().request('POST', '/api/ai/docrag/index-paths', {
          collection: this.collection.trim(), description: this.description,
          paths: this.serverFiles.map((f) => f.path),
        })
      } else {
        // Plain HTTP multipart, same-origin (/api -> backend, like the imagegen images): no base64,
        // no websocket message cap, no bridge timeout on a slow upload.
        const fd = new FormData()
        fd.append('collection', this.collection.trim())
        fd.append('description', this.description)
        for (const f of this.files) fd.append('files', f.file, f.name)
        const r = await fetch('/api/ai/docrag/index', { method: 'POST', body: fd })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d?.error || `upload failed (HTTP ${r.status})`)
      }
      void this.refreshStatus()
    } catch (e: any) {
      runInAction(() => { this.err = 'Index failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.busy = false })
    }
  }
  async deleteCollection(name: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/docrag/collections/${encodeURIComponent(name)}`).catch(() => undefined)
    await this.load()
  }
}

export const docRagStore = new DocRagStore()
