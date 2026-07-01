import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { gpuFleetStore, type FleetGpu } from '../../stores/GpuFleetStore'
import styles from './GpuFleet.module.scss'

const GIB = 1073741824

function fmtGB(bytes: number | null): string {
  if (bytes == null) return '—'
  const gb = bytes / GIB
  return gb < 10 ? gb.toFixed(1) : String(Math.round(gb))
}

function utilClass(pct: number | null): string {
  if (pct == null) return ''
  if (pct >= 85) return styles.barHot
  if (pct >= 50) return styles.barWarm
  return styles.barCool
}

const Bar: React.FC<{ label: string; pct: number | null; text: string }> = ({ label, pct, text }) => (
  <div className={styles.barRow}>
    <span className={styles.barLabel}>{label}</span>
    <div className={styles.barTrack}>
      <div
        className={`${styles.barFill} ${utilClass(pct)}`}
        style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
      />
    </div>
    <span className={styles.barText}>{text}</span>
  </div>
)

const GpuCard: React.FC<{ gpu: FleetGpu }> = ({ gpu }) => {
  const memPct =
    gpu.memUsedBytes != null && gpu.memTotalBytes ? (gpu.memUsedBytes / gpu.memTotalBytes) * 100 : null
  return (
    <div className={styles.gpuCard}>
      <div className={styles.gpuTop}>
        <span className={styles.gpuIdx}>#{gpu.index >= 0 ? gpu.index : '?'}</span>
        <span className={styles.gpuName} title={gpu.name}>
          {gpu.name}
        </span>
      </div>
      <Bar label="GPU" pct={gpu.gpuUtil} text={gpu.gpuUtil == null ? '—' : `${Math.round(gpu.gpuUtil)}%`} />
      <Bar label="VRAM" pct={memPct} text={`${fmtGB(gpu.memUsedBytes)}/${fmtGB(gpu.memTotalBytes)} GB`} />
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

  useEffect(() => {
    if (open) s.startPolling(3000)
    else s.stopPolling()
    return () => s.stopPolling()
  }, [open, s])

  return (
    <div className={`${styles.panel} ${open ? styles.panelOpen : ''}`}>
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
