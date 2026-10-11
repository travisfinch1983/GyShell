import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { confirmStore } from '../../../stores/confirmStore'
import { fanslyApi, thumbUrl, fullUrl, type Creator, type LibItem } from './fanslyApi'
import styles from '../rule34/Rule34.module.scss'   // shared addon look (grid, pager, lightbox)
import { useRangeSelect, noShiftTextSelect } from '../rangeSelect'

// Same browser as the rule34 / Instagram / X tabs, over the Fansly/Coomer/Kemono download folders.
const SET_KEY = 'fansly.trainingSet.v1'
const FILTER_KEY = 'fansly.browse.v1'
const PER_PAGE = 60

const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`)

export const BrowserView: React.FC = () => {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') } catch { return {} } })()
  const [source, setSource] = useState<string>(saved.source || '')          // "" | "<svc>" | "<svc>/<creator>"
  const [sort, setSort] = useState<string>(saved.sort || 'newest')
  const [videos, setVideos] = useState<boolean>(!!saved.videos)
  const [q, setQ] = useState('')
  const [qApplied, setQApplied] = useState('')
  const [page, setPage] = useState(1)
  const [d, setD] = useState<{ items: LibItem[]; total: number; total_pages: number } | null>(null)
  const [creators, setCreators] = useState<Creator[]>([])
  const [err, setErr] = useState('')
  const [jumpVal, setJumpVal] = useState('')
  const [lightbox, setLightbox] = useState<LibItem | null>(null)

  const [trainingSets, setTrainingSets] = useState<{ name: string; count: number }[]>([])
  const [selectedSet, setSelectedSet] = useState<string>(() => { try { return localStorage.getItem(SET_KEY) || '' } catch { return '' } })
  const [newSetName, setNewSetName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [setKeys, setSetKeys] = useState<Set<string>>(new Set())
  const [allMembers, setAllMembers] = useState<Record<string, string[]>>({})
  const [tsBusy, setTsBusy] = useState(false)
  const [tsMsg, setTsMsg] = useState('')

  const [svc, creator] = (() => { const i = source.indexOf('/'); return i < 0 ? [source, ''] : [source.slice(0, i), source.slice(i + 1)] })()

  const load = useCallback(async (pg = page, refresh = false) => {
    try {
      const r = await fanslyApi.items({ svc, creator, page: pg, per_page: PER_PAGE, sort, videos, q: qApplied, refresh })
      setD(r)
      setErr('')
      return r
    } catch (e: any) { setErr(String(e?.message || e)) }
  }, [svc, creator, sort, videos, qApplied, page])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    try { localStorage.setItem(FILTER_KEY, JSON.stringify({ source, sort, videos })) } catch { /* ignore */ }
  }, [source, sort, videos])

  const loadCreators = useCallback(async () => {
    try { setCreators((await fanslyApi.creators()).creators) } catch (e: any) { setErr(String(e?.message || e)) }
  }, [])
  const loadSets = useCallback(async () => {
    try { setTrainingSets((await fanslyApi.trainingSets()).sets) } catch (e: any) { setTsMsg(String(e?.message || e)) }
  }, [])
  const loadMembers = useCallback(async (set: string) => {
    if (!set) { setSetKeys(new Set()); return }
    try { setSetKeys(new Set((await fanslyApi.trainingSetMembers(set)).keys)) } catch { setSetKeys(new Set()) }
  }, [])
  const loadAllMembers = useCallback(async () => {
    try { setAllMembers((await fanslyApi.trainingSetMembersAll()).members) } catch { /* keep last */ }
  }, [])
  useEffect(() => { void loadCreators(); void loadSets(); void loadAllMembers() }, [loadCreators, loadSets, loadAllMembers])
  useEffect(() => {
    try { localStorage.setItem(SET_KEY, selectedSet) } catch { /* ignore */ }
    void loadMembers(selectedSet)
  }, [selectedSet, loadMembers])

  // click = toggle one, shift-click = range from the last clicked tile (same as the training browser)
  const pick = useRangeSelect<string>(setSelected)

  const refresh = async () => { await loadCreators(); await load(page, true); void loadAllMembers() }

  const createSet = async () => {
    const name = newSetName.trim()
    if (!name) return
    try {
      const r = await fanslyApi.createTrainingSet(name)
      setNewSetName(''); await loadSets(); setSelectedSet(r.name); setTsMsg(`Created ${r.name}`)
    } catch (e: any) { setTsMsg(String(e?.message || e)) }
  }

  const addToSet = async (ids: string[]) => {
    if (!selectedSet) { setTsMsg('Pick a training set first.'); return }
    if (!ids.length) return
    setTsBusy(true)
    try {
      const r = await fanslyApi.addToTrainingSet(selectedSet, ids)
      const other = r.skipped - r.already_in_set
      setTsMsg(`Added ${r.added} to ${selectedSet}${r.already_in_set ? ` (${r.already_in_set} already there)` : ''}`
        + `${other > 0 ? ` - ${other} skipped (videos can't go in a training set)` : ''}${r.errors?.length ? ` - ${r.errors[0]}` : ''}`)
      setSelected(new Set())
      void loadSets(); void loadAllMembers(); await loadMembers(selectedSet)
    } catch (e: any) { setTsMsg(String(e?.message || e)) } finally { setTsBusy(false) }
  }

  const deleteItems = async (ids: string[]) => {
    if (!ids.length) return
    const ok = await confirmStore.confirm({
      title: `Delete ${ids.length} file${ids.length === 1 ? '' : 's'}`,
      message: 'Delete from the download folder on the NAS? This cannot be undone, and the scraper may download '
        + 'them again on a later run. Copies already in training sets are not touched.',
      confirmText: 'Delete',
    })
    if (!ok) return
    try {
      const r = await fanslyApi.deleteItems(ids)
      setTsMsg(`Deleted ${r.deleted}${r.errors?.length ? ` - ${r.errors[0]}` : ''}`)
    } catch (e: any) { setTsMsg(String(e?.message || e)) }
    setSelected(new Set())
    if (lightbox && ids.includes(lightbox.id)) setLightbox(null)
    await load(); void loadCreators()
  }

  const totalPages = d?.total_pages || 1
  const goToPage = (n: number) => setPage(Math.min(Math.max(1, n), totalPages))
  const items: LibItem[] = d?.items ?? []
  const pageIds = items.map((i) => i.id)

  const navLightbox = async (dir: 1 | -1) => {
    if (!lightbox) return
    const idx = items.findIndex((p) => p.id === lightbox.id)
    const ni = idx + dir
    if (idx >= 0 && ni >= 0 && ni < items.length) { setLightbox(items[ni]); return }
    const tp = page + dir
    if (tp < 1 || tp > totalPages) return
    setPage(tp)
    const r = await load(tp)
    const list = r?.items ?? []
    if (list.length) setLightbox(dir === 1 ? list[0] : list[list.length - 1])
  }

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight') { e.preventDefault(); void navLightbox(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); void navLightbox(-1) }
      else if (e.key === 'Escape') setLightbox(null)
      else if ((e.key === 'a' || e.key === 'A') && selectedSet && !tsBusy && !lightbox.is_video && !setKeys.has(lightbox.key)) {
        e.preventDefault(); void addToSet([lightbox.id])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, items, page, selectedSet, tsBusy, setKeys])

  const pager = (where: 'top' | 'bottom') => totalPages <= 1 ? null : (
    <div className={styles.pagination} data-where={where}>
      <button className={styles.btn} disabled={page <= 1} onClick={() => goToPage(1)}>« First</button>
      <button className={styles.btn} disabled={page <= 1} onClick={() => goToPage(page - 1)}>Prev</button>
      {Array.from({ length: Math.min(totalPages, page + 4) - Math.max(1, page - 4) + 1 }, (_, i) => Math.max(1, page - 4) + i).map((n) => (
        <button key={n} className={n === page ? styles.btnPrimary : styles.btn} onClick={() => goToPage(n)}>{n}</button>
      ))}
      <button className={styles.btn} disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>Next</button>
      <button className={styles.btn} disabled={page >= totalPages} onClick={() => goToPage(totalPages)}>Last »</button>
      <span className={styles.dim}>{page} / {totalPages}</span>
      <input className={styles.jumpInput} type="number" min={1} max={totalPages} placeholder="Go to…" value={jumpVal}
        onChange={(e) => setJumpVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { const n = parseInt(jumpVal, 10); if (!Number.isNaN(n)) goToPage(n); setJumpVal('') } }} />
    </div>
  )

  const setPicker = (inViewer: boolean) => (
    <select className={styles.select} value={selectedSet} title="Training set (same selection as the browser page)"
      onChange={(e) => { setSelectedSet(e.target.value); if (inViewer) e.currentTarget.blur() }}>
      <option value="">— select a set —</option>
      {trainingSets.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.count})</option>)}
    </select>
  )

  const otherSets = (key: string) => (allMembers[key] ?? []).filter((n) => n !== selectedSet)
  const services = Array.from(new Map(creators.map((c) => [c.svc, c.svc_label])).entries())

  return (
    <div className={styles.view} style={{ maxWidth: 'none' }}>
      <div className={styles.headRow}>
        <select className={styles.select} value={source} onChange={(e) => { setSource(e.target.value); setPage(1); setSelected(new Set()) }}>
          <option value="">All creators</option>
          {services.map(([s, label]) => (
            <optgroup key={s} label={label}>
              {services.length > 1 && <option value={s}>All {label}</option>}
              {creators.filter((c) => c.svc === s).map((c) => (
                <option key={c.creator} value={`${s}/${c.creator}`}>{c.creator} ({c.images} img{c.videos ? `, ${c.videos} vid` : ''})</option>
              ))}
            </optgroup>
          ))}
        </select>
        <select className={styles.select} value={sort} onChange={(e) => { setSort(e.target.value); setPage(1) }}>
          <option value="newest">Newest post</option>
          <option value="oldest">Oldest post</option>
          <option value="recent">Recently downloaded</option>
          <option value="largest">Largest</option>
          <option value="name">Folder / name</option>
        </select>
        <label className={styles.dim} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={videos} onChange={(e) => { setVideos(e.target.checked); setPage(1) }} /> Include videos
        </label>
        <form className={styles.searchBar} onSubmit={(e) => { e.preventDefault(); setQApplied(q.trim()); setPage(1) }}>
          <input className={styles.searchInput} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by folder / file name…" />
          <button type="submit" className={styles.btn}>Search</button>
        </form>
        <span className={styles.spacer} />
        {d && <span className={styles.dim}>{d.total.toLocaleString()} {videos ? 'files' : 'images'}</span>}
        <button className={styles.btn} onClick={() => void refresh()} title="Re-scan the download folders now (otherwise new downloads show up within 30 s)"><RefreshCw size={12} /></button>
      </div>

      <div className={styles.headRow}>
        <span className={styles.dim}>Training set:</span>
        {setPicker(false)}
        <input className={styles.select} value={newSetName} onChange={(e) => setNewSetName(e.target.value)} placeholder="new set name…"
          style={{ width: 140 }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createSet() } }} />
        <button className={styles.btn} disabled={!newSetName.trim()} onClick={createSet}>Create</button>
        <span className={styles.spacer} />
        <span className={styles.dim}>{selected.size} selected</span>
        <button className={styles.btn} disabled={!items.length} onClick={() => setSelected(new Set(pageIds))}>Select page</button>
        <button className={styles.btnPrimary} disabled={!selectedSet || !selected.size || tsBusy} onClick={() => addToSet([...selected])}>
          {tsBusy ? 'Adding…' : `Add ${selected.size} to set`}
        </button>
        <button className={styles.btnDanger} disabled={!selected.size} onClick={() => deleteItems([...selected])}>Delete</button>
        <button className={styles.btn} disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear</button>
      </div>
      {(tsMsg || err) && <div className={styles.msg}>{err || tsMsg}</div>}

      {!d ? <span className={styles.dim}>{err ? '' : 'Loading…'}</span> : items.length === 0 ? (
        <span className={styles.dim}>Nothing here yet - downloads appear as the scraper (Scraper tab) saves them.</span>
      ) : (
        <>
          {pager('top')}
          <div className={styles.grid}>
            {items.map((p) => {
              const inSet = setKeys.has(p.key)
              const elsewhere = !inSet && (allMembers[p.key]?.length ?? 0) > 0
              return (
                <div key={p.id} className={styles.gridItem} onMouseDown={noShiftTextSelect}
                  onClick={(e) => { if (e.shiftKey) { pick(p.id, pageIds, true); return } setLightbox(p) }}
                  title={`${p.creator}/${p.section ? `${p.section}/` : ''}${p.name}`}
                  style={selected.has(p.id) ? { outline: '3px solid var(--accent)', outlineOffset: -3 } : undefined}>
                  <img src={thumbUrl(p.id)} alt={p.name} loading="lazy" />
                  <div className={styles.gridOverlay}>
                    <span>{p.posted_at ? new Date(p.posted_at * 1000).toLocaleDateString() : p.section}</span>
                    {p.is_video ? <span className={styles.videoBadge}>VID</span> : p.width && p.height ? <span>{p.width}×{p.height}</span> : null}
                  </div>
                  {(inSet || elsewhere) && (
                    <>
                      <div style={{ position: 'absolute', inset: 0, border: `3px ${inSet ? 'solid #22c55e' : 'dashed #14b8a6'}`, borderRadius: 'inherit', boxSizing: 'border-box', pointerEvents: 'none', zIndex: 3 }} />
                      <span title={inSet ? `Already in ${selectedSet}` : `Already in: ${allMembers[p.key].join(', ')}`}
                        style={{ position: 'absolute', top: 4, right: 4, zIndex: 4, background: inSet ? '#22c55e' : '#14b8a6', color: '#fff', borderRadius: 4, fontSize: 10, fontWeight: 700, padding: '1px 4px' }}>
                        {inSet ? 'In set' : 'In other set'}
                      </span>
                    </>
                  )}
                  <input type="checkbox" checked={selected.has(p.id)} onMouseDown={noShiftTextSelect}
                    onClick={(e) => { e.stopPropagation(); pick(p.id, pageIds, e.shiftKey) }}
                    onChange={() => { /* handled in onClick (needs shiftKey) */ }} title="Select - shift-click to select a range"
                    style={{ position: 'absolute', top: 4, left: 4, width: 18, height: 18, cursor: 'pointer', zIndex: 2 }} />
                </div>
              )
            })}
          </div>
          {pager('bottom')}
        </>
      )}

      {lightbox && (
        <div className={styles.lightboxOverlay} onClick={() => setLightbox(null)}>
          <div className={styles.lightboxFull} onClick={(e) => e.stopPropagation()}>
            <button className={styles.lightboxClose} onClick={() => setLightbox(null)}>×</button>
            <button className={styles.lightboxNav} style={{ left: 12 }} onClick={() => void navLightbox(-1)} title="Previous (←)">‹</button>
            <button className={styles.lightboxNav} style={{ right: 12 }} onClick={() => void navLightbox(1)} title="Next (→)">›</button>
            <div className={styles.lightboxMediaFull} style={{ display: 'flex' }}>
              {lightbox.is_video
                ? <video key={lightbox.id} src={fullUrl(lightbox.id)} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%' }} />
                : <img src={fullUrl(lightbox.id)} alt={lightbox.name} draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
            </div>
            <div className={styles.lightboxSetBar}>
              {setPicker(true)}
              {setKeys.has(lightbox.key) ? (
                <span className={styles.ok} style={{ fontWeight: 600 }}>✓ In set</span>
              ) : (
                <button className={styles.btnPrimary} disabled={!selectedSet || tsBusy || !!lightbox.is_video}
                  title={lightbox.is_video ? 'Videos cannot go in a training set' : selectedSet ? `Add to ${selectedSet} (A)` : 'Pick a training set first'}
                  onClick={() => addToSet([lightbox.id])}>{tsBusy ? 'Adding…' : '+ Add to set'}</button>
              )}
              {otherSets(lightbox.key).length > 0 && <span className={styles.dim}>also in {otherSets(lightbox.key).join(', ')}</span>}
              <button className={styles.btnDanger} onClick={() => void deleteItems([lightbox.id])} title="Delete from the download folder"><Trash2 size={12} /></button>
              {tsMsg && <span className={styles.dim}>{tsMsg}</span>}
            </div>
            <div className={styles.lightboxInfoBar}>
              <div className={styles.lightboxMeta}>
                <span>{lightbox.creator}</span>
                {lightbox.section && <span>{lightbox.section}</span>}
                {lightbox.posted_at && <span>{new Date(lightbox.posted_at * 1000).toLocaleString()}</span>}
                {lightbox.width && lightbox.height && <span>{lightbox.width}×{lightbox.height}</span>}
                <span>{fmtSize(lightbox.size)}</span>
              </div>
              <div className={styles.dim} style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{lightbox.name}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
