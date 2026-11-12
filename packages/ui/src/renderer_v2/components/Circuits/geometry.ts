import type { PartDef, PartInstance, PinDef, PinSide, View, Wire, Design } from './circuitTypes'

export type Pt = { x: number; y: number }

/** Schematic symbol size — MUST match schSize() in the backend's circuitModel.ts. */
export function schSize(part: PartDef): { w: number; h: number } {
  const sym = part.schematic?.symbol
  if (sym && sym !== 'box') return { w: 60, h: 40 }
  const left = part.pins.filter((p) => p.side === 'L' || p.side === 'T').length
  const right = part.pins.filter((p) => p.side === 'R' || p.side === 'B').length
  return { w: 140, h: Math.max(left, right, 1) * 10 + 30 }
}

export function partSize(part: PartDef | undefined, view: View): { w: number; h: number } {
  if (!part) return { w: 60, h: 40 }
  return view === 'bb' ? { w: part.width, h: part.height } : schSize(part)
}

/** Where each pin sits on the schematic symbol (local coords) and which way its stub points. */
export function schPins(part: PartDef): Map<string, Pt & { side: PinSide }> {
  const m = new Map<string, Pt & { side: PinSide }>()
  const sym = part.schematic?.symbol
  const { w, h } = schSize(part)
  if (sym && sym !== 'box') {
    if (part.pins.length === 3 && (sym === 'npn' || sym === 'nmos')) {
      // B/G left, C/D top, E/S bottom — whatever their ids, by conventional letter
      const find = (re: RegExp) => part.pins.find((p) => re.test(p.id))
      const ctl = find(/^[BG]$/i) ?? part.pins[1], top = find(/^[CD]$/i) ?? part.pins[2], bot = find(/^[ES]$/i) ?? part.pins[0]
      m.set(ctl.id, { x: 0, y: h / 2, side: 'L' })
      m.set(top.id, { x: 40, y: 0, side: 'T' })
      m.set(bot.id, { x: 40, y: h, side: 'B' })
      return m
    }
    part.pins.forEach((p, i) => m.set(p.id, i === 0 ? { x: 0, y: h / 2, side: 'L' } : { x: w, y: h / 2, side: 'R' }))
    return m
  }
  let left = part.pins.filter((p) => p.side === 'L' || p.side === 'T')
  let right = part.pins.filter((p) => p.side === 'R' || p.side === 'B')
  // a breakout with every pin on one edge: put them on the LEFT, facing the board it plugs into
  if (!left.length) { left = right; right = [] }
  left.forEach((p, i) => m.set(p.id, { x: 0, y: 25 + i * 10, side: 'L' }))
  right.forEach((p, i) => m.set(p.id, { x: w, y: 25 + i * 10, side: 'R' }))
  return m
}

export function rotatePt(p: Pt, w: number, h: number, rot: number): Pt {
  const cx = w / 2, cy = h / 2
  const dx = p.x - cx, dy = p.y - cy
  switch (((rot % 360) + 360) % 360) {
    case 90: return { x: cx - dy, y: cy + dx }
    case 180: return { x: cx - dx, y: cy - dy }
    case 270: return { x: cx + dy, y: cy - dx }
    default: return { x: p.x, y: p.y }
  }
}

const SIDE_VEC: Record<PinSide, Pt> = { L: { x: -1, y: 0 }, R: { x: 1, y: 0 }, T: { x: 0, y: -1 }, B: { x: 0, y: 1 } }
function rotateVec(v: Pt, rot: number): Pt {
  switch (((rot % 360) + 360) % 360) {
    case 90: return { x: -v.y, y: v.x }
    case 180: return { x: -v.x, y: -v.y }
    case 270: return { x: v.y, y: -v.x }
    default: return v
  }
}

/** World position of a pin, plus the outward direction of its stub (used by schematic routing). */
export function pinWorld(inst: PartInstance, part: PartDef | undefined, pinId: string, view: View): (Pt & { dir: Pt; order?: number }) | null {
  if (!part) {
    const pl = inst[view]
    return { x: pl.x, y: pl.y, dir: { x: -1, y: 0 } }
  }
  const pl = inst[view]
  const { w, h } = partSize(part, view)
  let local: (Pt & { side: PinSide }) | undefined
  if (view === 'bb') {
    const p = part.pins.find((q) => q.id === pinId)
    if (p) local = { x: p.x, y: p.y, side: p.side }
  } else local = schPins(part).get(pinId)
  if (!local) return null
  const r = rotatePt(local, w, h, pl.rot)
  return { x: pl.x + r.x, y: pl.y + r.y, dir: rotateVec(SIDE_VEC[local.side], pl.rot), order: part.pins.findIndex((q) => q.id === pinId) }
}

