import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { trainingImagesStore as store, igImage } from '../../stores/TrainingImagesStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './TrainingImages.module.scss'

const CROP_PRESETS = [
  { group: 'Square', items: [{ label: '512²', w: 512, h: 512 }, { label: '768²', w: 768, h: 768 }, { label: '1024²', w: 1024, h: 1024 }] },
  { group: 'Portrait (SDXL)', items: [{ label: '832×1216', w: 832, h: 1216 }, { label: '896×1152', w: 896, h: 1152 }, { label: '768×1024', w: 768, h: 1024 }] },
  { group: 'Landscape (SDXL)', items: [{ label: '1216×832', w: 1216, h: 832 }, { label: '1152×896', w: 1152, h: 896 }, { label: '1024×768', w: 1024, h: 768 }] },
]
const CORNERS: Record<string, [number, number]> = { nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] }

export const CropEditor: React.FC<{ rel: string; name: string; onClose: () => void; onChanged: () => void; navPos?: { i: number; n: number }; onNav?: (dir: 1 | -1) => void }> = observer(({ rel, name, onClose, onChanged, navPos, onNav }) => {
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const S = useRef({ natW: 0, natH: 0, fit: 1, dispW: 0, dispH: 0, target: { w: 1024, h: 1024 }, box: { x: 0, y: 0, w: 0, h: 0 } })
  const drag = useRef<{ mode: 'move' | 'resize' | null; anchor?: any; dir?: [number, number]; start?: any }>({ mode: null })

  const [target, setTarget] = useState(() => localStorage.getItem('aig-crop-target') || '1024x1024')
  const [info, setInfo] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const imRec = store.images.find((x) => x.name === name) || ({} as any)
  const [tags, setTags] = useState(''); const tagsOrig = useRef('')
  const [nl, setNl] = useState(''); const nlOrig = useRef('')
  const [score, setScore] = useState(imRec.score ? String(imRec.score) : '')
  const [comment, setComment] = useState(imRec.comment || '')
  const pollRef = useRef<any>(null)

  const maxBox = () => { const ar = S.current.target.w / S.current.target.h; let w = S.current.dispW, h = w / ar; if (h > S.current.dispH) { h = S.current.dispH; w = h * ar } return { w, h } }
  const minBoxW = () => Math.min(S.current.target.w * S.current.fit, maxBox().w)
  const clampBox = () => {
    const s = S.current, ar = s.target.w / s.target.h, mb = maxBox(), minW = minBoxW()
    s.box.w = Math.max(minW, Math.min(s.box.w, mb.w)); s.box.h = s.box.w / ar
    s.box.x = Math.max(0, Math.min(s.box.x, s.dispW - s.box.w)); s.box.y = Math.max(0, Math.min(s.box.y, s.dispH - s.box.h))
  }
  const draw = () => {
    const s = S.current, b = boxRef.current; if (!b) return
    b.style.left = s.box.x + 'px'; b.style.top = s.box.y + 'px'; b.style.width = s.box.w + 'px'; b.style.height = s.box.h + 'px'
    const sw = Math.round(s.box.w / s.fit), sh = Math.round(s.box.h / s.fit)
    setInfo(`src ${sw}×${sh}px → ${s.target.w}×${s.target.h}${(sw < s.target.w || sh < s.target.h) ? '  ⚠ upscales' : ''}`)
  }
  const initBox = () => { const mb = maxBox(); S.current.box = { w: mb.w, h: mb.h, x: (S.current.dispW - mb.w) / 2, y: (S.current.dispH - mb.h) / 2 }; draw() }
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
    const v = (target || '').split('x').map(Number); if (v.length === 2 && v[0] > 0) S.current.target = { w: v[0], h: v[1] }
    loadImg()
    void (async () => {
      try { const r = await store.getCaption(rel, 'txt'); setTags(r.caption || ''); tagsOrig.current = r.caption || '' } catch {}
      try { const r = await store.getCaption(rel, 'caption'); setNl(r.caption || ''); nlOrig.current = r.caption || '' } catch {}
    })()
    const onMove = (e: MouseEvent) => {
      const d = drag.current; if (!d.mode) return
      const r = canvasRef.current!.getBoundingClientRect(); const p = { x: e.clientX - r.left, y: e.clientY - r.top }; const s = S.current
      if (d.mode === 'move') { s.box.x = d.start.bx + (p.x - d.start.x); s.box.y = d.start.by + (p.y - d.start.y); clampBox(); draw() }
      else {
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

  const apply = async (): Promise<boolean> => {
    const s = S.current
    setMsg('Applying…')
    try {
      const r = await store.crop({ path: rel, left: Math.round(s.box.x / s.fit), top: Math.round(s.box.y / s.fit), width: Math.round(s.box.w / s.fit), height: Math.round(s.box.h / s.fit), target_w: s.target.w, target_h: s.target.h })
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
  const stripOne = async () => {
    if (!(await confirmStore.confirm({ title: 'Strip tags (.txt)', message: `Delete ${name}'s .txt tag sidecar? Keeps the image + .caption.`, confirmText: 'Strip' }))) return
    try { await store.stripTags([name]); setTags(''); tagsOrig.current = ''; setMsg('Tags stripped.') } catch (e: any) { setMsg('strip failed') }
  }
  const saveAll = async () => {
    try {
      if (tags !== tagsOrig.current) { await store.setCaption(rel, tags, 'txt'); tagsOrig.current = tags }
      if (nl !== nlOrig.current) { await store.setCaption(rel, nl, 'caption'); nlOrig.current = nl }
      const sc = imRec.score ? String(imRec.score) : ''; const cm = imRec.comment || ''
      if (score !== sc || comment !== cm) await store.setRating(name, score ? Number(score) : 0, comment)
      setMsg('Saved.'); onChanged()
    } catch (e: any) { setMsg('Save failed: ' + (e?.message || e)) }
  }
  const closeSave = () => { void saveAll().finally(onClose) }
  // Navigation saves like Close does — moving on must not discard caption/rating
  // edits typed on this image. The parent remounts the editor (key=rel) so every
  // image opens with clean state.
  const goNav = (dir: 1 | -1) => { void saveAll().finally(() => onNav?.(dir)) }
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
          <button className={styles.btn} disabled={busy} onClick={() => void upscale()} title="Re-upscale via SeedVR2">⤴ Upscale</button>
          <button className={styles.btn} disabled={busy} onClick={() => void swap()} title="Toggle upscaled ↔ pre-upscale">⇄ Swap</button>
          <button className={styles.btn} disabled={busy} onClick={() => void reset()}>Reset</button>
          <button className={styles.btnPrimary} disabled={busy} onClick={() => void apply()}>Apply crop</button>
          <button className={styles.btn} onClick={closeSave}>Close</button>
        </div>
        <div className={styles.crStage} ref={stageRef}>
          <div className={styles.crCanvas} ref={canvasRef}>
            <img ref={imgRef} alt="" draggable={false} />
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
