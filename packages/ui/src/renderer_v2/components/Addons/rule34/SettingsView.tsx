import React, { useEffect, useState, useCallback } from 'react'
import { rule34Api } from './rule34Api'
import styles from './Rule34.module.scss'

// api_key / user_id are managed per-key in the pool below, not here.
const FIELDS: { key: string; label: string; type?: string; readOnly?: boolean }[] = [
  { key: 'storage_path', label: 'Storage Path', readOnly: true },
  { key: 'poll_interval_sec', label: 'Poll Interval (sec)' },
  { key: 'download_concurrency', label: 'Download Concurrency' },
  { key: 'rate_limit_requests', label: 'Per-Key Requests / Window' },
  { key: 'rate_limit_window_sec', label: 'Rate Window (sec)' },
  { key: 'rate_limit_rps', label: 'Download Rate (req/sec)' },
  { key: 'download_bandwidth_limit_kbps', label: 'Bandwidth Cap (KB/s, 0 = off)', type: 'number' },
  { key: 'max_retries', label: 'Max Retries' },
]

interface ApiKey {
  id: number
  key_preview: string
  user_id: string
  label: string
  proxy: string
  enabled: boolean
}
interface RateInfo {
  enabled_keys: number
  per_key_requests: number
  window_sec: number
  effective_requests: number
}

export const SettingsView: React.FC = () => {
  const [form, setForm] = useState<Record<string, string>>({})
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [rate, setRate] = useState<RateInfo | null>(null)
  const [newKey, setNewKey] = useState({ api_key: '', user_id: '', label: '', proxy: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const d = await rule34Api.settings()
    setForm(d.settings ?? {})
    setKeys(d.api_keys ?? [])
    setRate(d.rate_info ?? null)
  }, [])

  useEffect(() => { void load() }, [load])

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(null), 3000) }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try { await rule34Api.saveSettings(form); flash('Saved') } finally { setBusy(false) }
  }

  const addKey = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newKey.api_key.trim() || !newKey.user_id.trim()) { flash('API key and User ID required'); return }
    setBusy(true)
    try {
      await rule34Api.addKey(newKey)
      setNewKey({ api_key: '', user_id: '', label: '', proxy: '' })
      await load(); flash('Key added')
    } finally { setBusy(false) }
  }

  const toggleKey = async (k: ApiKey) => {
    await rule34Api.toggleKey(k.id, !k.enabled); await load()
  }
  const removeKey = async (k: ApiKey) => {
    if (!confirm(`Remove key ${k.label || k.key_preview}?`)) return
    await rule34Api.removeKey(k.id); await load()
  }

  return (
    <div className={styles.view}>
      <div className={styles.headRow}>
        <span style={{ fontWeight: 600 }}>Settings</span>
        <span className={styles.spacer} />
        {msg && <span className={styles.msg}>{msg}</span>}
      </div>

      {/* ── API Key Pool ─────────────────────────────────────────────────── */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>API Key Pool</div>
        <div className={styles.cardSub}>
          Requests round-robin across enabled keys, each with its own rate budget.
          {rate && (
            <> Effective ceiling: <b>{rate.effective_requests}</b> requests / {rate.window_sec}s
            &nbsp;({rate.enabled_keys} × {rate.per_key_requests}).</>
          )}
        </div>
        <div className={styles.faint} style={{ margin: '4px 0 10px' }}>
          Note: rule34.xxx likely rate-limits per IP. If extra keys don’t raise your real
          throughput, give a key a <b>proxy</b> (e.g. your Netherlands VPS) so it uses a
          separate IP.
        </div>

        <table className={styles.table}>
          <thead>
            <tr><th>Key</th><th>User ID</th><th>Label</th><th>Proxy</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td className={styles.mono}>{k.key_preview}</td>
                <td>{k.user_id}</td>
                <td>{k.label || <span className={styles.dim}>—</span>}</td>
                <td className={styles.mono}>{k.proxy || <span className={styles.dim}>direct</span>}</td>
                <td>
                  <span className={k.enabled ? styles.badgeOk : styles.badgeErr}>
                    {k.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className={styles.btn} onClick={() => toggleKey(k)}>
                    {k.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className={styles.btnDanger} onClick={() => removeKey(k)}
                    style={{ marginLeft: 6 }}>Remove</button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr><td colSpan={6} className={styles.dim}>No keys — add one below.</td></tr>
            )}
          </tbody>
        </table>

        <form onSubmit={addKey} className={styles.formGrid} style={{ marginTop: 12 }}>
          <div className={styles.fieldCol}>
            <span>API Key</span>
            <input className={styles.input} type="password" value={newKey.api_key}
              onChange={(e) => setNewKey({ ...newKey, api_key: e.target.value })} />
          </div>
          <div className={styles.fieldCol}>
            <span>User ID</span>
            <input className={styles.input} value={newKey.user_id}
              onChange={(e) => setNewKey({ ...newKey, user_id: e.target.value })} />
          </div>
          <div className={styles.fieldCol}>
            <span>Label (optional)</span>
            <input className={styles.input} value={newKey.label}
              onChange={(e) => setNewKey({ ...newKey, label: e.target.value })} />
          </div>
          <div className={styles.fieldCol}>
            <span>Proxy URL (optional)</span>
            <input className={styles.input} placeholder="http://user:pass@host:port" value={newKey.proxy}
              onChange={(e) => setNewKey({ ...newKey, proxy: e.target.value })} />
          </div>
          <div className={styles.fieldCol} style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className={styles.btnPrimary} disabled={busy}>Add Key</button>
          </div>
        </form>
      </div>

      {/* ── General settings ─────────────────────────────────────────────── */}
      <form onSubmit={save} style={{ marginTop: 16 }}>
        <div className={styles.formGrid}>
          {FIELDS.map((f) => (
            <div key={f.key} className={styles.fieldCol}>
              <span>{f.label}</span>
              <input
                className={styles.input}
                type={f.type ?? 'text'}
                value={form[f.key] ?? ''}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                readOnly={f.readOnly}
              />
            </div>
          ))}
        </div>
        <button type="submit" className={styles.btnPrimary} disabled={busy}>
          {busy ? 'Saving…' : 'Save Settings'}
        </button>
      </form>
    </div>
  )
}
