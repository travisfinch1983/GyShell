import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { confirmStore } from '../../../stores/confirmStore'
import { socialApi, SITE_LABEL, type Account, type Site } from './socialApi'
import styles from '../rule34/Rule34.module.scss'   // shared addon look (same tokens/classes as rule34)

const ago = (t: number | null) => {
  if (!t) return 'never'
  const s = Date.now() / 1000 - t
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)

export const makeDashboardView = (site: Site): React.FC => {
  const api = socialApi(site)
  const View: React.FC = () => {
    const [d, setD] = useState<any>(null)
    const [busy, setBusy] = useState(false)
    const [handles, setHandles] = useState('')
    const [msg, setMsg] = useState('')
    const [showLog, setShowLog] = useState(false)
    const [log, setLog] = useState<string[]>([])

    const load = useCallback(async () => {
      try { setD(await api.dashboard()) } catch (e: any) { setMsg(String(e?.message || e)) }
      if (showLog) { try { setLog((await api.log()).lines) } catch { /* keep last */ } }
    }, [showLog])
    useEffect(() => { void load() }, [load])
    useEffect(() => { const iv = setInterval(load, 4000); return () => clearInterval(iv) }, [load])

    const act = async (fn: () => Promise<any>) => {
      setBusy(true)
      try {
        const r = await fn()
        if (r && r.ok === false && r.error) setMsg(r.error)
        await load()
        return r
      } catch (e: any) { setMsg(String(e?.message || e)) } finally { setBusy(false) }
    }

    const add = async (e: React.FormEvent) => {
      e.preventDefault()
      if (!handles.trim()) return
      const r = await act(() => api.addAccounts(handles))
      if (r?.added?.length) {
        setHandles('')
        setMsg(`Added ${r.added.map((h: string) => '@' + h).join(', ')} - first sync queued`
          + (r.invalid?.length ? ` (ignored: ${r.invalid.join(', ')})` : ''))
      }
    }

    const remove = async (a: Account) => {
      const ok = await confirmStore.confirm({
        title: `Remove @${a.handle}`,
        message: `Stop watching @${a.handle}? Its ${a.n_media} downloaded file${a.n_media === 1 ? '' : 's'} stay on disk `
          + '(and anything already copied into a training set is untouched).',
        confirmText: 'Remove',
      })
      if (!ok) return
      await act(() => api.removeAccount(a.id, false))
    }

    if (!d) return <div className={styles.view}><span className={styles.dim}>{msg || 'Loading…'}</span></div>

    const { worker, stats, accounts, cookies } = d
    const cur = worker.current
    const needLogin = site === 'twitter' && cookies.missing.length > 0

    return (
      <div className={styles.view}>
        <div className={styles.headRow}>
          <span className={styles.badge}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: worker.paused ? 'var(--warning, #f59e0b)' : cur ? 'var(--accent)' : 'var(--success, #22c55e)' }} />
            {worker.paused ? 'Paused' : cur ? 'Syncing' : 'Idle'}
          </span>
          <span className={styles.dim}>
            {cur ? `@${cur.handle}: ${cur.downloaded} new, ${cur.skipped} already had${cur.full_pass ? ' (full history)' : ''}` : 'waiting for the next scheduled sync'}
            {worker.queue.length ? ` · ${worker.queue.length} queued` : ''}
            {` · every ${d.poll_interval_h} h`}
          </span>
          <span className={styles.spacer} />
          {cur && <button className={styles.btnDanger} disabled={busy} onClick={() => act(api.cancel)}>Cancel run</button>}
          <button className={worker.paused ? styles.btnPrimary : styles.btn} disabled={busy}
            onClick={() => act(() => api.pause(!worker.paused))}>{worker.paused ? 'Resume' : 'Pause'}</button>
          <button className={styles.btnPrimary} disabled={busy || !accounts.length} onClick={() => act(api.syncAll)}>Sync all now</button>
          <button className={styles.btn} onClick={() => void load()} title="Refresh"><RefreshCw size={12} /></button>
        </div>

        {needLogin && (
          <div className={styles.card} style={{ borderColor: 'color-mix(in srgb, var(--danger) 45%, transparent)' }}>
            <b>X needs a logged-in account to show timelines.</b>{' '}
            <span className={styles.dim}>Paste the cookies from a logged-in browser session in the Settings tab (needs {cookies.required.join(' + ')}). Until then every sync fails with "AuthRequired".</span>
          </div>
        )}
        {site === 'instagram' && !cookies.set && (
          <div className={styles.card}>
            <span className={styles.dim}>
              Running <b>without a login</b>: public profiles work, but Instagram throttles anonymous requests and may only
              return recent posts. Add a session cookie in Settings for full histories (a spare account is safer than your main one).
            </span>
          </div>
        )}

        <div className={styles.card}>
          <div className={styles.statRow}>
            <span className={styles.stat}><b>{stats.accounts}</b><span>accounts</span></span>
            <span className={styles.stat}><b>{stats.active_accounts}</b><span>active</span></span>
            <span className={styles.stat}><b>{stats.images.toLocaleString()}</b><span>images</span></span>
            {stats.videos > 0 && <span className={styles.stat}><b>{stats.videos.toLocaleString()}</b><span>videos</span></span>}
            <span className={styles.stat}><b>{fmtBytes(stats.bytes)}</b><span>on disk</span></span>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.headRow}>
            <div className={styles.cardTitle}>Watched {SITE_LABEL[site]} accounts</div>
            <span className={styles.spacer} />
            <form className={styles.searchBar} onSubmit={add}>
              <input className={styles.searchInput} value={handles} onChange={(e) => setHandles(e.target.value)}
                placeholder={site === 'instagram' ? '@handle, profile URL, or several separated by spaces' : '@handle or x.com/handle (several OK)'}
                style={{ minWidth: 260 }} />
              <button type="submit" className={styles.btnPrimary} disabled={busy || !handles.trim()}>Add</button>
            </form>
          </div>
          {msg && <div className={styles.msg} style={{ margin: '6px 0' }}>{msg}</div>}
          {accounts.length === 0 ? (
            <span className={styles.dim}>No accounts yet. Add the storefronts you pull stock photos from - each one syncs right away, then every {d.poll_interval_h} hours.</span>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className={styles.table}>
                <thead><tr><th>Account</th><th>Files</th><th>Last sync</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {accounts.map((a: Account) => {
                    const running = cur?.account_id === a.id
                    const queued = worker.queue.includes(a.id)
                    return (
                      <tr key={a.id} style={{ opacity: a.enabled ? 1 : 0.5, background: running ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined }}>
                        <td className={styles.mono}>
                          <a href={site === 'instagram' ? `https://www.instagram.com/${a.handle}/` : `https://x.com/${a.handle}`}
                            target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>@{a.handle}</a>
                          {!a.complete && <span className={styles.dim} title="The first full pass over this account's history hasn't finished yet"> · history pending</span>}
                        </td>
                        <td>{a.n_media.toLocaleString()}</td>
                        <td className={styles.dim}>{ago(a.last_synced_at)}{a.last_new ? ` · +${a.last_new}` : ''}</td>
                        <td>
                          {running ? <span className={styles.ok}>syncing…</span>
                            : queued ? <span className={styles.dim}>queued</span>
                            : !a.enabled ? <span className={styles.dim}>suspended</span>
                            : a.last_status === 'error' ? <span className={styles.err} title={a.last_error || ''}>⚠ {(a.last_error || 'failed').slice(0, 60)}</span>
                            : a.last_status === 'partial' ? <span className={styles.err} title={a.last_error || ''}>partial · {(a.last_error || '').slice(0, 40)}</span>
                            : a.last_status ? <span className={styles.ok}>{a.last_status}</span>
                            : <span className={styles.dim}>not synced yet</span>}
                        </td>
                        <td>
                          <div className={styles.headRow} style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                            <button className={styles.btn} disabled={busy || running} onClick={() => act(() => api.syncAccount(a.id))}>Sync</button>
                            <button className={styles.btn} disabled={busy || running} title="Walk the whole history again - picks up anything older that was missed (already-downloaded posts are skipped)"
                              onClick={() => act(() => api.syncAccount(a.id, true))}>Full</button>
                            <button className={styles.btn} disabled={busy} onClick={() => act(() => api.toggleAccount(a.id, !a.enabled))}>{a.enabled ? 'Suspend' : 'Activate'}</button>
                            <button className={styles.btnDanger} disabled={busy} onClick={() => void remove(a)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className={styles.card}>
          <div className={styles.headRow}>
            <div className={styles.cardTitle}>Sync log</div>
            <span className={styles.spacer} />
            <button className={styles.btn} onClick={() => setShowLog((v) => !v)}>{showLog ? 'Hide' : 'Show'}</button>
          </div>
          {showLog && (
            <pre className={styles.mono} style={{ maxHeight: 280, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
              {log.length ? log.join('\n') : 'nothing yet'}
            </pre>
          )}
        </div>
      </div>
    )
  }
  return View
}
