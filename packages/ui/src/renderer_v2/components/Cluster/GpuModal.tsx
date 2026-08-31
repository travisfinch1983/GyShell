import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { clusterStore, type ClusterGuest } from '../../stores/ClusterStore'
import styles from './Cluster.module.scss'

export const GpuModal: React.FC<{ guest: ClusterGuest; onClose: () => void }> = observer(
  ({ guest, onClose }) => {
    const node = clusterStore.gpuInventory?.[guest.node ?? '']
    const gpus: any[] = node?.allGpus ?? node?.nvidiaGpus ?? []
    const current =
      clusterStore.gpuAssignments?.[String(guest.vmid)] ?? clusterStore.gpuAssignments?.[guest.vmid as any]
    const busy = clusterStore.actionBusy === guest.vmid

    const [selected, setSelected] = useState<string[] | null>(null)
    const [mountStyle, setMountStyle] = useState<'new' | 'old'>('new')

    useEffect(() => {
      if (current && selected === null) {
        setSelected(current.gpus ?? [])
        if (current.mountStyle === 'old' || current.mountStyle === 'new') setMountStyle(current.mountStyle)
      }
    }, [current, selected])

    const sel: string[] = selected ?? current?.gpus ?? []
    const toggle = (pciId: string) => {
      const base: string[] = selected ?? current?.gpus ?? []
      setSelected(base.includes(pciId) ? base.filter((x) => x !== pciId) : [...base, pciId])
    }

    // Assigned PCI ids that are NOT among this node's currently-detected GPUs (e.g. a card that was
    // removed/moved). Without rendering these, they have no checkbox to clear — so they stay stuck in
    // the assignment forever, inflate the badge count, and break container launch (hookscript tries to
    // mount a device that no longer exists). Render them checked so they can be unchecked/removed.
    const staleAssigned: string[] = sel.filter((id) => !gpus.some((g) => g.pciId === id))

    const save = async () => {
      await clusterStore.setGpuAssignment(guest.vmid, { mountStyle, gpus: sel })
      if (!clusterStore.actionError) onClose()
    }
    const clear = async () => {
      await clusterStore.clearGpuAssignment(guest.vmid)
      if (!clusterStore.actionError) onClose()
    }

    return (
      <div className={styles.modalOverlay} onClick={onClose}>
        <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalTitle}>
            GPU assignment · LXC {guest.vmid} <span className={styles.dim}>({guest.name})</span>
          </div>
          <div className={styles.modalRow}>
            <label>Node</label>
            <span className={styles.mono}>{guest.node}</span>
          </div>
          <div className={styles.modalRow}>
            <label>Mount style</label>
            <select value={mountStyle} onChange={(e) => setMountStyle(e.target.value as 'new' | 'old')}>
              <option value="new">new (cgroup2 / device entries)</option>
              <option value="old">old (devfn)</option>
            </select>
          </div>
          <div className={styles.gpuList}>
            {clusterStore.modalDataError && (
              <div className={styles.dim} style={{ color: 'var(--danger, #e05555)', fontWeight: 600 }}>
                ⚠ load failed ({clusterStore.modalDataError}) — empty lists below mean UNKNOWN, not "none available"
              </div>
            )}
            {!clusterStore.gpuInventory && !clusterStore.modalDataError && <div className={styles.dim}>Loading GPUs…</div>}
            {clusterStore.gpuInventory && gpus.length === 0 && staleAssigned.length === 0 && (
              <div className={styles.dim}>No GPUs detected on {guest.node}.</div>
            )}
            {gpus.map((gpu) => (
              <label key={gpu.pciId} className={styles.gpuItem}>
                <input type="checkbox" checked={sel.includes(gpu.pciId)} onChange={() => toggle(gpu.pciId)} />
                <span className={styles.mono}>{gpu.pciId}</span>
                <span>{gpu.friendlyName || gpu.productName || gpu.vendor}</span>
              </label>
            ))}
            {staleAssigned.map((pciId) => (
              <label key={pciId} className={styles.gpuItem}>
                <input type="checkbox" checked onChange={() => toggle(pciId)} />
                <span className={styles.mono}>{pciId}</span>
                <span className={styles.modalErr}>⚠ not present on {guest.node} — uncheck to remove</span>
              </label>
            ))}
          </div>
          {clusterStore.actionError && <div className={styles.modalErr}>{clusterStore.actionError}</div>}
          <div className={styles.modalActions}>
            <button onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button onClick={() => void clear()} disabled={busy} className={styles.danger}>
              Clear all
            </button>
            <button className={styles.primary} onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
          <div className={styles.modalNote}>Changes apply on next container reboot.</div>
        </div>
      </div>
    )
  },
)
