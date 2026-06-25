import React, { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

/**
 * MetricChart — a native, lightweight time-series chart (uPlot, the same engine
 * Grafana wraps internally). NO iframe, NO Grafana. Data comes from the backend
 * `metrics:queryRange` RPC (rule #1: backend queries Prometheus, not the browser).
 *
 * Renders just the graph — no panel chrome — so it sits inline in a guest row.
 */
interface Props {
  query: string
  label: string
  color?: string
  unit?: string // 'percent' | 'bytes' | '' ; affects axis/tooltip formatting
  rangeSeconds?: number
  stepSeconds?: number
  height?: number
  refreshMs?: number
}

function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export const MetricChart: React.FC<Props> = ({
  query,
  label,
  color,
  unit = 'percent',
  rangeSeconds = 10800,
  stepSeconds = 60,
  height = 84,
  refreshMs = 15000,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null

    const accent = color || readCssVar('--accent', '#4ea1ff')
    const grid = readCssVar('--border', 'rgba(255,255,255,0.08)')
    const fg = readCssVar('--fg-muted', 'rgba(255,255,255,0.66)')

    const fmtVal = (v: number | null) =>
      v == null ? '—' : unit === 'percent' ? `${v.toFixed(1)}%` : unit === 'bytes' ? humanBytes(v) : v.toFixed(2)

    const ensurePlot = (data: uPlot.AlignedData) => {
      const width = hostRef.current?.clientWidth || 240
      if (!plotRef.current && hostRef.current) {
        plotRef.current = new uPlot(
          {
            width,
            height,
            cursor: { y: false },
            legend: { show: false },
            scales: { x: { time: true }, y: unit === 'percent' ? { range: [0, 100] } : {} },
            axes: [
              { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 22, font: '10px sans-serif' },
              { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 38, font: '10px sans-serif',
                values: (_u, splits) => splits.map((s) => fmtVal(s)) },
            ],
            series: [
              {},
              {
                label,
                stroke: accent,
                width: 1.5,
                fill: `color-mix(in srgb, ${accent} 16%, transparent)`,
                points: { show: false },
                value: (_u, v) => fmtVal(v as number | null),
              },
            ],
          },
          data,
          hostRef.current,
        )
      } else if (plotRef.current) {
        plotRef.current.setSize({ width, height })
        plotRef.current.setData(data)
      }
    }

    const load = async () => {
      try {
        const api = (window as any).gyshell?.metrics
        if (!api?.queryRange) throw new Error('metrics RPC unavailable')
        const res = await api.queryRange(query, rangeSeconds, stepSeconds)
        if (!alive) return
        const series = (res?.series ?? [])[0]
        if (!series || !series.points?.length) {
          setEmpty(true)
          return
        }
        setEmpty(false)
        setErr(null)
        const xs = series.points.map((p: any) => p.t)
        const ys = series.points.map((p: any) => (p.v == null ? null : p.v))
        ensurePlot([xs, ys] as uPlot.AlignedData)
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      }
    }

    void load()
    timer = setInterval(load, refreshMs)
    const onResize = () => {
      if (plotRef.current && hostRef.current) plotRef.current.setSize({ width: hostRef.current.clientWidth, height })
    }
    window.addEventListener('resize', onResize)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
      window.removeEventListener('resize', onResize)
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [query, label, color, unit, rangeSeconds, stepSeconds, height, refreshMs])

  return (
    <div style={{ position: 'relative', minHeight: height }}>
      <div ref={hostRef} />
      {empty && !err && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--fg-faint)' }}>
          no data
        </div>
      )}
      {err && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--danger)' }}>
          {err}
        </div>
      )}
    </div>
  )
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
