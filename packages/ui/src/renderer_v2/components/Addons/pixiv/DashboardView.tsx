import React, { useEffect, useState, useCallback } from 'react'
import { pixivApi } from './pixivApi'
import styles from '../rule34/Rule34.module.scss'

export const PixivDashboardView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [kind, setKind] = useState<'tag' | 'artist'>('tag')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const load = useCallback(async () => { setD(await pixivApi.dashboard()) }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  const act = async (fn: () => Promise<any>, m?: string) => {
    setBusy(true)
    try { await fn(); if (m) { setMsg(m); setTimeout(() => setMsg(null), 3000) }; await load() } finally { setBusy(false) }
  }

  if (!d) return <div className={styles.view}><span className={styles.dim}>Loading…</span></div>
  const { worker, stats, watches } = d
  const auth = worker.auth ?? {}

  return (
    <div className={styles.view}>
      <div className={styles.card}>
        <div className={styles.headRow}>
          <div className={styles.cardTitle}>Pixiv Scraper</div>
          <span className={styles.dim}>{worker.activity}{worker.scrape_progress ? ` — ${worker.scrape_progress}` : ''}</span>
          <span className={styles.spacer} />
          <span className={auth.auth === 'authenticated' ? styles.ok : styles.err} title={auth.detail}>
            {auth.auth === 'authenticated' ? `✓ ${auth.account}` : `⚠ ${auth.auth}`}
          </span>
          <button className={styles.btn} disabled={busy}
            onClick={() => act(worker.paused ? pixivApi.workerResume : pixivApi.workerPause)}>
            {worker.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        {auth.auth !== 'authenticated' && (
          <div className={styles.dim} style={{ marginTop: 4 }}>
            {auth.detail} — nothing scrapes until a refresh token is configured (Settings).
          </div>
        )}
        <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
          <span className={styles.stat}><b>{stats.total_illusts.toLocaleString()}</b><span>illusts</span></span>
          <span className={styles.stat}><b>{stats.pages_downloaded.toLocaleString()}</b><span>pages downloaded</span></span>
          <span className={styles.stat}><b>{stats.pending}</b><span>pending</span></span>
          <span className={styles.stat}><b className={stats.failed ? styles.err : ''}>{stats.failed}</b><span>failed</span></span>
          <span className={styles.stat}><b>{stats.artists}</b><span>artists</span></span>
        </div>
        {stats.failed > 0 && (
          <button className={styles.btnDanger} disabled={busy} onClick={() => act(pixivApi.retryFailed, 'Re-queued failed')} style={{ marginTop: 8 }}>
            Retry failed downloads
          </button>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.headRow}>
          <div className={styles.cardTitle}>Watches ({watches.length})</div>
          <span className={styles.spacer} />
          <form className={styles.searchBar} onSubmit={(e) => {
            e.preventDefault()
            if (!value.trim()) return
            void act(() => pixivApi.addWatch(kind, value.trim(), label.trim()), 'Watch added')
            setValue(''); setLabel('')
          }}>
            <select className={styles.select} value={kind} onChange={(e) => setKind(e.target.value as any)}>
              <option value="tag">Tag</option>
              <option value="artist">Artist (user id)</option>
            </select>
            <input className={styles.searchInput} value={value} onChange={(e) => setValue(e.target.value)}
              placeholder={kind === 'tag' ? 'tag (JP or EN)…' : 'pixiv user id (number from the artist URL)…'} />
            <input className={styles.searchInput} value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="label (optional)" style={{ maxWidth: 140 }} />
            <button type="submit" className={styles.btnPrimary} disabled={busy || !value.trim()}>Add</button>
          </form>
        </div>
        {msg && <span className={styles.msg}>{msg}</span>}
        {watches.length === 0 ? (
          <span className={styles.dim}>No watches yet. Add a tag or an artist above.</span>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Watch</th><th>Found</th><th>Downloaded</th><th>Last scraped</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {watches.map((w: any) => (
                <tr key={w.id} style={{ opacity: w.enabled ? 1 : 0.5 }}>
                  <td className={styles.mono}>
                    <span style={{ background: w.kind === 'artist' ? '#e879f9' : '#38bdf8', color: '#111', borderRadius: 3, fontSize: 10, fontWeight: 700, padding: '1px 4px', marginRight: 6 }}>
                      {w.kind === 'artist' ? 'ARTIST' : 'TAG'}
                    </span>
                    {w.label || w.value}{w.label && <span className={styles.dim}> ({w.value})</span>}
                  </td>
                  <td>{(w.live_total ?? 0).toLocaleString()}</td>
                  <td>{(w.live_downloaded ?? 0).toLocaleString()}</td>
                  <td className={styles.dim}>{w.last_scraped_at ? new Date(w.last_scraped_at).toLocaleString() : '—'}</td>
                  <td>
                    {worker.watch_status?.[w.id]?.error
                      ? <span className={styles.err} title={worker.watch_status[w.id].error}>⚠ error</span>
                      : worker.watch_status?.[w.id]
                        ? <span className={styles.dim}>{worker.watch_status[w.id].found ? `${worker.watch_status[w.id].found} new` : 'up to date'}</span>
                        : <span className={styles.dim}>—</span>}
                  </td>
                  <td>
                    <div className={styles.headRow}>
                      <button className={styles.btn} disabled={busy} onClick={() => act(() => pixivApi.toggleWatch(w.id, !w.enabled))}>
                        {w.enabled ? 'Suspend' : 'Activate'}
                      </button>
                      <button className={styles.btn} disabled={busy} onClick={() => act(() => pixivApi.scrapeNow(w.id), 'Scrape started')}>Sync Now</button>
                      <button className={styles.btnDanger} disabled={busy}
                        onClick={() => { if (confirmId !== w.id) { setConfirmId(w.id); return } setConfirmId(null); void act(() => pixivApi.removeWatch(w.id), 'Removed') }}>
                        {confirmId === w.id ? 'Confirm?' : 'Remove'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
