import React, { useEffect, useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { rule34Api } from './rule34Api'
import styles from './Rule34.module.scss'

export const DashboardView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [newTag, setNewTag] = useState('')

  const load = useCallback(async () => {
    setD(await rule34Api.dashboard())
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { const iv = setInterval(load, 5000); return () => clearInterval(iv) }, [load])

  const act = async (fn: () => Promise<any>) => {
    setBusy(true)
    try { await fn(); await load() } finally { setBusy(false) }
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const q = newTag.trim()
    if (!q) return
    await act(() => rule34Api.addTag(q))
    setNewTag('')
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
        <span className={styles.dim} style={worker.api_error ? { color: 'var(--danger, #ef4444)' } : undefined}>
          {worker.api_error
            ? `\u26a0 API error: ${worker.api_error.error}`
            : (worker.scrape_progress || worker.activity || 'idle')}
          {` \u00b7 ${(stats.pending ?? 0).toLocaleString()} queued`}
        </span>
        <span className={styles.spacer} />
        <button className={worker.paused ? styles.btnPrimary : styles.btnDanger} disabled={busy} onClick={() => act(worker.paused ? rule34Api.workerResume : rule34Api.workerPause)}>
          {worker.paused ? 'Start' : 'Stop'}
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
          {stats.by_site && Object.keys(stats.by_site).length > 1 && (
            <span className={styles.stat}>
              <b>{Object.entries(stats.by_site).map(([s, n]: [string, any]) => `${s}: ${Number(n).toLocaleString()}`).join(' · ')}</b>
              <span>by site{stats.cross_site_dupes ? ` · ${stats.cross_site_dupes} cross-site dupes merged` : ''}</span>
            </span>
          )}
        </div>
        {stats.failed > 0 && (
          <button className={styles.btnDanger} disabled={busy} onClick={() => act(rule34Api.retryFailed)} style={{ marginTop: 8 }}>
            Retry failed downloads
          </button>
        )}
      </div>

      <div className={styles.card}>
        <div className={styles.headRow}>
          <div className={styles.cardTitle}>Watched Tags ({tags.length})</div>
          <span className={styles.spacer} />
          <form className={styles.searchBar} onSubmit={handleAdd}>
            <input
              className={styles.searchInput}
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="Add tag (e.g. character_name or tag1 tag2)…"
            />
            <button type="submit" className={styles.btnPrimary} disabled={busy || !newTag.trim()}>Add Tag</button>
          </form>
        </div>
        {tags.length === 0 ? (
          <span className={styles.dim}>No watched tags yet. Add one above to start scraping.</span>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Query</th><th>Found</th><th>Downloaded</th><th>Last Scraped</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {tags.map((t: any) => (
                <tr key={t.id} style={{ opacity: t.enabled ? 1 : 0.5, background: worker.current_download_tag === t.tag_query ? 'rgba(59,130,246,0.14)' : undefined }}>
                  <td className={styles.mono}>
                    {t.tag_query}
                    {worker.current_download_tag === t.tag_query && (
                      <span style={{ color: 'var(--primary, #3b82f6)', marginLeft: 6, fontWeight: 600 }}>⬇ downloading</span>
                    )}
                    {t.tag_query.trim().split(/\s+/).length > 2 && (
                      <div className={styles.dim} style={{ fontSize: 11 }}
                        title="Danbooru free accounts can search at most 2 tags, so this tag's danbooru scrape uses only the first two as listed. rule34 and gelbooru use the full query.">
                        ⓘ Danbooru: first 2 tags only ({t.tag_query.trim().split(/\s+/).slice(0, 2).join(' ')})
                      </div>
                    )}
                  </td>
                  <td>{(t.live_total ?? 0).toLocaleString()}</td>
                  <td>{(t.live_downloaded ?? 0).toLocaleString()}</td>
                  <td className={styles.dim}>{t.last_scraped_at ? new Date(t.last_scraped_at).toLocaleString() : '—'}</td>
                  <td>
                    {t.enabled ? <span className={styles.ok}>active</span> : <span className={styles.dim}>suspended</span>}
                    {worker.tag_status?.[t.id] && (
                      worker.tag_status[t.id].error
                        ? <div style={{ color: 'var(--danger, #ef4444)', fontSize: 11 }} title={worker.tag_status[t.id].error}>\u26a0 {String(worker.tag_status[t.id].error).slice(0, 40)}</div>
                        : <div className={styles.dim} style={{ fontSize: 11 }}>
                            {(worker.tag_status[t.id].found ?? 0) > 0
                              ? `${(worker.tag_status[t.id].found).toLocaleString()} new last scan`
                              : 'up to date'}
                          </div>
                    )}
                  </td>
                  <td>
                    <div className={styles.headRow}>
                      <button className={styles.btn} disabled={busy} onClick={() => act(() => rule34Api.toggleTag(String(t.id), !t.enabled))}>
                        {t.enabled ? 'Suspend' : 'Activate'}
                      </button>
                      <button className={styles.btn} disabled={busy} onClick={() => act(() => rule34Api.scrapeTagNow(String(t.id)))}>
                        Sync Now
                      </button>
                    </div>
                  </td>
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
