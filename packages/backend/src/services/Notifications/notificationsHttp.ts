// @ts-expect-error — express ships untyped in this repo (same pattern as flowchartsHttp)
import express from 'express'
import { createReadStream } from 'node:fs'
import type { NotificationsService, NotifySeverity } from './NotificationsService'
import { MAX_TEXT_BYTES } from './ClipboardDrops'
import { ImageInboxError } from './ImageInbox'

type Req = express.Request
type Res = express.Response

const SEVERITIES: NotifySeverity[] = ['info', 'warning', 'error', 'critical']

/**
 * Notifications HTTP surface.
 *
 * /emit is the estate-wide cheap path: anything that can curl — a systemd
 * timer's ExecStartPost, the Optane pruner, an audit script, another agent —
 * can put a real event in front of Travis with one POST instead of writing to
 * a journal nobody opens. That is the entire point of the panel.
 */
export function createNotificationsRouter(svc: NotificationsService): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '256kb' })

  // ─── Clipboard drops: text an agent posts for Travis to COPY (MCP ailab-clipboard). ───
  router.get('/api/clipboard', (_req: Req, res: Res) => {
    res.json({ items: svc.clips.list() })
  })

  router.post('/api/clipboard', json, (req: Req, res: Res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const text = typeof b.text === 'string' ? b.text : ''
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text is required' })
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      return res.status(413).json({ ok: false, error: `text exceeds ${MAX_TEXT_BYTES} bytes` })
    }
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
    const item = svc.clips.post({
      text,
      title: str(b.title, 200),
      from: str(b.from, 60),
      sensitive: b.sensitive === true,
    })
    res.json({ ok: true, item })
  })

  // History: every drop ever posted. Registered BEFORE /api/clipboard/:id, or
  // DELETE /api/clipboard/history would be read as 'delete the entry whose id is "history"'.
  router.get('/api/clipboard/history', (_req: Req, res: Res) => {
    res.json({ items: svc.clips.listHistory() })
  })

  router.post('/api/clipboard/history/:id/restore', (req: Req, res: Res) => {
    const item = svc.clips.restore(String(req.params.id))
    if (!item) return res.status(404).json({ ok: false, error: 'not in history' })
    res.json({ ok: true, item })
  })

  router.delete('/api/clipboard/history/:id', (req: Req, res: Res) => {
    const removed = svc.clips.removeFromHistory(String(req.params.id))
    res.status(removed ? 200 : 404).json({ ok: removed })
  })

  router.delete('/api/clipboard/history', (_req: Req, res: Res) => {
    res.json({ ok: true, cleared: svc.clips.clearHistory() })
  })

  router.delete('/api/clipboard/:id', (req: Req, res: Res) => {
    const removed = svc.clips.remove(String(req.params.id))
    res.status(removed ? 200 : 404).json({ ok: removed })
  })

  router.delete('/api/clipboard', (_req: Req, res: Res) => {
    res.json({ ok: true, cleared: svc.clips.clear() })
  })

  // ─── Image inbox: images an agent posts for Travis to SEE (MCP ailab-image-inbox). ───
  // Uploads arrive as base64 in JSON, so this route gets its own, bigger body limit; the
  // shared 256kb `json` stays on everything else.
  const jsonImage = express.json({ limit: '34mb' })

  router.get('/api/image-inbox', (_req: Req, res: Res) => {
    res.json({ items: svc.imageInbox.list(), unseen: svc.imageInbox.unseen() })
  })

  router.post('/api/image-inbox', jsonImage, (req: Req, res: Res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    try {
      const item = svc.imageInbox.post({
        path: b.path === undefined ? undefined : String(b.path),
        dataBase64: b.dataBase64 === undefined ? undefined : String(b.dataBase64),
        filename: b.filename === undefined ? undefined : String(b.filename),
        title: b.title === undefined ? undefined : String(b.title),
        caption: b.caption === undefined ? undefined : String(b.caption),
        from: b.from === undefined ? undefined : String(b.from),
      })
      res.json({ ok: true, item })
    } catch (e) {
      const status = e instanceof ImageInboxError ? e.status : 500
      const msg = (e as Error)?.message || String(e)
      if (status >= 500) console.warn('[image-inbox] post failed:', msg)
      res.status(status).json({ ok: false, error: msg })
    }
  })

  // The stored copy's bytes, for <img src>. Registered before any /:id handler ambiguity.
  router.get('/api/image-inbox/:id/image', (req: Req, res: Res) => {
    const f = svc.imageInbox.storedFile(String(req.params.id))
    if (!f) return res.status(404).json({ ok: false, error: 'no such image' })
    res.setHeader('content-type', f.mime)
    res.setHeader('cache-control', 'private, max-age=31536000, immutable')
    // Streamed by hand: express sendFile 404s any path CONTAINING a dotfile segment, and the
    // store lives under .gybackend-data.
    const stream = createReadStream(f.file)
    stream.on('error', (err: Error) => {
      console.warn('[image-inbox] stream failed:', err.message)
      if (!res.headersSent) res.status(500).json({ ok: false, error: err.message })
      else res.end()
    })
    stream.pipe(res)
  })

  // Viewer opened — the pip clears. Idempotent.
  router.post('/api/image-inbox/seen', (_req: Req, res: Res) => {
    res.json({ ok: true, marked: svc.imageInbox.markAllSeen() })
  })

  router.delete('/api/image-inbox/:id', (req: Req, res: Res) => {
    const removed = svc.imageInbox.remove(String(req.params.id))
    res.status(removed ? 200 : 404).json({ ok: removed })
  })

  router.delete('/api/image-inbox', (_req: Req, res: Res) => {
    res.json({ ok: true, cleared: svc.imageInbox.clear() })
  })

  router.get('/api/notifications/state', (_req: Req, res: Res) => {
    res.json(svc.state())
  })

  /** Task-progress reporting for anything that can curl — the /emit of progress meters.
   *  Same estate-wide cheap path: the RAG indexer, a training wrapper, a systemd job. */
  router.post('/api/notifications/task', json, (req: Req, res: Res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const id = String(b.id ?? '').trim()
    if (!id) return res.status(400).json({ ok: false, error: 'id is required (stable per task, e.g. rag:ai-lab)' })
    const state = b.state === undefined ? undefined : String(b.state)
    if (state !== undefined && !['running', 'done', 'failed'].includes(state)) {
      return res.status(400).json({ ok: false, error: "state must be running | done | failed" })
    }
    const t = svc.tasks.report({
      id,
      source: b.source === undefined ? undefined : String(b.source),
      label: b.label === undefined ? undefined : String(b.label),
      state: state as 'running' | 'done' | 'failed' | undefined,
      done: b.done === undefined ? undefined : Number(b.done),
      total: b.total === undefined ? undefined : Number(b.total),
      percent: b.percent === undefined ? undefined : Number(b.percent),
      detail: b.detail === undefined ? undefined : String(b.detail),
    })
    if (!t) return res.status(429).json({ ok: false, error: 'task registry full of RUNNING tasks — a reporter is leaking ids' })
    res.json({ ok: true, task: t })
  })

  router.get('/api/notifications/tasks', (_req: Req, res: Res) => {
    res.json(svc.tasks.state())
  })

  router.get('/api/notifications/routing', (_req: Req, res: Res) => {
    res.json(svc.routingState())
  })

  /**
   * Suspend or resume forwarding to the maintenance agent. Exposed as an API (and a UI
   * control) rather than an env var because it is toggled during normal work — building
   * emitters raises premature alerts — and an env var means a restart and no visibility.
   */
  router.post('/api/notifications/routing', json, (req: Req, res: Res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    if (typeof b.suspended !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'suspended must be a boolean' })
    }
    const reason = String(b.reason ?? '').slice(0, 300)
    const state = svc.setRouting(b.suspended, reason)
    console.log(`[notify-routing] forwarding ${state.suspended ? 'SUSPENDED' : 'RESUMED'}${reason ? ` — ${reason}` : ''}`)
    return res.json({ ok: true, ...state })
  })

  router.post('/api/notifications/emit', json, (req: Req, res: Res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const severity = String(b.severity ?? '') as NotifySeverity
    const source = String(b.source ?? '').trim()
    const message = String(b.message ?? '').trim()
    if (!SEVERITIES.includes(severity)) {
      return res.status(400).json({ ok: false, error: `severity must be one of ${SEVERITIES.join('|')}` })
    }
    if (!source || !message) {
      return res.status(400).json({ ok: false, error: 'source and message are required' })
    }
    // Truncation happens either way (a 200k detail must not balloon the store),
    // but silently rewriting a caller's content is the lying-response shape:
    // the caller believes the panel holds what it sent. Say which fields were
    // cut, so a script author can see it in the response they already read.
    const detailRaw = b.detail !== undefined ? String(b.detail) : undefined
    const truncated = [
      source.length > 64 ? 'source' : '',
      message.length > 500 ? 'message' : '',
      detailRaw !== undefined && detailRaw.length > 4000 ? 'detail' : '',
    ].filter(Boolean)
    const evt = svc.notify({
      severity, source: source.slice(0, 64), message: message.slice(0, 500),
      detail: detailRaw !== undefined ? detailRaw.slice(0, 4000) : undefined,
    })
    res.json({ ok: true, id: evt.id, ...(truncated.length ? { truncated } : {}) })
  })

  router.post('/api/notifications/debug', json, (req: Req, res: Res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const source = String(b.source ?? '').trim()
    const message = String(b.message ?? '').trim()
    if (!source || !message) return res.status(400).json({ ok: false, error: 'source and message are required' })
    svc.debug(source.slice(0, 64), message.slice(0, 1000))
    res.json({ ok: true })
  })

  router.post('/api/notifications/ack', json, (req: Req, res: Res) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const ids = b.ids === 'all' ? ('all' as const) : Array.isArray(b.ids) ? b.ids.map(String) : null
    if (ids === null) return res.status(400).json({ ok: false, error: "ids must be an array or 'all'" })
    res.json({ ok: true, acked: svc.ack(ids) })
  })

  return router
}
