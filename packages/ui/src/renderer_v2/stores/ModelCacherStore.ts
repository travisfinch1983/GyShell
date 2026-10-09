import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

type Root = 'imagegen' | 'tts' | 'models'

/** Model Cacher — copy NAS models to per-node tmpfs (RAM drive); browse + cache + manage. */
export class ModelCacherStore {
  entries: any[] = []
  capacities: Record<string, any> = {}
  agents: Record<string, any> = {}
  scanModels: any[] = [] // [{family, variant, formats:{Format:{Quant:{path,sizeMB}}}}]
  cacheTargets: Record<string, number> = {} // sourceDir -> target MB (live progress %)
  loaded = false
  err = ''
  msg = ''
  busy = false
  // family/variant/quant quick-cache form
  qcNode = ''
  qcFamily = ''
  qcVariant = ''
  qcQuant = '' // "Format/Quant"
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
      const [cache, cfg, scan] = await Promise.all([
        bridge().request('GET', '/api/ai/models/cache').catch(() => ({ entries: [], capacities: {} })),
        bridge().request('GET', '/api/ai/config').catch(() => ({ agents: {} })),
        bridge().request('GET', '/api/ai/models/scan').catch(() => ({ models: [] })),
      ])
      runInAction(() => {
        this.entries = (cache as any)?.entries ?? []
        this.capacities = (cache as any)?.capacities ?? {}
        this.agents = (cfg as any)?.agents ?? {}
        this.scanModels = (scan as any)?.models ?? []
        const firstNode = Object.keys(this.capacities)[0] || Object.keys(this.agents)[0] || ''
        if (!this.bNode) this.bNode = firstNode
        if (!this.qcNode) this.qcNode = this.cacheableNodes[0] || firstNode
        this.loaded = true
      })
    } catch (e: any) { runInAction(() => { this.err = e?.message || 'load failed' }) }
    this.maybePoll()
  }
  private maybePoll(): void {
    const active = this.entries.some((e) => e.status === 'caching' || e.status === 'queued')
    if (active && !this.poll) this.poll = setInterval(() => { if (!document.hidden) void this.refreshList() }, 3000)
    else if (!active && this.poll) { clearInterval(this.poll); this.poll = null }
  }
  async refreshList(): Promise<void> {
    const c = await bridge().request('GET', '/api/ai/models/cache').catch(() => null)
    if (c) runInAction(() => { this.entries = (c as any).entries ?? []; this.capacities = (c as any).capacities ?? {} })
    this.maybePoll()
  }

  get nodes(): string[] { return Object.keys(this.agents) }
  get cacheableNodes(): string[] { return this.nodes.filter((n) => this.agents[n]?.cache?.enabled) }

  // ── LLM cap per node (agents[node].cache.llmLimitGB; LLM = sourceDir under /models/) ──
  llmLimitMB(node: string): number { return (Number(this.agents[node]?.cache?.llmLimitGB) || 0) * 1024 }
  llmUsedMB(node: string): number {
    return this.entries.filter((e: any) => e.node === node && String(e.sourceDir || '').startsWith('/models/'))
      .reduce((a: number, e: any) => a + (Number(e.sizeMB) || 0), 0)
  }
  /** Error text when caching sizeMB more LLM data on node would pass its limit, else ''. */
  llmLimitError(node: string, sourceDir: string, sizeMB: number): string {
    const lim = this.llmLimitMB(node)
    if (!lim || !String(sourceDir).startsWith('/models/')) return ''
    const used = this.llmUsedMB(node)
    if (used + (Number(sizeMB) || 0) <= lim) return ''
    return `LLM cache limit on ${node} is ${(lim / 1024).toFixed(0)} GB: ${(used / 1024).toFixed(1)} GB cached + ${((Number(sizeMB) || 0) / 1024).toFixed(1)} GB would exceed it. Uncache an LLM first, or raise the limit in Node Cache Config.`
  }
  entriesForNode(node: string): any[] { return this.entries.filter((e) => e.node === node) }

  // ── Family / Variant / Quant quick-cache (whole quant folder) ──
  setQc(k: 'qcNode' | 'qcFamily' | 'qcVariant' | 'qcQuant', v: string): void {
    ;(this as any)[k] = v
    if (k === 'qcFamily') { this.qcVariant = ''; this.qcQuant = '' }
    if (k === 'qcVariant') { this.qcQuant = '' }
  }
  get qcFamilies(): string[] { return [...new Set(this.scanModels.map((m) => m.family))].sort() }
  get qcVariants(): string[] { return [...new Set(this.scanModels.filter((m) => m.family === this.qcFamily).map((m) => m.variant))].sort() }
  /** Quant options for the selected family+variant, flattened across formats. */
  get qcQuants(): { key: string; label: string; format: string; quant: string; path: string; sizeMB: number }[] {
    const m = this.scanModels.find((x) => x.family === this.qcFamily && x.variant === this.qcVariant)
    if (!m) return []
    const out: any[] = []
    for (const [format, quants] of Object.entries(m.formats || {})) {
      for (const [quant, info] of Object.entries(quants as any)) {
        out.push({ key: `${format} ${quant}`, label: `${format} · ${quant}`, format, quant, path: (info as any).path, sizeMB: (info as any).sizeMB || 0 })
      }
    }
    return out
  }

  /** Cache the entire quant FOLDER (handles multi-file AWQ / FP16-safetensors / sharded GGUF). */
  async cacheSelectedQuant(): Promise<void> {
    const q = this.qcQuants.find((x) => x.key === this.qcQuant)
    if (!q || !this.qcNode) { this.err = 'Pick a node, family, variant, and quant first.'; return }
    // The quant folder: drop a trailing filename if path points at a file (e.g. sharded GGUF).
    const folder = /\.[a-z0-9]+$/i.test(q.path) ? q.path.replace(/\/[^/]+$/, '') : q.path
    const limErr = this.llmLimitError(this.qcNode, folder, q.sizeMB)
    if (limErr) { this.err = limErr; this.msg = ''; return }
    this.busy = true; this.err = ''; this.msg = ''
    runInAction(() => { this.cacheTargets[folder] = q.sizeMB })
    try {
      await bridge().request('POST', '/api/ai/models/cache', {
        node: this.qcNode, type: 'llm', family: this.qcFamily, variant: this.qcVariant, quant: q.quant,
        sourceDir: folder, sizeMB: q.sizeMB, displayName: `${this.qcFamily} ${this.qcVariant} · ${q.format} ${q.quant}`,
      })
      runInAction(() => { this.msg = `Caching ${this.qcFamily} ${this.qcVariant} (${q.format} ${q.quant}) on ${this.qcNode}…` })
      await this.refreshList()
    } catch (e: any) {
      runInAction(() => { this.err = 'Cache failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.busy = false })
    }
  }

  /** Live progress 0–100 for a caching entry (current copied size / target), or null if unknown. */
  progressPct(e: any): number | null {
    const target = this.cacheTargets[e.sourceDir] || 0
    if (!target || !e.sizeMB) return null
    return Math.max(2, Math.min(99, Math.round((e.sizeMB / target) * 100)))
  }

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
      const limErr = this.llmLimitError(this.bNode, sourceDir, sizeMB)
      if (limErr) { this.err = limErr; this.msg = ''; return }
    } else {
      body.type = this.bRoot
    }
    this.busy = true; this.err = ''; this.msg = ''
    if (sizeMB) runInAction(() => { this.cacheTargets[sourceDir] = sizeMB })
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
