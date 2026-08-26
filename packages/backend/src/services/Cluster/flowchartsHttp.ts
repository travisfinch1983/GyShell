// @ts-expect-error — express ships untyped in this repo (same pattern as hermesHttp/UniversalProxyService)
import express from 'express'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'

type Req = express.Request
type Res = express.Response

/**
 * Flowchart diagram store. Diagrams are plain JSON files under <dataDir>/flowcharts/<id>.json,
 * so BOTH the AI-Lab UI (via these routes) and claude1 (via the filesystem) can read/write them —
 * the shared "you draw it, I read it / I generate it, you view it" surface. Mounted on the
 * universal proxy app before the broad /api cluster router.
 */
export function createFlowchartsRouter(dataDir: string): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '8mb' })
  const dir = path.join(dataDir, 'flowcharts')
  const ensure = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }
  const safe = (id: string) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)
  const file = (id: string) => path.join(dir, `${id}.json`)

  // List: id + name + updatedAt, newest first.
  router.get('/api/flowcharts', (_req: Req, res: Res) => {
    try {
      ensure()
      const charts = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => { try { const id = f.replace(/\.json$/, ''); const c = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); return { id, name: c.name || id, updatedAt: c.updatedAt } } catch { return null } })
        .filter(Boolean)
        .sort((a: any, b: any) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      res.json({ charts })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  router.get('/api/flowcharts/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return res.status(400).json({ error: 'bad id' })
    try {
      if (!existsSync(file(id))) return res.status(404).json({ error: 'not found' })
      res.json({ chart: JSON.parse(readFileSync(file(id), 'utf8')) })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  router.put('/api/flowcharts/:id', json, (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return res.status(400).json({ error: 'bad id' })
    try {
      ensure()
      const body = (req.body ?? {}) as Record<string, unknown>
      const chart = { ...body, id, updatedAt: new Date().toISOString() }
      writeFileSync(file(id), JSON.stringify(chart, null, 2))
      res.json({ ok: true, chart })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  router.delete('/api/flowcharts/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!safe(id)) return res.status(400).json({ error: 'bad id' })
    try { if (existsSync(file(id))) unlinkSync(file(id)); res.json({ ok: true }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  return router
}
