import React, { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { VizType, MetricUnit } from '../../stores/metricTemplates'
import styles from './Cluster.module.scss'

/**
 * MetricChart — native, information-dense metric entity (NO Grafana/iframe). Data via
 * the backend `metrics:queryRangeBatch` RPC (rule #1). A single entity can show MANY
 * values (inspired by HA apexcharts-card / gauge-card-pro):
 *   - `series`: plotted series (lines/area/bars; gauge/stat primary = series[0])
 *   - `fields`: extra scalar read-outs shown as text (e.g. Used / Total / ARC)
 * Queries must already have `$id` resolved by the caller.
 */
export interface ResolvedQuery {
  id: string
  label: string
  query: string
  color?: string
  unit?: MetricUnit
}
interface Props {
  title: string
  viz: VizType
  unit: MetricUnit
  series: ResolvedQuery[]
  fields: ResolvedQuery[]
  rangeSeconds?: number
  stepSeconds?: number
  height?: number
  refreshMs?: number
}
interface Point {
  t: number
  v: number | null
}

function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
function humanBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = b
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)}${u[i]}`
}
function fmt(v: number | null | undefined, unit?: MetricUnit): string {
  if (v == null) return '—'
  if (unit === 'percent') return `${v.toFixed(1)}%`
  if (unit === 'bytes') return humanBytes(v)
  return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2)
}
function last(points: Point[] | undefined): number | null {
  if (!points) return null
  for (let i = points.length - 1; i >= 0; i--) if (points[i].v != null) return points[i].v
  return null
}
function thresholdColor(v: number | null, base: string, unit?: MetricUnit): string {
  if (unit !== 'percent' || v == null) return base
  if (v >= 90) return 'var(--danger)'
  if (v >= 70) return '#e0a832'
  return base
}

export const MetricChart: React.FC<Props> = ({
  title,
  viz,
  unit,
  series,
  fields,
  rangeSeconds = 10800,
  stepSeconds = 60,
  height = 84,
  refreshMs = 15000,
}) => {
  const [seriesData, setSeriesData] = useState<Point[][] | null>(null)
  const [fieldVals, setFieldVals] = useState<(number | null)[]>([])
  const [err, setErr] = useState<string | null>(null)

  const seriesKey = series.map((s) => s.query).join('|')
  const fieldKey = fields.map((f) => f.query).join('|')

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const api = (window as any).gyshell?.metrics
        if (!api?.queryRangeBatch) throw new Error('metrics RPC unavailable')
        const queries = [...series.map((s) => s.query), ...fields.map((f) => f.query)]
        const res = await api.queryRangeBatch(queries, rangeSeconds, stepSeconds)
        if (!alive) return
        const results: any[] = res?.results ?? []
        const sData = series.map((_, i) => (results[i]?.[0]?.points as Point[]) ?? [])
        const fData = fields.map((_, i) => last((results[series.length + i]?.[0]?.points as Point[]) ?? []))
        setErr(null)
        setSeriesData(sData)
        setFieldVals(fData)
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    const timer = setInterval(load, refreshMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [seriesKey, fieldKey, rangeSeconds, stepSeconds, refreshMs, series.length, fields.length])

  if (err) return <div style={msg('var(--danger)', height)}>{err}</div>
  if (seriesData == null) return <div style={msg('var(--fg-faint)', height)}>…</div>

  const primaryVal = last(seriesData[0])
  const accent = series[0]?.color || readCssVar('--accent', '#4ea1ff')

  const fieldStrip = (fields.length > 0 || series.length > 1) && (
    <div className={styles.fieldStrip}>
      {series.slice(1).map((s, i) => (
        <span key={s.id} className={styles.fieldItem}>
          <span className={styles.fieldDot} style={{ background: s.color || accent }} />
          {s.label} <b>{fmt(last(seriesData[i + 1]), unit)}</b>
        </span>
      ))}
      {fields.map((f, i) => (
        <span key={f.id} className={styles.fieldItem}>
          {f.label} <b>{fmt(fieldVals[i], f.unit)}</b>
        </span>
      ))}
    </div>
  )

  if (viz === 'gauge') {
    return (
      <div>
        <Gauge value={primaryVal} unit={unit} color={accent} height={height} />
        {fieldStrip}
      </div>
    )
  }
  if (viz === 'stat') {
    return (
      <div>
        <div style={{ height, display: 'grid', placeItems: 'center' }}>
          <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1, color: thresholdColor(primaryVal, accent, unit) }}>
            {fmt(primaryVal, unit)}
          </div>
        </div>
        {fieldStrip}
      </div>
    )
  }
  return (
    <div>
      {series.length > 1 && (
        <div className={styles.legend}>
          {series.map((s, i) => (
            <span key={s.id} className={styles.legendItem}>
              <span className={styles.fieldDot} style={{ background: s.color || accent }} />
              {s.label} <b>{fmt(last(seriesData[i]), unit)}</b>
            </span>
          ))}
        </div>
      )}
      <UPlotChart seriesData={seriesData} series={series} unit={unit} viz={viz} height={height} />
      {fields.length > 0 && fieldStrip}
    </div>
  )
}

function msg(color: string, height: number): React.CSSProperties {
  return { display: 'grid', placeItems: 'center', height, fontSize: 11, color }
}

// ── gauge (270° SVG arc) ─────────────────────────────────────────────────────
const Gauge: React.FC<{ value: number | null; unit: MetricUnit; color: string; height: number }> = ({ value, unit, color, height }) => {
  const max = unit === 'percent' ? 100 : Math.max(value ?? 1, 1)
  const frac = value == null ? 0 : Math.max(0, Math.min(1, value / max))
  const stroke = thresholdColor(value, color, unit)
  const start = 135
  const sweep = 270
  return (
    <div style={{ height, display: 'grid', placeItems: 'center' }}>
      <svg viewBox="0 0 100 72" width="100%" height={height} preserveAspectRatio="xMidYMid meet">
        <path d={arc(50, 50, 40, start, start + sweep)} fill="none" stroke="var(--control-bg)" strokeWidth={9} strokeLinecap="round" />
        {value != null && <path d={arc(50, 50, 40, start, start + sweep * frac)} fill="none" stroke={stroke} strokeWidth={9} strokeLinecap="round" />}
        <text x={50} y={52} textAnchor="middle" fontSize={16} fontWeight={600} fill="var(--fg)">
          {fmt(value, unit)}
        </text>
      </svg>
    </div>
  )
}
function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const s = polar(cx, cy, r, a1)
  const e = polar(cx, cy, r, a0)
  const large = a1 - a0 <= 180 ? 0 : 1
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y}`
}

