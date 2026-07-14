// @ts-expect-error — express ships untyped in this repo (same pre-existing gap as UniversalProxyService)
import express from 'express'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { hermesAgentSpecSchema, providerServiceSchema } from '@gyshell/shared'
// @ts-expect-error — proxy capability resolver ships as untyped JS (same pattern as the other proxy/*.js imports)
import { resolveModelCapabilities } from '../Cluster/proxy/model-capabilities.js'
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
export function createHermesRouter(hermes: HermesService, roadmapFile?: string): express.Router {
  const router = express.Router()
  // 12mb: prompt bodies can carry a base64 screenshot (Feature A page-aware chat).
  const json = express.json({ limit: '12mb' })

  // List agent profiles + per-agent capabilities (Feature A: the UI attaches a
  // screenshot only when the bound agent's model is vision-capable).
  router.get('/api/hermes/agents', async (_req: Req, res: Res) => {
    try {
      const agents = await hermes.listAgents()
      const capabilities: Record<string, { model?: string; visionCapable: boolean; capabilities?: { text: boolean; vision: boolean; audio: boolean } }> = {}
      for (const id of agents) {
        const model = hermes.getSpec(id)?.model
        const caps = resolveModelCapabilities(model)
        capabilities[id] = { model, visionCapable: caps.vision, capabilities: caps }
      }
      res.json({ agents, capabilities })
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
      const stored = hermes.getSpec(req.params.id)
      if (stored) return res.json({ spec: stored, source: 'ailab-spec' })
      // No AI-Lab spec (OpenClaw-imported agent): reconstruct from the live host profile so
      // the editor shows real values instead of a blank form.
      const live = await hermes.reconstructSpec(req.params.id)
      if (live) return res.json({ spec: live, source: 'hermes-live' })
      return res.status(404).json({ error: 'no stored spec for agent' })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // Per-agent tool scoping via gateway groups. GET reads the agent's curated set (scoped:false
  // = still on the FULL gateway). PUT scopes it to a group + repoints its MCP server. DELETE
  // reverts to the full gateway.
  router.get('/api/hermes/agents/:id/tools', async (req: Req, res: Res) => {
    try { res.json(await hermes.getAgentTools(req.params.id)) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/agents/:id/tools', json, async (req: Req, res: Res) => {
    try {
      const selected = Array.isArray((req.body as any)?.selected) ? (req.body as any).selected.filter((x: unknown) => typeof x === 'string') : null
      if (!selected) return res.status(400).json({ error: 'body needs { selected: string[] }' })
      res.json({ ok: true, ...(await hermes.syncAgentTools(req.params.id, selected)) })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.delete('/api/hermes/agents/:id/tools', async (req: Req, res: Res) => {
    try { await hermes.resetAgentTools(req.params.id); res.json({ ok: true }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  // Native (built-in Hermes) tool on/off for the ACP chat agent — backs the acp-tool-override
  // plugin (native browser tools etc. can't be toggled via Hermes config on the ACP runtime).
  // GET catalog = the pristine native tool list; GET per-agent = catalog + current enabled state;
  // PUT = the full OFF list (per-tool). PUT /native-tools (no id) applies to every agent.
  router.get('/api/hermes/native-tools/catalog', async (_req: Req, res: Res) => {
    try { res.json({ tools: await hermes.nativeToolCatalog() }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.get('/api/hermes/agents/:id/native-tools', async (req: Req, res: Res) => {
    try { res.json(await hermes.getAgentNativeTools(req.params.id)) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/agents/:id/native-tools', json, async (req: Req, res: Res) => {
    try {
      const disabled = Array.isArray((req.body as any)?.disabled) ? (req.body as any).disabled.filter((x: unknown) => typeof x === 'string') : null
      if (!disabled) return res.status(400).json({ error: 'body needs { disabled: string[] }' })
      res.json({ ok: true, ...(await hermes.setAgentNativeTools(req.params.id, disabled)) })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/native-tools', json, async (req: Req, res: Res) => {
    try {
      const disabled = Array.isArray((req.body as any)?.disabled) ? (req.body as any).disabled.filter((x: unknown) => typeof x === 'string') : null
      if (!disabled) return res.status(400).json({ error: 'body needs { disabled: string[] }' })
      res.json({ ok: true, ...(await hermes.setGlobalNativeTools(disabled)) })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  // Add a doc to an agent by copying it from the `default` template store. Returns the new path.
  router.post('/api/hermes/agents/:id/add-doc', json, async (req: Req, res: Res) => {
    try {
      const templatePath = String((req.body as any)?.templatePath || '')
      const path = await hermes.addDocFromTemplate(req.params.id, templatePath)
      res.json({ ok: true, path })
    } catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })

  // Agent config docs — list + read/write the workspace/*.md operating docs on the Hermes
  // host (IDENTITY/USER/MEMORY/AGENTS/EXECUTION/TOOLS/… ). Path-validated, skills excluded.
  router.get('/api/hermes/agents/:id/memory-docs', async (req: Req, res: Res) => {
    try { res.json({ docs: await hermes.listMemoryDocs(req.params.id) }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.get('/api/hermes/agents/:id/docs', async (req: Req, res: Res) => {
    try { res.json({ docs: await hermes.listDocs(req.params.id) }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.get('/api/hermes/agents/:id/doc', async (req: Req, res: Res) => {
    try { res.json({ path: String(req.query.path || ''), content: await hermes.readDoc(req.params.id, String(req.query.path || '')) }) }
    catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })
  router.delete('/api/hermes/agents/:id/doc', async (req: Req, res: Res) => {
    try { await hermes.deleteDoc(req.params.id, String(req.query.path || '')); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/agents/:id/doc', json, async (req: Req, res: Res) => {
    try {
      const path = String((req.body as any)?.path || '')
      const content = typeof (req.body as any)?.content === 'string' ? (req.body as any).content : ''
      await hermes.writeDoc(req.params.id, path, content)
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })

  // Per-agent skill assignment (copy/remove skill dirs in the profile).
  router.get('/api/hermes/agents/:id/skills', async (req: Req, res: Res) => {
    try { res.json({ skills: await hermes.listAgentSkills(req.params.id) }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.post('/api/hermes/agents/:id/skills', json, async (req: Req, res: Res) => {
    try { await hermes.assignSkill(req.params.id, String((req.body as any)?.ref || '')); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })
  router.delete('/api/hermes/agents/:id/skills', async (req: Req, res: Res) => {
    try { await hermes.unassignSkill(req.params.id, String(req.query.ref || '')); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })

  router.get('/api/hermes/agents/:id/library-docs', async (req: Req, res: Res) => {
    try { res.json({ docs: await hermes.listAgentLibraryDocs(req.params.id) }) } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  // Central library docs (~/.hermes/library) + skill bonding.
  router.get('/api/hermes/library', async (_req: Req, res: Res) => {
    try { res.json({ docs: await hermes.listLibraryDocs() }) } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.get('/api/hermes/library/doc', async (req: Req, res: Res) => {
    try { const name = String(req.query.name || ''); res.json({ name, content: await hermes.readLibraryDoc(name) }) } catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/library/doc', json, async (req: Req, res: Res) => {
    try { await hermes.writeLibraryDoc(String(req.query.name || (req.body as any)?.name || ''), typeof (req.body as any)?.content === 'string' ? (req.body as any).content : ''); res.json({ ok: true }) } catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })
  router.post('/api/hermes/library/bond', json, async (req: Req, res: Res) => {
    try { const b = req.body as any; await hermes.bondDoc(String(b?.doc || ''), String(b?.skill || ''), b?.bonded !== false); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })
  router.post('/api/hermes/agents/:id/library-doc', json, async (req: Req, res: Res) => {
    try { await hermes.setAgentLibraryDoc(req.params.id, String((req.body as any)?.name || ''), (req.body as any)?.assigned !== false); res.json({ ok: true }) } catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })

  // Hermes skills LIBRARY (~/.hermes/skills) — the repurposed settings Skills tab manages it.
  router.get('/api/hermes/skills', async (_req: Req, res: Res) => {
    try { res.json({ skills: await hermes.listLibrarySkills() }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.get('/api/hermes/skills/item', async (req: Req, res: Res) => {
    try { const ref = String(req.query.ref || ''); res.json({ ref, content: await hermes.readLibrarySkill(ref) }) }
    catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/skills/item', json, async (req: Req, res: Res) => {
    try {
      const ref = String(req.query.ref || (req.body as any)?.ref || '')
      const content = typeof (req.body as any)?.content === 'string' ? (req.body as any).content : ''
      await hermes.writeLibrarySkill(ref, content)
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })

  // Skill tags (curated, sidecar-backed) + full-text search — powers the library filter/search UI.
  router.get('/api/hermes/skills/tags', async (_req: Req, res: Res) => {
    try { res.json({ tags: await hermes.listSkillTags() }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/skills/tags', json, async (req: Req, res: Res) => {
    try {
      const ref = String((req.body as any)?.ref || req.query.ref || '')
      const tags = Array.isArray((req.body as any)?.tags) ? (req.body as any).tags : []
      await hermes.setSkillTags(ref, tags)
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })
  router.get('/api/hermes/skills/search', async (req: Req, res: Res) => {
    try { res.json({ skills: await hermes.searchSkills(String(req.query.q || '')) }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  // Live SOUL.md persona — read/write the actual file on the Hermes host (NOT the AI-Lab spec
  // cache, which is empty for OpenClaw-imported agents). Fixes the blank persona editor.
  router.get('/api/hermes/agents/:id/soul', async (req: Req, res: Res) => {
    try { res.json({ soul: await hermes.readSoul(req.params.id) }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/agents/:id/soul', json, async (req: Req, res: Res) => {
    try {
      const soul = typeof (req.body as any)?.soul === 'string' ? (req.body as any).soul : ''
      await hermes.writeSoul(req.params.id, soul)
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
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
    const body = (req.body ?? {}) as { text?: unknown; context?: unknown; screenshot?: unknown; images?: unknown; conversationId?: unknown; wait?: unknown }
    const text = String(body.text ?? '')
    if (!text.trim()) return res.status(400).json({ error: 'text required' })
    // Feature A (page-aware): optional structured view context + screenshot data URL.
    // conversationId (per chat tab) scopes an independent session; omit → one-per-agent.
    const opts = {
      context: typeof body.context === 'string' ? body.context : undefined,
      screenshot: typeof body.screenshot === 'string' ? body.screenshot : undefined,
      images: Array.isArray(body.images) ? (body.images as unknown[]).filter((x) => typeof x === 'string') as string[] : undefined,
      sessionKey: typeof body.conversationId === 'string' ? body.conversationId : undefined,
    }
    try {
      if (body.wait === true) {
        // Blocking: assemble + return the full reply (non-streaming callers).
        const r = await hermes.runTurn(req.params.id, text, opts)
        return res.json({ ok: true, ...r })
      }
      // Default: FIRE-AND-ACK — return immediately; the reply arrives over /stream.
      // An LLM turn can take minutes, so blocking here would trip the cluster-proxy RPC timeout.
      await hermes.sendPrompt(req.params.id, text, opts)
      res.json({ ok: true, fired: true })
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
      const q = req.query as { since?: unknown; conversationId?: unknown }
      const since = Number(q.since ?? 0) || 0
      const key = typeof q.conversationId === 'string' ? q.conversationId : req.params.id
      const h = hermes.getHistory(key, since)
      if (!h) return res.status(404).json({ error: 'no live session for conversation' })
      res.json(h)
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // Server-side conversation list — the tab list, so conversations follow the user to ANY device.
  router.get('/api/hermes/conversations', (_req: Req, res: Res) => {
    try { res.json({ conversations: hermes.listConversations() }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  // Server-authoritative turn state (idle|busy). The UI reflects THIS for the Stop button, so a
  // reconnecting / other-device client is never stuck showing the wrong state.
  router.get('/api/hermes/agents/:id/status', (req: Req, res: Res) => {
    const q = req.query as { conversationId?: unknown }
    const key = typeof q.conversationId === 'string' ? q.conversationId : req.params.id
    res.json({ status: hermes.getStatus(key) })
  })

  // Stop button: cancel the in-flight turn (server forwards ACP session/cancel to the model). The
  // turn ends with stop_reason 'cancelled' and the status flips to idle over /stream. Idempotent.
  router.post('/api/hermes/agents/:id/cancel', json, (req: Req, res: Res) => {
    try {
      const q = req.query as { conversationId?: unknown }
      const b = (req.body ?? {}) as { conversationId?: unknown }
      const key = typeof q.conversationId === 'string' ? q.conversationId
        : typeof b.conversationId === 'string' ? b.conversationId : req.params.id
      hermes.cancelTurn(key)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // End + WIPE a conversation's session (called when a chat tab is closed) so a same-agent
  // reopen starts brand new. Idempotent — no-op if nothing's running for that key.
  router.delete('/api/hermes/agents/:id/session', (req: Req, res: Res) => {
    try {
      const q = req.query as { conversationId?: unknown }
      const key = typeof q.conversationId === 'string' ? q.conversationId : req.params.id
      hermes.stopSession(key)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // Page-aware vision: the `view_screen` MCP tool POSTs here. We ask the active chat frontend
  // to capture its screen (a capture_request on the conversation stream), write the returned
  // image into the agent's workspace on CT158, and return the local path for `vision_analyze`.
  router.post('/api/hermes/capture-screen', json, async (_req: Req, res: Res) => {
    try {
      const r = await hermes.captureScreen()
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(503).json({ error: String((e as Error).message) })
    }
  })

  // The frontend POSTs the captured screenshot back here, keyed by the capture_request's requestId.
  router.post('/api/hermes/screen-capture', json, (req: Req, res: Res) => {
    const body = (req.body ?? {}) as { requestId?: unknown; image?: unknown }
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    const image = typeof body.image === 'string' ? body.image : ''
    if (!requestId || !image) return res.status(400).json({ error: 'requestId + image required' })
    res.json({ ok: hermes.resolveCapture(requestId, image) })
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
    const q = req.query as { since?: unknown; conversationId?: unknown }
    const since = Number(q.since ?? 0) || 0
    const key = typeof q.conversationId === 'string' ? q.conversationId : id
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    ;(res as unknown as { flushHeaders?: () => void }).flushHeaders?.()

    let ready: AcpEvent
    try {
      ready = await hermes.ensureReady(id, key)
    } catch (e) {
      res.write(`data: ${JSON.stringify({ t: 'error', message: String((e as Error).message) })}\n\n`)
      return res.end()
    }

    // Attach the live listener FIRST, buffering into a queue, so no event emitted during the
    // replay below is dropped. Flip to direct-write once the replay is flushed.
    let queue: AcpEvent[] | null = []
    const off = hermes.onEvent(key, (ev) => {
      if (queue) { queue.push(ev); return }
      try { res.write(`data: ${JSON.stringify(ev)}\n\n`) } catch { /* client gone */ }
    })
    // Detach ONLY the observer on disconnect — the backend-owned session keeps running.
    req.on('close', () => off())

    let lastWritten = 0
    if (since > 0) {
      for (const ev of hermes.getHistory(key, since)?.events ?? []) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
        lastWritten = ev.seq ?? lastWritten
      }
      if (!lastWritten) lastWritten = since
    } else {
      res.write(`data: ${JSON.stringify(ready)}\n\n`)
      lastWritten = ready.seq ?? 0
    }

    // Always (re)assert the authoritative turn state on connect so a reconnecting or new client can
    // never be stuck showing the wrong Stop-button state (the OpenClaw failure mode). Idempotent.
    try { res.write(`data: ${JSON.stringify({ t: 'status', status: hermes.getStatus(key) })}\n\n`) } catch { /* client gone */ }

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

  // Global Support-Models roles (Vision Description describer for text-only agents, etc.).
  // GET returns the stored roles; PUT replaces them and re-applies vision routing to all agents.
  router.get('/api/hermes/support-models', (_req: Req, res: Res) => {
    try { res.json({ roles: hermes.getSupportModels() }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/support-models', json, async (req: Req, res: Res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>
      const parseRole = (v: unknown): { provider: string; model: string } | undefined => {
        const o = v as { provider?: unknown; model?: unknown } | null
        return o && typeof o.model === 'string' && o.model
          ? { provider: typeof o.provider === 'string' ? o.provider : 'ailab', model: o.model }
          : undefined
      }
      // Merge: only role keys PRESENT in the body change (null/empty clears; absent = preserved).
      const roles: Record<string, { provider: string; model: string }> = { ...(hermes.getSupportModels() as Record<string, { provider: string; model: string }>) }
      for (const key of ['visionDescription', 'compaction']) {
        if (key in b) { const r = parseRole(b[key]); if (r) roles[key] = r; else delete roles[key] }
      }
      const r = await hermes.setSupportModels(roles)
      res.json({ ok: true, ...r })
    } catch (e) { res.status(400).json({ error: String((e as Error).message) }) }
  })

  // Roadmap — one live-editable markdown doc (buildout plan + completed/outstanding checklist).
  // GET returns it; PUT overwrites it. Backs the Roadmap tab (rendered client-side with GFM task lists).
  router.get('/api/roadmap', (_req: Req, res: Res) => {
    try {
      const markdown = roadmapFile && existsSync(roadmapFile) ? readFileSync(roadmapFile, 'utf8') : ''
      res.json({ markdown })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/roadmap', json, (req: Req, res: Res) => {
    try {
      if (!roadmapFile) return res.status(503).json({ error: 'roadmap storage not configured' })
      const md = (req.body as { markdown?: unknown })?.markdown
      if (typeof md !== 'string') return res.status(400).json({ error: 'body needs { markdown: string }' })
      const dir = dirname(roadmapFile)
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(roadmapFile, md, 'utf8')
      res.json({ ok: true, bytes: Buffer.byteLength(md) })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  // Global USER doc-template ("About Travis") — shared across agents. GET returns it; PUT writes it
  // and re-propagates into every agent's AGENTS.md "About Your Human" section.
  router.get('/api/hermes/doc-templates/user', async (_req: Req, res: Res) => {
    try { res.json({ markdown: await hermes.getUserDoc() }) }
    catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })
  router.put('/api/hermes/doc-templates/user', json, async (req: Req, res: Res) => {
    try {
      const md = (req.body as { markdown?: unknown })?.markdown
      if (typeof md !== 'string') return res.status(400).json({ error: 'body needs { markdown: string }' })
      const r = await hermes.setUserDoc(md)
      res.json({ ok: true, ...r })
    } catch (e) { res.status(500).json({ error: String((e as Error).message) }) }
  })

  return router
}
