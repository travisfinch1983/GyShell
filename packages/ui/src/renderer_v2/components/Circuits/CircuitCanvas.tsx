import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Design, PartDef, PartInstance, PinDef, PinRef, View } from './circuitTypes'
import { PIN_COLORS } from './circuitTypes'
import { anchoredRoute, artUrl, bounds, draggableSegment, nearestSegment, partSize, pinWorld, routePoints, schPins, slideSegment, snap, wireControls, wirePath, wireStyleFor, type Pt } from './geometry'
import styles from './Circuit.module.css'

export type Sel = { kind: 'part'; ref: string } | { kind: 'wire'; id: string } | null

export interface CanvasHandle {
  fit: () => void
  /** World point at the centre of the visible canvas (where click-to-add drops a part). */
  center: () => Pt
  cancelWiring: () => void
}

interface Props {
  design: Design
  parts: Map<string, PartDef>
  view: View
  selection: Sel
  highlight: Set<string>
  onSelect: (s: Sel) => void
  /** push=true records an undo step for this change; drags call onBeginEdit once, then push=false. */
  onChange: (next: Design, push?: boolean) => void
  onBeginEdit: () => void
  onDropPart: (partId: string, at: Pt) => void
  handleRef: (h: CanvasHandle) => void
  onStatus?: (msg: string) => void
}

