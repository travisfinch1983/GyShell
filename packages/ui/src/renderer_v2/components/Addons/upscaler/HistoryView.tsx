import React, { useCallback, useEffect, useState } from 'react'
import { confirmStore } from '../../../stores/confirmStore'
import { upscalerApi, previewUrl } from './upscalerApi'
import { CompareOverlay } from './CompareOverlay'
import styles from './Upscaler.module.scss'

/**
 * Upscaler · History — native port of templates/history.html: ok/failed tabs
 * with counts, album/tag filter (mutually exclusive; tag adds include-children),
 * per-page selector, bulk retry/reprocess (selected · all-in-filter ·
 * all-failed, with the template's confirm messages), per-row compare (opens the
 * CompareOverlay detail view) / reprocess / retry, ellipsis pagination.
 */
export const HistoryView: React.FC = () => {
  const [view, setView] = useState<'ok' | 'failed'>('ok')
  const [album, setAlbum] = useState('')
  const [tag, setTag] = useState('')
  const [children, setChildren] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState('50')
  const [d, setD] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [compareId, setCompareId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setD(await upscalerApi.history({ page, status: view, album_id: album, tag_id: tag, include_children: children, page_size: pageSize }))
    } catch (e) {
      setMsg(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }, [page, view, album, tag, children, pageSize])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setSel(new Set()) }, [view, album, tag, children, page])

  const act = async (fn: () => Promise<any>, label: string) => {
    setBusy(true)
    try {
      const r = await fn()
      setMsg(r?.ok === false ? `${label} failed` : `${label} ✓${r?.reprocessed != null ? ` — ${r.reprocessed} re-enqueued` : ''}`)
      await load()
    } catch (e) {
      setMsg(`${label} failed: ${String((e as Error).message)}`)
    } finally {
      setBusy(false)
    }
  }

  const confirmThen = async (message: string, fn: () => Promise<any>, label: string) => {
    const ok = await confirmStore.confirm({ title: label, message, confirmText: 'Go' })
    if (ok) await act(fn, label)
  }

  const entries: any[] = d?.entries ?? []
  const filterCtx = { view, album_id: album || undefined, tag_id: tag || undefined, include_children: children }
  const verb = view === 'failed' ? 'Retry' : 'Reprocess'

  return (
    <div className={styles.view}>
      {/* filter bar */}
      <div className={styles.headRow}>
        <select className={styles.select} value={album} onChange={(e) => { setAlbum(e.target.value); if (e.target.value) { setTag(''); setChildren(false) } setPage(1) }}>
          <option value="">— any album —</option>
          {(d?.albums ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.albumName} ({a.assetCount ?? '?'})</option>)}
        </select>
        <select className={styles.select} value={tag} onChange={(e) => { setTag(e.target.value); if (e.target.value) setAlbum(''); setPage(1) }}>
          <option value="">— any tag —</option>
          {(d?.tags ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.value ?? t.name}</option>)}
        </select>
        {tag && (
          <label className={styles.dim} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <input type="checkbox" checked={children} onChange={(e) => { setChildren(e.target.checked); setPage(1) }} /> include child tags
          </label>
        )}
        {d?.filter_active && <button className={styles.btn} onClick={() => { setAlbum(''); setTag(''); setChildren(false); setPage(1) }}>clear filter</button>}
        <span className={styles.spacer} />
        <label className={styles.faint}>
          show{' '}
          <select className={styles.select} value={pageSize} onChange={(e) => { setPageSize(e.target.value); setPage(1) }}>
            {(d?.page_size_options ?? [50, 100, 250, 500, 1000]).map((o: number | string) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
          </select>{' '}per page
        </label>
      </div>

      {/* ok/failed tabs */}
      <div className={styles.headRow}>
        <button className={view === 'ok' ? styles.btnPrimary : styles.btn} onClick={() => { setView('ok'); setPage(1) }}>
          Successful ({d?.ok_count ?? '…'})
        </button>
        <button className={view === 'failed' ? styles.btnPrimary : styles.btn} onClick={() => { setView('failed'); setPage(1) }}>
          Failed ({d?.failed_count ?? '…'})
        </button>
        <span className={styles.dim}>
          {d ? `${d.total} ${d.view}${d.filter_active ? ` in ${d.filter_label}` : ''}` : ''}
        </span>
        <span className={styles.spacer} />
        {d?.filter_active && d.total > 0 && (
          <button
            className={view === 'failed' ? styles.btnDanger : styles.btn}
            disabled={busy}
            onClick={() => void confirmThen(
              `Re-enqueue ALL ${d.total} ${view} asset(s) in ${d.filter_label} on the current active model?`,
              () => upscalerApi.reprocessBatch({ ...filterCtx, all_in_filter: true }),
              `${verb} all in filter`,
            )}
          >
            {verb} all {d.total} in this filter
          </button>
        )}
        {!d?.filter_active && view === 'failed' && (d?.failed_count ?? 0) > 0 && (
          <button
            className={styles.btnDanger}
            disabled={busy}
            onClick={() => void confirmThen(
              `Retry ALL ${d.failed_count} failures (unfiltered)?`,
              () => upscalerApi.reprocessBatch({ view: 'failed', all_failed: true }),
              'Retry all failed',
            )}
          >
            Retry all {d.failed_count} failed
          </button>
        )}
      </div>
      {msg && <span className={styles.msg} onClick={() => setMsg(null)}>{msg}</span>}

      {/* bulk bar */}
      {sel.size > 0 && (
        <div className={styles.headRow}>
          <span className={styles.dim}><b>{sel.size}</b> selected</span>
          <button
            className={styles.btn}
            disabled={busy}
            onClick={() => void confirmThen(
              'Re-enqueue the selected asset(s) on the CURRENT active upscaler? To run with a different model, switch the model in Settings first.',
              () => upscalerApi.reprocessBatch({ ...filterCtx, asset_id: [...sel] }),
              `${verb} selected`,
            )}
          >
            {verb} selected
          </button>
          <button className={styles.btn} onClick={() => setSel(new Set())}>clear</button>
        </div>
      )}

      <table className={styles.table}>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={entries.length > 0 && entries.every((e) => sel.has(e.asset_id))}
                onChange={(ev) => setSel(ev.target.checked ? new Set(entries.map((e) => e.asset_id)) : new Set())}
              />
            </th>
            <th>When</th><th /><th>File</th>
            {view === 'ok' ? <><th>Before</th><th>After</th><th>Model</th><th>Time</th><th /></> : <><th>Model</th><th>Error</th><th /></>}
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr><td colSpan={view === 'ok' ? 9 : 7} className={styles.dim}>
              {busy ? 'loading…' : d?.filter_active ? `No ${view} assets in ${d.filter_label}.` : view === 'failed' ? 'No failures recorded.' : 'No completed assets yet.'}
            </td></tr>
          )}
          {entries.map((a) => (
            <tr key={`${a.asset_id}-${a.processed_at}`}>
              <td><input type="checkbox" checked={sel.has(a.asset_id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(a.asset_id); else n.delete(a.asset_id); return n })} /></td>
              <td className={styles.dim}>{a.processed_at ? new Date(a.processed_at * 1000).toLocaleString() : '—'}</td>
              <td>
                <img
                  src={previewUrl(a.new_asset_id ?? a.asset_id)}
                  alt=""
                  loading="lazy"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  onClick={() => { if (view === 'ok' && a.new_asset_id) setCompareId(a.asset_id) }}
                  style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4, cursor: view === 'ok' && a.new_asset_id ? 'pointer' : 'default' }}
                />
              </td>
              <td>{a.filename ?? a.asset_id.slice(0, 12)}</td>
              {view === 'ok' ? (
                <>
                  <td className={styles.mono}>{a.src_w && a.src_h ? `${a.src_w}×${a.src_h} (${((a.src_w * a.src_h) / 1e6).toFixed(1)} MP)` : '?'}</td>
                  <td className={styles.mono}>{a.dst_w && a.dst_h ? `${a.dst_w}×${a.dst_h} (${((a.dst_w * a.dst_h) / 1e6).toFixed(1)} MP)` : '?'}</td>
                  <td className={styles.dim}>{a.model ?? '-'}</td>
                  <td className={styles.dim}>{(a.elapsed_sec ?? 0).toFixed(1)}s</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className={styles.btn} onClick={() => setCompareId(a.asset_id)}>compare</button>{' '}
                    <button
                      className={styles.btn}
                      disabled={busy}
                      onClick={() => void confirmThen(
                        'Reprocess this asset on the CURRENT active model? Switch the model in Settings first if you want a different upscaler.',
                        () => upscalerApi.reprocess(a.asset_id, 'ok'),
                        'Reprocess',
                      )}
                    >
                      reprocess
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className={styles.dim}>{a.model ?? '-'}</td>
                  <td style={{ maxWidth: '40em', wordBreak: 'break-word' }}>
                    {a.error?.trim()
                      ? <code className={`${styles.mono} ${styles.faint}`}>{a.error.slice(0, 200)}{a.error.length > 200 ? '…' : ''}</code>
                      : <span className={styles.faint}>(no error captured — likely SSH crashed before output)</span>}
                  </td>
                  <td>
                    <button
                      className={styles.btn}
                      disabled={busy}
                      onClick={() => void confirmThen('Retry this asset on the current active model?', () => upscalerApi.reprocess(a.asset_id, 'failed'), 'Retry')}
                    >
                      retry
                    </button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {d && d.total_pages > 1 && (
        <div className={styles.headRow}>
          <button className={styles.btn} disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}>« prev</button>
          {(d.page_list ?? []).map((p: number | string, i: number) =>
            p === '...' ? <span key={`e${i}`} className={styles.faint}>…</span> : (
              <button key={p} className={p === d.page ? styles.btnPrimary : styles.btn} onClick={() => setPage(Number(p))}>{p}</button>
            ),
          )}
          <button className={styles.btn} disabled={d.page >= d.total_pages} onClick={() => setPage(d.page + 1)}>next »</button>
        </div>
      )}

      {compareId && <CompareOverlay assetId={compareId} onClose={() => setCompareId(null)} />}
    </div>
  )
}
