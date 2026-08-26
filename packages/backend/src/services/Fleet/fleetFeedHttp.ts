// @ts-expect-error — express ships untyped in this repo (same pre-existing gap as fleetHttp.ts)
import express from 'express'
import { FleetFeedService, FleetFeedError } from './FleetFeedService'

type Req = { body?: any; query?: Record<string, unknown>; params?: Record<string, string> }
type Res = {
  json: (v: unknown) => void
  status: (code: number) => { json: (v: unknown) => void; send: (v: unknown) => void }
  setHeader: (k: string, v: string) => void
  send: (v: unknown) => void
}

/**
 * Fleet FEED routes (phase 2) — the AI-Lab surface for the reworked Fleet Feed tab.
 *
 * 🛑 These are NEW paths, deliberately NOT reusing `/api/fleet/feed` or `/api/fleet/agents`.
 * Those already exist in ConversationBus/fleetHttp.ts with DIFFERENT semantics — the old
 * `/feed` is an afterSeq replay cursor, not a thread listing. Repointing them would break the
 * live Fleet tab before its replacement UI exists. The old routes retire when the new tab lands.
 *
 * Everything here is a thin proxy to fleetd. No business logic: visibility, participant checks
 * and public-only search are enforced in the store, so a second implementation here could only
 * ever drift from it.
 */
/**
 * Paths already claimed by ConversationBus/fleetHttp.ts, which is mounted FIRST and therefore
 * WINS. This list exists because /api/fleet/guard silently collided: GET reached this router,
 * POST reached the old one, so the kill switch reported "off" while messages kept flowing — a
 * safety control that lies is worse than no control. Express shadows duplicate paths without a
 * word, so the collision is asserted at mount time instead.
 */
const CONVERSATION_BUS_PATHS = new Set([
  '/api/fleet/activity', '/api/fleet/activity/detail', '/api/fleet/agents', '/api/fleet/feed',
  '/api/fleet/guard', '/api/fleet/heartbeat', '/api/fleet/register', '/api/fleet/relay-inbound',
  '/api/fleet/send', '/api/fleet/status',
])

export function createFleetFeedRouter(svc: FleetFeedService = new FleetFeedService()): unknown {
  const router = express.Router()
  const claim = (p: string) => {
    if (CONVERSATION_BUS_PATHS.has(p)) {
      throw new Error(
        `fleet feed route ${p} collides with ConversationBus/fleetHttp.ts, which is mounted ` +
        `first and would shadow it. Rename this route, or retire the old one first.`)
    }
    return p
  }
  const json = express.json({ limit: '25mb' })   // attachments arrive base64 in the body

  // Preserve fleetd's status + stage. A participant check failing is a 400 for the CALLER,
  // not a 500 — collapsing everything to 500 sends the UI into retry/alert instead of
  // showing the user why it was refused.
  const fail = (res: Res, e: unknown) => {
    if (e instanceof FleetFeedError) {
      return res.status(e.status >= 400 && e.status < 600 ? e.status : 500)
                .json({ ok: false, error: e.message, stage: e.stage })
    }
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
  const ok = async (res: Res, fn: () => Promise<unknown>) => {
    try { res.json(await fn()) } catch (e) { fail(res, e) }
  }

  router.get(claim('/api/fleet/threads'), (req: Req, res: Res) => ok(res, () => svc.listFeed({
    viewer: req.query?.viewer as string, scope: req.query?.scope as string,
    category: req.query?.category as string, kind: req.query?.kind as string,
    limit: req.query?.limit ? Number(req.query.limit) : undefined,
    before: req.query?.before ? Number(req.query.before) : undefined,
    cursor: req.query?.cursor as string,          // opaque — pass next_cursor straight back
    unread: req.query?.unread === '1',
  })))

  router.get(claim('/api/fleet/thread/:id'), (req: Req, res: Res) => ok(res, () => svc.readThread(
    req.params!.id, {
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      before_seq: req.query?.before_seq !== undefined ? Number(req.query.before_seq) : undefined,
      receipts: req.query?.receipts !== '0',
    })))

  router.post(claim('/api/fleet/thread/:id/read'), json, (req: Req, res: Res) =>
    ok(res, () => svc.markRead(req.params!.id, req.body?.viewer, Number(req.body?.up_to_seq))))

  router.get(claim('/api/fleet/unread'), (req: Req, res: Res) => {
    const viewer = req.query?.viewer as string
    if (!viewer) return res.status(400).json({ ok: false, error: 'viewer required', stage: 'validation' })
    return ok(res, () => svc.unread(viewer))
  })

  // Travis-facing kill switch. Read and write, because a control you cannot observe is not a
  // control — the UI has to be able to show that traffic is currently stopped, and why.
  router.get(claim('/api/fleet/delivery-guard'), (_req: Req, res: Res) => ok(res, () => svc.getGuard()))
  router.post(claim('/api/fleet/delivery-guard'), json, (req: Req, res: Res) =>
    ok(res, () => svc.setGuard(Boolean(req.body?.enabled), req.body?.actor ?? 'user', req.body?.reason)))

  router.get(claim('/api/fleet/attachment/:id/structured'), (req: Req, res: Res) =>
    ok(res, () => svc.getStructured(req.params!.id)))

  router.post(claim('/api/fleet/post'), json, (req: Req, res: Res) =>
    ok(res, () => svc.post(req.body)))

  router.post(claim('/api/fleet/message'), json, (req: Req, res: Res) =>
    ok(res, () => svc.send(req.body)))

  router.post(claim('/api/fleet/thread/:id/visibility'), json, (req: Req, res: Res) =>
    ok(res, () => svc.setVisibility(req.params!.id, req.body?.actor, req.body?.visibility)))

  router.get(claim('/api/fleet/categories'), (_req: Req, res: Res) =>
    ok(res, () => svc.categories()))

  router.get(claim('/api/fleet/search'), (req: Req, res: Res) => {
    const q = String(req.query?.q ?? '')
    if (!q) return res.status(400).json({ ok: false, error: 'q required', stage: 'validation' })
    return ok(res, () => svc.search(q, {
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      category: req.query?.category as string,
    }))
  })

  router.get(claim('/api/fleet/directory'), (_req: Req, res: Res) =>
    ok(res, () => svc.directory()))

  router.post(claim('/api/fleet/attachment'), json, (req: Req, res: Res) =>
    ok(res, () => svc.addAttachment(req.body)))

  // Bytes stream through the backend — the browser must never fetch fleetd directly (standard #1),
  // and an image stays a ref until someone deliberately asks for it.
  router.get(claim('/api/fleet/attachment/:id'), async (req: Req, res: Res) => {
    try {
      const a = await svc.getAttachment(req.params!.id)
      res.setHeader('Content-Type', a.mediaType)
      res.setHeader('X-Fleet-Attachment-Kind', a.kind)
      res.send(a.body)
    } catch (e) { fail(res, e) }
  })

  // Live health of the fleet transport itself — derived, never a stored flag (standard #5).
  router.get(claim('/api/fleet/health'), async (_req: Req, res: Res) => {
    const up = await svc.health()
    res.json({ ok: up, fleetd: svc.endpoint, reachable: up })
  })

  return router
}
