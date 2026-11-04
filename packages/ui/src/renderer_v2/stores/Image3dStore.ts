import { makeAutoObservable, runInAction } from 'mobx'

/**
 * Image → 3D (claude1 2026-11-03). Talks to /api/imagegen/image3d/*, which the backend relays to the image model
 * service's image3d plugin (ai-epyc :9310, /opt/ailab-modelsvc/plugins/image3d.py). Plain same-origin fetch, not the
 * WS bridge: uploads carry base64 photos and the viewer downloads 50-75 MB model files.
 */
const BASE = '/api/imagegen/image3d'

export type OptSpec = number | string | boolean | { default: number | string; choices: (number | string)[] }
export interface GpuChoice { index: number; name: string; ok: boolean; why: string; service: string; host: string }
export interface Model3d {
  id: string; label: string; input: 'single' | 'multi'; output: 'mesh' | 'splat'; vram_gb: number
  time: string; notes: string; options: Record<string, OptSpec>; gpus: GpuChoice[]; archs: string[] | null
}
export interface GpuInfo { index: number; name: string; total_gb: number; free_gb: number; queue?: number; service: string; host: string }
export interface Job3d {
  id: string; name: string; model: string; model_label: string; output_type: 'mesh' | 'splat'
  gpu: number; gpu_name: string; host?: string; service?: string; status: 'queued' | 'loading' | 'running' | 'done' | 'error' | 'cancelled'
  stage?: string; progress?: number; elapsed_s?: number; load_s?: number; error?: string; output?: string
  created: number; started?: number; finished?: number; inputs: string[]; files?: string[]
  options: Record<string, unknown>; result?: Record<string, unknown>; note?: string
}
export interface Upload { name: string; dataUrl: string; size: number }

const ACTIVE = new Set(['queued', 'loading', 'running'])
export const gpuKey = (g: { service: string; index: number }) => `${g.service}|${g.index}`
export const shortGpu = (n?: string) => (n || '').replace(/^NVIDIA (GeForce )?/, '').replace(/^Tesla /, '').replace(/-SXM2-32GB$/, '')

async function call<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || (data && data.error)) throw new Error(data?.error || `HTTP ${res.status}`)
  return data as T
}

const readFile = (f: File) => new Promise<Upload>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve({ name: f.name, dataUrl: String(r.result), size: f.size })
  r.onerror = () => reject(r.error || new Error(`could not read ${f.name}`))
  r.readAsDataURL(f)
})

class Image3dStore {
  models: Model3d[] = []
  gpus: GpuInfo[] = []
  jobs: Job3d[] = []
  error = ''
  loading = false
  submitting = false
  // form
  modelId = 'trellis2'
  /** 'auto' or '<service id>|<gpu index>' (the backend merges every host's image model service) */
  gpu = 'auto'
  name = ''
  uploads: Upload[] = []
  options: Record<string, number | string | boolean> = {}
  // viewer
  selectedId = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private watchers = 0

  constructor() { makeAutoObservable(this) }

  get model(): Model3d | undefined { return this.models.find((m) => m.id === this.modelId) }
  get active(): Job3d[] { return this.jobs.filter((j) => ACTIVE.has(j.status)) }
  get done(): Job3d[] { return this.jobs.filter((j) => j.status === 'done') }
  get selected(): Job3d | undefined { return this.jobs.find((j) => j.id === this.selectedId) }
  get usableGpus(): GpuChoice[] { return (this.model?.gpus || []).filter((g) => g.ok) }

  fileUrl(j: Job3d, path?: string, download = false) {
    const q = new URLSearchParams({ id: j.id })
    if (path) q.set('path', path)
    if (download) q.set('download', '1')
    return `${BASE}/file?${q}`
  }
  zipUrl(j: Job3d) { return `${BASE}/zip?${new URLSearchParams({ id: j.id, download: '1' })}` }
  thumbUrl(j: Job3d) { return this.fileUrl(j, 'thumb.jpg') }

