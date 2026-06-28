import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

interface PickedFile { name: string; size: number; dataB64: string }

/** Document RAG — upload files (PDF/DOCX/XLSX/img/text) and index into vector DBs. */
export class DocRagStore {
  collections: any[] = []
  status: any = { active: false, phase: '', progress: 0, detail: '' }
  loaded = false
  err = ''
  collection = ''
  description = ''
  files: PickedFile[] = []
  busy = false
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
    const arr = Array.from(fileList)
    const read = await Promise.all(arr.map((f) => new Promise<PickedFile>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve({ name: f.name, size: f.size, dataB64: String(r.result).split(',')[1] || '' })
      r.onerror = () => resolve({ name: f.name, size: f.size, dataB64: '' })
      r.readAsDataURL(f)
    })))
    runInAction(() => { this.files = [...this.files, ...read] })
  }
  removeFile(i: number): void { this.files = this.files.filter((_, j) => j !== i) }

  async refreshStatus(): Promise<void> {
    const s = await bridge().request('GET', '/api/ai/docrag/index/status').catch(() => null)
    if (!s) return
    const justFinished = this.wasActive && !s.active
    runInAction(() => { this.status = s; this.wasActive = !!s.active })
    if (s.active) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.refreshStatus(), 1500)
    } else if (justFinished) {
      runInAction(() => { this.files = [] })
      void this.load()
    }
  }

  async index(): Promise<void> {
    if (!this.collection.trim()) { this.err = 'Collection name is required.'; return }
    if (!this.files.length) { this.err = 'Add at least one file.'; return }
    this.err = ''; this.busy = true
    try {
      await bridge().request('POST', '/api/ai/docrag/index-b64', { collection: this.collection.trim(), description: this.description, files: this.files })
      void this.refreshStatus()
    } catch (e: any) {
      runInAction(() => { this.err = 'Upload failed: ' + (e?.message || e) })
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
