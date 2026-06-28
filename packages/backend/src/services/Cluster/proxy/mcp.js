// MCPJungle gateway management — ported from ProxLab server.js (/api/mcp/*).
// Runs the `mcpjungle` CLI on the gateway container via SSH + fetches its health.
import express from 'express'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const MCPJUNGLE_URL = process.env.MCPJUNGLE_URL || 'http://10.0.0.52:8080'
const MCPJUNGLE_HOST = process.env.MCPJUNGLE_HOST || '10.0.0.52'

/** Parse `mcpjungle list servers` output into structured data (verbatim from ProxLab). */
function parseServerList(output) {
  const servers = []
  const blocks = output.split(/(?=^\d+\.\s)/m)
  for (const block of blocks) {
    const nameMatch = block.match(/^\d+\.\s+(\S+)/)
    if (!nameMatch) continue
    const name = nameMatch[1]
    const descMatch = block.match(/^\d+\.\s+\S+\n(.+)/m)
    const transportMatch = block.match(/Transport:\s+(\S+)/)
    const cmdMatch = block.match(/Command:\s+(.+)/)
    const envMatch = block.match(/Environment variables:\s+map\[(.+)\]/)
    const urlMatch = block.match(/URL:\s+(\S+)/)
    servers.push({
      name,
      description: descMatch ? descMatch[1].trim() : '',
      transport: transportMatch ? transportMatch[1] : '',
      command: cmdMatch ? cmdMatch[1].trim() : '',
      url: urlMatch ? urlMatch[1] : '',
      env: envMatch ? envMatch[1] : '',
    })
  }
  return servers
}

/** Parse `mcpjungle list tools` output into structured data (verbatim from ProxLab). */
function parseToolList(output) {
  const tools = []
  const lines = output.split('\n')
  for (const line of lines) {
    const match = line.match(/^\d+\.\s+(\S+)\s+\[(ENABLED|DISABLED)\]/)
    if (match) {
      const [serverName, toolName] = match[1].split('__')
      tools.push({ fullName: match[1], server: serverName, tool: toolName, enabled: match[2] === 'ENABLED' })
    }
  }
  return tools
}

export function createMcpRouter({ exec }) {
  const router = express.Router()
  const dataDir = process.env.AILAB_PROXY_DATA_DIR || '/tmp'
  const settingsPath = join(dataDir, 'mcp-settings.json')

  async function mcpjungleCli(cmd) {
    const result = await exec(MCPJUNGLE_HOST, `cd /opt/mcpjungle && PATH=/usr/local/bin:$PATH mcpjungle ${cmd} 2>&1`, { timeout: 15000 })
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
      const gateway = await resp.json()
      res.json(gateway)
    } catch (e) {
      res.json({ status: 'unreachable', error: e.message })
    }
  })
  router.get('/servers', async (_req, res) => {
    try { res.json(parseServerList(await mcpjungleCli('list servers'))) } catch (e) { res.status(502).json({ error: e.message }) }
  })
  router.get('/tools', async (_req, res) => {
    try { res.json(parseToolList(await mcpjungleCli('list tools'))) } catch (e) { res.status(502).json({ error: e.message }) }
  })
  router.post('/tools/:name/enable', async (req, res) => {
    try { await mcpjungleCli(`enable tool ${req.params.name}`); res.json({ ok: true }) } catch (e) { res.status(502).json({ error: e.message }) }
  })
  router.post('/tools/:name/disable', async (req, res) => {
    try { await mcpjungleCli(`disable tool ${req.params.name}`); res.json({ ok: true }) } catch (e) { res.status(502).json({ error: e.message }) }
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
