import { spawn as ptySpawn, type IPty } from 'node-pty'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Server } from 'http'

/**
 * Native console bridge for the consolidated Claude instances — replaces the
 * per-instance ttyd terminals (see /claude/plans/ailab-native-console.md).
 *
 * WS `/api/claude/console/:id` → node-pty running the dtach attach over SSH to
 * the instance container (sockets live there, mode srwx------, so user
 * instances attach via a `su - <user>` drop).
 *
 * The two properties that fix the spontaneous /clear:
 *  - SINGLE-WRITER: one live attach per instance, enforced here. A new WS for
 *    an instance CLOSES the old session first (last-writer-wins — a wifi
 *    reconnect takes over cleanly; two attaches never coexist).
 *  - CLEAN RECONNECT: every connect is a fresh `dtach -a` (dtach redraws the
 *    current screen). No input buffering, no replay — a dropped connection's
 *    unsent keystrokes are simply gone.
 *
 * Wire protocol (browser ↔ here):
 *  - binary frames: raw terminal bytes, both directions.
 *  - text frames: JSON control. client→server {t:'resize',cols,rows} |
 *    {t:'input',data} (fallback for clients that can't send binary);
 *    server→client {t:'status',state:'attached'|'exit'|'takeover'|'error',detail?}.
 * Closing the WS kills the pty — dtach detaches; the persistent session
 * survives in its `dtach -N` host on the container.
 */

export interface ClaudeConsoleConfig {
  /** instance-manager base, e.g. http://10.0.0.161:7700 */
  managerUrl: string
  /** ssh key authorized as root on the instance container (AILAB_SSH_KEY convention) */
  sshKeyPath: string
  /** container ssh target, e.g. root@10.0.0.161 */
  sshTarget: string
}

interface ManagedInstance {
  id: string
  user?: string
  /** explicit socket from the manager registry (its instances.json `sock` field —
   *  not exposed over GET /instances yet; claude1 asked to add it) */
  consoleSocket?: string
  sock?: string
}

interface ConsoleSession {
  id: string
  seq: number
  ws: WebSocket
  pty: IPty
}

/**
 * Socket names are ad-hoc history (claude.sock, claude-fable.sock, claude-dhb.sock)
 * — no clean derivation rule exists, so the current fleet is mapped explicitly.
 * The manager's registry `sock` field is authoritative when the API exposes it.
 */
const KNOWN_SOCKETS: Record<string, string> = {
  claude1: '/tmp/claude.sock',
  'fable-builder': '/tmp/claude-fable.sock',
  claude2: '/tmp/claude-claude2.sock',
  'claude-dhb': '/tmp/claude-dhb.sock',
}

export function socketForInstance(inst: ManagedInstance): string {
  return inst.sock ?? inst.consoleSocket ?? KNOWN_SOCKETS[inst.id] ?? `/tmp/claude-${inst.user ?? inst.id}.sock`
}

/**
 * The remote attach command; user-owned sockets require attaching AS the owner.
 *
 * `-r winch`: on attach, make dtach send a SIGWINCH to the program instead of its
 * default Ctrl-L. dtach keeps no screen buffer — it only nudges the app to repaint,
 * and Claude Code's full-screen (Ink) TUI ignores Ctrl-L, so a fresh attach showed a
 * blank screen (just a cursor) until an external winch arrived (which is why a manual
 * Proxmox `dtach -a` was needed to "wake" it — and that 2nd attach is the /clear
 * multi-attach vector). SIGWINCH reliably forces the TUI to re-render on attach.
 */
export function attachCommandFor(inst: ManagedInstance): string {
  const socket = socketForInstance(inst)
  const user = inst.user ?? 'root'
  // SINGLE-ATTACH ENFORCEMENT: reap any stray `dtach -a` clients on this socket BEFORE we
  // attach. A second client (the legacy ttyd, another browser) makes dtach flip-flop the
  // shared pty size on every resize -> garbled lines / blank screen / lost cursor for
  // fleet instances that also run a ttyd (claude1/root has none, so it was never affected).
  // It's also the /clear multi-attach vector. We reap ONLY real dtach procs (comm=dtach) so
  // the ttyd wrapper + the su layer are untouched; runs as root (ssh target) so it can reap
  // a user-owned client. Our own attach is exec'd AFTER, surviving as the sole client.
  const reap = `for p in $(pgrep -f 'dtach -a ${socket}' 2>/dev/null); do [ "$(cat /proc/$p/comm 2>/dev/null)" = dtach ] && kill "$p" 2>/dev/null; done`
  // dtach usage is `-a <socket> <options>` — the socket MUST precede -r or dtach 0.9
  // rejects it with "Invalid number of arguments" (only once a tty exists, i.e. under ssh -tt).
  if (user === 'root') return `${reap}; exec dtach -a ${socket} -r winch`
  // Drop to the socket owner with runuser (NO login shell / PAM session) — `su - <user> -c`
  // ran a login shell whose profile/terminal setup corrupted the pty stream (blank content,
  // resize garble) for fleet-user instances; claude1/root attaches directly and was never
  // affected. runuser -u <user> -- <argv> execs straight through, inheriting the ssh pty clean.
  return `${reap}; exec runuser -u ${user} -- dtach -a ${socket} -r winch`
}

