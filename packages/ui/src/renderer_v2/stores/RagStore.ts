import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

/** Codebase RAG — index git repos into vector DBs, manage collections, resume interrupted jobs. */
export class RagStore {
  collections: any[] = []
  checkpoints: any[] = []
  status: any = { active: false, phase: '', progress: 0, detail: '' }
  loaded = false
  err = ''
  form = { url: '', collection: '', description: '', branch: '' }
  private timer: any = null
  private wasActive = false

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const [cols, cps] = await Promise.all([
        bridge().request('GET', '/api/ai/rag/collections').catch(() => []),
        bridge().request('GET', '/api/ai/rag/checkpoints').catch(() => []),
      ])
      runInAction(() => {
        this.collections = Array.isArray(cols) ? cols : []
        this.checkpoints = Array.isArray(cps) ? cps : []
        this.loaded = true
      })
    } catch (e: any) { runInAction(() => { this.err = e?.message || 'load failed' }) }
    void this.refreshStatus()
  }

  setForm(k: string, v: string): void { this.form = { ...this.form, [k]: v } }

  async refreshStatus(): Promise<void> {
    const s = await bridge().request('GET', '/api/ai/rag/index/status').catch(() => null)
    if (!s) return
    const justFinished = this.wasActive && !s.active
    runInAction(() => { this.status = s; this.wasActive = !!s.active })
    if (s.active) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.refreshStatus(), 1500)
    } else if (justFinished) {
      void this.load()
    }
  }

  async index(): Promise<void> {
    const { url, collection, description, branch } = this.form
    if (!url.trim() || !collection.trim()) { this.err = 'Repository URL and collection name are required.'; return }
    this.err = ''
    await bridge().request('POST', '/api/ai/rag/index', { url: url.trim(), collection: collection.trim(), description, branch })
    void this.refreshStatus()
  }
  async updateCollection(col: any): Promise<void> {
    if (!col.repo_url) { this.err = 'No repository URL on record for this collection.'; return }
    await bridge().request('POST', '/api/ai/rag/index', { url: col.repo_url, collection: col.display_name || col.name, description: col.description, branch: col.branch })
    void this.refreshStatus()
  }
  async deleteCollection(name: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/rag/collections/${encodeURIComponent(name)}`).catch(() => undefined)
    await this.load()
  }
  async resume(collection: string): Promise<void> {
    await bridge().request('POST', '/api/ai/rag/resume', { collection }).catch(() => undefined)
    void this.refreshStatus()
  }
  async discardCheckpoint(name: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/rag/checkpoints/${encodeURIComponent(name)}`).catch(() => undefined)
    await this.load()
  }
}

export const ragStore = new RagStore()
