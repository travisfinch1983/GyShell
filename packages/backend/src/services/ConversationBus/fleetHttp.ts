// @ts-expect-error — express ships untyped in this repo (same pre-existing gap as UniversalProxyService)
import express from 'express'
import type { ConversationBus } from './ConversationBus'

type Req = { body?: unknown; query?: Record<string, unknown> }
type Res = { json: (v: unknown) => void; status: (code: number) => { json: (v: unknown) => void } }

const fail = (res: Res, e: unknown) =>
  res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) })

/**
 * The fleet HTTP surface for EXTERNAL agents (claude-relay replacement).
 * Mounted on the universal proxy; wraps ConversationBus methods 1:1 so the
 * ailab-fleet MCP server (and anything else on the LAN) can read + post
 * without a WS gateway session.
 *
 * Kill-switch semantics: POSTs append + fan out to the feed unconditionally;
 * delivery-triggered inference still honors autonomousRoutingEnabled.
 */
export function createFleetRouter(bus: ConversationBus): unknown {
  const router = express.Router()
  const json = express.json({ limit: '1mb' })

  /** Send: claude-relay shape {sender, recipient, message}; recipient "broadcast" fans out. */
  const handleSend = (req: Req, res: Res) => {
    try {
      res.json({ ok: true, envelope: bus.handleRelayInbound(req.body) })
    } catch (e) {
      fail(res, e)
    }
  }
  router.post('/api/fleet/send', json, handleSend)
  // Original path — keep working (existing relay mirrors point here).
  router.post('/api/fleet/relay-inbound', json, handleSend)

  /** Cursor replay: ?afterSeq=-1&limit=200 → {records, nextAfterSeq, latestSeq}. */
  router.get('/api/fleet/feed', (req: Req, res: Res) => {
    try {
      const afterSeq = Number(req.query?.afterSeq ?? -1)
      const limit = Number(req.query?.limit ?? 200)
      res.json(bus.replay({ afterSeq, limit }))
    } catch (e) {
      fail(res, e)
    }
  })

  router.get('/api/fleet/agents', (_req: Req, res: Res) => {
    res.json({ agents: bus.registry.list(), statuses: bus.agentStatuses() })
  })

  router.get('/api/fleet/status', (_req: Req, res: Res) => {
    res.json({
      guardConfig: bus.getGuardConfig(),
      budget: bus.guards.budgetStatus(),
      latestSeq: bus.replay({ afterSeq: -1, limit: 1 }).latestSeq,
    })
  })

  /** Declare/update a fleet agent (schema-validated by the registry). */
  router.post('/api/fleet/register', json, (req: Req, res: Res) => {
    try {
      res.json({ ok: true, agent: bus.registry.upsert(req.body) })
    } catch (e) {
      fail(res, e)
    }
  })

  return router
}
