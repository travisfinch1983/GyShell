import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { upscalerApi, previewUrl } from './upscalerApi'
import styles from './Upscaler.module.scss'

/**
 * Upscaler · Compare — native port of templates/compare.html as a full-screen
 * OVERLAY (detail view from History/Browse, not a tab — per the ratified
 * layout). Side-by-side original/upscaled at full resolution with the
 * template's pan+zoom behavior: wheel zooms toward the cursor, pointer-drag
 * pans, optional sync between panes, reset. Ported to refs (no re-render per
 * pointer move).
 */

interface PanState { x: number; y: number; scale: number; drag: boolean; lx: number; ly: number }
const fresh = (): PanState => ({ x: 0, y: 0, scale: 1, drag: false, lx: 0, ly: 0 })

export const CompareOverlay: React.FC<{ assetId: string; onClose: () => void }> = ({ assetId, onClose }) => {
  const [entry, setEntry] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const syncRef = useRef(true)
  const [syncOn, setSyncOn] = useState(true)
  const state = useRef<{ left: PanState; right: PanState }>({ left: fresh(), right: fresh() })
  const imgL = useRef<HTMLImageElement | null>(null)
  const imgR = useRef<HTMLImageElement | null>(null)
  const wrapL = useRef<HTMLDivElement | null>(null)
  const wrapR = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    upscalerApi.compare(assetId).then((r) => setEntry(r.entry)).catch((e) => setErr(String((e as Error).message)))
  }, [assetId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const imgs = { left: imgL.current, right: imgR.current }
    const wraps = { left: wrapL.current, right: wrapR.current }
    if (!imgs.left || !imgs.right || !wraps.left || !wraps.right) return
    const apply = (side: 'left' | 'right') => {
      const s = state.current[side]
      imgs[side]!.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`
    }
    const cleanups: Array<() => void> = []
    for (const side of ['left', 'right'] as const) {
      const wrap = wraps[side]!
      const other = side === 'left' ? 'right' : 'left'
      const onWheel = (e: WheelEvent) => {
        e.preventDefault()
        const rect = wrap.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const s = state.current[side]
        const newScale = Math.max(0.1, Math.min(20, s.scale * (1 + -Math.sign(e.deltaY) * 0.15)))
        const sf = newScale / s.scale
        s.x = cx - (cx - s.x) * sf
        s.y = cy - (cy - s.y) * sf
        s.scale = newScale
        apply(side)
        if (syncRef.current) { Object.assign(state.current[other], { x: s.x, y: s.y, scale: s.scale }); apply(other) }
      }
      const onDown = (e: PointerEvent) => {
        e.preventDefault()
        const s = state.current[side]
        s.drag = true; s.lx = e.clientX; s.ly = e.clientY
        try { wrap.setPointerCapture(e.pointerId) } catch { /* ok */ }
      }
      const onMove = (e: PointerEvent) => {
        const s = state.current[side]
        if (!s.drag) return
        s.x += e.clientX - s.lx; s.y += e.clientY - s.ly
        s.lx = e.clientX; s.ly = e.clientY
        apply(side)
        if (syncRef.current) { Object.assign(state.current[other], { x: s.x, y: s.y }); apply(other) }
      }
      const onUp = () => { state.current[side].drag = false }
      const onDrag = (e: Event) => e.preventDefault()
      wrap.addEventListener('wheel', onWheel, { passive: false })
      wrap.addEventListener('pointerdown', onDown)
      wrap.addEventListener('pointermove', onMove)
      wrap.addEventListener('pointerup', onUp)
      wrap.addEventListener('pointercancel', onUp)
      wrap.addEventListener('dragstart', onDrag)
      cleanups.push(() => {
        wrap.removeEventListener('wheel', onWheel)
        wrap.removeEventListener('pointerdown', onDown)
        wrap.removeEventListener('pointermove', onMove)
        wrap.removeEventListener('pointerup', onUp)
        wrap.removeEventListener('pointercancel', onUp)
        wrap.removeEventListener('dragstart', onDrag)
      })
    }
    return () => cleanups.forEach((c) => c())
  }, [entry])

  const reset = () => {
    state.current.left = fresh()
    state.current.right = fresh()
    if (imgL.current) imgL.current.style.transform = ''
    if (imgR.current) imgR.current.style.transform = ''
  }

  return (
    <div className={styles.compareOverlay}>
      <div className={styles.headRow} style={{ padding: '10px 14px' }}>
        <b>{entry?.filename ?? assetId.slice(0, 12)}</b>
        {entry && (
          <span className={styles.dim}>
            original {(entry.src_mp ?? 0).toFixed(1)} MP — upscaled with <code className={styles.mono}>{entry.model ?? '?'}</code> in {(entry.elapsed_sec ?? 0).toFixed(1)}s
          </span>
        )}
        <span className={styles.spacer} />
        <button className={styles.btn} onClick={reset}>Reset view</button>
        <label className={styles.dim} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={syncOn} onChange={(e) => { setSyncOn(e.target.checked); syncRef.current = e.target.checked }} /> Sync pan + zoom
        </label>
        <button className={styles.btn} onClick={onClose}><X size={13} /> Close</button>
      </div>
      {err && <div className={styles.msgErr} style={{ padding: 16 }}>{err} (asset not processed / no upscaled version?)</div>}
      {entry && (
        <div className={styles.compareGrid}>
          <div className={styles.comparePane}>
            <div className={styles.paneLabel}>ORIGINAL</div>
            <div ref={wrapL} className={styles.panWrap}>
              <img ref={imgL} src={previewUrl(entry.asset_id, 'original')} alt="original" draggable={false} />
            </div>
          </div>
          <div className={styles.comparePane}>
            <div className={styles.paneLabel}>UPSCALED</div>
            <div ref={wrapR} className={styles.panWrap}>
              <img ref={imgR} src={previewUrl(entry.new_asset_id, 'original')} alt="upscaled" draggable={false} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
