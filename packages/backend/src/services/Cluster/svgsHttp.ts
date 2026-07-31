import express from 'express'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import path from 'path'

type Req = express.Request
type Res = express.Response

/**
 * SVG store + rasterizer. Drawings are plain .svg files under <dataDir>/svgs/<id>.svg and are
 * edited in the AI-Lab "SVG" tab (self-hosted svgedit) or written by the svg_* MCP tools —
 * one store, both authors, same as flowcharts.
 *
 * THE FILENAME IS THE ID. The flowchart list endpoint used to read `id` from inside the file,
 * so anything whose contents disagreed with its name listed under the wrong id and could not
 * be opened. Nothing here consults the document for identity.
 */

// ─── structured map mode ──────────────────────────────────────────────────────────────────
// An agent supplies geography (regions on a 0-100 grid + connections); we lay out and style.
// Mirrors the flowchart graph mode: no coordinate maths or SVG authoring in the model.

const BIOME: Record<string, { fill: string; stroke: string }> = {
  islands:  { fill: '#3f9e6b', stroke: '#0b3d5c' },
  coast:    { fill: '#57ab7d', stroke: '#e6d9a2' },
  forest:   { fill: '#2f6d3f', stroke: '#1c4427' },
  mountain: { fill: '#8a8f98', stroke: '#5b6069' },
  desert:   { fill: '#d9c27e', stroke: '#b39a58' },
  plains:   { fill: '#8fbf6a', stroke: '#6b9450' },
  swamp:    { fill: '#5c6f4a', stroke: '#3d4b31' },
  tundra:   { fill: '#cfe0e8', stroke: '#9db4c0' },
  city:     { fill: '#c9a227', stroke: '#7d6416' },
  ruins:    { fill: '#9c8f7a', stroke: '#6b6153' },
  ocean:    { fill: '#0e4b6e', stroke: '#08304a' },
  neutral:  { fill: '#7f8a94', stroke: '#59626a' },
}
const CONNECTION: Record<string, string> = {
  border:      'stroke="#f0e68c" stroke-width="2" stroke-dasharray="7 6" fill="none" opacity="0.75"',
  road:        'stroke="#d8bb87" stroke-width="3" fill="none" opacity="0.9"',
  river:       'stroke="#5fb0d9" stroke-width="4" fill="none" opacity="0.85" stroke-linecap="round"',
  'sea-route': 'stroke="#9fd4ec" stroke-width="2.5" stroke-dasharray="3 8" fill="none" opacity="0.8" stroke-linecap="round"',
  plain:       'stroke="#cbd5e0" stroke-width="2" fill="none" opacity="0.7"',
}

const xmlEsc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Deterministic PRNG seeded from a string — the SAME structure must redraw identically. */
function seeded(str: string): () => number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  let a = h >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An organic blob around a centre, stable for a given seed. */
function blobPath(cx: number, cy: number, r: number, seed: string): string {
  const rnd = seeded(seed)
  const pts: string[] = []
  const N = 11
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2
    const rad = r * (0.72 + rnd() * 0.55)
    pts.push(`${(cx + Math.cos(ang) * rad).toFixed(1)},${(cy + Math.sin(ang) * rad).toFixed(1)}`)
  }
  // Closed Catmull-Rom-ish: quadratic segments through midpoints read as a coastline.
  const xy = pts.map((p) => p.split(',').map(Number) as [number, number])
  let d = ''
  for (let i = 0; i < xy.length; i++) {
    const [x0, y0] = xy[i]
    const [x1, y1] = xy[(i + 1) % xy.length]
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
    d += i === 0 ? `M ${mx.toFixed(1)} ${my.toFixed(1)} ` : `Q ${x0.toFixed(1)} ${y0.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)} `
  }
  return d + 'Z'
}

interface MapRegion { id: string; name?: string; biome?: string; x?: number; y?: number; size?: number; description?: string }
interface MapConn { from: string; to: string; kind?: string; label?: string }