// ── uPlot multi-series line / area / bar ─────────────────────────────────────
const UPlotChart: React.FC<{ seriesData: Point[][]; series: ResolvedQuery[]; unit: MetricUnit; viz: VizType; height: number }> = ({
  seriesData,
  series,
  unit,
  viz,
  height,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)

  useEffect(() => {
    const grid = readCssVar('--border', 'rgba(255,255,255,0.08)')
    const fg = readCssVar('--fg-muted', 'rgba(255,255,255,0.66)')
    const fmtY = (v: number | null) => fmt(v, unit)

    // Align all series onto a unified, sorted timestamp axis.
    const xset = new Set<number>()
    seriesData.forEach((pts) => pts.forEach((p) => xset.add(p.t)))
    const xs = [...xset].sort((a, b) => a - b)
    const ys = seriesData.map((pts) => {
      const m = new Map(pts.map((p) => [p.t, p.v]))
      return xs.map((t) => (m.has(t) ? (m.get(t) as number | null) : null))
    })
    const data = [xs, ...ys] as uPlot.AlignedData

    const mkSeries = (i: number): uPlot.Series => {
      const color = series[i]?.color || '#4ea1ff'
      return viz === 'bar'
        ? { label: series[i]?.label, stroke: color, fill: color, width: 1, paths: (uPlot.paths as any).bars?.({ size: [0.6, 100] }), points: { show: false }, value: (_u, v) => fmtY(v as number | null) }
        : { label: series[i]?.label, stroke: color, width: 1.5, fill: viz === 'area' ? `color-mix(in srgb, ${color} 22%, transparent)` : undefined, points: { show: false }, value: (_u, v) => fmtY(v as number | null) }
    }

    plotRef.current?.destroy()
    if (hostRef.current && xs.length) {
      plotRef.current = new uPlot(
        {
          width: hostRef.current.clientWidth || 240,
          height,
          cursor: { y: false },
          legend: { show: false },
          scales: { x: { time: true }, y: unit === 'percent' ? { range: [0, 100] } : {} },
          axes: [
            { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 22, font: '10px sans-serif' },
            { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 40, font: '10px sans-serif', values: (_u, sp) => sp.map((s) => fmtY(s)) },
          ],
          series: [{}, ...series.map((_, i) => mkSeries(i))],
        },
        data,
        hostRef.current,
      )
    }
    const onResize = () => plotRef.current && hostRef.current && plotRef.current.setSize({ width: hostRef.current.clientWidth, height })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [seriesData, series, unit, viz, height])

  return <div ref={hostRef} />
}
