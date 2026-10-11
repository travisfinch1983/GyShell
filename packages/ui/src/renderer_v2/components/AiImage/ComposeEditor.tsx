import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { trainingImagesStore as store, igImage, igThumb, type IgImage } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

// ── Compose: several images on one canvas ────────────────────────────────────────────
// For before/after pairs and the like: each picked image becomes a LAYER that can be moved,
// scaled, cropped and re-ordered on a canvas of any size; Save renders the canvas at full output
// resolution in the browser and writes it beside the first source as a new PNG. Sources are never
// touched.
//
// Coordinates: everything in state is OUTPUT pixels (canvas) or SOURCE pixels (a layer's crop).
// `view` is display-px per output-px and only exists for drawing + mouse maths.

type Crop = { x: number; y: number; w: number; h: number }          // source px
type Layer = { id: number; rel: string; name: string; natW: number; natH: number; crop: Crop; x: number; y: number; scale: number; flip: boolean }
type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'
type Drag =
  | { kind: 'move'; id: number; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'scale'; id: number; h: Handle; ax: number; ay: number }
  | { kind: 'crop'; id: number; h: Handle; sx: number; sy: number; o: Layer }
  | null

const SIZE_PRESETS = [
  { label: '1024 × 1024', w: 1024, h: 1024 }, { label: '2048 × 1024 (side by side)', w: 2048, h: 1024 },
  { label: '1024 × 2048 (stacked)', w: 1024, h: 2048 }, { label: '1216 × 832', w: 1216, h: 832 }, { label: '832 × 1216', w: 832, h: 1216 },
  { label: '1536 × 1024', w: 1536, h: 1024 }, { label: '1024 × 1536', w: 1024, h: 1536 },
]
const MIN_SRC = 8   // smallest crop side, source px
let nextId = 1

const lw = (l: Layer) => l.crop.w * l.scale
const lh = (l: Layer) => l.crop.h * l.scale

const loadImg = (src: string) => new Promise<HTMLImageElement>((ok, bad) => {
  const im = new Image()
  im.onload = () => ok(im); im.onerror = () => bad(new Error(`could not load ${src}`))
  im.src = src
})

