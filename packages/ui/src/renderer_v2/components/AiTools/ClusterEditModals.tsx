import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { X, Plus, Eye, EyeOff } from 'lucide-react'
import { clusterInfoStore as store } from '../../stores/ClusterInfoStore'
import {
  HOST_TYPE_OPTIONS, RAM_TYPE_OPTIONS, GPU_INTERLINK_GEN, SECTION_FIELDS, SECTION_ORDER, calcRamBandwidth, type Field,
} from './clusterEditConstants'
import styles from './AiTools.module.scss'

// ─── Credential add/edit ───
export const CredentialEditModal: React.FC<{ id: string; onClose: () => void }> = observer(({ id, onClose }) => {
  const isNew = id === 'new'
  const [e, setE] = useState<any>({ name: '', type: 'login', url: '', username: '', password: '', tokenId: '', tokenSecret: '', sshPrivateKey: '', sshPublicKey: '', sshKeyPath: '', bearerToken: '', notes: '', tags: [] })
  const [loading, setLoading] = useState(!isNew)
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!isNew) void (async () => { const full = await store.getCredential(id); if (full) setE((p: any) => ({ ...p, ...full })); setLoading(false) })() }, [])
  const set = (k: string, v: any) => setE((p: any) => ({ ...p, [k]: v }))
  const ptype = reveal ? 'text' : 'password'
  const save = async () => {
    if (!e.name.trim()) return
    setBusy(true)
    const body = { ...e, name: e.name.trim(), tags: Array.isArray(e.tags) ? e.tags : String(e.tags).split(',').map((t) => t.trim()).filter(Boolean) }
    try { await store.saveCredential(body, isNew ? undefined : id); onClose() } finally { setBusy(false) }
  }
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} style={{ maxWidth: 560 }} onClick={(ev) => ev.stopPropagation()}>
        <div className={styles.modalHead}><strong>{isNew ? 'Add Credential' : 'Edit Credential'}</strong><span className={styles.spacer} /><button className={styles.iconBtn} onClick={onClose}><X size={14} /></button></div>
        {loading ? <div className={styles.muted}>Loading…</div> : (
          <div className={styles.editForm}>
            <label className={styles.efRow}><span className={styles.efLbl}>Name</span><input className={styles.input} value={e.name} onChange={(ev) => set('name', ev.target.value)} /></label>
            <label className={styles.efRow}><span className={styles.efLbl}>Type</span>
              <select className={styles.input} value={e.type} onChange={(ev) => set('type', ev.target.value)}>
                <option value="login">Login (user/pass)</option><option value="api_token">API Token</option><option value="ssh_key">SSH Key</option><option value="bearer_token">Bearer Token</option>
              </select>
            </label>
            <label className={styles.efRow}><span className={styles.efLbl}>URL</span><input className={styles.input} value={e.url} placeholder="https://…" onChange={(ev) => set('url', ev.target.value)} /></label>
            <div className={styles.revealRow}><button className={styles.btn} onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={13} /> : <Eye size={13} />} {reveal ? 'Hide' : 'Reveal'} secrets</button></div>
            {e.type === 'login' && <>
              <label className={styles.efRow}><span className={styles.efLbl}>Username</span><input className={styles.input} value={e.username} onChange={(ev) => set('username', ev.target.value)} /></label>
              <label className={styles.efRow}><span className={styles.efLbl}>Password</span><input className={styles.input} type={ptype} value={e.password} onChange={(ev) => set('password', ev.target.value)} /></label>
            </>}
            {e.type === 'api_token' && <>
              <label className={styles.efRow}><span className={styles.efLbl}>Token ID</span><input className={styles.input} value={e.tokenId} onChange={(ev) => set('tokenId', ev.target.value)} /></label>
              <label className={styles.efRow}><span className={styles.efLbl}>Token Secret</span><input className={styles.input} type={ptype} value={e.tokenSecret} onChange={(ev) => set('tokenSecret', ev.target.value)} /></label>
            </>}
            {e.type === 'ssh_key' && <>
              <label className={styles.efCol}><span className={styles.efLbl}>Private Key</span><textarea className={styles.editor} rows={6} value={reveal ? e.sshPrivateKey : (e.sshPrivateKey ? '••••••••' : '')} onChange={(ev) => set('sshPrivateKey', ev.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></label>
              <label className={styles.efCol}><span className={styles.efLbl}>Public Key</span><textarea className={styles.editor} rows={2} value={e.sshPublicKey} onChange={(ev) => set('sshPublicKey', ev.target.value)} placeholder="ssh-ed25519 AAAA… user@host" /></label>
              <label className={styles.efRow}><span className={styles.efLbl}>Key Path</span><input className={styles.input} value={e.sshKeyPath} placeholder="/root/.ssh/id_ed25519" onChange={(ev) => set('sshKeyPath', ev.target.value)} /></label>
            </>}
            {e.type === 'bearer_token' && <label className={styles.efRow}><span className={styles.efLbl}>Bearer Token</span><input className={styles.input} type={ptype} value={e.bearerToken} onChange={(ev) => set('bearerToken', ev.target.value)} /></label>}
            <label className={styles.efCol}><span className={styles.efLbl}>Notes</span><textarea className={styles.editor} rows={2} value={e.notes} onChange={(ev) => set('notes', ev.target.value)} /></label>
            <label className={styles.efRow}><span className={styles.efLbl}>Tags</span><input className={styles.input} value={Array.isArray(e.tags) ? e.tags.join(', ') : e.tags} onChange={(ev) => set('tags', ev.target.value)} placeholder="comma, separated" /></label>
          </div>
        )}
        <div className={styles.modalFoot}><span className={styles.spacer} /><button className={styles.btn} onClick={onClose}>Cancel</button><button className={styles.btnPrimary} disabled={busy || !e.name?.trim()} onClick={() => void save()}>{isNew ? 'Add' : 'Save'}</button></div>
      </div>
    </div>
  )
})

