import { makeAutoObservable, runInAction } from 'mobx'

/**
 * DetectorTrainingStore — AI · Image Gen -> Detector Training.
 *
 * Wraps /api/dataset/train/*, which proxies to the trainer on ai-epyc. Two things shape it:
 *
 *  - GPUs ARE CHOSEN BY NAME. An index says nothing about which card it is, and CUDA's
 *    default ordering disagrees with nvidia-smi's on that host, so an index picked here can
 *    mean a different card there. Every request sends an alias ("5060ti-3").
 *  - THE SERVER DECIDES, NOT THIS STORE. VRAM fit, name collisions and "already training"
 *    are all re-checked at launch, because anything this store knows is a snapshot that
 *    another session can invalidate between render and click. The form only has to make the
 *    likely refusals visible BEFORE the click; it never substitutes for them.
 */
export interface GpuRec {
  index: number; alias: string; name: string
  total_mib: number; free_mib: number; utilization_pct: number | null
  processes: { pid: string; used_mib: number | null; name: string }[]
}
export interface BaseModelRec {
  path: string; label: string; kind: 'stock' | 'detector'
  trained: boolean; size_mib: number; warn?: string
}
export interface DatasetRec {
  name: string; tiles: number; sources: number; trainable_tiles: number
  positives: number; negatives: number; held_back: number
  status: Record<string, number>
}
export interface RunRec {
  dataset: string; run: string; dir: string; modified: number
  state?: string; pid?: number | null; epochs?: number; epochs_done?: number
  imgsz?: number; batch?: number; gpu?: string; gpu_index?: number
  base_model?: string; base_is_trained?: boolean
  tiles?: number; positives?: number; negatives?: number
  has_weights?: boolean; best_pt?: string | null
  metrics?: Record<string, number>; elapsed_s?: number
  error?: string; note?: string; log_tail?: string; started?: number
}

const num = (v: string, lo: number, hi: number, dflt: number) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt
}

export class DetectorTrainingStore {
  datasets: DatasetRec[] = []
  baseModels: BaseModelRec[] = []
  gpus: GpuRec[] = []
  runs: RunRec[] = []

  dataset = ''
  runName = ''
  baseModel = ''
  gpu = ''
  epochs = 150
  imgsz = 640
  batch = 8
  valFrac = 0.15
  seed = 0
  allowLowVram = false

  selected = ''            // "<dataset>/<run>" being watched
  detail: RunRec | null = null
  loading = false
  starting = false
  error = ''
  refusal: any = null      // the server's structured refusal, rendered in full
  notice = ''
  private timer: any = null

  constructor() { makeAutoObservable(this) }

  get datasetRec() { return this.datasets.find((d) => d.name === this.dataset) }
  get baseRec() { return this.baseModels.find((m) => m.path === this.baseModel) }
  get gpuRec() { return this.gpus.find((g) => g.alias === this.gpu) }

  /** Same shape as the server's estimate, so the form warns with the number that will refuse it. */
  get vramEstimate() { return Math.round((2600 + 460 * this.batch) * Math.pow(Math.max(320, this.imgsz) / 640, 2)) }
  get vramTight() { const g = this.gpuRec; return !!g && g.free_mib < this.vramEstimate }

