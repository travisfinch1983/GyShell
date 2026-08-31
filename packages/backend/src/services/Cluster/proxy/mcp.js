// AI-Lab MCP Gateway management — /api/mcp/*.
// Talks to the MCPJungle 0.4.5 REST API directly (the gateway now runs locally on the
// AI-Lab container as ai-lab-mcp.service, so no SSH/CLI-text-parsing needed — that path
// broke when 0.4.5 changed the `list` output format). `exec` is retained only for the
// rare deregister-server call.
import express from 'express'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const MCPJUNGLE_URL = (process.env.MCPJUNGLE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
const MCPJUNGLE_HOST = process.env.MCPJUNGLE_HOST || '127.0.0.1'
const AILAB_SELF = (process.env.AILAB_API_URL || 'http://127.0.0.1:17890').replace(/\/+$/, '')

/** ailab-native federates the AI-Lab chat agent's built-ins so they can be enabled/disabled
 * alongside MCP tools, but only its STATELESS tools actually execute over the gateway —
 * session-bound ones answer tools/call with a config-only refusal (they run inside AI-Lab's
 * own agent loop). Report which is which so pickers for external agents (Hermes) can hide
 * the dead ones. Static fallback = the two known-stateless tools, so a metadata hiccup
 * never re-advertises dead tools. */
async function statelessNativeTools() {
  try {
    const r = await fetch(`${AILAB_SELF}/api/agent/native-tools`, { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    const set = new Set()
    for (const t of d.tools || []) if (t.stateless) set.add(`ailab-native__${t.name}`)
    if (set.size) return set
  } catch { /* fall through to the static floor */ }
  return new Set(['ailab-native__web_search', 'ailab-native__web_fetch'])
}

async function gwGet(path) {
  const r = await fetch(`${MCPJUNGLE_URL}${path}`, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`gateway ${path} -> ${r.status}`)
  return r.json()
}
async function gwPost(path, body) {
  const r = await fetch(`${MCPJUNGLE_URL}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) throw new Error(`gateway ${path} -> ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json().catch(() => ({}))
}
async function gwDelete(path) {
  const r = await fetch(`${MCPJUNGLE_URL}${path}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) })
  if (!r.ok && r.status !== 404) throw new Error(`gateway ${path} -> ${r.status}`)
  return { ok: true }
}

/** "server__tool" -> "tool" (the gateway namespaces every tool with its server). */
const shortName = (full) => {
  const i = full.indexOf('__')
  return i === -1 ? full : full.slice(i + 2)
}

export function createMcpRouter({ exec }) {
  const router = express.Router()
  const dataDir = process.env.AILAB_PROXY_DATA_DIR || '/tmp'
  const settingsPath = join(dataDir, 'mcp-settings.json')

  async function mcpjungleCli(cmd) {
    const result = await exec(MCPJUNGLE_HOST, `PATH=/opt/ai-lab-mcp:/usr/local/bin:$PATH mcpjungle ${cmd} 2>&1`, { timeout: 15000 })
    return (result.stdout || '') + (result.stderr || '')
  }
  const getSettings = () => {
    try { return JSON.parse(readFileSync(settingsPath, 'utf8')) } catch { return { maxToolRounds: 20, toolInjection: true } }
  }
  const saveSettings = (s) => {
    try { mkdirSync(dataDir, { recursive: true }) } catch { /* ignore */ }
    writeFileSync(settingsPath, JSON.stringify(s, null, 2))
    return s
  }

  router.get('/health', async (_req, res) => {
    try {
      const resp = await fetch(`${MCPJUNGLE_URL}/health`, { signal: AbortSignal.timeout(8000) })
      res.json(await resp.json())
    } catch (e) {
      res.json({ status: 'unreachable', error: e.message })
    }
  })

  // Grouped tree for the native quick-toggle panel: every registered server with its tools
  // and their global enable state (servers AND tools each carry an `enabled` flag). The
  // `ailab-native` server shows up here too, so the agent's built-ins toggle alongside MCP.
  router.get('/tree', async (_req, res) => {
    try {
      const servers = await gwGet('/api/v0/servers')
      const stateless = await statelessNativeTools()
      const out = []
      for (const s of servers) {
        let tools = []
        try { tools = await gwGet(`/api/v0/tools?server=${encodeURIComponent(s.name)}`) } catch (e) {
        // toolCount:0 from a FAILED enumeration was indistinguishable from a
        // server exposing no tools — name which server would not enumerate.
        console.warn(`[mcp] tool enumeration failed for '${s.name}' — rendering 0 tools (${e?.message})`)
        tools = []
      }
        const mapped = tools.map((t) => ({
          name: t.name,
          shortName: shortName(t.name),
          enabled: t.enabled !== false,
          description: t.description || '',
          // false = listed for config federation only; tools/call through the gateway refuses it
          gatewayExecutable: s.name !== 'ailab-native' || stateless.has(t.name),
        }))
        out.push({
          name: s.name,
          description: s.description || '',
          enabled: s.enabled !== false,
          sessionMode: s.session_mode || '',
          transport: s.transport || '',
          toolCount: mapped.length,
          enabledCount: mapped.filter((t) => t.enabled).length,
          tools: mapped,
        })
      }
      out.sort((a, b) => a.name.localeCompare(b.name))
      res.json({ servers: out })
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  // Toggle a single tool or a whole server on/off globally.
  // body: { scope: 'tool' | 'server', name: string, enabled: boolean }
  router.post('/toggle', express.json(), async (req, res) => {
    const { scope, name, enabled } = req.body || {}
    if (!name || (scope !== 'tool' && scope !== 'server')) {
      return res.status(400).json({ error: 'body needs { scope: "tool"|"server", name, enabled }' })
    }
    const action = enabled ? 'enable' : 'disable'
    try {
      if (scope === 'tool') await gwPost(`/api/v0/tools/${action}?entity=${encodeURIComponent(name)}`)
      else await gwPost(`/api/v0/servers/${encodeURIComponent(name)}/${action}`)
      res.json({ ok: true, scope, name, enabled: !!enabled })
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  // Legacy list endpoints, now REST-backed (this also revives the old dead panel).
  router.get('/servers', async (_req, res) => {
    try { res.json(await gwGet('/api/v0/servers')) } catch (e) { res.status(502).json({ error: e.message }) }
  })
  router.get('/tools', async (req, res) => {
    try {
      if (req.query.server) return res.json(await gwGet(`/api/v0/tools?server=${encodeURIComponent(String(req.query.server))}`))
      const servers = await gwGet('/api/v0/servers')
      const all = []
      for (const s of servers) {
        try { all.push(...(await gwGet(`/api/v0/tools?server=${encodeURIComponent(s.name)}`))) } catch (e) { console.warn(`[mcp] tool enumeration failed for '${s.name}' — its tools are absent from this listing (${e?.message})`) }
      }
      res.json(all)
    } catch (e) { res.status(502).json({ error: e.message }) }
  })
  router.post('/tools/:name/enable', async (req, res) => {
    try { await gwPost(`/api/v0/tools/enable?entity=${encodeURIComponent(req.params.name)}`); res.json({ ok: true }) } catch (e) { res.status(502).json({ error: e.message }) }
  })
  router.post('/tools/:name/disable', async (req, res) => {
    try { await gwPost(`/api/v0/tools/disable?entity=${encodeURIComponent(req.params.name)}`); res.json({ ok: true }) } catch (e) { res.status(502).json({ error: e.message }) }
  })

  // --- Tool groups (per-agent curated tool sets exposed at /v0/groups/<name>/mcp) ---
  // A group is created/synced from an agent's tool selection; the agent then consumes it.
  router.get('/groups', async (_req, res) => {
    try { res.json(await gwGet('/api/v0/tool-groups')) } catch (e) { res.status(502).json({ error: e.message }) }
  })
  router.get('/groups/:name', async (req, res) => {
    try { res.json(await gwGet(`/api/v0/tool-groups/${encodeURIComponent(req.params.name)}`)) } catch (e) { res.status(502).json({ error: e.message }) }
  })
  // Upsert a group. body: { name, description?, included_servers?, included_tools?, excluded_tools? }
  // The gateway POST /api/v0/tool-groups is create-or-update keyed by name.
  router.put('/groups/:name', express.json(), async (req, res) => {
    const b = req.body || {}
    const payload = {
      name: req.params.name,
      description: b.description || '',
      included_servers: Array.isArray(b.included_servers) ? b.included_servers : [],
      included_tools: Array.isArray(b.included_tools) ? b.included_tools : [],
      excluded_tools: Array.isArray(b.excluded_tools) ? b.excluded_tools : [],
    }
    try {
      await gwPost('/api/v0/tool-groups', payload)
      res.json({ ok: true, name: payload.name, endpoint: `${MCPJUNGLE_URL}/v0/groups/${payload.name}/mcp` })
    } catch (e) { res.status(502).json({ error: e.message }) }
  })
  router.delete('/groups/:name', async (req, res) => {
    try { res.json(await gwDelete(`/api/v0/tool-groups/${encodeURIComponent(req.params.name)}`)) } catch (e) { res.status(502).json({ error: e.message }) }
  })

  router.get('/settings', (_req, res) => res.json(getSettings()))
  router.put('/settings', express.json(), (req, res) => {
    try { res.json(saveSettings({ ...getSettings(), ...(req.body || {}) })) } catch (e) { res.status(500).json({ error: e.message }) }
  })
  router.delete('/servers/:name', async (req, res) => {
    try { await mcpjungleCli(`deregister ${req.params.name}`); res.json({ ok: true }) } catch (e) { res.status(502).json({ error: e.message }) }
  })

  return router
}
