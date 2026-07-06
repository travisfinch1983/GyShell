// @ts-expect-error — express ships untyped in this repo (same pattern as hermesHttp/ftpHttp)
import express from 'express'
import { TOOLS_FOR_MODEL, runWebSearch, runWebFetch } from '../AgentHelper/tools'

/** TOOLS_FOR_MODEL is OpenAI-tool shape: { type:'function', function:{ name, description, parameters } };
 *  `parameters` is already JSON Schema, so it's the MCP inputSchema as-is. */
type OpenAiTool = { type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }

type Req = express.Request
type Res = express.Response

/**
 * Native-tools bridge for the "ailab-native" gateway server (config federation).
 *
 * The AI-Lab chat agent's built-in tools are surfaced to the MCP Gateway webui so ALL
 * tools — native + MCP — are visible and enable/disable-able in ONE place. The stdio
 * `ailab-native` MCP server (registered on the gateway) mirrors these:
 *   - GET /api/agent/native-tools     → tool metadata (name/description/JSON-Schema)
 *   - POST /api/agent/native-tools/exec → execute a STATELESS tool
 *
 * Only truly stateless tools (web_search/web_fetch — pure functions) execute via the
 * gateway. Session-bound tools (terminal, memory, delegate, file edit) are listed for
 * config only; they keep executing natively in the agent loop where they have the
 * session/terminal context an MCP round-trip can't carry.
 */
const STATELESS: Record<string, (args: unknown, signal?: AbortSignal) => Promise<unknown>> = {
  web_search: runWebSearch,
  web_fetch: runWebFetch,
}

export function createNativeToolsRouter(): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '1mb' })

  router.get('/api/agent/native-tools', (_req: Req, res: Res) => {
    try {
      const tools = (TOOLS_FOR_MODEL as OpenAiTool[]).map((t) => {
        const fn = t.function
        return {
          name: fn.name,
          description: fn.description || '',
          inputSchema: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
          stateless: fn.name in STATELESS,
        }
      })
      res.json({ tools })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  router.post('/api/agent/native-tools/exec', json, async (req: Req, res: Res) => {
    const body = (req.body ?? {}) as { name?: unknown; args?: unknown }
    const name = String(body.name ?? '')
    const impl = STATELESS[name]
    if (!impl) {
      return res.status(400).json({
        error: `'${name}' runs natively in the AI-Lab agent (session-bound); it is exposed here for enable/disable config only, not gateway execution.`,
      })
    }
    try {
      const result = await impl(body.args ?? {})
      res.json({ ok: true, result })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  return router
}
