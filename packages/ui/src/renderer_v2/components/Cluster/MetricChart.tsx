import React, { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { VizType } from '../../stores/metricTemplates'

/**
 * MetricChart — native metric visualization (NO Grafana, NO iframe). Data comes from
 * the backend `metrics:queryRange` RPC (rule #1). Renders one of several viz types:
 *   timeseries / area / bar  → uPlot (the engine Grafana wraps)
 *   gauge / stat             → native SVG / HTML (latest value)
 */
interface Props {
  query: string
  label: string
  color?: string
  unit?: 'percent' | 'bytes' | 'raw'
  viz?: VizType
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
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
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

function fmt(v: number | null, unit: Props['unit']): string {
  if (v == null) return '—'
  if (unit === 'percent') return `${v.toFixed(1)}%`
  if (unit === 'bytes') return humanBytes(v)
  return v >= 1000 ? v.toFixed(0) : v.toFixed(2)
}

function thresholdColor(v: number | null, base: string): string {
  if (v == null) return base
  if (v >= 90) return 'var(--danger)'
  if (v >= 70) return '#e0a832'
  return base
}

export const MetricChart: React.FC<Props> = ({
  query,
  label,
  color,
  unit = 'percent',
  viz = 'timeseries',
  rangeSeconds = 10800,
  stepSeconds = 60,
  height = 84,
  refreshMs = 15000,
}) => {
  const [points, setPoints] = useState<Point[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const api = (window as any).gyshell?.metrics
        if (!api?.queryRange) throw new Error('metrics RPC unavailable')
        const res = await api.queryRange(query, rangeSeconds, stepSeconds)
        if (!alive) return
        const series = (res?.series ?? [])[0]
        setErr(null)
        setPoints(series?.points ?? [])
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
  }, [query, rangeSeconds, stepSeconds, refreshMs])

  if (err) return <div className="metricMsg" style={msgStyle('var(--danger)', height)}>{err}</div>
  if (points == null) return <div className="metricMsg" style={msgStyle('var(--fg-faint)', height)}>…</div>
  const lastVal = [...points].reverse().find((p) => p.v != null)?.v ?? null
  if (!points.length) return <div className="metricMsg" style={msgStyle('var(--fg-faint)', height)}>no data</div>

  const accent = color || readCssVar('--accent', '#4ea1ff')

  if (viz === 'gauge') return <Gauge value={lastVal} unit={unit} color={accent} height={height} />
  if (viz === 'stat') return <Stat value={lastVal} unit={unit} color={accent} height={height} label={label} />
  return <UPlotChart points={points} label={label} color={accent} unit={unit} viz={viz} height={height} />
}

function msgStyle(color: string, height: number): React.CSSProperties {
  return { display: 'grid', placeItems: 'center', height, fontSize: 11, color }
}

// ── gauge (SVG arc, 270°) ───────────────────────────────────────────────────
const Gauge: React.FC<{ value: number | null; unit: Props['unit']; color: string; height: number }> = ({
  value,
  unit,
  color,
  height,
}) => {
  const max = unit === 'percent' ? 100 : Math.max(value ?? 1, 1)
  const frac = value == null ? 0 : Math.max(0, Math.min(1, value / max))
  const stroke = thresholdColor(unit === 'percent' ? value : null, color)
  const r = 40
  const cx = 50
  const cy = 50
  const startA = 135
  const sweep = 270
  const track = describeArc(cx, cy, r, startA, startA + sweep)
  const val = describeArc(cx, cy, r, startA, startA + sweep * frac)
  return (
    <div style={{ height, display: 'grid', placeItems: 'center' }}>
      <svg viewBox="0 0 100 70" width="100%" height={height} preserveAspectRatio="xMidYMid meet">
        <path d={track} fill="none" stroke="var(--control-bg)" strokeWidth={9} strokeLinecap="round" />
        {value != null && <path d={val} fill="none" stroke={stroke} strokeWidth={9} strokeLinecap="round" />}
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
function describeArc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const s = polar(cx, cy, r, a1)
  const e = polar(cx, cy, r, a0)
  const large = a1 - a0 <= 180 ? 0 : 1
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y}`
}

// ── stat (big number) ─────────────────────────────────────────────────────────
const Stat: React.FC<{ value: number | null; unit: Props['unit']; color: string; height: number; label: string }> = ({
  value,
  unit,
  color,
  height,
}) => (
  <div style={{ height, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ fontSize: 26, fontWeight: 700, color: thresholdColor(unit === 'percent' ? value : null, color), lineHeight: 1.1 }}>
      {fmt(value, unit)}
    </div>
  </div>
)

// ── uPlot line / area / bar ─────────────────────────────────────────────────
const UPlotChart: React.FC<{
  points: Point[]
  label: string
  color: string
  unit: Props['unit']
  viz: VizType
  height: number
}> = ({ points, label, color, unit, viz, height }) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)

  useEffect(() => {
    const grid = readCssVar('--border', 'rgba(255,255,255,0.08)')
    const fg = readCssVar('--fg-muted', 'rgba(255,255,255,0.66)')
    const xs = points.map((p) => p.t)
    const ys = points.map((p) => p.v)
    const data = [xs, ys] as uPlot.AlignedData
    const fmtY = (v: number | null) => fmt(v, unit)

    const seriesConfig: uPlot.Series =
      viz === 'bar'
        ? {
            label,
            stroke: color,
            fill: color,
            width: 1,
            paths: (uPlot.paths as any).bars?.({ size: [0.6, 100] }),
            points: { show: false },
            value: (_u, v) => fmtY(v as number | null),
          }
        : {
            label,
            stroke: color,
            width: 1.5,
            fill: viz === 'area' ? `color-mix(in srgb, ${color} 22%, transparent)` : undefined,
            points: { show: false },
            value: (_u, v) => fmtY(v as number | null),
          }

    if (!plotRef.current && hostRef.current) {
      plotRef.current = new uPlot(
        {
          width: hostRef.current.clientWidth || 240,
          height,
          cursor: { y: false },
          legend: { show: false },
          scales: { x: { time: true }, y: unit === 'percent' ? { range: [0, 100] } : {} },
          axes: [
            { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 22, font: '10px sans-serif' },
            { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 40, font: '10px sans-serif',
              values: (_u, splits) => splits.map((s) => fmtY(s)) },
          ],
          series: [{}, seriesConfig],
        },
        data,
        hostRef.current,
      )
    } else if (plotRef.current) {
      plotRef.current.setSize({ width: hostRef.current?.clientWidth || 240, height })
      plotRef.current.setData(data)
    }
    const onResize = () => {
      if (plotRef.current && hostRef.current) plotRef.current.setSize({ width: hostRef.current.clientWidth, height })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [points, label, color, unit, viz, height])

  // Rebuild the plot when viz changes (different series/path config).
  useEffect(() => {
    return () => {
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [viz])

  return <div ref={hostRef} />
}
