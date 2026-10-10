import { makeAutoObservable, runInAction } from 'mobx'
import { imageModelsStore } from './ImageModelsStore'

/**
 * Graphical Image Model Service manager (Travis, 2026-10-10 - /claude/ui_example.png): one cylinder per GPU on every
 * node AI-Lab polls, filled with the image-model-service models resident on it (labelled blocks) and whatever else
 * uses the card (one unlabelled block - its owner is not looked up); plus a RAM-cache and a Disk/Optane-cache
 * cylinder per host that has them.
 *
 * Nothing executes live: drag / X / pin STAGE changes, projected onto the cylinders as ghost blocks; Undo pops them;
 * Apply sends them, unloads first, through the AI-Lab action route (the services' own whitelisted endpoints).
 *
 * Data: GPU size + used VRAM from Prometheus (the nvidia_smi gauges GpuFleetStore reads, keyed by uuid); models
 * from the existing /api/ai/imagegen-models/overview (imageModelsStore) - each service lists its GPUs with the same
 * uuid, so a resident model maps to its card exactly.
 */
const QUERY = '{__name__=~"nvidia_smi_gpu_info|nvidia_smi_memory_used_bytes|nvidia_smi_memory_total_bytes",job="gpu"}'
const GIB = 1024 ** 3
const norm = (u: any) => String(u || '').replace(/^GPU-/i, '').toLowerCase()
const bridge = (): any => (window as any).gyshell?.cluster

export type Change =
  | { t: 'load'; service: string; kind: string; name: string; gpu: number; clipType?: string }
  | { t: 'unload'; service: string; kind: string; name: string; gpu: number; clipType?: string }
  | { t: 'split'; service: string; name: string; gpus: [number, number]; clipType: string }
  | { t: 'unsplit'; service: string; name: string }
  | { t: 'pin'; service: string; kind: string; name: string; gpu: number; pinned: boolean; clipType?: string }
  | { t: 'warm'; node: string; service: string; kind: string; name: string }
  | { t: 'evict'; node: string; service: string; kind: string; name: string; tier: 'ram' | 'optane' }
  | { t: 'cachepin'; node: string; service: string; kind: string; name: string; tier: 'ram' | 'optane'; pinned: boolean }

export interface MapBlock {
  id: string; kind: string; name: string; gb: number | null; service: string; gpus: number[]; split: boolean
  pinned: boolean; busy: boolean; tier: string; clipType?: string; plugin?: string
  staged?: 'add' | 'remove'; pinNext?: boolean   // pinNext: the pin state after Apply, when a pin change is staged
  other?: boolean                                 // usage that is not an image-model-service model
}
export interface MapGpu {
  uuid: string; node: string; label: string; totalGb: number; usedGb: number
  service: string | null; svcIndex: number | null; teSplit: boolean; pinSupported: boolean
  blocks: MapBlock[]; projectedGb: number
}
export interface CacheBlock { id: string; kind: string; name: string; gb: number; pinned: boolean; copying?: boolean; staged?: 'add' | 'remove'; pinNext?: boolean }
export interface CacheCyl { node: string; tier: 'ram' | 'optane'; label: string; service: string; capGb: number; usedGb: number; blocks: CacheBlock[]; projectedGb: number }
export interface MapNode { node: string; gpus: MapGpu[]; caches: CacheCyl[] }

const ORDER: Change['t'][] = ['unsplit', 'unload', 'evict', 'split', 'load', 'warm', 'pin', 'cachepin']

