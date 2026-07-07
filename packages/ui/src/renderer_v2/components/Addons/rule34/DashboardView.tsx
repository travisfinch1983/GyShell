import React, { useEffect, useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { rule34Api } from './rule34Api'
import styles from './Rule34.module.scss'

export const DashboardView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setD(await rule34Api.dashboard())
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { const iv = setInterval(load, 5000); return () => clearInterval(iv) }, [load])

  const act = async (fn: () => Promise<any>) => {
    setBusy(true)
    try { await fn(); await load() } finally { setBusy(false) }
  }

  if (!d) return <div className={styles.view}><span className={styles.dim}>Loading…</span></div>

  const { worker, stats, watched_tags: tags } = d

  return (
    <div className={styles.view}>
      <div className={styles.headRow}>
        <span className={styles.badge}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: worker.paused ? 'var(--warning, #f59e0b)' : 'var(--success, #22c55e)' }} />
          {worker.paused ? 'Paused' : 'Running'}
        </span>
        <span className={styles.dim}>{worker.activity}</span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy} onClick={() => act(worker.paused ? rule34Api.workerResume : rule34Api.workerPause)}>
          {worker.paused ? 'Resume' : 'Pause'}
        </button>
        <button className={styles.btnPrimary} disabled={busy} onClick={() => act(rule34Api.scrapeAll)}>
          Scrape All Now
        </button>
        <button className={styles.btn} onClick={() => void load()}><RefreshCw size={12} /></button>
      </div>

      <div className={styles.card}>
        <div className={styles.statRow}>
          <span className={styles.stat}><b>{stats.total_posts}</b><span>total posts</span></span>
          <span className={styles.stat}><b>{stats.downloaded}</b><span>downloaded</span></span>
          <span className={styles.stat}><b>{stats.pending}</b><span>pending</span></span>
          <span className={styles.stat}>
            <b className={stats.failed ? styles.err : ''}>{stats.failed}</b><span>failed</span>
          </span>
          <span className={styles.stat}><b>{stats.total_tags}</b><span>tags</span></span>
        </div>
        {stats.failed > 0 && (
          <button className={styles.btnDanger} disabled={busy} onClick={() => act(rule34Api.retryFailed)} style={{ marginTop: 8 }}>
            Retry failed downloads
          </button>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Watched Tags ({tags.length})</div>
        {tags.length === 0 ? (
          <span className={styles.dim}>No watched tags. Go to Tags tab to add some.</span>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Query</th><th>Found</th><th>Downloaded</th><th>Last Scraped</th><th>Status</th></tr></thead>
            <tbody>
              {tags.map((t: any) => (
                <tr key={t.id}>
                  <td className={styles.mono}>{t.tag_query}</td>
                  <td>{t.total_found}</td>
                  <td>{t.total_downloaded}</td>
                  <td className={styles.dim}>{t.last_scraped_at ? new Date(t.last_scraped_at).toLocaleString() : '—'}</td>
                  <td>{t.enabled ? <span className={styles.ok}>active</span> : <span className={styles.dim}>disabled</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Worker stats</div>
        <div className={styles.dim}>
          Scrapes completed: {worker.scrapes_completed} · Downloads completed: {worker.downloads_completed}
        </div>
      </div>
    </div>
  )
}
