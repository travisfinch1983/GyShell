import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

/**
 * Model Cache & Placement (AI · Image Gen) - claude2's image model services: per host, the RAM tier,
 * the persistent tier (Optane on px-gpu, Disk on px-epyc), VRAM per service and every model with the
 * tier it sits in. Reads /api/ai/imagegen-models/overview; actions go through .../action, which only
 * forwards the services' own whitelisted routes.
 */
export const KIND_LABEL: Record<string, string> = { unet: 'UNet', ckpt: 'Checkpoint', lora: 'LoRA', te: 'Text encoder', detector: 'Detector', sam: 'SAM', vae: 'VAE' }
/** Model root (under /imagegen) per kind; file names are relative to it, as ComfyUI lists them. */
export const KIND_ROOT: Record<string, string> = { unet: 'diffusion-models', ckpt: 'checkpoints', lora: 'loras', te: 'text-encoders', detector: 'ultralytics', sam: 'sam', vae: 'vae' }

export interface ModelRow {
  kind: string; name: string
  ram: any | null; persist: any | null
  // One entry per loaded COPY: the same model can sit on several GPUs of one service (multi-GPU serve.py).
  hotOn: { service: string; port: number; tier: string; busy: boolean; waiting: number; gpu: number | null; gpuName: string | null }[]
  sizeGb: number | null
}

export class ImageModelsStore {
  nodes: any[] = []
  loading = false
  error = ''
  msg = ''
  busyKey = ''
  search = ''
  kind = ''
  showNas = false
  updatedAt = 0
  quotaDraft: Record<string, any> = {}
  // ── "Add to cache" picker ──
  addNode = ''
  addKind = 'unet'
  addSearch = ''
  addFile = ''
  files: Record<string, string[]> = {}
  filesErr: Record<string, string> = {}
  private timer: any = null

  constructor() { makeAutoObservable(this) }

