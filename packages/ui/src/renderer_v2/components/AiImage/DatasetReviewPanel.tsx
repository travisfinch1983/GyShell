import React, { useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { Check, X, RefreshCw, Database, ChevronLeft, ChevronRight, MousePointerClick, Save, Undo2, Trash2 } from 'lucide-react'
import { datasetReviewStore as store, type TileRec } from '../../stores/DatasetReviewStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './DatasetReview.module.scss'

const Thumb: React.FC<{ t: TileRec; i: number }> = observer(({ t, i }) => (
  <div
    role="button" tabIndex={0}
    className={`${styles.cell} ${i === store.cursor ? styles.cellCursor : ''} ${styles['s_' + t.status] || ''}`}
    onClick={() => { store.cursor = i }}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { store.cursor = i; e.preventDefault() } }}
    title={`${t.tile}\n${t.polys} polygon(s)${t.sam != null ? ` · SAM ${t.sam.toFixed(2)}` : ''}`}>
    <img className={styles.thumb} src={store.imgUrl(t)} loading="lazy" alt="" />
    <span className={styles.cellTag}>{
      t.status === 'auto' ? '?' : t.status === 'approved' ? '✓'
      : t.status === 'manual' ? '✎' : t.status === 'unlabelled' ? '·' : '✕'
    }</span>
  </div>
))