function buildMapSvg(spec: { title?: string; regions?: MapRegion[]; connections?: MapConn[] }):
  { svg: string; warnings: string[] } {
  const W = 1200, H = 800, PAD = 70
  const warnings: string[] = []
  const regions = Array.isArray(spec.regions) ? spec.regions : []
  if (!regions.length) throw new Error('regions must be a non-empty array')

  const seen = new Set<string>()
  for (const r of regions) {
    if (!r?.id) throw new Error('every region needs an id')
    if (seen.has(r.id)) throw new Error(`duplicate region id "${r.id}"`)
    seen.add(r.id)
  }

  // 0-100 -> canvas. Clamped rather than rejected: a slightly out-of-range coordinate is a
  // drawing nuisance, not a broken map, but it is reported so it can be corrected.
  const at = (r: MapRegion) => {
    const cx = Number.isFinite(r.x) ? Number(r.x) : 50
    const cy = Number.isFinite(r.y) ? Number(r.y) : 50
    if (cx < 0 || cx > 100 || cy < 0 || cy > 100) warnings.push(`region "${r.id}": x/y outside 0-100, clamped`)
    return {
      x: PAD + (Math.min(100, Math.max(0, cx)) / 100) * (W - PAD * 2),
      y: PAD + (Math.min(100, Math.max(0, cy)) / 100) * (H - PAD * 2),
    }
  }
  const pos = new Map(regions.map((r) => [r.id, at(r)]))

  const conns = (Array.isArray(spec.connections) ? spec.connections : []).map((c) => {
    // STRICT: a connection to a region that does not exist is an error. Dropping it silently
    // means the agent believes it drew a route that is not on the map.
    if (!pos.has(c.from)) throw new Error(`connection references unknown region "${c.from}"`)
    if (!pos.has(c.to)) throw new Error(`connection references unknown region "${c.to}"`)
    let kind = String(c.kind ?? 'plain')
    if (!CONNECTION[kind]) { warnings.push(`connection ${c.from}->${c.to}: unknown kind "${kind}", drawn plain`); kind = 'plain' }
    return { ...c, kind }
  })

  // Connections first so routes pass UNDER landmasses rather than over them.
  const connSvg = conns.map((c) => {
    const a = pos.get(c.from)!, b = pos.get(c.to)!
    // Bow the line so overlapping routes stay distinguishable; deterministic per pair.
    const rnd = seeded(`${c.from}__${c.to}`)
    const mx = (a.x + b.x) / 2 + (rnd() - 0.5) * 90
    const my = (a.y + b.y) / 2 + (rnd() - 0.5) * 90
    return `  <path id="conn-${xmlEsc(c.from)}__${xmlEsc(c.to)}" d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}" ${CONNECTION[c.kind]}/>`
  }).join('\n')

  const regionSvg = regions.map((r) => {
    const p = pos.get(r.id)!
    let biome = String(r.biome ?? 'neutral')
    if (!BIOME[biome]) { warnings.push(`region "${r.id}": unknown biome "${biome}", drawn neutral`); biome = 'neutral' }
    const st = BIOME[biome]
    const size = Math.max(18, Math.min(160, Number(r.size) || 58))
    const label = xmlEsc(r.name ?? r.id)
    return `  <g id="region-${xmlEsc(r.id)}" data-biome="${xmlEsc(biome)}">
    <path id="shape-${xmlEsc(r.id)}" d="${blobPath(p.x, p.y, size, r.id)}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="3"/>
    <title>${label}${r.description ? ' — ' + xmlEsc(r.description) : ''}</title>
  </g>
  <text id="label-${xmlEsc(r.id)}" x="${p.x.toFixed(1)}" y="${(p.y + size + 22).toFixed(1)}" text-anchor="middle" font-family="Georgia, serif" font-size="19" fill="#f5ecd2" stroke="#0b3d5c" stroke-width="3.5" paint-order="stroke" >${label}</text>`
  }).join('\n')

  const title = spec.title ? `  <text id="map-title" x="${W / 2}" y="46" text-anchor="middle" font-family="Georgia, serif" font-size="34" fill="#f5ecd2" stroke="#08304a" stroke-width="4" paint-order="stroke">${xmlEsc(spec.title)}</text>` : ''

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect id="ocean" width="${W}" height="${H}" fill="#0e4b6e"/>
${connSvg}
${regionSvg}
${title}
</svg>`
  return { svg, warnings }
}

export function createSvgsRouter(dataDir: string): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '12mb' })
  const dir = path.join(dataDir, 'svgs')
  // Where svg_export is allowed to write. Deliberately a single root rather than "anywhere":
  // an unauthenticated endpoint that writes arbitrary paths as root is a foothold, not a
  // convenience. Override with SVG_EXPORT_ROOT.
  const EXPORT_ROOT = path.resolve(process.env.SVG_EXPORT_ROOT || '/claude/svg-exports')
  const ensure = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

  // Ids become filenames, so anything that could escape the directory or collide with the
  // filesystem is rejected rather than sanitised — silently renaming a caller's id makes a
  // later get() miss for reasons nobody can see.
  const badId = (id: string): string | null => {
    if (!id || typeof id !== 'string') return 'id is required'
    if (id.length > 120) return 'id too long (max 120)'
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return 'id may contain only letters, digits, dot, underscore and hyphen'
    if (id.startsWith('.')) return 'id may not start with a dot'
    return null
  }
  const fileFor = (id: string) => path.join(dir, `${id}.svg`)

  /** Reject non-SVG before it is stored. An LLM will happily return prose, a markdown fence,
   *  or a truncated document; storing that yields a drawing that renders blank with no clue
   *  why. Cheap structural check, not a full parse. */
  const svgProblem = (svg: unknown): string | null => {
    if (typeof svg !== 'string' || !svg.trim()) return 'svg must be a non-empty string'
    const s = svg.trim()
    if (s.startsWith('```')) return 'svg is wrapped in a markdown code fence — send the raw document'
    if (!/<svg[\s>]/i.test(s)) return 'no <svg> element found'
    if (!/<\/svg>\s*$/i.test(s)) return 'document does not end with </svg> (truncated?)'
    return null
  }

  /**
   * Serialize writes PER DRAWING. Element edits are read-modify-write, so two concurrent
   * requests would interleave and one would be silently lost — exactly the clobbering this
   * endpoint exists to prevent. Each id gets a promise chain so an edit always sees the
   * previous edit's result.
   */
  const writeChains = new Map<string, Promise<unknown>>()
  const serialize = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = writeChains.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    // Keep the chain alive but never let a rejection poison later edits.
    writeChains.set(id, next.catch(() => undefined))
    return next
  }

  /** Depth-first search for an element carrying this id. */
  const findById = (root: any, id: string): any => {
    if (!root) return null
    if (root.nodeType === 1 && typeof root.getAttribute === 'function' && root.getAttribute('id') === id) return root
    for (let c = root.firstChild; c; c = c.nextSibling) {
      const hit = findById(c, id)
      if (hit) return hit
    }
    return null
  }

  /**
   * Apply element operations to a drawing. Ops are addressed by the elements' SVG `id`.
   *
   *   { op:'set',    id, svg }        replace that element, or append it if absent (upsert)
   *   { op:'attrs',  id, set?, remove? }  change attributes only, leaving children intact
   *   { op:'remove', id }
   *   { op:'append', svg, parent? }   append a new element, optionally inside a parent id
   */
  router.post('/api/svgs/:id/elements', json, async (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const f = fileFor(req.params.id)
    if (!existsSync(f)) return res.status(404).json({ error: `no svg named "${req.params.id}"` })
    const ops = (req.body ?? {}).ops
    if (!Array.isArray(ops) || ops.length === 0) return res.status(400).json({ error: 'ops must be a non-empty array' })

    try {
      const result = await serialize(req.params.id, async () => {
        const { DOMParser, XMLSerializer } = await import('@xmldom/xmldom')
        const doc: any = new DOMParser().parseFromString(readFileSync(f, 'utf8'), 'image/svg+xml')
        const root: any = doc.documentElement
        if (!root) throw new Error('stored document could not be parsed as SVG')
        const SVG_NS = 'http://www.w3.org/2000/svg'

        /** Parse a fragment and adopt it, dropping the redundant xmlns the parser adds. */
        const parseFragment = (markup: string, where: string): any => {
          const frag: any = new DOMParser().parseFromString(
            /xmlns=/.test(markup) ? markup : markup.replace(/^\s*<([a-zA-Z][\w:-]*)/, `<$1 xmlns="${SVG_NS}"`),
            'image/svg+xml',
          )
          const el = frag?.documentElement
          if (!el || el.nodeType !== 1) throw new Error(`${where}: svg is not a single parseable element`)
          const adopted = doc.importNode ? doc.importNode(el, true) : el
          // The root already declares the namespace; repeating it on every child is noise
          // that an agent then reads back and copies forward.
          if (adopted.getAttribute && adopted.getAttribute('xmlns') === SVG_NS) adopted.removeAttribute('xmlns')
          return adopted
        }

        const applied: Array<Record<string, unknown>> = []
        ops.forEach((raw: any, i: number) => {
          const op = String(raw?.op ?? '')
          const where = `ops[${i}] (${op || 'missing op'})`
          if (op === 'append') {
            if (typeof raw.svg !== 'string' || !raw.svg.trim()) throw new Error(`${where}: svg is required`)
            const parent = raw.parent ? findById(root, String(raw.parent)) : root
            if (!parent) throw new Error(`${where}: parent id "${raw.parent}" not found`)
            parent.appendChild(parseFragment(raw.svg, where))
            applied.push({ i, op, parent: raw.parent ?? null })
            return
          }
          const id = String(raw?.id ?? '')
          if (!id) throw new Error(`${where}: id is required`)
          const el = findById(root, id)
          if (op === 'set') {
            if (typeof raw.svg !== 'string' || !raw.svg.trim()) throw new Error(`${where}: svg is required`)
            const node = parseFragment(raw.svg, where)
            if (el) { el.parentNode.replaceChild(node, el); applied.push({ i, op, id, action: 'replaced' }) }
            else { root.appendChild(node); applied.push({ i, op, id, action: 'appended' }) }
            return
          }
          // Everything below TARGETS an existing element, so a miss is an error rather than
          // a no-op: silently doing nothing is how an agent ends up believing it edited a map
          // it never touched.
          if (!el) throw new Error(`${where}: no element with id "${id}"`)
          if (op === 'remove') {
            el.parentNode.removeChild(el)
            applied.push({ i, op, id })
          } else if (op === 'attrs') {
            const set = raw.set && typeof raw.set === 'object' ? raw.set : {}
            for (const [k, v] of Object.entries(set)) el.setAttribute(k, String(v))
            for (const k of Array.isArray(raw.remove) ? raw.remove : []) el.removeAttribute(String(k))
            applied.push({ i, op, id, set: Object.keys(set), removed: raw.remove ?? [] })
          } else {
            throw new Error(`${where}: unknown op — use set | attrs | remove | append`)
          }
        })

        const out = new XMLSerializer().serializeToString(doc)
        const problem = svgProblem(out)
        if (problem) throw new Error(`result would not be valid SVG: ${problem}`)
        writeFileSync(f, out, 'utf8')
        return { ok: true, id: req.params.id, applied, bytes: Buffer.byteLength(out) }
      })
      res.json(result)
    } catch (e) {
      // NOTHING was written — the batch is applied to an in-memory document and only
      // persisted once every op succeeds, so a rejected batch leaves the drawing untouched.
      res.status(400).json({ error: String((e as Error).message), applied: false })
    }
  })


  /**
   * Structured map mode — the agent supplies geography, we lay out and style it.
   * PUT /api/svgs/:id/map {title, regions:[{id,name,biome,x,y,size,description}], connections:[{from,to,kind}]}
   * Result is stored as the SVG at :id, so /render.png and /file.svg work unchanged.
   */
  router.put('/api/svgs/:id/map', json, async (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    try {
      const { svg, warnings } = buildMapSvg(req.body ?? {})
      const problem = svgProblem(svg)
      if (problem) throw new Error(`generated map failed validation: ${problem}`)
      await serialize(req.params.id, async () => { ensure(); writeFileSync(fileFor(req.params.id), svg, 'utf8') })
      res.json({
        ok: true,
        id: req.params.id,
        bytes: Buffer.byteLength(svg),
        regions: (req.body?.regions ?? []).length,
        connections: (req.body?.connections ?? []).length,
        // Reported, never silent: an unknown biome still draws, but the agent is told it was
        // substituted rather than left wondering why its desert looks like everything else.
        warnings,
        element_ids: 'region-<id>, shape-<id>, label-<id>, conn-<from>__<to>, ocean, map-title — usable with svg_edit',
      })
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message) })
    }
  })

  router.get('/api/svgs', (_req: Req, res: Res) => {
    try {
      ensure()
      const items = readdirSync(dir)
        .filter((f) => f.endsWith('.svg'))
        .map((f) => {
          const id = f.replace(/\.svg$/, '')
          const st = statSync(path.join(dir, f))
          return { id, bytes: st.size, updatedAt: st.mtime.toISOString() }
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      res.json({ svgs: items })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  router.get('/api/svgs/:id', (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const f = fileFor(req.params.id)
    if (!existsSync(f)) return res.status(404).json({ error: `no svg named "${req.params.id}"` })
    res.json({ id: req.params.id, svg: readFileSync(f, 'utf8') })
  })

  router.put('/api/svgs/:id', json, (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const svg = (req.body ?? {}).svg
    const problem = svgProblem(svg)
    if (problem) return res.status(400).json({ error: problem })
    try {
      ensure()
      writeFileSync(fileFor(req.params.id), String(svg), 'utf8')
      res.json({ ok: true, id: req.params.id, bytes: Buffer.byteLength(String(svg)) })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  router.delete('/api/svgs/:id', (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const f = fileFor(req.params.id)
    if (!existsSync(f)) return res.status(404).json({ error: `no svg named "${req.params.id}"` })
    try { unlinkSync(f); res.json({ ok: true }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  /**
   * Rasterise to PNG so a model can LOOK at its own drawing.
   *
   * Served as a normal image response at a stable URL, deliberately: MCP image results do not
   * reach Hermes agents (see reference_hermes_mcp_images_never_reach_model), so the render has
   * to be something a vision model can be pointed AT. density lifts the source resolution
   * before scaling, otherwise a small viewBox upscales into a blurry mess.
   */
  router.get('/api/svgs/:id/render.png', async (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const f = fileFor(req.params.id)
    if (!existsSync(f)) return res.status(404).json({ error: `no svg named "${req.params.id}"` })
    const width = Math.max(16, Math.min(4096, Number(req.query.width ?? 1024) || 1024))
    try {
      const { default: sharp } = await import('sharp')
      const png = await sharp(readFileSync(f), { density: 144 })
        .resize({ width, fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer()
      res.setHeader('Content-Type', 'image/png')
      // No caching: the whole point is to re-look after an edit, and a cached render would
      // show the previous attempt — the most confusing possible failure for this workflow.
      res.setHeader('Cache-Control', 'no-store')
      res.end(png)
    } catch (e) {
      // Say WHY. A broken render usually means malformed SVG, and that message is the single
      // most useful thing an agent can be told here.
      res.status(422).json({ error: `could not rasterise: ${String((e as Error).message)}` })
    }
  })

  /**
   * Raw SVG download. An EXTERNAL agent usually just wants a link to the file rather than the
   * document echoed back through a tool result, and a browser gets a real download too.
   */
  router.get('/api/svgs/:id/file.svg', (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const f = fileFor(req.params.id)
    if (!existsSync(f)) return res.status(404).json({ error: `no svg named "${req.params.id}"` })
    res.setHeader('Content-Type', 'image/svg+xml')
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.svg"`)
    res.setHeader('Cache-Control', 'no-store')
    res.end(readFileSync(f, 'utf8'))
  })

  /**
   * Pull an SVG in from a URL — what "upload so I can edit it" means for an agent holding a
   * link. Validated exactly like a write, and size-capped: a 20MB HTML error page fetched by
   * mistake should fail as "no <svg> element", not fill the disk.
   */
  router.post('/api/svgs/:id/import', json, async (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const url = String((req.body ?? {}).url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must be http(s)' })
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!r.ok) return res.status(502).json({ error: `fetch failed: ${r.status} ${r.statusText}` })
      const text = (await r.text()).slice(0, 12 * 1024 * 1024)
      const problem = svgProblem(text)
      // Name the content type in the failure: "no <svg> element" plus text/html tells the
      // caller instantly that the URL served a page, not a drawing.
      if (problem) return res.status(400).json({ error: `${problem} (server sent ${r.headers.get('content-type') ?? 'unknown type'})` })
      ensure()
      writeFileSync(fileFor(req.params.id), text, 'utf8')
      res.json({ ok: true, id: req.params.id, bytes: Buffer.byteLength(text), source: url })
    } catch (e) {
      res.status(502).json({ error: String((e as Error).message) })
    }
  })

  /** Write a stored drawing to a caller-chosen filesystem path, CONFINED to an allowlisted root. */
  router.post('/api/svgs/:id/export', json, (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const f = fileFor(req.params.id)
    if (!existsSync(f)) return res.status(404).json({ error: `no svg named "${req.params.id}"` })
    const dest = String((req.body ?? {}).path ?? '').trim()
    if (!dest) return res.status(400).json({ error: 'path is required' })
    if (!path.isAbsolute(dest)) return res.status(400).json({ error: 'path must be absolute' })
    try {
      const target = dest.endsWith('.svg') ? dest : path.join(dest, `${req.params.id}.svg`)
      // CONFINED. This endpoint previously wrote anywhere the backend user could reach, which
      // is remote arbitrary file write the moment /api is exposed. Resolve first so a symlink
      // or .. cannot walk out, and name the permitted root in the error so a caller is not
      // left guessing why a reasonable-looking path was refused.
      const resolved = path.resolve(target)
      if (resolved !== EXPORT_ROOT && !resolved.startsWith(EXPORT_ROOT + path.sep)) {
        return res.status(403).json({
          error: `exports are confined to ${EXPORT_ROOT} (got ${resolved}). `
            + 'Set SVG_EXPORT_ROOT to change it.',
        })
      }
      mkdirSync(path.dirname(resolved), { recursive: true })
      writeFileSync(resolved, readFileSync(f, 'utf8'), 'utf8')
      res.json({ ok: true, path: resolved, bytes: statSync(resolved).size })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  return router
}
