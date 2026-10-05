import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Undo2, RefreshCw, ArrowLeftRight, Save, Check, X, EyeOff, Eye, Trash2, ChevronLeft, ChevronRight, Wand2 } from 'lucide-react'
import { poseManagerStore as store, SK_BODY_NAMES, type Pose, type Skeleton, type SkPoint } from '../../stores/PoseManagerStore'
import { igImage } from '../../stores/TrainingImagesStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './PoseManager.module.scss'

/** OpenPose drawing standard - must match skSvg() in imagegen.js so the editor shows what gets saved. */
const LIMBS: [number, number][] = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]]
const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170],
  [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]]
const HAND_EDGES: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]]
/** Left/right partners in the body list - swapping them turns the figure to face the other way. */
/** Nose, eyes, ears - the points DWPose guesses worst on a faceless mannequin. */
const FACE_POINTS = [0, 14, 15, 16, 17]
/** Far-side eye + ear of a head in profile - same rule as skFarFace() in imagegen.js. f = nose - ear
 *  midpoint, u = ear midpoint - neck; sign of f x u says which side faces away. null = not clearly profile. */
const farFace = (b: SkPoint[]): number[] | null => {
  const mid = (a: SkPoint, c: SkPoint): number[] | null => (a && c ? [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2] : (a || c || null))
  const nose = b[0], neck = b[1], ear = mid(b[16], b[17]) || mid(b[14], b[15])
  if (!nose || !neck || !ear) return null
  const fx = nose[0] - ear[0], fy = nose[1] - ear[1], ux = ear[0] - neck[0], uy = ear[1] - neck[1]
  const sin = (fx * uy - fy * ux) / ((Math.hypot(fx, fy) * Math.hypot(ux, uy)) || 1)
  return sin > 0.35 ? [14, 16] : sin < -0.35 ? [15, 17] : null
}
/** Far ear on a REAR view - same rule as skRearFarEar() in imagegen.js: the face DWPose invents on the
 *  back of the head sits on the side the head turns toward; nose to the figure's right -> left ear hidden. */
const rearFarEar = (b: SkPoint[]): number[] => {
  const nose = b[0], neck = b[1], rs = b[2], ls = b[5]
  const hips = [b[8], b[11]].filter(Boolean) as number[][]
  if (!nose || !neck || !rs || !ls || !hips.length) return []
  const hx = hips.reduce((a, k) => a + k[0], 0) / hips.length, hy = hips.reduce((a, k) => a + k[1], 0) / hips.length
  let ux = neck[0] - hx, uy = neck[1] - hy; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul
  const sw = Math.hypot(rs[0] - ls[0], rs[1] - ls[1]) || 1
  const off = ((nose[0] - neck[0]) * -uy + (nose[1] - neck[1]) * ux) / sw
  return off > 0.35 ? [17] : off < -0.35 ? [16] : []
}
const LR_PAIRS: [number, number][] = [[2, 5], [3, 6], [4, 7], [8, 11], [9, 12], [10, 13], [14, 15], [16, 17]]
const hsv = (h: number) => { const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f; const v = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][i % 6]; return `rgb(${v.map((x) => Math.round(x * 255)).join(',')})` }
const rgb = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

type Part = 'body' | 'hand_left' | 'hand_right'
type Sel = { part: Part; i: number } | null
const clone = (s: Skeleton): Skeleton => JSON.parse(JSON.stringify(s))
const emptySkeleton = (w: number, h: number, hidden: number[]): Skeleton =>
  ({ width: w, height: h, body: Array(18).fill(null), hand_left: null, hand_right: null, hidden, source: 'edited', review: [] })

/** Fix or place a pose's OpenPose skeleton by hand. Drag joints, place missing ones, swap left/right
 *  (that is what tells the edit model which way the body faces), hide points that shouldn't be drawn. */
/** `list` = the poses to cycle through with Previous / Next (the panel passes what it is showing, so the
 *  active filters apply - e.g. filter to "check skeleton" and Next walks only the flagged ones). */