  start(): void {
    void this.load()
    if (!this.timer) this.timer = setInterval(() => { if (!this.busyKey) void this.load(true) }, 10000)
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  async load(quiet = false): Promise<void> {
    if (!quiet) this.loading = true
    try {
      const r: any = await bridge().request('GET', '/api/ai/imagegen-models/overview')
      runInAction(() => { this.nodes = r?.nodes ?? []; this.error = r?.error || ''; this.updatedAt = Date.now() })
    } catch (e: any) {
      runInAction(() => { this.error = String(e?.message || e) })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  set<K extends 'search' | 'kind' | 'showNas' | 'addNode' | 'addKind' | 'addSearch' | 'addFile'>(k: K, v: this[K]): void {
    (this as any)[k] = v
    if (k === 'addKind') { this.addFile = ''; void this.loadFiles(KIND_ROOT[v as string]) }
  }

  async loadFiles(root: string): Promise<void> {
    if (!root || this.files[root]) return
    try {
      const r: any = await bridge().request('GET', `/api/imagegen/model-files?root=${encodeURIComponent(root)}`)
      runInAction(() => { this.files[root] = Array.isArray(r?.files) ? r.files : []; delete this.filesErr[root] })
    } catch (e: any) {
      runInAction(() => { this.filesErr[root] = String(e?.message || e) })
    }
  }
  get addTarget(): any { return this.nodes.find((n) => n.node === this.addNode) || this.nodes[0] || null }
  /** The host's cache takes a kind when it has a RAM quota for it (claude2's services add kinds there). */
  kindSupported(n: any, kind: string): boolean { return !!n?.cache?.config?.quota_gb && kind in n.cache.config.quota_gb }
  get addMatches(): string[] {
    const all = this.files[KIND_ROOT[this.addKind]] || []
    const q = this.addSearch.trim().toLowerCase()
    return (q ? all.filter((f) => f.toLowerCase().includes(q)) : all).slice(0, 200)
  }
  async addToCache(): Promise<void> {
    const n = this.addTarget
    if (!n?.cacheService || !this.addFile) return
    await this.act(n.cacheService, '/cache/warm', { kind: this.addKind, name: this.addFile }, `Add ${this.addFile} to ${n.node} RAM cache`)
  }

  kinds(n: any): string[] {
    const q = n?.cache?.config?.quota_gb
    return q ? Object.keys(q) : ['unet', 'te', 'vae', 'lora']
  }

  /** Every model on this node: catalog (available) + RAM + persistent + resident, one row per kind/name. */
  rows(n: any): ModelRow[] {
    const map = new Map<string, ModelRow>()
    const row = (kind: string, name: string): ModelRow => {
      const key = `${kind}\u0000${name}`
      let r = map.get(key)
      if (!r) { r = { kind, name, ram: null, persist: null, hotOn: [], sizeGb: null }; map.set(key, r) }
      return r
    }
    for (const s of n.services || []) {
      if (!s.ok) continue
      for (const [kind, names] of Object.entries(s.available || {})) for (const name of names as string[]) row(kind, name)
      for (const m of s.resident || []) row(m.kind, m.name).hotOn.push({ service: s.id, port: s.port, tier: m.tier, busy: !!m.busy, waiting: m.waiting || 0,
        gpu: m.gpu ?? null, gpuName: m.gpu_name ?? null })
    }
    for (const [kind, e] of Object.entries(n.cache?.entries || {})) {
      for (const x of (e as any).ram || []) { const r = row(kind, x.name); r.ram = x; r.sizeGb = x.size_gb }
      for (const x of (e as any).optane || []) { const r = row(kind, x.name); r.persist = x; r.sizeGb = r.sizeGb ?? x.size_gb }
    }
    const q = this.search.trim().toLowerCase()
    const rank = (r: ModelRow) => (r.hotOn.length ? 0 : r.ram ? 1 : r.persist ? 2 : 3)
    return [...map.values()]
      .filter((r) => (!this.kind || r.kind === this.kind) && (!q || r.name.toLowerCase().includes(q)))
      .filter((r) => this.showNas || r.hotOn.length || r.ram || r.persist)
      .sort((a, b) => rank(a) - rank(b) || (b.ram?.score ?? 0) - (a.ram?.score ?? 0) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  }

  /** Services on this node that can hold a model of this kind. */
  servicesFor(n: any, kind: string): any[] {
    return (n.services || []).filter((s: any) => s.ok && (!s.service?.kinds || s.service.kinds.includes(kind) || kind === 'lora'))
  }

  async act(service: string, path: string, body: any, label: string): Promise<void> {
    const key = `${service}${path}${JSON.stringify(body)}`
    this.busyKey = key; this.error = ''; this.msg = ''
    try {
      const r: any = await bridge().request('POST', '/api/ai/imagegen-models/action', { service, path, body })
      if (r?.error) throw new Error(r.error)
      runInAction(() => { this.msg = `${label}: ${r?.status || r?.message || 'ok'}` })
    } catch (e: any) {
      runInAction(() => { this.error = `${label} failed: ${e?.message || e}` })
    } finally {
      runInAction(() => { this.busyKey = '' })
      await this.load(true)
    }
  }

  // ── placement rules (per service): {kind: [gpu index...]}; a GPU named in a rule is RESERVED for
  //    the kinds naming it (auto-placement only). An explicit gpu on Load always wins. ──
  rulesOf(s: any): Record<string, number[]> { return (s?.service?.placement && typeof s.service.placement === 'object') ? s.service.placement : {} }
  async toggleRule(s: any, kind: string, gpu: number): Promise<void> {
    const cur = this.rulesOf(s)
    const next: Record<string, number[]> = {}
    for (const [k, v] of Object.entries(cur)) next[k] = [...(v as number[])]
    const list = next[kind] || []
    next[kind] = list.includes(gpu) ? list.filter((g) => g !== gpu) : [...list, gpu].sort((a, b) => a - b)
    if (!next[kind].length) delete next[kind]
    await this.act(s.id, '/placement', { rules: next }, `Placement on :${s.port}`)
  }

  // ── quota editor (per host) ──
  draft(n: any): any {
    if (!this.quotaDraft[n.node] && n.cache?.config) {
      const c = n.cache.config
      this.quotaDraft[n.node] = { quota_gb: { ...(c.quota_gb || {}) }, half_life_h: c.half_life_h, optane_quota_gb: c.optane_quota_gb }
    }
    return this.quotaDraft[n.node]
  }
  setDraft(node: string, path: string[], v: number): void {
    const d = this.quotaDraft[node]; if (!d) return
    if (path.length === 2) d[path[0]] = { ...d[path[0]], [path[1]]: v }
    else d[path[0]] = v
  }
  async saveQuotas(n: any): Promise<void> {
    const d = this.quotaDraft[n.node]
    if (!d || !n.cacheService) return
    await this.act(n.cacheService, '/cache/quotas', d, `Quotas on ${n.node}`)
    runInAction(() => { delete this.quotaDraft[n.node] })
  }
}

export const imageModelsStore = new ImageModelsStore()
