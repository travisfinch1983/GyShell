import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

/** One file waiting to be indexed, uploaded from this machine or picked on the container. */
export interface StagedDoc {
  key: string
  kind: 'upload' | 'server'
  name: string
  size: number
  file?: File
  path?: string
  title: string
  description: string
  docType: string
}
export interface RagDocument {
  doc_id: string
  file_name: string
  title: string
  description: string
  doc_type: string
  file_kind?: string
  chunks?: number
  page_images?: number
  size?: number | null
  indexed_at?: string
  version?: number
}
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
/** The collection window (click a collection row): its documents + per-document actions. */
interface DetailState {
  open: boolean
  name: string            // internal docs_* name
  entry: any | null
  docs: RagDocument[]
  loading: boolean
  error: string
  editing: string | null  // doc_id being edited
  draft: { title: string; description: string; docType: string }
  savingDesc: boolean
}

/** Suggested document types; the field accepts anything. */
export const DOC_TYPES = ['Blueprint / Drawing', 'Specification', 'Contract', 'Report', 'Submittal', 'RFI', 'Change Order',
  'Schedule', 'Permit', 'Manual', 'Photo', 'Correspondence', 'Calculation', 'Other']

const stripExt = (n: string) => n.replace(/\.[A-Za-z0-9]{1,5}$/, '')
let keySeq = 0

/** Document RAG — index files into vector DBs, either uploaded from the browser or
 *  browsed directly on the AI-Lab container's filesystem (its NAS mounts). A collection holds
 *  many titled documents; a file whose name matches one already there replaces it. */
