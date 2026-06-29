// Claude tab — manage multiple Claude Code instances across LXC containers.
// Phase 1: connections registry + Central Directives + per-connection CLAUDE/RULES/MEMORY/TOOLS editors +
// restart, all reached via SSH to the container's PVE node → `pct exec <vmid> -- ...` (no key inside the
// container needed). Phase 2 adds the ttyd reverse-proxy terminal + auto-provisioning.
/* eslint-disable */
// @ts-nocheck
import { Router } from 'express'
import express from 'express'
import http from 'node:http'
import net from 'node:net'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FILE_WHITELIST = new Set(['CLAUDE.md', 'RULES.md', 'MEMORY.md', 'TOOLS.md'])
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'` // single-quote shell-escape
const MANAGED_TTYD_PORT = 7690 // AI-Lab's own base-path ttyd (distinct from any pre-existing ttyd on 7681)

const DATA = () => process.env.AILAB_PROXY_DATA_DIR || '/tmp'
function loadConns() { try { return JSON.parse(readFileSync(join(DATA(), 'claude-connections.json'), 'utf-8')) } catch { return { connections: [] } } }
/** container IP for a connection: explicit, else resolved from the seeded inventory by vmid. */
function containerIpFor(conn) {
  if (conn.containerIp) return conn.containerIp
  try {
    const inv = JSON.parse(readFileSync(join(DATA(), 'inventory.json'), 'utf-8'))
    const e = (inv.entries || []).find((x) => String(x.vmid) === String(conn.vmid))
    return e?.ip || ''
  } catch { return '' }
}

/** Provisioning script (run via `pct exec <vmid> -- sh -c '<b64 | base64 -d | sh>'`). Idempotent:
 *  reuses an existing dtach session if present, installs ttyd if missing, and registers a managed
 *  base-path ttyd systemd unit that auto-starts at boot. Auto-accept via the env var (the --flag fails as root). */
