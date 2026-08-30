// @ts-expect-error — express ships untyped in this repo (same pattern as flowchartsHttp)
import express from 'express'
import type { NotificationsService, NotifySeverity } from './NotificationsService'

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

  router.get('/api/notifications/state', (_req: Req, res: Res) => {
    res.json(svc.state())
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
    const evt = svc.notify({
      severity, source: source.slice(0, 64), message: message.slice(0, 500),
      detail: b.detail !== undefined ? String(b.detail).slice(0, 4000) : undefined,
    })
    res.json({ ok: true, id: evt.id })
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
