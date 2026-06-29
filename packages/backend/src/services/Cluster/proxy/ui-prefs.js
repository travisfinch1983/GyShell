// Backend-persisted UI preferences (single-user app — settings are global, not per-browser).
// GET /api/ui-prefs -> { ...prefs }; PUT /api/ui-prefs (JSON body) shallow-merges + persists.
import { Router } from 'express'
import express from 'express'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function createUiPrefsRouter() {
  const router = Router()
  const file = join(process.env.AILAB_PROXY_DATA_DIR || '/tmp', 'ui-prefs.json')
  const load = () => {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {} } catch { return {} }
  }
  const save = (d) => { try { writeFileSync(file, JSON.stringify(d, null, 2)) } catch { /* ignore */ } }

  router.get('/', (_req, res) => res.json(load()))
  router.put('/', express.json({ limit: '256kb' }), (req, res) => {
    const next = { ...load(), ...(req.body || {}) }
    save(next)
    res.json(next)
  })
  return router
}
