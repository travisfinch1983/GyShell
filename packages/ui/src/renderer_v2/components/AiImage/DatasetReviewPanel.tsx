import React, { useEffect, useCallback, useState, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { Check, X, RefreshCw, Database, ChevronLeft, ChevronRight, MousePointerClick, Save, Undo2, Trash2, Ban, Tags, Maximize2, Minimize2, ZoomIn, ZoomOut, Plus } from 'lucide-react'
import { datasetReviewStore as store, type TileRec } from '../../stores/DatasetReviewStore'
import { confirmStore } from '../../stores/confirmStore'
import { AutoCaptionModal } from './AutoCaptionModal'
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
  const [capOpen, setCapOpen] = useState(false)
  // Side pane width is draggable and remembered: a 380px preview of a 768px tile renders at
  // under half scale, which makes clicking a small mask a guess.
  const [sideW, setSideW] = useState(() => Number(localStorage.getItem('dsReviewSideW')) || 380)
  const [focus, setFocus] = useState(false)     // full-width editing view
  const [zoom, setZoom] = useState(1)           // multiplies the rendered image width
  const dragRef = useRef<{ x: number; w: number } | null>(null)

  const onDragStart = (e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX, w: sideW }
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return
      // dragging LEFT widens the right-hand pane
      const w = Math.min(1400, Math.max(280, dragRef.current.w + (dragRef.current.x - ev.clientX)))
      setSideW(w)
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      setSideW((w) => { localStorage.setItem('dsReviewSideW', String(w)); return w })
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    e.preventDefault()
  }

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
    else if (e.key === 'f' || e.key === 'F') { setFocus((v) => !v); e.preventDefault() }
    else if (e.key === '+' || e.key === '=') { setZoom((z) => Math.min(6, z * 1.25)); e.preventDefault() }
    else if (e.key === '-' || e.key === '_') { setZoom((z) => Math.max(1, z / 1.25)); e.preventDefault() }
    else if (e.key === 'n' || e.key === 'N') { void store.decideCurrent('negative'); e.preventDefault() }
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
            <b>{store.pending}</b> to review · <span className={styles.ok}>{(store.counts.approved || 0) + (store.counts.manual || 0)} ✓</span>
            {' · '}{store.counts.negative || 0} bg
            {' · '}<span className={styles.bad}>{store.counts.rejected || 0} ✕</span>
          </span>
        )}
        <span className={styles.counts}>showing <b>{store.tiles.length}</b> of {store.total}</span>
        <button className={styles.btn} disabled={!store.tiles.some((t) => t.status === 'auto')}
          title="Approve every seed mask currently shown"
          onClick={() => void store.approveVisible()}>Approve all shown</button>
        <button className={styles.btn} disabled={!store.active || !store.tiles.length}
          title="Run the same auto-captioner used by Training Images over the tiles shown here. Captions do NOT affect training — YOLO reads masks, not text — they are for seeing what a tile CONTAINS so you can judge coverage."
          onClick={() => setCapOpen(true)}><Tags size={12} /> Caption tiles…</button>
      </div>

      {capOpen && (
        <AutoCaptionModal
          onClose={() => setCapOpen(false)}
          path={`_datasets/${store.active}/tiles`}
          files={store.tiles.map((t) => t.tile)}
          label={`${store.tiles.length} tile${store.tiles.length === 1 ? '' : 's'} in ${store.active}`}
        />
      )}
      {store.error && <div className={styles.errorBar}>{store.error}</div>}

      <div className={styles.body}
        style={{ gridTemplateColumns: focus ? '1fr' : `1fr 6px ${sideW}px` }}>
        <div className={styles.grid} style={focus ? { display: 'none' } : undefined}>
          {store.tiles.map((t, i) => <Thumb key={t.tile} t={t} i={i} />)}
          {!store.loading && !store.tiles.length && (
            <div className={styles.empty}>
              Nothing here. Run <code>forge.py annotate</code> on ai-epyc, or switch the filter.
            </div>
          )}
        </div>

        <div className={styles.dragBar} onMouseDown={onDragStart} title="Drag to resize"
          style={focus ? { display: 'none' } : undefined} />
        <div className={styles.side}>
          {cur ? (
            <>
              <div className={styles.sideHead}>
                <button className={styles.iconBtn} onClick={() => store.move(-1)}><ChevronLeft size={13} /></button>
                <span className={styles.pos}>{store.cursor + 1} / {store.tiles.length}</span>
                <button className={styles.iconBtn} onClick={() => store.move(1)}><ChevronRight size={13} /></button>
                <span className={styles.spacer} />
                <button className={styles.iconBtn} title="Zoom out (-)" onClick={() => setZoom((z) => Math.max(1, z / 1.25))}><ZoomOut size={13} /></button>
                <span className={styles.pos}>{Math.round(zoom * 100)}%</span>
                <button className={styles.iconBtn} title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(6, z * 1.25))}><ZoomIn size={13} /></button>
                <button className={styles.iconBtn} title={focus ? 'Back to the grid (F)' : 'Expand to full width (F)'}
                  onClick={() => setFocus((v) => !v)}>{focus ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
              </div>
              {/* Click the target to annotate. The overlay shows the seed mask; once you
                  click, the draft polygon from SAM is drawn on top so you can judge it
                  before saving. Shift+click subtracts a region. */}
              <div className={styles.canvasWrap} style={{ width: `${zoom * 100}%` }}>
                <img className={styles.big} src={store.imgUrl(cur, store.points.length ? 'tiles' : 'overlays')} alt=""
                  onClick={(e) => {
                    const r = (e.target as HTMLImageElement).getBoundingClientRect()
                    void store.addPoint((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height,
                                        e.shiftKey ? 0 : 1)
                  }} />
                {!!store.allDraft.length && (
                  // pointer-events sit on the polygons only: clicking a REGION deletes it,
                  // clicking anywhere else falls through to the image and adds a SAM point
                  <svg className={styles.overlaySvg} viewBox="0 0 1 1" preserveAspectRatio="none">
                    {store.allDraft.map((p, i) => (
                      <polygon key={i} points={p.pts.map(([x, y]) => `${x},${y}`).join(' ')}
                        className={`${styles.draftPoly} ${i < store.keptPolys.length ? styles.keptPoly : ''}`}
                        onClick={(e) => { e.stopPropagation(); store.removePoly(i) }}>
                        <title>click to remove this region</title>
                      </polygon>
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
                <button className={styles.btn} title="No target in this tile — keep it as a training background (empty label). This is what suppresses false positives; do NOT reject these."
                  onClick={() => void store.decideCurrent('negative')}>
                  <Ban size={13} /> Background <kbd>N</kbd>
                </button>
                <button className={`${styles.btn} ${styles.btnBad}`} title="Discard this tile entirely — it is not usable either way" onClick={() => void store.decideCurrent('rejected')}>
                  <X size={13} /> Discard <kbd>R</kbd>
                </button>
                {cur.status !== 'auto' && cur.status !== 'unlabelled' && (
                  <button className={styles.btn} title="Clear this verdict and put the tile back in the review queue"
                    onClick={() => void store.resetCurrent()}>
                    <Undo2 size={13} /> Undo
                  </button>
                )}
              </div>
              {(store.allDraft.length > 0 || store.points.length > 0) && (
                <>
                  <div className={styles.actions}>
                    <button className={`${styles.btn} ${styles.btnOk}`} disabled={!store.allDraft.length}
                      onClick={() => void store.saveDraft()}>
                      <Save size={13} /> Save mask <kbd>S</kbd>
                    </button>
                    <button className={styles.btn} disabled={!store.draftPolys.length}
                      title="Lock in these regions and start a fresh click set — the next click ADDS instead of replacing"
                      onClick={() => store.keepAndContinue()}>
                      <Plus size={13} /> Add region
                    </button>
                  </div>
                  <div className={styles.actions}>
                    <button className={styles.btn} disabled={!store.points.length}
                      title="Remove the last click and re-run SAM" onClick={() => void store.undoPoint()}>
                      <Undo2 size={13} /> Undo click
                    </button>
                    <button className={styles.btn} onClick={() => store.clearDraft()}>
                      <X size={13} /> Clear all
                    </button>
                  </div>
                </>
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
                <label className={styles.chkLine}>
                  <input type="checkbox" checked={store.singleRegion}
                    onChange={(e) => { store.singleRegion = e.target.checked }} />
                  single region per click (uncheck to allow up to 4)
                </label>
                <MousePointerClick size={11} /> <b>Click the target</b>, then <b>Save mask</b> —
                that is the whole action; a saved mask counts as reviewed and you do <b>not</b>
                also need Approve. <b>Click any green region to delete it.</b> Shift+click
                subtracts, <b>Undo click</b> steps back one, and <b>Add region</b> locks in what
                you have so the next click adds instead of replacing.
                <br />
                <b>No target in this tile?</b> Press <kbd>N</kbd> — it becomes a training
                background (empty label), which is what teaches the model where the target is
                NOT. Do <b>not</b> Discard those; discarding throws the signal away.
                <br />
                <kbd>A</kbd> approve · <kbd>N</kbd> background · <kbd>R</kbd> discard ·
                <kbd>S</kbd> save mask · <kbd>←</kbd><kbd>→</kbd> move.
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