export const DatasetReviewPanel: React.FC = observer(() => {
  useEffect(() => { void store.loadSets() }, [])

  // Keyboard is the point: a mouse round-trip per tile makes 700 reviews unbearable.
  const onKey = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    // A MODIFIED key belongs to the browser, not to us. Without this, Ctrl+Shift+R — hard
    // refresh — matched the bare 'r' shortcut and silently REJECTED whatever tile was open,
    // every time the user tried to reload the page.
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'a' || e.key === 'A') { void store.decideCurrent('approved'); e.preventDefault() }
    else if (e.key === 'r' || e.key === 'R') { void store.decideCurrent('rejected'); e.preventDefault() }
    else if (e.key === 's' || e.key === 'S') { void store.saveDraft(); e.preventDefault() }
    else if (e.key === 'ArrowRight') { store.move(1); e.preventDefault() }
    else if (e.key === 'ArrowLeft') { store.move(-1); e.preventDefault() }
  }, [])
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  const cur = store.current
  const set = store.sets.find((s) => s.name === store.active)

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <Database size={14} />
        <select className={styles.input} value={store.active} onChange={(e) => void store.open(e.target.value)}>
          {!store.sets.length && <option value="">no datasets found</option>}
          {store.sets.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.tiles} tiles</option>)}
        </select>
        <select className={styles.input} value={store.filter} onChange={(e) => store.setFilter(e.target.value)}>
          <option value="auto,unlabelled">needs review (all)</option>
          <option value="auto">seed masks to verify</option>
          <option value="unlabelled">no mask yet — draw one</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
          <option value="negative">negatives</option>
          <option value="">all</option>
        </select>
        <button className={styles.btn} onClick={() => void store.loadTiles()}>
          {store.loading ? <RefreshCw size={11} className={styles.spin} /> : <RefreshCw size={11} />} Reload
        </button>
        <span className={styles.spacer} />
        {set && (
          <span className={styles.counts}>
            <b>{store.pending}</b> to review · <span className={styles.ok}>{store.counts.approved || 0} ✓</span>
            {' · '}<span className={styles.bad}>{store.counts.rejected || 0} ✕</span>
            {' · '}{store.counts.negative || 0} neg
          </span>
        )}
        <button className={styles.btn} disabled={!store.tiles.some((t) => t.status === 'auto')}
          onClick={() => void store.approveVisible()}>Approve page</button>
      </div>

      {store.error && <div className={styles.errorBar}>{store.error}</div>}

      <div className={styles.body}>
        <div className={styles.grid}>
          {store.tiles.map((t, i) => <Thumb key={t.tile} t={t} i={i} />)}
          {!store.loading && !store.tiles.length && (
            <div className={styles.empty}>
              Nothing here. Run <code>forge.py annotate</code> on ai-epyc, or switch the filter.
            </div>
          )}
        </div>

        <div className={styles.side}>
          {cur ? (
            <>
              <div className={styles.sideHead}>
                <button className={styles.iconBtn} onClick={() => store.move(-1)}><ChevronLeft size={13} /></button>
                <span className={styles.pos}>{store.cursor + 1} / {store.tiles.length}</span>
                <button className={styles.iconBtn} onClick={() => store.move(1)}><ChevronRight size={13} /></button>
              </div>
              {/* Click the target to annotate. The overlay shows the seed mask; once you
                  click, the draft polygon from SAM is drawn on top so you can judge it
                  before saving. Shift+click subtracts a region. */}
              <div className={styles.canvasWrap}>
                <img className={styles.big} src={store.imgUrl(cur, store.points.length ? 'tiles' : 'overlays')} alt=""
                  onClick={(e) => {
                    const r = (e.target as HTMLImageElement).getBoundingClientRect()
                    void store.addPoint((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height,
                                        e.shiftKey ? 0 : 1)
                  }} />
                {!!store.draftPolys.length && (
                  <svg className={styles.overlaySvg} viewBox="0 0 1 1" preserveAspectRatio="none">
                    {store.draftPolys.map((p, i) => (
                      <polygon key={i} points={p.pts.map(([x, y]) => `${x},${y}`).join(' ')}
                        className={styles.draftPoly} />
                    ))}
                  </svg>
                )}
                {store.points.map((p, i) => (
                  <span key={i} className={`${styles.dot} ${p.label ? '' : styles.dotNeg}`}
                    style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />
                ))}
                {store.segmenting && <span className={styles.segBadge}>SAM…</span>}
              </div>
              <div className={styles.meta}>
                <div className={styles.fname} title={cur.tile}>{cur.tile}</div>
                <div>{cur.polys} polygon(s){cur.sam != null && <> · SAM {cur.sam.toFixed(2)}</>}</div>
                <div className={styles.dim} title={cur.src}>from {cur.src.split('/').pop()} @ y={cur.y}</div>
                <div>status: <b>{cur.status}</b>{cur.status === 'manual' && ' — hand-corrected mask saved'}</div>
              </div>
              <div className={styles.actions}>
                <button className={`${styles.btn} ${styles.btnOk}`} onClick={() => void store.decideCurrent('approved')}>
                  <Check size={13} /> Approve <kbd>A</kbd>
                </button>
                <button className={`${styles.btn} ${styles.btnBad}`} onClick={() => void store.decideCurrent('rejected')}>
                  <X size={13} /> Reject <kbd>R</kbd>
                </button>
                {cur.status !== 'auto' && cur.status !== 'unlabelled' && (
                  <button className={styles.btn} title="Clear this verdict and put the tile back in the review queue"
                    onClick={() => void store.resetCurrent()}>
                    <Undo2 size={13} /> Undo
                  </button>
                )}
              </div>
              {(store.draftPolys.length > 0 || store.points.length > 0) && (
                <div className={styles.actions}>
                  <button className={`${styles.btn} ${styles.btnOk}`} disabled={!store.draftPolys.length}
                    onClick={() => void store.saveDraft()}>
                    <Save size={13} /> Save mask <kbd>S</kbd>
                  </button>
                  <button className={styles.btn} onClick={() => store.clearDraft()}>
                    <Undo2 size={13} /> Clear
                  </button>
                </div>
              )}
              <div className={styles.actions}>
                <button className={styles.btn} title="Drop just this tile from the dataset"
                  onClick={() => void (async () => {
                    if (await confirmStore.confirm({ title: 'Remove tile',
                      message: `Remove ${cur.tile} from the dataset? The source image on disk is not touched.`,
                      confirmText: 'Remove', danger: true })) void store.removeCurrent(false)
                  })()}>
                  <Trash2 size={13} /> Remove tile
                </button>
                <button className={`${styles.btn} ${styles.btnBad}`}
                  title="Drop every tile cut from this source image — for a warped or otherwise unusable render"
                  onClick={() => void (async () => {
                    if (await confirmStore.confirm({ title: 'Remove image',
                      message: `Remove EVERY tile cut from ${cur.src.split('/').pop()}? The source image on disk is not touched.`,
                      confirmText: 'Remove image', danger: true })) void store.removeCurrent(true)
                  })()}>
                  <Trash2 size={13} /> Remove image
                </button>
              </div>
              <div className={styles.hint}>
                <MousePointerClick size={11} /> <b>Click the target</b> to draw a mask with SAM,
                then <b>Save mask</b>. That is the whole action — a saved mask counts as reviewed
                (<code>manual</code>) and exports; you do <b>not</b> also need Approve. Approve is
                only for accepting a seed mask unchanged. Shift+click removes a region.
                <br />
                <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>←</kbd><kbd>→</kbd> move.
                Decisions save immediately. Only tiles WITH a mask need a verdict — negatives
                are already valid backgrounds and export as empty label files.
              </div>
            </>
          ) : <div className={styles.empty}>Select a tile.</div>}
        </div>
      </div>
    </div>
  )
})