export function changeLabel(c: Change, gpuName: (service: string, gpu: number) => string): string {
  const short = (n: string) => n.split('/').pop()!.replace(/\.(safetensors|gguf|pth|pt|ckpt|bin)$/i, '')
  switch (c.t) {
    case 'load': return `Load ${short(c.name)} → ${gpuName(c.service, c.gpu)}`
    case 'unload': return `Unload ${short(c.name)} from ${gpuName(c.service, c.gpu)}`
    case 'split': return `Split ${short(c.name)} across ${gpuName(c.service, c.gpus[0])} + ${gpuName(c.service, c.gpus[1])}`
    case 'unsplit': return `Unload split ${short(c.name)}`
    case 'pin': return `${c.pinned ? 'Pin' : 'Unpin'} ${short(c.name)} on ${gpuName(c.service, c.gpu)}`
    case 'warm': return `Cache ${short(c.name)} on ${c.node} (RAM${''} + mirror)`
    case 'evict': return `Evict ${short(c.name)} from ${c.node} ${c.tier === 'ram' ? 'RAM' : 'disk'} cache`
    case 'cachepin': return `${c.pinned ? 'Pin' : 'Unpin'} ${short(c.name)} in ${c.node} ${c.tier === 'ram' ? 'RAM' : 'disk'} cache`
  }
}

export class ModelMapStore {
  metrics: Record<string, { node: string; name: string; used: number | null; total: number | null }> = {}
  names: Record<string, string> = {}
  metricsError = ''
  changes: Change[] = []
  applying = false
  applyLog: { text: string; ok: boolean }[] = []
  hint = ''
  search = ''
  kindFilter = ''
  private timer: any = null

  constructor() { makeAutoObservable(this) }

