import React, { useEffect, useState, useCallback } from 'react'
import { pixivApi } from './pixivApi'
import styles from '../rule34/Rule34.module.scss'

const FIELDS: { key: string; label: string; ph?: string }[] = [
  { key: 'storage_path', label: 'Storage Path' },
  { key: 'poll_interval_sec', label: 'Poll Interval (sec)' },
  { key: 'download_concurrency', label: 'Download Concurrency' },
  { key: 'pixiv_min_interval_sec', label: 'Min seconds between API calls', ph: '1.2' },
  { key: 'pixiv_token_cred_id', label: 'Vault credential id (refresh token)', ph: 'cred-…' },
]

export const PixivSettingsView: React.FC = () => {
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const d = await pixivApi.settings()
    setForm(d.settings ?? {})
  }, [])
  useEffect(() => { void load() }, [load])

  const auth = (form as any).auth_status
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try { await pixivApi.saveSettings(form); setMsg('Saved'); setTimeout(() => setMsg(null), 3000); await load() } finally { setBusy(false) }
  }

  return (
    <div className={styles.view}>
      <div className={styles.headRow}>
        <span style={{ fontWeight: 600 }}>Pixiv Settings</span>
        <span className={styles.spacer} />
        {msg && <span className={styles.msg}>{msg}</span>}
      </div>
      <div className={styles.card}>
        <div className={styles.cardTitle}>Account</div>
        <div className={styles.cardSub}>
          Pixiv has no official API keys — the addon authenticates with an OAuth refresh token
          from Travis's account (minted once with gppt). The token lives in the AI-Lab vault
          (credential id below) or can be pasted here; pasted values are stored write-only in
          the addon's own database, never in git. If pixiv invalidates the token, a
          notification fires and scraping stops until a new one is minted.
        </div>
        {auth && (
          <div style={{ margin: '6px 0' }}>
            <span className={auth.auth === 'authenticated' ? styles.ok : styles.err}>
              {auth.auth === 'authenticated' ? `✓ authenticated as ${auth.account}` : `⚠ ${auth.auth}`}
            </span>
            <span className={styles.dim} style={{ marginLeft: 8 }}>{auth.detail}</span>
          </div>
        )}
        <form onSubmit={save}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {FIELDS.map((f) => (
              <label key={f.key} className={styles.dim} style={{ fontSize: 12 }}>
                {f.label}
                <input className={styles.searchInput} style={{ display: 'block', width: 220 }}
                  value={form[f.key] ?? ''} placeholder={f.ph}
                  onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))} />
              </label>
            ))}
            <label className={styles.dim} style={{ fontSize: 12 }}>
              Refresh token (override)
              <input className={styles.searchInput} style={{ display: 'block', width: 220 }} type="password"
                value={form.pixiv_refresh_token ?? ''}
                placeholder={form.pixiv_refresh_token_set === '1' ? '(stored — blank keeps it)' : '(blank = vault)'}
                onChange={(e) => setForm((x) => ({ ...x, pixiv_refresh_token: e.target.value }))} />
            </label>
          </div>
          <button type="submit" className={styles.btnPrimary} disabled={busy} style={{ marginTop: 10 }}>Save</button>
        </form>
      </div>
    </div>
  )
}
