import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, RotateCw, Eye, EyeOff, Search, Pencil, Plus } from 'lucide-react'
import { clusterInfoStore as store } from '../../stores/ClusterInfoStore'
import { HardwareEditModal, CredentialEditModal } from './ClusterEditModals'
import styles from './AiTools.module.scss'

const CRED_LABELS: Record<string, string> = { login: 'Login', api_token: 'API Token', ssh_key: 'SSH Key', bearer_token: 'Bearer' }
const statusClass = (s: string) => (s === 'running' || s === 'online' ? styles.up : s === 'stopped' || s === 'offline' ? styles.down : styles.unknown)

export const ClusterInfoPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const [editHost, setEditHost] = useState<string | null>(null)
  const [editCred, setEditCred] = useState<string | null>(null)

  return (
    <div className={styles.panel}>
      {editHost && <HardwareEditModal id={editHost} onClose={() => setEditHost(null)} />}
      {editCred && <CredentialEditModal id={editCred} onClose={() => setEditCred(null)} />}
      {store.err && <div className={styles.error}>{store.err}</div>}

      {/* Cluster Inventory */}
      <div className={styles.ragCard}>
        <div className={styles.head}>
          <h4 className={styles.h4}>Cluster Inventory <span className={styles.dim}>({store.inventory.length})</span></h4>
          <span className={styles.spacer} />
          <button className={styles.btn} disabled={store.scanning} onClick={() => void store.scan()}><RotateCw size={13} className={store.scanning ? styles.spin : ''} /> {store.scanning ? 'Scanning…' : 'Scan'}</button>
          <button className={styles.btn} onClick={() => void store.load()}><RefreshCw size={13} /> Refresh</button>
        </div>
        <div className={styles.filterRow}>
          <span className={styles.searchWrap}><Search size={12} /><input className={styles.searchInput} placeholder="Search name / IP / VMID / node" value={store.invSearch} onChange={(e) => (store.invSearch = e.target.value)} /></span>
          <select className={styles.miniSelect} value={store.invType} onChange={(e) => (store.invType = e.target.value)}>
            <option value="">All types</option>
            {store.invTypes.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
          </select>
        </div>
        <div className={styles.invList}>
          {store.filteredInventory.length === 0 && <div className={styles.muted}>{store.loaded ? 'No matching entries.' : 'Loading…'}</div>}
          {store.filteredInventory.map((e) => (
            <div key={e.id} className={styles.invEntry}>
              <div className={styles.invHead}>
                <span className={`${styles.typeBadge} ${styles['t_' + e.type] || ''}`}>{String(e.type || '').toUpperCase()}</span>
                {e.vmid && <span className={styles.vmid}>{e.vmid}</span>}
                <span className={styles.bold}>{e.name}</span>
                <span className={statusClass(e.status)}>{e.status || '?'}</span>
                <span className={styles.spacer} />
                {e.vmid && <button className={styles.iconBtn} title="Rescan" onClick={() => void store.rescanInventory(e.id)}><RotateCw size={12} /></button>}
                <button className={styles.iconDanger} title="Delete" onClick={() => { if (window.confirm(`Remove "${e.name}" from inventory?`)) void store.deleteInventory(e.id) }}><Trash2 size={12} /></button>
              </div>
              <div className={styles.invMeta}>
                {e.ip && <span>IP: {e.ip}</span>}
                {e.node && <span>Node: {e.node}</span>}
                {e.gpus && <span>GPUs: {e.gpus}</span>}
                {e.role && <span>Role: {e.role}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Cluster Hardware */}
      <div className={styles.ragCard}>
        <div className={styles.head}>
          <h4 className={styles.h4}>Cluster Hardware <span className={styles.dim}>({store.hosts.length})</span></h4>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={() => setEditHost('new')}><Plus size={13} /> Add Host</button>
          <button className={styles.btn} onClick={() => void store.load()}><RefreshCw size={13} /> Refresh</button>
        </div>
        <div className={styles.invList}>
          {store.hosts.map((h) => {
            const hw = h.hostHardware || {}
            const ramGB = h.ram ? Math.round(h.ram / 1073741824) : 0
            const cpu = (hw.cpus || []).map((c: any) => c.model || 'Unknown CPU').join(', ') || `${h.cpu || '?'} cores`
            const gpu = (hw.gpus || []).map((g: any) => `${g.brand || ''} ${g.name || ''}`.trim()).join(', ') || 'None'
            const zpools = (hw.zpools || []).map((z: any) => z.name || '').filter(Boolean).join(', ') || 'None'
            return (
              <div key={h.id} className={styles.invEntry}>
                <div className={styles.invHead}>
                  <span className={`${styles.typeBadge} ${styles.t_host}`}>HOST</span>
                  <span className={styles.bold}>{h.name}</span>
                  <span className={statusClass(h.status)}>{h.status || '?'}</span>
                  <span className={styles.spacer} />
                  <button className={styles.iconBtn} title="Edit" onClick={() => setEditHost(h.id)}><Pencil size={12} /></button>
                  <button className={styles.iconDanger} title="Delete" onClick={() => { if (window.confirm(`Remove host "${h.name}"?`)) void store.deleteHost(h.id) }}><Trash2 size={12} /></button>
                </div>
                <div className={styles.invMeta}>
                  {h.ip && <span>IP: {h.ip}</span>}
                  <span>CPU: {cpu}</span>
                  {(hw.ramAmount || ramGB) ? <span>RAM: {hw.ramAmount || ramGB}GB {hw.ramType || ''} {hw.ramEcc || ''}</span> : null}
                  <span>GPUs: {gpu}</span>
                  <span>Zpools: {zpools}</span>
                  {hw.hostType && <span>Type: {hw.hostType}</span>}
                </div>
                {h.primaryUse && <div className={styles.dim}>{h.primaryUse}</div>}
              </div>
            )
          })}
        </div>
      </div>

      {/* Credential Vault */}
      <div className={styles.ragCard}>
        <div className={styles.head}>
          <h4 className={styles.h4}>Credential Vault <span className={styles.dim}>({store.credentials.length})</span></h4>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={() => setEditCred('new')}><Plus size={13} /> Add Credential</button>
          <button className={styles.btn} onClick={() => void store.load()}><RefreshCw size={13} /> Refresh</button>
        </div>
        <div className={styles.invList}>
          {store.credentials.map((e) => {
            const rev = store.revealed[e.id]
            return (
              <div key={e.id} className={styles.invEntry}>
                <div className={styles.invHead}>
                  <span className={styles.credBadge}>{CRED_LABELS[e.type] || e.type}</span>
                  <span className={styles.bold}>{e.name}</span>
                  <span className={styles.spacer} />
                  {(e.password || e.tokenSecret || e.type === 'ssh_key') && (
                    <button className={styles.iconBtn} title={rev ? 'Hide' : 'Reveal'} onClick={() => void store.toggleReveal(e.id)}>{rev ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                  )}
                  <button className={styles.iconDanger} title="Delete" onClick={() => { if (window.confirm(`Delete credential "${e.name}"?`)) void store.deleteCredential(e.id) }}><Trash2 size={12} /></button>
                </div>
                <div className={styles.invMeta}>
                  {e.url && <span>URL: {e.url}</span>}
                  {e.username && <span>User: {e.username}</span>}
                  {e.tokenId && <span>Token: {e.tokenId}</span>}
                  {e.password && (rev ? <span className={styles.secret}>pw: {rev.password}</span> : <span className={styles.masked}>••••••••</span>)}
                  {e.tokenSecret && (rev ? <span className={styles.secret}>secret: {rev.tokenSecret}</span> : <span className={styles.masked}>••••••••</span>)}
                  {e.type === 'ssh_key' && (rev?.sshPrivateKey ? <span className={styles.secret}>private key revealed below</span> : (e.sshKeyPath ? <span>Path: {e.sshKeyPath}</span> : <span className={styles.dim}>key stored</span>))}
                </div>
                {rev?.sshPrivateKey && <textarea className={styles.editor} readOnly rows={4} value={rev.sshPrivateKey} />}
                {e.notes && <div className={styles.dim}>{e.notes}</div>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})
