// @ts-expect-error — express ships untyped in this repo (same pattern as flowchartsHttp)
import express from 'express'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { builtinParts, type PartDef, type PinDef, type PinType, type PinSide } from '../Circuits/circuitParts'
import { normalizeDesign, applyOps, netlist, checkDesign, exportText, bom, pinAssignments, type Design, type Op } from '../Circuits/circuitModel'

type Req = express.Request
type Res = express.Response

/**
 * Circuit Designer store (Diagrams → Circuit Designer tab, and the ailab-circuits MCP server).
 *
 *   <dataDir>/circuits/designs/<id>.json   designs
 *   <dataDir>/circuits/parts/<id>.json     custom parts (built-ins live in code: circuitParts.ts)
 *   <dataDir>/circuits/fritzing/<id>.json  imported Fritzing library (read-only; regenerate with
 *                                          infra/circuits/import-fritzing.mjs)
 *   <dataDir>/circuits/trash/              deleted designs/parts land here, never unlinked
 *
 * Two write paths: the UI PUTs whole designs with `baseUpdatedAt` (409 if someone else wrote since),
 * agents POST atomic `ops`. Every read-modify-write below is synchronous, so two writers in this
 * process cannot interleave inside one.
 */
export function createCircuitsRouter(dataDir: string): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '24mb' })
  const root = path.join(dataDir, 'circuits')
  const dDir = path.join(root, 'designs'), pDir = path.join(root, 'parts'), trash = path.join(root, 'trash')
  const fDir = path.join(root, 'fritzing')
  const ensure = () => { for (const d of [dDir, pDir, trash]) if (!existsSync(d)) mkdirSync(d, { recursive: true }) }
  const safe = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)
  const dFile = (id: string) => path.join(dDir, `${id}.json`)
  const pFile = (id: string) => path.join(pDir, `${id}.json`)
  const writeAtomic = (f: string, data: unknown) => { const t = `${f}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(data, null, 2)); renameSync(t, f) }
  const err = (res: Res, code: number, e: unknown) => res.status(code).json({ error: String((e as Error)?.message ?? e) })
  const slug = (s: string) => String(s || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x'

  // ── parts ──────────────────────────────────────────────────────────────────────────────────
  const builtinIds = () => new Set(builtinParts().map((p) => p.id))
  /**
   * Parts directories are read once and cached until the directory changes (custom parts are
   * written by rename, which bumps the dir mtime; a Fritzing re-import swaps the whole dir).
   * The Fritzing library is ~2k parts / ~150 MB of SVG, so re-reading it per request is not an
   * option — and its art is not cached either: only GET /parts/:id returns it, read from disk.
   */
  const dirCache = new Map<string, { stamp: string; parts: PartDef[] }>()
  const readPartsDir = (dir: string, source: PartDef['source']): PartDef[] => {
    if (!existsSync(dir)) return []
    let stamp: string
    try {
      const st = statSync(dir)
      const rep = path.join(dir, '_report.json')
      stamp = `${st.ino}:${st.mtimeMs}:${existsSync(rep) ? statSync(rep).mtimeMs : 0}`
    } catch (e) { console.warn(`[circuits] cannot stat ${dir}: ${(e as Error).message}`); return [] }
    const hit = dirCache.get(dir)
    if (hit && hit.stamp === stamp) return hit.parts
    const out: PartDef[] = []
    const t0 = Date.now()
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue
      try {
        const p = { ...JSON.parse(readFileSync(path.join(dir, f), 'utf8')), source }
        // imported art is ~150 MB in all: keep metadata + pins in memory, read the art per request
        if (source === 'fritzing') { delete p.svg; delete p.image }
        out.push(p)
      }
      catch (e) { console.warn(`[circuits] unreadable ${source} part ${f}: ${(e as Error).message}`) }
    }
    dirCache.set(dir, { stamp, parts: out })
    if (source === 'fritzing') console.log(`[circuits] loaded ${out.length} Fritzing parts in ${Date.now() - t0} ms`)
    return out
  }
  const customParts = (): PartDef[] => { ensure(); return readPartsDir(pDir, 'custom') }
  const fritzingParts = (): PartDef[] => readPartsDir(fDir, 'fritzing')
  const fritzingIds = () => new Set(fritzingParts().map((p) => p.id))
  const allParts = (): PartDef[] => [...builtinParts(), ...customParts(), ...fritzingParts()]
  /** Palette entry for a big imported part: everything but the art and pin list (fetched on use). */
  const lite = (p: PartDef) => {
    const { svg: _svg, image: _image, pins, buses: _buses, ...rest } = p
    return { ...rest, description: clip(rest.description, 300), pins: [], pinCount: pins.length, lite: true }
  }
  // Fritzing parts and big-art built-ins (the traced dev boards, 80-290 KB each) ship lite in the palette list;
  // the UI fetches the full part from GET /parts/:id when it is placed.
  const heavy = (p: PartDef) => p.source === 'fritzing' || (p.svg?.length ?? 0) + (p.image?.length ?? 0) > 50_000
  const lookupFrom = (parts: PartDef[]) => { const m = new Map(parts.map((p) => [p.id, p])); return (id: string) => m.get(id) }
  const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
  const summary = (p: PartDef) => ({
    id: p.id, name: p.name, category: p.category, refPrefix: p.refPrefix, source: p.source, description: clip(p.description, 240), tags: p.tags,
    pinCount: (p as any).pinCount ?? p.pins.length, width: p.width, height: p.height,
  })

  router.get('/api/circuits/parts', (req: Req, res: Res) => {
    try {
      const q = String(req.query.q ?? '').trim().toLowerCase()
      const cat = String(req.query.category ?? '').trim().toLowerCase()
      let parts = allParts()
      if (cat) parts = parts.filter((p) => p.category.toLowerCase() === cat)
      if (q) {
        const terms = q.split(/\s+/)
        parts = parts.filter((p) => {
          const hay = [p.id, p.name, p.category, p.description ?? '', ...(p.tags ?? []), ...p.pins.flatMap((x) => [x.id, x.name, ...(x.functions ?? [])])].join(' ').toLowerCase()
          return terms.every((t) => hay.includes(t))
        })
      }
      const limit = Number(req.query.limit) || 0
      const total = parts.length
      if (limit > 0) {
        // our own parts first (built-in, custom, then the Fritzing import); within each, parts whose
        // NAME matches the query beat ones that only mention it in tags or a long description
        const terms = q ? q.split(/\s+/) : []
        const rank = (p: PartDef) => {
          const src = p.source === 'builtin' ? 0 : p.source === 'custom' ? 1 : 2
          const nm = p.name.toLowerCase(), meta = [p.id, p.category, ...(p.tags ?? [])].join(' ').toLowerCase()
          const fit = !terms.length || terms.every((t) => nm.includes(t)) ? 0 : terms.every((t) => nm.includes(t) || meta.includes(t)) ? 1 : 2
          return fit * 3 + src
        }
        parts = parts.map((p) => ({ p, r: rank(p) })).sort((a, b) => a.r - b.r).map((x) => x.p).slice(0, limit)
      }
      const shaped = req.query.summary ? parts.map(summary) : req.query.lite ? parts.map((p) => (heavy(p) ? lite(p) : p)) : parts
      res.json({ parts: shaped, total })
    } catch (e) { err(res, 500, e) }
  })

  router.get('/api/circuits/parts/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    const p = allParts().find((x) => x.id === id)
    if (!p) return err(res, 404, `no part '${id}'`)
    if (p.source === 'fritzing') {
      try {
        const disk = JSON.parse(readFileSync(path.join(fDir, `${id}.json`), 'utf8'))
        return res.json({ part: { ...p, svg: disk.svg, image: disk.image } })
      } catch (e) { return err(res, 500, `Fritzing part '${id}' art unreadable: ${(e as Error).message}`) }
    }
    res.json({ part: p })
  })

  const PIN_TYPES: PinType[] = ['power', 'ground', 'gpio', 'input', 'output', 'analog', 'passive', 'nc', 'other']
  const SIDES: PinSide[] = ['L', 'R', 'T', 'B']
  function validatePart(body: any, id: string): PartDef {
    const name = String(body?.name ?? '').trim()
    if (!name) throw new Error('name is required')
    const width = Number(body?.width), height = Number(body?.height)
    if (!(width >= 5 && width <= 3000 && height >= 5 && height <= 3000)) throw new Error('width/height must be 5..3000 units (10 units = 0.1")')
    if (!Array.isArray(body?.pins) || !body.pins.length) throw new Error('pins must be a non-empty array')
    if (body.pins.length > 400) throw new Error('at most 400 pins')
    const ids = new Set<string>()
    const pins: PinDef[] = body.pins.map((raw: any, i: number) => {
      const pid = String(raw?.id ?? raw?.name ?? '').trim()
      if (!pid || pid.length > 40) throw new Error(`pin #${i + 1}: id/name required (≤40 chars)`)
      if (ids.has(pid)) throw new Error(`pin id '${pid}' is used twice`)
      ids.add(pid)
      const x = Number(raw?.x), y = Number(raw?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`pin '${pid}': x and y are required numbers`)
      const type = PIN_TYPES.includes(raw?.type) ? raw.type : 'passive'
      let side: PinSide = SIDES.includes(raw?.side) ? raw.side : 'L'
      if (!SIDES.includes(raw?.side)) {
        // infer from the nearest edge
        const d = { L: x, R: width - x, T: y, B: height - y }
        side = (Object.entries(d).sort((a, b) => a[1] - b[1])[0][0]) as PinSide
      }
      const p: PinDef = { id: pid, name: String(raw?.name ?? pid).slice(0, 40), x, y, side, type }
      if (Array.isArray(raw?.functions) && raw.functions.length) p.functions = raw.functions.map(String).slice(0, 20)
      if (Array.isArray(raw?.flags) && raw.flags.length) p.flags = raw.flags.map(String).slice(0, 20)
      if (raw?.voltage !== undefined && raw.voltage !== null && raw.voltage !== '' && Number.isFinite(Number(raw.voltage))) p.voltage = Number(raw.voltage)
      if (raw?.notes) p.notes = String(raw.notes).slice(0, 1000)
      return p
    })
    const part: PartDef = {
      id, name: name.slice(0, 120), category: String(body?.category ?? 'Custom').slice(0, 60) || 'Custom',
      refPrefix: /^[A-Z]{1,3}$/.test(String(body?.refPrefix ?? '')) ? body.refPrefix : 'U',
      description: body?.description ? String(body.description).slice(0, 4000) : undefined,
      tags: Array.isArray(body?.tags) ? body.tags.map(String).slice(0, 30) : undefined,
      source: 'custom', width, height, pins,
    }
    if (typeof body?.svg === 'string' && body.svg.trim()) {
      if (body.svg.length > 4_000_000) throw new Error('svg too large (4 MB max)')
      if (!/<svg[\s>]/i.test(body.svg)) throw new Error('svg must be an <svg> document')
      part.svg = body.svg
    }
    if (typeof body?.image === 'string' && body.image) {
      if (body.image.length > 16_000_000) throw new Error('image too large (~12 MB max)')
      if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/.test(body.image)) throw new Error('image must be a data: URL (png, jpeg, webp, gif or svg)')
      part.image = body.image
    }
    if (!part.svg && !part.image) throw new Error('give the part art: svg (an <svg> document) or image (data: URL)')
    if (Array.isArray(body?.buses)) part.buses = body.buses.filter((b: unknown) => Array.isArray(b)).map((b: unknown[]) => b.map(String).filter((x) => ids.has(x))).filter((b: string[]) => b.length > 1)
    if (body?.schematic?.symbol) part.schematic = { symbol: body.schematic.symbol }
    if (body?.props && typeof body.props === 'object') part.props = body.props
    if (body?.license) part.license = String(body.license).slice(0, 200)
    return part
  }

  /** Create (POST, id from name) or replace (PUT) a custom part. Built-in ids are read-only. */
  const savePart = (id: string, body: any, mustBeNew: boolean, res: Res) => {
    try {
      ensure()
      if (builtinIds().has(id)) return err(res, 409, `'${id}' is a built-in part and cannot be overwritten — save it under a new id`)
      if (fritzingIds().has(id)) return err(res, 409, `'${id}' is an imported Fritzing part and is read-only — save a copy under a new id`)
      if (mustBeNew && existsSync(pFile(id))) return err(res, 409, `custom part '${id}' already exists`)
      const part = { ...validatePart(body, id), updatedAt: new Date().toISOString() }
      writeAtomic(pFile(id), part)
      res.json({ ok: true, part })
    } catch (e) { err(res, 400, e) }
  }
  router.post('/api/circuits/parts', json, (req: Req, res: Res) => {
    const id = safe(req.body?.id) ? req.body.id : `custom-${slug(req.body?.name)}`
    savePart(id, req.body, true, res)
  })
  router.put('/api/circuits/parts/:id', json, (req: Req, res: Res) => {
    if (!safe(req.params.id)) return err(res, 400, 'bad id')
    savePart(req.params.id, req.body, false, res)
  })
  router.delete('/api/circuits/parts/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    if (builtinIds().has(id)) return err(res, 409, 'built-in parts cannot be deleted')
    if (fritzingIds().has(id)) return err(res, 409, 'imported Fritzing parts cannot be deleted one by one — they come from the library import')
    try {
      ensure()
      if (!existsSync(pFile(id))) return err(res, 404, `no custom part '${id}'`)
      const used = listDesigns().filter((d) => readDesign(d.id)?.parts.some((p) => p.partId === id)).map((d) => d.name)
      renameSync(pFile(id), path.join(trash, `part-${id}-${Date.now()}.json`))
      res.json({ ok: true, stillUsedBy: used })
    } catch (e) { err(res, 500, e) }
  })

  // ── designs ────────────────────────────────────────────────────────────────────────────────
  const readDesign = (id: string): Design | null => {
    if (!existsSync(dFile(id))) return null
    return JSON.parse(readFileSync(dFile(id), 'utf8'))
  }
  function listDesigns() {
    ensure()
    return readdirSync(dDir).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const d = JSON.parse(readFileSync(path.join(dDir, f), 'utf8')) as Design
        return { id: d.id || f.replace(/\.json$/, ''), name: d.name, description: d.description, updatedAt: d.updatedAt, parts: d.parts?.length ?? 0, wires: d.wires?.length ?? 0 }
      } catch (e) { console.warn(`[circuits] unreadable design ${f}: ${(e as Error).message}`); return null }
    }).filter(Boolean).sort((a: any, b: any) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))) as Array<{ id: string; name: string; description?: string; updatedAt?: string; parts: number; wires: number }>
  }
  const newDesignId = (name: string) => `${slug(name)}-${Date.now().toString(36)}`.slice(0, 80)

  router.get('/api/circuits/designs', (_req: Req, res: Res) => {
    try { res.json({ designs: listDesigns() }) } catch (e) { err(res, 500, e) }
  })

  router.post('/api/circuits/designs', json, (req: Req, res: Res) => {
    try {
      ensure()
      const lookup = lookupFrom(allParts())
      const id = safe(req.body?.id) ? req.body.id : newDesignId(req.body?.name ?? 'circuit')
      if (existsSync(dFile(id))) return err(res, 409, `design '${id}' already exists`)
      const { design, warnings } = normalizeDesign({ ...(req.body ?? {}), id }, lookup)
      const now = new Date().toISOString()
      const out = { ...design, id, createdAt: now, updatedAt: now }
      writeAtomic(dFile(id), out)
      res.json({ ok: true, design: out, warnings })
    } catch (e) { err(res, 400, e) }
  })

  router.get('/api/circuits/designs/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    try {
      const d = readDesign(id)
      if (!d) return err(res, 404, `no design '${id}'`)
      res.json({ design: d })
    } catch (e) { err(res, 500, e) }
  })

  /** Cheap poll for the open editor: has anyone else written this design? */
  router.get('/api/circuits/designs/:id/version', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    try {
      const d = readDesign(id)
      if (!d) return err(res, 404, `no design '${id}'`)
      res.json({ updatedAt: d.updatedAt ?? null, by: (d as any).updatedBy ?? null })
    } catch (e) { err(res, 500, e) }
  })

  router.put('/api/circuits/designs/:id', json, (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    try {
      ensure()
      const { baseUpdatedAt, ...rest } = (req.body ?? {}) as Record<string, unknown>
      const cur = readDesign(id)
      // Same contract as the flowchart store: baseUpdatedAt = the version this editor loaded
      // (null = creating). Absent = unchecked writer.
      if (baseUpdatedAt !== undefined) {
        const stored = cur ? (cur.updatedAt ?? 'unknown') : null
        if ((baseUpdatedAt ?? null) !== stored) return res.status(409).json({ error: `conflict: design '${id}' changed since this editor loaded it`, current: stored })
      }
      const lookup = lookupFrom(allParts())
      const { design, warnings } = normalizeDesign({ ...rest, id, createdAt: cur?.createdAt ?? new Date().toISOString() }, lookup)
      const out = { ...design, id, updatedAt: new Date().toISOString(), updatedBy: String(req.body?.updatedBy ?? 'ui').slice(0, 60) }
      writeAtomic(dFile(id), out)
      res.json({ ok: true, design: out, warnings })
    } catch (e) { err(res, 400, e) }
  })

  router.delete('/api/circuits/designs/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    try {
      ensure()
      if (!existsSync(dFile(id))) return err(res, 404, `no design '${id}'`)
      const to = path.join(trash, `design-${id}-${Date.now()}.json`)
      renameSync(dFile(id), to)
      res.json({ ok: true, trashed: to })
    } catch (e) { err(res, 500, e) }
  })

  /** Agent write path: atomic batch of operations applied to the CURRENT stored design. */
  router.post('/api/circuits/designs/:id/ops', json, (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    try {
      const ops = req.body?.ops as Op[]
      if (!Array.isArray(ops) || !ops.length) return err(res, 400, 'ops must be a non-empty array')
      if (ops.length > 500) return err(res, 400, 'at most 500 ops per call')
      const cur = readDesign(id)
      if (!cur) return err(res, 404, `no design '${id}'`)
      if (req.body?.baseUpdatedAt !== undefined && req.body.baseUpdatedAt !== cur.updatedAt) return res.status(409).json({ error: 'conflict: design changed since baseUpdatedAt', current: cur.updatedAt })
      const lookup = lookupFrom(allParts())
      let applied
      try { applied = applyOps(cur, ops, lookup) } catch (e) { return err(res, 400, e) }
      const { design, warnings } = normalizeDesign(applied.design, lookup)
      const out = { ...design, id, createdAt: cur.createdAt, updatedAt: new Date().toISOString(), updatedBy: String(req.body?.actor ?? 'agent').slice(0, 60) }
      writeAtomic(dFile(id), out)
      res.json({ ok: true, results: applied.results, warnings, updatedAt: out.updatedAt, parts: out.parts.length, wires: out.wires.length })
    } catch (e) { err(res, 500, e) }
  })

  router.get('/api/circuits/designs/:id/netlist', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    try {
      const d = readDesign(id)
      if (!d) return err(res, 404, `no design '${id}'`)
      const lookup = lookupFrom(allParts())
      res.json({ nets: netlist(d, lookup), pinAssignments: pinAssignments(d, lookup), bom: bom(d, lookup) })
    } catch (e) { err(res, 500, e) }
  })

  router.get('/api/circuits/designs/:id/check', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    try {
      const d = readDesign(id)
      if (!d) return err(res, 404, `no design '${id}'`)
      res.json({ findings: checkDesign(d, lookupFrom(allParts())) })
    } catch (e) { err(res, 500, e) }
  })

  /** Check an UNSAVED design (the editor's live state). */
  router.post('/api/circuits/check', json, (req: Req, res: Res) => {
    try {
      const lookup = lookupFrom(allParts())
      const { design } = normalizeDesign(req.body?.design ?? {}, lookup)
      res.json({ findings: checkDesign(design, lookup), nets: netlist(design, lookup) })
    } catch (e) { err(res, 400, e) }
  })

  router.get('/api/circuits/designs/:id/export', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return err(res, 400, 'bad id')
    try {
      const d = readDesign(id)
      if (!d) return err(res, 404, `no design '${id}'`)
      res.json({ format: String(req.query.format ?? 'netlist'), text: exportText(d, lookupFrom(allParts()), String(req.query.format ?? 'netlist')) })
    } catch (e) { err(res, 400, e) }
  })

  return router
}
