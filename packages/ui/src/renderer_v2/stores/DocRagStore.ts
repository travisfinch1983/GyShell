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
        await this.uploadStagedAndIndex()
      }
      void this.refreshStatus()
    } catch (e: any) {
      runInAction(() => { this.err = 'Index failed: ' + (e?.message || e); this.uploadMsg = '' })
    } finally {
      runInAction(() => { this.busy = false })
    }
  }
  /** Upload progress line while files are going up ('' when idle). */
  uploadMsg = ''

  /**
   * Each file goes up on its own in 32 MB pieces (same-origin HTTP, no websocket bridge), so no
   * request ever approaches Cloudflare's 100 MB cap however big the file or the batch. A failed
   * piece is retried from the server's own byte count, so a blip resumes instead of restarting.
   * Once every file is complete the server indexes them from its staging folder.
   */
  private async uploadStagedAndIndex(): Promise<void> {
    const CHUNK = 32 * 1024 * 1024
    const jsonOrThrow = async (r: Response) => {
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error(d?.error || `HTTP ${r.status}`), { status: r.status, body: d })
      return d
    }
    const { session } = await jsonOrThrow(await fetch('/api/ai/docrag/staging', { method: 'POST' }))
    const total = this.files.reduce((a, f) => a + f.size, 0) || 1
    let sent = 0
    const mb = (n: number) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0)
    for (const [idx, f] of this.files.entries()) {
      let offset = 0
      const q = (o: number) => `/api/ai/docrag/staging/${session}/${idx}?name=${encodeURIComponent(f.name)}&offset=${o}`
      while (offset < f.size || (f.size === 0 && offset === 0)) {
        const piece = f.file.slice(offset, Math.min(offset + CHUNK, f.size))
        let attempt = 0
        for (;;) {
          try {
            const d = await jsonOrThrow(await fetch(q(offset), { method: 'PUT', body: piece, headers: { 'Content-Type': 'application/octet-stream' } }))
            sent += d.size - offset; offset = d.size
            break
          } catch (e: any) {
            // 409 = server has a different byte count than we think: resync to it and carry on.
            if (e?.status === 409 && typeof e.body?.size === 'number') { sent += e.body.size - offset; offset = e.body.size; break }
            if (++attempt >= 4) throw new Error(`uploading ${f.name} failed at ${mb(offset)} MB: ${e?.message || e}`)
            await new Promise((r) => setTimeout(r, 1500 * attempt))
            try { const s2 = await jsonOrThrow(await fetch(`/api/ai/docrag/staging/${session}/${idx}`)); sent += s2.size - offset; offset = s2.size } catch { /* retry blind */ }
            if (offset >= f.size) break
          }
        }
        runInAction(() => { this.uploadMsg = `Uploading ${idx + 1}/${this.files.length}: ${f.name} — ${mb(sent)} of ${mb(total)} MB (${Math.round((sent / total) * 100)}%)` })
        if (f.size === 0) break
      }
    }
    runInAction(() => { this.uploadMsg = 'Upload complete, starting indexing…' })
    await jsonOrThrow(await fetch(`/api/ai/docrag/staging/${session}/index`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: this.collection.trim(), description: this.description,
        files: this.files.map((f, idx) => ({ idx, name: f.name, size: f.size })) }),
    }))
    runInAction(() => { this.uploadMsg = '' })
  }

  async deleteCollection(name: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/docrag/collections/${encodeURIComponent(name)}`).catch(() => undefined)
    await this.load()
  }
}

export const docRagStore = new DocRagStore()
