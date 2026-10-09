import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

/**
 * Model Cache & Placement (AI · Image Gen) - claude2's image model services: per host, the RAM tier,
 * the persistent tier (Optane on px-gpu, Disk on px-epyc), VRAM per service and every model with the
 * tier it sits in. Reads /api/ai/imagegen-models/overview; actions go through .../action, which only
 * forwards the services' own whitelisted routes.
 */
export const KIND_LABEL: Record<string, string> = { unet: 'UNet', te: 'Text encoder', vae: 'VAE', lora: 'LoRA' }

export interface ModelRow {
  kind: string; name: string
  ram: any | null; persist: any | null
  hotOn: { service: string; port: number; tier: string; busy: boolean; waiting: number }[]
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

  set<K extends 'search' | 'kind' | 'showNas'>(k: K, v: this[K]): void { (this as any)[k] = v }

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
      for (const m of s.resident || []) row(m.kind, m.name).hotOn.push({ service: s.id, port: s.port, tier: m.tier, busy: !!m.busy, waiting: m.waiting || 0 })
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