export const PoseSkeletonEditor: React.FC<{ pose: Pose; onClose: () => void; list?: Pose[]; onNavigate?: (p: Pose) => void }> = observer(({ pose, onClose, list = [], onNavigate }) => {
  const [sk, setSk] = useState<Skeleton | null>(null)
  const [saved, setSaved] = useState<Skeleton | null>(null)
  const [undo, setUndo] = useState<Skeleton[]>([])
  const [sel, setSel] = useState<Sel>(null)
  const [placing, setPlacing] = useState<number | null>(null)
  const [editHands, setEditHands] = useState(false)
  const [imgOpacity, setImgOpacity] = useState(1)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [scale, setScale] = useState(1)
  const [mqAt, setMqAt] = useState<number | undefined>(pose.mannequin_at)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const drag = useRef<{ part: Part; i: number; before: Skeleton } | null>(null)
  const defaultHidden = useRef<number[]>([])

  const load = useCallback(async () => {
    setBusy('Loading…')
    try {
      const d = await store.getSkeleton(pose.id)
      defaultHidden.current = d.default_hidden || []
      setStale(d.stale); setMqAt(d.pose.mannequin_at)
      if (d.skeleton) { setSk(clone(d.skeleton)); setSaved(clone(d.skeleton)) }
      else { setSk(null); setSaved(null) }   // sized from the image once it loads
      setUndo([]); setSel(null); setPlacing(null); setMsg('')
    } catch (e: any) { setMsg('Failed to load: ' + String(e?.message || e)) }
    finally { setBusy('') }
  }, [pose.id])
  useEffect(() => { void load() }, [load])

  const dirty = useMemo(() => !!sk && JSON.stringify(sk) !== JSON.stringify(saved), [sk, saved])
  const W = sk?.width || 1, H = sk?.height || 1

  // Handle sizes are in image pixels, so scale them by how big the image is on screen.
  const measure = useCallback(() => { const im = imgRef.current; if (im && im.naturalWidth) setScale(im.clientWidth / im.naturalWidth) }, [])
  useEffect(() => { const ro = new ResizeObserver(measure); if (imgRef.current) ro.observe(imgRef.current); return () => ro.disconnect() }, [measure, sk === null])
  const onImgLoad = () => {
    const im = imgRef.current; if (!im) return
    measure()
    setSk((cur) => cur || emptySkeleton(im.naturalWidth, im.naturalHeight, defaultHidden.current))
  }

  const commit = (next: Skeleton, before?: Skeleton) => { if (sk) setUndo((u) => [...u.slice(-49), before || clone(sk)]); setSk(next) }
  const toSvg = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const svg = svgRef.current!; const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return [Math.max(0, Math.min(W - 1, Math.round(p.x * 10) / 10)), Math.max(0, Math.min(H - 1, Math.round(p.y * 10) / 10))]
  }
  const setPoint = (s: Skeleton, part: Part, i: number, v: SkPoint) => { const arr = s[part] as SkPoint[] | null; if (arr) arr[i] = v }

  const onHandleDown = (e: React.PointerEvent, part: Part, i: number) => {
    if (!sk || placing !== null) return
    e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { part, i, before: clone(sk) }; setSel({ part, i })
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || !sk) return
    const [x, y] = toSvg(e); const n = clone(sk); setPoint(n, d.part, d.i, [x, y, 1]); setSk(n)
  }
  const onUp = () => {
    const d = drag.current; drag.current = null
    if (d && sk && JSON.stringify(d.before) !== JSON.stringify(sk)) setUndo((u) => [...u.slice(-49), d.before])
  }
  const onSvgClick = (e: React.MouseEvent) => {
    if (placing === null || !sk) { return }
    const [x, y] = toSvg(e); const n = clone(sk); n.body[placing] = [x, y, 1]; commit(n)
    setSel({ part: 'body', i: placing }); setPlacing(null)
  }

  const swapLR = () => {
    if (!sk) return
    const n = clone(sk)
    for (const [a, b] of LR_PAIRS) { const t = n.body[a]; n.body[a] = n.body[b]; n.body[b] = t }
    const hl = n.hand_left; n.hand_left = n.hand_right; n.hand_right = hl
    const map = new Map<number, number>(); for (const [a, b] of LR_PAIRS) { map.set(a, b); map.set(b, a) }
    n.hidden = (n.hidden || []).map((i) => map.get(i) ?? i)
    commit(n); setMsg('Swapped left and right - check the colours now match the way the body faces.')
  }
  const toggleHidden = (i: number) => {
    if (!sk) return; const n = clone(sk); const h = new Set(n.hidden || [])
    if (h.has(i)) h.delete(i); else h.add(i); n.hidden = [...h].sort((a, b) => a - b); commit(n)
  }
  const setFaceHidden = (hide: boolean) => {
    if (!sk) return; const n = clone(sk); const h = new Set(n.hidden || [])
    for (const i of FACE_POINTS) { if (hide) h.add(i); else h.delete(i) }
    n.hidden = [...h].sort((a, b) => a - b); commit(n)
  }
  const hideFarFace = () => {
    if (!sk) return
    // Rear view (its default hides the nose): nose + eyes hidden, plus the far ear if the head is turned.
    if (defaultHidden.current.includes(0)) {
      const ear = rearFarEar(sk.body)
      const n = clone(sk); const h = new Set(n.hidden || [])
      for (const i of [0, 14, 15, 16, 17]) h.delete(i)
      for (const i of [0, 14, 15, ...ear]) h.add(i)
      n.hidden = [...h].sort((a, b) => a - b); commit(n)
      setMsg(ear.length ? `Rear view: face hidden, plus the far ${ear[0] === 16 ? 'right' : 'left'} ear.` : 'Rear view: face hidden; the head looks straight, so both ears stay.')
      return
    }
    const far = farFace(sk.body)
    if (!far) { setMsg('Can\'t tell which side is far - the head doesn\'t look clearly in profile (needs nose, neck and an ear or eye). Hide them by hand.'); return }
    const n = clone(sk); const h = new Set(n.hidden || [])
    for (const i of [0, 14, 15, 16, 17]) h.delete(i)
    for (const i of far) h.add(i)
    n.hidden = [...h].sort((a, b) => a - b); commit(n)
    setMsg(`Hid the far ${far[0] === 14 ? 'right' : 'left'} eye and ear; nose and near eye/ear shown.`)
  }
  const removeSel = () => {
    if (!sk || !sel) return; const n = clone(sk); setPoint(n, sel.part, sel.i, null); commit(n); setSel(null)
  }
  const removeHand = (part: 'hand_left' | 'hand_right') => { if (!sk) return; const n = clone(sk); n[part] = null; commit(n); setSel(null) }
  const doUndo = () => { setUndo((u) => { if (!u.length) return u; setSk(u[u.length - 1]); return u.slice(0, -1) }); setSel(null) }

  const save = async (unchanged = false): Promise<boolean> => {
    if (!sk) return false
    setBusy('Saving…')
    try {
      const r = await store.saveSkeleton(pose.id, sk, unchanged)
      setSk(clone(r.skeleton)); setSaved(clone(r.skeleton)); setUndo([]); setStale(false)
      setMsg(unchanged ? 'Marked as checked.' : 'Saved - the overlay image was redrawn.')
      return true
    } catch (e: any) { setMsg('Save failed: ' + String(e?.message || e)); return false }
    finally { setBusy('') }
  }

  // Previous / Next through `list`. Unsaved edits are never dropped silently.
  const idx = list.findIndex((p) => p.id === pose.id)
  const prevPose = idx > 0 ? list[idx - 1] : null
  const nextPose = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null
  const go = async (target: Pose | null) => {
    if (!target || !onNavigate || busy) return
    if (dirty && !(await confirmStore.confirm({ title: 'Unsaved changes', message: `Leave ${pose.name} without saving your skeleton edits?`, confirmText: 'Discard and go' }))) return
    onNavigate(target)
  }
  const saveAndNext = async (unchanged = false) => {
    if (!(await save(unchanged))) return
    if (nextPose && onNavigate) onNavigate(nextPose)
    else setMsg(unchanged ? 'Marked as checked - that was the last one in the list.' : 'Saved - that was the last one in the list.')
  }
  // Keyboard: Alt+Left / Alt+Right = previous / next (plain arrows are left alone for inputs/sliders).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); void go(prevPose) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); void go(nextPose) }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  })
  const redetect = async (fromPoints = false) => {
    if (!fromPoints && (dirty || saved?.source === 'edited')) {
      if (!(await confirmStore.confirm({ title: 'Re-detect skeleton', message: 'Replace this skeleton (including your edits) with a fresh automatic detection?', confirmText: 'Re-detect' }))) return
    }
    // "Detect from my points": every joint currently placed is sent as a hint and kept exactly; the
    // detector uses them to frame and turn the figure upright, then fills in only the missing ones.
    const hints = fromPoints && sk ? { [pose.id]: sk.body.map((k) => (k ? [k[0], k[1]] : null)) } : undefined
    setBusy(fromPoints ? 'Detecting the rest around your points (a few seconds)…' : 'Detecting on the CPU (a few seconds)…')
    try {
      const job = await store.detectSkeletons([pose.id], true, hints)
      for (let t = 0; t < 120; t++) {
        await new Promise((r) => setTimeout(r, 1500))
        const j = store.skJobs.find((x) => x.id === job.id)
        if (j && j.state !== 'running') { if (j.state !== 'done') setMsg(`Detection ${j.state}: ${j.error || j.results[pose.id]?.error || ''}`); break }
      }
      await load()
    } catch (e: any) { setMsg('Failed: ' + String(e?.message || e)) }
    finally { setBusy('') }
  }
  const close = async () => {
    if (dirty && !(await confirmStore.confirm({ title: 'Discard changes', message: 'Close without saving your skeleton edits?', confirmText: 'Discard' }))) return
    onClose()
  }

  const r = 7 / Math.max(scale, 0.05)          // on-screen ~7 px handles
  const hidden = new Set(sk?.hidden || [])
  const missing = sk ? sk.body.map((k, i) => (k ? -1 : i)).filter((i) => i >= 0) : []
  const reviewOpen = !!saved && !saved.reviewed && (saved.review || []).length > 0
  const selName = sel ? (sel.part === 'body' ? SK_BODY_NAMES[sel.i] : `${sel.part === 'hand_left' ? 'left' : 'right'} hand point ${sel.i}`) : ''

  return (
    <div className={styles.modalBg}>
      {/* deliberately NOT click-to-close: a stray click would throw away joint edits */}
      <div className={styles.skBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Skeleton · {pose.name}</strong>
          <span className={styles.dim}>{saved ? `${saved.source === 'edited' ? 'hand-edited' : `auto-detected${saved.framing ? ` (${saved.framing})` : ''}`}${saved.reviewed ? ' · checked' : ''}` : 'no skeleton yet - place the joints, or Re-detect'}</span>
          <span className={styles.spacer} />
          {onNavigate && list.length > 1 && (
            <>
              <button className={styles.btn} onClick={() => void go(prevPose)} disabled={!prevPose || !!busy} title={prevPose ? `Previous: ${prevPose.name} (Alt+←)` : 'First in the list'}><ChevronLeft size={13} /> Previous</button>
              <span className={styles.dim}>{idx >= 0 ? `${idx + 1} / ${list.length}` : `not in the current list`}</span>
              <button className={styles.btn} onClick={() => void go(nextPose)} disabled={!nextPose || !!busy} title={nextPose ? `Next: ${nextPose.name} (Alt+→)` : 'Last in the list'}>Next <ChevronRight size={13} /></button>
            </>
          )}
          <button className={styles.btn} onClick={() => void close()} disabled={!!busy}><X size={13} /> Close</button>
        </div>

        {stale && <div className={styles.noteBar}>The mannequin was regenerated after this skeleton was saved - check it still fits, or Re-detect.</div>}
        {reviewOpen && <div className={styles.skReview}><strong>Check:</strong> {(saved!.review || []).join(' · ')}</div>}

        <div className={styles.skMain}>
          <div className={styles.skStage}>
            {pose.mannequin_rel ? (
              <div className={styles.skImgWrap} style={{ background: imgOpacity < 1 ? '#000' : undefined }}>
                <img ref={imgRef} className={styles.skImg} src={igImage(pose.mannequin_rel, mqAt)} alt="mannequin" onLoad={onImgLoad} draggable={false}
                     style={{ opacity: imgOpacity }} />
                {sk && (
                  <svg ref={svgRef} className={styles.skSvg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
                       onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClick={onSvgClick}
                       style={{ cursor: placing !== null ? 'crosshair' : 'default' }}>
                    {LIMBS.map(([a, b], i) => {
                      const p = !hidden.has(a) && sk.body[a], q = !hidden.has(b) && sk.body[b]
                      if (!p || !q) return null
                      const cx = (p[0] + q[0]) / 2, cy = (p[1] + q[1]) / 2, len = Math.hypot(q[0] - p[0], q[1] - p[1]), ang = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI
                      return <ellipse key={`l${i}`} cx={cx} cy={cy} rx={len / 2} ry={Math.max(2, 4 * Math.max(W, H) / 512)} transform={`rotate(${ang} ${cx} ${cy})`} fill={rgb(COLORS[i], 0.6)} pointerEvents="none" />
                    })}
                    {(['hand_left', 'hand_right'] as const).map((part) => sk[part] && (
                      <g key={part} pointerEvents="none">
                        {HAND_EDGES.map(([a, b], i) => { const p = sk[part]![a], q = sk[part]![b]; return p && q ? <line key={i} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={hsv(i / HAND_EDGES.length)} strokeWidth={Math.max(1, 1.5 * Math.max(W, H) / 512)} /> : null })}
                      </g>
                    ))}
                    {/* handles: body always; hand points only when hand editing is on (42 points crowd the view) */}
                    {sk.body.map((k, i) => k && (
                      <circle key={`b${i}`} cx={k[0]} cy={k[1]} r={r} fill={rgb(COLORS[i], hidden.has(i) ? 0.25 : 1)}
                              stroke={sel?.part === 'body' && sel.i === i ? '#fff' : '#000'} strokeWidth={r * (sel?.part === 'body' && sel.i === i ? 0.45 : 0.2)}
                              strokeDasharray={hidden.has(i) ? `${r * 0.5} ${r * 0.4}` : undefined}
                              style={{ cursor: 'grab' }} onPointerDown={(e) => onHandleDown(e, 'body', i)}>
                        <title>{SK_BODY_NAMES[i]}{hidden.has(i) ? ' (hidden)' : ''}{k[2] < 0.5 ? ` - low confidence ${k[2].toFixed(2)}` : ''}</title>
                      </circle>
                    ))}
                    {(['hand_left', 'hand_right'] as const).map((part) => sk[part]?.map((k, i) => k && (
                      <circle key={`${part}${i}`} cx={k[0]} cy={k[1]} r={editHands ? r * 0.6 : r * 0.3} fill="rgb(0,0,255)"
                              stroke={sel?.part === part && sel.i === i ? '#fff' : 'none'} strokeWidth={r * 0.3}
                              pointerEvents={editHands ? 'all' : 'none'} style={{ cursor: 'grab' }} onPointerDown={(e) => onHandleDown(e, part, i)} />
                    )))}
                  </svg>
                )}
              </div>
            ) : <div className={styles.err}>This pose has no mannequin yet - convert it first.</div>}
          </div>

          <div className={styles.skSide}>
            <div className={styles.section}>Selected</div>
            {sel ? (
              <div className={styles.skSelRow}>
                <span>{selName}</span>
                {sel.part === 'body' && (
                  <button className={styles.btnSm} onClick={() => toggleHidden(sel.i)} title="Keep the point but don't draw it (e.g. the face on a rear view)">
                    {hidden.has(sel.i) ? <><Eye size={11} /> Show</> : <><EyeOff size={11} /> Hide</>}
                  </button>
                )}
                <button className={styles.btnDangerSm} onClick={removeSel} title="Remove this point (it becomes 'missing')"><Trash2 size={11} /></button>
              </div>
            ) : <div className={styles.dim}>Drag a joint to move it; click one to hide or remove it.</div>}

            <div className={styles.section}>Face</div>
            <div className={styles.skChips}>
              <button className={styles.btnSm} onClick={() => setFaceHidden(false)} disabled={!sk || !FACE_POINTS.some((i) => hidden.has(i))}
                      title="Unhide the nose, both eyes and both ears"><Eye size={11} /> Show all facial features</button>
              <button className={styles.btnSm} onClick={() => setFaceHidden(true)} disabled={!sk || FACE_POINTS.every((i) => hidden.has(i))}
                      title="Hide the nose, both eyes and both ears (e.g. a rear view)"><EyeOff size={11} /> Hide all</button>
              <button className={styles.btnSm} onClick={hideFarFace} disabled={!sk}
                      title="Profile: show the nose and near eye/ear, hide the far eye and ear (worked out from where the nose points)"><EyeOff size={11} /> Hide far eye &amp; ear</button>
            </div>
            {sk && FACE_POINTS.some((i) => !sk.body[i]) && (
              <div className={styles.hint}>Not detected (place them under Missing joints): {FACE_POINTS.filter((i) => !sk.body[i]).map((i) => SK_BODY_NAMES[i]).join(', ')}</div>
            )}

            <div className={styles.section}>Missing joints</div>
            {missing.length ? (
              <div className={styles.skChips}>
                {missing.map((i) => (
                  <button key={i} className={placing === i ? styles.btnPrimarySm : styles.btnSm} onClick={() => setPlacing(placing === i ? null : i)}
                          style={{ borderLeft: `3px solid ${rgb(COLORS[i])}` }}>{SK_BODY_NAMES[i]}</button>
                ))}
              </div>
            ) : <div className={styles.dim}>none</div>}
            {placing !== null && <div className={styles.hint}>Click on the image to place the <strong>{SK_BODY_NAMES[placing]}</strong>.</div>}
            {missing.length > 0 && (
              <>
                <button className={styles.btnSm} onClick={() => void redetect(true)} disabled={!!busy || !sk || 18 - missing.length < 2}
                        title="Keep every joint you've placed and let the detector find the rest around them"><Wand2 size={11} /> Detect the rest from my points</button>
                <div className={styles.hint}>Place a few anchor joints first - head or neck, both hips and a foot work best (they tell it which way is up) - then let it fill in the others.</div>
              </>
            )}

            <div className={styles.section}>Facing</div>
            <button className={styles.btnSm} onClick={swapLR} disabled={!sk}><ArrowLeftRight size={11} /> Swap left / right</button>
            <div className={styles.hint}>
              The figure's <strong>right</strong> arm is orange/yellow and its <strong>left</strong> arm green; right leg green/teal, left leg blue.
              On a front view the figure's right is on <em>your</em> left; on a rear view it is on your right.
            </div>

            <div className={styles.section}>Hands</div>
            <label className={styles.skCheck}><input type="checkbox" checked={editHands} onChange={(e) => setEditHands(e.target.checked)} /> Edit hand points</label>
            <div className={styles.skChips}>
              {sk?.hand_left && <button className={styles.btnSm} onClick={() => removeHand('hand_left')}>Remove left hand</button>}
              {sk?.hand_right && <button className={styles.btnSm} onClick={() => removeHand('hand_right')}>Remove right hand</button>}
            </div>

            <div className={styles.section}>Mannequin visibility</div>
            <input type="range" min={0} max={1} step={0.05} value={imgOpacity} onChange={(e) => setImgOpacity(parseFloat(e.target.value))} style={{ width: '100%' }} />
          </div>
        </div>

        <div className={styles.modalFoot}>
          <button className={styles.btn} onClick={doUndo} disabled={!undo.length || !!busy}><Undo2 size={13} /> Undo</button>
          <button className={styles.btn} onClick={() => { if (saved) { setSk(clone(saved)); setUndo([]); setSel(null) } }} disabled={!dirty || !!busy}>Revert</button>
          <button className={styles.btn} onClick={() => void redetect(false)} disabled={!!busy || !pose.mannequin_rel}><RefreshCw size={13} /> Re-detect</button>
          {(busy || msg) && <span className={styles.dim}>{busy || msg}</span>}
          <span className={styles.spacer} />
          {reviewOpen && !dirty && <button className={styles.btn} onClick={() => void save(true)} disabled={!!busy} title="The detection is fine - clear the review flag"><Check size={13} /> OK as is</button>}
          {reviewOpen && !dirty && onNavigate && <button className={styles.btn} onClick={() => void saveAndNext(true)} disabled={!!busy} title="Clear the review flag and open the next pose"><Check size={13} /> OK &amp; Next</button>}
          <button className={styles.btnPrimary} onClick={() => void save(false)} disabled={!sk || (!dirty && !!saved) || !!busy}><Save size={13} /> Save</button>
          {onNavigate && <button className={styles.btnPrimary} onClick={() => void saveAndNext(false)} disabled={!sk || (!dirty && !!saved) || !!busy} title={nextPose ? `Save, then open ${nextPose.name}` : 'Save (this is the last one in the list)'}><Save size={13} /> Save &amp; Next <ChevronRight size={13} /></button>}
        </div>
      </div>
    </div>
  )
})
