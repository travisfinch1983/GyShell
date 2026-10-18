import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { rule34Api, thumbUrl, fullUrl } from './rule34Api'
import { confirmStore } from '../../../stores/confirmStore'
import styles from './Rule34.module.scss'
import { useRangeSelect, noShiftTextSelect } from '../rangeSelect'

type SidebarSort = 'count' | 'alpha'

type BrowseTab = { id: string; tags: string; page: number }
const TABS_KEY = 'rule34.browseTabs.v1'
const ACTIVE_KEY = 'rule34.activeTab.v1'
const SET_KEY = 'rule34.trainingSet.v1'
const SITES_KEY = 'rule34.sites.v1'
// Site badges: short label + colour per source site. A deduped image carries
// one badge per site it exists on and is hidden only when every one of its
// sites is toggled off (the backend filter works on posts.site, so an image
// whose only enabled twin is filtered out simply has no visible row).
const SITE_META: Record<string, { label: string; color: string; title: string }> = {
  rule34: { label: 'R34', color: '#86b300', title: 'rule34.xxx' },
  danbooru: { label: 'Dan', color: '#0075f8', title: 'danbooru.donmai.us' },
  gelbooru: { label: 'Gel', color: '#a24cc8', title: 'gelbooru.com' },
}
const ALL_SITES = Object.keys(SITE_META)
const loadStoredSites = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(SITES_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (p && typeof p === 'object') return { rule34: p.rule34 !== false, danbooru: p.danbooru !== false, gelbooru: p.gelbooru !== false }
    }
  } catch { /* ignore */ }
  return { rule34: true, danbooru: true, gelbooru: true }
}
const MAX_TABS = 50
const loadStoredTabs = (): BrowseTab[] => {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        const clean = parsed
          .filter((t: any) => t && typeof t.id === 'string' && typeof t.tags === 'string')
          .map((t: any) => ({ id: t.id, tags: t.tags, page: Number(t.page) || 1 }))
        if (clean.length) return clean.slice(0, MAX_TABS)
      }
    }
  } catch { /* ignore */ }
  return [{ id: 't0', tags: '', page: 1 }]
}

