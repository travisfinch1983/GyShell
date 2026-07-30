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
export function createSvgsRouter(dataDir: string): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '12mb' })
  const dir = path.join(dataDir, 'svgs')
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

  /** Write a stored drawing to a caller-chosen filesystem path. */
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
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, readFileSync(f, 'utf8'), 'utf8')
      res.json({ ok: true, path: target, bytes: statSync(target).size })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  return router
}