  get runningHere() {
    return this.runs.find((r) => r.state === 'running' && r.gpu === this.gpu)
  }
  /** Blocking problems the form can see up front. The server re-checks all of them. */
  get formErrors(): string[] {
    const e: string[] = []
    if (!this.dataset) e.push('choose a dataset')
    else if ((this.datasetRec?.trainable_tiles ?? 0) < 10) e.push('this dataset has almost nothing labelled yet')
    if (!this.baseModel) e.push('choose a base model')
    if (!this.gpu) e.push('choose a GPU')
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.runName)) e.push('run name: letters, digits, . _ - (1-64)')
    else if (this.runs.some((r) => r.dataset === this.dataset && r.run === this.runName))
      e.push(`"${this.runName}" already exists for this dataset`)
    return e
  }

  set<K extends keyof this>(k: K, v: this[K]) { this[k] = v }
  setNum(k: 'epochs' | 'imgsz' | 'batch' | 'seed', v: string) {
    const lim = { epochs: [1, 1000, 150], imgsz: [320, 1536, 640], batch: [1, 64, 8], seed: [0, 99999, 0] } as const
    const [lo, hi, d] = lim[k]
    this[k] = num(v, lo, hi, d)
  }

  async loadOptions() {
    this.loading = true; this.error = ''
    try {
      const r = await fetch('/api/dataset/train/options')
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      runInAction(() => {
        this.datasets = d.datasets || []
        this.baseModels = d.base_models || []
        this.gpus = d.gpus || []
        if (!this.dataset && this.datasets.length) this.dataset = this.datasets[0].name
        // Default to STOCK weights. Fine-tuning the previous detector is offered but is
        // never the default: it compounds the last round's errors and makes the run
        // irreproducible from stock + a dataset.
        if (!this.baseModel) this.baseModel = (this.baseModels.find((m) => !m.trained) || this.baseModels[0])?.path || ''
        if (!this.gpu) {
          const fit = this.gpus.filter((g) => g.free_mib >= this.vramEstimate)
          this.gpu = (fit.sort((a, b) => b.free_mib - a.free_mib)[0] || null)?.alias || ''
        }
        if (!this.runName) this.runName = this.suggestName()
      })
    } catch (e: any) {
      runInAction(() => { this.error = `could not load training options: ${e.message}` })
    } finally {
      runInAction(() => { this.loading = false })
    }
    await this.loadRuns()
  }

  suggestName() {
    // v1, v2, v3... after whatever already exists for this dataset, so a name collision
    // (which the server refuses outright) is not the default experience.
    const used = new Set(this.runs.filter((r) => r.dataset === this.dataset).map((r) => r.run))
    for (let i = 1; i < 999; i++) if (!used.has(`v${i}`)) return `v${i}`
    return ''
  }

  async loadRuns() {
    try {
      const r = await fetch('/api/dataset/train/runs')
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      runInAction(() => {
        this.runs = d.runs || []
        if (!this.runName) this.runName = this.suggestName()
        if (!this.selected) {
          const live = this.runs.find((x) => x.state === 'running')
          if (live) this.watch(live.dataset, live.run)
        }
      })
    } catch (e: any) {
      runInAction(() => { this.error = `could not list runs: ${e.message}` })
    }
  }

  watch(dataset: string, run: string) {
    this.selected = `${dataset}/${run}`
    this.detail = null
    this.poll()
    if (this.timer) clearInterval(this.timer)
    // 5s: an epoch on this dataset is ~9s, so this samples every epoch or two without
    // making the trainer's own host serve a request per second.
    this.timer = setInterval(() => this.poll(), 5000)
  }

  stopWatching() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.selected = ''; this.detail = null
  }

  async poll() {
    if (!this.selected) return
    const [dataset, run] = this.selected.split('/')
    try {
      const r = await fetch(`/api/dataset/train/status?dataset=${encodeURIComponent(dataset)}&run=${encodeURIComponent(run)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      runInAction(() => { this.detail = d })
      // Stop polling once it is finished, and refresh the list so the run's final metrics
      // and its weights land in the table without a manual reload.
      if (d.state && d.state !== 'running' && d.state !== 'launching') {
        if (this.timer) { clearInterval(this.timer); this.timer = null }
        this.loadRuns()
      }
    } catch (e: any) {
      runInAction(() => { this.error = `status: ${e.message}` })
    }
  }

  async start() {
    this.starting = true; this.error = ''; this.refusal = null; this.notice = ''
    try {
      const r = await fetch('/api/dataset/train', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset: this.dataset, run_name: this.runName, base_model: this.baseModel,
          gpu: this.gpu, epochs: this.epochs, imgsz: this.imgsz, batch: this.batch,
          val_frac: this.valFrac, seed: this.seed, allow_low_vram: this.allowLowVram,
        }),
      })
      const d = await r.json()
      if (!r.ok) { runInAction(() => { this.refusal = d }); return false }
      runInAction(() => {
        this.notice = `started ${d.run} on ${d.gpu} — ${d.tiles} tiles, ${d.epochs} epochs`
        this.allowLowVram = false      // an override is for ONE launch, never sticky
      })
      await this.loadRuns()
      this.watch(this.dataset, this.runName)
      runInAction(() => { this.runName = this.suggestName() })
      return true
    } catch (e: any) {
      runInAction(() => { this.error = `could not start training: ${e.message}` })
      return false
    } finally {
      runInAction(() => { this.starting = false })
    }
  }

  async stopRun(dataset: string, run: string) {
    this.error = ''
    try {
      const r = await fetch('/api/dataset/train/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset, run }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      runInAction(() => { this.notice = `stopped ${dataset}/${run}` })
      await this.loadRuns(); await this.poll()
    } catch (e: any) {
      runInAction(() => { this.error = `could not stop: ${e.message}` })
    }
  }

  async install(dataset: string, run: string, filename: string) {
    this.error = ''; this.notice = ''
    try {
      const r = await fetch('/api/dataset/train/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset, run, filename }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      runInAction(() => { this.notice = `installed ${d.installed}` })
      await this.loadOptions()          // it is now selectable as a base model
      return true
    } catch (e: any) {
      runInAction(() => { this.error = `could not install: ${e.message}` })
      return false
    }
  }
}

export const detectorTrainingStore = new DetectorTrainingStore()
