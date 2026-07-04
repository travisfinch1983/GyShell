import React, { useCallback, useEffect, useState } from 'react'
import { Pause, Play, RefreshCw } from 'lucide-react'
import { confirmStore } from '../../../stores/confirmStore'
import { upscalerApi } from './upscalerApi'
import styles from './Upscaler.module.scss'

/**
 * Upscaler · Sync — native port of templates/sync.html: one-way download of
 * upscaled assets to the NAS. Live progress bar (2s poll of /api/sync/status),
 * pause/resume + sync-now, watched-tag subtree cards (recursive node list with
 * per-node reset), tag search with watch/unwatch.
 */

const TagNode: React.FC<{ n: any; onReset: (id: string, label: string, hasKids: boolean) => void }> = ({ n, onReset }) => (
  <li>
    <span className={styles.headRow} style={{ gap: 6 }}>
      <code className={styles.mono}>{n.leaf}</code>
      <span className={styles.faint}>({n.count})</span>
      <button className={styles.btn} style={{ padding: '0px 6px', fontSize: 10.5 }} onClick={() => onReset(n.id, n.value, Boolean(n.children?.length))}>reset</button>
    </span>
    {n.children?.length > 0 && (
      <ul style={{ listStyle: 'none', margin: 0, paddingLeft: '1.1em' }}>
        {n.children.map((c: any) => <TagNode key={c.id} n={c} onReset={onReset} />)}
      </ul>
    )}
  </li>
)

