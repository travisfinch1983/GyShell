// @ts-expect-error — express ships untyped in this repo (same pattern as flowchartsHttp)
import express from 'express'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { marked } from 'marked'
import {
  pageIdSchema,
  pageRestoreRequestSchema,
  pageWriteRequestSchema,
  type PageMeta,
  type PageVersionInfo,
} from '@gyshell/shared'

type Req = express.Request
type Res = express.Response

/**
 * Pages store — versioned documents for the Pages tab, mirroring the
 * flowcharts store's dataDir pattern. Layout:
 *
 *   <dataDir>/pages/<id>/meta.json           — PageMeta (version index)
 *   <dataDir>/pages/<id>/v0007.html          — rendered HTML per version
 *   <dataDir>/pages/<id>/v0007.src.md        — authored source, markdown pages only
 *   <dataDir>/pages/.trash/<id>-<ts>/        — deletes are moves, never unlinks
 *
 * Writes are APPEND-ONLY: every PUT adds a version; restore copies an old
 * version forward as a new one. Markdown converts to HTML here, at write
 * time — the renderer only ever sees HTML (one render path, one sandbox).
 * The SANDBOX in the UI is the security boundary for this content; these
 * routes deliberately do no HTML sanitisation, matching the scoping doc
 * ("the mitigation is an origin boundary, not sanitisation").
 */
export function createPagesRouter(dataDir: string): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '8mb' })
  const root = path.join(dataDir, 'pages')
  const pageDir = (id: string) => path.join(root, id)
  const metaFile = (id: string) => path.join(pageDir(id), 'meta.json')
  const vName = (n: number) => `v${String(n).padStart(4, '0')}`
  const htmlFile = (id: string, n: number) => path.join(pageDir(id), `${vName(n)}.html`)
  const srcFile = (id: string, n: number) => path.join(pageDir(id), `${vName(n)}.src.md`)
  const ensure = () => { if (!existsSync(root)) mkdirSync(root, { recursive: true }) }

  const fail = (res: Res, code: number, error: string) => res.status(code).json({ ok: false, error })

  const readMeta = (id: string): PageMeta | null => {
    if (!existsSync(metaFile(id))) return null
    try { return JSON.parse(readFileSync(metaFile(id), 'utf8')) as PageMeta } catch { return null }
  }

  const renderHtml = (contentType: string, body: string): string =>
    contentType === 'markdown' ? (marked.parse(body, { async: false }) as string) : body

  // List: newest first, without the per-page version arrays.
  router.get('/api/pages', (_req: Req, res: Res) => {
    try {
      ensure()
      const pages = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => readMeta(d.name))
        .filter((m): m is PageMeta => m !== null)
        .map(({ versions, ...m }) => ({ ...m, versionCount: versions.length }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      res.json({ pages })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  // Read: latest by default, ?version=N for history.
  router.get('/api/pages/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!pageIdSchema.safeParse(id).success) return fail(res, 400, 'bad page id')
    const meta = readMeta(id)
    if (!meta) return fail(res, 404, `no page ${id}`)
    const version = req.query.version ? Number(req.query.version) : meta.currentVersion
    const info = meta.versions.find((v) => v.version === version)
    if (!info) return fail(res, 404, `page ${id} has no version ${version}`)
    try {
      const html = readFileSync(htmlFile(id, version), 'utf8')
      const source = info.contentType === 'markdown' && existsSync(srcFile(id, version))
        ? readFileSync(srcFile(id, version), 'utf8')
        : html
      res.json({ meta, version, html, source })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  router.get('/api/pages/:id/versions', (req: Req, res: Res) => {
    const id = req.params.id
    if (!pageIdSchema.safeParse(id).success) return fail(res, 400, 'bad page id')
    const meta = readMeta(id)
    if (!meta) return fail(res, 404, `no page ${id}`)
    res.json({ id, currentVersion: meta.currentVersion, versions: meta.versions })
  })

  // Write: append-only — every write is a new version; id is created on first write.
  router.put('/api/pages/:id', json, (req: Req, res: Res) => {
    const id = req.params.id
    if (!pageIdSchema.safeParse(id).success) return fail(res, 400, 'bad page id')
    const parsed = pageWriteRequestSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, `bad write: ${parsed.error.issues[0]?.message}`)
    const { title, contentType, body, author } = parsed.data
    try {
      ensure()
      let meta = readMeta(id)
      const now = new Date().toISOString()
      if (!meta) {
        mkdirSync(pageDir(id), { recursive: true })
        meta = { id, title, contentType, createdAt: now, updatedAt: now, currentVersion: 0, versions: [] }
      }
      const version = meta.currentVersion + 1
      const html = renderHtml(contentType, body)
      writeFileSync(htmlFile(id, version), html)
      if (contentType === 'markdown') writeFileSync(srcFile(id, version), body)
      const info: PageVersionInfo = {
        version, title, contentType, author, createdAt: now, bytes: Buffer.byteLength(html),
      }
      meta = { ...meta, title, contentType, updatedAt: now, currentVersion: version, versions: [...meta.versions, info] }
      writeFileSync(metaFile(id), JSON.stringify(meta, null, 2))
      res.json({ ok: true, id, version })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  // Restore: append-only too — copies version N forward as a NEW latest version,
  // so "what was restored when" stays in the history instead of vanishing.
  router.post('/api/pages/:id/restore', json, (req: Req, res: Res) => {
    const id = req.params.id
    if (!pageIdSchema.safeParse(id).success) return fail(res, 400, 'bad page id')
    const parsed = pageRestoreRequestSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, 'bad restore request')
    const meta = readMeta(id)
    if (!meta) return fail(res, 404, `no page ${id}`)
    const from = meta.versions.find((v) => v.version === parsed.data.version)
    if (!from) return fail(res, 404, `page ${id} has no version ${parsed.data.version}`)
    try {
      const now = new Date().toISOString()
      const version = meta.currentVersion + 1
      writeFileSync(htmlFile(id, version), readFileSync(htmlFile(id, from.version)))
      if (from.contentType === 'markdown' && existsSync(srcFile(id, from.version))) {
        writeFileSync(srcFile(id, version), readFileSync(srcFile(id, from.version)))
      }
      const info: PageVersionInfo = { ...from, version, createdAt: now, restoredFrom: from.version }
      const next: PageMeta = {
        ...meta, title: from.title, contentType: from.contentType,
        updatedAt: now, currentVersion: version, versions: [...meta.versions, info],
      }
      writeFileSync(metaFile(id), JSON.stringify(next, null, 2))
      res.json({ ok: true, id, version, restoredFrom: from.version })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  // Delete: a MOVE into .trash, never an unlink — the store is append-only in
  // spirit and a mistaken delete of a versioned document must be recoverable.
  router.delete('/api/pages/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!pageIdSchema.safeParse(id).success) return fail(res, 400, 'bad page id')
    if (!existsSync(pageDir(id))) return fail(res, 404, `no page ${id}`)
    try {
      const trash = path.join(root, '.trash')
      mkdirSync(trash, { recursive: true })
      renameSync(pageDir(id), path.join(trash, `${id}-${Date.now()}`))
      res.json({ ok: true })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  return router
}
