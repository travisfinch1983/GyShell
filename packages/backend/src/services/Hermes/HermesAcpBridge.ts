import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'

/**
 * HermesAcpBridge — the BACKEND-OWNED persistent runner for Hermes agent sessions
 * (AI-Lab × Hermes). Honors the hard headless invariant (see
 * /claude/plans/ailab-hermes-integration.md):
 *
 *   - Each agent session is a long-lived child process:
 *       ssh <CT158> <pyvenv> /opt/acp-bridge/acp-bridge.py --profile <agentId>
 *     which drives `hermes -p <agentId> acp` and streams NORMALIZED ndjson events.
 *   - Sessions live in THIS service's Map — their lifecycle is owned by the backend,
 *     NEVER by a UI socket. UIs, the ConversationBus, and UIHistory are all mere
 *     OBSERVERS that subscribe via `onEvent`/the emitter and may come and go freely.
 *     Closing a browser cannot stop or pause an agent.
 *   - Prompts arrive from anywhere (UI or bus-inbound) via `prompt()`.
 *
 * This service does NOT persist transcripts or touch the bus itself — callers wire
 * those on top of its event stream, keeping the runner single-responsibility.
 */

export interface HermesAcpConfig {
  host: string // CT158, e.g. 10.0.0.236
  sshKeyPath: string // AI-Lab's key authorized on CT158
  user?: string // default root
  bridgePath?: string // default /opt/acp-bridge/acp-bridge.py
  pythonBin?: string // default the hermes venv python (has the `acp` lib)
  readyTimeoutMs?: number // default 30000
  historyCap?: number // max events buffered per session (ring); default 5000
}

/** A normalized event from acp-bridge (t = ready|message|thought|tool_start|tool_progress|commands|usage|turn_done|error|update). */
export interface AcpEvent {
  t: string
  /** Monotonic per-session sequence, stamped by the bridge on ingest. Present on every
   *  event the bridge emits (live + buffered), so replay and live tail are byte-identical
   *  and a UI can reconnect with a `since` cursor. */
  seq?: number
  [k: string]: unknown
}

/** Transcript read-back for a live session (see getHistory). */
export interface AcpHistory {
  events: AcpEvent[]
  firstSeq: number // seq of the oldest event still buffered (0 if none)
  lastSeq: number // seq of the newest buffered event (0 if none)
  truncated: boolean // true once the ring has dropped older events past the cap
  startedAt: number
}

interface AcpSession {
  agentId: string
  proc: ChildProcessWithoutNullStreams
  emitter: EventEmitter // 'event' (AcpEvent), 'exit' (code)
  ready: Promise<AcpEvent>
  readyResolved: boolean
  stdoutBuf: string
  startedAt: number
  lastActivity: number
  lastReady?: AcpEvent
  history: AcpEvent[] // ring buffer of emitted events (for transcript read-back)
  seq: number // monotonic event counter (last assigned seq)
  truncated: boolean // set once the ring has dropped events past the cap
}

export class HermesAcpBridge extends EventEmitter {
  private readonly sessions = new Map<string, AcpSession>()

  constructor(private readonly cfg: HermesAcpConfig) {
    super()
  }

  private sshArgs(agentId: string): string[] {
    const py = this.cfg.pythonBin ?? '/usr/local/lib/hermes-agent/venv/bin/python'
    const bridge = this.cfg.bridgePath ?? '/opt/acp-bridge/acp-bridge.py'
    return [
      '-i', this.cfg.sshKeyPath,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      `${this.cfg.user ?? 'root'}@${this.cfg.host}`,
      py, bridge, '--profile', agentId,
    ]
  }

  /** Start (or return the existing) persistent session for an agent. Idempotent. */
  startSession(agentId: string): AcpSession {
    const existing = this.sessions.get(agentId)
    if (existing && existing.proc.exitCode === null) return existing

    const proc = spawn('ssh', this.sshArgs(agentId), { stdio: ['pipe', 'pipe', 'pipe'] })
    const emitter = new EventEmitter()
    emitter.setMaxListeners(0)

    let resolveReady!: (e: AcpEvent) => void
    let rejectReady!: (err: Error) => void
    const ready = new Promise<AcpEvent>((res, rej) => { resolveReady = res; rejectReady = rej })

    const session: AcpSession = {
      agentId, proc, emitter, ready, readyResolved: false,
      stdoutBuf: '', startedAt: Date.now(), lastActivity: Date.now(),
      history: [], seq: 0, truncated: false,
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      session.stdoutBuf += chunk.toString('utf8')
      let nl: number
      while ((nl = session.stdoutBuf.indexOf('\n')) >= 0) {
        const line = session.stdoutBuf.slice(0, nl).trim()
        session.stdoutBuf = session.stdoutBuf.slice(nl + 1)
        if (!line) continue
        let ev: AcpEvent
        try { ev = JSON.parse(line) as AcpEvent } catch { continue }
        session.lastActivity = Date.now()
        // Stamp a monotonic seq and buffer into the ring BEFORE emitting, so live observers
        // and later read-back/replay see identical events. The seq lets a reconnecting UI
        // ask for only the gap it missed (/stream?since=<seq>).
        ev.seq = ++session.seq
        session.history.push(ev)
        const cap = this.cfg.historyCap ?? 5000
        if (session.history.length > cap) {
          session.history.splice(0, session.history.length - cap)
          session.truncated = true
        }
        if (ev.t === 'ready' && !session.readyResolved) {
          session.readyResolved = true
          session.lastReady = ev
          resolveReady(ev)
        }
        emitter.emit('event', ev)
        // fleet-wide fan-out so a single observer (bus wiring, logger) can watch all agents
        this.emit('event', { agentId, event: ev })
      }
    })

