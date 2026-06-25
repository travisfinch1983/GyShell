import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Server, MoreVertical } from 'lucide-react'
import { clusterStore, type ClusterGuest, type GuestSort, type GuestSortKey } from '../../stores/ClusterStore'
import { GrafanaPanel } from './GrafanaPanel'
import { MigrateModal } from './MigrateModal'
import { GpuModal } from './GpuModal'
import styles from './Cluster.module.scss'

function pct(used?: number, max?: number): number {
  if (!used || !max || max <= 0) return 0
  return Math.min(100, Math.round((used / max) * 100))
}

function fmtBytes(b?: number): string {
  if (!b || b <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = b
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function fmtUptime(s?: number): string {
  if (!s || s <= 0) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
}

const Metric: React.FC<{ label: string; value: number }> = ({ label, value }) => {
  const cls = value >= 80 ? styles.crit : value >= 50 ? styles.warn : styles.ok
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <div className={styles.track}>
        <div className={`${styles.fill} ${cls}`} style={{ width: `${value}%` }} />
      </div>
      <span className={styles.metricPct}>{value}%</span>
    </div>
  )
}

const COLUMNS: Array<{ key: GuestSortKey; label: string }> = [
  { key: 'vmid', label: 'VMID' },
  { key: 'name', label: 'Name' },
  { key: 'node', label: 'Node' },
  { key: 'status', label: 'Status' },
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'Memory' },
]