type Drag =
  | { mode: 'part'; ref: string; start: Pt; orig: { x: number; y: number }; moved: boolean }
  | { mode: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { mode: 'bend'; wireId: string; idx: number; moved: boolean }
  /** pressed on a wire body / a '+' handle: becomes a drag once the pointer actually moves */
  | { mode: 'wire-pull'; wireId: string; seg: number | null; sx: number; sy: number; at: Pt }
  /** sliding one straight run of a square-cornered wire sideways (Cirkit-style) */
  | { mode: 'segment'; wireId: string; route: Pt[]; seg: number; horiz: boolean; start: Pt; d: number; moved: boolean }
  | null

const GRID = 5
const clone = (d: Design): Design => JSON.parse(JSON.stringify(d))

export function CircuitCanvas(p: Props) {
  const { design, parts, view } = p
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [pan, setPan] = useState<Pt>({ x: 40, y: 40 })
  const [zoom, setZoom] = useState(2)
  const [wiring, setWiring] = useState<{ from: PinRef; pts: Pt[] } | null>(null)
  const [cursor, setCursor] = useState<Pt>({ x: 0, y: 0 })
  const [hover, setHover] = useState<{ inst: PartInstance; pin: PinDef; cx: number; cy: number } | null>(null)
  const drag = useRef<Drag>(null)
  const designRef = useRef(design); designRef.current = design

  const toWorld = useCallback((cx: number, cy: number): Pt => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: (cx - r.left - pan.x) / zoom, y: (cy - r.top - pan.y) / zoom }
  }, [pan, zoom])

  const fit = useCallback(() => {
    const b = bounds(designRef.current, parts, view)
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    if (!b) { setZoom(2); setPan({ x: 40, y: 40 }); return }
    const pad = 30
    const z = Math.max(0.3, Math.min(6, Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1))))
    setZoom(z)
    setPan({ x: (r.width - b.w * z) / 2 - b.x * z, y: (r.height - b.h * z) / 2 - b.y * z })
  }, [parts, view])

  useEffect(() => {
    p.handleRef({
      fit,
      center: () => {
        const r = svgRef.current?.getBoundingClientRect()
        if (!r) return { x: 40, y: 40 }
        return { x: snap((r.width / 2 - pan.x) / zoom, 10), y: snap((r.height / 2 - pan.y) / zoom, 10) }
      },
      cancelWiring: () => setWiring(null),
    })
  })

  // Fit once when a design is first shown in a view.
  const fitted = useRef<string>('')
  useEffect(() => {
    const k = `${design.id}|${view}`
    if (fitted.current === k) return
    fitted.current = k
    requestAnimationFrame(() => fit())
  }, [design.id, view, fit])

  // ── wheel zoom around the cursor (non-passive so the page doesn't scroll) ──
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      setZoom((z) => {
        const nz = Math.max(0.25, Math.min(8, z * Math.exp(-e.deltaY * 0.0015)))
        setPan((pp) => ({ x: mx - ((mx - pp.x) / z) * nz, y: my - ((my - pp.y) / z) * nz }))
        return nz
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const connected = useMemo(() => {
    const s = new Set<string>()
    for (const w of design.wires) { s.add(`${w.from.ref}.${w.from.pin}`); s.add(`${w.to.ref}.${w.to.pin}`) }
    return s
  }, [design.wires])

  // ── pointer handling ──
  const finishWire = (to: PinRef) => {
    if (!wiring) return
    if (to.ref === wiring.from.ref && to.pin === wiring.from.pin) { setWiring(null); return }
    const d = clone(designRef.current)
    const dup = d.wires.some((w) => (w.from.ref === wiring.from.ref && w.from.pin === wiring.from.pin && w.to.ref === to.ref && w.to.pin === to.pin) ||
      (w.to.ref === wiring.from.ref && w.to.pin === wiring.from.pin && w.from.ref === to.ref && w.from.pin === to.pin))
    if (dup) { setWiring(null); p.onStatus?.('Those pins are already wired'); return }
    const pa = pinDefOf(d, wiring.from), pb = pinDefOf(d, to)
    const color = [pa?.type, pb?.type].includes('ground') ? '#1f1f1f' : [pa?.type, pb?.type].includes('power') ? '#e5484d' : ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#f97316'][d.wires.length % 7]
    const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const pts = wiring.pts.map((q) => [q.x, q.y] as [number, number])
    d.wires.push({ id, from: wiring.from, to, color, ...(view === 'bb' ? (pts.length ? { bbPoints: pts } : {}) : (pts.length ? { schPoints: pts } : {})) })
    setWiring(null)
    p.onChange(d, true)
    p.onSelect({ kind: 'wire', id })
  }
  const pinDefOf = (d: Design, r: PinRef) => {
    const inst = d.parts.find((q) => q.ref === r.ref)
    return inst ? parts.get(inst.partId)?.pins.find((q) => q.id === r.pin) : undefined
  }

  const onPinDown = (e: React.PointerEvent, inst: PartInstance, pin: PinDef) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (wiring) finishWire({ ref: inst.ref, pin: pin.id })
    else { setWiring({ from: { ref: inst.ref, pin: pin.id }, pts: [] }); p.onSelect(null) }
  }

  const onPartDown = (e: React.PointerEvent, inst: PartInstance) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (wiring) return // clicking a body while wiring does nothing (a pin finishes it)
    p.onSelect({ kind: 'part', ref: inst.ref })
    drag.current = { mode: 'part', ref: inst.ref, start: toWorld(e.clientX, e.clientY), orig: { x: inst[view].x, y: inst[view].y }, moved: false }
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  /**
   * Pressing a wire selects it. Dragging a square-cornered wire slides the straight run under the
   * pointer sideways (no new vertex — corners appear where it meets a pin's lead-out); dragging a
   * straight-line wire pulls out a new bend.
   */
  const onWireDown = (e: React.PointerEvent, wireId: string, seg: number | null = null) => {
    if (e.button !== 0 || wiring) return
    e.stopPropagation()
    p.onSelect({ kind: 'wire', id: wireId })
    drag.current = { mode: 'wire-pull', wireId, seg, sx: e.clientX, sy: e.clientY, at: toWorld(e.clientX, e.clientY) }
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  const stubLen = view === 'sch' ? 10 : 8
  const wireRoute = (d: Design, wireId: string): Pt[] | null => {
    const wire = d.wires.find((q) => q.id === wireId)
    const ctrl = wire ? wireControls(d, parts, wire, view) : null
    return ctrl ? anchoredRoute(ctrl, stubLen) : null
  }

  /** Start sliding the segment of `wireId` nearest to `at`. */
  const beginSegment = (wireId: string, at: Pt): Drag => {
    const route = wireRoute(designRef.current, wireId)
    if (!route) return null
    const seg = draggableSegment(route, nearestSegment(route, at))
    if (seg === null) return null
    return { mode: 'segment', wireId, route, seg, horiz: route[seg].y === route[seg + 1].y, start: at, d: 0, moved: false }
  }

  /** Insert a bend on wire `wireId` at world point `at` (segment `seg` of its control points, or the nearest). Returns its index. */
  const insertBend = (wireId: string, at: Pt, seg: number | null): number | null => {
    const d = clone(designRef.current)
    const wire = d.wires.find((q) => q.id === wireId)
    if (!wire) return null
    const ctrl = wireControls(d, parts, wire, view)
    if (!ctrl) return null
    const key = view === 'bb' ? 'bbPoints' : 'schPoints'
    const inner = [...(wire[key] ?? [])]
    const i = seg ?? nearestSegment(ctrl, at)
    inner.splice(i, 0, [snap(at.x, GRID), snap(at.y, GRID)])
    wire[key] = inner
    p.onBeginEdit()
    p.onChange(d, false)
    return i
  }

  const removeBend = (wireId: string, idx: number) => {
    const d = clone(designRef.current)
    const wire = d.wires.find((q) => q.id === wireId)
    const key = view === 'bb' ? 'bbPoints' : 'schPoints'
    if (!wire?.[key]) return
    wire[key]!.splice(idx, 1)
    if (!wire[key]!.length) delete wire[key]
    p.onChange(d, true)
  }

  const onBendDown = (e: React.PointerEvent, wireId: string, idx: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    drag.current = { mode: 'bend', wireId, idx, moved: false }
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && !wiring)) {
      if (e.button === 0) p.onSelect(null)
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y }
      svgRef.current?.setPointerCapture(e.pointerId)
      return
    }
    if (e.button === 0 && wiring) {
      const w = toWorld(e.clientX, e.clientY)
      setWiring({ ...wiring, pts: [...wiring.pts, { x: snap(w.x, GRID), y: snap(w.y, GRID) }] })
    }
  }

  const onMove = (e: React.PointerEvent) => {
    const w = toWorld(e.clientX, e.clientY)
    setCursor(w)
    const dr = drag.current
    if (!dr) return
    if (dr.mode === 'pan') { setPan({ x: dr.ox + e.clientX - dr.sx, y: dr.oy + e.clientY - dr.sy }); return }
    if (dr.mode === 'wire-pull') {
      if (Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) < 4) return
      if (wireStyleFor(designRef.current, view) === 'orthogonal') {
        drag.current = beginSegment(dr.wireId, dr.at)
        if (drag.current) onMove(e)
        return
      }
      const idx = insertBend(dr.wireId, w, dr.seg)
      drag.current = idx === null ? null : { mode: 'bend', wireId: dr.wireId, idx, moved: true }
      return
    }
    if (dr.mode === 'segment') {
      const base = dr.horiz ? dr.route[dr.seg].y : dr.route[dr.seg].x
      const raw = dr.horiz ? w.y - dr.start.y : w.x - dr.start.x
      const dd = snap(base + raw, GRID) - base
      if (dd === dr.d) return
      dr.d = dd
      const d = clone(designRef.current)
      const wire = d.wires.find((q) => q.id === dr.wireId)
      if (!wire) return
      if (!dr.moved) { p.onBeginEdit(); dr.moved = true }
      const key = view === 'bb' ? 'bbPoints' : 'schPoints'
      const pts = slideSegment(dr.route, dr.seg, dd)
      if (pts.length) wire[key] = pts
      else delete wire[key]
      p.onChange(d, false)
      return
    }
    if (dr.mode === 'part') {
      const nx = snap(dr.orig.x + w.x - dr.start.x, GRID), ny = snap(dr.orig.y + w.y - dr.start.y, GRID)
      const cur = designRef.current.parts.find((q) => q.ref === dr.ref)
      if (!cur || (cur[view].x === nx && cur[view].y === ny)) return
      if (!dr.moved) { p.onBeginEdit(); dr.moved = true }
      const d = clone(designRef.current)
      const inst = d.parts.find((q) => q.ref === dr.ref)!
      inst[view].x = nx; inst[view].y = ny
      p.onChange(d, false)
      return
    }
    if (dr.mode === 'bend') {
      const d = clone(designRef.current)
      const wire = d.wires.find((q) => q.id === dr.wireId)
      const key = view === 'bb' ? 'bbPoints' : 'schPoints'
      const pts = wire?.[key]
      if (!wire || !pts?.[dr.idx]) return
      const np: [number, number] = [snap(w.x, GRID), snap(w.y, GRID)]
      if (pts[dr.idx][0] === np[0] && pts[dr.idx][1] === np[1]) return
      if (!dr.moved) { p.onBeginEdit(); dr.moved = true }
      pts[dr.idx] = np
      p.onChange(d, false)
    }
  }

  const onUp = (e: React.PointerEvent) => {
    try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    drag.current = null
  }

  const onBendDouble = (e: React.MouseEvent, wireId: string, idx: number) => {
    e.stopPropagation()
    removeBend(wireId, idx)
  }

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-circuit-part')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
  }
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('application/x-circuit-part')
    if (!id) return
    e.preventDefault()
    const w = toWorld(e.clientX, e.clientY)
    const def = parts.get(id)
    const { w: pw, h: ph } = partSize(def, view)
    p.onDropPart(id, { x: snap(w.x - pw / 2, 10), y: snap(w.y - ph / 2, 10) })
  }

  // ── render ──
  const sel = p.selection
  const gridSize = 10 * zoom
  const wiringStart = wiring ? (() => {
    const inst = design.parts.find((q) => q.ref === wiring.from.ref)
    return inst ? pinWorld(inst, parts.get(inst.partId), wiring.from.pin, view) : null
  })() : null

  return (
    <div ref={wrapRef} className={styles.canvasWrap} onDragOver={onDragOver} onDrop={onDrop}>
      <svg
        ref={svgRef}
        className={`${styles.svg} ${wiring ? styles.svgWiring : ''}`}
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onContextMenu={(e) => { e.preventDefault(); if (wiring) setWiring(null) }}
      >
        <defs>
          <pattern id={`cgrid-${view}`} width={gridSize} height={gridSize} patternUnits="userSpaceOnUse" x={pan.x % gridSize} y={pan.y % gridSize}>
            <circle cx={1} cy={1} r={zoom > 1.2 ? 0.9 : 0.6} fill="var(--circuit-grid, #3a3f47)" />
          </pattern>
        </defs>
        <rect x={0} y={0} width="100%" height="100%" fill={`url(#cgrid-${view})`} />
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {/* parts */}
          {design.parts.map((inst) => {
            const def = parts.get(inst.partId)
            const { w, h } = partSize(def, view)
            const pl = inst[view]
            const isSel = sel?.kind === 'part' && sel.ref === inst.ref
            const hl = p.highlight.has(inst.ref)
            return (
              <g key={inst.ref} transform={`translate(${pl.x} ${pl.y}) rotate(${pl.rot} ${w / 2} ${h / 2})`} onPointerDown={(e) => onPartDown(e, inst)} className={styles.part}>
                {view === 'bb' ? <BreadboardArt def={def} inst={inst} w={w} h={h} /> : <SchematicArt def={def} inst={inst} w={w} h={h} rot={pl.rot} />}
                {(isSel || hl) && <rect x={-3} y={-3} width={w + 6} height={h + 6} rx={3} fill="none" stroke={hl ? '#f59e0b' : 'var(--accent)'} strokeWidth={1.2 / Math.min(zoom, 2) + 0.3} strokeDasharray={isSel ? '4 2' : undefined} />}
              </g>
            )
          })}
          {/* ref labels in breadboard view, unrotated */}
          {view === 'bb' && design.parts.map((inst) => {
            const def = parts.get(inst.partId)
            const { w, h } = partSize(def, view)
            const pl = inst[view]
            const rotSide = pl.rot % 180 !== 0
            const W = rotSide ? h : w, H = rotSide ? w : h
            const cx = pl.x + w / 2, cy = pl.y + h / 2
            return <text key={`lbl-${inst.ref}`} x={cx - W / 2} y={cy - H / 2 - 3} className={styles.refLabel}>{inst.ref}{inst.label ? ` · ${inst.label}` : ''}{inst.props?.value ? ` · ${inst.props.value}` : ''}</text>
          })}
          {/* wires */}
          {design.wires.map((w) => {
            const path = wirePath(design, parts, w, view)
            if (!path) return null
            const isSel = sel?.kind === 'wire' && sel.id === w.id
            const d = path.map((q, i) => `${i ? 'L' : 'M'}${q.x} ${q.y}`).join(' ')
            const color = view === 'sch' ? 'var(--circuit-sch-wire, #7dd3fc)' : (w.color || '#3b82f6')
            const pts = (view === 'bb' ? w.bbPoints : w.schPoints) ?? []
            // label sits halfway along the middle segment, not on a pin
            const mi = Math.max(0, Math.floor((path.length - 1) / 2))
            const mid = path[mi + 1] ? { x: (path[mi].x + path[mi + 1].x) / 2, y: (path[mi].y + path[mi + 1].y) / 2 } : path[mi]
            const dark = isDarkColor(color)
            const ortho = wireStyleFor(design, view) === 'orthogonal'
            const hitRoute = ortho ? (() => { const c = wireControls(design, parts, w, view); return c ? anchoredRoute(c, stubLen) : null })() : null
            return (
              <g key={w.id}>
                {ortho && hitRoute
                  ? hitRoute.slice(0, -1).map((a, i) => {
                    const b = hitRoute[i + 1]
                    const s = draggableSegment(hitRoute, i)
                    const cur = s === null ? 'pointer' : hitRoute[s].y === hitRoute[s + 1].y ? 'ns-resize' : 'ew-resize'
                    return <path key={`h${i}`} d={`M${a.x} ${a.y} L${b.x} ${b.y}`} fill="none" stroke="transparent" strokeWidth={8} strokeLinecap="round" style={{ cursor: cur }} onPointerDown={(e) => onWireDown(e, w.id)} />
                  })
                  : <path d={d} fill="none" stroke="transparent" strokeWidth={8} className={styles.wireHit} onPointerDown={(e) => onWireDown(e, w.id)} />}
                {isSel && <path d={d} fill="none" stroke="var(--accent)" strokeWidth={view === 'bb' ? 4.6 : 3} strokeOpacity={0.55} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />}
                {view === 'bb' && <path d={d} fill="none" stroke={dark ? '#ffffff59' : '#00000066'} strokeWidth={dark ? 3.2 : 2.8} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />}
                <path d={d} fill="none" stroke={color} strokeWidth={view === 'bb' ? 2 : 1} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
                {w.label && mid && <text x={mid.x + 2} y={mid.y - 2} className={styles.netLabel} pointerEvents="none">{w.label}</text>}
                {isSel && !ortho && (() => {
                  const ctrl = wireControls(design, parts, w, view) ?? []
                  return ctrl.slice(0, -1).map((a, i) => {
                    const b = ctrl[i + 1]
                    if (Math.hypot(b.x - a.x, b.y - a.y) < 14) return null
                    return (
                      <g key={`g${i}`} className={styles.ghost} onPointerDown={(e) => onWireDown(e, w.id, i)}>
                        <circle cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} r={2.4} />
                        <path d={`M${(a.x + b.x) / 2 - 1.3} ${(a.y + b.y) / 2} h2.6 M${(a.x + b.x) / 2} ${(a.y + b.y) / 2 - 1.3} v2.6`} />
                      </g>
                    )
                  })
                })()}
                {isSel && !ortho && pts.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={y} r={2.6} className={styles.bend} onPointerDown={(e) => onBendDown(e, w.id, i)} onDoubleClick={(e) => onBendDouble(e, w.id, i)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); removeBend(w.id, i) }} />
                ))}
              </g>
            )
          })}
          {/* pins on top so wire ends never block them */}
          {design.parts.map((inst) => {
            const def = parts.get(inst.partId)
            if (!def) return null
            return def.pins.map((pin) => {
              const pw = pinWorld(inst, def, pin.id, view)
              if (!pw) return null
              const key = `${inst.ref}.${pin.id}`
              const isConn = connected.has(key)
              const isFrom = wiring?.from.ref === inst.ref && wiring.from.pin === pin.id
              return (
                <circle
                  key={key} cx={pw.x} cy={pw.y} r={view === 'bb' ? 2.6 : 1.8}
                  className={`${styles.pin} ${isConn ? styles.pinConn : ''} ${isFrom ? styles.pinFrom : ''}`}
                  style={{ ['--pin-color' as any]: PIN_COLORS[pin.type] }}
                  onPointerDown={(e) => onPinDown(e, inst, pin)}
                  onPointerEnter={(e) => setHover({ inst, pin, cx: e.clientX, cy: e.clientY })}
                  onPointerLeave={() => setHover((h) => (h?.pin === pin && h.inst === inst ? null : h))}
                />
              )
            })
          })}
          {/* rubber band while wiring */}
          {wiring && wiringStart && (
            <path
              d={routePoints([wiringStart, ...wiring.pts, { x: snap(cursor.x, GRID), y: snap(cursor.y, GRID) }], wireStyleFor(design, view), view === 'sch' ? 10 : 8).map((q, i) => `${i ? 'L' : 'M'}${q.x} ${q.y}`).join(' ')}
              fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeDasharray="4 3" pointerEvents="none"
            />
          )}
        </g>
      </svg>
      {hover && <PinTip hover={hover} wrap={wrapRef.current} design={design} />}
      <div className={styles.zoomBadge}>{Math.round(zoom * 50)}%{wiring ? ' · wiring: click a pin to finish, empty space to add a corner, Esc / right-click to cancel' : sel?.kind === 'wire' ? (wireStyleFor(design, view) === 'orthogonal' ? ' · drag any straight run of the wire to slide it — corners appear where needed' : ' · drag the wire or a + to add a bend · drag a bend to move it · right-click a bend to remove it') : ''}</div>
    </div>
  )
}

