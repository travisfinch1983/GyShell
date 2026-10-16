import React, { useEffect, useState, useCallback } from 'react'
import { pixivApi, thumbUrl, fullUrl } from './pixivApi'
import styles from '../rule34/Rule34.module.scss'

export const PixivBrowserView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState('newest')
  const [restrict, setRestrict] = useState('')
  const [artistId, setArtistId] = useState<number | null>(null)
  const [lightbox, setLightbox] = useState<any>(null)
  const [lbPage, setLbPage] = useState(0)

  const load = useCallback(async () => {
    setD(await pixivApi.browser({ q: applied || undefined, page, sort, restrict: restrict || undefined, artist_id: artistId ?? undefined }))
  }, [applied, page, sort, restrict, artistId])
  useEffect(() => { void load() }, [load])

  const open = async (id: number) => {
    setLbPage(0)
    setLightbox(await pixivApi.post(id))
  }

  const nav = async (dir: number) => {
    if (!d || !lightbox) return
    const ids = d.posts.map((p: any) => p.id)
    const i = ids.indexOf(lightbox.id)
    const next = ids[i + dir]
    if (next !== undefined) await open(next)
  }

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
      else if (e.key === 'ArrowLeft') void nav(-1)
      else if (e.key === 'ArrowRight') void nav(1)
      else if (e.key === 'ArrowUp') setLbPage((p) => Math.max(0, p - 1))
      else if (e.key === 'ArrowDown') setLbPage((p) => Math.min((lightbox.pages?.length ?? 1) - 1, p + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, d])

  return (
    <div className={styles.view}>
      <form className={styles.searchBar} onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); setArtistId(null); setPage(1) }}>
        <input className={styles.searchInput} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search title / tags (JP or translated) / artist…" />
        <button type="submit" className={styles.btnPrimary}>Search</button>
        <select className={styles.select} value={sort} onChange={(e) => { setSort(e.target.value); setPage(1) }}>
          <option value="newest">Newest</option>
          <option value="bookmarks">Bookmarks</option>
          <option value="views">Views</option>
        </select>
        <select className={styles.select} value={restrict} onChange={(e) => { setRestrict(e.target.value); setPage(1) }}>
          <option value="">All</option>
          <option value="all-ages">All-ages</option>
          <option value="r18">R-18</option>
        </select>
        {artistId && (
          <span className={styles.chip} onClick={() => { setArtistId(null); setPage(1) }}>artist #{artistId} ×</span>
        )}
      </form>

      {!d ? <span className={styles.dim}>Loading…</span> : (
        <>
          <span className={styles.dim}>{d.total.toLocaleString()} illusts</span>
          <div className={styles.grid}>
            {d.posts.map((p: any) => (
              <div key={p.id} className={styles.gridItem} onClick={() => void open(p.id)}>
                <img src={thumbUrl(p.id)} alt={p.title} loading="lazy" />
                <div className={styles.gridOverlay}>
                  <span>♥ {p.bookmarks}</span>
                  {p.page_count > 1 && <span className={styles.videoBadge}>{p.page_count}p</span>}
                  {p.type === 'ugoira' && <span className={styles.videoBadge}>UGOIRA</span>}
                </div>
                {p.x_restrict >= 1 && (
                  <span style={{ position: 'absolute', top: 4, right: 4, background: '#ef4444', color: '#fff', borderRadius: 3, fontSize: 9, fontWeight: 700, padding: '1px 4px' }}>R-18{p.x_restrict > 1 ? 'G' : ''}</span>
                )}
              </div>
            ))}
          </div>
          <div className={styles.headRow} style={{ marginTop: 8 }}>
            <button className={styles.btn} disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
            <span className={styles.dim}>{page} / {d.total_pages}</span>
            <button className={styles.btn} disabled={page >= d.total_pages} onClick={() => setPage(page + 1)}>Next ›</button>
          </div>
        </>
      )}

      {lightbox && (
        <div className={styles.lightboxOverlay} onClick={() => setLightbox(null)}>
          <div className={styles.lightboxFull} onClick={(e) => e.stopPropagation()}>
            <button className={styles.lightboxClose} onClick={() => setLightbox(null)}>×</button>
            <button className={styles.lightboxNav} style={{ left: 12 }} onClick={() => void nav(-1)} title="Previous illust (←)">‹</button>
            <button className={styles.lightboxNav} style={{ right: 12 }} onClick={() => void nav(1)} title="Next illust (→)">›</button>
            <div className={styles.lightboxMediaFull} style={{ display: 'flex' }}>
              <img src={fullUrl(lightbox.id, lightbox.pages?.[lbPage]?.page_no ?? 0)} alt={lightbox.title}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} draggable={false} />
            </div>
            {(lightbox.pages?.length ?? 0) > 1 && (
              <div className={styles.zoomIndicator}>
                <button className={styles.btn} disabled={lbPage <= 0} onClick={() => setLbPage(lbPage - 1)} style={{ padding: '2px 8px' }}>↑</button>
                <span style={{ minWidth: 60, textAlign: 'center' }}>page {lbPage + 1}/{lightbox.pages.length}</span>
                <button className={styles.btn} disabled={lbPage >= lightbox.pages.length - 1} onClick={() => setLbPage(lbPage + 1)} style={{ padding: '2px 8px' }}>↓</button>
              </div>
            )}
            <div className={styles.lightboxInfoBar}>
              <div className={styles.lightboxMeta}>
                <span>{lightbox.title}</span>
                <span className={styles.chip} title="Browse this artist"
                  onClick={() => { setArtistId(lightbox.artist_id); setApplied(''); setQ(''); setPage(1); setLightbox(null) }}>
                  {lightbox.artist_name}
                </span>
                <span>♥ {lightbox.bookmarks}</span>
                <span className={styles.dim}>pixiv #{lightbox.id}</span>
                {lightbox.type === 'ugoira' && <span className={styles.dim}>ugoira (animation frames stored as zip)</span>}
              </div>
              <div className={styles.lightboxTags}>
                {(lightbox.tag_list ?? []).map((t: any) => (
                  <span key={t.name} className={styles.tagChip}
                    onClick={() => { setQ(t.name); setApplied(t.name); setArtistId(null); setPage(1); setLightbox(null) }}
                    title={t.translated || t.name}>
                    {t.name}{t.translated ? ` · ${t.translated}` : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