const GuestTable: React.FC<{
  title: string
  guests: ClusterGuest[]
  sort: GuestSort
  onSort: (key: GuestSortKey) => void
  renderActions: (g: ClusterGuest) => React.ReactNode
}> = ({ title, guests, sort, onSort, renderActions }) => (
  <div className={styles.tableWrap}>
    <div className={styles.tableHead}>
      <span className={styles.tableTitle}>
        {title} <span className={styles.tableCount}>({guests.length})</span>
      </span>
    </div>
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.key} className={styles.sortable} onClick={() => onSort(col.key)}>
                {col.label}
                <span className={styles.sortArrow}>
                  {sort.key === col.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </span>
              </th>
            ))}
            <th>Boot</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {guests.map((g) => {
            const running = g.status === 'running'
            const busy = clusterStore.actionBusy === g.vmid
            return (
              <tr key={g.vmid} className={busy ? styles.rowBusy : ''}>
                <td className={styles.mono}>{g.vmid}</td>
                <td>{g.name ?? '—'}</td>
                <td>{g.node ?? '—'}</td>
                <td>
                  <span className={`${styles.status} ${running ? styles.ok : styles.idle}`}>
                    {g.status ?? '—'}
                  </span>
                </td>
                <td className={styles.mono}>{running ? `${Math.round((g.cpu ?? 0) * 100)}%` : '—'}</td>
                <td className={styles.mono}>
                  {running ? `${fmtBytes(g.mem)} / ${fmtBytes(g.maxmem)}` : fmtBytes(g.maxmem)}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={!!g.onboot}
                    disabled={busy}
                    title="Start on boot"
                    onChange={() => clusterStore.setConfig(g.vmid, { onboot: g.onboot ? 0 : 1 })}
                  />
                </td>
                <td className={styles.actionsCell}>{renderActions(g)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  </div>
)

export const ClusterPanel: React.FC = observer(() => {
  const [dragNode, setDragNode] = useState<string | null>(null)
  const [overNode, setOverNode] = useState<string | null>(null)
  const [menuVmid, setMenuVmid] = useState<number | null>(null)
  const [migrateFor, setMigrateFor] = useState<ClusterGuest | null>(null)
  const [gpuFor, setGpuFor] = useState<ClusterGuest | null>(null)

  useEffect(() => {
    clusterStore.startPolling(10000)
    return () => clusterStore.stopPolling()
  }, [])

  const power = (g: ClusterGuest, action: 'start' | 'stop' | 'shutdown' | 'reboot') => {
    setMenuVmid(null)
    if (action !== 'start' && !window.confirm(`${action.toUpperCase()} ${g.type?.toUpperCase()} ${g.vmid} (${g.name ?? ''})?`)) return
    void clusterStore.guestPower(g.vmid, action)
  }

  const editResources = (g: ClusterGuest) => {
    setMenuVmid(null)
    const cores = window.prompt(`Cores for ${g.vmid} (${g.name ?? ''})`, String(g.maxcpu ?? ''))
    if (cores === null) return
    const memMb = window.prompt('Memory (MB)', String(g.maxmem ? Math.round(g.maxmem / 1048576) : ''))
    if (memMb === null) return
    const patch: Record<string, unknown> = {}
    if (cores.trim()) patch.cores = Number(cores)
    if (memMb.trim()) patch.memory = Number(memMb)
    if (Object.keys(patch).length) void clusterStore.setResources(g.vmid, patch)
  }

  const resizeDisk = (g: ClusterGuest) => {
    setMenuVmid(null)
    const disk = g.type === 'qemu' ? 'scsi0' : 'rootfs'
    const size = window.prompt(`Grow disk "${disk}" of ${g.vmid} by (e.g. +5G):`, '+5G')
    if (size && size.trim()) void clusterStore.resizeDisk(g.vmid, disk, size.trim())
  }

  const toggleProtection = (g: ClusterGuest) => {
    setMenuVmid(null)
    void clusterStore.setConfig(g.vmid, { protection: g.protection ? 0 : 1 })
  }

  const openMigrate = (g: ClusterGuest) => {
    setMenuVmid(null)
    void clusterStore.loadModalData()
    setMigrateFor(g)
  }

  const openGpu = (g: ClusterGuest) => {
    setMenuVmid(null)
    void clusterStore.loadModalData()
    setGpuFor(g)
  }

  const renderActions = (g: ClusterGuest) => {
    const running = g.status === 'running'
    const open = menuVmid === g.vmid
    return (
      <div className={styles.actionWrap}>
        <button
          className={styles.menuBtn}
          title="Actions"
          type="button"
          onClick={() => setMenuVmid(open ? null : g.vmid)}
        >
          <MoreVertical size={15} />
        </button>
        {open && (
          <>
            <div className={styles.menuBackdrop} onClick={() => setMenuVmid(null)} />
            <div className={styles.menu}>
              {!running && <button onClick={() => power(g, 'start')}>Start</button>}
              {running && <button onClick={() => power(g, 'reboot')}>Reboot</button>}
              {running && <button onClick={() => power(g, 'shutdown')}>Shutdown</button>}
              {running && <button className={styles.danger} onClick={() => power(g, 'stop')}>Stop</button>}
              <div className={styles.menuSep} />
              <button onClick={() => editResources(g)}>Edit cores / memory…</button>
              <button onClick={() => resizeDisk(g)}>Resize disk…</button>
              <button onClick={() => openMigrate(g)}>Migrate…</button>
              {g.type === 'lxc' && <button onClick={() => openGpu(g)}>GPUs…</button>}
              <div className={styles.menuSep} />
              <button onClick={() => toggleProtection(g)}>
                {g.protection ? 'Disable protection' : 'Enable protection'}
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  const s = clusterStore.status
  const c = s?.cluster

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Server size={16} className={styles.headerIcon} />
        <span className={styles.clusterName}>{c?.name ?? 'Cluster'}</span>
        {c && (
          <span className={`${styles.badge} ${c.quorate ? styles.ok : styles.crit}`}>
            {c.quorate ? 'Quorate' : 'No Quorum'}
          </span>
        )}
        <span className={styles.counts}>
          {(s?.nodes?.length ?? 0)} nodes · {(s?.containers?.length ?? 0)} CT · {(s?.vms?.length ?? 0)} VM
        </span>
        <div className={styles.spacer} />
        {clusterStore.lastUpdated && (
          <span className={styles.updated}>
            updated {new Date(clusterStore.lastUpdated).toLocaleTimeString()}
          </span>
        )}
        <button
          className={styles.refreshBtn}
          onClick={() => void clusterStore.refresh()}
          title="Refresh"
          type="button"
        >
          <RefreshCw size={14} className={clusterStore.loading ? styles.spin : ''} />
        </button>
      </div>

      {clusterStore.error && <div className={styles.error}>Failed to load cluster — {clusterStore.error}</div>}
      {clusterStore.actionError && (
        <div className={styles.error} onClick={() => (clusterStore.actionError = null)}>
          Action failed — {clusterStore.actionError} <span className={styles.dismiss}>(dismiss)</span>
        </div>
      )}
      {!s && !clusterStore.error && <div className={styles.loading}>Loading cluster…</div>}

      {s && (
        <div className={styles.body}>
          <div className={styles.nodeGrid}>
            {clusterStore.orderedNodes.map((n) => (
              <div
                key={n.node}
                className={`${styles.nodeCard} ${n.online ? styles.isOnline : styles.isOffline} ${
                  dragNode === n.node ? styles.dragging : ''
                } ${overNode === n.node && dragNode && dragNode !== n.node ? styles.dropTarget : ''}`}
                draggable
                onDragStart={(e) => {
                  setDragNode(n.node)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (overNode !== n.node) setOverNode(n.node)
                }}
                onDragLeave={() => setOverNode((cur) => (cur === n.node ? null : cur))}
                onDrop={() => {
                  if (dragNode && dragNode !== n.node) clusterStore.moveNode(dragNode, n.node)
                  setDragNode(null)
                  setOverNode(null)
                }}
                onDragEnd={() => {
                  setDragNode(null)
                  setOverNode(null)
                }}
              >
                <div className={styles.nodeTop}>
                  <span className={`${styles.dot} ${n.online ? styles.ok : styles.crit}`} />
                  <span className={styles.nodeName}>{n.node}</span>
                  <span className={styles.nodeIp}>{n.ip ?? ''}</span>
                </div>
                <div className={styles.nodeMeta}>
                  {n.maxcpu ?? '?'} vCPU · {fmtBytes(n.maxmem)} RAM · up {fmtUptime(n.uptime)}
                </div>
                <Metric label="CPU" value={Math.round((n.cpu ?? 0) * 100)} />
                <Metric label="MEM" value={pct(n.mem, n.maxmem)} />
                <Metric label="DISK" value={pct(n.disk, n.maxdisk)} />
              </div>
            ))}
          </div>

          <div className={styles.metricsSection}>
            <div className={styles.sectionTitle}>
              Fleet Metrics <span className={styles.sectionSub}>· Grafana / Prometheus</span>
            </div>
            <div className={styles.grafanaGrid}>
              <GrafanaPanel uid="gpu-fleet-homelab" panelId={5} />
              <GrafanaPanel uid="gpu-fleet-homelab" panelId={6} />
              <GrafanaPanel uid="gpu-fleet-homelab" panelId={11} />
              <GrafanaPanel uid="gpu-fleet-homelab" panelId={12} />
            </div>
          </div>

          <div className={styles.guestToolbar}>
            <input
              className={styles.filter}
              placeholder="Filter by name / vmid / node…"
              value={clusterStore.filter}
              onChange={(e) => clusterStore.setFilter(e.target.value)}
            />
            <span className={styles.tableCounts}>
              {clusterStore.runningCount} running · {clusterStore.stoppedCount} stopped
            </span>
          </div>

          <GuestTable
            title="LXC Containers"
            guests={clusterStore.containers}
            sort={clusterStore.ctSort}
            onSort={(key) => clusterStore.setSort('ct', key)}
            renderActions={renderActions}
          />
          <GuestTable
            title="Virtual Machines"
            guests={clusterStore.vms}
            sort={clusterStore.vmSort}
            onSort={(key) => clusterStore.setSort('vm', key)}
            renderActions={renderActions}
          />
        </div>
      )}

      {migrateFor && <MigrateModal guest={migrateFor} onClose={() => setMigrateFor(null)} />}
      {gpuFor && <GpuModal guest={gpuFor} onClose={() => setGpuFor(null)} />}
    </div>
  )
})
