/**
 * FtpSettingsPanel — Settings › General → FTP Server subsection.
 *
 * Connection info (host + SFTP/FTP ports with live active badges) and FTP
 * user-account management against the backend's SFTPGo wrapper (/api/ftp/*).
 * Passwords are write-only: the API never returns one (hasPassword flag), and
 * on edit a blank password field preserves the stored secret.
 */
import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, Pencil, Plus, X } from 'lucide-react'
import { ftpStore as store, type FtpUser } from '../../stores/FtpStore'
import { confirmStore } from '../../stores/confirmStore'
import './FtpSettingsPanel.scss'

const GIB = 1024 ** 3
const GRANULAR_PERMS = ['list', 'download', 'upload', 'delete', 'rename', 'create_dirs', 'overwrite']
const READ_ONLY = ['list', 'download']

type Preset = 'full' | 'read-only' | 'custom'

function presetOf(perms: string[]): Preset {
  if (perms.includes('*')) return 'full'
  if (perms.length === READ_ONLY.length && READ_ONLY.every((p) => perms.includes(p))) return 'read-only'
  return 'custom'
}

function permLabel(perms: string[]): string {
  const p = presetOf(perms)
  return p === 'full' ? 'Full access' : p === 'read-only' ? 'Read-only' : perms.join(', ') || '—'
}

function quotaLabel(bytes: number): string {
  if (!bytes) return 'unlimited'
  const gb = bytes / GIB
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
}

interface Draft {
  editing?: string // username when editing; undefined = create
  username: string
  password: string
  homeDir: string
  preset: Preset
  customPerms: string[]
  quotaGb: string // '' or '0' = unlimited
  active: boolean
}

const blankDraft = (): Draft => ({ username: '', password: '', homeDir: '', preset: 'full', customPerms: [...READ_ONLY], quotaGb: '', active: true })

const draftFor = (u: FtpUser): Draft => ({
  editing: u.username,
  username: u.username,
  password: '',
  homeDir: u.homeDir,
  preset: presetOf(u.permissions),
  customPerms: u.permissions.includes('*') ? [...READ_ONLY] : [...u.permissions],
  quotaGb: u.quotaSize ? String(Math.round((u.quotaSize / GIB) * 10) / 10) : '',
  active: u.status === 1,
})

