import express from 'express'
import { hermesAgentSpecSchema } from '@gyshell/shared'
import type { HermesService } from './HermesService'

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

  // SSE observer — attaches to the session's live normalized event stream.
  router.get('/api/hermes/agents/:id/stream', async (req: Req, res: Res) => {
    const id = req.params.id
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    ;(res as unknown as { flushHeaders?: () => void }).flushHeaders?.()
    try {
      const ready = await hermes.ensureReady(id)
      res.write(`data: ${JSON.stringify(ready)}\n\n`)
    } catch (e) {
      res.write(`data: ${JSON.stringify({ t: 'error', message: String((e as Error).message) })}\n\n`)
      return res.end()
    }
    const off = hermes.onEvent(id, (ev) => {
      try { res.write(`data: ${JSON.stringify(ev)}\n\n`) } catch { /* client gone */ }
    })
    // Detach ONLY the observer on disconnect — the backend-owned session keeps running.
    req.on('close', () => off())
  })

  return router
}