/** Near-black wires (ground) vanish on the dark canvas — they get a light halo instead of a shadow. */
function isDarkColor(c: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return false
  const n = parseInt(m[1], 16)
  const l = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return l < 60
}

function PinTip({ hover, wrap, design }: { hover: { inst: PartInstance; pin: PinDef; cx: number; cy: number }; wrap: HTMLDivElement | null; design: Design }) {
  const r = wrap?.getBoundingClientRect()
  if (!r) return null
  const { pin, inst } = hover
  const links = design.wires.filter((w) => (w.from.ref === inst.ref && w.from.pin === pin.id) || (w.to.ref === inst.ref && w.to.pin === pin.id))
    .map((w) => (w.from.ref === inst.ref && w.from.pin === pin.id ? w.to : w.from)).map((q) => `${q.ref}.${q.pin}`)
  return (
    <div className={styles.pinTip} style={{ left: hover.cx - r.left + 14, top: hover.cy - r.top + 10 }}>
      <div className={styles.pinTipHead}>{inst.ref} · {pin.name}{pin.id !== pin.name ? ` (${pin.id})` : ''}</div>
      <div className={styles.pinTipRow}><span style={{ color: PIN_COLORS[pin.type] }}>●</span> {pin.type}{pin.voltage !== undefined ? ` · ${pin.voltage} V` : ''}</div>
      {pin.functions?.length ? <div className={styles.pinTipRow}>{pin.functions.join(', ')}</div> : null}
      {pin.flags?.length ? <div className={styles.pinTipWarn}>⚠ {pin.flags.join(', ')}</div> : null}
      {pin.notes ? <div className={styles.pinTipRow}>{pin.notes}</div> : null}
      {links.length ? <div className={styles.pinTipRow}>→ {links.join(', ')}</div> : null}
    </div>
  )
}