export const BrowserView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [search, setSearch] = useState('')
  // Internal browse tabs — each keeps its own tag filter + page, so opening a
  // tag from the lightbox in a NEW tab preserves the current browse. Shares all
  // other state (selection, training set, "In set" highlight) live across tabs.
  const [tabs, setTabs] = useState<BrowseTab[]>(loadStoredTabs)
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    try { return localStorage.getItem(ACTIVE_KEY) || 't0' } catch { return 't0' }
  })
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  const activeTags = activeTab.tags
  const page = activeTab.page
  const patchActiveTab = (patch: Partial<{ tags: string; page: number }>) =>
    setTabs((ts) => ts.map((t) => (t.id === activeTabId ? { ...t, ...patch } : t)))
  const setActiveTags = (v: string) => patchActiveTab({ tags: v })
  const setPage = (v: number) => patchActiveTab({ page: v })
  const [jumpVal, setJumpVal] = useState('')
  const [sort, setSort] = useState('newest')
  const [rating, setRating] = useState('')
  const [siteFilter, setSiteFilter] = useState<Record<string, boolean>>(loadStoredSites)
  const toggleSite = (site: string) => {
    setSiteFilter((cur) => {
      const next = { ...cur, [site]: !cur[site] }
      // All three off would mean "show nothing" — treat it as a misclick and
      // bounce back to the one just clicked, which is what the user can see.
      if (!ALL_SITES.some((x) => next[x])) next[site] = true
      try { localStorage.setItem(SITES_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  const [lightbox, setLightbox] = useState<any>(null)
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [showSug, setShowSug] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout>>()
  const inputRef = useRef<HTMLInputElement>(null)

  // Sidebar state
  const [sidebarTags, setSidebarTags] = useState<any[]>([])
  const [sidebarFilter, setSidebarFilter] = useState('')
  const [sidebarSort, setSidebarSort] = useState<SidebarSort>('count')

  // Watched tags (download list) — maps tag_query → watched_tag id
  const [watchedMap, setWatchedMap] = useState<Map<string, number>>(new Map())
  const [trainingSets, setTrainingSets] = useState<any[]>([])
  // ONE selection, shown by both the page's set bar and the viewer's - picking in either changes both.
  const [selectedSet, setSelectedSet] = useState<string>(() => {
    try { return localStorage.getItem(SET_KEY) || '' } catch { return '' }
  })
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [tsBusy, setTsBusy] = useState(false)
  const [tsMsg, setTsMsg] = useState('')
  const [newSetName, setNewSetName] = useState('')
  const [setMemberIds, setSetMemberIds] = useState<Set<number>>(new Set())
  // Every set/batch a post is already in - so a post added to ANOTHER bulge size shows up too.
  const [allMembers, setAllMembers] = useState<Record<string, string[]>>({})

  // Lightbox zoom/pan
  const [zoom, setZoom] = useState(1)
  const [actualSize, setActualSize] = useState(false)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })
  const mediaRef = useRef<HTMLDivElement>(null)

  // Sidebar tags come from the browse response (watched tags + current-page
  // image tags), set in load() below — mirrors rule34.xxx's tag sidebar.

  // Load watched tags
  const loadWatched = useCallback(async () => {
    try {
      const data = await rule34Api.dashboard()
      const map = new Map<string, number>()
      for (const wt of data.watched_tags ?? []) {
        map.set(wt.tag_query, wt.id)
      }
      setWatchedMap(map)
    } catch {}
  }, [])

  useEffect(() => { void loadWatched() }, [loadWatched])

  const load = useCallback(async () => {
    const enabled = ALL_SITES.filter((x) => siteFilter[x])
    const data = await rule34Api.browser({
      tags: activeTags || undefined, page, per_page: 40, sort, rating: rating || undefined,
      sites: enabled.length === ALL_SITES.length ? undefined : enabled.join(','),
    })
    setD(data)
    setSidebarTags(data.sidebar_tags ?? [])
  }, [activeTags, page, sort, rating, siteFilter])

  useEffect(() => { void load() }, [load])

  // Reflect the active tab's filter in the search box when switching tabs.
  useEffect(() => {
    const t = tabs.find((x) => x.id === activeTabId)
    setSearch(t ? t.tags : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId])

  // A restored active-tab id may no longer exist — point it at the first tab.
  useEffect(() => {
    if (tabs.length && !tabs.some((t) => t.id === activeTabId)) setActiveTabId(tabs[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist tabs across refreshes / browser sessions until manually closed.
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
      localStorage.setItem(ACTIVE_KEY, activeTabId)
    } catch { /* ignore */ }
  }, [tabs, activeTabId])

  const activeSet = useMemo(() => new Set(activeTags.split(' ').filter(Boolean)), [activeTags])

  const filteredSidebar = useMemo(() => {
    const f = sidebarFilter.toLowerCase()
    const list = f ? sidebarTags.filter((t) => t.name.toLowerCase().includes(f)) : [...sidebarTags]
    const sortFn = sidebarSort === 'alpha'
      ? (a: any, b: any) => a.name.localeCompare(b.name)
      : (a: any, b: any) => b.post_count - a.post_count
    // Partition: watched tags first, then the rest — each group sorted independently
    const watched = list.filter((t) => watchedMap.has(t.name)).sort(sortFn)
    const rest = list.filter((t) => !watchedMap.has(t.name)).sort(sortFn)
    return [...watched, ...rest]
  }, [sidebarTags, sidebarFilter, sidebarSort, watchedMap])

  const doSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setActiveTags(search.trim())
    setPage(1)
    setShowSug(false)
  }

  const onInput = (val: string) => {
    setSearch(val)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      const last = val.split(' ').pop() || ''
      if (last.length >= 2) {
        setSuggestions(await rule34Api.searchTags(last))
        setShowSug(true)
      } else { setShowSug(false) }
    }, 300)
  }

  const pickSuggestion = (name: string) => {
    const parts = search.split(' ')
    parts[parts.length - 1] = name
    setSearch(parts.join(' ') + ' ')
    setShowSug(false)
    inputRef.current?.focus()
  }

  const toggleSidebarTag = (name: string) => {
    const tags = new Set(activeSet)
    if (tags.has(name)) {
      tags.delete(name)
    } else {
      tags.add(name)
    }
    const next = [...tags].join(' ')
    setSearch(next)
    setActiveTags(next)
    setPage(1)
  }

  const toggleWatched = async (name: string) => {
    const existingId = watchedMap.get(name)
    if (existingId) {
      await rule34Api.removeTag(String(existingId))
    } else {
      await rule34Api.addTag(name)
    }
    await loadWatched()
  }

  const removeChip = (name: string) => {
    const next = activeTags.split(' ').filter((t) => t !== name).join(' ')
    setSearch(next)
    setActiveTags(next)
    setPage(1)
  }

  const goToPage = (n: number) => {
    const tp = d?.total_pages ?? 1
    setPage(Math.min(Math.max(1, n), tp))
  }
  const doJump = () => {
    const n = parseInt(jumpVal, 10)
    if (!Number.isNaN(n)) goToPage(n)
    setJumpVal('')
  }

  const tabLabel = (t: { tags: string }) => (t.tags.trim() ? t.tags : 'All posts')
  const openTagInNewTab = (name: string) => {
    if (tabs.length >= MAX_TABS) { setTsMsg(`Max ${MAX_TABS} browse tabs — close one first.`); return }
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
    setTabs((ts) => [...ts, { id, tags: name, page: 1 }])
    setActiveTabId(id)
    setLightbox(null)
  }
  const newBlankTab = () => {
    if (tabs.length >= MAX_TABS) { setTsMsg(`Max ${MAX_TABS} browse tabs.`); return }
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
    setTabs((ts) => [...ts, { id, tags: '', page: 1 }])
    setActiveTabId(id)
  }
  const closeTab = (id: string) => {
    if (tabs.length <= 1) return
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (id === activeTabId) setActiveTabId(next[Math.max(0, idx - 1)].id)
  }

  const openLightbox = async (id: number) => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    const post = await rule34Api.post(id)
    const w = post?.width || 0, h = post?.height || 0
    const ratio = w && h ? Math.max(w / h, h / w) : 1
    setActualSize(ratio > 5) // extreme stitched strips open at native size, scrollable
    setLightbox(post)
  }

  const closeLightbox = () => {
    setLightbox(null)
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const zoomBy = (dir: 1 | -1) =>
    setZoom((z) => {
      const next = Math.max(0.25, Math.min(40, z + dir * 0.25 * z))
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })

  // Prev/next within the current page; rolls over to the adjacent page's edge
  // image at a boundary (and moves the grid with it).
  const navLightbox = async (dir: 1 | -1) => {
    if (!d || !lightbox) return
    const posts = (d.posts as any[]) || []
    const idx = posts.findIndex((p) => p.id === lightbox.id)
    if (idx < 0) return
    const ni = idx + dir
    if (ni >= 0 && ni < posts.length) { await openLightbox(posts[ni].id); return }
    const targetPage = page + dir
    if (targetPage < 1 || targetPage > (d.total_pages || 1)) return
    const data = await rule34Api.browser({ tags: activeTags || undefined, page: targetPage, per_page: 40, sort, rating: rating || undefined })
    if (data?.posts?.length) {
      setPage(targetPage)
      const target = dir === 1 ? data.posts[0] : data.posts[data.posts.length - 1]
      await openLightbox(target.id)
    }
  }

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return // let browser shortcuts (Back, page-zoom) through
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return // arrows belong to the set dropdown
      if (e.key === 'ArrowRight') { e.preventDefault(); void navLightbox(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); void navLightbox(-1) }
      else if (e.key === 'Escape') closeLightbox()
      else if ((e.key === 'a' || e.key === 'A') && lightbox.downloaded === 1 && selectedSet && !tsBusy && !setMemberIds.has(lightbox.id)) {
        e.preventDefault(); void addToSet([lightbox.id])
      }
      else if (!actualSize && (e.key === '+' || e.key === '=')) zoomBy(1)
      else if (!actualSize && e.key === '-') zoomBy(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, d, page, activeTags, sort, rating, actualSize, selectedSet, tsBusy, setMemberIds, trainingSets])

  const loadSets = useCallback(async () => {
    try { const r = await rule34Api.trainingSets(); setTrainingSets(r?.sets ?? []) } catch { /* ignore */ }
  }, [])
  useEffect(() => { void loadSets() }, [loadSets])
  useEffect(() => {
    try { localStorage.setItem(SET_KEY, selectedSet) } catch { /* ignore */ }
  }, [selectedSet])
  const loadMembers = useCallback(async (set: string) => {
    if (!set) { setSetMemberIds(new Set()); return }
    try { const r = await rule34Api.trainingSetMembers(set); setSetMemberIds(new Set<number>(r?.post_ids ?? [])) }
    catch { setSetMemberIds(new Set()) }
  }, [])
  useEffect(() => { void loadMembers(selectedSet) }, [selectedSet, loadMembers])
  const loadAllMembers = useCallback(async () => {
    try { const r = await rule34Api.trainingSetMembersAll(); setAllMembers(r?.members ?? {}) } catch { /* keep last */ }
  }, [])
  useEffect(() => { void loadAllMembers() }, [loadAllMembers])
  // click = toggle one, shift-click = range from the last clicked tile (same as the training browser)
  const pick = useRangeSelect<number>(setSelectedIds)
  const handleCreateSet = async () => {
    const name = newSetName.trim()
    if (!name) return
    const r = await rule34Api.createTrainingSet(name)
    if (r?.ok) { setNewSetName(''); await loadSets(); setSelectedSet(r.name); setTsMsg(`Created ${r.name}`) }
    else setTsMsg(r?.error || 'Create failed')
  }
  const addToSet = async (ids: number[]) => {
    if (!selectedSet) { setTsMsg('Select a training set first.'); return }
    if (!ids.length) return
    // Fail SAFE: gate unless the set is positively known to be a rule34 set.
    // If the set is missing from the loaded list or an older response lacks the
    // rule34 flag, still confirm — the failure this guards is silent and
    // unrecoverable (images land in someone else's training corpus).
    const setObj = trainingSets.find((s: any) => s.name === selectedSet)
    if (!setObj?.rule34) {
      const ok = await confirmStore.confirm({
        title: 'Not a rule34 set',
        message: `"${selectedSet}" wasn't created by the rule34 browser — it may be another training collection. Add ${ids.length} image${ids.length === 1 ? '' : 's'} to it anyway?`,
        confirmText: 'Add anyway',
      })
      if (!ok) return
    }
    setTsBusy(true)
    try {
      const r = await rule34Api.addToTrainingSet(selectedSet, ids)
      if (r?.ok) { setTsMsg(`Added ${r.added} to ${selectedSet}${r.skipped ? ` (${r.skipped} skipped)` : ''}`); setSelectedIds(new Set()); await loadSets(); void loadAllMembers(); await loadMembers(selectedSet) }
      else setTsMsg(r?.error || 'Add failed')
    } catch (e: any) { setTsMsg(String(e?.message || e)) }
    finally { setTsBusy(false) }
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    const delta = e.deltaY < 0 ? 0.15 : -0.15
    setZoom((z) => {
      const next = Math.max(0.25, Math.min(40, z + delta * z))
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return
    e.preventDefault()
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }

  const handleMouseUp = () => setDragging(false)

  const isVideo = (ext: string | null) => ext === 'mp4' || ext === 'webm'

  // Page controls, shown ABOVE and below the grid (Travis: on mobile the GPU Fleet bar covered the bottom set).
  const renderPager = (where: 'top' | 'bottom') => (!d || d.total_pages <= 1) ? null : (
              <div className={styles.pagination} data-where={where}>
                <button className={styles.btn} disabled={page <= 1} onClick={() => goToPage(1)}>« First</button>
                <button className={styles.btn} disabled={page <= 1} onClick={() => goToPage(page - 1)}>Prev</button>
                {(() => {
                  const tp = d.total_pages
                  const start = Math.max(1, page - 5)
                  const end = Math.min(tp, page + 5)
                  const nums: number[] = []
                  for (let i = start; i <= end; i++) nums.push(i)
                  return nums.map((n) => (
                    <button key={n} className={styles.btn} onClick={() => goToPage(n)}
                      style={n === page ? { fontWeight: 700, background: 'var(--primary, #3b82f6)', color: '#fff', borderColor: 'var(--primary, #3b82f6)' } : undefined}>{n}</button>
                  ))
                })()}
                <button className={styles.btn} disabled={page >= d.total_pages} onClick={() => goToPage(page + 1)}>Next</button>
                <button className={styles.btn} disabled={page >= d.total_pages} onClick={() => goToPage(d.total_pages)}>Last »</button>
                <span className={styles.dim}>{page} / {d.total_pages}</span>
                <input className={styles.jumpInput} type="number" min={1} max={d.total_pages}
                  placeholder="Go to…" value={jumpVal}
                  onChange={(e) => setJumpVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') doJump() }} />
                <button className={styles.btn} onClick={doJump}>Go</button>
              </div>
  )


  return (
    <div className={styles.browserLayout}>
      {/* ── Tag sidebar ── */}
      <div className={styles.sidebar}>
        <input
          className={styles.sidebarSearch}
          value={sidebarFilter}
          onChange={(e) => setSidebarFilter(e.target.value)}
          placeholder="Filter tags…"
        />
        <div className={styles.sidebarSortBar}>
          <button
            className={`${styles.sidebarSortBtn} ${sidebarSort === 'count' ? styles.sidebarSortBtnActive : ''}`}
            onClick={() => setSidebarSort('count')}
          >
            By Count
          </button>
          <button
            className={`${styles.sidebarSortBtn} ${sidebarSort === 'alpha' ? styles.sidebarSortBtnActive : ''}`}
            onClick={() => setSidebarSort('alpha')}
          >
            A–Z
          </button>
        </div>
        <div className={styles.sidebarList}>
          {filteredSidebar.map((t, i) => {
            const isWatched = watchedMap.has(t.name)
            // Insert a divider between the pinned watched group and the rest
            const prevIsWatched = i > 0 && watchedMap.has(filteredSidebar[i - 1].name)
            const showDivider = !isWatched && prevIsWatched
            return (
              <React.Fragment key={t.name}>
              {showDivider && <div className={styles.sidebarDivider} />}
              <div className={`${styles.sidebarItem} ${activeSet.has(t.name) ? styles.sidebarItemActive : ''}`}>
                <input
                  type="checkbox"
                  checked={activeSet.has(t.name)}
                  onChange={() => toggleSidebarTag(t.name)}
                  className={styles.sidebarCheck}
                  title="Filter by this tag"
                />
                <span className={`${styles.sidebarName} ${isWatched ? styles.sidebarNameWatched : ''}`}>{t.name}</span>
                <span className={styles.sidebarCount}>{t.post_count}</span>
                <input
                  type="checkbox"
                  checked={isWatched}
                  onChange={() => toggleWatched(t.name)}
                  className={styles.sidebarDownloadCheck}
                  title={isWatched ? 'Remove from download list' : 'Add to download list'}
                />
              </div>
              </React.Fragment>
            )
          })}
          {filteredSidebar.length === 0 && <span className={styles.dim} style={{ padding: 8 }}>No tags match</span>}
        </div>
      </div>

      {/* ── Main content ── */}
      <div className={styles.browserMain}>
        <div className={styles.browseTabs}>
          {tabs.map((t) => (
            <div key={t.id} className={`${styles.browseTab} ${t.id === activeTabId ? styles.browseTabActive : ''}`}
              onClick={() => setActiveTabId(t.id)} title={tabLabel(t)}>
              <span className={styles.browseTabLabel}>{tabLabel(t)}</span>
              {tabs.length > 1 && (
                <span className={styles.browseTabClose} onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}>×</span>
              )}
            </div>
          ))}
          <button type="button" className={styles.browseTabAdd} onClick={newBlankTab} title="New browse tab">+</button>
        </div>
        <form className={styles.searchBar} onSubmit={doSearch}>
          <div className={styles.searchWrap}>
            <input
              ref={inputRef}
              className={styles.searchInput}
              value={search}
              onChange={(e) => onInput(e.target.value)}
              onBlur={() => setTimeout(() => setShowSug(false), 200)}
              placeholder="Search tags…"
            />
            {showSug && suggestions.length > 0 && (
              <div className={styles.suggestions}>
                {suggestions.map((s: any) => (
                  <div key={s.name} className={styles.sugItem} onMouseDown={() => pickSuggestion(s.name)}>
                    <span>{s.name}</span><span className={styles.dim}>{s.post_count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button type="submit" className={styles.btnPrimary}>Search</button>
          <select className={styles.select} value={sort} onChange={(e) => { setSort(e.target.value); setPage(1) }}>
            <option value="newest">Newest</option>
            <option value="score">Top Score</option>
            <option value="recent_download">Recent DL</option>
          </select>
          <select className={styles.select} value={rating} onChange={(e) => { setRating(e.target.value); setPage(1) }}>
            <option value="">All</option>
            <option value="s">Safe</option>
            <option value="q">Questionable</option>
            <option value="e">Explicit</option>
          </select>
          {ALL_SITES.map((site) => (
            <button key={site} type="button"
              className={styles.btn}
              onClick={() => { toggleSite(site); setPage(1) }}
              title={`${siteFilter[site] ? 'Hide' : 'Show'} ${SITE_META[site].title} images`}
              style={{
                fontWeight: 700, fontSize: 11, padding: '3px 8px',
                background: siteFilter[site] ? SITE_META[site].color : 'transparent',
                color: siteFilter[site] ? '#fff' : 'var(--text-dim, #888)',
                border: `1px solid ${SITE_META[site].color}`,
                opacity: siteFilter[site] ? 1 : 0.6,
              }}>
              {SITE_META[site].label}
            </button>
          ))}
        </form>
        {d?.danbooru_tags_used && (
          <div className={styles.dim} style={{ margin: '2px 0', fontSize: 12 }}>
            ⓘ Danbooru limits searches to 2 tags — its scrapes for this query use only: {d.danbooru_tags_used.join(' ')}
          </div>
        )}

        {activeTags && (
          <div className={styles.chips}>
            {activeTags.split(' ').filter(Boolean).map((t) => (
              <span key={t} className={styles.chip} onClick={() => removeChip(t)}>{t} ×</span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', flexWrap: 'wrap' }}>
          <span className={styles.dim}>Training set:</span>
          <select className={styles.select} value={selectedSet} onChange={(e) => setSelectedSet(e.target.value)}>
            <option value="">— select a set —</option>
            {trainingSets.map((s: any) => (
              <option key={s.name} value={s.name}>{s.name} ({s.count})</option>
            ))}
          </select>
          <input
            className={styles.select}
            value={newSetName}
            onChange={(e) => setNewSetName(e.target.value)}
            placeholder="new set name\u2026"
            style={{ width: 140 }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleCreateSet() } }}
          />
          <button type="button" className={styles.btn} disabled={!newSetName.trim()} onClick={handleCreateSet}>Create</button>
          {selectedSet && <span className={styles.ok} style={{ fontWeight: 600 }}>→ {selectedSet}</span>}
          <span style={{ flex: 1 }} />
          <span className={styles.dim}>{selectedIds.size} selected</span>
          <button type="button" className={styles.btnPrimary} disabled={!selectedSet || selectedIds.size === 0 || tsBusy} onClick={() => addToSet([...selectedIds])}>
            {tsBusy ? 'Adding…' : `Add ${selectedIds.size} to set`}
          </button>
          <button type="button" className={styles.btn} disabled={selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}>Clear</button>
          {tsMsg && <span className={styles.dim}>{tsMsg}</span>}
        </div>

        {!d ? (
          <span className={styles.dim}>Loading…</span>
        ) : (
          <>
            <span className={styles.dim}>{d.total.toLocaleString()} posts</span>
            {renderPager('top')}
            <div className={styles.grid}>
              {d.posts.map((p: any, _i: number, all: any[]) => (
                <div key={p.id} className={styles.gridItem} onMouseDown={noShiftTextSelect}
                  onClick={(e) => { if (e.shiftKey) { pick(p.id, all.map((x) => x.id), true); return } openLightbox(p.id) }}
                  style={{
                    ...(selectedIds.has(p.id) ? { outline: '3px solid var(--primary, #3b82f6)', outlineOffset: -3 } : {}),
                  }}>
                  <img src={thumbUrl(p.id)} alt={`#${p.id}`} loading="lazy" />
                  <div className={styles.gridOverlay}>
                    <span>{p.score}</span>
                    {isVideo(p.file_ext) && <span className={styles.videoBadge}>VID</span>}
                  </div>
                  <div style={{ position: 'absolute', bottom: 4, right: 4, display: 'flex', gap: 2, zIndex: 2, pointerEvents: 'none' }}>
                    {(p.sources ?? [{ site: p.site ?? 'rule34' }]).map((src: any) => (
                      <span key={src.site} title={`${SITE_META[src.site]?.title ?? src.site} #${src.site_post_id ?? ''}`}
                        style={{ background: SITE_META[src.site]?.color ?? '#555', color: '#fff', borderRadius: 3,
                                 fontSize: 9, fontWeight: 700, padding: '1px 4px', lineHeight: '12px' }}>
                        {SITE_META[src.site]?.label ?? src.site}
                      </span>
                    ))}
                  </div>
                  {!setMemberIds.has(p.id) && (allMembers[String(p.id)]?.length ?? 0) > 0 && (
                    <>
                      <div style={{ position: 'absolute', inset: 0, border: '3px dashed #14b8a6', borderRadius: 'inherit', boxSizing: 'border-box', pointerEvents: 'none', zIndex: 3 }} />
                      <span title={`Already in: ${allMembers[String(p.id)].join(', ')}`} style={{ position: 'absolute', top: 4, right: 4, zIndex: 4, background: '#14b8a6', color: '#fff', borderRadius: 4, fontSize: 10, fontWeight: 700, padding: '1px 4px' }}>In other set</span>
                    </>
                  )}
                  {setMemberIds.has(p.id) && (
                    <>
                      <div style={{ position: 'absolute', inset: 0, border: '3px solid #22c55e', borderRadius: 'inherit', boxSizing: 'border-box', pointerEvents: 'none', zIndex: 3 }} />
                      <span title={`Already in ${selectedSet}`} style={{ position: 'absolute', top: 4, right: 4, zIndex: 4, background: '#22c55e', color: '#fff', borderRadius: 4, fontSize: 10, fontWeight: 700, padding: '1px 4px' }}>In set</span>
                    </>
                  )}
                  <input type="checkbox" checked={selectedIds.has(p.id)} onMouseDown={noShiftTextSelect}
                    onClick={(e) => { e.stopPropagation(); pick(p.id, all.map((x) => x.id), e.shiftKey) }}
                    onChange={() => { /* handled in onClick (needs shiftKey) */ }}
                    title="Select for training set - shift-click to select a range"
                    style={{ position: 'absolute', top: 4, left: 4, width: 18, height: 18, cursor: 'pointer', zIndex: 2 }} />
                </div>
              ))}
            </div>

            {renderPager('bottom')}
          </>
        )}
      </div>

      {/* ── Lightbox ── */}
      {lightbox && (
        <div className={styles.lightboxOverlay} onClick={closeLightbox}>
          <div className={styles.lightboxFull} onClick={(e) => e.stopPropagation()}>
            <button className={styles.lightboxClose} onClick={closeLightbox}>×</button>
            <button className={styles.lightboxNav} style={{ left: 12 }} onClick={() => void navLightbox(-1)} title="Previous image (←)">‹</button>
            <button className={styles.lightboxNav} style={{ right: 12 }} onClick={() => void navLightbox(1)} title="Next image (→)">›</button>
            <div
              ref={mediaRef}
              className={styles.lightboxMediaFull}
              onWheel={actualSize ? undefined : handleWheel}
              onMouseDown={actualSize ? undefined : handleMouseDown}
              onMouseMove={actualSize ? undefined : handleMouseMove}
              onMouseUp={actualSize ? undefined : handleMouseUp}
              onMouseLeave={actualSize ? undefined : handleMouseUp}
              style={{
                cursor: actualSize ? 'auto' : (zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default'),
                overflow: actualSize ? 'auto' : 'hidden',
                display: actualSize ? 'block' : 'flex',
                textAlign: actualSize ? 'center' : undefined,
              }}
            >
              {isVideo(lightbox.file_ext) ? (
                <video
                  src={fullUrl(lightbox.id)}
                  controls
                  autoPlay
                  style={{ maxWidth: '100%', maxHeight: '100%' }}
                />
              ) : (
                <img
                  src={fullUrl(lightbox.id)}
                  alt={`#${lightbox.id}`}
                  draggable={false}
                  style={actualSize ? {
                    maxWidth: 'none',
                    maxHeight: 'none',
                    display: 'inline-block',
                    verticalAlign: 'top',
                  } : {
                    transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
                    transformOrigin: 'center center',
                    transition: dragging ? 'none' : 'transform 0.1s ease-out',
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                  }}
                />
              )}
            </div>
            <div className={styles.zoomIndicator}>
              <button className={styles.btn} onClick={() => setActualSize((a) => !a)} style={{ padding: '2px 8px' }} title="Toggle actual size / fit">
                {actualSize ? 'Fit' : '1:1'}
              </button>
              {!actualSize && (
                <>
                  <button className={styles.btn} onClick={() => zoomBy(-1)} style={{ padding: '2px 8px' }}>−</button>
                  <span style={{ minWidth: 42, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                  <button className={styles.btn} onClick={() => zoomBy(1)} style={{ padding: '2px 8px' }}>+</button>
                  {zoom !== 1 && (
                    <button className={styles.btn} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} style={{ padding: '2px 6px' }}>Reset</button>
                  )}
                </>
              )}
            </div>
            <div className={styles.lightboxSetBar}>
              <select className={styles.select} value={selectedSet} title="Training set (same selection as the browser page)"
                onChange={(e) => { setSelectedSet(e.target.value); e.currentTarget.blur() }}>
                <option value="">— select a set —</option>
                {trainingSets.map((s: any) => (
                  <option key={s.name} value={s.name}>{s.name} ({s.count})</option>
                ))}
              </select>
              {setMemberIds.has(lightbox.id) ? (
                <span className={styles.ok} style={{ fontWeight: 600 }} title={`Already in ${selectedSet}`}>✓ In set</span>
              ) : (
                <button type="button" className={styles.btnPrimary}
                  disabled={!selectedSet || tsBusy || lightbox.downloaded !== 1}
                  title={lightbox.downloaded !== 1 ? 'Not downloaded yet - only downloaded images can go in a set'
                    : selectedSet ? `Add this image to ${selectedSet} (A)` : 'Pick a training set first'}
                  onClick={() => addToSet([lightbox.id])}>
                  {tsBusy ? 'Adding…' : '+ Add to set'}
                </button>
              )}
              {allMembers[String(lightbox.id)]?.some((n) => n !== selectedSet) && (
                <span className={styles.dim} title={allMembers[String(lightbox.id)].join(', ')}>
                  also in {allMembers[String(lightbox.id)].filter((n) => n !== selectedSet).join(', ')}
                </span>
              )}
              {tsMsg && <span className={styles.dim}>{tsMsg}</span>}
            </div>
            <div className={styles.lightboxInfoBar}>
              <div className={styles.lightboxMeta}>
                <span>ID: {lightbox.id}</span>
                <span>Score: {lightbox.score}</span>
                <span>Rating: {lightbox.rating}</span>
                {lightbox.width && lightbox.height && <span>{lightbox.width}×{lightbox.height}</span>}
                {(lightbox.sources ?? [{ site: lightbox.site ?? 'rule34', site_post_id: lightbox.site_post_id }]).map((src: any) => (
                  <span key={src.site} title={SITE_META[src.site]?.title ?? src.site}
                    style={{ background: SITE_META[src.site]?.color ?? '#555', color: '#fff', borderRadius: 3,
                             fontSize: 10, fontWeight: 700, padding: '1px 5px' }}>
                    {SITE_META[src.site]?.label ?? src.site} #{src.site_post_id}
                  </span>
                ))}
              </div>
              <div className={styles.lightboxTags}>
                {(() => {
                  const list: any[] = (lightbox.tag_list && lightbox.tag_list.length)
                    ? lightbox.tag_list
                    : (lightbox.tags ? lightbox.tags.split(' ').filter(Boolean).map((n: string) => ({ name: n, type: 0 })) : [])
                  // rule34 type codes: 1=artist, 3=copyright, 4=character, 5=meta, 0=general
                  const GROUPS = [
                    { key: 1, label: 'Artist', cls: styles.tagArtist },
                    { key: 4, label: 'Character', cls: styles.tagCharacter },
                    { key: 3, label: 'Copyright', cls: styles.tagCopyright },
                    { key: 5, label: 'Meta', cls: styles.tagMeta },
                    { key: 0, label: 'Tags', cls: '' },
                  ]
                  return GROUPS.map((g) => {
                    const items = list.filter((t) => (g.key === 0 ? (t.type ?? 0) === 0 : t.type === g.key))
                    if (!items.length) return null
                    return (
                      <div key={g.key} className={styles.tagGroup}>
                        <span className={styles.tagGroupLabel}>{g.label}</span>
                        {items.map((t) => (
                          <span key={t.name} className={`${styles.tagChip} ${g.cls}`} onClick={() => openTagInNewTab(t.name)} title="Open in a new browse tab">{t.name}</span>
                        ))}
                      </div>
                    )
                  })
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