  async load() {
    this.loading = true
    try {
      const [m, j] = await Promise.all([call<{ models: Model3d[]; gpus: GpuInfo[] }>('/models'), call<{ jobs: Job3d[] }>('/jobs')])
      runInAction(() => {
        this.models = m.models; this.gpus = m.gpus; this.jobs = j.jobs; this.error = ''
        if (!this.models.find((x) => x.id === this.modelId) && this.models[0]) this.setModel(this.models[0].id)
        else if (!Object.keys(this.options).length) this.resetOptions()
        if (!this.selectedId && this.done[0]) this.selectedId = this.done[0].id
      })
    } catch (e: any) {
      runInAction(() => { this.error = `Image → 3D service: ${e.message}` })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  async refreshJobs() {
    try {
      const j = await call<{ jobs: Job3d[] }>('/jobs')
      runInAction(() => { this.jobs = j.jobs })
    } catch (e: any) {
      runInAction(() => { this.error = `Image → 3D service: ${e.message}` })
    }
  }

  /** poll while any job is active; panels call watch() on mount and unwatch() on unmount */
  watch() {
    this.watchers++
    if (!this.timer) this.timer = setInterval(() => { if (this.active.length) this.refreshJobs() }, 3000)
  }
  unwatch() {
    this.watchers = Math.max(0, this.watchers - 1)
    if (!this.watchers && this.timer) { clearInterval(this.timer); this.timer = null }
  }

  setModel(id: string) {
    this.modelId = id
    this.resetOptions()
    if (this.gpu !== 'auto' && !this.usableGpus.find((g) => gpuKey(g) === this.gpu)) this.gpu = 'auto'
  }
  resetOptions() {
    const o: Record<string, number | string | boolean> = {}
    for (const [k, v] of Object.entries(this.model?.options || {})) o[k] = typeof v === 'object' ? v.default : v
    this.options = o
  }
  setOption(k: string, v: number | string | boolean) { this.options = { ...this.options, [k]: v } }
  setGpu(v: string) { this.gpu = v }
  setName(v: string) { this.name = v }

  async addFiles(list: FileList | File[]) {
    const files = Array.from(list).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name))
    try {
      const ups = await Promise.all(files.map(readFile))
      runInAction(() => {
        this.uploads = [...this.uploads, ...ups]
        if (!this.name && ups[0]) this.name = ups[0].name.replace(/\.[^.]+$/, '').replace(/[-_ ]?\d+$/, '')
      })
    } catch (e: any) {
      runInAction(() => { this.error = e.message })
    }
  }
  removeUpload(i: number) { this.uploads = this.uploads.filter((_, k) => k !== i) }
  moveFirst(i: number) { const u = [...this.uploads]; const [x] = u.splice(i, 1); this.uploads = [x, ...u] }
  clearUploads() { this.uploads = []; this.name = '' }

  async submit() {
    if (!this.model || !this.uploads.length) return
    this.submitting = true
    try {
      const imgs = this.model.input === 'single' ? this.uploads.slice(0, 1) : this.uploads
      const j = await call<Job3d>('/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelId, gpu: this.gpu, name: this.name || undefined,
          options: this.options, images: imgs.map((u) => ({ name: u.name, data: u.dataUrl })) }),
      })
      runInAction(() => { this.jobs = [j, ...this.jobs.filter((x) => x.id !== j.id)]; this.error = '' })
    } catch (e: any) {
      runInAction(() => { this.error = `Could not start: ${e.message}` })
    } finally {
      runInAction(() => { this.submitting = false })
    }
  }

  async cancel(j: Job3d) {
    try { await call('/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: j.id }) }) }
    catch (e: any) { runInAction(() => { this.error = `Cancel failed: ${e.message}` }) }
    this.refreshJobs()
  }

  async remove(j: Job3d) {
    try {
      await call('/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: j.id }) })
      runInAction(() => {
        this.jobs = this.jobs.filter((x) => x.id !== j.id)
        if (this.selectedId === j.id) this.selectedId = this.done[0]?.id || ''
      })
    } catch (e: any) { runInAction(() => { this.error = `Delete failed: ${e.message}` }) }
  }

  select(id: string) { this.selectedId = id }
  clearError() { this.error = '' }
}

export const image3dStore = new Image3dStore()
