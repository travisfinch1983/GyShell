import React from 'react'
import { observer } from 'mobx-react-lite'
import { ChevronRight, ChevronDown, MoreVertical, Settings, Cpu } from 'lucide-react'
import { clusterStore, type ClusterGuest } from '../../stores/ClusterStore'
import { GrafanaPanel } from './GrafanaPanel'
import styles from './Cluster.module.scss'

export interface GuestRowHandlers {
  onPower: (g: ClusterGuest, action: 'start' | 'stop' | 'shutdown' | 'reboot') => void
  onEditCores: (g: ClusterGuest) => void
  onEditMemory: (g: ClusterGuest) => void
  onResizeDisk: (g: ClusterGuest) => void
  onEditOrder: (g: ClusterGuest) => void
  onMigrate: (g: ClusterGuest) => void
  onGpu: (g: ClusterGuest) => void
}

/**
 * A single guest as a 2-row entry (coding standard #3):
 *  Row 1 — inline controls (boot toggle, startup order, console, protection, GPU, power ⋯).
 *  Row 2 — lazily-loaded per-guest Grafana mini-panels (CPU/Mem/Disk) with a ⚙ gear beside
 *          the editable ones that opens the in-page editor. Only rendered when expanded, so we
 *          don't mount hundreds of Grafana iframes at once.
 */
export const GuestRow: React.FC<{
  guest: ClusterGuest
  expanded: boolean
  onToggleExpand: () => void
  menuOpen: boolean
  onMenuToggle: () => void
  h: GuestRowHandlers
}> = observer(({ guest: g, expanded, onToggleExpand, menuOpen, onMenuToggle, h }) => {
  const running = g.status === 'running'
  const busy = clusterStore.actionBusy === g.vmid
  const isLxc = g.type === 'lxc'
  const guestId = `${isLxc ? 'lxc' : 'qemu'}/${g.vmid}`

  const gpuAssigned = clusterStore.gpuAssignments?.[String(g.vmid)]?.gpus?.length ?? 0

  return (
    <div className={`${styles.guestEntry} ${busy ? styles.rowBusy : ''}`}>
      <div className={styles.guestRow1}>
        <button className={styles.expandBtn} onClick={onToggleExpand} title="Metrics">
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <span className={`${styles.dot} ${running ? styles.ok : styles.idle}`} />
        <span className={styles.gVmid}>{g.vmid}</span>
        <span className={styles.gName}>{g.name ?? '—'}</span>
        <span className={styles.gNode}>{g.node}</span>
        <span className={`${styles.status} ${running ? styles.ok : styles.idle}`}>{g.status ?? '—'}</span>

        <div className={styles.ctrlSpacer} />

        <label className={styles.ctrl} title="Start on boot">
          <input
            type="checkbox"
            checked={!!g.onboot}
            disabled={busy}
            onChange={() => clusterStore.setConfig(g.vmid, { onboot: g.onboot ? 0 : 1 })}
          />
          boot
        </label>

        <button className={styles.ctrlBtn} disabled={busy} title="Startup order" onClick={() => h.onEditOrder(g)}>
          order{g.startup ? `: ${String(g.startup).replace(/order=/, '').split(',')[0]}` : ''}
        </button>

        {isLxc && (
          <label className={styles.ctrl} title="Console (/dev/console)">
            <input
              type="checkbox"
              checked={!!g.console}
              disabled={busy}
              onChange={() => clusterStore.setConfig(g.vmid, { console: g.console ? 0 : 1 })}
            />
            console
          </label>
        )}

        <label className={styles.ctrl} title="Protection (prevent deletion)">
          <input
            type="checkbox"
            checked={!!g.protection}
            disabled={busy}
            onChange={() => clusterStore.setConfig(g.vmid, { protection: g.protection ? 0 : 1 })}
          />
          prot
        </label>

        {isLxc && (
          <button className={styles.ctrlBtn} disabled={busy} title="GPU assignment" onClick={() => h.onGpu(g)}>
            <Cpu size={12} /> GPU{gpuAssigned ? ` ·${gpuAssigned}` : ''}
          </button>
        )}

        <div className={styles.actionWrap}>
          <button className={styles.menuBtn} title="Actions" type="button" onClick={onMenuToggle}>
            <MoreVertical size={15} />
          </button>
          {menuOpen && (
            <>
              <div className={styles.menuBackdrop} onClick={onMenuToggle} />
              <div className={styles.menu}>
                {!running && <button onClick={() => h.onPower(g, 'start')}>Start</button>}
                {running && <button onClick={() => h.onPower(g, 'reboot')}>Reboot</button>}
                {running && <button onClick={() => h.onPower(g, 'shutdown')}>Shutdown</button>}
                {running && (
                  <button className={styles.danger} onClick={() => h.onPower(g, 'stop')}>
                    Stop
                  </button>
                )}
                <div className={styles.menuSep} />
                <button onClick={() => h.onMigrate(g)}>Migrate…</button>
              </div>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className={styles.guestRow2}>
          <div className={styles.metricCell}>
            <button className={styles.gear} title="Edit cores" onClick={() => h.onEditCores(g)}>
              <Settings size={12} />
            </button>
            <GrafanaPanel uid="pve-guest-homelab" panelId={1} height={120} vars={{ guest: guestId }} />
          </div>
          <div className={styles.metricCell}>
            <button className={styles.gear} title="Edit memory" onClick={() => h.onEditMemory(g)}>
              <Settings size={12} />
            </button>
            <GrafanaPanel uid="pve-guest-homelab" panelId={2} height={120} vars={{ guest: guestId }} />
          </div>
          <div className={styles.metricCell}>
            <button className={styles.gear} title="Resize disk" onClick={() => h.onResizeDisk(g)}>
              <Settings size={12} />
            </button>
            <GrafanaPanel uid="pve-guest-homelab" panelId={3} height={120} vars={{ guest: guestId }} />
          </div>
        </div>
      )}
    </div>
  )
})
