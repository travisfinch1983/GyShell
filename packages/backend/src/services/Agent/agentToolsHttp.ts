// @ts-expect-error — express ships untyped in this repo (same pattern as hermesHttp/ftpHttp)
import express from 'express'

import { syncToolGroup } from '../mcp/toolGroups.js'

type Req = express.Request
type Res = express.Response

/**
 * Per-agent tool selection (config federation — the Agents › Tools picker).
 *
 * The picker works in GATEWAY tool names (server__tool, exactly what /api/mcp/tree returns).
 * This router owns the reconciliation between that and the agent executor:
 *   - allowedTools canonical form: ailab-native tools are stored as BARE built-in names
 *     (web_search, exec_command, …) so the existing delegate executor + buildToolsForModel
 *     keep matching them; every other server keeps its gateway server__tool name (an MCP tool).
 *   - On save we ALSO sync a gateway tool-group `agent-<id>` from the raw selection, so the
 *     agent (and any external client — a fleet Claude, a Hermes agent) can consume the exact
 *     curated set at /v0/groups/agent-<id>/mcp.
 *
 * NOTE (phasing): selection + group sync are live immediately. In-process delegated agents can
 * only RUN the stateless native subset today; MCP + session-bound tools are selectable and work
 * for external group consumers, and become in-process-runnable in the execution fast-follow.
 */
const MCPJUNGLE_URL = (process.env.MCPJUNGLE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
const NATIVE_PREFIX = 'ailab-native__'

// Native built-ins that actually execute inside a delegated agent today (mirror of
// delegate_agent_tool.ts STATELESS_TOOLS — keep in sync).
const DELEGATE_RUNNABLE_NATIVE = new Set([
  'web_fetch', 'web_search', 'read_file', 'create_or_edit', 'skill', 'create_skill',
  'memory_list_collections', 'memory_recall', 'memory_save', 'memory_create_collection', 'memory_delete',
])

// gateway/tree name -> canonical allowedTools entry
const toCanonical = (treeName: string): string =>
  treeName.startsWith(NATIVE_PREFIX) ? treeName.slice(NATIVE_PREFIX.length) : treeName
// canonical allowedTools entry -> gateway/tree name (a bare, no-"__" name is an ailab-native built-in)
const toTreeName = (canonical: string): string =>
  canonical.includes('__') ? canonical : `${NATIVE_PREFIX}${canonical}`

async function fetchEnabledMap(): Promise<Record<string, boolean>> {
  const servers = await (await fetch(`${MCPJUNGLE_URL}/api/v0/servers`, { signal: AbortSignal.timeout(8000) })).json() as Array<{ name: string; enabled?: boolean }>
  const map: Record<string, boolean> = {}
  for (const s of servers) {
    try {
      const tools = await (await fetch(`${MCPJUNGLE_URL}/api/v0/tools?server=${encodeURIComponent(s.name)}`, { signal: AbortSignal.timeout(8000) })).json() as Array<{ name: string; enabled?: boolean }>
      for (const t of tools) map[t.name] = (s.enabled !== false) && (t.enabled !== false)
    } catch { /* skip a server that won't enumerate */ }
  }
  return map
}

// Group writes go through the SHARED helper (services/mcp/toolGroups.ts) so this path and the
// Hermes one cannot drift again. It validates every name against the live registry, expands a
// bare server name into its tools, and PUTs in place — this function used to be POST-only, which
// meant it silently could not update an existing group and 400'd on a whole-toolset selection.
async function syncGroup(agentId: string, treeNames: string[], description: string): Promise<string> {
  await syncToolGroup(MCPJUNGLE_URL, `agent-${agentId}`, description || `Tool set for agent ${agentId}`, treeNames)
  return `${MCPJUNGLE_URL}/v0/groups/agent-${agentId}/mcp`
}

export function createAgentToolsRouter(deps: { settingsService: any; agentService: any }): express.Router {
  const { settingsService, agentService } = deps
  const router = express.Router()
  const json = express.json({ limit: '1mb' })

  router.get('/api/mcp/agent-tools/:agentId', (req: Req, res: Res) => {
    try {
      const agents = settingsService.getSettings().agents ?? []
      const agent = agents.find((a: any) => a.id === req.params.agentId)
      if (!agent) return res.status(404).json({ error: 'agent not found' })
      const selected = (agent.allowedTools ?? []).map(toTreeName)
      res.json({ selected })
    } catch (e) {
      res.status(500).json({ error: String((e as Error)?.message || e) })
    }
  })

  router.put('/api/mcp/agent-tools/:agentId', json, async (req: Req, res: Res) => {
    const agentId = req.params.agentId
    const body = (req.body ?? {}) as { selected?: unknown }
    const treeNames = Array.isArray(body.selected) ? body.selected.filter((x): x is string => typeof x === 'string') : null
    if (!treeNames) return res.status(400).json({ error: 'body needs { selected: string[] }' })
    try {
      const settings = settingsService.getSettings()
      const agents = (settings.agents ?? []).slice()
      const idx = agents.findIndex((a: any) => a.id === agentId)
      if (idx === -1) return res.status(404).json({ error: 'agent not found' })

      // Persist canonical allowedTools. deepMerge replaces arrays wholesale, so writing the
      // full agents array is a clean replace.
      const canonical = Array.from(new Set(treeNames.map(toCanonical)))
      agents[idx] = { ...agents[idx], allowedTools: canonical }
      settingsService.setSettings({ agents })
      agentService.updateSettings(settingsService.getSettings())

      // Sync the gateway group (best-effort — the selection is already persisted).
      let endpoint: string | null = null
      let groupError: string | null = null
      try { endpoint = await syncGroup(agentId, treeNames, agents[idx].description) }
      catch (e) { groupError = String((e as Error)?.message || e) }

      // Status counts (best-effort).
      let disabledSelectedCount = 0
      let unsupportedCount = 0
      let functionalCount = 0
      let countsFailed: string | null = null
      try {
        const enabled = await fetchEnabledMap()
        for (const tn of treeNames) {
          const globallyOn = enabled[tn] !== false
          if (!globallyOn) disabledSelectedCount++
          const nativeBare = tn.startsWith(NATIVE_PREFIX) ? tn.slice(NATIVE_PREFIX.length) : null
          const runnableInProc = nativeBare != null && DELEGATE_RUNNABLE_NATIVE.has(nativeBare)
          if (runnableInProc) { if (globallyOn) functionalCount++ }
          else unsupportedCount++ // MCP or session-bound native: external-only until the exec fast-follow
        }
      } catch (e) {
        // Counts are advisory, but zeros-from-failure read as "you selected
        // nothing runnable" — a different claim entirely. Mark them unknown.
        countsFailed = String((e as Error)?.message || e)
        console.warn(`[agent-tools] status counts unavailable for ${agentId}: ${countsFailed}`)
      }

      res.json({
        ok: true, agentId, count: canonical.length, endpoint, groupError,
        // null = could not be computed (countsError says why) — NOT zero.
        functionalCount: countsFailed ? null : functionalCount,
        disabledSelectedCount: countsFailed ? null : disabledSelectedCount,
        unsupportedCount: countsFailed ? null : unsupportedCount,
        ...(countsFailed ? { countsError: countsFailed } : {}),
      })
    } catch (e) {
      res.status(500).json({ error: String((e as Error)?.message || e) })
    }
  })

  return router
}
