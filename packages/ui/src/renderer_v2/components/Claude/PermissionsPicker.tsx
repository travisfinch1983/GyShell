import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Save, Shield } from 'lucide-react'
import { claudeStore } from '../../stores/ClaudeStore'
import { claudeInstancesStore as store } from '../../stores/ClaudeInstancesStore'
import type { ClaudeInstance, ClusterPermissions } from '../../stores/instanceManager'
import styles from './Claude.module.scss'

/**
 * Soft cluster-permissions editor (fleet-consolidation req 4): a primary
 * container + a click-to-highlight badge per LXC, with All/None toggles.
 * ADVISORY ONLY — this informs the instance which containers it may act in;
 * real enforcement stays at the SSH-key/credential level.
 */
export const PermissionsPicker: React.FC<{ instance: ClaudeInstance }> = observer(({ instance }) => {
  const [primary, setPrimary] = useState<number | null>(instance.primaryVmid ?? null)
  const [allowed, setAllowed] = useState<'all' | number[]>(instance.allowed)
  const [status, setStatus] = useState('')

  // Re-sync local edits when the backend copy changes (e.g. after reload).
  useEffect(() => {
    setPrimary(instance.primaryVmid ?? null)
    setAllowed(instance.allowed)
  }, [instance.id, instance.primaryVmid, JSON.stringify(instance.allowed)])

  const lxc = claudeStore.lxc.slice().sort((a, b) => Number(a.vmid) - Number(b.vmid))
  const isAllowed = (vmid: number) => allowed === 'all' || allowed.includes(vmid)
  const toggle = (vmid: number) => {
    setStatus('')
    if (allowed === 'all') {
      // Leaving "all": switch to an explicit list without this one.
      setAllowed(lxc.map((l) => Number(l.vmid)).filter((v) => v !== vmid))
      return
    }
    setAllowed(allowed.includes(vmid) ? allowed.filter((v) => v !== vmid) : [...allowed, vmid])
  }

  const dirty =
    primary !== (instance.primaryVmid ?? null) ||
    JSON.stringify(allowed) !== JSON.stringify(instance.allowed)

  const save = async () => {
    setStatus('Saving…')
    try {
      const permissions: ClusterPermissions = { primaryVmid: primary, allowed }
      await store.setPermissions(instance.id, permissions)
      setStatus('Saved')
    } catch (e: any) {
      setStatus('Save failed: ' + (e?.message || e))
    }
  }

  return (
    <div className={styles.permBox}>
      <div className={styles.fileTabs}>
        <strong className={styles.permTitle}>
          <Shield size={13} /> Cluster access (advisory)
        </strong>
        <span className={styles.dim}>
          informational — tells the instance where it may act; enforcement stays at SSH-key level
        </span>
        <span className={styles.spacer} />
        <span className={styles.dim}>{status}</span>
        <button className={styles.btn} onClick={() => { setStatus(''); setAllowed('all') }}>All</button>
        <button className={styles.btn} onClick={() => { setStatus(''); setAllowed([]) }}>None</button>
        <button className={styles.btnPrimary} disabled={!dirty} onClick={() => void save()}>
          <Save size={12} /> Save
        </button>
      </div>
      <label className={styles.field}>
        <span>Primary container</span>
        <select
          value={primary === null ? '' : String(primary)}
          onChange={(e) => { setStatus(''); setPrimary(e.target.value === '' ? null : Number(e.target.value)) }}
        >
          <option value="">(none)</option>
          {lxc.map((l) => (
            <option key={l.vmid} value={String(l.vmid)}>
              {l.name} (CT {l.vmid})
            </option>
          ))}
        </select>
      </label>
      <div className={styles.permBadges}>
        {allowed === 'all' && <span className={styles.dim}>All containers allowed — click any badge to switch to an explicit list.</span>}
        {lxc.map((l) => {
          const vmid = Number(l.vmid)
          const on = isAllowed(vmid)
          const isPrimary = primary === vmid
          return (
            <button
              key={l.vmid}
              type="button"
              className={`${styles.permBadge} ${on ? styles.permBadgeOn : ''} ${isPrimary ? styles.permBadgePrimary : ''}`}
              title={`CT ${l.vmid} · ${l.node}${isPrimary ? ' · PRIMARY' : ''}`}
              onClick={() => toggle(vmid)}
            >
              {l.name}
              {isPrimary ? ' ★' : ''}
            </button>
          )
        })}
      </div>
    </div>
  )
})
