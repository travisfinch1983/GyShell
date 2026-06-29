// Claude tab — manage multiple Claude Code instances across LXC containers.
// Phase 1: connections registry + Central Directives + per-connection CLAUDE/RULES/MEMORY/TOOLS editors +
// restart, all reached via SSH to the container's PVE node → `pct exec <vmid> -- ...` (no key inside the
// container needed). Phase 2 adds the ttyd reverse-proxy terminal + auto-provisioning.
/* eslint-disable */
// @ts-nocheck
import { Router } from 'express'
import express from 'express'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FILE_WHITELIST = new Set(['CLAUDE.md', 'RULES.md', 'MEMORY.md', 'TOOLS.md'])
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'` // single-quote shell-escape

export function createClaudeRouter({ exec }) {
  const router = Router()
  const json = express.json({ limit: '10mb' })
  const dataDir = process.env.AILAB_PROXY_DATA_DIR || '/tmp'
  const file = join(dataDir, 'claude-connections.json')

  const loadHostMap = () => {
    try {
      const h = JSON.parse(readFileSync(join(dataDir, 'hosts.json'), 'utf-8'))
      const m = {}
      for (const e of h.entries || []) if (e.name && e.ip) m[e.name] = e.ip
      return m
    } catch { return {} }
  }
  const load = () => {
    try { if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8')) } catch {}
    return { connections: [], directives: { nodeIp: '10.0.0.17', vmid: '180', path: '/claude/CENTRAL-DIRECTIVES.md' } }
  }
  const save = (d) => { try { writeFileSync(file, JSON.stringify(d, null, 2)) } catch {} }
  const nodeIpOf = (conn) => conn.nodeIp || loadHostMap()[conn.node] || conn.node
  const pct = (conn, inner, opts = {}) => exec(nodeIpOf(conn), `pct exec ${conn.vmid} -- ${inner}`, { timeout: 20000, ...opts })

  // ── connections CRUD ──
  router.get('/connections', (_req, res) => res.json(load()))
  router.post('/connections', json, (req, res) => {
    const d = load()
    const b = req.body || {}
    if (!b.name || !b.vmid) return res.status(400).json({ error: 'name and vmid required' })
    const hostMap = loadHostMap()
    const conn = {
      id: b.id || Math.random().toString(16).slice(2, 8),
      name: b.name, vmid: String(b.vmid), node: b.node || '', nodeIp: b.nodeIp || hostMap[b.node] || '',
      containerIp: b.containerIp || '', workspacePath: b.workspacePath || '/root',
      ttydPort: b.ttydPort || 7681, sessionSock: b.sessionSock || '', restartCommand: b.restartCommand || '',
    }
    const idx = d.connections.findIndex((c) => c.id === conn.id)
    if (idx >= 0) d.connections[idx] = { ...d.connections[idx], ...conn }
    else d.connections.push(conn)
    save(d)
    res.json(conn)
  })
  router.delete('/connections/:id', (req, res) => {
    const d = load(); d.connections = d.connections.filter((c) => c.id !== req.params.id); save(d); res.json({ ok: true })
  })

  // ── LXC list for the add dropdown (from the seeded inventory) ──
  router.get('/lxc', (_req, res) => {
    try {
      const inv = JSON.parse(readFileSync(join(dataDir, 'inventory.json'), 'utf-8'))
      const out = (inv.entries || []).filter((e) => e.type === 'lxc').map((e) => ({ vmid: e.vmid, name: e.name, ip: e.ip, node: e.node }))
      res.json({ entries: out })
    } catch (e) { res.json({ entries: [] }) }
  })

  // ── per-connection workspace files ──
  router.get('/connections/:id/file', async (req, res) => {
    const d = load(); const conn = d.connections.find((c) => c.id === req.params.id)
    const name = req.query.name
    if (!conn) return res.status(404).json({ error: 'connection not found' })
    if (!FILE_WHITELIST.has(name)) return res.status(400).json({ error: 'file not allowed' })
    try {
      const r = await pct(conn, `cat ${q(conn.workspacePath + '/' + name)}`)
      if (r.code !== 0) return res.json({ content: '', missing: true, error: (r.stderr || '').trim() })
      res.json({ content: r.stdout, path: `${conn.workspacePath}/${name}` })
    } catch (e) { res.status(502).json({ error: e?.message || String(e) }) }
  })
  router.put('/connections/:id/file', json, async (req, res) => {
    const d = load(); const conn = d.connections.find((c) => c.id === req.params.id)
    const name = req.query.name
    if (!conn) return res.status(404).json({ error: 'connection not found' })
    if (!FILE_WHITELIST.has(name)) return res.status(400).json({ error: 'file not allowed' })
    try {
      const b64 = Buffer.from(String(req.body?.content ?? ''), 'utf-8').toString('base64')
      const target = conn.workspacePath + '/' + name
      const r = await pct(conn, `sh -c ${q(`printf %s ${b64} | base64 -d > ${q(target)}`)}`, { timeout: 30000 })
      if (r.code !== 0) return res.status(502).json({ error: (r.stderr || 'write failed').trim() })
      res.json({ ok: true })
    } catch (e) { res.status(502).json({ error: e?.message || String(e) }) }
  })

  // ── restart the instance ──
  router.post('/connections/:id/restart', async (req, res) => {
    const d = load(); const conn = d.connections.find((c) => c.id === req.params.id)
    if (!conn) return res.status(404).json({ error: 'connection not found' })
    if (!conn.restartCommand) return res.status(400).json({ error: 'no restart command configured for this connection' })
    try { const r = await pct(conn, `sh -c ${q(conn.restartCommand)}`, { timeout: 30000 }); res.json({ ok: r.code === 0, code: r.code, stderr: (r.stderr || '').trim() }) }
    catch (e) { res.status(502).json({ error: e?.message || String(e) }) }
  })

  // ── Central Directives (shared mount, read via a container that has /claude) ──
  router.get('/directives', async (req, res) => {
    const dir = load().directives
    try {
      const r = await exec(dir.nodeIp, `pct exec ${dir.vmid} -- cat ${q(dir.path)}`, { timeout: 15000 })
      res.json({ content: r.code === 0 ? r.stdout : '', path: dir.path, error: r.code !== 0 ? (r.stderr || '').trim() : undefined })
    } catch (e) { res.status(502).json({ error: e?.message || String(e) }) }
  })
  router.put('/directives', json, async (req, res) => {
    const dir = load().directives
    try {
      const b64 = Buffer.from(String(req.body?.content ?? ''), 'utf-8').toString('base64')
      const r = await exec(dir.nodeIp, `pct exec ${dir.vmid} -- sh -c ${q(`printf %s ${b64} | base64 -d > ${q(dir.path)}`)}`, { timeout: 30000 })
      if (r.code !== 0) return res.status(502).json({ error: (r.stderr || 'write failed').trim() })
      res.json({ ok: true })
    } catch (e) { res.status(502).json({ error: e?.message || String(e) }) }
  })

  return router
}
