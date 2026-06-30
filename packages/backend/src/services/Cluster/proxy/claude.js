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
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
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
export IS_SANDBOX=1
ID=${q(id)}; PORT=${q(String(port))}; BASE=${q(base)}; WS=${q(ws)}; SOCKHINT=${q(sockHint)}
TTYD=$(command -v ttyd || { [ -x /usr/local/bin/ttyd ] && echo /usr/local/bin/ttyd; } || true)
if [ -z "$TTYD" ]; then ARCH=$(uname -m); wget -qO /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.$ARCH" 2>/dev/null && chmod +x /usr/local/bin/ttyd && TTYD=/usr/local/bin/ttyd; fi
[ -z "$TTYD" ] && { echo "ERR: ttyd unavailable (install failed)"; exit 1; }
DTACH=$(command -v dtach || echo /bin/dtach)
# Prefer the versioned ~/.local/bin/claude over a possibly-stale /usr/bin/claude (avoids running an old build).
CLAUDE=""
for p in /root/.local/bin/claude "$HOME/.local/bin/claude" /usr/local/bin/claude $(command -v claude 2>/dev/null) /usr/bin/claude $(ls /root/.nvm/versions/node/*/bin/claude 2>/dev/null); do
  [ -n "$p" ] && [ -x "$p" ] && CLAUDE="$p" && break
done

# 1) Permissions: do NOT touch ~/.claude/settings.json. Setting permissions.defaultMode=bypassPermissions
#    makes Claude Code REFUSE TO LAUNCH AS ROOT ("--dangerously-skip-permissions cannot be used with
#    root/sudo") — the same guard as the flag. These containers run as root and already skip prompts via
#    their trusted folder (~/.claude.json) + their own allow-list. Leave their settings alone.
SETTINGS_DONE=untouched

# 2) Resolve the session socket: explicit hint, else the user's own dtach session (skip our managed ones),
#    else the canonical /tmp/claude.sock (matches the user's claudecode alias so they converge — no duplicate).
SOCK="$SOCKHINT"
[ -z "$SOCK" ] && SOCK=$(pgrep -af dtach 2>/dev/null | grep -v 'ailab-managed' | grep -oE '/[^ ]+\\.sock' | head -1)
[ -z "$SOCK" ] && SOCK="/tmp/claude.sock"

# 3) Retire legacy per-connection managed sessions/sockets (we now converge on the stable socket).
pkill -f '/tmp/claude-[0-9a-f][0-9a-f]*\\.sock' 2>/dev/null || true
rm -f /tmp/claude-*.sock 2>/dev/null || true
# One managed terminal per container: tear down any OTHER claude-term unit so it can't hold port $PORT.
for f in /etc/systemd/system/claude-term-*.service; do
  [ -e "$f" ] || continue
  u=$(basename "$f"); [ "$u" = "claude-term-$ID.service" ] && continue
  systemctl disable --now "$u" >/dev/null 2>&1 || true; rm -f "$f"
done

# 4) Boot launcher: ensure the dtach session exists (spawn a respawning claude -c if absent), then serve ttyd.
cat > /usr/local/bin/claude-term-$ID.sh <<LAUNCH
#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin
export IS_SANDBOX=1
[ -S "$SOCK" ] || "$DTACH" -n "$SOCK" sh -c "export TERM=xterm-256color; cd /root 2>/dev/null; while :; do IS_SANDBOX=1 $CLAUDE -c; sleep 2; done # ailab-managed" >/dev/null 2>&1 || true
sleep 1
exec "$TTYD" --base-path $BASE --writable -p $PORT "$DTACH" -a "$SOCK"
LAUNCH
chmod +x /usr/local/bin/claude-term-$ID.sh

# 5) Boot-enabled service (owns lifecycle: session + terminal come back after reboot).
cat > /etc/systemd/system/claude-term-$ID.service <<UNIT
[Unit]
Description=AI-Lab Claude session + terminal ($ID)
After=network-online.target
[Service]
Environment=IS_SANDBOX=1
ExecStart=/usr/local/bin/claude-term-$ID.sh
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now claude-term-$ID.service >/dev/null 2>&1 || true
sleep 4
echo "ttyd=$TTYD"; echo "claude=\${CLAUDE:-NONE}"; echo "session=$SOCK"; echo "settings=\${SETTINGS_DONE}"; echo "port=$PORT"; echo "active=$(systemctl is-active claude-term-$ID.service 2>/dev/null)"; echo "log=$(journalctl -u claude-term-$ID.service -n 3 --no-pager 2>/dev/null | tail -1)"`
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
  // Browser-side trace shim: injected into the ttyd HTML so we capture the JS STACK TRACE at the moment
  // any "/clear"-ish input is sent over the WebSocket. A human keystroke comes from xterm's key handler;
  // an auto-injection comes from a reconnect/visibility/timer handler — the stack tells them apart, which
  // the server-side input log (same connection, same UA) cannot. Beacons to POST /api/claude/termtrace.
  const TERMTRACE_SHIM = `<script>(function(){try{var OS=WebSocket.prototype.send;WebSocket.prototype.send=function(d){try{var s=typeof d==='string'?d:((d&&(d.byteLength!=null))?new TextDecoder().decode(d):'');if(s&&s.charCodeAt(0)===48){var p=s.slice(1);var cl=p.indexOf('/clear')!==-1;var en=(p==='\\r'||p==='\\n')&&window.__cz&&(Date.now()-window.__cz)<3000;if(cl||en){var rec={t:Date.now(),path:location.pathname,payload:p,vis:document.visibilityState,focus:document.hasFocus&&document.hasFocus(),stack:(new Error()).stack};try{navigator.sendBeacon('/api/claude/termtrace',new Blob([JSON.stringify(rec)],{type:'application/json'}));}catch(e){}console.warn('[termtrace] clear-ish send',rec);}if(cl)window.__cz=Date.now();}}catch(e){}return OS.apply(this,arguments);};console.log('[termtrace] shim installed');}catch(e){}})();</script>`

  // Receives the browser trace beacons and appends them (with stack trace) to the trace log.
  router.post('/termtrace', express.json({ type: () => true, limit: '256kb' }), (req, res) => {
    try {
      const b = req.body || {}
      _termLog(`${new Date().toISOString()} TRACE path=${b.path} payload=${JSON.stringify(b.payload)} vis=${b.vis} focus=${b.focus}\n    stack: ${String(b.stack || '').replace(/\n/g, ' | ')}`)
    } catch {}
    res.status(204).end()
  })

  const termProxy = (req, res) => {
    const conn = load().connections.find((c) => c.id === req.params.id)
    if (!conn) return res.status(404).send('connection not found')
    const ip = containerIpFor(conn), port = conn.ttydPort || MANAGED_TTYD_PORT
    if (!ip) return res.status(502).send('no container IP')
    const up = http.request({ host: ip, port, method: req.method, path: req.originalUrl, headers: { ...req.headers, host: `${ip}:${port}` } }, (r) => {
      const ct = String(r.headers['content-type'] || '')
      // Inject the trace shim into the main HTML doc (skip if compressed — don't corrupt the body).
      if (ct.includes('text/html') && !r.headers['content-encoding']) {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8')
          html = html.includes('<head>') ? html.replace('<head>', '<head>' + TERMTRACE_SHIM) : TERMTRACE_SHIM + html
          const body = Buffer.from(html, 'utf8')
          const headers = { ...r.headers }; delete headers['content-length']; headers['content-length'] = String(body.length)
          res.writeHead(r.statusCode || 502, headers); res.end(body)
        })
        r.on('error', () => { if (!res.headersSent) res.status(502).end() })
      } else {
        res.writeHead(r.statusCode || 502, r.headers); r.pipe(res)
      }
    })
    up.on('error', (e) => { if (!res.headersSent) res.status(502).send('ttyd proxy: ' + e.message) })
    req.pipe(up)
  }
  router.all('/term/:id', termProxy)
  router.all('/term/:id/{*rest}', termProxy)

  return router
}

/** Attach the ttyd WebSocket reverse-proxy to the universal-proxy HTTP server (raw TCP pipe). */
// ── Terminal input audit log ──────────────────────────────────────────────
// Every keystroke the browser sends to a Claude terminal passes through this WS proxy. We decode the
// client→server ttyd frames and log the actual input + which connection it came from, so an erroneously
// injected command (e.g. a stray "/clear") can be traced to its source connection + timing. Logs to
// <dataDir>/claude-term-input.log. Output (server→client) is left as a plain pipe.
let _termConnSeq = 0
function _termLog(line) { try { appendFileSync(join(DATA(), 'claude-term-input.log'), line + '\n') } catch {} }

// Stateful parser for masked client WS frames → decode ttyd commands ('0' = INPUT). Returns a fn(chunk).
function _makeWsInputTap(cid) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f, off = 2
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const need = off + (masked ? 4 : 0) + len
      if (buf.length < need) break
      let payload
      if (masked) {
        const mk = buf.subarray(off, off + 4); payload = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mk[i & 3]
      } else payload = buf.subarray(off, off + len)
      buf = buf.subarray(need)
      if (opcode === 0x1 || opcode === 0x2) {
        const cmd = payload.length ? String.fromCharCode(payload[0]) : ''
        if (cmd === '0') { // ttyd INPUT
          const data = payload.subarray(1).toString('utf8')
          const flag = /\/clear|\/exit|\/quit/.test(data) ? '  <<<<<< SLASH-COMMAND' : ''
          _termLog(`${new Date().toISOString()} conn#${cid} INPUT ${JSON.stringify(data)}${flag}`)
        }
      } else if (opcode === 0x8) _termLog(`${new Date().toISOString()} conn#${cid} WS-CLOSE`)
    }
  }
}