export const SyncView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [status, setStatus] = useState<any>(null)
  const [q, setQ] = useState('')
  const [qDraft, setQDraft] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setD(await upscalerApi.sync(q)) } catch (e) { setMsg(String((e as Error).message)) }
  }, [q])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const poll = () => upscalerApi.syncStatus().then(setStatus).catch(() => undefined)
    void poll()
    const t = setInterval(poll, 2000)
    return () => clearInterval(t)
  }, [])

  const act = async (fn: () => Promise<any>, label: string) => {
    setBusy(true)
    try { const r = await fn(); setMsg(r?.ok === false ? `${label} failed` : `${label} ✓`); await load() } catch (e) { setMsg(`${label} failed: ${String((e as Error).message)}`) } finally { setBusy(false) }
  }
  const resetTag = async (id: string, label: string, hasKids: boolean) => {
    const ok = await confirmStore.confirm({
      title: 'Reset sync ledger',
      message: `Reset sync for ${label}${hasKids ? ' and its sub-tags' : ''}? The next pass re-downloads only images currently MISSING from ${hasKids ? 'these folders' : 'this folder'}.`,
      confirmText: 'Reset',
    })
    if (ok) await act(() => upscalerApi.syncReset(id), 'Reset')
  }
  const removeWatch = async (id: string, label: string) => {
    const ok = await confirmStore.confirm({
      title: 'Stop watching',
      message: `Stop watching ${label}? Downloaded files are kept; the ledger is kept so they won't re-download if re-added.`,
      confirmText: 'Remove',
    })
    if (ok) await act(() => upscalerApi.syncSource(id, 'remove'), 'Removed')
  }

  const tot = status?.tags_total || 0
  const done = status?.tags_done || 0
  const pct = tot ? Math.round((done * 100) / tot) : status?.running ? 0 : 100

  return (
    <div className={styles.view}>
      <div className={styles.headRow}>
        <b>Tag → Training-Images sync</b>
        <span className={styles.faint}>one-way download of upscaled assets to the NAS</span>
      </div>

      {/* ── live status bar ── */}
      <div className={styles.card}>
        <div className={styles.dim} style={{ marginBottom: 6 }}>
          {!status ? 'loading…' : status.running ? (
            <>
              <b className={styles.ok}>● syncing</b> — tag {done}/{tot} · <code className={styles.mono}>{status.tag}</code>
              {status.dl_total > 0 && ` · downloading ${status.dl_done ?? 0}/${status.dl_total}`}
              {` · delivered ${status.delivered ?? 0}, skipped ${status.skipped ?? 0}`}
              {status.errors ? <span className={styles.err}>, errors {status.errors}</span> : null}
            </>
          ) : (
            <>
              <b className={status.enabled ? '' : styles.err}>● {status.enabled ? 'idle' : 'paused'}</b>
              {` — last pass: delivered ${status.delivered ?? 0}, skipped ${status.skipped ?? 0}`}
              {status.errors ? `, errors ${status.errors}` : ''}
              {` · ${status.last_run ? new Date(status.last_run * 1000).toLocaleTimeString() : 'never'}`}
            </>
          )}
        </div>
        <div style={{ height: 8, background: 'var(--app-bg)', border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width .4s' }} />
        </div>
        <div className={styles.headRow}>
          <button className={styles.btn} disabled={busy} onClick={() => void act(upscalerApi.syncToggle, d?.enabled ? 'Paused' : 'Resumed')}>
            {d?.enabled ? <><Pause size={12} /> Pause watching</> : <><Play size={12} /> Resume watching</>}
          </button>
          <button className={styles.btn} disabled={busy} onClick={() => void act(upscalerApi.syncRun, 'Sync started')}><RefreshCw size={12} /> Sync now</button>
          <span className={styles.faint}>watch loop every {d?.interval ?? '…'}s · dest <code className={styles.mono}>{d?.dest_root}</code></span>
        </div>
        {msg && <div className={styles.msg} onClick={() => setMsg(null)}>{msg}</div>}
      </div>

      {/* ── watched trees ── */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>Watched tags ({d?.trees?.length ?? '…'})</div>
        {d && d.trees.length === 0 && (
          <div className={styles.dim}>
            No tags watched yet. Pick one below — its images (and all sub-tag images) that also carry the{' '}
            <code className={styles.mono}>upscaled</code> tag download into nested folders under <code className={styles.mono}>{d.dest_root}</code>.
          </div>
        )}
        {(d?.trees ?? []).map((t: any) => (
          <div key={t.src.tag_id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
            <div className={styles.headRow} style={{ gap: 8 }}>
              <code className={styles.mono} style={{ fontWeight: 600 }}>{t.src.tag_value}</code>
              <span className={styles.faint}>{t.n_tags} tag(s) · {t.total_synced} downloaded</span>
              <span className={styles.spacer} />
              <button
                className={styles.btn}
                disabled={busy}
                onClick={() => void confirmStore.confirm({ title: 'Reset subtree', message: `Reset the ENTIRE ${t.src.tag_value} subtree?`, confirmText: 'Reset' }).then((ok) => { if (ok) void act(() => upscalerApi.syncReset(t.src.tag_id), 'Reset') })}
              >
                reset all
              </button>
              <button className={styles.btnDanger} disabled={busy} onClick={() => void removeWatch(t.src.tag_id, t.src.tag_value)}>remove</button>
            </div>
            {t.tree?.children?.length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary className={styles.faint} style={{ cursor: 'pointer' }}>show {t.n_tags - 1} sub-tag folder(s)</summary>
                <ul style={{ listStyle: 'none', margin: '4px 0 0', paddingLeft: '1.1em' }}>
                  {t.tree.children.map((c: any) => <TagNode key={c.id} n={c} onReset={(id, label, kids) => void resetTag(id, label, kids)} />)}
                </ul>
              </details>
            )}
          </div>
        ))}
      </div>

      {/* ── add a tag ── */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>Add a tag</div>
        <div className={styles.headRow} style={{ marginBottom: 8 }}>
          <input
            className={styles.input}
            style={{ minWidth: '18em' }}
            placeholder="filter tags…"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setQ(qDraft) }}
          />
          <button className={styles.btn} onClick={() => setQ(qDraft)}>search</button>
          {q && <button className={styles.btn} onClick={() => { setQ(''); setQDraft('') }}>clear</button>}
          <span className={styles.faint}>showing {d?.tags?.length ?? 0} of {d?.tag_total ?? '…'}</span>
        </div>
        <div style={{ maxHeight: '50vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
          <table className={styles.table}>
            <tbody>
              {(d?.tags ?? []).length === 0 && <tr><td className={styles.dim}>No tags match.</td></tr>}
              {(d?.tags ?? []).map((tg: any) => (
                <tr key={tg.id}>
                  <td style={{ width: '100%' }}><code className={styles.mono}>{tg.value ?? tg.name}</code></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {d.src_ids.includes(tg.id)
                      ? <span className={styles.faint}>✓ watched</span>
                      : <button className={styles.btn} disabled={busy} onClick={() => void act(() => upscalerApi.syncSource(tg.id, 'add'), 'Watching')}>+ watch</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
