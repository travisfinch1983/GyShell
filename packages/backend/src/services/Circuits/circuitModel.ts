/**
 * Circuit Designer — design model, edit operations, netlist and design checks.
 *
 * A design is parts placed on a canvas plus wires between part pins. The UI saves whole designs;
 * agents send small atomic OPERATIONS (add_part, connect, ...) so two writers never have to merge
 * whole documents. Both paths go through `normalizeDesign`, so a design on disk always has
 * unique refs, wires that point at real pins, and both views' coordinates.
 */
import type { PartDef, PinDef } from './circuitParts'

export interface Placement { x: number; y: number; rot: number }
export interface PartInstance {
  ref: string
  partId: string
  label?: string
  bb: Placement
  sch: Placement
  props?: Record<string, string>
}
export interface PinRef { ref: string; pin: string }
export interface Wire {
  id: string
  from: PinRef
  to: PinRef
  color?: string
  label?: string
  bbPoints?: Array<[number, number]>
  schPoints?: Array<[number, number]>
}
export interface Design {
  id: string
  name: string
  description?: string
  notes?: string
  parts: PartInstance[]
  wires: Wire[]
  updatedAt?: string
  createdAt?: string
}

export type PartLookup = (partId: string) => PartDef | undefined

const WIRE_COLORS = ['#e5484d', '#1f1f1f', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#f97316']
const rid = () => Math.random().toString(36).slice(2, 8)
export const newWireId = () => `w${Date.now().toString(36)}${rid()}`

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const rot = (v: unknown) => { const r = Math.round(num(v, 0) / 90) * 90; return ((r % 360) + 360) % 360 }

/** Default wire colour by what the wire carries (red = supply, black = ground). */
export function defaultWireColor(a?: PinDef, b?: PinDef, i = 0): string {
  const t = [a?.type, b?.type]
  if (t.includes('ground')) return '#1f1f1f'
  if (t.includes('power')) return '#e5484d'
  return WIRE_COLORS[2 + (i % (WIRE_COLORS.length - 2))]
}

/** Resolve a user / agent pin reference against a part: id, name, GPIO alias ("4" ↔ "GPIO4"), alt function. */
export function resolvePin(part: PartDef, raw: string): PinDef | undefined {
  const q = String(raw).trim()
  const lc = q.toLowerCase()
  const exact = part.pins.find((p) => p.id === q) ?? part.pins.find((p) => p.id.toLowerCase() === lc)
  if (exact) return exact
  const byName = part.pins.filter((p) => p.name.toLowerCase() === lc)
  if (byName.length) return byName[0]
  const m = /^(?:gpio|io|d)?(\d{1,2})$/i.exec(q)
  if (m) {
    const g = `GPIO${Number(m[1])}`
    const hit = part.pins.find((p) => p.id === g) ?? part.pins.find((p) => p.functions?.includes(g))
    if (hit) return hit
  }
  return part.pins.find((p) => p.functions?.some((f) => f.toLowerCase() === lc))
}

/** "U1.GPIO4" / "U1:GPIO4" → { ref, pin } */
export function parsePinRef(s: unknown): PinRef {
  if (s && typeof s === 'object' && 'ref' in (s as any)) return { ref: String((s as any).ref), pin: String((s as any).pin) }
  const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*[.:]\s*(.+?)\s*$/.exec(String(s ?? ''))
  if (!m) throw new Error(`bad pin reference '${String(s)}' — use "REF.PIN", e.g. "U1.GPIO4" or "R1.1"`)
  return { ref: m[1], pin: m[2] }
}

export function nextRef(design: Design, prefix: string): string {
  const used = new Set(design.parts.map((p) => p.ref))
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`
}

/** Pick a free spot to the right of everything already placed (agents rarely care where a part goes). */
function autoPlace(design: Design, part: PartDef, lookup: PartLookup, view: 'bb' | 'sch'): Placement {
  let maxX = 0, minY = Infinity
  for (const p of design.parts) {
    const d = lookup(p.partId)
    const pl = p[view]
    const w = d ? (view === 'bb' ? d.width : schSize(d).w) : 60
    maxX = Math.max(maxX, pl.x + w)
    minY = Math.min(minY, pl.y)
  }
  const x = design.parts.length ? Math.ceil((maxX + 40) / 10) * 10 : 40
  const y = Number.isFinite(minY) ? minY : 40
  void part
  return { x, y, rot: 0 }
}

/** Schematic box size for a part (must match the UI's schematic renderer). */
export function schSize(part: PartDef): { w: number; h: number } {
  const sym = part.schematic?.symbol
  if (sym && sym !== 'box') return { w: 60, h: 40 }
  const left = part.pins.filter((p) => p.side === 'L' || p.side === 'T').length
  const right = part.pins.filter((p) => p.side === 'R' || p.side === 'B').length
  const rows = Math.max(left, right, 1)
  return { w: 140, h: rows * 10 + 30 }
}

/**
 * Make a design consistent: unique refs, known parts, wires only between existing pins (dangling
 * ones are DROPPED and reported, not kept silently), numeric placements.
 */
export function normalizeDesign(input: any, lookup: PartLookup): { design: Design; warnings: string[] } {
  const warnings: string[] = []
  const d: Design = {
    id: String(input?.id ?? ''),
    name: String(input?.name ?? 'Untitled circuit').slice(0, 200) || 'Untitled circuit',
    description: input?.description ? String(input.description).slice(0, 4000) : undefined,
    notes: input?.notes ? String(input.notes).slice(0, 20000) : undefined,
    parts: [],
    wires: [],
    createdAt: input?.createdAt,
  }
  const refs = new Set<string>()
  for (const raw of Array.isArray(input?.parts) ? input.parts : []) {
    const partId = String(raw?.partId ?? '')
    if (!partId) { warnings.push('dropped a part with no partId'); continue }
    if (!lookup(partId)) warnings.push(`part ${raw?.ref ?? '?'} uses unknown part '${partId}' (kept; it renders as a placeholder)`)
    let ref = String(raw?.ref ?? '').trim()
    if (!ref || refs.has(ref) || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(ref)) {
      const prefix = lookup(partId)?.refPrefix ?? 'U'
      const fixed = nextRef({ ...d, parts: d.parts }, prefix)
      if (ref) warnings.push(`ref '${ref}' was duplicate/invalid — renamed ${fixed}`)
      ref = fixed
    }
    refs.add(ref)
    const bb = { x: num(raw?.bb?.x ?? raw?.x, 40), y: num(raw?.bb?.y ?? raw?.y, 40), rot: rot(raw?.bb?.rot ?? raw?.rot) }
    const sch = raw?.sch ? { x: num(raw.sch.x, bb.x), y: num(raw.sch.y, bb.y), rot: rot(raw.sch.rot) } : { ...bb, rot: 0 }
    const inst: PartInstance = { ref, partId, bb, sch }
    if (raw?.label) inst.label = String(raw.label).slice(0, 120)
    if (raw?.props && typeof raw.props === 'object') inst.props = Object.fromEntries(Object.entries(raw.props).map(([k, v]) => [String(k), String(v)]))
    d.parts.push(inst)
  }
  const byRef = new Map(d.parts.map((p) => [p.ref, p]))
  const wireIds = new Set<string>()
  for (const raw of Array.isArray(input?.wires) ? input.wires : []) {
    let from: PinRef, to: PinRef
    try { from = parsePinRef(raw?.from); to = parsePinRef(raw?.to) } catch (e) { warnings.push(`dropped wire: ${(e as Error).message}`); continue }
    const ok = (r: PinRef) => {
      const inst = byRef.get(r.ref)
      if (!inst) return `no part '${r.ref}'`
      const def = lookup(inst.partId)
      if (!def) return null // unknown part: keep its wires, can't validate
      const pin = resolvePin(def, r.pin)
      if (!pin) return `part ${r.ref} has no pin '${r.pin}'`
      r.pin = pin.id
      return null
    }
    const e1 = ok(from), e2 = ok(to)
    if (e1 || e2) { warnings.push(`dropped wire ${raw?.id ?? ''} ${from.ref}.${from.pin} → ${to.ref}.${to.pin}: ${e1 ?? e2}`); continue }
    if (from.ref === to.ref && from.pin === to.pin) { warnings.push(`dropped wire from ${from.ref}.${from.pin} to itself`); continue }
    let id = String(raw?.id ?? '') || newWireId()
    if (wireIds.has(id)) id = newWireId()
    wireIds.add(id)
    const w: Wire = { id, from, to }
    if (raw?.color) w.color = String(raw.color).slice(0, 32)
    if (raw?.label) w.label = String(raw.label).slice(0, 80)
    const pts = (v: unknown) => Array.isArray(v) ? (v as unknown[]).filter((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n))).slice(0, 200) as Array<[number, number]> : undefined
    const bp = pts(raw?.bbPoints), sp = pts(raw?.schPoints)
    if (bp?.length) w.bbPoints = bp
    if (sp?.length) w.schPoints = sp
    d.wires.push(w)
  }
  return { design: d, warnings }
}

// ── operations (the agent write path) ─────────────────────────────────────────────────────────
export type Op =
  | { op: 'add_part'; partId: string; ref?: string; label?: string; x?: number; y?: number; rot?: number; view?: 'bb' | 'sch'; props?: Record<string, string> }
  | { op: 'move_part'; ref: string; x?: number; y?: number; rot?: number; view?: 'bb' | 'sch' }
  | { op: 'remove_part'; ref: string }
  | { op: 'set_part'; ref: string; label?: string; props?: Record<string, string | null>; newRef?: string }
  | { op: 'connect'; from: string | PinRef; to: string | PinRef; color?: string; label?: string }
  | { op: 'disconnect'; wireId?: string; from?: string | PinRef; to?: string | PinRef }
  | { op: 'set_wire'; wireId: string; color?: string; label?: string }
  | { op: 'set_meta'; name?: string; description?: string; notes?: string }
  | { op: 'clear' }

export interface OpResult { op: string; ok: true; detail: string; ref?: string; wireId?: string }

/** Apply ops to a COPY. Throws on the first bad op (the whole batch is atomic). */
export function applyOps(src: Design, ops: Op[], lookup: PartLookup): { design: Design; results: OpResult[] } {
  const d: Design = JSON.parse(JSON.stringify(src))
  const results: OpResult[] = []
  const inst = (ref: string) => {
    const p = d.parts.find((q) => q.ref === ref) ?? d.parts.find((q) => q.ref.toLowerCase() === String(ref).toLowerCase())
    if (!p) throw new Error(`no part '${ref}' in this design (have: ${d.parts.map((q) => q.ref).join(', ') || 'none'})`)
    return p
  }
  const pinOf = (r: PinRef) => {
    const p = inst(r.ref)
    const def = lookup(p.partId)
    if (!def) throw new Error(`part ${p.ref} uses unknown part '${p.partId}'`)
    const pin = resolvePin(def, r.pin)
    if (!pin) throw new Error(`part ${p.ref} (${def.name}) has no pin '${r.pin}'. Pins: ${def.pins.map((q) => q.id).join(', ')}`)
    return { inst: p, def, pin }
  }
  ops.forEach((o, i) => {
    const where = `op #${i + 1} (${(o as any)?.op})`
    try {
      switch (o.op) {
        case 'add_part': {
          const def = lookup(o.partId)
          if (!def) throw new Error(`unknown partId '${o.partId}' — use parts_search to find one`)
          let ref = o.ref?.trim()
          if (ref) {
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(ref)) throw new Error(`bad ref '${ref}'`)
            if (d.parts.some((p) => p.ref === ref)) throw new Error(`ref '${ref}' already used`)
          } else ref = nextRef(d, def.refPrefix || 'U')
          const view = o.view ?? 'bb'
          const auto = autoPlace(d, def, lookup, 'bb')
          const autoS = autoPlace(d, def, lookup, 'sch')
          const given = o.x !== undefined && o.y !== undefined ? { x: num(o.x, 0), y: num(o.y, 0), rot: rot(o.rot) } : null
          const p: PartInstance = {
            ref, partId: def.id,
            bb: view === 'bb' && given ? given : auto,
            sch: view === 'sch' && given ? given : autoS,
          }
          if (o.label) p.label = String(o.label)
          if (o.props) p.props = Object.fromEntries(Object.entries(o.props).map(([k, v]) => [k, String(v)]))
          d.parts.push(p)
          results.push({ op: o.op, ok: true, ref, detail: `added ${ref} = ${def.name}` })
          break
        }
        case 'move_part': {
          const p = inst(o.ref)
          const pl = p[o.view ?? 'bb']
          if (o.x !== undefined) pl.x = num(o.x, pl.x)
          if (o.y !== undefined) pl.y = num(o.y, pl.y)
          if (o.rot !== undefined) pl.rot = rot(o.rot)
          results.push({ op: o.op, ok: true, ref: p.ref, detail: `moved ${p.ref} (${o.view ?? 'bb'}) to ${pl.x},${pl.y} rot ${pl.rot}` })
          break
        }
        case 'remove_part': {
          const p = inst(o.ref)
          const before = d.wires.length
          d.wires = d.wires.filter((w) => w.from.ref !== p.ref && w.to.ref !== p.ref)
          d.parts = d.parts.filter((q) => q !== p)
          results.push({ op: o.op, ok: true, ref: p.ref, detail: `removed ${p.ref} and ${before - d.wires.length} wire(s)` })
          break
        }
        case 'set_part': {
          const p = inst(o.ref)
          if (o.label !== undefined) p.label = o.label || undefined
          if (o.props) {
            p.props = { ...(p.props ?? {}) }
            for (const [k, v] of Object.entries(o.props)) { if (v === null) delete p.props[k]; else p.props[k] = String(v) }
          }
          if (o.newRef && o.newRef !== p.ref) {
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(o.newRef)) throw new Error(`bad ref '${o.newRef}'`)
            if (d.parts.some((q) => q.ref === o.newRef)) throw new Error(`ref '${o.newRef}' already used`)
            for (const w of d.wires) { if (w.from.ref === p.ref) w.from.ref = o.newRef; if (w.to.ref === p.ref) w.to.ref = o.newRef }
            p.ref = o.newRef
          }
          results.push({ op: o.op, ok: true, ref: p.ref, detail: `updated ${p.ref}` })
          break
        }
        case 'connect': {
          const a = pinOf(parsePinRef(o.from)), b = pinOf(parsePinRef(o.to))
          if (a.inst === b.inst && a.pin.id === b.pin.id) throw new Error('cannot wire a pin to itself')
          const dup = d.wires.find((w) =>
            (w.from.ref === a.inst.ref && w.from.pin === a.pin.id && w.to.ref === b.inst.ref && w.to.pin === b.pin.id) ||
            (w.to.ref === a.inst.ref && w.to.pin === a.pin.id && w.from.ref === b.inst.ref && w.from.pin === b.pin.id))
          if (dup) { results.push({ op: o.op, ok: true, wireId: dup.id, detail: `already connected (${dup.id})` }); break }
          const w: Wire = { id: newWireId(), from: { ref: a.inst.ref, pin: a.pin.id }, to: { ref: b.inst.ref, pin: b.pin.id }, color: o.color || defaultWireColor(a.pin, b.pin, d.wires.length) }
          if (o.label) w.label = String(o.label)
          d.wires.push(w)
          results.push({ op: o.op, ok: true, wireId: w.id, detail: `wired ${a.inst.ref}.${a.pin.id} → ${b.inst.ref}.${b.pin.id}` })
          break
        }
        case 'disconnect': {
          let ids: string[] = []
          if (o.wireId) ids = d.wires.filter((w) => w.id === o.wireId).map((w) => w.id)
          else if (o.from) {
            const a = pinOf(parsePinRef(o.from))
            const b = o.to ? pinOf(parsePinRef(o.to)) : null
            const at = (r: PinRef, x: { inst: PartInstance; pin: PinDef }) => r.ref === x.inst.ref && r.pin === x.pin.id
            ids = d.wires.filter((w) => b
              ? (at(w.from, a) && at(w.to, b)) || (at(w.to, a) && at(w.from, b))
              : at(w.from, a) || at(w.to, a)).map((w) => w.id)
          } else throw new Error('disconnect needs wireId, or from (and optionally to)')
          if (!ids.length) throw new Error('no matching wire')
          d.wires = d.wires.filter((w) => !ids.includes(w.id))
          results.push({ op: o.op, ok: true, detail: `removed ${ids.length} wire(s): ${ids.join(', ')}` })
          break
        }
        case 'set_wire': {
          const w = d.wires.find((q) => q.id === o.wireId)
          if (!w) throw new Error(`no wire '${o.wireId}'`)
          if (o.color !== undefined) w.color = o.color || undefined
          if (o.label !== undefined) w.label = o.label || undefined
          results.push({ op: o.op, ok: true, wireId: w.id, detail: `updated wire ${w.id}` })
          break
        }
        case 'set_meta': {
          if (o.name !== undefined) d.name = String(o.name).slice(0, 200) || d.name
          if (o.description !== undefined) d.description = String(o.description).slice(0, 4000) || undefined
          if (o.notes !== undefined) d.notes = String(o.notes).slice(0, 20000) || undefined
          results.push({ op: o.op, ok: true, detail: 'updated design info' })
          break
        }
        case 'clear': {
          d.parts = []; d.wires = []
          results.push({ op: o.op, ok: true, detail: 'cleared all parts and wires' })
          break
        }
        default:
          throw new Error(`unknown op '${(o as any)?.op}'`)
      }
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`)
    }
  })
  return { design: d, results }
}

// ── netlist ───────────────────────────────────────────────────────────────────────────────────
export interface NetNode { ref: string; pin: string; pinName: string; partName: string; type: string }
export interface Net { name: string; nodes: NetNode[]; labels: string[] }

export function netlist(d: Design, lookup: PartLookup): Net[] {
  const parent = new Map<string, string>()
  const key = (ref: string, pin: string) => `${ref}\u0000${pin}`
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; let c = k; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n } return r }
  const add = (k: string) => { if (!parent.has(k)) parent.set(k, k) }
  const union = (a: string, b: string) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  const labels = new Map<string, string[]>()
  for (const w of d.wires) {
    const a = key(w.from.ref, w.from.pin), b = key(w.to.ref, w.to.pin)
    union(a, b)
    if (w.label) labels.set(a, [...(labels.get(a) ?? []), w.label])
  }
  // Internal buses (all GND pins on a board) join nets — but only pins that are actually wired.
  for (const p of d.parts) {
    const def = lookup(p.partId)
    for (const bus of def?.buses ?? []) {
      const wired = bus.map((pin) => key(p.ref, pin)).filter((k) => parent.has(k))
      for (let i = 1; i < wired.length; i++) union(wired[0], wired[i])
    }
  }
  const groups = new Map<string, string[]>()
  for (const k of parent.keys()) { const r = find(k); groups.set(r, [...(groups.get(r) ?? []), k]) }
  const nets: Net[] = []
  for (const ks of groups.values()) {
    const nodes: NetNode[] = ks.map((k) => {
      const [ref, pin] = k.split('\u0000')
      const inst = d.parts.find((p) => p.ref === ref)
      const def = inst ? lookup(inst.partId) : undefined
      const pd = def?.pins.find((q) => q.id === pin)
      return { ref, pin, pinName: pd?.name ?? pin, partName: def?.name ?? inst?.partId ?? '?', type: pd?.type ?? 'other' }
    }).sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.pin.localeCompare(b.pin))
    const lbls = [...new Set(ks.flatMap((k) => labels.get(k) ?? []))]
    nets.push({ name: '', nodes, labels: lbls })
  }
  // Name nets: explicit wire label > ground > supply voltage > first microcontroller pin > first node.
  const used = new Set<string>()
  const uniq = (n: string) => { let s = n, i = 2; while (used.has(s)) s = `${n}_${i++}`; used.add(s); return s }
  for (const n of nets) {
    let name = n.labels[0]
    if (!name && n.nodes.some((x) => x.type === 'ground')) name = 'GND'
    if (!name) {
      const pw = n.nodes.find((x) => x.type === 'power')
      if (pw) {
        const inst = d.parts.find((p) => p.ref === pw.ref)
        const v = inst ? lookup(inst.partId)?.pins.find((q) => q.id === pw.pin)?.voltage : undefined
        name = v !== undefined ? `+${v}V` : pw.pinName
      }
    }
    if (!name) {
      const mcu = n.nodes.find((x) => /^GPIO\d+$/.test(x.pin))
      name = mcu ? `${mcu.ref}_${mcu.pin}` : `${n.nodes[0].ref}_${n.nodes[0].pin}`
    }
    n.name = uniq(name)
  }
  nets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return nets
}

// ── design checks ─────────────────────────────────────────────────────────────────────────────
export interface Finding { level: 'error' | 'warning' | 'info'; message: string; refs: string[] }

export function checkDesign(d: Design, lookup: PartLookup): Finding[] {
  const out: Finding[] = []
  const nets = netlist(d, lookup)
  const pinDef = (ref: string, pin: string) => {
    const inst = d.parts.find((p) => p.ref === ref)
    return inst ? lookup(inst.partId)?.pins.find((q) => q.id === pin) : undefined
  }
  for (const p of d.parts) if (!lookup(p.partId)) out.push({ level: 'error', message: `${p.ref}: part '${p.partId}' is not in the library`, refs: [p.ref] })

  for (const net of nets) {
    const defs = net.nodes.map((n) => ({ n, p: pinDef(n.ref, n.pin) }))
    const grounds = defs.filter((x) => x.p?.type === 'ground')
    const supplies = defs.filter((x) => x.p?.type === 'power' && x.p.voltage !== undefined)
    const volts = [...new Set(supplies.map((x) => x.p!.voltage!))]
    const tag = (xs: typeof defs) => xs.map((x) => `${x.n.ref}.${x.n.pinName}`).join(', ')
    if (grounds.length && supplies.length) out.push({ level: 'error', message: `Short: ground tied to supply on net ${net.name} (${tag([...grounds, ...supplies])})`, refs: [...new Set(defs.map((x) => x.n.ref))] })
    // Two different supply outputs on one net. Inputs like a module's VIN carry a nominal voltage too,
    // so this is a warning, not an error.
    if (volts.length > 1) out.push({ level: 'warning', message: `Net ${net.name} joins pins rated ${volts.map((v) => `${v} V`).join(' and ')} (${tag(supplies)}) — check the module accepts that voltage`, refs: [...new Set(supplies.map((x) => x.n.ref))] })
    const highV = Math.max(...supplies.map((x) => x.p!.voltage!), -Infinity)
    for (const { n, p } of defs) {
      if (!p) continue
      const flags = p.flags ?? []
      const at = `${n.ref}.${p.name}${p.id !== p.name ? ` (${p.id})` : ''}`
      if (flags.includes('flash')) out.push({ level: 'error', message: `${at} is wired to the on-module SPI flash — using it will crash the chip`, refs: [n.ref] })
      if (highV > 3.6 && ['gpio', 'input', 'analog'].includes(p.type) && /^GPIO\d+$/.test(p.id)) out.push({ level: 'error', message: `${at} is on a ${highV} V net — ESP32 GPIOs are 3.3 V only (use a divider or level shifter)`, refs: [n.ref] })
      if (flags.includes('strapping')) out.push({ level: 'warning', message: `${at} is a strapping pin — whatever it connects to must not pull it the wrong way at boot (${p.notes ?? 'see datasheet'})`, refs: [n.ref] })
      if (flags.includes('psram-octal')) out.push({ level: 'warning', message: `${at} is used by octal PSRAM on N8R8/N16R8 modules — avoid on those`, refs: [n.ref] })
      if (flags.includes('usb')) out.push({ level: 'info', message: `${at} is a native-USB data line — using it disables USB-JTAG/serial`, refs: [n.ref] })
      if (flags.includes('uart0')) out.push({ level: 'info', message: `${at} is UART0 (USB serial / logs) — it will see traffic during flashing`, refs: [n.ref] })
      if (flags.includes('input-only')) {
        const drivesOut = defs.some((x) => x !== defs.find((y) => y.p === p) && (x.p?.type === 'input'))
        if (drivesOut) out.push({ level: 'error', message: `${at} is INPUT-ONLY but is wired to an input pin (${tag(defs.filter((x) => x.p?.type === 'input'))}) — it cannot drive it`, refs: [n.ref] })
      }
      if (flags.includes('adc2') && defs.some((x) => x.p?.type === 'analog'))
        out.push({ level: 'info', message: `${at} is ADC2 — analog reads fail while Wi-Fi is on; prefer an ADC1 pin`, refs: [n.ref] })
    }
  }
  // I2C address clashes: same bus (SDA net) with overlapping fixed addresses.
  const sdaNets = new Map<string, Array<{ ref: string; addrs: string[] }>>()
  for (const net of nets) {
    const devs = net.nodes.filter((n) => /^SDA$/i.test(n.pinName))
    for (const dv of devs) {
      const inst = d.parts.find((p) => p.ref === dv.ref)
      const def = inst ? lookup(inst.partId) : undefined
      const addrs = (inst?.props?.i2cAddress ? [inst.props.i2cAddress] : (def?.props?.i2cAddress as string[] | undefined)) ?? []
      if (addrs.length) sdaNets.set(net.name, [...(sdaNets.get(net.name) ?? []), { ref: dv.ref, addrs }])
    }
  }
  for (const [net, devs] of sdaNets) {
    for (let i = 0; i < devs.length; i++) for (let j = i + 1; j < devs.length; j++) {
      const a = devs[i], b = devs[j]
      const aFixed = a.addrs.length === 1 ? a.addrs : null, bFixed = b.addrs.length === 1 ? b.addrs : null
      const overlap = a.addrs.filter((x) => b.addrs.includes(x))
      if (overlap.length && (aFixed || bFixed || a.addrs[0] === b.addrs[0]))
        out.push({ level: 'warning', message: `I2C bus ${net}: ${a.ref} and ${b.ref} can both answer at ${overlap.join('/')} — set different addresses (part property i2cAddress)`, refs: [a.ref, b.ref] })
    }
  }
  // Unpowered modules: a part with power/ground pins where none of them is wired.
  for (const p of d.parts) {
    const def = lookup(p.partId)
    if (!def) continue
    const wired = new Set(d.wires.flatMap((w) => [w.from, w.to]).filter((r) => r.ref === p.ref).map((r) => r.pin))
    if (!wired.size) { out.push({ level: 'info', message: `${p.ref} (${def.name}) has nothing connected`, refs: [p.ref] }); continue }
    const pw = def.pins.filter((q) => q.type === 'power'), gnd = def.pins.filter((q) => q.type === 'ground')
    if (pw.length && !pw.some((q) => wired.has(q.id)) && !/supply|regulator|buck/i.test(def.name)) out.push({ level: 'warning', message: `${p.ref} (${def.name}) has no power pin connected`, refs: [p.ref] })
    if (gnd.length && !gnd.some((q) => wired.has(q.id))) out.push({ level: 'warning', message: `${p.ref} (${def.name}) has no ground connected`, refs: [p.ref] })
  }
  const order = { error: 0, warning: 1, info: 2 }
  // de-duplicate identical messages
  const seen = new Set<string>()
  return out.filter((f) => (seen.has(f.message) ? false : (seen.add(f.message), true))).sort((a, b) => order[a.level] - order[b.level])
}

// ── exports ───────────────────────────────────────────────────────────────────────────────────
export function bom(d: Design, lookup: PartLookup) {
  const rows = new Map<string, { partId: string; name: string; value: string; refs: string[] }>()
  for (const p of d.parts) {
    const def = lookup(p.partId)
    const value = p.props?.value ?? (def?.props?.value as string | undefined) ?? ''
    const k = `${p.partId}|${value}`
    const r = rows.get(k) ?? { partId: p.partId, name: def?.name ?? p.partId, value, refs: [] }
    r.refs.push(p.ref)
    rows.set(k, r)
  }
  return [...rows.values()].map((r) => ({ ...r, qty: r.refs.length, refs: r.refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }))
}

/** Which MCU GPIO each peripheral pin lands on — the bit you paste into ESPHome / firmware. */
export function pinAssignments(d: Design, lookup: PartLookup) {
  const nets = netlist(d, lookup)
  const out: Array<{ mcu: string; gpio: string; net: string; connectsTo: string[] }> = []
  for (const net of nets) {
    const mcuPins = net.nodes.filter((n) => /^GPIO\d+$/.test(n.pin))
    for (const m of mcuPins) {
      const others = net.nodes.filter((n) => n !== m && !/^GPIO\d+$/.test(n.pin)).map((n) => `${n.ref}.${n.pin}`)
      out.push({ mcu: m.ref, gpio: m.pin, net: net.name, connectsTo: others })
    }
  }
  return out.sort((a, b) => a.mcu.localeCompare(b.mcu) || Number(a.gpio.slice(4)) - Number(b.gpio.slice(4)))
}

export function exportText(d: Design, lookup: PartLookup, format: string): string {
  const nets = netlist(d, lookup)
  if (format === 'netlist') {
    const show = (x: NetNode) => `${x.ref}.${x.pinName}${x.pin !== x.pinName ? ` (${x.pin})` : ''}`
    return nets.map((n) => `${n.name}: ${n.nodes.map(show).join(', ')}`).join('\n')
  }
  if (format === 'bom') {
    const rows = bom(d, lookup)
    return ['Qty\tRefs\tPart\tValue', ...rows.map((r) => `${r.qty}\t${r.refs.join(' ')}\t${r.name}\t${r.value}`)].join('\n')
  }
  const assigns = pinAssignments(d, lookup)
  const ident = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase() || 'PIN'
  if (format === 'arduino') {
    return [`// ${d.name} — pin map generated by AI-Lab Circuit Designer`, ...assigns.map((a) => `#define ${ident(a.connectsTo[0] ?? a.net)} ${a.gpio.slice(4)}  // ${a.gpio} → ${a.connectsTo.join(', ') || a.net}`)].join('\n')
  }
  if (format === 'esphome') {
    return [`# ${d.name} — pin map generated by AI-Lab Circuit Designer`, 'substitutions:', ...assigns.map((a) => `  ${ident(a.connectsTo[0] ?? a.net).toLowerCase()}_pin: ${a.gpio}  # → ${a.connectsTo.join(', ') || a.net}`)].join('\n')
  }
  throw new Error(`unknown export format '${format}' (netlist | bom | arduino | esphome)`)
}
