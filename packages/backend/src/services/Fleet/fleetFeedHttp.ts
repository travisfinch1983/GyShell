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
 * Fleet FEED routes — the AI-Lab surface for the Fleet Feed tab, and since bus-retirement 3/5
 * the SOLE owner of /api/fleet/*. Canonical names are the ones this surface always wanted
 * (/feed, /send, /agents, /guard); the shadow-avoiding names it launched under (/threads,
 * /message, /directory, /delivery-guard) remain as ALIASES so a deployed UI bundle keeps
 * working across the rename — drop them once the web build ships with canonical paths.
 *
 * Everything here is a thin proxy to fleetd. No business logic: visibility, participant checks
 * and public-only search are enforced in the store, so a second implementation here could only
 * ever drift from it.
 *
 * (Historical: a claim() mount-time collision guard lived here while ConversationBus's router
 * was mounted first and Express silently shadowed duplicates — /api/fleet/guard collided and
 * the kill switch lied. The old router is gone; the guard went with it.)
 */

/**
 * Adapter over ConversationBus's guard. The fleet has TWO delivery paths and they were governed
 * by two unrelated switches: fleetd delivery, and ConversationBus autonomous routing
 * (HermesBusSubscriber — Hermes agents auto-replying to each other, which never touches fleetd).
 * Flipping one while believing it stopped "agent traffic" left the other running.
 */
export type BusGuard = {
  get: () => { autonomousRoutingEnabled: boolean }
  set: (patch: { autonomousRoutingEnabled: boolean }) => { autonomousRoutingEnabled: boolean }
}

