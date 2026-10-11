import React, { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Trash2 } from 'lucide-react'
import { confirmStore } from '../../../stores/confirmStore'
import { socialApi, thumbUrl, fullUrl, type MediaItem, type Site } from './socialApi'
import styles from '../rule34/Rule34.module.scss'   // shared addon look (grid, pager, lightbox)

// ONE training-set selection for both social browsers (and their viewers).
const SET_KEY = 'social.trainingSet.v1'
const PER_PAGE = 60

export const makeBrowserView = (site: Site): React.FC => {
  const api = socialApi(site)
  const FILTER_KEY = `social.${site}.browse.v1`
  const View: React.FC = () => {
    const saved = (() => { try { return JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') } catch { return {} } })()
    const [account, setAccount] = useState<number>(Number(saved.account) || 0)
    const [sort, setSort] = useState<string>(saved.sort || 'newest')
    const [q, setQ] = useState('')
    const [qApplied, setQApplied] = useState('')
    const [page, setPage] = useState(1)
    const [d, setD] = useState<any>(null)
    const [err, setErr] = useState('')
    const [jumpVal, setJumpVal] = useState('')
    const [lightbox, setLightbox] = useState<MediaItem | null>(null)

    const [trainingSets, setTrainingSets] = useState<{ name: string; count: number }[]>([])
    const [selectedSet, setSelectedSet] = useState<string>(() => { try { return localStorage.getItem(SET_KEY) || '' } catch { return '' } })
    const [newSetName, setNewSetName] = useState('')
    const [selected, setSelected] = useState<Set<number>>(new Set())
    const [setKeys, setSetKeys] = useState<Set<string>>(new Set())
    const [allMembers, setAllMembers] = useState<Record<string, string[]>>({})
    const [tsBusy, setTsBusy] = useState(false)
    const [tsMsg, setTsMsg] = useState('')

    const load = useCallback(async (pg = page) => {
      try {
        const r = await api.browser({ account, page: pg, per_page: PER_PAGE, sort, q: qApplied })
        setD(r)
        setErr('')
        return r
      } catch (e: any) { setErr(String(e?.message || e)) }
    }, [account, sort, qApplied, page])
    useEffect(() => { void load() }, [load])
    useEffect(() => {
      try { localStorage.setItem(FILTER_KEY, JSON.stringify({ account, sort })) } catch { /* ignore */ }
    }, [account, sort])

    const loadSets = useCallback(async () => {
      try { setTrainingSets((await api.trainingSets()).sets) } catch { /* ignore */ }
    }, [])
    const loadMembers = useCallback(async (set: string) => {
      if (!set) { setSetKeys(new Set()); return }
      try { setSetKeys(new Set((await api.trainingSetMembers(set)).keys)) } catch { setSetKeys(new Set()) }
    }, [])
    const loadAllMembers = useCallback(async () => {
      try { setAllMembers((await api.trainingSetMembersAll()).members) } catch { /* keep last */ }
    }, [])
    useEffect(() => { void loadSets(); void loadAllMembers() }, [loadSets, loadAllMembers])
    useEffect(() => {
      try { localStorage.setItem(SET_KEY, selectedSet) } catch { /* ignore */ }
      void loadMembers(selectedSet)
    }, [selectedSet, loadMembers])

    const toggleSelect = (id: number) =>
      setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

    const createSet = async () => {
      const name = newSetName.trim()
      if (!name) return
      const r = await api.createTrainingSet(name)
      if (r?.ok) { setNewSetName(''); await loadSets(); setSelectedSet(r.name); setTsMsg(`Created ${r.name}`) }
      else setTsMsg(r?.error || 'Create failed')
    }

    const addToSet = async (ids: number[]) => {
      if (!selectedSet) { setTsMsg('Pick a training set first.'); return }
      if (!ids.length) return
      setTsBusy(true)
      try {
        const r = await api.addToTrainingSet(selectedSet, ids)
        if (r?.ok) {
          setTsMsg(`Added ${r.added} to ${selectedSet}${r.already_in_set ? ` (${r.already_in_set} already there)` : ''}${r.errors?.length ? ` - ${r.errors[0]}` : ''}`)
          setSelected(new Set())
          void loadSets(); void loadAllMembers(); await loadMembers(selectedSet)
        } else setTsMsg(r?.error || 'Add failed')
      } catch (e: any) { setTsMsg(String(e?.message || e)) } finally { setTsBusy(false) }
    }

    const deleteItems = async (ids: number[]) => {
      if (!ids.length) return
      const ok = await confirmStore.confirm({
        title: `Delete ${ids.length} file${ids.length === 1 ? '' : 's'}`,
        message: 'Remove from the library and from disk? They will NOT be downloaded again on the next sync. '
          + 'Copies already in training sets are not touched.',
        confirmText: 'Delete',
      })
      if (!ok) return
      const r = await api.deleteMedia(ids)
      setTsMsg(`Deleted ${r?.deleted ?? 0}`)
      setSelected(new Set())
      if (lightbox && ids.includes(lightbox.id)) setLightbox(null)
      await load()
    }

    const totalPages = d?.total_pages || 1
    const goToPage = (n: number) => setPage(Math.min(Math.max(1, n), totalPages))
    const items: MediaItem[] = d?.items ?? []

    const openLightbox = async (id: number) => {
      try { setLightbox(await api.media(id)) } catch (e: any) { setTsMsg(String(e?.message || e)) }
    }
    const navLightbox = async (dir: 1 | -1) => {
      if (!lightbox) return
      const idx = items.findIndex((p) => p.id === lightbox.id)
      const ni = idx + dir
      if (idx >= 0 && ni >= 0 && ni < items.length) { await openLightbox(items[ni].id); return }
      const tp = page + dir
      if (tp < 1 || tp > totalPages) return
      setPage(tp)
      const r = await load(tp)
      const list: MediaItem[] = r?.items ?? []
      if (list.length) await openLightbox((dir === 1 ? list[0] : list[list.length - 1]).id)
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
      <select className={styles.select} value={selectedSet} title="Training set (shared by both social browsers and their viewers)"
        onChange={(e) => { setSelectedSet(e.target.value); if (inViewer) e.currentTarget.blur() }}>
        <option value="">— select a set —</option>
        {trainingSets.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.count})</option>)}
      </select>
    )

    const otherSets = (key: string) => (allMembers[key] ?? []).filter((n) => n !== selectedSet)

    return (
      <div className={styles.view} style={{ maxWidth: 'none' }}>
        <div className={styles.headRow}>
          <select className={styles.select} value={account} onChange={(e) => { setAccount(Number(e.target.value)); setPage(1) }}>
            <option value={0}>All accounts</option>
            {(d?.accounts ?? []).map((a: any) => <option key={a.id} value={a.id}>@{a.handle} ({a.n_media})</option>)}
          </select>
          <select className={styles.select} value={sort} onChange={(e) => { setSort(e.target.value); setPage(1) }}>
            <option value="newest">Newest post</option>
            <option value="oldest">Oldest post</option>
            <option value="recent">Recently downloaded</option>
            <option value="largest">Largest</option>
          </select>
          <form className={styles.searchBar} onSubmit={(e) => { e.preventDefault(); setQApplied(q.trim()); setPage(1) }}>
            <input className={styles.searchInput} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search captions…" />
            <button type="submit" className={styles.btn}>Search</button>
          </form>
          <span className={styles.spacer} />
          {d && <span className={styles.dim}>{d.total.toLocaleString()} images</span>}
        </div>

        <div className={styles.headRow}>
          <span className={styles.dim}>Training set:</span>
          {setPicker(false)}
          <input className={styles.select} value={newSetName} onChange={(e) => setNewSetName(e.target.value)} placeholder="new set name…"
            style={{ width: 140 }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createSet() } }} />
          <button className={styles.btn} disabled={!newSetName.trim()} onClick={createSet}>Create</button>
          <span className={styles.spacer} />
          <span className={styles.dim}>{selected.size} selected</span>
          <button className={styles.btn} disabled={!items.length} onClick={() => setSelected(new Set(items.filter((i) => !i.is_video).map((i) => i.id)))}>Select page</button>
          <button className={styles.btnPrimary} disabled={!selectedSet || !selected.size || tsBusy} onClick={() => addToSet([...selected])}>
            {tsBusy ? 'Adding…' : `Add ${selected.size} to set`}
          </button>
          <button className={styles.btnDanger} disabled={!selected.size} onClick={() => deleteItems([...selected])}>Delete</button>
          <button className={styles.btn} disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
        {(tsMsg || err) && <div className={styles.msg}>{err || tsMsg}</div>}

        {!d ? <span className={styles.dim}>Loading…</span> : items.length === 0 ? (
          <span className={styles.dim}>Nothing here yet - add accounts on the Dashboard tab; images appear as they download.</span>
        ) : (
          <>
            {pager('top')}
            <div className={styles.grid}>
              {items.map((p) => {
                const inSet = setKeys.has(p.key)
                const elsewhere = !inSet && (allMembers[p.key]?.length ?? 0) > 0
                return (
                  <div key={p.id} className={styles.gridItem} onClick={() => void openLightbox(p.id)}
                    style={selected.has(p.id) ? { outline: '3px solid var(--accent)', outlineOffset: -3 } : undefined}>
                    {p.is_video ? <div style={{ display: 'grid', placeItems: 'center', height: '100%' }} className={styles.dim}>video</div>
                      : <img src={thumbUrl(p.id)} alt={p.post_id} loading="lazy" />}
                    <div className={styles.gridOverlay}>
                      <span>@{p.handle}</span>
                      {p.width && p.height ? <span>{p.width}×{p.height}</span> : null}
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
                    {!p.is_video && (
                      <input type="checkbox" checked={selected.has(p.id)} onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelect(p.id)} title="Select"
                        style={{ position: 'absolute', top: 4, left: 4, width: 18, height: 18, cursor: 'pointer', zIndex: 2 }} />
                    )}
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
                  ? <video src={fullUrl(lightbox.id)} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%' }} />
                  : <img src={fullUrl(lightbox.id)} alt={lightbox.post_id} draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
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
                <button className={styles.btnDanger} onClick={() => void deleteItems([lightbox.id])} title="Delete from the library"><Trash2 size={12} /></button>
                {tsMsg && <span className={styles.dim}>{tsMsg}</span>}
              </div>
              <div className={styles.lightboxInfoBar}>
                <div className={styles.lightboxMeta}>
                  <span>@{lightbox.handle}</span>
                  {lightbox.posted_at && <span>{new Date(lightbox.posted_at * 1000).toLocaleDateString()}</span>}
                  {lightbox.width && lightbox.height && <span>{lightbox.width}×{lightbox.height}</span>}
                  {lightbox.post_url && (
                    <a href={lightbox.post_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                      open post <ExternalLink size={11} />
                    </a>
                  )}
                </div>
                {lightbox.caption && (
                  <div className={styles.dim} style={{ whiteSpace: 'pre-wrap', maxHeight: 90, overflow: 'auto', fontSize: 12 }}>{lightbox.caption}</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
  return View
}