    proc.stderr.on('data', (d: Buffer) => this.emit('stderr', { agentId, text: d.toString('utf8') }))

    proc.on('exit', (code) => {
      this.sessions.delete(agentId)
      if (!session.readyResolved) { try { rejectReady(new Error(`acp-bridge for ${agentId} exited (code ${code}) before ready`)) } catch { /* noop */ } }
      emitter.emit('exit', code)
      this.emit('sessionExit', { agentId, code })
    })
    proc.on('error', (err) => {
      if (!session.readyResolved) { try { rejectReady(err instanceof Error ? err : new Error(String(err))) } catch { /* noop */ } }
      this.emit('sessionError', { agentId, error: String(err) })
    })

    this.sessions.set(agentId, session)
    return session
  }

  /** Ensure a session exists and has completed its ACP handshake; returns the `ready` event. */
  async ensureReady(agentId: string): Promise<AcpEvent> {
    const session = this.startSession(agentId)
    const timeoutMs = this.cfg.readyTimeoutMs ?? 30_000
    let timer: NodeJS.Timeout
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`acp session ${agentId} ready timeout`)), timeoutMs) })
    try {
      return await Promise.race([session.ready, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  /** Send a prompt into a running session (UI- or bus-originated). Session must exist. */
  prompt(agentId: string, text: string): void {
    const session = this.sessions.get(agentId)
    if (!session || session.proc.exitCode !== null) throw new Error(`no live acp session for ${agentId}`)
    session.proc.stdin.write(JSON.stringify({ type: 'prompt', text }) + '\n')
  }

  /** Subscribe to a session's normalized events. Returns an unsubscribe fn (safe to call any time). */
  onEvent(agentId: string, cb: (ev: AcpEvent) => void): () => void {
    const session = this.sessions.get(agentId)
    if (!session) throw new Error(`no acp session for ${agentId}`)
    session.emitter.on('event', cb)
    return () => session.emitter.off('event', cb)
  }

  /**
   * Buffered transcript for a live session, for read-back on (re)attach. `since` returns
   * only events with seq > since (the gap a reconnecting observer missed); since=0 returns
   * the whole buffer. undefined if no session exists for the agent.
   */
  getHistory(agentId: string, since = 0): AcpHistory | undefined {
    const s = this.sessions.get(agentId)
    if (!s) return undefined
    const events = since > 0 ? s.history.filter((e) => (e.seq ?? 0) > since) : s.history.slice()
    return {
      events,
      firstSeq: s.history[0]?.seq ?? 0,
      lastSeq: s.history[s.history.length - 1]?.seq ?? 0,
      truncated: s.truncated,
      startedAt: s.startedAt,
    }
  }

  /** Gracefully close a session (asks the bridge to exit, then hard-kills as a backstop). */
  stopSession(agentId: string): void {
    const session = this.sessions.get(agentId)
    if (!session) return
    try { session.proc.stdin.write(JSON.stringify({ type: 'close' }) + '\n') } catch { /* noop */ }
    setTimeout(() => { try { if (session.proc.exitCode === null) session.proc.kill('SIGTERM') } catch { /* noop */ } }, 2500)
  }

  listSessions(): Array<{ agentId: string; startedAt: number; lastActivity: number; model?: unknown }> {
    return [...this.sessions.values()].map((s) => ({
      agentId: s.agentId, startedAt: s.startedAt, lastActivity: s.lastActivity,
      model: s.lastReady?.current_model,
    }))
  }

  hasSession(agentId: string): boolean {
    const s = this.sessions.get(agentId)
    return !!s && s.proc.exitCode === null
  }

  /** Backend shutdown: tear down all sessions. */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.stopSession(id)
  }
}
