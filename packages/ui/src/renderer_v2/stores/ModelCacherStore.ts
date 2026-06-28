import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

type Root = 'imagegen' | 'tts' | 'models'

/** Model Cacher — copy NAS models to per-node tmpfs (RAM drive); browse + cache + manage. */
export class ModelCacherStore {
  entries: any[] = []
  capacities: Record<string, any> = {}
  agents: Record<string, any> = {}
  loaded = false
  err = ''
  msg = ''
  busy = false
  // browse state
  bNode = ''
  bRoot: Root = 'imagegen'
  bRel = '' // relative path under the root
  bCwd = '' // container path returned by browse
  bDirs: string[] = []
  bFiles: { name: string; sizeMB: number }[] = []
  browsing = false
  browseErr = ''
  private poll: any = null

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const [cache, cfg] = await Promise.all([
        bridge().request('GET', '/api/ai/models/cache').catch(() => ({ entries: [], capacities: {} })),
        bridge().request('GET', '/api/ai/config').catch(() => ({ agents: {} })),
      ])
      runInAction(() => {
        this.entries = (cache as any)?.entries ?? []
        this.capacities = (cache as any)?.capacities ?? {}
        this.agents = (cfg as any)?.agents ?? {}
        if (!this.bNode) this.bNode = Object.keys(this.capacities)[0] || Object.keys(this.agents)[0] || ''
        this.loaded = true
      })
    } catch (e: any) { runInAction(() => { this.err = e?.message || 'load failed' }) }
    this.maybePoll()
  }
  private maybePoll(): void {
    const active = this.entries.some((e) => e.status === 'caching' || e.status === 'queued')
    if (active && !this.poll) this.poll = setInterval(() => void this.refreshList(), 3000)
    else if (!active && this.poll) { clearInterval(this.poll); this.poll = null }
  }
  async refreshList(): Promise<void> {
    const c = await bridge().request('GET', '/api/ai/models/cache').catch(() => null)
    if (c) runInAction(() => { this.entries = (c as any).entries ?? []; this.capacities = (c as any).capacities ?? {} })
    this.maybePoll()
  }

  get nodes(): string[] { return Object.keys(this.agents) }
  get cacheableNodes(): string[] { return this.nodes.filter((n) => this.agents[n]?.cache?.enabled) }
  entriesForNode(node: string): any[] { return this.entries.filter((e) => e.node === node) }

  setBrowse(k: 'bNode' | 'bRoot' | 'bRel', v: any): void { (this as any)[k] = v }

  async browse(rel: string = this.bRel): Promise<void> {
    if (!this.bNode) return
    this.browsing = true; this.browseErr = ''
    try {
      const r: any = await bridge().request('GET', `/api/ai/cache/browse?node=${encodeURIComponent(this.bNode)}&root=${this.bRoot}&path=${encodeURIComponent(rel)}`)
      runInAction(() => { this.bRel = rel; this.bCwd = r.cwd || ''; this.bDirs = r.dirs || []; this.bFiles = r.files || [] })
    } catch (e: any) {
      runInAction(() => { this.browseErr = e?.message || 'browse failed'; this.bDirs = []; this.bFiles = [] })
    } finally {
      runInAction(() => { this.browsing = false })
    }
  }
  descend(dir: string): void { void this.browse(this.bRel ? `${this.bRel}/${dir}` : dir) }
  up(): void { void this.browse(this.bRel.split('/').slice(0, -1).join('/')) }

  async cacheItem(name: string, sizeMB: number): Promise<void> {
    const sourceDir = `${this.bCwd}/${name}`.replace(/\/+/g, '/')
    const body: any = { node: this.bNode, sourceDir, sizeMB: sizeMB || 0, displayName: name }
    if (this.bRoot === 'models') {
      const segs = sourceDir.replace(/^\/models\//, '').split('/').filter(Boolean)
      body.type = 'llm'; body.family = segs[0]; body.variant = segs[1]; body.quant = segs[segs.length - 1]
    } else {
      body.type = this.bRoot
    }
    this.busy = true; this.err = ''; this.msg = ''
    try {
      await bridge().request('POST', '/api/ai/models/cache', body)
      runInAction(() => { this.msg = `Caching ${name} on ${this.bNode}…` })
      await this.refreshList()
    } catch (e: any) {
      runInAction(() => { this.err = 'Cache failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.busy = false })
    }
  }
  async removeEntry(e: any): Promise<void> {
    await bridge().request('DELETE', `/api/ai/models/cache?node=${encodeURIComponent(e.node)}&cacheDir=${encodeURIComponent(e.cacheDir)}`).catch(() => undefined)
    await this.refreshList()
  }
  async saveNodeConfig(node: string, patch: Record<string, any>): Promise<void> {
    const next = { ...(this.agents[node]?.cache || {}), ...patch }
    runInAction(() => { this.agents[node] = { ...(this.agents[node] || {}), cache: next } })
    await bridge().request('PUT', `/api/ai/agents/${encodeURIComponent(node)}/cache`, next).catch(() => undefined)
    await this.refreshList()
  }
}

export const modelCacherStore = new ModelCacherStore()