export class DocRagStore {
  collections: any[] = []
  status: any = { active: false, phase: '', progress: 0, detail: '' }
  loaded = false
  err = ''
  collection = ''
  description = ''
  staged: StagedDoc[] = []
  busy = false
  /** Also render + embed every PDF page as an image (diagrams, scans). ~2x indexing time. */
  pageImages = true
  browse: BrowseState = { open: false, path: '/nas', parent: null, dirs: [], files: [], selected: [], loading: false, error: null }
  detail: DetailState = { open: false, name: '', entry: null, docs: [], loading: false, error: '', editing: null, draft: { title: '', description: '', docType: '' }, savingDesc: false }
  /** Documents of the collection named in the add form (to flag replacements before indexing). */
  targetDocs: RagDocument[] = []
  private targetFor = ''
  private timer: any = null
  private wasActive = false

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const c = await bridge().request('GET', '/api/ai/docrag/collections').catch(() => [])
      runInAction(() => { this.collections = Array.isArray(c) ? c : []; this.loaded = true })
    } catch (e: any) { runInAction(() => { this.err = e?.message || 'load failed' }) }
    void this.refreshStatus()
    void this.loadTargetDocs()
  }

  /** The existing collection the add form currently targets (matched by display or internal name). */
  get targetCollection(): any | null {
    const v = this.collection.trim().toLowerCase()
    if (!v) return null
    const internal = 'docs_' + v.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    return this.collections.find((c) => String(c.display_name || '').toLowerCase() === v || c.name === v || c.name === internal) || null
  }
  setCollection(v: string): void { this.collection = v; void this.loadTargetDocs() }
  setDescription(v: string): void { this.description = v }
  setPageImages(v: boolean): void { this.pageImages = v }

  async loadTargetDocs(): Promise<void> {
    const t = this.targetCollection
    const name = t?.name || ''
    if (name === this.targetFor) return
    this.targetFor = name
    if (!name) { this.targetDocs = []; return }
    try {
      const d = await bridge().request('GET', `/api/ai/docrag/collections/${encodeURIComponent(name)}/documents`)
      runInAction(() => { if (this.targetFor === name) this.targetDocs = Array.isArray(d?.documents) ? d.documents : [] })
    } catch { runInAction(() => { if (this.targetFor === name) this.targetDocs = [] }) }
  }
  /** The document a staged file will replace (same file name in the target collection), if any. */
  replaces(s: StagedDoc): RagDocument | null {
    return this.targetDocs.find((d) => d.file_name === s.name) || null
  }

  private stage(kind: 'upload' | 'server', name: string, size: number, extra: Partial<StagedDoc>): StagedDoc {
    return { key: `s${++keySeq}`, kind, name, size, title: stripExt(name), description: '', docType: '', ...extra }
  }
  async addFiles(fileList: FileList | File[]): Promise<void> {
    // Keep the File itself: it is streamed in pieces at index time (never base64'd into memory).
    const arr = Array.from(fileList).map((f) => this.stage('upload', f.name, f.size, { file: f }))
    runInAction(() => { this.staged = [...this.staged, ...arr] })
  }
  removeStaged(key: string): void { this.staged = this.staged.filter((s) => s.key !== key) }
  setStaged(key: string, field: 'title' | 'description' | 'docType', v: string): void {
    const s = this.staged.find((x) => x.key === key)
    if (s) s[field] = v
  }
  /** Copy one document type onto every staged file (a stack of prints is usually all one type). */
  setAllTypes(v: string): void { for (const s of this.staged) s.docType = v }

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

  /** Move the checked files into the staged list (dedup by path) and close. */
  addSelected(): void {
    runInAction(() => {
      const bySelected = this.browse.files.filter((f) => this.browse.selected.includes(f.path))
      const have = new Set(this.staged.filter((s) => s.kind === 'server').map((s) => s.path))
      for (const f of bySelected) if (!have.has(f.path)) this.staged.push(this.stage('server', f.name, f.size, { path: f.path }))
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
      runInAction(() => { this.staged = [] })
      this.targetFor = ''
      await this.load()
      if (this.detail.open) void this.loadDetail()
    }
  }

  get totalStaged(): number { return this.staged.length }

  private metaOf(s: StagedDoc) {
    return { title: s.title.trim(), description: s.description.trim(), doc_type: s.docType.trim() }
  }

  async index(): Promise<void> {
    if (!this.collection.trim()) { this.err = 'Collection name is required.'; return }
    if (!this.totalStaged) { this.err = 'Add at least one file (upload or browse the server).'; return }
    if (this.staged.some((s) => !s.title.trim())) { this.err = 'Every document needs a title.'; return }
    this.err = ''; this.busy = true
    // An existing collection is addressed by its internal name, so a display name that sanitises
    // differently can never fork it into a second collection.
    const target = this.targetCollection?.name || this.collection.trim()
    try {
      const uploads = this.staged.filter((s) => s.kind === 'upload')
      const server = this.staged.filter((s) => s.kind === 'server').map((s) => ({ path: s.path, ...this.metaOf(s) }))
      if (uploads.length) {
        await this.uploadAndIndex(target, uploads.map((s) => ({ file: s.file!, meta: this.metaOf(s) })), server)
      } else {
        await bridge().request('POST', '/api/ai/docrag/index-paths', {
          collection: target, description: this.description, paths: server, pageImages: this.pageImages,
        })
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
   * Once every file is complete the server indexes them (plus any container files) as ONE job.
   */
  private async uploadAndIndex(collection: string, items: { file: File; meta: any; replaceDocId?: string }[], serverFiles: any[] = []): Promise<void> {
    const CHUNK = 32 * 1024 * 1024
    const jsonOrThrow = async (r: Response) => {
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error(d?.error || `HTTP ${r.status}`), { status: r.status, body: d })
      return d
    }
    const { session } = await jsonOrThrow(await fetch('/api/ai/docrag/staging', { method: 'POST' }))
    const total = items.reduce((a, it) => a + it.file.size, 0) || 1
    let sent = 0
    const mb = (n: number) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0)
    for (const [idx, { file: f }] of items.entries()) {
      let offset = 0
      const q = (o: number) => `/api/ai/docrag/staging/${session}/${idx}?name=${encodeURIComponent(f.name)}&offset=${o}`
      while (offset < f.size || (f.size === 0 && offset === 0)) {
        const piece = f.slice(offset, Math.min(offset + CHUNK, f.size))
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
        runInAction(() => { this.uploadMsg = `Uploading ${idx + 1}/${items.length}: ${f.name} — ${mb(sent)} of ${mb(total)} MB (${Math.round((sent / total) * 100)}%)` })
        if (f.size === 0) break
      }
    }
    runInAction(() => { this.uploadMsg = 'Upload complete, starting indexing…' })
    await jsonOrThrow(await fetch(`/api/ai/docrag/staging/${session}/index`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection, description: this.description, pageImages: this.pageImages, serverFiles,
        files: items.map((it, idx) => ({ idx, name: it.file.name, size: it.file.size, ...it.meta, ...(it.replaceDocId ? { replaceDocId: it.replaceDocId } : {}) })) }),
    }))
    runInAction(() => { this.uploadMsg = '' })
  }

  async deleteCollection(name: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/docrag/collections/${encodeURIComponent(name)}`).catch(() => undefined)
    if (this.detail.name === name) this.closeDetail()
    await this.load()
  }

  // ─── Collection window ─────────────────────────────────────────────────────
  openDetail(name: string): void {
    this.detail = { ...this.detail, open: true, name, entry: this.collections.find((c) => c.name === name) || null, docs: [], error: '', editing: null }
    void this.loadDetail()
  }
  closeDetail(): void { this.detail.open = false; this.detail.editing = null }

  async loadDetail(): Promise<void> {
    const name = this.detail.name
    runInAction(() => { this.detail.loading = true; this.detail.error = '' })
    try {
      const d = await bridge().request('GET', `/api/ai/docrag/collections/${encodeURIComponent(name)}/documents`)
      runInAction(() => {
        if (this.detail.name !== name) return
        if (d?.error) { this.detail.error = d.error; return }
        this.detail.entry = d
        this.detail.docs = Array.isArray(d?.documents) ? d.documents : []
      })
    } catch (e: any) {
      runInAction(() => { this.detail.error = e?.message || String(e) })
    } finally {
      runInAction(() => { this.detail.loading = false })
    }
  }

  startEdit(doc: RagDocument): void {
    this.detail.editing = doc.doc_id
    this.detail.draft = { title: doc.title || '', description: doc.description || '', docType: doc.doc_type || '' }
  }
  cancelEdit(): void { this.detail.editing = null }
  setDraft(field: 'title' | 'description' | 'docType', v: string): void { this.detail.draft[field] = v }

  async saveEdit(): Promise<void> {
    const id = this.detail.editing
    if (!id) return
    const { title, description, docType } = this.detail.draft
    if (!title.trim()) { this.detail.error = 'Title cannot be empty.'; return }
    try {
      const r = await bridge().request('PATCH', `/api/ai/docrag/collections/${encodeURIComponent(this.detail.name)}/documents/${id}`,
        { title, description, doc_type: docType })
      if (r?.error) throw new Error(r.error)
      runInAction(() => { this.detail.editing = null })
      await this.loadDetail()
    } catch (e: any) { runInAction(() => { this.detail.error = 'Save failed: ' + (e?.message || e) }) }
  }

  async saveCollectionDescription(description: string): Promise<void> {
    runInAction(() => { this.detail.savingDesc = true })
    try {
      const r = await bridge().request('PATCH', `/api/ai/docrag/collections/${encodeURIComponent(this.detail.name)}`, { description })
      if (r?.error) throw new Error(r.error)
      await Promise.all([this.loadDetail(), this.load()])
    } catch (e: any) { runInAction(() => { this.detail.error = 'Save failed: ' + (e?.message || e) }) }
    finally { runInAction(() => { this.detail.savingDesc = false }) }
  }

  async deleteDocument(doc: RagDocument): Promise<void> {
    try {
      const r = await bridge().request('DELETE', `/api/ai/docrag/collections/${encodeURIComponent(this.detail.name)}/documents/${doc.doc_id}`)
      if (r?.error) throw new Error(r.error)
      await Promise.all([this.loadDetail(), this.load()])
    } catch (e: any) { runInAction(() => { this.detail.error = 'Delete failed: ' + (e?.message || e) }) }
  }

  /** Replace one document with a new file: the title/description/type carry over, the old
   *  version's chunks are removed only after the new version is indexed. */
  async replaceDocument(doc: RagDocument, file: File): Promise<void> {
    if (this.status.active) { this.detail.error = 'Another indexing job is running - wait for it to finish.'; return }
    runInAction(() => { this.detail.error = ''; this.busy = true })
    try {
      await this.uploadAndIndex(this.detail.name, [{ file, meta: { title: doc.title, description: doc.description, doc_type: doc.doc_type }, replaceDocId: doc.doc_id }])
      void this.refreshStatus()
    } catch (e: any) {
      runInAction(() => { this.detail.error = 'Replace failed: ' + (e?.message || e); this.uploadMsg = '' })
    } finally { runInAction(() => { this.busy = false }) }
  }

  /** "Add documents" from the collection window: point the add form at this collection. */
  addToThis(): void {
    const e = this.detail.entry
    this.setCollection(e?.display_name || this.detail.name)
    this.closeDetail()
  }
}

export const docRagStore = new DocRagStore()