export function createFleetFeedRouter(svc: FleetFeedService = new FleetFeedService(),
                                      busGuard?: BusGuard): unknown {
  const router = express.Router()
  // Measured, not assumed: 16 MiB bodies pass and 26.7 MiB is refused, identically through the
  // backend (17890) and the web host (17889) — the web host does not narrow it.
  const BODY_LIMIT = process.env.FLEET_BODY_LIMIT ?? '25mb'
  const json = express.json({ limit: BODY_LIMIT })   // attachments arrive base64 in the body

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

  /**
   * Body-size failures arrive from express.json as an HTML error page, which a JSON client
   * parses as a crash rather than a message it can show. An oversized upload is a normal thing
   * for a user to do, so it has to come back as a readable JSON refusal that names the limit.
   */
  const jsonBody = (req: Req, res: Res, next: (e?: unknown) => void) =>
    json(req, res, (err: any) => {
      if (err?.type === 'entity.too.large' || err?.status === 413) {
        return res.status(413).json({
          ok: false, stage: 'validation',
          error: `attachment too large — the request body limit is ${BODY_LIMIT}. ` +
                 `base64 inflates a file by about a third, so keep files under ~18MB.`,
          limit: BODY_LIMIT,
        })
      }
      return next(err)
    })

  router.get('/api/fleet/feed', (req: Req, res: Res) => ok(res, () => svc.listFeed({
    viewer: req.query?.viewer as string, scope: req.query?.scope as string,
    category: req.query?.category as string, kind: req.query?.kind as string,
    limit: req.query?.limit ? Number(req.query.limit) : undefined,
    before: req.query?.before ? Number(req.query.before) : undefined,
    cursor: req.query?.cursor as string,          // opaque — pass next_cursor straight back
    unread: req.query?.unread === '1',
  })))
  // alias (launch name) — drop once the web build ships canonical paths
  router.get('/api/fleet/threads', (req: Req, res: Res) => ok(res, () => svc.listFeed({
    viewer: req.query?.viewer as string, scope: req.query?.scope as string,
    category: req.query?.category as string, kind: req.query?.kind as string,
    limit: req.query?.limit ? Number(req.query.limit) : undefined,
    before: req.query?.before ? Number(req.query.before) : undefined,
    cursor: req.query?.cursor as string,          // opaque — pass next_cursor straight back
    unread: req.query?.unread === '1',
  })))

  router.get('/api/fleet/thread/:id', (req: Req, res: Res) => ok(res, () => svc.readThread(
    req.params!.id, {
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      before_seq: req.query?.before_seq !== undefined ? Number(req.query.before_seq) : undefined,
      receipts: req.query?.receipts !== '0',
      viewer: req.query?.viewer as string,
    })))

  router.post('/api/fleet/thread/:id/read', jsonBody, (req: Req, res: Res) =>
    ok(res, () => svc.markRead(req.params!.id, req.body?.viewer, Number(req.body?.up_to_seq))))

  router.get('/api/fleet/unread', (req: Req, res: Res) => {
    const viewer = req.query?.viewer as string
    if (!viewer) return res.status(400).json({ ok: false, error: 'viewer required', stage: 'validation' })
    return ok(res, () => svc.unread(viewer))
  })

  // Travis-facing kill switch. Read and write, because a control you cannot observe is not a
  // control — the UI has to be able to show that traffic is currently stopped, and why.
  // ONE switch, BOTH paths. Reports each leg separately so a disagreement is visible rather
  // than averaged away — if they ever drift, `unified:false` says so instead of quietly
  // reporting the state of whichever leg was checked last.
  router.get('/api/fleet/guard', (_req: Req, res: Res) => ok(res, async () => {
    const g = await svc.getGuard()
    const autonomous = busGuard ? busGuard.get().autonomousRoutingEnabled : null
    return { ...g, autonomous_routing: autonomous,
             unified: autonomous === null ? null : autonomous === g.enabled }
  }))
  // alias (launch name) — drop once the web build ships canonical paths
  router.get('/api/fleet/delivery-guard', (_req: Req, res: Res) => ok(res, async () => {
    const g = await svc.getGuard()
    const autonomous = busGuard ? busGuard.get().autonomousRoutingEnabled : null
    return { ...g, autonomous_routing: autonomous,
             unified: autonomous === null ? null : autonomous === g.enabled }
  }))

  router.post('/api/fleet/guard', jsonBody, (req: Req, res: Res) => ok(res, async () => {
    const enabled = Boolean(req.body?.enabled)
    const g = await svc.setGuard(enabled, req.body?.actor ?? 'user', req.body?.reason) as Record<string, unknown>
    // Set the bus leg SECOND and report it: if this throws, the caller learns the fleet is in a
    // mixed state rather than getting an ok that covers only half of what they asked for.
    let autonomous: boolean | null = null
    let busError: string | undefined
    if (busGuard) {
      try { autonomous = busGuard.set({ autonomousRoutingEnabled: enabled }).autonomousRoutingEnabled }
      catch (e) { busError = (e as Error).message }
    }
    return { ...g, autonomous_routing: autonomous,
             unified: autonomous === null ? null : autonomous === enabled,
             ...(busError ? { bus_error: busError, stage: 'partial' } : {}) }
  }))
  // alias (launch name) — drop once the web build ships canonical paths
  router.post('/api/fleet/delivery-guard', jsonBody, (req: Req, res: Res) => ok(res, async () => {
    const enabled = Boolean(req.body?.enabled)
    const g = await svc.setGuard(enabled, req.body?.actor ?? 'user', req.body?.reason) as Record<string, unknown>
    // Set the bus leg SECOND and report it: if this throws, the caller learns the fleet is in a
    // mixed state rather than getting an ok that covers only half of what they asked for.
    let autonomous: boolean | null = null
    let busError: string | undefined
    if (busGuard) {
      try { autonomous = busGuard.set({ autonomousRoutingEnabled: enabled }).autonomousRoutingEnabled }
      catch (e) { busError = (e as Error).message }
    }
    return { ...g, autonomous_routing: autonomous,
             unified: autonomous === null ? null : autonomous === enabled,
             ...(busError ? { bus_error: busError, stage: 'partial' } : {}) }
  }))

  router.get('/api/fleet/attachment/:id/structured', (req: Req, res: Res) =>
    ok(res, () => svc.getStructured(req.params!.id)))

  router.post('/api/fleet/post', jsonBody, (req: Req, res: Res) =>
    ok(res, () => svc.post(req.body)))

  router.post('/api/fleet/send', jsonBody, (req: Req, res: Res) =>
    ok(res, () => svc.send(req.body)))
  // alias (launch name) — drop once the web build ships canonical paths
  router.post('/api/fleet/message', jsonBody, (req: Req, res: Res) =>
    ok(res, () => svc.send(req.body)))

  router.post('/api/fleet/thread/:id/visibility', jsonBody, (req: Req, res: Res) =>
    ok(res, () => svc.setVisibility(req.params!.id, req.body?.actor, req.body?.visibility)))

  router.get('/api/fleet/categories', (req: Req, res: Res) =>
    ok(res, () => svc.categories(req.query?.viewer as string)))

  router.get('/api/fleet/search', (req: Req, res: Res) => {
    const q = String(req.query?.q ?? '')
    if (!q) return res.status(400).json({ ok: false, error: 'q required', stage: 'validation' })
    return ok(res, () => svc.search(q, {
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      category: req.query?.category as string,
      // literal stays the default so existing callers are unchanged; semantic and hybrid are
      // opt-in. All three are public-only — the mode cannot widen visibility.
      mode: req.query?.mode as 'literal' | 'semantic' | 'hybrid' | undefined,
    }))
  })

  // Semantic index build. No claim() wrapper — the guard retired with the router that
  // made it necessary, now that ConversationBus no longer holds these paths.
  router.post('/api/fleet/reindex', jsonBody, (req: Req, res: Res) =>
    ok(res, () => svc.reindex(req.body?.limit ? Number(req.body.limit) : undefined)))

  router.get('/api/fleet/agents', (_req: Req, res: Res) =>
    ok(res, () => svc.directory()))
  // alias (launch name) — drop once the web build ships canonical paths
  router.get('/api/fleet/directory', (_req: Req, res: Res) =>
    ok(res, () => svc.directory()))

  router.post('/api/fleet/attachment', jsonBody, (req: Req, res: Res) =>
    ok(res, () => svc.addAttachment(req.body)))

  // Bytes stream through the backend — the browser must never fetch fleetd directly (standard #1),
  // and an image stays a ref until someone deliberately asks for it.
  router.get('/api/fleet/attachment/:id', async (req: Req, res: Res) => {
    try {
      const a = await svc.getAttachment(req.params!.id)
      res.setHeader('Content-Type', a.mediaType)
      res.setHeader('X-Fleet-Attachment-Kind', a.kind)
      res.send(a.body)
    } catch (e) { fail(res, e) }
  })

  // Live health of the fleet transport itself — derived, never a stored flag (standard #5).
  router.get('/api/fleet/health', async (_req: Req, res: Res) => {
    const up = await svc.health()
    res.json({ ok: up, fleetd: svc.endpoint, reachable: up })
  })

  return router
}
