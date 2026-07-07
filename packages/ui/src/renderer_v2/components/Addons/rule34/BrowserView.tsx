import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { rule34Api, thumbUrl, fullUrl } from './rule34Api'
import styles from './Rule34.module.scss'

type SidebarSort = 'count' | 'alpha'

export const BrowserView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [search, setSearch] = useState('')
  const [activeTags, setActiveTags] = useState('')
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState('newest')
  const [rating, setRating] = useState('')
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

  // Lightbox zoom/pan
  const [zoom, setZoom] = useState(1)
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
    const data = await rule34Api.browser({ tags: activeTags || undefined, page, per_page: 40, sort, rating: rating || undefined })
    setD(data)
    setSidebarTags(data.sidebar_tags ?? [])
  }, [activeTags, page, sort, rating])

  useEffect(() => { void load() }, [load])

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

  const addTag = (name: string) => {
    const tags = activeTags ? activeTags.split(' ') : []
    if (!tags.includes(name)) tags.push(name)
    const next = tags.join(' ')
    setSearch(next)
    setActiveTags(next)
    setPage(1)
    setLightbox(null)
  }

  const removeChip = (name: string) => {
    const next = activeTags.split(' ').filter((t) => t !== name).join(' ')
    setSearch(next)
    setActiveTags(next)
    setPage(1)
  }

  const openLightbox = async (id: number) => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setLightbox(await rule34Api.post(id))
  }

  const closeLightbox = () => {
    setLightbox(null)
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    const delta = e.deltaY < 0 ? 0.15 : -0.15
    setZoom((z) => {
      const next = Math.max(0.25, Math.min(12, z + delta * z))
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
        </form>

        {activeTags && (
          <div className={styles.chips}>
            {activeTags.split(' ').filter(Boolean).map((t) => (
              <span key={t} className={styles.chip} onClick={() => removeChip(t)}>{t} ×</span>
            ))}
          </div>
        )}

        {!d ? (
          <span className={styles.dim}>Loading…</span>
        ) : (
          <>
            <span className={styles.dim}>{d.total.toLocaleString()} posts</span>
            <div className={styles.grid}>
              {d.posts.map((p: any) => (
                <div key={p.id} className={styles.gridItem} onClick={() => openLightbox(p.id)}>
                  <img src={thumbUrl(p.id)} alt={`#${p.id}`} loading="lazy" />
                  <div className={styles.gridOverlay}>
                    <span>{p.score}</span>
                    {isVideo(p.file_ext) && <span className={styles.videoBadge}>VID</span>}
                  </div>
                </div>
              ))}
            </div>

            {d.total_pages > 1 && (
              <div className={styles.pagination}>
                <button className={styles.btn} disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
                <span className={styles.dim}>{page} / {d.total_pages}</span>
                <button className={styles.btn} disabled={page >= d.total_pages} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Lightbox ── */}
      {lightbox && (
        <div className={styles.lightboxOverlay} onClick={closeLightbox}>
          <div className={styles.lightboxFull} onClick={(e) => e.stopPropagation()}>
            <button className={styles.lightboxClose} onClick={closeLightbox}>×</button>
            <div
              ref={mediaRef}
              className={styles.lightboxMediaFull}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{ cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
            >
              {isVideo(lightbox.file_ext) ? (
                <video
                  src={lightbox.downloaded === 1 ? fullUrl(lightbox.id) : lightbox.file_url}
                  controls
                  autoPlay
                  style={{ maxWidth: '100%', maxHeight: '100%' }}
                />
              ) : (
                <img
                  src={lightbox.downloaded === 1 ? fullUrl(lightbox.id) : (lightbox.sample_url || lightbox.file_url)}
                  alt={`#${lightbox.id}`}
                  draggable={false}
                  style={{
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
            {zoom !== 1 && (
              <div className={styles.zoomIndicator}>
                {Math.round(zoom * 100)}%
                <button className={styles.btn} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} style={{ marginLeft: 6, padding: '2px 6px' }}>Reset</button>
              </div>
            )}
            <div className={styles.lightboxInfoBar}>
              <div className={styles.lightboxMeta}>
                <span>ID: {lightbox.id}</span>
                <span>Score: {lightbox.score}</span>
                <span>Rating: {lightbox.rating}</span>
                {lightbox.width && lightbox.height && <span>{lightbox.width}×{lightbox.height}</span>}
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
                          <span key={t.name} className={`${styles.tagChip} ${g.cls}`} onClick={() => addTag(t.name)}>{t.name}</span>
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
