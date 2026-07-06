import React, { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { gpuFleetStore, type FleetGpu } from '../../stores/GpuFleetStore'
import { uiPrefsStore } from '../../stores/uiPrefsStore'
import styles from './GpuFleet.module.scss'

/** Sparkline poll rate — Travis #6: settable down to 1s in Settings › General
 *  (the fleet data is cheap Prometheus reads). Persisted in ui-prefs. */
export const GPU_FLEET_POLL_PREF = 'gpuFleetPollMs'
export const GPU_FLEET_POLL_DEFAULT = 3000
export const fleetPollMs = (): number =>
  Math.min(60000, Math.max(1000, Number(uiPrefsStore.get(GPU_FLEET_POLL_PREF, GPU_FLEET_POLL_DEFAULT)) || GPU_FLEET_POLL_DEFAULT))

const GIB = 1073741824

function fmtGB(bytes: number | null): string {
  if (bytes == null) return '—'
  const gb = bytes / GIB
  return gb < 10 ? gb.toFixed(1) : String(Math.round(gb))
}

function utilClass(pct: number | null): string {
  if (pct == null) return ''
  if (pct >= 85) return styles.sparkHot
  if (pct >= 50) return styles.sparkWarm
  return styles.sparkCool
}

/**
 * Rolling per-GPU sample buffers, keyed by uuid, module-scoped so history
 * survives card re-renders (and resets with the page — it's a live monitor,
 * not persistence). 40 samples at the 3s poll ≈ the last 2 minutes.
 * Appended exactly once per store update (keyed on updatedAt), null for
 * missing samples so the line gaps instead of lying.
 */
const SPARK_CAP = 40
const sparkBuffers = new Map<string, { util: Array<number | null>; mem: Array<number | null> }>()
let lastSampledAt = 0

function sampleFleet(updatedAt: number, nodes: Array<{ gpus: FleetGpu[] }>): void {
  if (updatedAt === 0 || updatedAt === lastSampledAt) return
  lastSampledAt = updatedAt
  for (const node of nodes) {
    for (const g of node.gpus) {
      const buf = sparkBuffers.get(g.uuid) ?? { util: [], mem: [] }
      const memPct = g.memUsedBytes != null && g.memTotalBytes ? (g.memUsedBytes / g.memTotalBytes) * 100 : null
      buf.util.push(g.gpuUtil)
      buf.mem.push(memPct)
      if (buf.util.length > SPARK_CAP) buf.util.splice(0, buf.util.length - SPARK_CAP)
      if (buf.mem.length > SPARK_CAP) buf.mem.splice(0, buf.mem.length - SPARK_CAP)
      sparkBuffers.set(g.uuid, buf)
    }
  }
}

/** Tiny single-series 0-100% sparkline. Recent samples anchor to the RIGHT so
 *  a filling buffer grows leftward; null samples break the line into gaps.
 *  Stroke/area take the status color of the LATEST value (same cool/warm/hot
 *  language the old bar meters used); the number next to it stays text. */
const Sparkline: React.FC<{ series: Array<number | null>; latest: number | null; title: string }> = ({ series, latest, title }) => {
  const W = 100
  const H = 26
  const PAD = 2
  const n = SPARK_CAP
  const x = (i: number) => ((n - series.length + i) / (n - 1)) * W
  const y = (v: number) => H - PAD - (Math.max(0, Math.min(100, v)) / 100) * (H - 2 * PAD)
  // split on nulls: each run of real samples becomes one polyline segment
  const segments: string[][] = []
  let cur: string[] = []
  series.forEach((v, i) => {
    if (v == null) { if (cur.length) { segments.push(cur); cur = [] } return }
    cur.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`)
  })
  if (cur.length) segments.push(cur)
  // area under the LAST contiguous segment only (the live tail)
  const tail = segments[segments.length - 1]
  const areaPath = tail && tail.length > 1
    ? `M ${tail[0].split(',')[0]},${H - PAD} L ${tail.join(' L ')} L ${tail[tail.length - 1].split(',')[0]},${H - PAD} Z`
    : null
  return (
    <svg
      className={`${styles.spark} ${utilClass(latest)}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
    >
      <title>{title}</title>
      {areaPath && <path d={areaPath} fill="currentColor" opacity={0.14} stroke="none" />}
      {segments.map((seg, i) =>
        seg.length > 1 ? (
          <polyline key={i} points={seg.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        ) : (
          <circle key={i} cx={seg[0].split(',')[0]} cy={seg[0].split(',')[1]} r={1.4} fill="currentColor" stroke="none" />
        ),
      )}
    </svg>
  )
}

function sparkTitle(label: string, series: Array<number | null>): string {
  const vals = series.filter((v): v is number => v != null)
  if (!vals.length) return `${label} — no samples yet`
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length
  const secs = Math.round(((vals.length - 1) * fleetPollMs()) / 1000)
  const span = secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`
  return `${label}, last ~${span}: min ${Math.round(min)}% · avg ${Math.round(avg)}% · max ${Math.round(max)}%`
}

const SparkRow: React.FC<{ label: string; series: Array<number | null>; latest: number | null; text: string }> = ({ label, series, latest, text }) => (
  <div className={styles.barRow}>
    <span className={styles.barLabel}>{label}</span>
    <Sparkline series={series} latest={latest} title={sparkTitle(label, series)} />
    <span className={styles.barText}>{text}</span>
  </div>
)

const GpuCard: React.FC<{ gpu: FleetGpu }> = ({ gpu }) => {
  const memPct =
    gpu.memUsedBytes != null && gpu.memTotalBytes ? (gpu.memUsedBytes / gpu.memTotalBytes) * 100 : null
  const buf = sparkBuffers.get(gpu.uuid) ?? { util: [], mem: [] }
  return (
    <div className={styles.gpuCard}>
      <div className={styles.gpuTop}>
        <span className={styles.gpuIdx}>#{gpu.index >= 0 ? gpu.index : '?'}</span>
        <span className={styles.gpuName} title={gpu.name}>
          {gpu.name}
        </span>
      </div>
      <SparkRow label="GPU" series={buf.util} latest={gpu.gpuUtil} text={gpu.gpuUtil == null ? '—' : `${Math.round(gpu.gpuUtil)}%`} />
      <SparkRow label="VRAM" series={buf.mem} latest={memPct} text={`${fmtGB(gpu.memUsedBytes)}/${fmtGB(gpu.memTotalBytes)}G`} />
      <div className={styles.statRow}>
        <span className={styles.stat}>{gpu.tempC == null ? '—' : `${Math.round(gpu.tempC)}°C`}</span>
        <span className={styles.stat}>
          {gpu.powerW == null ? '—' : `${Math.round(gpu.powerW)}W`}
          {gpu.powerLimitW ? ` / ${Math.round(gpu.powerLimitW)}W` : ''}
        </span>
      </div>
    </div>
  )
}

/**
 * Bottom-docked, collapsible GPU fleet monitor. The header bar is always visible (it's the
 * toggle button); clicking it slides the panel up. Live metrics come from Prometheus via
 * GpuFleetStore. Self-contained: mount once in the app shell, no props needed.
 */
export const GpuFleetPanel = observer(() => {
  const s = gpuFleetStore
  const open = s.open
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { void uiPrefsStore.ensureLoaded() }, [])
  const pollMs = fleetPollMs()
  useEffect(() => {
    if (open) s.startPolling(pollMs)
    else s.stopPolling()
    return () => s.stopPolling()
  }, [open, pollMs, s])

  // Append one sample per store refresh into the rolling sparkline buffers.
  // During render (not an effect) so the cards below read the buffer WITH the
  // sample that triggered this render — idempotent via the updatedAt guard.
  sampleFleet(s.updatedAt, s.nodes)

  const onResizeDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = panelRef.current?.offsetHeight ?? s.heightPx ?? 400
    const onMove = (ev: MouseEvent) => {
      // Panel is anchored to the bottom, so dragging the top edge UP makes it taller.
      s.setHeight(startH + (startY - ev.clientY))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'
  }

  return (
    <div
      ref={panelRef}
      className={`${styles.panel} ${open ? styles.panelOpen : ''}`}
      style={s.heightPx ? { height: `${s.heightPx}px` } : undefined}
    >
      {open && (
        <div
          className={styles.resizer}
          onMouseDown={onResizeDown}
          title="Drag to resize"
          role="separator"
          aria-orientation="horizontal"
        />
      )}
      <button className={styles.handle} onClick={() => s.toggle()} title="Toggle GPU fleet monitor">
        <span className={styles.chevron}>{open ? '▼' : '▲'}</span>
        <span className={styles.handleTitle}>GPU Fleet</span>
        <span className={styles.handleMeta}>
          {s.totalGpus} GPU{s.totalGpus !== 1 ? 's' : ''} · {s.avgUtil}% avg
        </span>
        {s.error && <span className={styles.handleErr}>⚠ {s.error}</span>}
      </button>
      <div className={styles.body}>
        {s.nodes.length === 0 && !s.error && (
          <div className={styles.empty}>Waiting for GPU metrics from Prometheus…</div>
        )}
        {s.nodes.map((node) => (
          <div key={node.node} className={styles.nodeGroup}>
            <div className={styles.nodeHeader}>
              <span className={styles.nodeName}>{node.node}</span>
              <span className={styles.nodeCount}>
                {node.gpus.length} GPU{node.gpus.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className={styles.gpuGrid}>
              {node.gpus.map((g) => (
                <GpuCard key={g.uuid} gpu={g} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})