export type WireStyle = 'straight' | 'orthogonal'

/** Wire style in a view: the schematic is always square-cornered; the breadboard follows the design setting. */
export function wireStyleFor(d: Design, view: View): WireStyle {
  return view === 'sch' ? 'orthogonal' : (d.wireStyle === 'straight' ? 'straight' : 'orthogonal')
}

/** The wire's CONTROL points: pin, hand-placed bends, pin. Bends are inserted / moved against these. */
export function wireControls(d: Design, parts: Map<string, PartDef>, w: Wire, view: View): Array<Pt & { dir?: Pt; order?: number }> | null {
  const ia = d.parts.find((p) => p.ref === w.from.ref), ib = d.parts.find((p) => p.ref === w.to.ref)
  if (!ia || !ib) return null
  const a = pinWorld(ia, parts.get(ia.partId), w.from.pin, view)
  const b = pinWorld(ib, parts.get(ib.partId), w.to.pin, view)
  if (!a || !b) return null
  const pts = (view === 'bb' ? w.bbPoints : w.schPoints) ?? []
  return [a, ...pts.map(([x, y]) => ({ x, y })), b]
}

/**
 * Turn control points into a drawable route. Orthogonal: leave each pin straight out along its
 * edge (a short stub), then join every pair of points with one 90° corner, alternating so
 * consecutive legs turn rather than double back. Straight: the control points as-is.
 */
const lead = (q: { order?: number }, stub: number) => stub + ((q.order ?? 0) % 5) * 3

export function routePoints(ctrl: Array<Pt & { dir?: Pt; order?: number }>, style: WireStyle, stub = 8): Pt[] {
  if (style === 'straight' || ctrl.length < 2) return ctrl.map(({ x, y }) => ({ x, y }))
  const a = ctrl[0], b = ctrl[ctrl.length - 1]
  const pts: Pt[] = [{ x: a.x, y: a.y }]
  // Neighbouring pins get different lead-out lengths, so wires leaving one header (or arriving at
  // one breakout) turn on different lines instead of stacking on top of each other.
  if (a.dir) pts.push({ x: a.x + a.dir.x * lead(a, stub), y: a.y + a.dir.y * lead(a, stub) })
  for (const q of ctrl.slice(1, -1)) pts.push({ x: q.x, y: q.y })
  if (b.dir) pts.push({ x: b.x + b.dir.x * lead(b, stub), y: b.y + b.dir.y * lead(b, stub) })
  pts.push({ x: b.x, y: b.y })
  const out: Pt[] = [pts[0]]
  // first free leg runs perpendicular to the pin's stub
  let horiz = a.dir ? a.dir.x === 0 : true
  for (let i = 1; i < pts.length; i++) {
    const p = out[out.length - 1], q = pts[i]
    if (p.x !== q.x && p.y !== q.y) {
      out.push(horiz ? { x: q.x, y: p.y } : { x: p.x, y: q.y })
      // after a corner the last leg is the other axis; the next corner keeps alternating
    } else horiz = p.y === q.y ? false : true
    out.push(q)
  }
  // drop zero-length legs and collinear midpoints
  const clean: Pt[] = []
  for (const q of out) {
    const l = clean[clean.length - 1]
    if (l && l.x === q.x && l.y === q.y) continue
    const k = clean[clean.length - 2]
    if (k && l && ((k.x === l.x && l.x === q.x) || (k.y === l.y && l.y === q.y))) clean[clean.length - 1] = q
    else clean.push(q)
  }
  return clean
}

/** Drop repeated points and collinear midpoints, never removing a point flagged `fixed`. */
function cleanRoute(pts: Pt[], fixed: (i: number) => boolean): Pt[] {
  const out: Array<Pt & { f: boolean }> = []
  pts.forEach((q, i) => {
    const f = fixed(i)
    const l = out[out.length - 1]
    if (l && l.x === q.x && l.y === q.y) { if (f && !l.f) out[out.length - 1] = { ...q, f }; return }
    const k = out[out.length - 2]
    if (k && l && !l.f && ((k.x === l.x && l.x === q.x) || (k.y === l.y && l.y === q.y))) out[out.length - 1] = { ...q, f }
    else out.push({ ...q, f })
  })
  return out.map(({ x, y }) => ({ x, y }))
}

