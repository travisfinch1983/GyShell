import { makeAutoObservable, runInAction } from 'mobx'

/**
 * GpuFleetStore — live GPU fleet monitor for the bottom-docked panel.
 *
 * Data source: Prometheus via the backend `metrics:query` RPC (rule #1: the browser never hits
 * Prometheus directly — it calls `window.gyshell.metrics`). We DON'T use /api/gpu here: that
 * endpoint is inventory-only now (the SSH nvidia-smi poller was removed in #264), so live
 * util/VRAM/temp/power comes from the `nvidia_smi_*` gauges scraped by the `gpu` job.
 *
 * One instant query pulls every series we need; we key GPUs by `uuid` and group by `host`.
 */

export interface FleetGpu {
  uuid: string
  node: string
  index: number
  name: string
  friendlyName?: string
  pciBusId?: string
  gpuUtil: number | null // %
  memUtil: number | null // %
  memUsedBytes: number | null
  memTotalBytes: number | null
  tempC: number | null
  powerW: number | null
  powerLimitW: number | null
}

export interface FleetNode {
  node: string
  gpus: FleetGpu[]
}

const OPEN_KEY = 'ai-lab-gpu-fleet-open'
const HEIGHT_KEY = 'ai-lab-gpu-fleet-height'
const MIN_HEIGHT = 120

// Single instant query returning gpu_info (metadata) + all live gauges for the `gpu` scrape job.
const FLEET_QUERY =
  '{__name__=~"nvidia_smi_gpu_info|nvidia_smi_utilization_gpu_ratio|nvidia_smi_utilization_memory_ratio|' +
  'nvidia_smi_memory_used_bytes|nvidia_smi_memory_total_bytes|nvidia_smi_temperature_gpu|' +
  'nvidia_smi_power_draw_watts|nvidia_smi_power_limit_watts",job="gpu"}'

type MetricRow = { labels: Record<string, string>; value: number | null }

function lastPoint(points: Array<{ t: number; v: number | null }> | undefined): number | null {
  if (!points || !points.length) return null
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]?.v != null) return points[i].v as number
  }
  return null
}

class GpuFleetStore {
  open = false
  // Panel height in px (persisted). null → fall back to the CSS default (46vh).
  heightPx: number | null = null
  nodes: FleetNode[] = []
  error: string | null = null
  loading = false
  updatedAt = 0
  gpuConfig: Record<string, any> = {}
  private gpuConfigAt = 0

