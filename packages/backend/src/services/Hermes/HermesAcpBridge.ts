import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

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
  sessionMapPath?: string // where conversationId->hermes sessionId persists (survives ai-lab restart -> resume)
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
  status: 'idle' | 'busy' // server-authoritative turn state (drives the UI Stop button)
}

/** Server-side per-conversation metadata — powers resume (sessionId) AND the cross-device
 *  conversation list (agentId + title + lastActive). Persisted to hermes-sessions.json. */
export interface ConversationMeta { sessionId: string; agentId: string; title?: string; lastActive: number }

export class HermesAcpBridge extends EventEmitter {
  private readonly sessions = new Map<string, AcpSession>()

  /** conversationId (sessionKey) -> hermes session id, persisted so each tab's session survives an
   *  ai-lab restart (resumed on respawn). Per-conversation, so multiple tabs on one agent stay distinct. */
  private persistedSessions: Record<string, ConversationMeta> = {}
  private sessionMapFile(): string {
    return this.cfg.sessionMapPath
      ?? (process.env.AILAB_PROXY_DATA_DIR ? `${process.env.AILAB_PROXY_DATA_DIR}/hermes-sessions.json` : '/opt/ai-lab/.gybackend-data/hermes-sessions.json')
  }
  private loadSessionMap(): void {
    try {
      if (!existsSync(this.sessionMapFile())) return
      const raw = JSON.parse(readFileSync(this.sessionMapFile(), 'utf-8')) as Record<string, string | ConversationMeta>
      const out: Record<string, ConversationMeta> = {}
      for (const [k, v] of Object.entries(raw || {})) {
        if (typeof v === 'string') out[k] = { sessionId: v, agentId: '', lastActive: 0 } // migrate legacy string entries
        else if (v && typeof v === 'object' && (v as ConversationMeta).sessionId) out[k] = { sessionId: v.sessionId, agentId: v.agentId || '', title: v.title, lastActive: v.lastActive || 0 }
      }
      this.persistedSessions = out
    } catch { this.persistedSessions = {} }
  }
  private saveSessionMap(): void {
    try { const p = this.sessionMapFile(); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(this.persistedSessions)) } catch { /* best-effort */ }
  }

  constructor(private readonly cfg: HermesAcpConfig) {
    super()
    this.loadSessionMap()
  }

  private sshArgs(agentId: string, resumeId?: string): string[] {
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
      ...(resumeId ? ['--resume', resumeId] : []),
    ]
  }

  /** Start (or return the existing) persistent session, keyed by an opaque `sessionKey`
   *  (a per-conversation id for chat tabs, or the agentId for bus/one-per-agent callers).
   *  `agentId` selects the Hermes profile to spawn. Idempotent per sessionKey. */
  startSession(sessionKey: string, agentId: string): AcpSession {
    const existing = this.sessions.get(sessionKey)
    if (existing && existing.proc.exitCode === null) return existing

    const resumeId = sessionKey ? this.persistedSessions[sessionKey]?.sessionId : undefined
    const proc = spawn('ssh', this.sshArgs(agentId, resumeId), { stdio: ['pipe', 'pipe', 'pipe'] })
    const emitter = new EventEmitter()
    emitter.setMaxListeners(0)

    let resolveReady!: (e: AcpEvent) => void
    let rejectReady!: (err: Error) => void
    const ready = new Promise<AcpEvent>((res, rej) => { resolveReady = res; rejectReady = rej })

    const session: AcpSession = {
      agentId, proc, emitter, ready, readyResolved: false,
      stdoutBuf: '', startedAt: Date.now(), lastActivity: Date.now(),
      history: [], seq: 0, truncated: false, status: 'idle',
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
          const sid = (ev as { session_id?: string }).session_id
          if (sid && sessionKey) { const prev = this.persistedSessions[sessionKey]; this.persistedSessions[sessionKey] = { sessionId: sid, agentId, title: prev?.title, lastActive: Date.now() }; this.saveSessionMap() }
          resolveReady(ev)
        }
        emitter.emit('event', ev)
        // fleet-wide fan-out so a single observer (bus wiring, logger) can watch all agents
        this.emit('event', { agentId, event: ev })
        // A finished turn is authoritative idle (covers cancelled/errored/normal — the bridge
        // always emits turn_done when the prompt task resolves).
        if (ev.t === 'turn_done') this.setStatus(sessionKey, 'idle')
      }
    })

    proc.stderr.on('data', (d: Buffer) => this.emit('stderr', { agentId, text: d.toString('utf8') }))

    proc.on('exit', (code) => {
      this.setStatus(sessionKey, 'idle') // a crashed/exited turn is no longer running
      this.sessions.delete(sessionKey)
      if (!session.readyResolved) { try { rejectReady(new Error(`acp-bridge for ${agentId} exited (code ${code}) before ready`)) } catch { /* noop */ } }
      emitter.emit('exit', code)
      this.emit('sessionExit', { agentId, sessionKey, code })
    })
    proc.on('error', (err) => {
      if (!session.readyResolved) { try { rejectReady(err instanceof Error ? err : new Error(String(err))) } catch { /* noop */ } }
      this.emit('sessionError', { agentId, sessionKey, error: String(err) })
    })

    this.sessions.set(sessionKey, session)
    return session
  }

  /** Ensure a session exists and has completed its ACP handshake; returns the `ready` event. */
  async ensureReady(sessionKey: string, agentId: string): Promise<AcpEvent> {
    const session = this.startSession(sessionKey, agentId)
    const timeoutMs = this.cfg.readyTimeoutMs ?? 30_000
    let timer: NodeJS.Timeout
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`acp session ${sessionKey} ready timeout`)), timeoutMs) })
    try {
      return await Promise.race([session.ready, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  /** Send a prompt into a running session (UI- or bus-originated). Session must exist.
   *  Feature A (page-aware): optional structured view `context` and a `screenshot`
   *  (data URL / base64 PNG) ride along; acp-bridge.py injects them into the turn
   *  (screenshot saved to a file the agent reads with its own vision/read tool). */
  prompt(sessionKey: string, text: string, extra?: { context?: string; screenshot?: string; images?: string[] }): void {
    const session = this.sessions.get(sessionKey)
    if (!session || session.proc.exitCode !== null) throw new Error(`no live acp session for ${sessionKey}`)
    // Record the user's turn in the ring buffer so a refreshed/reconnecting UI rebuilds it.
    // The bridge only buffers ASSISTANT events (from stdout); the user's message otherwise
    // exists only client-side (optimistic bubble) and vanishes on refresh. Buffer only — do NOT
    // emit, or the live view double-shows it. Renders via the reducer's `case 'user'`.
    const uev = { t: 'user', text, seq: ++session.seq } as unknown as AcpEvent
    session.history.push(uev)
    { const cap = this.cfg.historyCap ?? 5000
      if (session.history.length > cap) { session.history.splice(0, session.history.length - cap); session.truncated = true } }
    // Server-side conversation registry: first user message becomes the tab title; every turn bumps lastActive.
    const meta = this.persistedSessions[sessionKey]
    if (meta) { meta.lastActive = Date.now(); if (!meta.title && text.trim()) meta.title = text.trim().slice(0, 80); this.saveSessionMap() }
    const payload: Record<string, unknown> = { type: 'prompt', text }
    if (extra?.context) payload.context = extra.context
    if (extra?.screenshot) payload.screenshot = extra.screenshot
    if (extra?.images?.length) payload.images = extra.images
    session.proc.stdin.write(JSON.stringify(payload) + '\n')
    this.setStatus(sessionKey, 'busy')
  }

  /** Server-authoritative turn state for a conversation (survives UI disconnects because it lives
   *  here, not in any browser). 'idle' when no session exists. Drives the UI Stop button. */
  getStatus(sessionKey: string): 'idle' | 'busy' {
    return this.sessions.get(sessionKey)?.status ?? 'idle'
  }

  /** Flip a session's turn state and broadcast it as a seq'd {t:'status'} event through the SAME
   *  ring + emitter pipeline as every other event — so live observers, /history read-back, and
   *  /stream?since= replay all converge on one truth (no client-side guessing). No-op if unchanged. */
  private setStatus(sessionKey: string, status: 'idle' | 'busy'): void {
    const session = this.sessions.get(sessionKey)
    if (!session || session.status === status) return
    session.status = status
    const ev = { t: 'status', status, seq: ++session.seq } as unknown as AcpEvent
    session.history.push(ev)
    const cap = this.cfg.historyCap ?? 5000
    if (session.history.length > cap) { session.history.splice(0, session.history.length - cap); session.truncated = true }
    session.emitter.emit('event', ev)
    this.emit('event', { agentId: session.agentId, event: ev })
  }

  /** Stop the in-flight turn: forward an ACP session/cancel to the bridge. The turn ends with
   *  stop_reason 'cancelled' -> turn_done -> status idle (all server-driven). Idempotent. */
  cancel(sessionKey: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session || session.proc.exitCode !== null) return
    session.proc.stdin.write(JSON.stringify({ type: 'cancel' }) + '\n')
  }

  /** Subscribe to a session's normalized events. Returns an unsubscribe fn (safe to call any time). */
  onEvent(sessionKey: string, cb: (ev: AcpEvent) => void): () => void {
    const session = this.sessions.get(sessionKey)
    if (!session) throw new Error(`no acp session for ${sessionKey}`)
    session.emitter.on('event', cb)
    return () => session.emitter.off('event', cb)
  }

  /**
   * Buffered transcript for a live session, for read-back on (re)attach. `since` returns
   * only events with seq > since (the gap a reconnecting observer missed); since=0 returns
   * the whole buffer. undefined if no session exists for the agent.
   */
  getHistory(sessionKey: string, since = 0): AcpHistory | undefined {
    const s = this.sessions.get(sessionKey)
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

  /** The most-recently-active live session (highest lastActivity) — used to route an
   *  on-demand screen capture to the conversation the user is currently in. */
  mostRecentSession(): { sessionKey: string; agentId: string } | null {
    let best: { sessionKey: string; agentId: string; at: number } | null = null
    for (const [sessionKey, s] of this.sessions) {
      if (s.proc.exitCode !== null) continue
      if (!best || s.lastActivity > best.at) best = { sessionKey, agentId: s.agentId, at: s.lastActivity }
    }
    return best ? { sessionKey: best.sessionKey, agentId: best.agentId } : null
  }

  /** Inject a synthetic event into a session's stream (e.g. a `capture_request` for the
   *  page-aware chat) so /stream observers (the frontend) receive it. Not persisted to the
   *  transcript ring — it's a live control signal, not a transcript event. */
  emitToSession(sessionKey: string, event: Record<string, unknown>): boolean {
    const s = this.sessions.get(sessionKey)
    if (!s) return false
    s.emitter.emit('event', event as unknown as AcpEvent)
    return true
  }

  /** Gracefully close a session (asks the bridge to exit, then hard-kills as a backstop).
   *  Removes it from the map immediately so a same-key reopen starts a FRESH session —
   *  this is what makes "close tab wipes the conversation" true. */
  /** Swap the model for a live conversation's ACP session (session/set_model). Hermes re-creates
   *  the session agent with the new model and persists it, so the switch survives reconnect.
   *  `modelId` = any AI-Lab proxy catalog id (routes via the ailab provider). */
  setModel(sessionKey: string, modelId: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session || session.proc.exitCode !== null) throw new Error(`no live acp session for ${sessionKey}`)
    session.proc.stdin.write(JSON.stringify({ type: 'set_model', model_id: modelId }) + '\n')
  }

  stopSession(sessionKey: string): void {
    // Deleting a tab wipes the conversation from the server registry too, so it stops appearing on
    // every device (matches the 'a conversation lives until I delete the tab' rule).
    if (this.persistedSessions[sessionKey]) { delete this.persistedSessions[sessionKey]; this.saveSessionMap() }
    const session = this.sessions.get(sessionKey)
    if (!session) return
    this.sessions.delete(sessionKey)
    try { session.proc.stdin.write(JSON.stringify({ type: 'close' }) + '\n') } catch { /* noop */ }
    setTimeout(() => { try { if (session.proc.exitCode === null) session.proc.kill('SIGTERM') } catch { /* noop */ } }, 2500)
  }

  listSessions(): Array<{ agentId: string; startedAt: number; lastActivity: number; model?: unknown }> {
    return [...this.sessions.values()].map((s) => ({
      agentId: s.agentId, startedAt: s.startedAt, lastActivity: s.lastActivity,
      model: s.lastReady?.current_model,
    }))
  }

  /** Server-side conversation list (cross-device): every persisted conversation with a known agent,
   *  newest first. Powers the tab list so conversations follow the user to any browser/device. */
  listConversations(): Array<{ conversationId: string; agentId: string; title?: string; lastActive: number }> {
    return Object.entries(this.persistedSessions)
      .filter(([, m]) => !!m.agentId)
      .map(([conversationId, m]) => ({ conversationId, agentId: m.agentId, title: m.title, lastActive: m.lastActive }))
      .sort((a, b) => b.lastActive - a.lastActive)
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
