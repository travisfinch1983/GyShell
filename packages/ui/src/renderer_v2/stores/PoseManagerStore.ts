import { makeAutoObservable, runInAction } from 'mobx'

const BASE = '/api/imagegen'

export interface Pose {
  id: string
  index: number
  name: string
  prompt: string
  category: string
  view: string
  image: string
  /** BASE-relative path for /thumb and /image — the server builds it so the UI never guesses. */
  rel: string
  /** Grey-mannequin version of this pose (pose → mannequin conversion), if one was made. */
  mannequin?: string
  mannequin_at?: number
  mannequin_rel?: string | null
}

export interface MqGpu { index: number; name: string; uuid: string; totalMB: number; usedMB: number; freeMB: number; computeCap: string; warn: string[]; avoid: boolean }
export interface MqHost { label: string; disabled: string | null; gpus: MqGpu[] }
export interface MqSettings { auto: boolean; host: string; gpus: number[]; quant: 'int8' | 'bf16'; te: 'int8' | 'bf16'; steps: number; outpaint: 'auto' | 'off' | 'always' }
export interface MqJob {
  id: string; state: 'running' | 'done' | 'error' | 'cancelled'; host: string; gpus: number[]; total: number; done: number; ok: number; errors: number
  results: Record<string, { status: 'ok' | 'error'; error?: string; secs?: number }>; error: string | null; lastError: string | null; auto: boolean
  ids: string[]; startedAt: number; finishedAt: number | null
  workers: { gpu: number; state: string; done: number; total: number; error: string | null }[]
}
export type MqStartOpts = Omit<MqSettings, 'auto'> & { extra_prompt?: string }