function BreadboardArt({ def, inst, w, h }: { def?: PartDef; inst: PartInstance; w: number; h: number }) {
  const url = def ? artUrl(def) : null
  if (!def || !url) {
    return (
      <g>
        <rect x={0} y={0} width={w} height={h} rx={3} fill="#3f1d1d" stroke="#e5484d" strokeDasharray="3 2" />
        <text x={w / 2} y={h / 2} className={styles.missingText}>{def ? def.name : `missing: ${inst.partId}`}</text>
      </g>
    )
  }
  return <image href={url} x={0} y={0} width={w} height={h} preserveAspectRatio="none" />
}

function SchematicArt({ def, inst, w, h, rot }: { def?: PartDef; inst: PartInstance; w: number; h: number; rot: number }) {
  const stroke = 'var(--circuit-sch, #e5e7eb)'
  const upright = rot === 180 ? `rotate(180 ${w / 2} ${h / 2})` : undefined
  if (!def) return <rect x={0} y={0} width={w} height={h} fill="none" stroke="#e5484d" strokeDasharray="3 2" />
  const sym = def.schematic?.symbol ?? 'box'
  const value = inst.props?.value ?? (def.props?.value as string | undefined)
  const label = (
    <g transform={upright}>
      <text x={sym === 'box' ? 10 : w / 2} y={-3} className={styles.schRef} textAnchor={sym === 'box' ? 'start' : 'middle'}>{inst.ref}{value ? ` ${value}` : ''}</text>
    </g>
  )
  const hit = <rect x={0} y={0} width={w} height={h} fill="transparent" />
  if (sym === 'box') {
    const pins = schPins(def)
    return (
      <g>
        {hit}
        <rect x={10} y={10} width={w - 20} height={h - 15} fill="var(--circuit-sch-fill, #1b2230)" stroke={stroke} strokeWidth={0.8} />
        <g transform={upright}><text x={w / 2} y={19} className={styles.schName}>{inst.label || def.name.replace(/\s*\(.*\)\s*$/, '').slice(0, 26)}</text></g>
        {label}
        {def.pins.map((pin) => {
          const q = pins.get(pin.id)
          if (!q) return null
          const inner = q.side === 'L' ? 10 : w - 10
          return (
            <g key={pin.id}>
              <line x1={q.x} y1={q.y} x2={inner} y2={q.y} stroke={stroke} strokeWidth={0.8} />
              <text x={q.side === 'L' ? inner + 2 : inner - 2} y={q.y + 1.4} className={styles.schPin} textAnchor={q.side === 'L' ? 'start' : 'end'}>{pin.name}</text>
            </g>
          )
        })}
      </g>
    )
  }
  const y = h / 2
  const sw = 1
  let body: React.ReactNode
  switch (sym) {
    case 'resistor': {
      const zz = Array.from({ length: 6 }, (_, i) => `L${17 + i * 5 + 2.5} ${i % 2 ? y + 4 : y - 4}`).join(' ')
      body = <path d={`M0 ${y} H15 ${zz} L45 ${y} H60`} fill="none" stroke={stroke} strokeWidth={sw} />
      break
    }
    case 'led':
    case 'diode':
      body = (
        <g fill="none" stroke={stroke} strokeWidth={sw}>
          <path d={`M0 ${y} H22 M38 ${y} H60`} />
          <path d={`M22 ${y - 7} L22 ${y + 7} L37 ${y} Z`} fill={sym === 'led' ? '#ef444455' : 'none'} />
          <path d={`M38 ${y - 7} V${y + 7}`} />
          {sym === 'led' && <path d={`M30 ${y - 9} l5 -6 m-3 0 h3 v3 M35 ${y - 7} l5 -6 m-3 0 h3 v3`} />}
        </g>
      )
      break
    case 'cap':
    case 'cap-pol':
      body = (
        <g fill="none" stroke={stroke} strokeWidth={sw}>
          <path d={`M0 ${y} H27 M33 ${y} H60 M27 ${y - 9} V${y + 9}`} />
          {sym === 'cap' ? <path d={`M33 ${y - 9} V${y + 9}`} /> : <path d={`M36 ${y - 9} Q31 ${y} 36 ${y + 9}`} />}
          {sym === 'cap-pol' && <text x={20} y={y - 5} className={styles.schPin} stroke="none" fill={stroke}>+</text>}
        </g>
      )
      break
    case 'button':
      body = (
        <g fill="none" stroke={stroke} strokeWidth={sw}>
          <path d={`M0 ${y} H20 M40 ${y} H60`} /><circle cx={20} cy={y} r={1.2} /><circle cx={40} cy={y} r={1.2} />
          <path d={`M18 ${y - 7} H42 M30 ${y - 7} V${y - 13}`} />
        </g>
      )
      break
    case 'npn':
    case 'nmos':
      body = (
        <g fill="none" stroke={stroke} strokeWidth={sw}>
          <circle cx={36} cy={y} r={13} />
          <path d={`M0 ${y} H28`} />
          {sym === 'npn'
            ? <path d={`M28 ${y - 8} V${y + 8} M28 ${y - 4} L40 ${y - 12} V0 M28 ${y + 4} L40 ${y + 12} V${h} M36 ${y + 10} L40 ${y + 12} L38 ${y + 8}`} />
            : <path d={`M25 ${y - 7} V${y + 7} M28 ${y - 8} V${y + 8} M28 ${y - 6} H40 V0 M28 ${y + 6} H40 V${h} M28 ${y} H40 V${y + 6}`} />}
        </g>
      )
      break
    default:
      body = <rect x={0} y={0} width={w} height={h} fill="none" stroke={stroke} />
  }
  return <g>{hit}{body}{label}</g>
}