// ─── Hardware (PVE host) add/edit ───
const blankHw = () => ({ hostType: '', ramType: '', ramEcc: 'Non-ECC', ramSpeed: '', ramAmount: '', ramChannels: '2', cpus: [], gpus: [], zpools: [], nics: [], pcieCards: [], psus: [] })

export const HardwareEditModal: React.FC<{ id: string; onClose: () => void }> = observer(({ id, onClose }) => {
  const isNew = id === 'new'
  const [h, setH] = useState<any>({ name: '', ip: '', primaryUse: '', notes: '', tags: [], hostHardware: blankHw() })
  const [loading, setLoading] = useState(!isNew)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!isNew) void (async () => { const full = await store.getHost(id); if (full) setH({ name: full.name || '', ip: full.ip || '', primaryUse: full.primaryUse || '', notes: full.notes || '', tags: full.tags || [], hostHardware: { ...blankHw(), ...(full.hostHardware || {}) } }); setLoading(false) })() }, [])
  const hw = h.hostHardware
  const setTop = (k: string, v: any) => setH((p: any) => ({ ...p, [k]: v }))
  const setHw = (k: string, v: any) => setH((p: any) => ({ ...p, hostHardware: { ...p.hostHardware, [k]: v } }))
  const addRow = (s: string) => setHw(s, [...(hw[s] || []), {}])
  const removeRow = (s: string, i: number) => setHw(s, hw[s].filter((_: any, j: number) => j !== i))
  const setRow = (s: string, i: number, k: string, v: any) => setHw(s, hw[s].map((r: any, j: number) => (j === i ? { ...r, [k]: v } : r)))
  const bandwidth = calcRamBandwidth(hw.ramType, hw.ramSpeed, hw.ramChannels, (hw.cpus || []).length) || '—'
  const save = async () => {
    if (!h.name.trim()) return
    setBusy(true)
    const body = { name: h.name.trim(), ip: h.ip.trim(), primaryUse: h.primaryUse.trim(), notes: h.notes.trim(), tags: Array.isArray(h.tags) ? h.tags : String(h.tags).split(',').map((t) => t.trim()).filter(Boolean), hostHardware: { ...hw, ramBandwidth: bandwidth === '—' ? '' : bandwidth } }
    try { await store.saveHost(body, isNew ? undefined : id); onClose() } finally { setBusy(false) }
  }
  const renderField = (s: string, i: number, row: any, f: Field) => {
    const val = row[f.k] ?? ''
    if (f.type === 'check') return <label key={f.k} className={styles.efCheck}><input type="checkbox" checked={!!row[f.k]} onChange={(e) => setRow(s, i, f.k, e.target.checked)} /> {f.label}</label>
    if (f.type === 'textarea') return <label key={f.k} className={styles.subFieldWide}><span className={styles.subLbl}>{f.label}</span><textarea className={styles.subInput} rows={2} value={val} onChange={(e) => setRow(s, i, f.k, e.target.value)} /></label>
    if (f.type === 'select' || (s === 'gpus' && f.k === 'interlinkGen')) {
      const opts = f.k === 'interlinkGen' ? GPU_INTERLINK_GEN[row.interlink || 'None'] || [] : (f.opts || [])
      return <label key={f.k} className={styles.subField}><span className={styles.subLbl}>{f.label}</span>
        <select className={styles.subInput} value={val} disabled={f.k === 'interlinkGen' && opts.length === 0} onChange={(e) => setRow(s, i, f.k, e.target.value)}>
          <option value="">—</option>{opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select></label>
    }
    return <label key={f.k} className={styles.subField}><span className={styles.subLbl}>{f.label}</span><input className={styles.subInput} type={f.type === 'number' ? 'number' : 'text'} value={val} placeholder={f.ph} onChange={(e) => setRow(s, i, f.k, e.target.value)} /></label>
  }
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} style={{ maxWidth: 900 }} onClick={(ev) => ev.stopPropagation()}>
        <div className={styles.modalHead}><strong>{isNew ? 'Add Host' : 'Edit Host'}</strong><span className={styles.spacer} /><button className={styles.iconBtn} onClick={onClose}><X size={14} /></button></div>
        {loading ? <div className={styles.muted}>Loading…</div> : (
          <div className={styles.editForm}>
            <div className={styles.efGrid}>
              <label className={styles.efRow}><span className={styles.efLbl}>Hostname</span><input className={styles.input} value={h.name} onChange={(e) => setTop('name', e.target.value)} /></label>
              <label className={styles.efRow}><span className={styles.efLbl}>IP</span><input className={styles.input} value={h.ip} onChange={(e) => setTop('ip', e.target.value)} /></label>
              <label className={styles.efRow}><span className={styles.efLbl}>Primary Use</span><input className={styles.input} value={h.primaryUse} onChange={(e) => setTop('primaryUse', e.target.value)} /></label>
              <label className={styles.efRow}><span className={styles.efLbl}>Host Type</span><select className={styles.input} value={hw.hostType} onChange={(e) => setHw('hostType', e.target.value)}><option value="">—</option>{HOST_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
              <label className={styles.efRow}><span className={styles.efLbl}>RAM Type</span><select className={styles.input} value={hw.ramType} onChange={(e) => setHw('ramType', e.target.value)}><option value="">—</option>{RAM_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
              <label className={styles.efRow}><span className={styles.efLbl}>ECC</span>
                <select className={styles.input} value={hw.ramEcc} onChange={(e) => setHw('ramEcc', e.target.value)}><option>Non-ECC</option><option>ECC</option></select></label>
              <label className={styles.efRow}><span className={styles.efLbl}>Speed (MT/s)</span><input className={styles.input} value={hw.ramSpeed} placeholder="3200" onChange={(e) => setHw('ramSpeed', e.target.value)} /></label>
              <label className={styles.efRow}><span className={styles.efLbl}>Amount (GB)</span><input className={styles.input} type="number" value={hw.ramAmount} placeholder="128" onChange={(e) => setHw('ramAmount', e.target.value)} /></label>
              <label className={styles.efRow}><span className={styles.efLbl}>Channels</span><input className={styles.input} type="number" value={hw.ramChannels} onChange={(e) => setHw('ramChannels', e.target.value)} /></label>
              <div className={styles.efRow}><span className={styles.efLbl}>Bandwidth</span><span className={styles.bwVal}>{bandwidth}</span></div>
            </div>

            {SECTION_ORDER.map((s) => (
              <div key={s} className={styles.subSection}>
                <div className={styles.subHead}><span>{SECTION_FIELDS[s].label}</span><button className={styles.smBtn} onClick={() => addRow(s)}><Plus size={12} /> Add</button></div>
                {(hw[s] || []).map((row: any, i: number) => (
                  <div key={i} className={styles.subRow}>
                    {SECTION_FIELDS[s].fields.map((f) => renderField(s, i, row, f))}
                    <button className={styles.iconDanger} title="Remove" onClick={() => removeRow(s, i)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            ))}

            <label className={styles.efRow}><span className={styles.efLbl}>Tags</span><input className={styles.input} value={Array.isArray(h.tags) ? h.tags.join(', ') : h.tags} onChange={(e) => setTop('tags', e.target.value)} placeholder="comma, separated" /></label>
            <label className={styles.efCol}><span className={styles.efLbl}>Notes</span><textarea className={styles.editor} rows={2} value={h.notes} onChange={(e) => setTop('notes', e.target.value)} /></label>
          </div>
        )}
        <div className={styles.modalFoot}><span className={styles.spacer} /><button className={styles.btn} onClick={onClose}>Cancel</button><button className={styles.btnPrimary} disabled={busy || !h.name?.trim()} onClick={() => void save()}>{isNew ? 'Add' : 'Save'}</button></div>
      </div>
    </div>
  )
})
