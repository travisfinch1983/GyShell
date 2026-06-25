import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Server } from 'lucide-react'
import { clusterStore, type ClusterGuest, type GuestSort, type GuestSortKey } from '../../stores/ClusterStore'
import { GrafanaPanel } from './GrafanaPanel'
import { MigrateModal } from './MigrateModal'
import { GpuModal } from './GpuModal'
import { ConfirmModal, EditValueModal } from './ClusterModals'
import { GuestRow, type GuestRowHandlers } from './GuestRow'
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

const SORT_KEYS: Array<{ key: GuestSortKey; label: string }> = [
  { key: 'vmid', label: 'VMID' },
  { key: 'name', label: 'Name' },
  { key: 'node', label: 'Node' },
  { key: 'status', label: 'Status' },
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'Mem' },
]

const SortBar: React.FC<{ sort: GuestSort; onSort: (k: GuestSortKey) => void }> = ({ sort, onSort }) => (
  <div className={styles.sortBar}>
    <span className={styles.sortLabel}>Sort:</span>
    {SORT_KEYS.map((s) => (
      <button
        key={s.key}
        className={`${styles.sortChip} ${sort.key === s.key ? styles.sortActive : ''}`}
        onClick={() => onSort(s.key)}
      >
        {s.label}
        {sort.key === s.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    ))}
  </div>
)

type EditKind = 'cores' | 'memory' | 'disk' | 'order'

export const ClusterPanel: React.FC = observer(() => {
  const [dragNode, setDragNode] = useState<string | null>(null)
  const [overNode, setOverNode] = useState<string | null>(null)
  const [menuVmid, setMenuVmid] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [migrateFor, setMigrateFor] = useState<ClusterGuest | null>(null)
  const [gpuFor, setGpuFor] = useState<ClusterGuest | null>(null)
  const [edit, setEdit] = useState<{ kind: EditKind; guest: ClusterGuest } | null>(null)
  const [confirm, setConfirm] = useState<{ guest: ClusterGuest; action: 'stop' | 'shutdown' | 'reboot' } | null>(null)

  useEffect(() => {
    clusterStore.startPolling(10000)
    clusterStore.loadModalData() // GPU assignment counts shown inline
    return () => clusterStore.stopPolling()
  }, [])

  const toggleExpand = (vmid: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(vmid) ? next.delete(vmid) : next.add(vmid)
      return next
    })

  const handlers: GuestRowHandlers = {
    onPower: (g, action) => {
      setMenuVmid(null)
      if (action === 'start') void clusterStore.guestPower(g.vmid, action)
      else setConfirm({ guest: g, action })
    },
    onEditCores: (g) => setEdit({ kind: 'cores', guest: g }),
    onEditMemory: (g) => setEdit({ kind: 'memory', guest: g }),
    onResizeDisk: (g) => setEdit({ kind: 'disk', guest: g }),
    onEditOrder: (g) => setEdit({ kind: 'order', guest: g }),
    onMigrate: (g) => {
      setMenuVmid(null)
      void clusterStore.loadModalData()
      setMigrateFor(g)
    },
    onGpu: (g) => {
      void clusterStore.loadModalData()
      setGpuFor(g)
    },
  }

  const applyEdit = (value: string) => {
    if (!edit) return
    const { kind, guest } = edit
    if (kind === 'cores') void clusterStore.setResources(guest.vmid, { cores: Number(value) })
    else if (kind === 'memory') void clusterStore.setResources(guest.vmid, { memory: Number(value) })
    else if (kind === 'disk')
      void clusterStore.resizeDisk(guest.vmid, guest.type === 'qemu' ? 'scsi0' : 'rootfs', value)
    else if (kind === 'order') void clusterStore.setConfig(guest.vmid, { startup: value })
  }

  const editConfig: Record<EditKind, { title: string; label: string; initial: (g: ClusterGuest) => string; hint?: string }> = {
    cores: { title: 'Edit cores', label: 'Cores', initial: (g) => String(g.maxcpu ?? '') },
    memory: { title: 'Edit memory', label: 'Memory (MB)', initial: (g) => String(g.maxmem ? Math.round(g.maxmem / 1048576) : '') },
    disk: { title: 'Resize disk', label: 'Grow by', initial: () => '+5G', hint: 'Relative size, e.g. +5G or +512M. Disk only grows.' },
    order: { title: 'Startup order', label: 'startup', initial: (g) => String(g.startup ?? 'order=1,up=30'), hint: 'PVE format: order=N,up=SECS;down=SECS' },
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
          <span className={styles.updated}>updated {new Date(clusterStore.lastUpdated).toLocaleTimeString()}</span>
        )}
        <button className={styles.refreshBtn} onClick={() => void clusterStore.refresh()} title="Refresh" type="button">
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

          <div className={styles.listSection}>
            <div className={styles.listHead}>
              <span className={styles.listTitle}>LXC Containers ({clusterStore.containers.length})</span>
              <SortBar sort={clusterStore.ctSort} onSort={(k) => clusterStore.setSort('ct', k)} />
            </div>
            {clusterStore.containers.map((g) => (
              <GuestRow
                key={g.vmid}
                guest={g}
                expanded={expanded.has(g.vmid)}
                onToggleExpand={() => toggleExpand(g.vmid)}
                menuOpen={menuVmid === g.vmid}
                onMenuToggle={() => setMenuVmid(menuVmid === g.vmid ? null : g.vmid)}
                h={handlers}
              />
            ))}
          </div>

          <div className={styles.listSection}>
            <div className={styles.listHead}>
              <span className={styles.listTitle}>Virtual Machines ({clusterStore.vms.length})</span>
              <SortBar sort={clusterStore.vmSort} onSort={(k) => clusterStore.setSort('vm', k)} />
            </div>
            {clusterStore.vms.map((g) => (
              <GuestRow
                key={g.vmid}
                guest={g}
                expanded={expanded.has(g.vmid)}
                onToggleExpand={() => toggleExpand(g.vmid)}
                menuOpen={menuVmid === g.vmid}
                onMenuToggle={() => setMenuVmid(menuVmid === g.vmid ? null : g.vmid)}
                h={handlers}
              />
            ))}
          </div>
        </div>
      )}

      {migrateFor && <MigrateModal guest={migrateFor} onClose={() => setMigrateFor(null)} />}
      {gpuFor && <GpuModal guest={gpuFor} onClose={() => setGpuFor(null)} />}
      {edit && (
        <EditValueModal
          title={`${editConfig[edit.kind].title} · ${edit.guest.vmid} (${edit.guest.name ?? ''})`}
          label={editConfig[edit.kind].label}
          initial={editConfig[edit.kind].initial(edit.guest)}
          hint={editConfig[edit.kind].hint}
          onSubmit={applyEdit}
          onClose={() => setEdit(null)}
        />
      )}
      {confirm && (
        <ConfirmModal
          title={`${confirm.action.toUpperCase()} ${confirm.guest.type?.toUpperCase()} ${confirm.guest.vmid}?`}
          message={`${confirm.guest.name ?? ''} on ${confirm.guest.node}. This affects a running guest.`}
          confirmLabel={confirm.action.charAt(0).toUpperCase() + confirm.action.slice(1)}
          danger={confirm.action === 'stop'}
          onConfirm={() => void clusterStore.guestPower(confirm.guest.vmid, confirm.action)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  )
})
