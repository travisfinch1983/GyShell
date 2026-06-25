import React, { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { clusterStore, type ClusterGuest } from '../../stores/ClusterStore'
import styles from './Cluster.module.scss'

/** Parse a PVE features string ("nesting=1,fuse=1,mount=nfs;cifs") into a map. */
function parseFeatures(s?: string): Record<string, string> {
  const out: Record<string, string> = {}
  ;(s || '').split(',').forEach((kv) => {
    const i = kv.indexOf('=')
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  })
  return out
}

const TOGGLES: Array<{ key: string; label: string }> = [
  { key: 'nesting', label: 'nesting (run containers/Docker inside)' },
  { key: 'keyctl', label: 'keyctl (systemd / keyring)' },
  { key: 'fuse', label: 'fuse (FUSE mounts)' },
]

export const FeaturesModal: React.FC<{ guest: ClusterGuest; onClose: () => void }> = ({ guest, onClose }) => {
  const init = parseFeatures(guest.features)
  const [flags, setFlags] = useState<Record<string, boolean>>({
    nesting: init.nesting === '1',
    keyctl: init.keyctl === '1',
    fuse: init.fuse === '1',
  })
  const [mount, setMount] = useState(init.mount ?? '')
  const busy = clusterStore.actionBusy === guest.vmid

  const save = async () => {
    const parts: string[] = []
    for (const t of TOGGLES) if (flags[t.key]) parts.push(`${t.key}=1`)
    if (mount.trim()) parts.push(`mount=${mount.trim()}`)
    await clusterStore.setFeatures(guest.vmid, parts.join(','))
    if (!clusterStore.actionError) onClose()
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>
          Features · LXC {guest.vmid} <span className={styles.dim}>({guest.name})</span>
        </div>
        {guest.unprivileged === 0 && <div className={styles.modalNote}>Privileged container — features apply directly.</div>}
        {TOGGLES.map((t) => (
          <label key={t.key} className={styles.modalRow} style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={!!flags[t.key]} onChange={(e) => setFlags((f) => ({ ...f, [t.key]: e.target.checked }))} />
            <span>{t.label}</span>
          </label>
        ))}
        <div className={styles.modalRow}>
          <label>mount</label>
          <input value={mount} placeholder="e.g. nfs;cifs" onChange={(e) => setMount(e.target.value)} />
        </div>
        {clusterStore.actionError && <div className={styles.modalErr}>{clusterStore.actionError}</div>}
        <div className={styles.modalActions}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className={styles.primary} onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className={styles.modalNote}>Reboot the container to apply feature changes.</div>
      </div>
    </div>
  )
}

export const EnvModal: React.FC<{ guest: ClusterGuest; onClose: () => void }> = ({ guest, onClose }) => {
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>(() =>
    Object.entries(guest.lxcenv ?? {}).map(([key, value]) => ({ key, value: String(value) })),
  )
  const busy = clusterStore.actionBusy === guest.vmid

  const save = async () => {
    const vars: Record<string, string> = {}
    for (const r of rows) if (r.key.trim()) vars[r.key.trim()] = r.value
    await clusterStore.setEnv(guest.vmid, vars)
    if (!clusterStore.actionError) onClose()
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>
          Environment · LXC {guest.vmid} <span className={styles.dim}>({guest.name})</span>
        </div>
        <div className={styles.modalNote}>lxc.environment entries injected into the container.</div>
        {rows.map((r, i) => (
          <div key={i} className={styles.qRow}>
            <input className={styles.qLabel} value={r.key} placeholder="KEY" onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <input className={styles.qQuery} value={r.value} placeholder="value" onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button className={`${styles.iconBtn} ${styles.danger}`} title="Remove" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button className={styles.addChartBtn} onClick={() => setRows((rs) => [...rs, { key: '', value: '' }])}>
          <Plus size={13} /> Add variable
        </button>
        {clusterStore.actionError && <div className={styles.modalErr}>{clusterStore.actionError}</div>}
        <div className={styles.modalActions}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className={styles.primary} onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
