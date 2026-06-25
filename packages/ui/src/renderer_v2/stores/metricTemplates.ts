/**
 * Per-category metric templates for the Cluster tab.
 *
 * A template defines the set of metric charts shown for every entry in a category
 * (e.g. all LXC rows, all VM rows). Edit one template → every row in that category
 * updates. Charts are native uPlot (MetricChart) fed by the backend metrics RPC; the
 * PromQL `query` uses the `$id` placeholder, substituted with the guest id at render
 * time (e.g. `lxc/177`).
 *
 * Persisted to localStorage for now (same approach as node order); the shape is kept
 * backend-friendly so it can move to a shared settings store later.
 */
export type MetricUnit = 'percent' | 'bytes' | 'raw'
export type GearEdit = 'none' | 'cores' | 'memory' | 'disk' | 'order'
export type MetricCategory = 'lxc' | 'qemu'
export type VizType = 'timeseries' | 'area' | 'bar' | 'gauge' | 'stat'

export const VIZ_TYPES: VizType[] = ['timeseries', 'area', 'bar', 'gauge', 'stat']

export interface MetricChartDef {
  id: string
  label: string
  query: string // PromQL; `$id` → guest id (lxc/NNN or qemu/NNN)
  unit: MetricUnit
  color: string
  gear: GearEdit // which in-row editor the ⚙ opens (none = no gear)
  viz: VizType
}

export interface MetricTemplate {
  category: MetricCategory
  rangeSeconds: number
  stepSeconds: number
  charts: MetricChartDef[]
}

const STORAGE_KEY = 'ai-lab-cluster-metric-templates'

function baseCharts(): MetricChartDef[] {
  return [
    { id: 'cpu', label: 'CPU %', unit: 'percent', color: '#4ea1ff', gear: 'cores', viz: 'timeseries',
      query: 'pve_cpu_usage_ratio{id="$id"} * 100' },
    { id: 'mem', label: 'Memory %', unit: 'percent', color: '#7c5cff', gear: 'memory', viz: 'area',
      query: 'pve_memory_usage_bytes{id="$id"} / pve_memory_size_bytes{id="$id"} * 100' },
    { id: 'disk', label: 'Disk %', unit: 'percent', color: '#2ecc71', gear: 'disk', viz: 'gauge',
      query: 'pve_disk_usage_bytes{id="$id"} / pve_disk_size_bytes{id="$id"} * 100' },
  ]
}

export function defaultTemplate(category: MetricCategory): MetricTemplate {
  return { category, rangeSeconds: 10800, stepSeconds: 60, charts: baseCharts() }
}

export function loadTemplates(): Record<MetricCategory, MetricTemplate> {
  const fallback = { lxc: defaultTemplate('lxc'), qemu: defaultTemplate('qemu') }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Record<MetricCategory, MetricTemplate>>
    return {
      lxc: parsed.lxc ?? fallback.lxc,
      qemu: parsed.qemu ?? fallback.qemu,
    }
  } catch {
    return fallback
  }
}

export function saveTemplates(templates: Record<MetricCategory, MetricTemplate>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
  } catch {
    /* ignore quota/serialization */
  }
}

/** Substitute the guest id into a template query. */
export function resolveQuery(query: string, guestId: string): string {
  return query.replace(/\$id/g, guestId)
}
