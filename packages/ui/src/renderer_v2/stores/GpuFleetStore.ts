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
  nodes: FleetNode[] = []
  error: string | null = null
  loading = false
  updatedAt = 0

  private timer: ReturnType<typeof setInterval> | null = null

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true })
    try {
      this.open = localStorage.getItem(OPEN_KEY) === '1'
    } catch {
      /* localStorage may be unavailable */
    }
  }

  private metrics(): any {
    return (window as any).gyshell?.metrics
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

      const nodesMap: Record<string, FleetGpu[]> = {}
      for (const g of Object.values(byUuid)) {
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
