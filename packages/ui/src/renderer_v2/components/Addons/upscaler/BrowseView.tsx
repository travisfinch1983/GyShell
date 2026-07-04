import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { confirmStore } from '../../../stores/confirmStore'
import { upscalerApi, previewUrl } from './upscalerApi'
import styles from './Upscaler.module.scss'

/**
 * Upscaler · Browse — native port of templates/browse.html: pick an album OR a
 * tag (mutually exclusive), browse its assets with cross-page selection
 * (persisted per scope in sessionStorage, parity with the template's script),
 * queue selected / queue ALL (± child-tag fan-out with confirm), add the scope
 * as a watch source. Native upgrade: thumbnails via /preview (the Jinja table
 * had none).
 */

const selKey = (album: string, tag: string) => `upscale-sel-${album}|${tag}`
const loadSel = (k: string): Set<string> => {
  try { return new Set(JSON.parse(sessionStorage.getItem(k) ?? '[]')) } catch { return new Set() }
}

export const BrowseView: React.FC = () => {
  const [album, setAlbum] = useState('')
  const [tag, setTag] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState('50')
  const [d, setD] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setD(await upscalerApi.browse({ album_id: album, tag_id: tag, page, page_size: pageSize }))
      setMsg(null)
    } catch (e) {
      setMsg(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }, [album, tag, page, pageSize])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setSel(loadSel(selKey(album, tag))) }, [album, tag])

  const saveSel = (next: Set<string>) => {
    setSel(next)
    sessionStorage.setItem(selKey(album, tag), JSON.stringify([...next]))
  }
  const toggle = (id: string, on: boolean) => {
    const n = new Set(sel)
    if (on) n.add(id); else n.delete(id)
    saveSel(n)
  }

  const scopePicked = Boolean(album || tag)
  const assets: any[] = d?.assets ?? []
  const expanded = d?.expanded_tag_count ?? 0
  const scopeName = album
    ? d?.albums?.find((a: any) => a.id === album)?.albumName ?? 'album'
    : d?.tags?.find((t: any) => t.id === tag)?.value ?? d?.tags?.find((t: any) => t.id === tag)?.name ?? 'tag'

  const act = async (fn: () => Promise<any>, label: string) => {
    setBusy(true)
    try {
      const r = await fn()
      setMsg(r?.ok === false ? `${label} failed` : `${label} ✓${r?.queued != null ? ` — ${r.queued} queued${r?.matching != null ? ` of ${r.matching} matching` : ''}` : ''}`)
    } catch (e) {
      setMsg(`${label} failed: ${String((e as Error).message)}`)
    } finally {
      setBusy(false)
    }
  }

  const queueSelected = async () => {
    if (!sel.size) return
    await act(() => upscalerApi.queueAssets([...sel]), `Queue ${sel.size}`)
    saveSel(new Set()) // parity: selection clears after submit
  }
  const queueAll = async (includeChildren: boolean) => {
    const ok = await confirmStore.confirm({
      title: includeChildren ? 'Queue ALL incl. children' : 'Queue ALL matching',
      message: includeChildren
        ? `Fan out to ${expanded} child tag(s) of “${scopeName}” — first-time fetch can take 1–2 minutes. Continue?`
        : `Queue every asset directly matching “${scopeName}”? The server pre-counts on submit (can take ~10–30s for large sources).`,
      confirmText: 'Queue',
    })
    if (!ok) return
    await act(() => upscalerApi.queueAll({ album_id: album || undefined, tag_id: tag || undefined, include_children: includeChildren }), 'Queue all')
  }
  const addAsWatch = () =>
    void act(() => upscalerApi.addSource(album ? 'album' : 'tag', album || tag, scopeName, 'watch'), 'Watch source added')

  const mp = (a: any) => {
    const w = a.exifInfo?.exifImageWidth ?? 0
    const h = a.exifInfo?.exifImageHeight ?? 0
    return w && h ? `${w} × ${h} (${((w * h) / 1e6).toFixed(1)} MP)` : '?'
  }

  return (
    <div className={styles.view}>
      <div className={styles.headRow}>
        <select className={styles.select} value={album} onChange={(e) => { setAlbum(e.target.value); if (e.target.value) setTag(''); setPage(1) }}>
          <option value="">— pick album —</option>
          {(d?.albums ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.albumName} ({a.assetCount ?? '?'})</option>)}
        </select>
        <span className={styles.faint}>or</span>
        <select className={styles.select} value={tag} onChange={(e) => { setTag(e.target.value); if (e.target.value) setAlbum(''); setPage(1) }}>
          <option value="">— pick tag —</option>
          {(d?.tags ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.value ?? t.name}</option>)}
        </select>
        <label className={styles.faint}>
          per page{' '}
          <select className={styles.select} value={pageSize} onChange={(e) => { setPageSize(e.target.value); setPage(1) }}>
            {(d?.page_size_options ?? [25, 50, 100, 250]).map((o: number) => <option key={o} value={String(o)}>{o}</option>)}
            <option value="all">All</option>
          </select>
        </label>
        <button className={styles.btn} title="Re-fetch from Immich (after adding albums/tags/photos there)" onClick={() => void load()}>
          <RefreshCw size={12} className={busy ? 'spin' : ''} />
        </button>
        <span className={styles.spacer} />
        {scopePicked && <button className={styles.btn} onClick={addAsWatch}>Add “{scopeName}” as watch source{tag && expanded > 1 ? ` (${expanded} tags incl. children)` : ''}</button>}
      </div>
      {msg && <span className={styles.msg} onClick={() => setMsg(null)}>{msg}</span>}

      {!scopePicked && <div className={styles.dim}>Pick an album or a tag to browse its assets.</div>}

      {scopePicked && d && (
        <>
          <div className={styles.headRow}>
            <span className={styles.dim}>
              {d.show_all ? `${d.total} asset(s) total` : d.page_list?.length ? `${d.total} asset(s) — page ${d.page} of ${d.total_pages}` : `page ${d.page} — ${assets.length} on this page${d.has_more ? ' (more available)' : ''}`}
            </span>
            {tag && expanded > 1 && (
              <span className={styles.faint}>direct only — this tag has {expanded - 1} child tag(s); “Queue ALL incl. children” covers nested</span>
            )}
            <span className={styles.spacer} />
            <span className={styles.dim}><b>{sel.size}</b> selected across pages</span>
            <button className={styles.btn} disabled={!sel.size} onClick={() => saveSel(new Set())}>Clear</button>
            <button className={styles.btnPrimary} disabled={busy || !sel.size} onClick={() => void queueSelected()}>Queue selected ({sel.size})</button>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={assets.length > 0 && assets.every((a) => sel.has(a.id))}
                    onChange={(e) => {
                      const n = new Set(sel)
                      assets.forEach((a) => (e.target.checked ? n.add(a.id) : n.delete(a.id)))
                      saveSel(n)
                    }}
                  />
                </th>
                <th>Asset</th><th>Filename</th><th>Resolution</th><th>Type</th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 && <tr><td colSpan={5} className={styles.dim}>{busy ? 'loading…' : 'No assets in this scope.'}</td></tr>}
              {assets.map((a) => (
                <tr key={a.id}>
                  <td><input type="checkbox" checked={sel.has(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} /></td>
                  <td>
                    <img src={previewUrl(a.id)} alt="" loading="lazy" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, verticalAlign: 'middle', marginRight: 8 }} />
                    <code className={styles.mono}>{a.id.slice(0, 8)}</code>
                  </td>
                  <td>{a.originalFileName}</td>
                  <td className={styles.mono}>{mp(a)}</td>
                  <td className={styles.dim}>{a.type}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className={styles.headRow}>
            <button className={styles.btn} disabled={busy} onClick={() => void queueAll(false)}>Queue ALL matching (direct only)</button>
            {tag && expanded > 1 && (
              <button className={styles.btn} disabled={busy} onClick={() => void queueAll(true)}>Queue ALL incl. {expanded - 1} child tag(s) — slow first time</button>
            )}
            <span className={styles.spacer} />
            {!d.show_all && d.total_pages > 1 && (
              <span className={styles.headRow}>
                <button className={styles.btn} disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}>« prev</button>
                {(d.page_list ?? []).map((p: number | string, i: number) =>
                  p === '...' ? <span key={`e${i}`} className={styles.faint}>…</span> : (
                    <button key={p} className={p === d.page ? styles.btnPrimary : styles.btn} onClick={() => setPage(Number(p))}>{p}</button>
                  ),
                )}
                <button className={styles.btn} disabled={d.page >= d.total_pages} onClick={() => setPage(d.page + 1)}>next »</button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
