/**
 * Per-category metric templates for the Cluster tab.
 *
 * A template defines the set of metric entities shown for every entry in a category
 * (all LXC rows, all VM rows). Edit one template → every row in that category updates.
 *
 * Each entity (MetricChartDef) can surface MULTIPLE values for higher information
 * density (inspired by HA's apexcharts-card / gauge-card-pro / flex-horseshoe-card):
 *   - `series`: one or more plotted series (lines/area/bars, or the gauge/stat primary)
 *   - `fields`: extra scalar read-outs shown as text (e.g. "Total 32 GB", "ARC 8 GB")
 * Charts are native uPlot/SVG (MetricChart) fed by the backend metrics RPC. PromQL uses
 * the `$id` placeholder, substituted with the guest id (lxc/NNN or qemu/NNN) at render.
 *
 * Persisted to localStorage (same approach as node order); shape kept backend-friendly.
 */
export type MetricUnit = 'percent' | 'bytes' | 'raw'
export type GearEdit = 'none' | 'cores' | 'memory' | 'disk' | 'order'
export type MetricCategory = 'lxc' | 'qemu'
export type VizType = 'timeseries' | 'area' | 'bar' | 'gauge' | 'stat'

export const VIZ_TYPES: VizType[] = ['timeseries', 'area', 'bar', 'gauge', 'stat']
export const UNITS: MetricUnit[] = ['percent', 'bytes', 'raw']

/** A single PromQL query — used both for plotted series and scalar fields. */
export interface MetricQuery {
  id: string
  label: string
  query: string // `$id` → guest id
  color?: string // plotted series only
  unit?: MetricUnit // fields only (per-field unit); series inherit the chart unit
}

export interface MetricChartDef {
  id: string
  label: string
  viz: VizType
  unit: MetricUnit // primary unit (axis / gauge / primary stat)
  gear: GearEdit
  series: MetricQuery[] // >=1; series[0] is primary for gauge/stat
  fields: MetricQuery[] // extra scalar text read-outs
}

export interface MetricTemplate {
  category: MetricCategory
  rangeSeconds: number
  stepSeconds: number
  charts: MetricChartDef[]
}

const STORAGE_KEY = 'ai-lab-cluster-metric-templates'

let seq = 0
export const newQueryId = () => `q${Date.now().toString(36)}${seq++}`

function baseCharts(): MetricChartDef[] {
  return [
    {
      id: 'cpu', label: 'CPU', viz: 'timeseries', unit: 'percent', gear: 'cores',
      series: [{ id: 'cpu', label: 'CPU %', color: '#4ea1ff', query: 'pve_cpu_usage_ratio{id="$id"} * 100' }],
      fields: [{ id: 'cores', label: 'Cores', unit: 'raw', query: 'pve_cpu_usage_limit{id="$id"}' }],
    },
    {
      id: 'mem', label: 'Memory', viz: 'gauge', unit: 'percent', gear: 'memory',
      series: [{ id: 'mempct', label: 'Mem %', color: '#7c5cff', query: 'pve_memory_usage_bytes{id="$id"} / pve_memory_size_bytes{id="$id"} * 100' }],
      fields: [
        { id: 'used', label: 'Used', unit: 'bytes', query: 'pve_memory_usage_bytes{id="$id"}' },
        { id: 'total', label: 'Total', unit: 'bytes', query: 'pve_memory_size_bytes{id="$id"}' },
      ],
    },
    {
      id: 'disk', label: 'Disk', viz: 'gauge', unit: 'percent', gear: 'disk',
      series: [{ id: 'diskpct', label: 'Disk %', color: '#2ecc71', query: 'pve_disk_usage_bytes{id="$id"} / pve_disk_size_bytes{id="$id"} * 100' }],
      fields: [
        { id: 'dused', label: 'Used', unit: 'bytes', query: 'pve_disk_usage_bytes{id="$id"}' },
        { id: 'dtotal', label: 'Total', unit: 'bytes', query: 'pve_disk_size_bytes{id="$id"}' },
      ],
    },
  ]
}

export function defaultTemplate(category: MetricCategory): MetricTemplate {
  return { category, rangeSeconds: 10800, stepSeconds: 60, charts: baseCharts() }
}

export function newSeries(): MetricQuery {
  return { id: newQueryId(), label: 'series', color: '#4ea1ff', query: 'pve_cpu_usage_ratio{id="$id"} * 100' }
}
export function newField(): MetricQuery {
  return { id: newQueryId(), label: 'field', unit: 'bytes', query: 'pve_memory_size_bytes{id="$id"}' }
}

/** Migrate an older chart that had a single `query`/`color` into the series/fields shape. */
function migrateChart(c: any): MetricChartDef {
  if (Array.isArray(c.series)) {
    return { ...c, series: c.series, fields: Array.isArray(c.fields) ? c.fields : [] }
  }
  return {
    id: c.id ?? newQueryId(),
    label: c.label ?? 'Metric',
    viz: c.viz ?? 'timeseries',
    unit: c.unit ?? 'percent',
    gear: c.gear ?? 'none',
    series: [{ id: newQueryId(), label: c.label ?? 'value', color: c.color ?? '#4ea1ff', query: c.query ?? '' }],
    fields: [],
  }
}

export function loadTemplates(): Record<MetricCategory, MetricTemplate> {
  const fallback = { lxc: defaultTemplate('lxc'), qemu: defaultTemplate('qemu') }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Record<MetricCategory, any>>
    const fix = (t: any, cat: MetricCategory): MetricTemplate =>
      !t ? defaultTemplate(cat) : { category: cat, rangeSeconds: t.rangeSeconds ?? 10800, stepSeconds: t.stepSeconds ?? 60, charts: (t.charts ?? []).map(migrateChart) }
    return { lxc: fix(parsed.lxc, 'lxc'), qemu: fix(parsed.qemu, 'qemu') }
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
