// @ts-expect-error — express ships untyped in this repo (same pre-existing gap as UniversalProxyService)
import express from 'express'
import { hermesAgentSpecSchema, providerServiceSchema } from '@gyshell/shared'
import type { HermesService } from './HermesService'
import type { AcpEvent } from './HermesAcpBridge'

type Req = express.Request
type Res = express.Response

/**
 * HTTP surface for the AI-Lab × Hermes control plane. Mounted on the universal proxy app
 * (same place as the fleet router). All operations are server-side; the SSE stream is a
 * pure OBSERVER — disconnecting only detaches, it never stops the backend-owned session
 * (headless invariant, see /claude/plans/ailab-hermes-integration.md).
 */
export function createHermesRouter(hermes: HermesService): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '2mb' })

  // List agent profiles.
  router.get('/api/hermes/agents', async (_req: Req, res: Res) => {
    try {
      res.json({ agents: await hermes.listAgents() })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // Create/update an agent from a HermesAgentSpec.
  router.post('/api/hermes/agents', json, async (req: Req, res: Res) => {
    try {
      const spec = hermesAgentSpecSchema.parse(req.body)
      const result = await hermes.applySpec(spec)
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message) })
    }
  })

  // Read back the persisted spec for one agent (for the UI edit flow). 404 if the agent
  // exists as a profile but was never applied through AI-Lab (no stored spec).
  router.get('/api/hermes/agents/:id', async (req: Req, res: Res) => {
    try {
      const spec = hermes.getSpec(req.params.id)
      if (!spec) return res.status(404).json({ error: 'no stored spec for agent' })
      res.json({ spec })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  router.delete('/api/hermes/agents/:id', async (req: Req, res: Res) => {
    try {
      await hermes.deleteAgent(req.params.id)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // Fire one turn and return the assembled reply (also streams to any /stream observers).
  router.post('/api/hermes/agents/:id/prompt', json, async (req: Req, res: Res) => {
    const text = String((req.body as { text?: unknown })?.text ?? '')
    if (!text.trim()) return res.status(400).json({ error: 'text required' })
    try {
      const r = await hermes.runTurn(req.params.id, text)
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // Transcript read-back — buffered normalized events for a live session, so a reloaded UI
  // can restore the conversation view before it re-attaches the live stream. The response
  // carries `lastSeq`; the UI then opens /stream?since=lastSeq to resume with no gap or dup.
  // 404 if no live session (backend-owned session isn't running → nothing buffered).
  router.get('/api/hermes/agents/:id/history', async (req: Req, res: Res) => {
    try {
      const since = Number((req.query as { since?: unknown }).since ?? 0) || 0
      const h = hermes.getHistory(req.params.id, since)
      if (!h) return res.status(404).json({ error: 'no live session for agent' })
      res.json(h)
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // SSE observer — attaches to the session's live normalized event stream.
  //   - No cursor: emit the current `ready` snapshot (model/mode/commands) then live events
  //     — byte-identical to the original fresh-attach contract.
  //   - ?since=<seq> (reconnect after /history): DON'T re-send ready; instead replay only the
  //     events buffered after `since`, then go live — closing the race where an event lands
  //     between the /history fetch and this attach. Live events are queued during the replay
  //     and flushed with seq-dedup so nothing is lost or doubled.
  router.get('/api/hermes/agents/:id/stream', async (req: Req, res: Res) => {
    const id = req.params.id
    const since = Number((req.query as { since?: unknown }).since ?? 0) || 0
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    ;(res as unknown as { flushHeaders?: () => void }).flushHeaders?.()

    let ready: AcpEvent
    try {
      ready = await hermes.ensureReady(id)
    } catch (e) {
      res.write(`data: ${JSON.stringify({ t: 'error', message: String((e as Error).message) })}\n\n`)
      return res.end()
    }

    // Attach the live listener FIRST, buffering into a queue, so no event emitted during the
    // replay below is dropped. Flip to direct-write once the replay is flushed.
    let queue: AcpEvent[] | null = []
    const off = hermes.onEvent(id, (ev) => {
      if (queue) { queue.push(ev); return }
      try { res.write(`data: ${JSON.stringify(ev)}\n\n`) } catch { /* client gone */ }
    })
    // Detach ONLY the observer on disconnect — the backend-owned session keeps running.
    req.on('close', () => off())

    let lastWritten = 0
    if (since > 0) {
      for (const ev of hermes.getHistory(id, since)?.events ?? []) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
        lastWritten = ev.seq ?? lastWritten
      }
      if (!lastWritten) lastWritten = since
    } else {
      res.write(`data: ${JSON.stringify(ready)}\n\n`)
      lastWritten = ready.seq ?? 0
    }

    // Flush anything that arrived during replay, deduped against what we just wrote, then
    // hand the listener the live channel.
    const pending = queue
    queue = null
    for (const ev of pending) {
      if ((ev.seq ?? 0) > lastWritten) res.write(`data: ${JSON.stringify(ev)}\n\n`)
    }
  })

  // ── Provider Services registry (keyed non-model providers: ElevenLabs TTS etc.) ──
  // One entry holds an account API key ONCE; the backend pushes it into Hermes .env (per
  // PROVIDER_SERVICE_CAPS) so agents with tts.provider=<x> pick it up. Keys are masked
  // end-to-end, mirroring the Model API sources registry.

  // List — key never returned raw; masked to ***<last4> + hasKey.
  router.get('/api/hermes/provider-services', (_req: Req, res: Res) => {
    try {
      const services = hermes.mgmt.getProviderServices().map((s) => ({
        ...s,
        // Don't reveal a short key by showing its whole tail — only last-4 when there's more to hide.
        apiKey: s.apiKey ? (s.apiKey.length > 4 ? `***${s.apiKey.slice(-4)}` : '***') : undefined,
        hasKey: !!s.apiKey,
      }))
      res.json({ services })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // Create/update (upsert by id). A blank or still-masked apiKey preserves the stored key.
  router.post('/api/hermes/provider-services', json, async (req: Req, res: Res) => {
    try {
      const parsed = providerServiceSchema.parse(req.body)
      const stored = hermes.mgmt.getProviderServices().find((e) => e.id === parsed.id)
      const apiKey = !parsed.apiKey || parsed.apiKey.startsWith('***') ? stored?.apiKey : parsed.apiKey
      await hermes.mgmt.upsertProviderService({ ...parsed, apiKey })
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message) })
    }
  })

  // Delete + clear the provider's secret from Hermes .env.
  router.delete('/api/hermes/provider-services/:id', async (req: Req, res: Res) => {
    try {
      await hermes.mgmt.deleteProviderService(req.params.id)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  return router
}