function provisionScript(conn) {
  const id = conn.id, port = MANAGED_TTYD_PORT, base = `/api/claude/term/${id}`, ws = conn.workspacePath || '/root'
  const sockHint = conn.sessionSock || ''
  return `set -e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin:$PATH
ID=${q(id)}; PORT=${q(String(port))}; BASE=${q(base)}; WS=${q(ws)}; SOCK=${q(sockHint)}
TTYD=$(command -v ttyd || { [ -x /usr/local/bin/ttyd ] && echo /usr/local/bin/ttyd; } || true)
if [ -z "$TTYD" ]; then ARCH=$(uname -m); wget -qO /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.$ARCH" 2>/dev/null && chmod +x /usr/local/bin/ttyd && TTYD=/usr/local/bin/ttyd; fi
[ -z "$TTYD" ] && { echo "ERR: ttyd unavailable (install failed)"; exit 1; }
DTACH=$(command -v dtach || echo /bin/dtach)
CLAUDE=$(command -v claude || true)
[ -z "$CLAUDE" ] && for p in /root/.local/bin/claude /usr/local/bin/claude /usr/bin/claude $(ls /root/.nvm/versions/node/*/bin/claude 2>/dev/null); do [ -x "$p" ] && CLAUDE="$p" && break; done
if [ -z "$SOCK" ]; then EXIST=$(ls /tmp/*.sock 2>/dev/null | head -1); [ -n "$EXIST" ] && SOCK="$EXIST" || SOCK="/tmp/claude-$ID.sock"; fi
if [ ! -S "$SOCK" ] && [ -n "$CLAUDE" ]; then "$DTACH" -n "$SOCK" sh -c "cd $WS 2>/dev/null; while :; do DANGEROUSLY_SKIP_PERMISSIONS=true $CLAUDE; sleep 2; done" >/dev/null 2>&1 || true; fi
# One managed terminal per container: tear down any OTHER claude-term unit (e.g. an orphan from a prior
# add with a different connection id) so it can't hold port $PORT and block this one.
for f in /etc/systemd/system/claude-term-*.service; do
  [ -e "$f" ] || continue
  u=$(basename "$f")
  [ "$u" = "claude-term-$ID.service" ] && continue
  systemctl disable --now "$u" >/dev/null 2>&1 || true
  rm -f "$f"
done
cat > /etc/systemd/system/claude-term-$ID.service <<UNIT
[Unit]
Description=AI-Lab Claude terminal ($ID)
After=network-online.target
[Service]
Environment=DANGEROUSLY_SKIP_PERMISSIONS=true
ExecStart=$TTYD --base-path $BASE --writable -p $PORT $DTACH -a $SOCK
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now claude-term-$ID.service >/dev/null 2>&1 || true
sleep 3
echo "ttyd=$TTYD"; echo "claude=\${CLAUDE:-NONE}"; echo "sock=$SOCK"; echo "port=$PORT"; echo "active=$(systemctl is-active claude-term-$ID.service 2>/dev/null)"; echo "log=$(journalctl -u claude-term-$ID.service -n 3 --no-pager 2>/dev/null | tail -1)"`
}

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

  // ── auto-provisioning (ttyd + dtach session + boot auto-start, auto-accept via env) ──
  router.post('/connections/:id/setup', async (req, res) => {
    const d = load(); const conn = d.connections.find((c) => c.id === req.params.id)
    if (!conn) return res.status(404).json({ error: 'connection not found' })
    try {
      const b64 = Buffer.from(provisionScript(conn), 'utf-8').toString('base64')
      const r = await exec(nodeIpOf(conn), `pct exec ${conn.vmid} -- sh -c ${q(`printf %s ${b64} | base64 -d | sh`)}`, { timeout: 90000 })
      const out = (r.stdout || '') + (r.stderr || '')
      const sock = (out.match(/^sock=(.+)$/m) || [])[1]
      const claudePath = (out.match(/^claude=(.+)$/m) || [])[1]
      const active = (out.match(/^active=(.+)$/m) || [])[1]
      runInActionSave(d, conn, { ttydPort: MANAGED_TTYD_PORT, sessionSock: sock && sock !== '' ? sock : conn.sessionSock, claudePath, provisioned: active === 'active' })
      res.json({ ok: r.code === 0 && active === 'active', active, log: out.trim() })
    } catch (e) { res.status(502).json({ error: e?.message || String(e) }) }
  })

  // helper to persist a patch onto a connection
  function runInActionSave(d, conn, patch) {
    const idx = d.connections.findIndex((c) => c.id === conn.id)
    if (idx >= 0) { d.connections[idx] = { ...d.connections[idx], ...patch }; save(d) }
  }

  // ── ttyd reverse-proxy (HTTP) — /api/claude/term/:id/* → container ttyd (base-path matches) ──
  const termProxy = (req, res) => {
    const conn = load().connections.find((c) => c.id === req.params.id)
    if (!conn) return res.status(404).send('connection not found')
    const ip = containerIpFor(conn), port = conn.ttydPort || MANAGED_TTYD_PORT
    if (!ip) return res.status(502).send('no container IP')
    const up = http.request({ host: ip, port, method: req.method, path: req.originalUrl, headers: { ...req.headers, host: `${ip}:${port}` } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res)
    })
    up.on('error', (e) => { if (!res.headersSent) res.status(502).send('ttyd proxy: ' + e.message) })
    req.pipe(up)
  }
  router.all('/term/:id', termProxy)
  router.all('/term/:id/{*rest}', termProxy)

  return router
}

/** Attach the ttyd WebSocket reverse-proxy to the universal-proxy HTTP server (raw TCP pipe). */
export function attachClaudeTermUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    const m = (req.url || '').match(/^\/api\/claude\/term\/([^/]+)\//)
    if (!m) return
    const conn = loadConns().connections.find((c) => c.id === m[1])
    if (!conn) { socket.destroy(); return }
    const ip = containerIpFor(conn), port = conn.ttydPort || MANAGED_TTYD_PORT
    if (!ip) { socket.destroy(); return }
    const up = net.connect(port, ip, () => {
      let head_ = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]
        head_ += `${k}: ${k.toLowerCase() === 'host' ? `${ip}:${port}` : req.rawHeaders[i + 1]}\r\n`
      }
      head_ += '\r\n'
      up.write(head_); if (head && head.length) up.write(head)
      socket.pipe(up); up.pipe(socket)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
}