  private timer: ReturnType<typeof setInterval> | null = null

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true })
    try {
      this.open = localStorage.getItem(OPEN_KEY) === '1'
      const h = parseInt(localStorage.getItem(HEIGHT_KEY) || '', 10)
      if (Number.isFinite(h) && h >= MIN_HEIGHT) this.heightPx = h
    } catch {
      /* localStorage may be unavailable */
    }
  }

  /** Set the drawer height (px), clamped to [MIN_HEIGHT, 90vh], and persist it. */
  setHeight(px: number): void {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1000
    const clamped = Math.round(Math.max(MIN_HEIGHT, Math.min(px, vh * 0.9)))
    this.heightPx = clamped
    try {
      localStorage.setItem(HEIGHT_KEY, String(clamped))
    } catch {
      /* ignore */
    }
  }

  private metrics(): any {
    return (window as any).gyshell?.metrics
  }

  /** Fetch per-GPU config (friendly names + showInFleet curation) from cluster settings.
   *  Cached ~8s so the panel reflects Settings changes within a couple polls without spamming RPC. */
  private async loadGpuConfig(): Promise<void> {
    const now = Date.now()
    if (this.gpuConfigAt && now - this.gpuConfigAt < 8000) return
    try {
      const s = await (window as any).gyshell?.clusterSettings?.get?.()
      const gc = (s?.gpuConfig ?? s?.settings?.gpuConfig ?? {}) as Record<string, any>
      runInAction(() => { this.gpuConfig = gc; this.gpuConfigAt = now })
    } catch { /* keep last-known config */ }
  }

  toggle(): void {
    this.open = !this.open
    try {
      localStorage.setItem(OPEN_KEY, this.open ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  startPolling(intervalMs = 3000): void {
    void this.load()
    if (this.timer) return
    this.timer = setInterval(() => void this.load(), intervalMs)
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async load(): Promise<void> {
    const api = this.metrics()
    if (!api?.query && !api?.queryRangeBatch) {
      runInAction(() => {
        this.error = 'metrics RPC unavailable'
      })
      return
    }
    this.loading = true
    await this.loadGpuConfig()
    try {
      let rows: MetricRow[] = []
      if (api.query) {
        // Instant vector — exactly the current value per series.
        const res = await api.query(FLEET_QUERY)
        rows = (res?.result ?? []) as MetricRow[]
      } else {
        // Fallback: short range query, take the latest point of each series.
        const res = await api.queryRangeBatch([FLEET_QUERY], 120, 15)
        const series = res?.results?.[0] ?? []
        rows = series.map((s: any) => ({ labels: s.labels || {}, value: lastPoint(s.points) }))
      }

      const byUuid: Record<string, FleetGpu> = {}
      for (const r of rows) {
        const l = r.labels || {}
        const uuid = l.uuid
        if (!uuid) continue
        let g = byUuid[uuid]
        if (!g) {
          g = byUuid[uuid] = {
            uuid,
            node: l.host || l.instance || '?',
            index: -1,
            name: 'GPU',
            gpuUtil: null,
            memUtil: null,
            memUsedBytes: null,
            memTotalBytes: null,
            tempC: null,
            powerW: null,
            powerLimitW: null,
          }
        }
        if (l.host) g.node = l.host
        switch (l.__name__) {
          case 'nvidia_smi_gpu_info':
            if (l.name) g.name = l.name
            if (l.index != null && l.index !== '') g.index = Number(l.index)
            if (l.pci_bus_id) g.pciBusId = l.pci_bus_id
            break
          case 'nvidia_smi_utilization_gpu_ratio':
            g.gpuUtil = r.value == null ? null : r.value * 100
            break
          case 'nvidia_smi_utilization_memory_ratio':
            g.memUtil = r.value == null ? null : r.value * 100
            break
          case 'nvidia_smi_memory_used_bytes':
            g.memUsedBytes = r.value
            break
          case 'nvidia_smi_memory_total_bytes':
            g.memTotalBytes = r.value
            break
          case 'nvidia_smi_temperature_gpu':
            g.tempC = r.value
            break
          case 'nvidia_smi_power_draw_watts':
            g.powerW = r.value
            break
          case 'nvidia_smi_power_limit_watts':
            g.powerLimitW = r.value
            break
          default:
            break
        }
      }

      // Join per-GPU config. Config is keyed `node:pciId` (e.g. px-gpu:0000:8a:00.0) while
      // Prometheus gives host + pci_bus_id (00000000:8A:00.0) — match on host + the lowercased
      // bus:dev.func tail. friendlyName overrides the card label; showInFleet curates the panel.
      const cfg = this.gpuConfig || {}
      const normPci = (p: string) => (p || '').toLowerCase().split(':').slice(-2).join(':')
      const cfgByNorm: Record<string, any> = {}
      for (const [k, v] of Object.entries(cfg)) {
        const i = k.indexOf(':')
        if (i < 0) continue
        cfgByNorm[`${k.slice(0, i)}:${normPci(k.slice(i + 1))}`] = v
      }
      const anyOptIn = Object.values(cfg).some((c: any) => c && c.showInFleet === true)
      let list = Object.values(byUuid)
      for (const g of list) {
        const c = cfgByNorm[`${g.node}:${normPci(g.pciBusId || '')}`]
        if (c?.friendlyName) { g.friendlyName = c.friendlyName; g.name = c.friendlyName }
        ;(g as any)._inFleet = !!c?.showInFleet
      }
      // If the user has opted any GPU into the fleet, show ONLY those; otherwise show all.
      if (anyOptIn) list = list.filter((g) => (g as any)._inFleet)
      const nodesMap: Record<string, FleetGpu[]> = {}
      for (const g of list) {
        ;(nodesMap[g.node] = nodesMap[g.node] || []).push(g)
      }
      const nodes = Object.entries(nodesMap)
        .map(([node, gpus]) => ({ node, gpus: gpus.sort((a, b) => a.index - b.index) }))
        .sort((a, b) => a.node.localeCompare(b.node))

      runInAction(() => {
        this.nodes = nodes
        this.error = null
        this.updatedAt = Date.now()
        this.loading = false
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
        this.loading = false
      })
    }
  }

  get totalGpus(): number {
    return this.nodes.reduce((n, x) => n + x.gpus.length, 0)
  }

  get avgUtil(): number {
    const vals = this.nodes
      .flatMap((n) => n.gpus)
      .map((g) => g.gpuUtil)
      .filter((v): v is number => v != null)
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0
  }
}

export const gpuFleetStore = new GpuFleetStore()