export function attachClaudeTermUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    const m = (req.url || '').match(/^\/api\/claude\/term\/([^/]+)\//)
    if (!m) return
    const conn = loadConns().connections.find((c) => c.id === m[1])
    if (!conn) { socket.destroy(); return }
    const ip = containerIpFor(conn), port = conn.ttydPort || MANAGED_TTYD_PORT
    if (!ip) { socket.destroy(); return }
    const cid = ++_termConnSeq
    const h = req.headers || {}
    _termLog(`${new Date().toISOString()} conn#${cid} OPEN id=${m[1]} url=${req.url} remote=${socket.remoteAddress} xff=${h['x-forwarded-for'] || '-'} ua=${JSON.stringify(h['user-agent'] || '-')} ref=${JSON.stringify(h['referer'] || '-')} wskey=${h['sec-websocket-key'] || '-'}`)
    const tap = _makeWsInputTap(cid)
    const up = net.connect(port, ip, () => {
      let head_ = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]
        head_ += `${k}: ${k.toLowerCase() === 'host' ? `${ip}:${port}` : req.rawHeaders[i + 1]}\r\n`
      }
      head_ += '\r\n'
      up.write(head_); if (head && head.length) { try { tap(head) } catch {} up.write(head) }
      // tap client→server (input) for the audit log, then forward unchanged; output stays a plain pipe
      socket.on('data', (chunk) => { try { tap(chunk) } catch {} ; up.write(chunk) })
      up.pipe(socket)
    })
    socket.on('close', () => { _termLog(`${new Date().toISOString()} conn#${cid} SOCKET-CLOSE`); up.destroy() })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
}