/**
 * Square-cornered route with both pins' lead-out points kept explicit:
 * [pin, lead-out, ...free corners..., lead-out, pin]. Segment dragging works on this shape —
 * the two pins and their lead-outs stay put, everything between them can move.
 */
export function anchoredRoute(ctrl: Array<Pt & { dir?: Pt; order?: number }>, stub: number): Pt[] | null {
  const a = ctrl[0], b = ctrl[ctrl.length - 1]
  if (ctrl.length < 2 || !a.dir || !b.dir) return null
  const sa = { x: a.x + a.dir.x * lead(a, stub), y: a.y + a.dir.y * lead(a, stub) }
  const sb = { x: b.x + b.dir.x * lead(b, stub), y: b.y + b.dir.y * lead(b, stub) }
  const r = routePoints(ctrl, 'orthogonal', stub)
  const inner = r.slice(1, -1).filter((q) => !(q.x === sa.x && q.y === sa.y) && !(q.x === sb.x && q.y === sb.y))
  const pts = [{ x: a.x, y: a.y }, sa, ...inner, sb, { x: b.x, y: b.y }]
  const n = pts.length
  return cleanRoute(pts, (i) => i <= 1 || i >= n - 2)
}

/**
 * Slide segment `seg` of an anchored route sideways by `d` (a horizontal segment moves up/down,
 * a vertical one left/right). Free corners move with it; where the segment meets a pin's
 * lead-out a new jog is inserted instead, so corners appear naturally. Returns the free
 * corners to store as the wire's points (pins and lead-outs stripped).
 */
export function slideSegment(route: Pt[], seg: number, d: number): Array<[number, number]> {
  const n = route.length
  const a = route[seg], b = route[seg + 1]
  const horiz = a.y === b.y
  const mv = (q: Pt): Pt => (horiz ? { x: q.x, y: q.y + d } : { x: q.x + d, y: q.y })
  const aFixed = seg <= 1, bFixed = seg + 1 >= n - 2
  const out = [...route.slice(0, seg), ...(aFixed ? [a] : []), mv(a), mv(b), ...(bFixed ? [b] : []), ...route.slice(seg + 2)]
  const m = out.length
  const clean = cleanRoute(out, (i) => i <= 1 || i >= m - 2)
  return clean.slice(2, -2).map((q) => [q.x, q.y] as [number, number])
}

/** Segment of an anchored route that a press at index `i` should drag: the lead-outs themselves hand off to their neighbour. */
export function draggableSegment(route: Pt[], i: number): number | null {
  const n = route.length
  if (n < 4) return null
  const s = Math.min(Math.max(i, 1), n - 3)
  const a = route[s], b = route[s + 1]
  return a.x === b.x && a.y === b.y ? null : s
}

/** Drawable route of a wire in a view. */
export function wirePath(d: Design, parts: Map<string, PartDef>, w: Wire, view: View): Pt[] | null {
  const ctrl = wireControls(d, parts, w, view)
  return ctrl ? routePoints(ctrl, wireStyleFor(d, view), view === 'sch' ? 10 : 8) : null
}

export const snap = (v: number, g: number) => Math.round(v / g) * g

export function bounds(d: Design, parts: Map<string, PartDef>, view: View): { x: number; y: number; w: number; h: number } | null {
  if (!d.parts.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of d.parts) {
    const { w, h } = partSize(parts.get(p.partId), view)
    const rot = p[view].rot % 180 !== 0
    const W = rot ? h : w, H = rot ? w : h
    const cx = p[view].x + w / 2, cy = p[view].y + h / 2
    x0 = Math.min(x0, cx - W / 2); y0 = Math.min(y0, cy - H / 2); x1 = Math.max(x1, cx + W / 2); y1 = Math.max(y1, cy + H / 2)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Index of the segment of `pts` nearest to `p` (where a dragged-out bend is inserted). */
export function nearestSegment(pts: Pt[], p: Pt): number {
  let best = 0, bd = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    const dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    const q = { x: a.x + t * dx, y: a.y + t * dy }
    const dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2
    if (dd < bd) { bd = dd; best = i }
  }
  return best
}

export function artUrl(part: PartDef): string | null {
  if (part.image) return part.image
  if (part.svg) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(part.svg)}`
  return null
}

export function pinLabel(p: PinDef): string {
  return p.id !== p.name ? `${p.name} (${p.id})` : p.name
}
