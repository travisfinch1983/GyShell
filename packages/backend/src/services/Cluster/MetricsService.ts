/**
 * MetricsService — backend-side Prometheus query proxy for native in-app charts.
 *
 * RULE #1: the browser never queries Prometheus directly. The renderer calls the
 * `metrics:queryRange` / `metrics:query` gateway RPCs; this service does the HTTP
 * call from CT 152 and returns plain series the UI renders with uPlot (no Grafana,
 * no iframe). Configure with PROMETHEUS_URL (default http://10.0.0.79:9090).
 */
const DEFAULT_BASE = process.env.PROMETHEUS_URL || 'http://10.0.0.79:9090'

export interface RangePoint {
  t: number // unix seconds
  v: number | null
}
export interface RangeSeries {
  labels: Record<string, string>
  points: RangePoint[]
}

export class MetricsService {
  private readonly base: string
  private readonly timeoutMs: number

  constructor(base = DEFAULT_BASE, timeoutMs = 12000) {
    this.base = base.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  private async fetchJson(path: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString()
    const url = `${this.base}${path}?${qs}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const resp = await fetch(url, { signal: controller.signal })
      const data = (await resp.json()) as any
      if (!resp.ok || data?.status === 'error') {
        throw new Error(`Prometheus ${path}: ${data?.error || resp.status}`)
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  /** Range query → array of series with [t, v] points (v null where absent/NaN). */
  async queryRange(query: string, rangeSeconds = 10800, stepSeconds = 60): Promise<RangeSeries[]> {
    if (typeof query !== 'string' || !query.trim()) throw new Error('metrics: empty query')
    const end = Math.floor(Date.now() / 1000)
    const start = end - Math.max(60, Math.min(rangeSeconds, 7 * 86400))
    const data = await this.fetchJson('/api/v1/query_range', {
      query,
      start: String(start),
      end: String(end),
      step: String(Math.max(5, Math.min(stepSeconds, 3600))),
    })
    const result = data?.data?.result ?? []
    return result.map((s: any): RangeSeries => ({
      labels: s.metric ?? {},
      points: (s.values ?? []).map(([t, v]: [number, string]) => ({
        t,
        v: v === 'NaN' || v == null ? null : Number(v),
      })),
    }))
  }

  /** Batch range query → results aligned to the input queries (each = that query's series). */
  async queryRangeBatch(queries: string[], rangeSeconds = 10800, stepSeconds = 60): Promise<RangeSeries[][]> {
    if (!Array.isArray(queries)) throw new Error('metrics: queries must be an array')
    return Promise.all(
      queries.slice(0, 24).map((q) => this.queryRange(q, rangeSeconds, stepSeconds).catch(() => [] as RangeSeries[])),
    )
  }

  /** All metric names known to Prometheus (for query autocomplete). */
  async metricNames(): Promise<string[]> {
    const data = await this.fetchJson('/api/v1/label/__name__/values', {})
    return Array.isArray(data?.data) ? data.data : []
  }

  /** Values for a given label (e.g. label="id" → ["lxc/100", "node/pbs", ...]). */
  async labelValues(label: string): Promise<string[]> {
    if (typeof label !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) {
      throw new Error(`metrics: invalid label name: ${label}`)
    }
    const data = await this.fetchJson(`/api/v1/label/${encodeURIComponent(label)}/values`, {})
    return Array.isArray(data?.data) ? data.data : []
  }

  /** Instant scalar/vector query → array of { labels, value }. */
  async query(query: string): Promise<Array<{ labels: Record<string, string>; value: number | null }>> {
    if (typeof query !== 'string' || !query.trim()) throw new Error('metrics: empty query')
    const data = await this.fetchJson('/api/v1/query', { query })
    const result = data?.data?.result ?? []
    return result.map((s: any) => ({
      labels: s.metric ?? {},
      value: s.value ? (s.value[1] === 'NaN' ? null : Number(s.value[1])) : null,
    }))
  }
}

export const metricsService = new MetricsService()
