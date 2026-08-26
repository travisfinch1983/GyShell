// @ts-expect-error — express ships untyped in this repo (same pre-existing gap as UniversalProxyService)
import express from 'express'
import { agentActivitySchema } from '@gyshell/shared'
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
  /**
   * Liveness ping from a delivery agent. Body: { agents: [{agentId, alive}] }.
   * The forwarder owns the dtach sockets, so it is the only thing that can tell
   * whether a session is actually reachable.
   */
  router.post('/api/fleet/heartbeat', json, (req: Req, res: Res) => {
    try {
      const list = Array.isArray((req.body as any)?.agents) ? (req.body as any).agents : []
      let n = 0
      for (const a of list) {
        const id = typeof a?.agentId === 'string' ? a.agentId : ''
        if (!id) { console.warn('[fleet] heartbeat entry missing agentId:', JSON.stringify(a)); continue }
        bus.recordHeartbeat(id, a?.alive !== false)
        n++
      }
      res.json({ ok: true, recorded: n })
    } catch (e) {
      fail(res, e)
    }
  })

  /**
   * Collector push. Body: a single AgentActivity, or { activities: [...] }.
   * Validated against the shared schema so a malformed report is REJECTED
   * loudly rather than stored and later read as truth.
   */
  /**
   * Flip fleet guard settings at runtime — notably `autonomousRoutingEnabled`,
   * the kill switch HermesBusSubscriber waits on. The bus already persisted and
   * announced changes; there was simply no way to reach setGuardConfig without
   * editing code, so the switch was effectively welded off.
   */
  router.post('/api/fleet/guard', json, (req: Req, res: Res) => {
    try {
      const patch = (req.body ?? {}) as Record<string, unknown>
      const before = bus.getGuardConfig()
      const after = bus.setGuardConfig(patch)
      const changed = Object.keys(after).filter(
        (k) => (before as any)[k] !== (after as any)[k],
      )
      if (changed.length) console.warn('[fleet] guard config changed:', changed.map((k) => `${k}: ${(before as any)[k]} -> ${(after as any)[k]}`).join(', '))
      res.json({ ok: true, guardConfig: after, changed })
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/api/fleet/activity', json, (req: Req, res: Res) => {
    try {
      const body = req.body as any
      const list = Array.isArray(body?.activities) ? body.activities : [body]
      let ok = 0
      const errors: string[] = []
      for (const raw of list) {
        const parsed = agentActivitySchema.safeParse(raw)
        if (!parsed.success) {
          const msg = `${raw?.agentId ?? '<no agentId>'}: ${parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => i.path.join('.') + ' ' + i.message).join('; ')}`
          console.warn('[fleet] REJECTED activity report —', msg)
          errors.push(msg)
          continue
        }
        bus.recordActivity(parsed.data)
        ok++
      }
      res.json({ ok: true, recorded: ok, ...(errors.length ? { rejected: errors } : {}) })
    } catch (e) {
      fail(res, e)
    }
  })

  /** Read activity. `?agentId=` for one, omit for all. */
  router.get('/api/fleet/activity', (req: Req, res: Res) => {
    try {
      const id = typeof req.query?.agentId === 'string' ? req.query.agentId : undefined
      res.json({ activity: bus.agentActivity(id) })
    } catch (e) {
      fail(res, e)
    }
  })

  /**
   * Recent transcript entries for an agent — "where did they get to?".
   * The collector reports a `ref` of the form "<transcriptPath>#<uuid>"; we read
   * the tail of that file rather than duplicating gigabytes of transcript into a
   * second store that could then disagree with reality.
   */
  router.get('/api/fleet/activity/detail', async (req: Req, res: Res) => {
    try {
      const agentId = typeof req.query?.agentId === 'string' ? req.query.agentId : ''
      if (!agentId) return fail(res, new Error('agentId is required'))
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit ?? 20)))

      const [act] = bus.agentActivity(agentId)
      if (!act) {
        return res.json({
          agentId, entries: [], source: 'none',
          note: 'No collector has reported for this agent — that is UNKNOWN, not idle.',
        })
      }
      const recent = act.recent ?? []
      res.json({
        agentId,
        source: act.kind,
        state: act.state,
        idleSeconds: act.idleSeconds,
        transcript: String(act.ref ?? '').split('#')[0] || null,
        entries: recent.slice(-limit),
        available: recent.length,
        ...(recent.length
          ? {}
          : {
              note:
                'Collector has not shipped a recent window yet (it only sends one when the ' +
                'agent has newly acted). Idle agents will show none until they next do something.',
            }),
      })
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/api/fleet/register', json, (req: Req, res: Res) => {
    try {
      res.json({ ok: true, agent: bus.registry.upsert(req.body) })
    } catch (e) {
      fail(res, e)
    }
  })

  return router
}
