import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { trainingImagesStore as store, igImage, igDownload, imKey } from '../../stores/TrainingImagesStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './TrainingImages.module.scss'

const CROP_PRESETS = [
  { group: 'Square', items: [{ label: '512²', w: 512, h: 512 }, { label: '768²', w: 768, h: 768 }, { label: '1024²', w: 1024, h: 1024 }] },
  { group: 'Portrait (SDXL)', items: [{ label: '832×1216', w: 832, h: 1216 }, { label: '896×1152', w: 896, h: 1152 }, { label: '768×1024', w: 768, h: 1024 }] },
  { group: 'Landscape (SDXL)', items: [{ label: '1216×832', w: 1216, h: 832 }, { label: '1152×896', w: 1152, h: 896 }, { label: '1024×768', w: 1024, h: 768 }] },
  // 0x0 = no aspect lock and no resize: the crop keeps its own pixels (comic panels, odd shapes)
  { group: 'Free', items: [{ label: 'Free (any shape, no resize)', w: 0, h: 0 }] },
]
const FREE_MIN = 12   // display px
const CORNERS: Record<string, [number, number]> = { nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] }

export const CropEditor: React.FC<{ rel: string; name: string; onClose: () => void; onChanged: () => void; navPos?: { i: number; n: number }; onNav?: (dir: 1 | -1) => void; onCaption?: () => void; onWatermark?: () => void }> = observer(({ rel, name, onClose, onChanged, navPos, onNav, onCaption, onWatermark }) => {
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const S = useRef({ natW: 0, natH: 0, fit: 1, dispW: 0, dispH: 0, target: { w: 1024, h: 1024 }, box: { x: 0, y: 0, w: 0, h: 0 } })
  const drag = useRef<{ mode: 'move' | 'resize' | 'draw' | null; anchor?: any; dir?: [number, number]; start?: any }>({ mode: null })
  // Crops saved as NEW files during this visit, in source px -- drawn as outlines so it is clear
  // which panels of a page are already done.
  const [madeRects, setMadeRects] = useState<{ x: number; y: number; w: number; h: number; name: string }[]>([])

  const [target, setTarget] = useState(() => localStorage.getItem('aig-crop-target') || '1024x1024')
  const [info, setInfo] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  // rel, not name: with batch subsections inlined, the same filename can exist twice.
  const imRec = store.images.find((x) => x.rel === rel) || ({} as any)
  const [tags, setTags] = useState(''); const tagsOrig = useRef('')
  const [nl, setNl] = useState(''); const nlOrig = useRef('')
  const [score, setScore] = useState(imRec.score ? String(imRec.score) : '')
  const [comment, setComment] = useState(imRec.comment || '')
  const pollRef = useRef<any>(null)

  const isFree = () => !(S.current.target.w > 0 && S.current.target.h > 0)
  const maxBox = () => {
    if (isFree()) return { w: S.current.dispW, h: S.current.dispH }
    const ar = S.current.target.w / S.current.target.h; let w = S.current.dispW, h = w / ar; if (h > S.current.dispH) { h = S.current.dispH; w = h * ar } return { w, h }
  }
  const minBoxW = () => isFree() ? Math.min(FREE_MIN, S.current.dispW) : Math.min(S.current.target.w * S.current.fit, maxBox().w)
  const clampBox = () => {
    const s = S.current, mb = maxBox(), minW = minBoxW()
    s.box.w = Math.max(minW, Math.min(s.box.w, mb.w))
    if (isFree()) s.box.h = Math.max(Math.min(FREE_MIN, s.dispH), Math.min(s.box.h, mb.h))
    else s.box.h = s.box.w / (s.target.w / s.target.h)
    s.box.x = Math.max(0, Math.min(s.box.x, s.dispW - s.box.w)); s.box.y = Math.max(0, Math.min(s.box.y, s.dispH - s.box.h))
  }
  const draw = () => {
    const s = S.current, b = boxRef.current; if (!b) return
    b.style.left = s.box.x + 'px'; b.style.top = s.box.y + 'px'; b.style.width = s.box.w + 'px'; b.style.height = s.box.h + 'px'
    const sw = Math.round(s.box.w / s.fit), sh = Math.round(s.box.h / s.fit)
    setInfo(isFree() ? `src ${sw}×${sh}px (kept as is)` : `src ${sw}×${sh}px → ${s.target.w}×${s.target.h}${(sw < s.target.w || sh < s.target.h) ? '  ⚠ upscales' : ''}`)
  }
  const initBox = () => {
    const mb = maxBox(), k = isFree() ? 0.8 : 1   // free: start inset so the box edges are visible and grabbable
    S.current.box = { w: mb.w * k, h: mb.h * k, x: (S.current.dispW - mb.w * k) / 2, y: (S.current.dispH - mb.h * k) / 2 }; draw()
  }
  const layout = () => {
    const s = S.current, r = stageRef.current!.getBoundingClientRect()
    s.fit = Math.min(r.width / s.natW, r.height / s.natH); if (!isFinite(s.fit) || s.fit <= 0) s.fit = 1
    s.dispW = s.natW * s.fit; s.dispH = s.natH * s.fit
    if (canvasRef.current) { canvasRef.current.style.width = s.dispW + 'px'; canvasRef.current.style.height = s.dispH + 'px' }
  }
  const loadImg = () => {
    const img = imgRef.current!; img.onload = () => { S.current.natW = img.naturalWidth; S.current.natH = img.naturalHeight; layout(); initBox() }
    img.src = igImage(rel, Date.now())
  }

  // init target from prop + load image + captions; attach window drag listeners
  useEffect(() => {
    const v = (target || '').split('x').map(Number); if (v.length === 2 && v[0] >= 0 && v[1] >= 0) S.current.target = { w: v[0], h: v[1] }
    loadImg()
    void (async () => {
      try { const r = await store.getCaption(rel, 'txt'); setTags(r.caption || ''); tagsOrig.current = r.caption || '' } catch {}
      try { const r = await store.getCaption(rel, 'caption'); setNl(r.caption || ''); nlOrig.current = r.caption || '' } catch {}
    })()
    const onMove = (e: MouseEvent) => {
      const d = drag.current; if (!d.mode) return
      const r = canvasRef.current!.getBoundingClientRect(); const p = { x: e.clientX - r.left, y: e.clientY - r.top }; const s = S.current
      if (d.mode === 'move') { s.box.x = d.start.bx + (p.x - d.start.x); s.box.y = d.start.by + (p.y - d.start.y); clampBox(); draw() }
      else if (isFree()) {
        // free resize / draw: width and height independent; 'draw' picks its corner from the drag direction
        if (d.mode === 'draw') d.dir = [p.x >= d.anchor.x ? 1 : -1, p.y >= d.anchor.y ? 1 : -1]
        const roomX = d.dir![0] > 0 ? (s.dispW - d.anchor.x) : d.anchor.x, roomY = d.dir![1] > 0 ? (s.dispH - d.anchor.y) : d.anchor.y
        const w = Math.max(Math.min(FREE_MIN, roomX), Math.min(Math.abs(p.x - d.anchor.x), roomX))
        const h = Math.max(Math.min(FREE_MIN, roomY), Math.min(Math.abs(p.y - d.anchor.y), roomY))
        s.box.x = d.dir![0] > 0 ? d.anchor.x : d.anchor.x - w; s.box.y = d.dir![1] > 0 ? d.anchor.y : d.anchor.y - h
        s.box.w = w; s.box.h = h; draw()
      }
      else {
        if (d.mode === 'draw') d.dir = [p.x >= d.anchor.x ? 1 : -1, p.y >= d.anchor.y ? 1 : -1]
        const ar = s.target.w / s.target.h; let w = Math.abs(p.x - d.anchor.x)
        const roomX = d.dir![0] > 0 ? (s.dispW - d.anchor.x) : d.anchor.x, roomY = d.dir![1] > 0 ? (s.dispH - d.anchor.y) : d.anchor.y
        w = Math.min(w, roomX, roomY * ar); w = Math.max(w, minBoxW()); w = Math.min(w, maxBox().w)
        const h = w / ar
        s.box.x = d.dir![0] > 0 ? d.anchor.x : d.anchor.x - w; s.box.y = d.dir![1] > 0 ? d.anchor.y : d.anchor.y - h
        s.box.w = w; s.box.h = h; draw()
      }
    }
    const onUp = () => { drag.current.mode = null }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); if (pollRef.current) clearInterval(pollRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onTargetChange = (v: string) => {
    setTarget(v); localStorage.setItem('aig-crop-target', v)
    const [w, h] = v.split('x').map(Number); S.current.target = { w, h }; initBox()
  }
  const boxDown = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement; const s = S.current
    if (t.dataset.c) { const dir = CORNERS[t.dataset.c]; drag.current = { mode: 'resize', dir, anchor: { x: dir[0] > 0 ? s.box.x : s.box.x + s.box.w, y: dir[1] > 0 ? s.box.y : s.box.y + s.box.h } } }
    else { const r = canvasRef.current!.getBoundingClientRect(); drag.current = { mode: 'move', start: { x: e.clientX - r.left, y: e.clientY - r.top, bx: s.box.x, by: s.box.y } } }
    e.preventDefault(); e.stopPropagation()
  }
  // Drag on the picture OUTSIDE the box = draw a new box from that point (quickest way to mark
  // panel after panel on a comic page). A plain click without movement leaves the box alone.
  const canvasDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const r = canvasRef.current!.getBoundingClientRect()
    const a = { x: Math.max(0, Math.min(e.clientX - r.left, S.current.dispW)), y: Math.max(0, Math.min(e.clientY - r.top, S.current.dispH)) }
    drag.current = { mode: 'draw', anchor: a, dir: [1, 1] }
    e.preventDefault()
  }
  const srcRect = () => {
    const s = S.current
    return { left: Math.round(s.box.x / s.fit), top: Math.round(s.box.y / s.fit), width: Math.round(s.box.w / s.fit), height: Math.round(s.box.h / s.fit) }
  }
  // Save the box as a NEW image beside this one; the original is untouched and the editor stays
  // open, so the box can go straight onto the next panel.
  const saveNew = async () => {
    const r0 = srcRect(), s = S.current
    setBusy(true); setMsg('Saving crop…')
    try {
      const r = await store.cropNew({ path: rel, ...r0, target_w: isFree() ? 0 : s.target.w, target_h: isFree() ? 0 : s.target.h })
      setMadeRects((m) => [...m, { x: r0.left, y: r0.top, w: r0.width, h: r0.height, name: r.name }])
      setMsg(`Saved ${r.name} (${r.w}×${r.h}) — draw the next box and save again.`)
      onChanged()
    } catch (e: any) { setMsg('Failed: ' + (e?.message || e)) }
    finally { setBusy(false) }
  }

  const apply = async (): Promise<boolean> => {
    const s = S.current
    setMsg('Applying…')
    try {
      const sr = srcRect()
      const r = await store.crop({ path: rel, ...sr, target_w: isFree() ? sr.width : s.target.w, target_h: isFree() ? sr.height : s.target.h })
      setMsg(`Saved ${r.w}×${r.h}.`); loadImg(); onChanged()
      return true
    } catch (e: any) { setMsg('Failed: ' + (e?.message || e)); return false }
  }
  const reset = async () => { setMsg('Restoring original…'); try { await store.resetCrop(rel); setMsg('Restored pristine original.'); loadImg(); onChanged() } catch (e: any) { setMsg('Failed: ' + (e?.message || e)) } }
  const upscale = async () => {
    setBusy(true); setMsg('Upscaling… (GPU, ~30–60s)')
    try {
      const { jobId } = await store.upscale(rel)
      let statusFailures = 0
      pollRef.current = setInterval(async () => {
        let s: any
        try { s = await store.upscaleStatus(jobId); statusFailures = 0 } catch {
          // catch{return} spun this interval FOREVER on a dead endpoint — the
          // UI stuck on "Upscaling…" with busy never released. The job may
          // well still be running server-side; after ~30s of unreachable
          // status, say so and stop pretending to watch it.
          if (++statusFailures >= 12) {
            clearInterval(pollRef.current); pollRef.current = null; setBusy(false)
            setMsg('Lost contact with the upscale job (status endpoint unreachable) — the job may still finish server-side; reload the image in a minute.')
          }
          return
        }
        if (s.state === 'running') return
        clearInterval(pollRef.current); pollRef.current = null; setBusy(false)
        if (s.state === 'done') { setMsg(`Upscaled to ${s.w}×${s.h}${s.gpu ? ' on ' + s.gpu : ''}.`); loadImg(); onChanged() } else setMsg(`Upscale failed: ${s.error || 'unknown'}`)
      }, 2500)
    } catch (e: any) { setBusy(false); setMsg('Failed: ' + (e?.message || e)) }
  }
  const swap = async () => { setBusy(true); setMsg('Swapping…'); try { await store.swapUpscale(rel); setMsg('Swapped version.'); loadImg(); onChanged() } catch (e: any) { setMsg('Failed: ' + (e?.message || e)) } finally { setBusy(false) } }
  // Watermark removal history: switch between the cleaned image and its kept original.
  const swapWm = async () => {
    setBusy(true); setMsg('Switching…')
    try { const r = await store.swapWatermark(rel); setMsg(r.showing === 'original' ? 'Showing the original (watermark-removed version parked).' : 'Showing the watermark-removed version.'); loadImg(); onChanged() }
    catch (e: any) { setMsg('Failed: ' + (e?.message || e)) } finally { setBusy(false) }
  }
  // A watermark job finishing while this editor is open may have rewritten THIS picture - reload it.
  const wmTick = store.wmDoneTick
  const wmConsumed = useRef(wmTick)
  useEffect(() => {
    if (wmConsumed.current === wmTick) return
    wmConsumed.current = wmTick
    loadImg()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wmTick])
  const stripOne = async () => {
    if (!(await confirmStore.confirm({ title: 'Strip tags (.txt)', message: `Delete ${name}'s .txt tag sidecar? Keeps the image + .caption.`, confirmText: 'Strip' }))) return
    try { await store.stripTags([name]); setTags(''); tagsOrig.current = ''; setMsg('Tags stripped.') } catch (e: any) { setMsg('strip failed') }
  }
  const saveAll = async () => {
    try {
      // Close and Next/Prev both route through here, so this runs on a pure LOOK as well as
      // an edit. onChanged() re-browses, so firing it unconditionally made simply opening an
      // image an act with consequences elsewhere in the UI. Only report a save that happened.
      let changed = false
      if (tags !== tagsOrig.current) { await store.setCaption(rel, tags, 'txt'); tagsOrig.current = tags; changed = true }
      if (nl !== nlOrig.current) { await store.setCaption(rel, nl, 'caption'); nlOrig.current = nl; changed = true }
      const sc = imRec.score ? String(imRec.score) : ''; const cm = imRec.comment || ''
      if (score !== sc || comment !== cm) { await store.setRating(rel, score ? Number(score) : 0, comment); changed = true }
      if (changed) { setMsg('Saved.'); onChanged() }
    } catch (e: any) { setMsg('Save failed: ' + (e?.message || e)) }
  }
  // When a caption job finishes while this editor is open, pull the fresh sidecars into
  // any box the user has NOT edited — otherwise a single-image caption looks like a no-op
  // until the image is reopened. Edited boxes are left alone: the user's text wins.
  // ANY tracked job finishing, not one specific job: with several captioners running, the
  // one that covers the open image is often not the last one started.
  const capTick = store.captionDoneTick
  const capConsumed = useRef(0)
  useEffect(() => {
    if (!capTick || capConsumed.current === capTick) return
    capConsumed.current = capTick
    void (async () => {
      try { const r = await store.getCaption(rel, 'txt'); if (tags === tagsOrig.current) { setTags(r.caption || ''); tagsOrig.current = r.caption || '' } } catch {}
      try { const r = await store.getCaption(rel, 'caption'); if (nl === nlOrig.current) { setNl(r.caption || ''); nlOrig.current = r.caption || '' } } catch {}
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capTick])

  const closeSave = () => { void saveAll().finally(onClose) }
  // Navigation saves like Close does — moving on must not discard caption/rating
  // edits typed on this image. The parent remounts the editor (key=rel) so every
  // image opens with clean state.
  const goNav = (dir: 1 | -1) => { void saveAll().finally(() => onNav?.(dir)) }
  // No confirmation, by request: this culls images that cropping cannot save, and a dialog on
  // every one defeats the point. 🛑 It is a HARD delete — the image plus its .txt/.caption/
  // .orig/.preup sidecars and its rating, with no trash — the same thing the browser's Delete
  // has always done.
  const deleteThis = async () => {
    setBusy(true); setMsg('Deleting…')
    try {
      // The section-qualified KEY, not the bare name. With batch subsections inlined into one
      // grid the same filename exists in several subsections, and a bare name posts against the
      // batch ROOT — deleting nothing, or a same-named file in the wrong place. imRec is looked
      // up by rel, so its dir is the one this image actually lives in.
      await store.deleteKeys([imRec && imRec.name ? imKey(imRec) : name])
      onChanged()
      // Keep paging: next image, else previous, else nothing left — close.
      if (navPos && onNav && navPos.i < navPos.n - 1) onNav(1)
      else if (navPos && onNav && navPos.i > 0) onNav(-1)
      else onClose()
    } catch (e: any) { setBusy(false); setMsg('Delete failed: ' + (e?.message || e)) }
  }
  const cropAndContinue = async () => {
    // A failed crop STAYS on the image with its error message — auto-advancing past
    // a failure would turn one bad crop into a silently skipped image.
    if (!(await apply())) return
    await saveAll()
    if (navPos && navPos.i < navPos.n - 1) onNav?.(1)
    else setMsg('Cropped — last image.')
  }

  return (
    <div className={styles.crBg} onClick={closeSave}>
      <div className={styles.crInner} onClick={(e) => e.stopPropagation()}>
        <div className={styles.crBar}>
          <span className={styles.crName}>{name}</span>
          <label className={styles.sortLbl}>Target
            <select className={styles.input} value={target} onChange={(e) => onTargetChange(e.target.value)}>
              {CROP_PRESETS.map((g) => <optgroup key={g.group} label={g.group}>{g.items.map((it) => <option key={it.label} value={`${it.w}x${it.h}`}>{it.label}</option>)}</optgroup>)}
            </select>
          </label>
          <span className={styles.crInfo}>{info}</span>
          <span className={styles.spacer} />
          {onCaption && <button className={styles.btn} disabled={busy} title="Run the auto-captioner on THIS image only" onClick={onCaption}>🏷 Caption</button>}
          {onWatermark && <button className={styles.btn} disabled={busy} title="Remove watermarks / signatures / logos from THIS image" onClick={onWatermark}>🧽 Watermark</button>}
          {imRec.wm && <button className={styles.btn} disabled={busy} onClick={() => void swapWm()}
                               title="Switch between the watermark-removed version and the kept original">{imRec.wm === 'cleaned' ? '⇄ Original' : '⇄ Cleaned'}</button>}
          <button className={styles.btn} disabled={busy} onClick={() => void upscale()} title="Re-upscale via SeedVR2">⤴ Upscale</button>
          <button className={styles.btn} disabled={busy} onClick={() => void swap()} title="Toggle upscaled ↔ pre-upscale">⇄ Swap</button>
          <button className={styles.btn} disabled={busy} onClick={() => void reset()}>Reset</button>
          {/* Not gated on inTrainingSet any more: culling happens in plain tag folders and in
              batches too, and the server already refuses what must not be deleted. */}
          <button className={styles.btnDanger} disabled={busy}
                  title="Delete this image and its caption sidecars, then go straight to the next one. No confirmation, and it cannot be undone."
                  onClick={() => void deleteThis()}>🗑 Delete</button>
          <button className={styles.btn} disabled={busy} onClick={() => void saveNew()}
                  title="Save the box as a NEW image next to this one (this image is not changed). Then drag a new box on the picture and save again — one page, many crops.">＋ Save as new{madeRects.length ? ` (${madeRects.length})` : ''}</button>
          <button className={styles.btnPrimary} disabled={busy} onClick={() => void apply()} title="Crop THIS image in place (training sets / batches; the original is kept for Reset)">Apply crop</button>
          <a className={styles.btn} href={igDownload(rel)} download={name} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
             title="Download the original file (full resolution, original format)">⬇ Download</a>
          <button className={styles.btn} onClick={closeSave}>Close</button>
        </div>
        <div className={styles.crStage} ref={stageRef}>
          <div className={styles.crCanvas} ref={canvasRef} onMouseDown={canvasDown}>
            <img ref={imgRef} alt="" draggable={false} />
            {madeRects.map((m) => (
              <div key={m.name} title={m.name} style={{ position: 'absolute', pointerEvents: 'none', left: m.x * S.current.fit, top: m.y * S.current.fit,
                width: m.w * S.current.fit, height: m.h * S.current.fit, border: '2px dashed #22c55e', background: 'rgba(34,197,94,0.12)', boxSizing: 'border-box' }}>
                <span style={{ position: 'absolute', left: 3, top: 1, fontSize: 10, color: '#fff', textShadow: '0 0 3px #000' }}>✓ {m.name.replace(/^.*-crop/, '#').replace(/\.[^.]+$/, '')}</span>
              </div>
            ))}
            <div className={styles.crBox} ref={boxRef} onMouseDown={boxDown}>
              {Object.keys(CORNERS).map((c) => <span key={c} className={`${styles.crH} ${styles['crH_' + c] || ''}`} data-c={c} />)}
            </div>
          </div>
        </div>
        <div className={styles.crCap}>
          <div className={styles.crCapCols}>
            <div className={styles.crCapCol}>
              <div className={styles.crCapHead}><span>Tags <span className={styles.dim}>.txt — comma-separated (WD/JoyTag)</span></span><button className={styles.btn} onClick={() => void stripOne()}>🧹 strip</button></div>
              <textarea className={styles.crText} spellCheck={false} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="1girl, plaid, studio lighting" />
            </div>
            <div className={styles.crCapCol}>
              <div className={styles.crCapHead}><span>Caption <span className={styles.dim}>.caption — natural language (BLIP)</span></span></div>
              <textarea className={styles.crText} spellCheck={false} value={nl} onChange={(e) => setNl(e.target.value)} placeholder="a woman wearing plaid on a bed" />
            </div>
          </div>
          <div className={styles.crRate}>
            <label className={styles.sortLbl}>★ Rating
              <select className={styles.input} value={score} onChange={(e) => setScore(e.target.value)}>
                <option value="">—</option>{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <input className={styles.input} style={{ flex: 1 }} placeholder="comment / notes" value={comment} onChange={(e) => setComment(e.target.value)} />
            <span className={styles.msg}>{msg}</span>
            <button className={styles.btnPrimary} onClick={() => void saveAll()}>Save all</button>
          </div>
        </div>
        <div className={styles.crNav}>
          <button className={styles.btn} disabled={busy || !navPos || navPos.i <= 0} onClick={() => goNav(-1)}>‹ Previous Image</button>
          <button className={styles.btnPrimary} disabled={busy || !onNav} onClick={() => void cropAndContinue()}>Crop and Continue</button>
          <button className={styles.btn} disabled={busy || !navPos || navPos.i >= navPos.n - 1} onClick={() => goNav(1)}>Next Image ›</button>
          {navPos && <span className={styles.crNavPos}>{navPos.i + 1} / {navPos.n}</span>}
        </div>
      </div>
    </div>
  )
})
