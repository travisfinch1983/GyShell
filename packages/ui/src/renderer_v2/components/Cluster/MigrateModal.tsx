import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { clusterStore, type ClusterGuest } from '../../stores/ClusterStore'
import styles from './Cluster.module.scss'

export const MigrateModal: React.FC<{ guest: ClusterGuest; onClose: () => void }> = observer(
  ({ guest, onClose }) => {
    const targets = clusterStore.orderedNodes.filter((n) => n.node !== guest.node)
    const [target, setTarget] = useState(targets[0]?.node ?? '')
    const [online, setOnline] = useState(guest.status === 'running')
    const [storage, setStorage] = useState('')

    const storages = clusterStore.storages ?? []
    const busy = clusterStore.actionBusy === guest.vmid

    const submit = async () => {
      if (!target) return
      const body: Record<string, unknown> = { target, mode: online ? 'online' : 'offline' }
      if (storage) body.targetStorage = storage
      await clusterStore.migrate(guest.vmid, body)
      if (!clusterStore.actionError) onClose()
    }

    return (
      <div className={styles.modalOverlay} onClick={onClose}>
        <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalTitle}>
            Migrate {guest.type?.toUpperCase()} {guest.vmid} <span className={styles.dim}>({guest.name})</span>
          </div>
          <div className={styles.modalRow}>
            <label>From</label>
            <span className={styles.mono}>{guest.node}</span>
          </div>
          <div className={styles.modalRow}>
            <label>To node</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((n) => (
                <option key={n.node} value={n.node}>
                  {n.node}
                </option>
              ))}
            </select>
          </div>
          {clusterStore.modalDataError && (
            <div className={styles.modalRow} style={{ color: 'var(--danger, #e05555)', fontSize: 11.5, fontWeight: 600 }}>
              ⚠ modal data failed to load ({clusterStore.modalDataError}) — empty pickers here mean UNKNOWN, not "no targets"; this gates a migration, so reload before proceeding
            </div>
          )}
          <div className={styles.modalRow}>
            <label>Target storage</label>
            <select value={storage} onChange={(e) => setStorage(e.target.value)}>
              <option value="">— keep current —</option>
              {storages.map((st: any) => (
                <option key={st.storage} value={st.storage}>
                  {st.storage} {st.type ? `(${st.type})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.modalRow}>
            <label>Online</label>
            <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} />
            <span className={styles.dim}>live migrate (running guest)</span>
          </div>
          {clusterStore.actionError && <div className={styles.modalErr}>{clusterStore.actionError}</div>}
          <div className={styles.modalActions}>
            <button onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className={styles.primary} onClick={() => void submit()} disabled={busy || !target}>
              {busy ? 'Migrating…' : 'Migrate'}
            </button>
          </div>
        </div>
      </div>
    )
  },
)