  start(): void {
    imageModelsStore.start()
    void this.loadMetrics(); void this.loadNames()
    if (!this.timer) this.timer = setInterval(() => void this.loadMetrics(), 5000)
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  async loadMetrics(): Promise<void> {
    const api = (window as any).gyshell?.metrics
    if (!api?.query) { runInAction(() => { this.metricsError = 'metrics RPC unavailable' }); return }
    try {
      const res = await api.query(QUERY)
      const out: Record<string, { node: string; name: string; used: number | null; total: number | null }> = {}
      for (const r of (res?.result ?? []) as { labels: Record<string, string>; value: number | null }[]) {
        const l = r.labels || {}; const u = norm(l.uuid)
        if (!u) continue
        const g = out[u] = out[u] || { node: l.host || l.instance || '?', name: 'GPU', used: null, total: null }
        if (l.host) g.node = l.host
        if (l.__name__ === 'nvidia_smi_gpu_info' && l.name) g.name = l.name
        if (l.__name__ === 'nvidia_smi_memory_used_bytes') g.used = r.value
        if (l.__name__ === 'nvidia_smi_memory_total_bytes') g.total = r.value
      }
      runInAction(() => { this.metrics = out; this.metricsError = '' })
    } catch (e: any) { runInAction(() => { this.metricsError = String(e?.message || e) }) }
  }

  /** Friendly names follow each card by uuid (gpu-config.json via the enriched inventory). */
  async loadNames(): Promise<void> {
    try {
      const inv = await bridge()?.request?.('GET', '/api/gpu/inventory')
      const names: Record<string, string> = {}
      for (const data of Object.values(inv || {})) {
        for (const g of ((data as any)?.allGpus ?? [])) if (g?.uuid && g?.friendlyName) names[norm(g.uuid)] = g.friendlyName
      }
      runInAction(() => { this.names = names })
    } catch (e) { console.warn('[ModelMap] gpu inventory unavailable', e) }
  }

  // ── lookups over the overview ───────────────────────────────────────────────────────────────
  get services(): any[] { return imageModelsStore.nodes.flatMap((n: any) => (n.services || []).filter((s: any) => s.ok).map((s: any) => ({ ...s, _node: n.node }))) }
  service(id: string): any { return this.services.find((s) => s.id === id) }
  gpuName(service: string, gpu: number): string {
    const s = this.service(service)
    const u = norm(s?.service?.gpus?.[gpu]?.uuid)
    return this.names[u] || s?.gpuFriendly?.[gpu] || s?.service?.gpus?.[gpu]?.name || `GPU ${gpu}`
  }
  /** Best size we know for a model in VRAM: a MEASURED resident copy (per card) first - VRAM use can differ from the
   *  file's size - then the file size from a cache copy (on that node, then anywhere). */
  sizeOf(kind: string, name: string, node?: string): number | null {
    for (const s of this.services) for (const r of s.resident || []) {
      if (r.kind === kind && r.name === name && r.vram_gb && String(r.tier || 'hot').startsWith('hot')) return r.vram_gb / ((r.gpus || [0]).length || 1)
    }
    let any: number | null = null
    for (const n of imageModelsStore.nodes as any[]) {
      const e = n.cache?.entries?.[kind]
      for (const x of [...(e?.ram || []), ...(e?.optane || [])]) {
        if (x.name !== name || !x.size_gb) continue
        if (n.node === node) return x.size_gb
        any = any ?? x.size_gb
      }
    }
    return any
  }
  /** VRAM pins (core, claude2 2026-10-10): every core resident entry carries "pinned". With nothing core-loaded there is
   *  nothing to read, so assume support unless loaded entries prove an older core (an Apply against one just errors). */
  pinSupported(s: any): boolean {
    if (!s) return false
    const core = (s.resident || []).filter((r: any) => !r.plugin)
    return core.length === 0 || core.some((r: any) => 'pinned' in r)
  }

  // ── the projected picture: live state + staged changes ───────────────────────────────────────
  get view(): MapNode[] {
    const svcByUuid: Record<string, { s: any; i: number }> = {}
    for (const s of this.services) (s.service?.gpus || []).forEach((g: any, i: number) => { if (g?.uuid) svcByUuid[norm(g.uuid)] = { s, i } })
    const gpus: Record<string, MapGpu> = {}
    for (const [u, m] of Object.entries(this.metrics)) {
      const at = svcByUuid[u]
      gpus[u] = { uuid: u, node: m.node, label: this.names[u] || m.name.replace(/^NVIDIA (GeForce )?/i, ''),
        totalGb: (m.total || 0) / GIB, usedGb: (m.used || 0) / GIB, service: at?.s.id ?? null, svcIndex: at?.i ?? null,
        teSplit: !!at?.s.teSplit, pinSupported: this.pinSupported(at?.s), blocks: [], projectedGb: 0 }
    }
    const gpuOf = (service: string, idx: number): MapGpu | undefined => {
      const s = this.service(service); const u = norm(s?.service?.gpus?.[idx]?.uuid)
      return u ? gpus[u] : undefined
    }
    // live resident models
    for (const s of this.services) {
      for (const r of s.resident || []) {
        const idx: number[] = (r.gpus && r.gpus.length ? r.gpus : [r.gpu]).filter((x: any) => x != null)
        // VRAM share: the service's own vram_gb; a copy parked in RAM (tier 'loaded (offloaded…)') holds ~none
        const parked = !!r.tier && !String(r.tier).startsWith('hot')
        const total = r.vram_gb ?? (parked ? 0 : this.sizeOf(r.kind, r.name, s._node))
        const b: MapBlock = { id: `${s.id}|${r.kind}|${r.name}|${r.clip_type || ''}|${idx.join(',')}`, kind: r.kind, name: r.name,
          gb: total != null ? total / idx.length : null, service: s.id, gpus: idx, split: idx.length > 1, pinned: !!r.pinned,
          busy: !!r.busy, tier: r.tier || '', clipType: r.clip_type || undefined, plugin: r.plugin || undefined }
        for (const i of idx) gpuOf(s.id, i)?.blocks.push(b)
      }
    }
    // "other" usage per card = what nvidia-smi sees minus the service models it holds (CUDA contexts land here too)
    for (const g of Object.values(gpus)) {
      const known = g.blocks.reduce((a, b) => a + (b.gb || 0), 0)
      const other = Math.max(0, g.usedGb - known)
      if (other > 0.15) g.blocks.unshift({ id: `other|${g.uuid}`, kind: 'other', name: g.service ? 'other / overhead' : 'in use', gb: other,
        service: '', gpus: [], split: false, pinned: false, busy: false, tier: '', other: true })
    }
    // staged changes
    const find = (service: string, gpu: number, kind: string, name: string) =>
      gpuOf(service, gpu)?.blocks.find((b) => !b.other && b.kind === kind && b.name === name && b.staged !== 'remove')
    for (const c of this.changes) {
      if (c.t === 'load') {
        const g = gpuOf(c.service, c.gpu)
        g?.blocks.push({ id: `stage|${c.service}|${c.kind}|${c.name}|${c.gpu}`, kind: c.kind, name: c.name, gb: this.sizeOf(c.kind, c.name, g.node),
          service: c.service, gpus: [c.gpu], split: false, pinned: false, busy: false, tier: 'staged', clipType: c.clipType, staged: 'add' })
      } else if (c.t === 'unload') {
        const b = find(c.service, c.gpu, c.kind, c.name); if (b) b.staged = 'remove'
      } else if (c.t === 'split') {
        const size = this.sizeOf('te', c.name)
        const b: MapBlock = { id: `stage|split|${c.service}|${c.name}`, kind: 'te', name: c.name, gb: size != null ? size / 2 : null, service: c.service,
          gpus: [...c.gpus], split: true, pinned: false, busy: false, tier: 'staged', clipType: c.clipType, staged: 'add', plugin: 'te_split' }
        for (const i of c.gpus) gpuOf(c.service, i)?.blocks.push(b)
      } else if (c.t === 'unsplit') {
        for (const g of Object.values(gpus)) for (const b of g.blocks) if (b.service === c.service && b.split && b.name === c.name) b.staged = 'remove'
      } else if (c.t === 'pin') {
        const b = find(c.service, c.gpu, c.kind, c.name); if (b) b.pinNext = c.pinned
      }
    }
    for (const g of Object.values(gpus)) g.projectedGb = g.blocks.reduce((a, b) => a + (b.staged === 'remove' ? 0 : (b.gb || 0)), 0)

    // caches: RAM + persistent per host
    const caches: Record<string, CacheCyl[]> = {}
    for (const n of imageModelsStore.nodes as any[]) {
      const c = n.cache; if (!c?.enabled || !n.cacheService) continue
      const list: CacheCyl[] = []
      const mk = (tier: 'ram' | 'optane'): CacheCyl => {
        const blocks: CacheBlock[] = []
        for (const [kind, e] of Object.entries(c.entries || {})) for (const x of ((e as any)[tier] || [])) {
          blocks.push({ id: `${n.node}|${tier}|${kind}|${x.name}`, kind, name: x.name, gb: x.size_gb || 0, pinned: !!x.pinned, copying: !!x.copying })
        }
        blocks.sort((a, b) => a.kind.localeCompare(b.kind) || b.gb - a.gb)
        const capGb = tier === 'ram' ? Object.values(c.config?.quota_gb || {}).reduce((a: number, v: any) => a + (Number(v) || 0), 0)
          : Number(c.optane?.quota_gb || c.config?.optane_quota_gb || 0)
        const usedGb = tier === 'ram' ? Object.values(c.ram || {}).reduce((a: number, v: any) => a + (Number(v?.used_gb) || 0), 0) : Number(c.optane?.used_gb || 0)
        return { node: n.node, tier, label: tier === 'ram' ? 'RAM cache' : `${c.optane?.label || c.config?.persist_label || 'Disk'} cache`,
          service: n.cacheService, capGb, usedGb, blocks, projectedGb: 0 }
      }
      list.push(mk('ram'))
      if (c.optane?.root || c.config?.optane_root) list.push(mk('optane'))
      for (const ch of this.changes) {
        if ((ch.t === 'warm') && ch.node === n.node) {
          for (const cy of list) if (!cy.blocks.some((b) => b.kind === ch.kind && b.name === ch.name)) {
            cy.blocks.push({ id: `stage|${cy.tier}|${ch.kind}|${ch.name}`, kind: ch.kind, name: ch.name, gb: this.sizeOf(ch.kind, ch.name) || 0, pinned: false, staged: 'add' })
          }
        } else if ((ch.t === 'evict' || ch.t === 'cachepin') && ch.node === n.node) {
          const cy = list.find((x) => x.tier === ch.tier); const b = cy?.blocks.find((x) => x.kind === ch.kind && x.name === ch.name)
          if (b && ch.t === 'evict') b.staged = 'remove'
          if (b && ch.t === 'cachepin') b.pinNext = ch.pinned
        }
      }
      for (const cy of list) cy.projectedGb = cy.blocks.reduce((a, b) => a + (b.staged === 'remove' ? 0 : b.gb), 0)
      caches[n.node] = list
    }

    const byNode: Record<string, MapNode> = {}
    for (const g of Object.values(gpus)) (byNode[g.node] = byNode[g.node] || { node: g.node, gpus: [], caches: [] }).gpus.push(g)
    for (const [node, list] of Object.entries(caches)) (byNode[node] = byNode[node] || { node, gpus: [], caches: [] }).caches = list
    const nodes = Object.values(byNode)
    for (const n of nodes) n.gpus.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    // GPU-rich nodes first (px-gpu, px-epyc), then the rest
    return nodes.sort((a, b) => (b.gpus.filter((g) => g.service).length - a.gpus.filter((g) => g.service).length) || a.node.localeCompare(b.node))
  }

  /** Models a drop can load: everything the services list as available, de-duplicated, searchable. */
  get palette(): { kind: string; name: string; gb: number | null }[] {
    const seen = new Map<string, { kind: string; name: string; gb: number | null }>()
    for (const s of this.services) for (const [kind, names] of Object.entries(s.available || {})) {
      if (this.kindFilter && kind !== this.kindFilter) continue
      for (const name of names as string[]) {
        const k = `${kind}\u0000${name}`
        if (!seen.has(k)) seen.set(k, { kind, name, gb: null })
      }
    }
    const q = this.search.trim().toLowerCase()
    const out = [...seen.values()].filter((m) => !q || m.name.toLowerCase().includes(q))
    out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    return out.slice(0, 400).map((m) => ({ ...m, gb: this.sizeOf(m.kind, m.name) }))
  }
  get paletteKinds(): string[] {
    const k = new Set<string>()
    for (const s of this.services) for (const kind of Object.keys(s.available || {})) k.add(kind)
    return [...k].sort()
  }

  setSearch(v: string): void { this.search = v }
  setKindFilter(v: string): void { this.kindFilter = v }
  setHint(v: string): void { this.hint = v }

  // ── staging ────────────────────────────────────────────────────────────────────────────────
  private push(c: Change): void { this.changes.push(c); this.hint = ''; this.applyLog = [] }

  stageLoad(kind: string, name: string, service: string, gpu: number, clipType?: string): void {
    const s = this.service(service)
    if (!s) { this.hint = 'That card is not part of an Image Model Service - only service GPUs can load models.'; return }
    if (s.service?.kinds && !s.service.kinds.includes(kind)) { this.hint = `${this.gpuName(service, gpu)}'s service doesn't serve ${kind} models.`; return }
    // undoing a staged unload of the same copy is just dropping that change
    const u = this.changes.findIndex((c) => c.t === 'unload' && c.service === service && c.gpu === gpu && c.kind === kind && c.name === name)
    if (u >= 0) { this.changes.splice(u, 1); return }
    const already = (s.resident || []).some((r: any) => r.kind === kind && r.name === name && (r.gpus?.length ? r.gpus : [r.gpu]).includes(gpu))
      || this.changes.some((c) => c.t === 'load' && c.service === service && c.gpu === gpu && c.kind === kind && c.name === name)
    if (already) { this.hint = `${name.split('/').pop()} is already on ${this.gpuName(service, gpu)}.`; return }
    if (kind === 'te' && !clipType && /qwen/i.test(name)) clipType = 'qwen_image'
    this.push({ t: 'load', service, kind, name, gpu, clipType })
  }

  stageUnload(b: MapBlock): void {
    if (b.other) return
    if (b.staged === 'add') {      // un-stage it instead
      this.changes = this.changes.filter((c) => !((c.t === 'load' && c.service === b.service && c.kind === b.kind && c.name === b.name && b.gpus.includes(c.gpu))
        || (c.t === 'split' && c.service === b.service && c.name === b.name)))
      return
    }
    if (b.pinned && b.pinNext !== false) { this.hint = `${b.name.split('/').pop()} is pinned - untick its pin first.`; return }
    if (b.split) this.push({ t: 'unsplit', service: b.service, name: b.name })
    else this.push({ t: 'unload', service: b.service, kind: b.kind, name: b.name, gpu: b.gpus[0], clipType: b.clipType })
  }

  /** Stretch a text encoder from its card onto a 2nd card of the same service (te_split plugin). */
  stageSplit(b: MapBlock, service: string, gpu: number): void {
    if (b.kind !== 'te') { this.hint = 'Only text encoders can be split across GPUs.'; return }
    if (b.service !== service) { this.hint = 'A split stays inside one service - stretch it onto a card of the same node.'; return }
    if (b.split) { this.hint = 'Already split.'; return }
    if (b.gpus[0] === gpu) return
    const s = this.service(service)
    if (!s?.teSplit) { this.hint = `${s?._node || 'This node'}'s service has no te_split plugin, so it can't split encoders.`; return }
    const ct = b.clipType || (/qwen/i.test(b.name) ? 'qwen_image' : 'qwen_image')
    if (b.staged === 'add') {   // a staged load becomes a staged split
      this.changes = this.changes.filter((c) => !(c.t === 'load' && c.service === service && c.kind === 'te' && c.name === b.name))
      this.push({ t: 'split', service, name: b.name, gpus: [b.gpus[0], gpu], clipType: ct })
      return
    }
    this.push({ t: 'split', service, name: b.name, gpus: [b.gpus[0], gpu], clipType: ct })
    this.push({ t: 'unload', service, kind: 'te', name: b.name, gpu: b.gpus[0], clipType: b.clipType })   // the single-card copy goes
  }

  stagePin(b: MapBlock, pinned: boolean): void {
    const s = this.service(b.service)
    if (b.plugin) { this.hint = `${b.name.split('/').pop()} is held by the ${b.plugin} plugin - VRAM pins cover the service's own copies only.`; return }
    if (!this.pinSupported(s)) { this.hint = 'VRAM pinning needs the pin support in the model service (claude2 is adding it).'; return }
    const i = this.changes.findIndex((c) => c.t === 'pin' && c.service === b.service && c.name === b.name && c.gpu === b.gpus[0])
    if (i >= 0) { this.changes.splice(i, 1); return }
    this.push({ t: 'pin', service: b.service, kind: b.kind, name: b.name, gpu: b.gpus[0], pinned, clipType: b.clipType })
  }

  stageWarm(cy: CacheCyl, kind: string, name: string): void {
    if (cy.blocks.some((b) => b.kind === kind && b.name === name && b.staged !== 'remove')) { this.hint = `Already in ${cy.node}'s ${cy.label}.`; return }
    const i = this.changes.findIndex((c) => c.t === 'evict' && c.node === cy.node && c.kind === kind && c.name === name)
    if (i >= 0) { this.changes.splice(i, 1); return }
    this.push({ t: 'warm', node: cy.node, service: cy.service, kind, name })
  }
  stageEvict(cy: CacheCyl, b: CacheBlock): void {
    if (b.staged === 'add') { this.changes = this.changes.filter((c) => !(c.t === 'warm' && c.node === cy.node && c.kind === b.kind && c.name === b.name)); return }
    if (b.pinned && b.pinNext !== false) { this.hint = `${b.name.split('/').pop()} is pinned in this cache - untick its pin first.`; return }
    this.push({ t: 'evict', node: cy.node, service: cy.service, kind: b.kind, name: b.name, tier: cy.tier })
  }
  stageCachePin(cy: CacheCyl, b: CacheBlock, pinned: boolean): void {
    const i = this.changes.findIndex((c) => c.t === 'cachepin' && c.node === cy.node && c.tier === cy.tier && c.name === b.name)
    if (i >= 0) { this.changes.splice(i, 1); return }
    this.push({ t: 'cachepin', node: cy.node, service: cy.service, kind: b.kind, name: b.name, tier: cy.tier, pinned })
  }

  undo(): void { this.changes.pop(); this.hint = '' }
  removeChange(i: number): void { this.changes.splice(i, 1) }
  clear(): void { this.changes = []; this.hint = '' }

  // ── apply ──────────────────────────────────────────────────────────────────────────────────
  async apply(): Promise<void> {
    if (this.applying || !this.changes.length) return
    this.applying = true; this.applyLog = []; this.hint = ''
    const todo = [...this.changes].sort((a, b) => ORDER.indexOf(a.t) - ORDER.indexOf(b.t))
    const failed: Change[] = []
    for (const c of todo) {
      const label = changeLabel(c, (s, g) => this.gpuName(s, g))
      let path = '', body: any = {}
      switch (c.t) {
        case 'load': path = '/models/load'; body = { kind: c.kind, name: c.name, gpu: c.gpu, ...(c.clipType ? { clip_type: c.clipType } : {}) }; break
        case 'unload': path = '/models/unload'; body = { kind: c.kind, name: c.name, gpu: c.gpu, ...(c.clipType ? { clip_type: c.clipType } : {}) }; break
        case 'split': path = '/te_split'; body = { model: c.name, clip_type: c.clipType, gpus: c.gpus }; break
        case 'unsplit': path = '/te_split/remove'; body = { model: c.name }; break
        case 'pin': path = '/models/pin'; body = { kind: c.kind, name: c.name, gpu: c.gpu, pinned: c.pinned, ...(c.clipType ? { clip_type: c.clipType } : {}) }; break
        case 'warm': path = '/cache/warm'; body = { kind: c.kind, name: c.name }; break
        case 'evict': path = '/cache/evict'; body = { kind: c.kind, name: c.name, tier: c.tier }; break
        case 'cachepin': path = '/cache/pin'; body = { kind: c.kind, name: c.name, pinned: c.pinned, tier: c.tier }; break
      }
      try {
        const r: any = await bridge().request('POST', '/api/ai/imagegen-models/action', { service: c.service, path, body })
        if (r?.error) throw new Error(r.error)
        if (c.t === 'split' && r && r.ok === false) throw new Error(r.error || 'split failed to load')
        runInAction(() => { this.applyLog.push({ text: `✓ ${label}${r?.loading ? ' (loading in the background)' : ''}`, ok: true }) })
      } catch (e: any) {
        failed.push(c)
        runInAction(() => { this.applyLog.push({ text: `✗ ${label}: ${e?.message || e}`, ok: false }) })
      }
    }
    runInAction(() => { this.changes = failed; this.applying = false })   // failed ones stay staged, to retry or undo
    await imageModelsStore.load(true); await this.loadMetrics()
    setTimeout(() => { void imageModelsStore.load(true); void this.loadMetrics() }, 6000)   // loads finish in the background
  }
}

export const modelMapStore = new ModelMapStore()