async function api(path: string, init?: { method?: string; body?: any }) {
  const res = await fetch(BASE + path, {
    method: init?.method || 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

export class PoseManagerStore {
  poses: Pose[] = []
  categories: string[] = []
  views: string[] = []
  loading = false
  error = ''
  msg = ''
  /** Poses edited but not yet written, keyed by id. */
  drafts = new Map<string, Partial<Pose>>()
  filterText = ''
  filterCategory = ''
  filterView = ''
  /** Set once a pose is added or removed. Prompt edits reach the gallery on a browser
   *  refresh, but the NODE builds its pose list in INPUT_TYPES at registration time, so
   *  membership changes need a ComfyUI restart before the node sees them. */
  restartRequired = false

  // ── pose → mannequin ──
  /** Poses ticked for a batch action (conversion). */
  selected = new Set<string>()
  mqHosts: Record<string, MqHost> = {}
  mqMinFreeMB = 15000
  mqGpuError = ''
  mqSettings: MqSettings = { auto: false, host: 'ai-epyc', gpus: [], quant: 'int8', te: 'int8', steps: 25, outpaint: 'auto' }
  mqJobs: MqJob[] = []
  private mqTimer: ReturnType<typeof setTimeout> | null = null

  constructor() { makeAutoObservable(this) }

  toggleSelect(id: string) { const n = new Set(this.selected); if (n.has(id)) n.delete(id); else n.add(id); this.selected = n }
  selectVisible() { this.selected = new Set([...this.selected, ...this.visible.map((p) => p.id)]) }
  selectWithoutMannequin() { this.selected = new Set(this.visible.filter((p) => !p.mannequin).map((p) => p.id)) }
  clearSelection() { this.selected = new Set() }
  get runningMqJobs(): MqJob[] { return this.mqJobs.filter((j) => j.state === 'running') }
  /** Pose ids currently being converted (cards show a spinner instead of a redo button). */
  get converting(): Set<string> {
    const s = new Set<string>()
    for (const j of this.runningMqJobs) for (const id of j.ids) if (!j.results[id]) s.add(id)
    return s
  }

  async loadMqGpus() {
    try {
      const d = await api('/poses/mannequin/gpus')
      runInAction(() => { this.mqHosts = d.hosts || {}; this.mqMinFreeMB = d.min_free_mb || 15000; this.mqGpuError = '' })
    } catch (e: any) { runInAction(() => { this.mqGpuError = String(e?.message || e) }) }
  }
  async loadMqSettings() {
    try { const d = await api('/poses/mannequin/settings'); runInAction(() => { this.mqSettings = d.settings }) } catch { /* defaults */ }
  }
  async saveMqSettings(next: MqSettings) {
    const d = await api('/poses/mannequin/settings', { method: 'POST', body: next })
    runInAction(() => { this.mqSettings = d.settings; this.msg = d.settings.auto ? 'Auto-convert is ON for new poses.' : 'Mannequin settings saved.' })
  }
  async startMannequin(ids: string[], opts: MqStartOpts) {
    const d = await api('/poses/mannequin/start', { method: 'POST', body: { ids, ...opts } })
    runInAction(() => { this.mqJobs = [d.job, ...this.mqJobs.filter((j) => j.id !== d.job.id)]; this.msg = `Converting ${ids.length} pose${ids.length === 1 ? '' : 's'}…` })
    this.pollMq()
    return d.job as MqJob
  }
  async cancelMannequin(jobId: string) {
    await api('/poses/mannequin/cancel', { method: 'POST', body: { jobId } })
    this.pollMq()
  }
  async removeMannequin(id: string) {
    const d = await api('/poses/mannequin/remove', { method: 'POST', body: { id } })
    runInAction(() => { const i = this.poses.findIndex((p) => p.id === id); if (i >= 0) this.poses[i] = d.pose; this.msg = `Removed the mannequin version of ${id}.` })
  }
  /** Poll while any conversion runs; finished poses get their mannequin thumbnail as they land. */
  async pollMq() {
    if (this.mqTimer) { clearTimeout(this.mqTimer); this.mqTimer = null }
    try {
      const d = await api('/poses/mannequin/jobs')
      const before = this.mqJobs.reduce((n, j) => n + j.ok, 0)
      runInAction(() => { this.mqJobs = d.jobs || [] })
      const after = (d.jobs || []).reduce((n: number, j: MqJob) => n + j.ok, 0)
      if (after !== before) await this.refreshMannequins()
    } catch { /* retry */ }
    if (this.runningMqJobs.length) this.mqTimer = setTimeout(() => void this.pollMq(), 4000)
  }
  /** Merge mannequin fields from the server without touching unsaved prompt drafts. */
  async refreshMannequins() {
    try {
      const d = await api('/poses')
      runInAction(() => {
        const byId = new Map<string, Pose>((d.poses || []).map((p: Pose) => [p.id, p]))
        this.poses = this.poses.map((p) => { const n = byId.get(p.id); return n ? { ...p, mannequin: n.mannequin, mannequin_at: n.mannequin_at, mannequin_rel: n.mannequin_rel } : p })
      })
    } catch { /* next poll */ }
  }

  get visible(): Pose[] {
    const q = this.filterText.trim().toLowerCase()
    return this.poses.filter((p) => {
      if (this.filterCategory && p.category !== this.filterCategory) return false
      if (this.filterView && p.view !== this.filterView) return false
      if (!q) return true
      return `${p.name} ${p.prompt} ${p.category} ${p.view}`.toLowerCase().includes(q)
    })
  }

  get dirtyCount(): number { return this.drafts.size }

  async load() {
    this.loading = true; this.error = ''
    try {
      const d = await api('/poses')
      runInAction(() => {
        this.poses = d.poses || []
        this.categories = d.categories || []
        this.views = d.views || []
      })
    } catch (e: any) {
      runInAction(() => { this.error = String(e?.message || e) })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  /** Local edit only — nothing reaches disk until save(). A mistyped prompt can be
   *  abandoned, and a slow network cannot leave the library half-written. */
  edit(id: string, field: 'prompt' | 'category' | 'view', value: string) {
    const pose = this.poses.find((p) => p.id === id)
    if (!pose) return
    const draft: Record<string, string> = { ...(this.drafts.get(id) as any || {}) }
    if (value === (pose as any)[field]) delete draft[field]
    else draft[field] = value
    if (Object.keys(draft).length) this.drafts.set(id, draft as Partial<Pose>)
    else this.drafts.delete(id)
    this.drafts = new Map(this.drafts)
  }

  draftValue(pose: Pose, field: 'prompt' | 'category' | 'view'): string {
    const draft = this.drafts.get(pose.id) as any
    const v = draft && draft[field]
    return v !== undefined ? v : ((pose as any)[field] || '')
  }

  async save(id: string) {
    const draft = this.drafts.get(id)
    if (!draft) return
    this.msg = 'Saving…'
    try {
      const d = await api('/poses/update', { method: 'POST', body: { id, ...draft } })
      runInAction(() => {
        const i = this.poses.findIndex((p) => p.id === id)
        if (i >= 0) this.poses[i] = d.pose
        this.drafts.delete(id); this.drafts = new Map(this.drafts)
        this.msg = `Saved ${d.pose.name}.`
      })
    } catch (e: any) {
      runInAction(() => { this.msg = 'Failed: ' + String(e?.message || e) })
    }
  }

  async saveAll() {
    const ids = [...this.drafts.keys()]
    if (!ids.length) return
    this.msg = `Saving ${ids.length}…`
    let ok = 0
    for (const id of ids) {
      try {
        const d = await api('/poses/update', { method: 'POST', body: { id, ...this.drafts.get(id) } })
        runInAction(() => {
          const i = this.poses.findIndex((p) => p.id === id)
          if (i >= 0) this.poses[i] = d.pose
          this.drafts.delete(id)
        })
        ok += 1
      } catch (e: any) {
        // STOP on the first failure rather than pressing on: the remaining drafts stay
        // in the tray so it is obvious what did NOT save, instead of a partial write
        // being reported as success.
        runInAction(() => { this.msg = `Stopped at ${id}: ${String(e?.message || e)}` })
        break
      }
    }
    runInAction(() => {
      this.drafts = new Map(this.drafts)
      if (!this.drafts.size) this.msg = `Saved ${ok} pose${ok === 1 ? '' : 's'}.`
    })
  }

  revert(id: string) { this.drafts.delete(id); this.drafts = new Map(this.drafts) }
  revertAll() { this.drafts = new Map() }

  async add(body: { prompt: string; category: string; view: string; name?: string; source_path?: string }) {
    const d = await api('/poses/add', { method: 'POST', body })
    runInAction(() => {
      this.poses.push(d.pose)
      this.poses.sort((a, b) => (a.index || 0) - (b.index || 0))
      this.restartRequired = true
      this.msg = `Added ${d.pose.name}.`
    })
    return d.pose as Pose
  }

  async remove(id: string) {
    const d = await api('/poses/delete', { method: 'POST', body: { id } })
    runInAction(() => {
      this.poses = this.poses.filter((p) => p.id !== id)
      this.drafts.delete(id); this.drafts = new Map(this.drafts)
      this.restartRequired = true
      this.msg = `Deleted ${id}. ${d.remaining} remain.`
    })
  }
}

export const poseManagerStore = new PoseManagerStore()
