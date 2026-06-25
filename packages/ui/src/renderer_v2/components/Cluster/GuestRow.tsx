import React from 'react'
import { observer } from 'mobx-react-lite'
import { ChevronRight, ChevronDown, MoreVertical, Settings, Cpu, ShieldAlert } from 'lucide-react'
import { clusterStore, type ClusterGuest } from '../../stores/ClusterStore'
import { MetricChart } from './MetricChart'
import { resolveQuery, type GearEdit } from '../../stores/metricTemplates'
import styles from './Cluster.module.scss'

export interface GuestRowHandlers {
  onPower: (g: ClusterGuest, action: 'start' | 'stop' | 'shutdown' | 'reboot') => void
  onEditCores: (g: ClusterGuest) => void
  onEditMemory: (g: ClusterGuest) => void
  onResizeDisk: (g: ClusterGuest) => void
  onEditOrder: (g: ClusterGuest) => void
  onEditTty: (g: ClusterGuest) => void
  onFeatures: (g: ClusterGuest) => void
  onEnv: (g: ClusterGuest) => void
  onMigrate: (g: ClusterGuest) => void
  onGpu: (g: ClusterGuest) => void
}

/** A small OS glyph from the PVE ostype. */
function osGlyph(ostype?: string): { icon: string; label: string } {
  const o = (ostype || '').toLowerCase()
  if (o.startsWith('win')) return { icon: '🪟', label: ostype || 'windows' }
  if (['debian', 'ubuntu', 'alpine', 'archlinux', 'fedora', 'centos', 'gentoo', 'opensuse', 'l26', 'nixos'].some((d) => o.includes(d)))
    return { icon: '🐧', label: ostype || 'linux' }
  if (o === 'l24') return { icon: '🐧', label: 'linux 2.4' }
  return { icon: '🖥️', label: ostype || 'unknown' }
}

const CMODES = ['tty', 'console', 'shell']

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
  const template = clusterStore.getTemplate(isLxc ? 'lxc' : 'qemu')

  const gpuAssigned = clusterStore.gpuAssignments?.[String(g.vmid)]?.gpus?.length ?? 0
  const os = osGlyph(g.ostype)
  const privileged = isLxc && g.unprivileged === 0
  const isAi = clusterStore.isAi(g.vmid)

  return (
    <div className={`${styles.guestEntry} ${busy ? styles.rowBusy : ''} ${isAi ? styles.aiEntry : ''}`}>
      <div className={styles.guestRow1}>
        <button className={styles.expandBtn} onClick={onToggleExpand} title="Metrics">
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <span className={`${styles.dot} ${running ? styles.ok : styles.idle}`} />
        <span className={styles.osIcon} title={os.label}>{os.icon}</span>
        <span className={styles.gVmid}>{g.vmid}</span>
        <span className={`${styles.gName} ${isAi ? styles.aiName : ''}`}>{g.name ?? '—'}</span>
        {privileged && <ShieldAlert size={13} className={styles.shield} aria-label="Privileged" />}
        {isAi && <span className={styles.aiBadge}>AI</span>}
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

        {isLxc && (
          <button className={styles.ctrlBtn} disabled={busy} title="TTY count" onClick={() => h.onEditTty(g)}>
            tty:{g.tty ?? 2}
          </button>
        )}

        {isLxc && (
          <select
            className={styles.ctrlSelect}
            value={g.cmode ?? 'tty'}
            disabled={busy}
            title="Console mode"
            onChange={(e) => clusterStore.setConfig(g.vmid, { cmode: e.target.value })}
          >
            {CMODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}

        {isLxc && (
          <button className={styles.ctrlBtn} disabled={busy} title="LXC features" onClick={() => h.onFeatures(g)}>
            features
          </button>
        )}

        {isLxc && (
          <button className={styles.ctrlBtn} disabled={busy} title="Environment variables" onClick={() => h.onEnv(g)}>
            env{g.lxcenv && Object.keys(g.lxcenv).length ? ` ·${Object.keys(g.lxcenv).length}` : ''}
          </button>
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
          {template.charts.map((chart) => {
            const gearFor: Record<Exclude<GearEdit, 'none'>, () => void> = {
              cores: () => h.onEditCores(g),
              memory: () => h.onEditMemory(g),
              disk: () => h.onResizeDisk(g),
              order: () => h.onEditOrder(g),
            }
            return (
              <div className={styles.metricCell} key={chart.id}>
                <div className={styles.metricHead}>
                  <span className={styles.metricName}>{chart.label}</span>
                  {chart.gear !== 'none' && (
                    <button className={styles.gear} title={`Edit ${chart.gear}`} onClick={gearFor[chart.gear]}>
                      <Settings size={12} />
                    </button>
                  )}
                </div>
                <MetricChart
                  title={chart.label}
                  viz={chart.viz}
                  unit={chart.unit}
                  series={chart.series.map((s) => ({ ...s, query: resolveQuery(s.query, guestId) }))}
                  fields={chart.fields.map((f) => ({ ...f, query: resolveQuery(f.query, guestId) }))}
                  rangeSeconds={template.rangeSeconds}
                  stepSeconds={template.stepSeconds}
                />
              </div>
            )
          })}
          {template.charts.length === 0 && (
            <div className={styles.noMetrics}>No metrics configured for this list — use “⚙ Metrics” in the list header.</div>
          )}
        </div>
      )}
    </div>
  )
})