export const FtpSettingsPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState('')

  const st = store.status
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const save = async () => {
    if (!draft) return
    setFormErr('')
    const perms = draft.preset === 'full' ? ['*'] : draft.preset === 'read-only' ? READ_ONLY : draft.customPerms
    if (draft.preset === 'custom' && !perms.length) { setFormErr('Pick at least one permission'); return }
    const quotaGb = parseFloat(draft.quotaGb)
    const body = {
      homeDir: draft.homeDir.trim() || undefined,
      permissions: perms,
      status: draft.active ? 1 : 0,
      quotaSize: Number.isFinite(quotaGb) && quotaGb > 0 ? Math.round(quotaGb * GIB) : 0,
      ...(draft.password.trim() ? { password: draft.password } : {}),
    }
    setSaving(true)
    const r = draft.editing
      ? await store.updateUser(draft.editing, body)
      : await store.createUser({ ...body, username: draft.username.trim() })
    setSaving(false)
    if (!r.ok) { setFormErr(r.error ?? 'save failed'); return }
    setDraft(null)
  }

  return (
    <>
      <div className="settings-section-header" style={{ marginTop: 24 }}>
        <div className="settings-section-title">FTP Server</div>
        <div className="settings-actions">
          <button className="btn-secondary" onClick={() => void store.load()} disabled={store.loading}>
            <RefreshCw size={13} className={store.loading ? 'ftp-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Connection info */}
      <div className="settings-rows">
        <div className="settings-row">
          <label>Host</label>
          <span className="ftp-mono">{st ? st.host : store.loading ? 'checking…' : '—'}</span>
        </div>
        <div className="settings-row">
          <label>SFTP</label>
          <span className="ftp-conn">
            <span className={`ftp-badge ${st?.sftp.active ? 'ftp-badge-ok' : 'ftp-badge-bad'}`}>{st ? (st.sftp.active ? 'active' : 'inactive') : '—'}</span>
            {st && <span className="ftp-mono">sftp://&lt;user&gt;@{st.host}:{st.sftp.port}</span>}
          </span>
        </div>
        <div className="settings-row">
          <label>FTP</label>
          <span className="ftp-conn">
            <span className={`ftp-badge ${st?.ftp.active ? 'ftp-badge-ok' : 'ftp-badge-bad'}`}>{st ? (st.ftp.active ? 'active' : 'inactive') : '—'}</span>
            {st && <span className="ftp-mono">ftp://{st.host}:{st.ftp.port}</span>}
          </span>
        </div>
      </div>
      {store.err && !st && <div className="ftp-err">{store.err}</div>}

      {/* User accounts */}
      <div className="settings-subsection-header">
        <div className="settings-divider"><span>FTP user accounts</span><i /></div>
        <div className="settings-actions">
          <button className="btn-secondary" onClick={() => { setFormErr(''); setDraft(blankDraft()) }} disabled={!!draft && !draft.editing}>
            <Plus size={13} /> Add user
          </button>
        </div>
      </div>

      {store.users.length === 0 && !draft && (
        <div className="ftp-muted">{store.loaded ? 'No FTP users yet.' : 'Loading…'}</div>
      )}

      {store.users.length > 0 && (
        <table className="ftp-table">
          <thead>
            <tr><th>User</th><th>Home</th><th>Permissions</th><th>Quota</th><th>Last login</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {store.users.map((u) => (
              <tr key={u.username} className={u.status === 1 ? '' : 'ftp-row-disabled'}>
                <td className="ftp-bold">{u.username}</td>
                <td className="ftp-mono ftp-dim">{u.homeDir}</td>
                <td>{permLabel(u.permissions)}</td>
                <td>{quotaLabel(u.quotaSize)}</td>
                <td className="ftp-dim">{u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'never'}</td>
                <td>
                  <span className={`ftp-badge ${u.status === 1 ? 'ftp-badge-ok' : 'ftp-badge-bad'}`}>{u.status === 1 ? 'active' : 'disabled'}</span>
                </td>
                <td>
                  <span className="ftp-row-actions">
                    <button className="ftp-icon-btn" title="Edit user" onClick={() => { setFormErr(''); setDraft(draftFor(u)) }}><Pencil size={13} /></button>
                    <button
                      className="ftp-icon-btn ftp-icon-danger"
                      title="Delete user"
                      onClick={async () => {
                        if (await confirmStore.confirm({ title: 'Delete FTP user', message: `Delete FTP user “${u.username}”? Their files under ${u.homeDir} are kept.`, confirmText: 'Delete' })) {
                          const r = await store.deleteUser(u.username)
                          if (!r.ok) setFormErr(r.error ?? 'delete failed')
                        }
                      }}
                    ><Trash2 size={13} /></button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create / edit form */}
      {draft && (
        <div className="ftp-editor">
          <div className="ftp-editor-head">
            <span className="ftp-bold">{draft.editing ? `Edit ${draft.editing}` : 'New FTP user'}</span>
            <button className="ftp-icon-btn" title="Cancel" onClick={() => setDraft(null)}><X size={14} /></button>
          </div>
          <div className="ftp-form-grid">
            <label>Username</label>
            <input className="ftp-input" value={draft.username} disabled={!!draft.editing} placeholder="e.g. travis"
              onChange={(e) => set({ username: e.target.value })} />
            <label>Password</label>
            <input className="ftp-input" type="password" value={draft.password} autoComplete="new-password"
              placeholder={draft.editing ? 'leave blank to keep current password' : 'required'}
              onChange={(e) => set({ password: e.target.value })} />
            <label>Home directory</label>
            <input className="ftp-input ftp-mono" value={draft.homeDir}
              placeholder={`auto: /opt/ai-lab-ftp/data/${draft.username.trim() || '<username>'}`}
              onChange={(e) => set({ homeDir: e.target.value })} />
            <label>Permissions</label>
            <div>
              <select className="ftp-input" value={draft.preset} onChange={(e) => set({ preset: e.target.value as Preset })}>
                <option value="full">Full access</option>
                <option value="read-only">Read-only (list + download)</option>
                <option value="custom">Custom…</option>
              </select>
              {draft.preset === 'custom' && (
                <div className="ftp-perm-grid">
                  {GRANULAR_PERMS.map((p) => (
                    <label key={p} className="ftp-perm-chk">
                      <input type="checkbox" checked={draft.customPerms.includes(p)}
                        onChange={(e) => set({ customPerms: e.target.checked ? [...draft.customPerms, p] : draft.customPerms.filter((x) => x !== p) })} />
                      {p}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label>Quota (GB)</label>
            <input className="ftp-input" type="number" min={0} step="0.5" value={draft.quotaGb} placeholder="0 = unlimited"
              onChange={(e) => set({ quotaGb: e.target.value })} />
            <label>Status</label>
            <label className="ftp-perm-chk">
              <input type="checkbox" checked={draft.active} onChange={(e) => set({ active: e.target.checked })} /> active
            </label>
          </div>
          {formErr && <div className="ftp-err">{formErr}</div>}
          <div className="ftp-editor-actions">
            <button className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn-primary" disabled={saving || (!draft.editing && (!draft.username.trim() || !draft.password.trim()))}
              onClick={() => void save()}>
              {saving ? 'Saving…' : draft.editing ? 'Save changes' : 'Create user'}
            </button>
          </div>
        </div>
      )}
      {formErr && !draft && <div className="ftp-err">{formErr}</div>}
    </>
  )
})