export const ComposeEditor: React.FC<{ rels: string[]; pool: IgImage[]; onClose: () => void; onSaved: () => void }> = ({ rels, pool, onClose, onSaved }) => {
  const [layers, setLayers] = useState<Layer[]>([])
  const [sel, setSel] = useState<number | null>(null)
  const [cropMode, setCropMode] = useState(false)
  const [W, setW] = useState(2048); const [H, setH] = useState(1024)
  const [bg, setBg] = useState('#ffffff')
  const [gap, setGap] = useState(0)
  const [name, setName] = useState(() => {
    const st = (rels[0] || 'compose').split('/').pop()!.replace(/\.[^.]+$/, '')
    return `${st}-compose`
  })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState(0.5)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<Drag>(null)
  const imgs = useRef<Map<string, HTMLImageElement>>(new Map())
  // live copies for the window listeners (state closures would be stale)
  const L = useRef(layers); L.current = layers
  const V = useRef(view); V.current = view

  const fitView = useCallback(() => {
    const r = stageRef.current?.getBoundingClientRect()
    if (!r) return
    setView(Math.max(0.02, Math.min((r.width - 40) / W, (r.height - 40) / H, 4)))
  }, [W, H])
  useLayoutEffect(() => { fitView() }, [fitView])
  useEffect(() => { const f = () => fitView(); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [fitView])

  // ---- layout helpers (pure: take layers, return layers) ----
  const sideBySide = (ls: Layer[], vertical: boolean): { ls: Layer[]; w: number; h: number } => {
    if (!ls.length) return { ls, w: W, h: H }
    // common height (or width, stacked) = the smallest crop's, so nothing is upscaled
    const t = Math.min(...ls.map((l) => (vertical ? l.crop.w : l.crop.h)))
    let at = 0
    const out = ls.map((l) => {
      const scale = t / (vertical ? l.crop.w : l.crop.h)
      const n = { ...l, scale, x: vertical ? 0 : at, y: vertical ? at : 0 }
      at += (vertical ? lh(n) : lw(n)) + gap
      return n
    })
    const len = Math.round(at - gap)
    return vertical ? { ls: out, w: Math.round(t), h: len } : { ls: out, w: len, h: Math.round(t) }
  }
  const applyLayout = (vertical: boolean, ls = L.current) => {
    const r = sideBySide(ls, vertical)
    setLayers(r.ls); setW(r.w); setH(r.h)
  }
  /** Shrink/grow the canvas to the layers' bounding box (arrange freely, then trim). */
  const fitCanvas = () => {
    const ls = L.current
    if (!ls.length) return
    const x0 = Math.min(...ls.map((l) => l.x)), y0 = Math.min(...ls.map((l) => l.y))
    const x1 = Math.max(...ls.map((l) => l.x + lw(l))), y1 = Math.max(...ls.map((l) => l.y + lh(l)))
    setLayers(ls.map((l) => ({ ...l, x: l.x - x0, y: l.y - y0 })))
    setW(Math.max(1, Math.round(x1 - x0))); setH(Math.max(1, Math.round(y1 - y0)))
  }
  /** Scale the whole composition (canvas + every layer) so the canvas has this size's longest side. */
  const resizeAll = (k: number) => {
    setLayers(L.current.map((l) => ({ ...l, x: l.x * k, y: l.y * k, scale: l.scale * k })))
    setW((w) => Math.max(1, Math.round(w * k))); setH((h) => Math.max(1, Math.round(h * k)))
  }

  const addImages = useCallback(async (list: string[], layoutAfter: boolean) => {
    const added: Layer[] = []
    for (const rel of list) {
      try {
        let im = imgs.current.get(rel)
        if (!im) { im = await loadImg(igImage(rel)); imgs.current.set(rel, im) }
        added.push({ id: nextId++, rel, name: rel.split('/').pop() || rel, natW: im.naturalWidth, natH: im.naturalHeight,
          crop: { x: 0, y: 0, w: im.naturalWidth, h: im.naturalHeight }, x: 0, y: 0, scale: 1, flip: false })
      } catch (e: any) { setMsg(String(e?.message || e)) }
    }
    if (!added.length) return
    if (layoutAfter) applyLayout(false, [...L.current, ...added])
    else {
      // dropped in later: fit inside the canvas, centred, on top
      const n = added.map((l) => { const s = Math.min(1, (W * 0.6) / l.natW, (H * 0.6) / l.natH); return { ...l, scale: s, x: (W - l.natW * s) / 2, y: (H - l.natH * s) / 2 } })
      setLayers([...L.current, ...n])
    }
    setSel(added[added.length - 1].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W, H, gap])

  useEffect(() => { void addImages(rels, true) /* initial: side by side */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const upd = (id: number, f: (l: Layer) => Layer) => setLayers((ls) => ls.map((l) => (l.id === id ? f(l) : l)))
  const cur = layers.find((l) => l.id === sel) || null

  // ---- mouse ----
  const pt = (e: MouseEvent | React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / V.current, y: (e.clientY - r.top) / V.current }
  }
  const downLayer = (e: React.MouseEvent, l: Layer) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    setSel(l.id)
    const p = pt(e)
    drag.current = { kind: 'move', id: l.id, sx: p.x, sy: p.y, ox: l.x, oy: l.y }
  }
  const downHandle = (e: React.MouseEvent, l: Layer, h: Handle) => {
    e.stopPropagation(); e.preventDefault()
    const p = pt(e)
    if (cropMode) drag.current = { kind: 'crop', id: l.id, h, sx: p.x, sy: p.y, o: { ...l, crop: { ...l.crop } } }
    else drag.current = { kind: 'scale', id: l.id, h, ax: h.includes('w') ? l.x + lw(l) : l.x, ay: h.includes('n') ? l.y + lh(l) : l.y }
  }
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current
      if (!d) return
      const p = pt(e)
      if (d.kind === 'move') {
        let nx = d.ox + (p.x - d.sx), ny = d.oy + (p.y - d.sy)
        // snap to canvas edges + other layers' edges (8 display px)
        const l = L.current.find((q) => q.id === d.id)
        if (l && !e.altKey) {
          const tol = 8 / V.current, w = lw(l), h = lh(l)
          const xs = [0, W, ...L.current.filter((q) => q.id !== d.id).flatMap((q) => [q.x, q.x + lw(q)])]
          const ys = [0, H, ...L.current.filter((q) => q.id !== d.id).flatMap((q) => [q.y, q.y + lh(q)])]
          for (const t of xs) { if (Math.abs(nx - t) < tol) { nx = t; break } if (Math.abs(nx + w - t) < tol) { nx = t - w; break } }
          for (const t of ys) { if (Math.abs(ny - t) < tol) { ny = t; break } if (Math.abs(ny + h - t) < tol) { ny = t - h; break } }
        }
        upd(d.id, (q) => ({ ...q, x: nx, y: ny }))
      } else if (d.kind === 'scale') {
        upd(d.id, (q) => {
          // keep aspect: scale from the opposite corner, whichever axis the pointer moved further on
          const sx = Math.abs(p.x - d.ax) / q.crop.w, sy = Math.abs(p.y - d.ay) / q.crop.h
          const s = Math.max(MIN_SRC / Math.min(q.crop.w, q.crop.h), Math.max(sx, sy))
          const w = q.crop.w * s, h = q.crop.h * s
          return { ...q, scale: s, x: d.h.includes('w') ? d.ax - w : d.ax, y: d.h.includes('n') ? d.ay - h : d.ay }
        })
      } else {
        // crop: move one or two edges; the picture itself stays where it is on the canvas
        const o = d.o, s = o.scale
        let dx = (p.x - d.sx) / s, dy = (p.y - d.sy) / s
        if (o.flip) dx = -dx   // a flipped layer's left edge on screen is the source's right edge
        const c = { ...o.crop }
        const hE = o.flip ? d.h.replace(/[ew]/, (m) => (m === 'e' ? 'w' : 'e')) : d.h
        if (hE.includes('w')) { const nx = Math.max(0, Math.min(c.x + dx, c.x + c.w - MIN_SRC)); c.w += c.x - nx; c.x = nx }
        if (hE.includes('e')) c.w = Math.max(MIN_SRC, Math.min(c.w + dx, o.natW - c.x))
        if (hE.includes('n')) { const ny = Math.max(0, Math.min(c.y + dy, c.y + c.h - MIN_SRC)); c.h += c.y - ny; c.y = ny }
        if (hE.includes('s')) c.h = Math.max(MIN_SRC, Math.min(c.h + dy, o.natH - c.y))
        // screen position: the visible left/top edge moves by however much was cropped off it
        const x = d.h.includes('w') ? o.x + (o.crop.w - c.w) * s : o.x
        const y = d.h.includes('n') ? o.y + (c.y - o.crop.y) * s : o.y
        upd(d.id, (q) => ({ ...q, crop: c, x, y }))
      }
    }
    const up = () => { drag.current = null }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [W, H])

  // ---- keyboard ----
  const onKey = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (e.key === 'Escape') { if (cropMode) setCropMode(false); else onClose(); return }
    if (!cur) return
    const k = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft') { e.preventDefault(); upd(cur.id, (l) => ({ ...l, x: l.x - k })) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); upd(cur.id, (l) => ({ ...l, x: l.x + k })) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); upd(cur.id, (l) => ({ ...l, y: l.y - k })) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); upd(cur.id, (l) => ({ ...l, y: l.y + k })) }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeLayer(cur.id) }
    else if (e.key.toLowerCase() === 'c') { e.preventDefault(); setCropMode((m) => !m) }
    else if (e.key === ']') { e.preventDefault(); zMove(cur.id, 1) }
    else if (e.key === '[') { e.preventDefault(); zMove(cur.id, -1) }
  }
  const removeLayer = (id: number) => { setLayers((ls) => ls.filter((l) => l.id !== id)); setSel(null) }
  const zMove = (id: number, dir: 1 | -1) => setLayers((ls) => {
    const i = ls.findIndex((l) => l.id === id), j = i + dir
    if (i < 0 || j < 0 || j >= ls.length) return ls
    const n = [...ls]; [n[i], n[j]] = [n[j], n[i]]; return n
  })
  /** Fill the canvas height (or width) with this layer, keeping its aspect. */
  const fitLayer = (id: number, axis: 'h' | 'w') => upd(id, (l) => {
    const s = axis === 'h' ? H / l.crop.h : W / l.crop.w
    return { ...l, scale: s, x: axis === 'w' ? 0 : l.x, y: axis === 'h' ? 0 : l.y }
  })

  // ---- save ----
  const save = async () => {
    if (!layers.length) { setMsg('Nothing to save.'); return }
    setBusy(true); setMsg('Rendering…')
    try {
      const c = document.createElement('canvas')
      c.width = Math.round(W); c.height = Math.round(H)
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      ctx.imageSmoothingQuality = 'high'
      if (bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height) }
      for (const l of layers) {
        const im = imgs.current.get(l.rel)
        if (!im) throw new Error(`${l.name} is not loaded`)
        ctx.save()
        if (l.flip) { ctx.translate(l.x + lw(l), l.y); ctx.scale(-1, 1); ctx.drawImage(im, l.crop.x, l.crop.y, l.crop.w, l.crop.h, 0, 0, lw(l), lh(l)) }
        else ctx.drawImage(im, l.crop.x, l.crop.y, l.crop.w, l.crop.h, l.x, l.y, lw(l), lh(l))
        ctx.restore()
      }
      const dir = rels[0].includes('/') ? rels[0].slice(0, rels[0].lastIndexOf('/')) : ''
      const r = await store.composeSave(dir, name.trim() || 'compose', c.toDataURL('image/png'))
      setMsg(`Saved ${r.name} (${c.width}×${c.height}) → ${dir || '/'}`)
      onSaved()
    } catch (e: any) { setMsg('Save failed: ' + (e?.message || e)) }
    finally { setBusy(false) }
  }

  // ---- render ----
  const handles: Handle[] = cropMode ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] : ['nw', 'ne', 'se', 'sw']
  const hPos = (h: Handle): React.CSSProperties => ({
    left: h.includes('w') ? -6 : h.includes('e') ? undefined : 'calc(50% - 6px)', right: h.includes('e') ? -6 : undefined,
    top: h.includes('n') ? -6 : h.includes('s') ? undefined : 'calc(50% - 6px)', bottom: h.includes('s') ? -6 : undefined,
    cursor: (h === 'n' || h === 's') ? 'ns-resize' : (h === 'e' || h === 'w') ? 'ew-resize' : (h === 'nw' || h === 'se') ? 'nwse-resize' : 'nesw-resize',
  })
  const usedRels = new Set(layers.map((l) => l.rel))
  const addable = pool.filter((im) => !im.is_video && !im.is_gif)

  return (
    <div className={styles.crBg} onKeyDown={onKey} tabIndex={-1} ref={(el) => { if (el && !el.contains(document.activeElement)) el.focus() }}>
      <div className={styles.crInner} onClick={(e) => e.stopPropagation()}>
        <div className={styles.crBar}>
          <strong>🧩 Compose</strong>
          <label className={styles.sortLbl}>Canvas
            <select className={styles.input} value="" onChange={(e) => { const p = SIZE_PRESETS[Number(e.target.value)]; if (p) { setW(p.w); setH(p.h) } }}>
              <option value="">{Math.round(W)} × {Math.round(H)}</option>
              {SIZE_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
            </select>
          </label>
          <input className={styles.input} type="number" min={16} max={8192} value={Math.round(W)} onChange={(e) => setW(Math.max(16, Math.min(8192, Number(e.target.value) || 16)))} style={{ width: 72 }} title="Canvas width (px)" />
          ×
          <input className={styles.input} type="number" min={16} max={8192} value={Math.round(H)} onChange={(e) => setH(Math.max(16, Math.min(8192, Number(e.target.value) || 16)))} style={{ width: 72 }} title="Canvas height (px)" />
          <button className={styles.btn} onClick={() => applyLayout(false)} title="Line every layer up left-to-right at the same height (smallest one's height, so nothing is upscaled); canvas fits them">⇹ Side by side</button>
          <button className={styles.btn} onClick={() => applyLayout(true)} title="Stack every layer top-to-bottom at the same width; canvas fits them">⇵ Stacked</button>
          <label className={styles.sortLbl} title="Space between layers for Side by side / Stacked">Gap
            <input className={styles.input} type="number" min={0} max={512} value={gap} onChange={(e) => setGap(Math.max(0, Number(e.target.value) || 0))} style={{ width: 56 }} />
          </label>
          <button className={styles.btn} onClick={fitCanvas} title="Trim / grow the canvas to exactly the area the layers cover">⛶ Fit canvas to layers</button>
          <button className={styles.btn} title="Scale the whole composition so its longest side is 1024 px (training size)" onClick={() => resizeAll(1024 / Math.max(W, H))}>⤓ Longest side 1024</button>
          <label className={styles.sortLbl}>Background
            <select className={styles.input} value={['#ffffff', '#000000', 'transparent'].includes(bg) ? bg : 'custom'} onChange={(e) => setBg(e.target.value === 'custom' ? '#808080' : e.target.value)}>
              <option value="#ffffff">White</option><option value="#000000">Black</option><option value="transparent">Transparent</option><option value="custom">Colour…</option>
            </select>
          </label>
          {!['#ffffff', '#000000', 'transparent'].includes(bg) && <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />}
          <span className={styles.spacer} />
          <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} style={{ width: 220 }} title="File name (.png is added; never overwrites — -2, -3… instead)" />
          <button className={styles.btnPrimary} disabled={busy || !layers.length} onClick={() => void save()}>{busy ? 'Saving…' : '💾 Save as new image'}</button>
          <button className={styles.btn} onClick={onClose}>Close</button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* layer list */}
          <div style={{ width: 230, flex: '0 0 auto', borderRight: '1px solid var(--border)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto' }}>
            <div className={styles.dim} style={{ fontSize: 11 }}>Layers (top of the list = front)</div>
            {[...layers].reverse().map((l) => (
              <div key={l.id} onClick={() => setSel(l.id)}
                style={{ display: 'flex', gap: 6, alignItems: 'center', padding: 4, borderRadius: 6, cursor: 'pointer',
                         border: `1px solid ${l.id === sel ? 'var(--accent)' : 'var(--border)'}`, background: l.id === sel ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined }}>
                <img src={igThumb(l.rel)} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 11 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.name}>{l.name}</div>
                  <div className={styles.dim}>{Math.round(l.crop.w)}×{Math.round(l.crop.h)} @ {Math.round(l.scale * 100)}%</div>
                </div>
              </div>
            ))}
            {cur && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                <button className={cropMode ? styles.btnPrimary : styles.btn} onClick={() => setCropMode((m) => !m)} title="Drag the 8 handles to crop this layer (C)">✂ {cropMode ? 'Cropping…' : 'Crop'}</button>
                <button className={styles.btn} onClick={() => upd(cur.id, (l) => ({ ...l, crop: { x: 0, y: 0, w: l.natW, h: l.natH } }))} title="Undo this layer's crop">Uncrop</button>
                <button className={styles.btn} onClick={() => upd(cur.id, (l) => ({ ...l, flip: !l.flip }))} title="Mirror left-right">⇋ Flip</button>
                <button className={styles.btn} onClick={() => fitLayer(cur.id, 'h')} title="Scale to the canvas height">↕ Fit height</button>
                <button className={styles.btn} onClick={() => fitLayer(cur.id, 'w')} title="Scale to the canvas width">↔ Fit width</button>
                <button className={styles.btn} onClick={() => upd(cur.id, (l) => ({ ...l, scale: 1 }))} title="100%: one source pixel per output pixel">1:1</button>
                <button className={styles.btn} onClick={() => zMove(cur.id, 1)} title="Bring forward (])">▲</button>
                <button className={styles.btn} onClick={() => zMove(cur.id, -1)} title="Send backward ([)">▼</button>
                <button className={styles.btnDanger} onClick={() => removeLayer(cur.id)} title="Remove from the composition (Delete) — the file is untouched">Remove</button>
              </div>
            )}
            <select className={styles.input} value="" onChange={(e) => { if (e.target.value) void addImages([e.target.value], false) }} title="Add another image from this folder">
              <option value="">＋ Add image…</option>
              {addable.map((im) => <option key={im.rel} value={im.rel}>{usedRels.has(im.rel) ? '✓ ' : ''}{im.name}</option>)}
            </select>
            <div className={styles.acHint} style={{ marginTop: 'auto' }}>
              Drag a layer to move it (snaps to edges; hold <strong>Alt</strong> to stop snapping) · corner handles scale ·
              {' '}<strong>C</strong> crop mode · arrows nudge (Shift = 10 px) · <strong>[ ]</strong> order · <strong>Del</strong> remove.
              Saved beside <code>{rels[0]?.split('/').slice(-2, -1)[0] || 'the first image'}</code>; originals are never changed.
            </div>
          </div>

          {/* stage */}
          <div ref={stageRef} className={styles.crStage} onMouseDown={() => { setSel(null); setCropMode(false) }}>
            <div ref={canvasRef} style={{
              position: 'relative', width: W * view, height: H * view, flex: '0 0 auto',
              background: bg === 'transparent' ? 'repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0 / 16px 16px' : bg,
              boxShadow: '0 0 0 1px rgba(255,255,255,0.25)',
            }}>
              {layers.map((l) => {
                const s = l.scale * view, active = l.id === sel
                return (
                  <div key={l.id} onMouseDown={(e) => downLayer(e, l)}
                    style={{ position: 'absolute', left: l.x * view, top: l.y * view, width: lw(l) * view, height: lh(l) * view, cursor: 'move',
                             outline: active ? `2px ${cropMode ? 'dashed' : 'solid'} var(--accent)` : '1px dashed rgba(255,255,255,0.25)', outlineOffset: 0 }}>
                    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', transform: l.flip ? 'scaleX(-1)' : undefined }}>
                      <img src={igImage(l.rel)} alt="" draggable={false}
                        style={{ position: 'absolute', left: -l.crop.x * s, top: -l.crop.y * s, width: l.natW * s, height: l.natH * s, maxWidth: 'none', userSelect: 'none', pointerEvents: 'none' }} />
                    </div>
                    {active && handles.map((h) => (
                      <span key={h} onMouseDown={(e) => downHandle(e, l, h)}
                        style={{ position: 'absolute', width: 12, height: 12, borderRadius: cropMode ? 2 : 6, background: cropMode ? '#f59e0b' : 'var(--accent)', border: '2px solid #fff', boxSizing: 'border-box', zIndex: 2, ...hPos(h) }} />
                    ))}
                  </div>
                )
              })}
            </div>
            <span style={{ position: 'absolute', right: 10, bottom: 8, fontSize: 11, color: '#bbb' }}>{Math.round(W)}×{Math.round(H)} · view {Math.round(view * 100)}%</span>
          </div>
        </div>
        {msg && <div className={styles.acHint} style={{ padding: '4px 12px' }}>{msg}</div>}
      </div>
    </div>
  )
}
