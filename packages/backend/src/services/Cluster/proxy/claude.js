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

const DATA = () => process.env.AILAB_PROXY_DATA_DIR || '/tmp'
function loadConns() { try { return JSON.parse(readFileSync(join(DATA(), 'claude-connections.json'), 'utf-8')) } catch { return { connections: [] } } }
/** container IP for a connection: explicit, else resolved from the seeded inventory by vmid. */

/** Provisioning script (run via `pct exec <vmid> -- sh -c '<b64 | base64 -d | sh>'`). Idempotent:
 *  reuses an existing dtach session if present, installs ttyd if missing, and registers a managed
 *  base-path ttyd systemd unit that auto-starts at boot. Auto-accept via the env var (the --flag fails as root). */
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

  // ── consolidated instances (fleet-consolidation Phase 3) ──
  // Thin HTTP proxy to the instance-manager on CT180 — it owns the per-user
  // runtime (users/dtach/ttyd) and returns the frozen Instance contract shape.
  // All methods + subpaths forward verbatim; body is piped raw (no re-parse).
  const IM_URL = (process.env.CLAUDE_INSTANCE_MANAGER_URL || 'http://10.0.0.161:7700').replace(/\/+$/, '')
  router.use('/instances', (req, res) => {
    const target = `${IM_URL}/instances${req.url === '/' ? '' : req.url}`
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = chunks.length ? Buffer.concat(chunks) : undefined
        // Spawn provisions a user + units — allow it time; reads stay snappy.
        const timeout = req.method === 'GET' ? 15000 : 120000
        const r = await fetch(target, {
          method: req.method,
          headers: {
            accept: 'application/json',
            ...(body ? { 'content-type': req.headers['content-type'] || 'application/json' } : {}),
          },
          body,
          signal: AbortSignal.timeout(timeout),
        })
        const text = await r.text()
        res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text)
      } catch (e) {
        res.status(502).json({ error: `instance-manager unreachable: ${e?.cause?.message || e.message}` })
      }
    })
  })

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
  router.delete('/connections/:id', async (req, res) => {
    const d = load(); const conn = d.connections.find((c) => c.id === req.params.id)
    // Tear down the container's managed terminal so it doesn't orphan (and keep holding the ttyd port).
    if (conn && conn.vmid) {
      const td = `sh -c ${q(`systemctl disable --now claude-term-${conn.id}.service >/dev/null 2>&1; rm -f /etc/systemd/system/claude-term-${conn.id}.service; systemctl daemon-reload`)}`
      try { await exec(nodeIpOf(conn), `pct exec ${conn.vmid} -- ${td}`, { timeout: 20000 }) } catch {}
    }
    d.connections = d.connections.filter((c) => c.id !== req.params.id); save(d); res.json({ ok: true })
  })

  // ── LXC list for the add dropdown (from the seeded inventory) ──
  router.get('/lxc', (_req, res) => {
    try {
      const inv = JSON.parse(readFileSync(join(dataDir, 'inventory.json'), 'utf-8'))
      const out = (inv.entries || []).filter((e) => e.type === 'lxc').map((e) => ({ vmid: e.vmid, name: e.name, ip: e.ip, node: e.node }))
      res.json({ entries: out })
    } catch (e) { res.json({ entries: [] }) }
  })

  // ── auto-detect the workspace dir holding the CLAUDE/RULES/MEMORY/TOOLS files on a container ──
  // Searches likely roots for the four agent files, ranks candidate directories by how many they hold
  // (CLAUDE.md weighted highest), and also reports the running Claude Code process's cwd as a hint.
  router.get('/detect-workspace', async (req, res) => {
    const node = req.query.node || ''
    const vmid = req.query.vmid
    if (!vmid) return res.status(400).json({ error: 'vmid required' })
    const nodeIp = req.query.nodeIp || loadHostMap()[node] || node
    const wanted = ['CLAUDE.md', 'RULES.md', 'MEMORY.md', 'TOOLS.md']
    // -L follows symlinks (ClawHub skill workspaces are symlinked); bounded depth + roots to stay fast.
    const findCmd = `sh -c ${q(
      'for r in /root /root/.claude "$HOME" "$HOME/.claude" /opt; do [ -d "$r" ] && find -L "$r" -maxdepth 4 -type f ' +
      '\\( -iname CLAUDE.md -o -iname RULES.md -o -iname MEMORY.md -o -iname TOOLS.md \\) 2>/dev/null; done | sort -u; ' +
      'echo "===CWD==="; for p in $(pgrep -f "claude" 2>/dev/null); do readlink /proc/$p/cwd 2>/dev/null; done | sort -u'
    )}`
    try {
      const r = await exec(nodeIp, `pct exec ${vmid} -- ${findCmd}`, { timeout: 25000 })
      const out = (r.stdout || '')
      const [filesPart, cwdPart = ''] = out.split('===CWD===')
      const byDir = {}
      for (const line of filesPart.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const slash = line.lastIndexOf('/')
        if (slash < 0) continue
        const dir = line.slice(0, slash) || '/'
        const file = line.slice(slash + 1)
        if (!wanted.some((w) => w.toLowerCase() === file.toLowerCase())) continue
        ;(byDir[dir] = byDir[dir] || new Set()).add(file)
      }
      const candidates = Object.entries(byDir).map(([dir, set]) => {
        const files = [...set]
        const hasClaude = files.some((f) => /^claude\.md$/i.test(f))
        return { dir, files, score: files.length + (hasClaude ? 10 : 0) }
      }).sort((a, b) => b.score - a.score)
      const cwds = cwdPart.split('\n').map((l) => l.trim()).filter(Boolean)
      res.json({ candidates, cwds, best: candidates[0]?.dir || cwds[0] || '/root' })
    } catch (e) { res.status(502).json({ error: e?.message || String(e), candidates: [], cwds: [] }) }
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