export class ClaudeConsoleService {
  private sessions = new Map<string, ConsoleSession>()
  private seq = 0

  constructor(private cfg: ClaudeConsoleConfig) {}

  /** Mount the WS upgrade listener next to the existing ttyd proxy (separate path). */
  attachUpgrade(server: Server): void {
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const m = (req.url || '').match(/^\/api\/claude\/console\/([^/?]+)/)
      if (!m) return // other listeners (ttyd proxy, gateway) own their paths
      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.attach(decodeURIComponent(m[1]), ws)
      })
    })
  }

  /** How many live consoles (for status surfaces). */
  liveSessions(): string[] {
    return [...this.sessions.keys()]
  }

  private async resolveInstance(id: string): Promise<ManagedInstance | null> {
    try {
      const r = await fetch(`${this.cfg.managerUrl}/instances`, { signal: AbortSignal.timeout(8000) })
      const body = (await r.json()) as { instances?: ManagedInstance[] }
      return body.instances?.find((i) => i.id === id) ?? null
    } catch {
      return null
    }
  }

  private async attach(id: string, ws: WebSocket): Promise<void> {
    const inst = await this.resolveInstance(id)
    if (!inst) {
      this.sendStatus(ws, 'error', `unknown instance "${id}" (instance-manager unreachable or id not registered)`)
      ws.close(4404, 'unknown instance')
      return
    }

    // SINGLE-WRITER: displace any existing attach before spawning ours.
    const old = this.sessions.get(id)
    if (old) {
      this.sendStatus(old.ws, 'takeover', 'another client attached — this console was displaced')
      try { old.pty.kill() } catch { /* already dead */ }
      try { old.ws.close(4001, 'takeover') } catch { /* already closed */ }
      this.sessions.delete(id)
    }

    const seq = ++this.seq
    let pty: IPty
    try {
      pty = ptySpawn(
        'ssh',
        [
          '-tt',
          '-i', this.cfg.sshKeyPath,
          '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=8',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'ServerAliveInterval=15',
          this.cfg.sshTarget,
          attachCommandFor(inst),
        ],
        { name: 'xterm-256color', cols: 80, rows: 24 },
      )
    } catch (e) {
      this.sendStatus(ws, 'error', `pty spawn failed: ${String((e as Error).message)}`)
      ws.close(4500, 'pty spawn failed')
      return
    }

    const session: ConsoleSession = { id, seq, ws, pty }
    this.sessions.set(id, session)
    this.sendStatus(ws, 'attached', socketForInstance(inst))

    // Liveness is handled without a native WS ping (that would need ws.ping/terminate,
    // which the type-only `ws` import can't see): the client drives an app-level
    // ping/pong (below) for its own half-open detection, and a genuinely dead attach
    // is reaped server-side by SSH ServerAliveInterval (~45s) → pty exit → cleanup.

    // pty → browser (raw bytes as binary frames)
    pty.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'), { binary: true })
    })
    pty.onExit(({ exitCode }) => {
      if (this.sessions.get(id)?.seq !== seq) return // a takeover already replaced us
      this.sessions.delete(id)
      this.sendStatus(ws, 'exit', `attach process exited (${exitCode})`)
      try { ws.close(4002, 'pty exit') } catch { /* already closed */ }
    })

    // browser → pty. Binary = raw input bytes; text = JSON control.
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this.sessions.get(id)?.seq !== seq) return
      if (isBinary) {
        pty.write(data.toString('utf8'))
        return
      }
      try {
        const msg = JSON.parse(data.toString('utf8')) as { t?: string; cols?: number; rows?: number; data?: string }
        if (msg.t === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          pty.resize(Math.max(2, Math.min(500, msg.cols!)), Math.max(2, Math.min(300, msg.rows!)))
        } else if (msg.t === 'input' && typeof msg.data === 'string') {
          pty.write(msg.data)
        } else if (msg.t === 'ping') {
          // App-level liveness: give the client a frame it can see (browser auto-pong
          // is invisible to JS), so an idle-but-healthy console isn't mistaken for dead.
          if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify({ t: 'pong' })) } catch { /* racing close */ } }
        }
      } catch { /* ignore malformed control frames — never guess at input */ }
    })

    // CLEAN RECONNECT: closing kills the pty (dtach detaches). Nothing is
    // buffered or replayed — the next connect gets a fresh dtach redraw.
    ws.on('close', () => {
      if (this.sessions.get(id)?.seq !== seq) return
      this.sessions.delete(id)
      try { pty.kill() } catch { /* already dead */ }
    })
    ws.on('error', () => {
      if (this.sessions.get(id)?.seq !== seq) return
      this.sessions.delete(id)
      try { pty.kill() } catch { /* already dead */ }
    })
  }

  private sendStatus(ws: WebSocket, state: 'attached' | 'exit' | 'takeover' | 'error', detail?: string): void {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify({ t: 'status', state, detail })) } catch { /* racing close */ }
    }
  }
}
