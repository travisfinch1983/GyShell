import React, { useEffect, useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { rule34Api } from './rule34Api'
import styles from './Rule34.module.scss'

export const TagsView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [newTag, setNewTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setD(await rule34Api.tags())
  }, [])

  useEffect(() => { void load() }, [load])

  const act = async (fn: () => Promise<any>, label?: string) => {
    setBusy(true)
    try {
      await fn()
      if (label) { setMsg(label); setTimeout(() => setMsg(null), 3000) }
      await load()
    } finally { setBusy(false) }
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const q = newTag.trim()
    if (!q) return
    await act(() => rule34Api.addTag(q), `Added "${q}"`)
    setNewTag('')
  }

  const handleRemove = (id: number) => {
    if (confirmId !== id) { setConfirmId(id); return }
    setConfirmId(null)
    void act(() => rule34Api.removeTag(String(id)), 'Removed')
  }

  if (!d) return <div className={styles.view}><span className={styles.dim}>Loading…</span></div>

  const tags: any[] = d.watched_tags ?? []

  return (
    <div className={styles.view}>
      <div className={styles.headRow}>
        <form className={styles.searchBar} onSubmit={handleAdd} style={{ flex: 1 }}>
          <input
            className={styles.searchInput}
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder="Add tag query (e.g. character_name or tag1 tag2)…"
          />
          <button type="submit" className={styles.btnPrimary} disabled={busy || !newTag.trim()}>Add</button>
        </form>
        <button className={styles.btn} disabled={busy} onClick={() => act(rule34Api.retryFailed, 'Re-queued failed')}>
          Retry Failed
        </button>
        <button className={styles.btn} onClick={() => void load()}><RefreshCw size={12} /></button>
      </div>
      {msg && <span className={styles.msg} onClick={() => setMsg(null)}>{msg}</span>}

      {tags.length === 0 ? (
        <div className={styles.card}><span className={styles.dim}>No watched tags yet. Add one above to start scraping.</span></div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr><th>Query</th><th>Found</th><th>Downloaded</th><th>Last Scraped</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {tags.map((t: any) => (
              <tr key={t.id} style={{ opacity: t.enabled ? 1 : 0.5 }}>
                <td className={styles.mono}>{t.tag_query}</td>
                <td>{t.total_found.toLocaleString()}</td>
                <td>{t.total_downloaded.toLocaleString()}</td>
                <td className={styles.dim}>{t.last_scraped_at ? new Date(t.last_scraped_at).toLocaleString() : '—'}</td>
                <td>
                  <div className={styles.headRow}>
                    <button
                      className={styles.btn}
                      disabled={busy}
                      onClick={() => act(() => rule34Api.toggleTag(String(t.id), !t.enabled))}
                    >
                      {t.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className={styles.btn} disabled={busy} onClick={() => act(() => rule34Api.scrapeTagNow(String(t.id)))}>
                      Scrape Now
                    </button>
                    <button className={styles.btnDanger} disabled={busy} onClick={() => handleRemove(t.id)}>
                      {confirmId === t.id ? 'Confirm?' : 'Remove'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
