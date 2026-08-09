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
  profilesDir?: string // default /root/.hermes/profiles (<agentId>/state.db lives here on CT158)
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
  /** conversationIds whose post-toolset-change reload was deferred because the session was
   *  mid-turn; reloaded when they next go idle. */
  private pendingReload = new Set<string>()
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

  private bridgeArgs(agentId: string, resumeId?: string): string[] {
    // Hermes is co-located — spawn the bridge LOCALLY (no ssh). The python binary is the spawn
    // target (see startSession); these are its args.
    const bridge = this.cfg.bridgePath ?? '/opt/acp-bridge/acp-bridge.py'
    return [
      bridge, '--profile', agentId,
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
    const py = this.cfg.pythonBin ?? '/usr/local/lib/hermes-agent/venv/bin/python'
    // The conversation id rides in on the ENV because this process IS the conversation
    // (one spawn per sessionKey). Agents otherwise cannot know which conversation they are in,
    // so tools that scope state per conversation had to guess from the agent's profile name.
    // acp-bridge injects it into the model's context on the first turn and echoes it on `ready`.
    const proc = spawn(py, this.bridgeArgs(agentId, resumeId), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: '/root', AILAB_CONVERSATION_ID: sessionKey } })
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
          // Guard: only (re)persist if THIS session is still the registered one for the key. A
          // stopSession() (tab delete) removes it from this.sessions, so a delete that races a slow
          // ACP spawn can no longer be undone by the late ready event re-adding the entry.
          if (sid && sessionKey && this.sessions.get(sessionKey) === session) { const prev = this.persistedSessions[sessionKey]; this.persistedSessions[sessionKey] = { sessionId: sid, agentId, title: prev?.title, lastActive: Date.now() }; this.saveSessionMap() }
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

    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      // LOG IT. This event had zero listeners, so the bridge's entire stderr was discarded —
      // including Python tracebacks and "Task exception was never retrieved", which is how an
      // asyncio task can die in total silence. A bridge that fails invisibly is the worst case:
      // the UI just stops behaving and nothing anywhere says why.
      for (const line of text.split('\n')) {
        if (line.trim()) console.warn(`[acp-bridge:${agentId}] ${line}`)
      }
      this.emit('stderr', { agentId, text })
    })

    proc.on('exit', (code) => {
      this.pendingReload.delete(sessionKey) // a dead session doesn't need a deferred reload
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

  /**
   * Inject guidance into a session's RUNNING turn — Hermes's native /steer, which lands at
   * the next tool boundary instead of waiting for the turn to end.
   *
   * Throws when there is no live session. That is deliberate and is the caller's signal to
   * fall back to a normal prompt: steering something that is not running is meaningless, and
   * silently swallowing it here is exactly the void-the-message bug we already fixed once.
   *
   * NOTE the absence of setStatus. A steer does not start a turn and must not touch turn
   * state — the real turn is still running and still owns `busy`.
   */
  steer(sessionKey: string, text: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session?.proc?.stdin) throw new Error(`no live hermes session for ${sessionKey} — cannot steer`)
    const t = text.trim()
    if (!t) throw new Error('steer text is empty')
    console.log(`[acp-bridge] ${sessionKey}: steering the active turn (${t.length} chars)`)
    session.proc.stdin.write(JSON.stringify({ type: 'steer', text: t }) + '\n')
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
    // A toolset-change reload deferred while this session was mid-turn now runs (session idle).
    if (status === 'idle' && this.pendingReload.has(sessionKey)) {
      this.pendingReload.delete(sessionKey)
      setTimeout(() => this.reloadSession(sessionKey), 100)
    }
  }

  /** Stop the in-flight turn: forward an ACP session/cancel to the bridge. The turn ends with
   *  stop_reason 'cancelled' -> turn_done -> status idle (all server-driven). Idempotent. */
  cancel(sessionKey: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session || session.proc.exitCode !== null) return
    session.proc.stdin.write(JSON.stringify({ type: 'cancel' }) + '\n')

    // CONFIRMATION WATCHDOG. The intended chain is conn.cancel() -> prompt resolves
    // 'cancelled' -> turn_done -> idle. When that chain completes, this is a no-op
    // because status is already idle. When it does NOT — the symptom being a Stop
    // button that never turns back into Send without a page refresh — the server
    // confirms the turn is over and drives the transition itself.
    //
    // Deliberately server-side: the client must not guess idle (that is why stop()
    // does not clear busy locally). And it SHOUTS when it fires, because needing
    // this means the bridge swallowed a turn_done and that root cause is still open.
    const CANCEL_GRACE_MS = 4000
    setTimeout(() => {
      const live = this.sessions.get(sessionKey)
      if (!live || live.status !== 'busy') return   // chain worked — nothing to do
      console.warn(`[acp-bridge] ${sessionKey}: no turn_done ${CANCEL_GRACE_MS}ms after cancel — `
        + `forcing idle so the composer unlocks. The bridge did not resolve its prompt task; `
        + `this is a real bug being masked, not a normal path.`)
      const ev = { t: 'turn_done', stop_reason: 'cancelled' } as unknown as AcpEvent
      live.emitter.emit('event', ev)
      this.emit('event', { agentId: live.agentId, event: ev })
      this.setStatus(sessionKey, 'idle')
    }, CANCEL_GRACE_MS)
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

  /** Run the NATIVE Hermes tail-rewind helper on CT158 (drives SessionDB.rewind_to_message /
   *  get_messages — no source patching). Resolves the parsed JSON result (last stdout line). */
  private runRewindHelper(agentId: string, sessionId: string, action: 'peek' | 'rewind'): Promise<Record<string, unknown>> {
    const py = this.cfg.pythonBin ?? '/usr/local/lib/hermes-agent/venv/bin/python'
    const helper = (this.cfg.bridgePath ?? '/opt/acp-bridge/acp-bridge.py').replace(/[^/]+$/, 'hermes_rewind.py')
    const db = `${this.cfg.profilesDir ?? '/root/.hermes/profiles'}/${agentId}/state.db`
    // Co-located: run the rewind helper LOCALLY (no ssh).
    const args = [helper, '--db', db, '--session', sessionId, '--action', action]
    return new Promise((resolve, reject) => {
      const p = spawn(py, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: '/root' } })
      let out = ''; let err = ''
      p.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
      p.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
      p.on('error', reject)
      p.on('close', (code) => {
        const line = out.trim().split('\n').filter(Boolean).pop() ?? ''
        try { resolve(JSON.parse(line) as Record<string, unknown>) }
        catch { reject(new Error(`rewind helper bad output (code ${code}): ${(err || out).slice(0, 300)}`)) }
      })
    })
  }

  /** Edit / Regenerate / Delete the TAIL user turn of a conversation, reflected in the agent's
   *  REAL context. Uses Hermes' native SessionDB.rewind_to_message to soft-delete (active=0) the
   *  last user message + everything after it, then resumes the session so session/load rebuilds
   *  context from active=1 rows. 'delete' stops there (the previous turn becomes the new tail);
   *  'regenerate' re-sends the original user text; 'edit' sends editedText. Refuses mid-turn. */
  /** Fully stop a session's LOCAL child (graceful close then SIGTERM), waiting for its exit. */
  private async hardStopLocal(sessionKey: string): Promise<void> {
    const live = this.sessions.get(sessionKey)
    if (!live || live.proc.exitCode !== null) return
    this.pendingReload.delete(sessionKey)
    const exited = new Promise<void>((res) => {
      const t = setTimeout(res, 4000)
      live.proc.once('exit', () => { clearTimeout(t); res() })
    })
    try { live.proc.stdin.write(JSON.stringify({ type: 'close' }) + '\n') } catch { /* noop */ }
    const killTimer = setTimeout(() => { try { live.proc.kill('SIGTERM') } catch { /* noop */ } }, 1000)
    await exited
    clearTimeout(killTimer)
  }

  /** Deterministically kill the REMOTE acp-bridge (+ its hermes child) driving a session on CT158
   *  and verify it's gone. Killing the local ssh does NOT reliably kill the remote, and a surviving
   *  process re-persists stale rows over our rewind (the clobber bug). Rejects if it can't confirm. */
  private remoteKillSession(sessionId: string): Promise<void> {
    const script = (this.cfg.bridgePath ?? '/opt/acp-bridge/acp-bridge.py').replace(/[^/]+$/, 'hard_stop.sh')
    // Co-located: hermes runs LOCALLY, so hard_stop.sh kills the local hermes child by session id.
    const args = [script, sessionId]
    return new Promise((resolve, reject) => {
      const p = spawn('bash', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: '/root' } })
      let err = ''
      p.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
      p.on('error', reject)
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`could not stop the live Hermes process before rewind: ${err.slice(0, 200)}`)))
    })
  }

  /** Edit / Regenerate / Delete the TAIL user turn — reflected in the agent's REAL context via
   *  Hermes' native SessionDB.rewind_to_message. ROBUST: fully stops the live session (local +
   *  remote, verified dead) BEFORE mutating so the write can't be clobbered; VERIFIES the
   *  soft-delete persisted (fail-loud, never a silent no-op); then resumes via --resume. On any
   *  failure it brings the session back so the conversation stays usable. */
  async rewindTail(sessionKey: string, mode: 'edit' | 'regenerate' | 'delete', editedText?: string): Promise<{ ok: true; mode: string; rewound: number; targetText: string }> {
    const live = this.sessions.get(sessionKey)
    const agentId = live?.agentId ?? this.persistedSessions[sessionKey]?.agentId
    if (!agentId) throw new Error('no such conversation')
    if (live && live.status === 'busy') throw new Error('the agent is mid-response — stop it or wait, then retry')
    const sessionId = this.persistedSessions[sessionKey]?.sessionId
    if (!sessionId) throw new Error('this conversation has no saved Hermes session yet')
    if (mode === 'edit' && !(editedText ?? '').trim()) throw new Error('edit needs non-empty text')

    // 1) Fully stop the session (local child + remote acp-bridge/hermes, verified dead) so the DB
    //    is quiescent and the rewind can't be re-persisted over.
    await this.hardStopLocal(sessionKey)
    let res: Record<string, unknown>
    try {
      await this.remoteKillSession(sessionId)
      // 2) Baseline -> native tail rewind -> VERIFY it stuck.
      const before = await this.runRewindHelper(agentId, sessionId, 'peek')
      res = await this.runRewindHelper(agentId, sessionId, 'rewind')
      if (!res || res.ok !== true) throw new Error(`rewind failed: ${(res && (res.error as string)) ?? 'unknown'}`)
      const beforeN = typeof before?.active_count === 'number' ? (before.active_count as number) : undefined
      const afterN = typeof res.active_count_after === 'number' ? (res.active_count_after as number) : undefined
      if (beforeN !== undefined && afterN !== undefined && afterN >= beforeN) {
        throw new Error('rewind did not persist (write was clobbered) — nothing changed')
      }
    } catch (e) {
      // Recover: bring the session back so the conversation stays usable, then surface the failure.
      await this.ensureReady(sessionKey, agentId).catch(() => { /* noop */ })
      throw e
    }
    const targetText = typeof res.target_text === 'string' ? res.target_text : ''
    const rewound = typeof res.rewound === 'number' ? res.rewound : 0

    // 3) Resume — session/load rebuilds context from active=1 and replays the trimmed transcript.
    await this.ensureReady(sessionKey, agentId)

    // 4) After-action: edit/regenerate re-prompt; delete leaves the conversation trimmed.
    const text = mode === 'edit' ? (editedText as string) : targetText
    if (mode !== 'delete' && text.trim()) this.prompt(sessionKey, text)

    console.log(`[hermes-acp] rewindTail ${mode} on ${sessionKey}: soft-deleted ${rewound} row(s), active ${res.active_count_before}->${res.active_count_after}`)
    return { ok: true, mode, rewound, targetText }
  }

  /** Restart a live session's PROCESS while KEEPING its resume state, so it respawns via
   *  --resume (ACP session/load): Hermes recreates the agent — loading the CURRENT tools/config —
   *  and replays history. Unlike stopSession, does NOT wipe persistedSessions. */
  reloadSession(sessionKey: string): void {
    const s = this.sessions.get(sessionKey)
    if (!s) return
    const agentId = s.agentId
    this.pendingReload.delete(sessionKey)
    // Respawn once the current proc exits (its exit handler removes it from the live map;
    // persistedSessions is left intact, so startSession resumes via --resume).
    s.proc.once('exit', () => { try { this.startSession(sessionKey, agentId) } catch { /* noop */ } })
    try { s.proc.stdin.write(JSON.stringify({ type: 'close' }) + '\n') } catch { /* noop */ }
    setTimeout(() => { try { s.proc.kill('SIGTERM') } catch { /* noop */ } }, 2500)
  }

  /** Reload every live session of an agent (after its toolset changes): idle sessions reload
   *  now; busy (mid-turn) sessions are deferred until their turn completes. */
  reloadAgentSessions(agentId: string): { reloaded: number; deferred: number } {
    let reloaded = 0
    let deferred = 0
    for (const [key, s] of this.sessions.entries()) {
      if (s.agentId !== agentId) continue
      if (s.status === 'busy') { this.pendingReload.add(key); deferred++ }
      else { this.reloadSession(key); reloaded++ }
    }
    if (reloaded || deferred) console.log(`[hermes-acp] toolset changed for ${agentId}: reloaded ${reloaded} live session(s), deferred ${deferred} busy`)
    return { reloaded, deferred }
  }

  stopSession(sessionKey: string): void {
    // Deleting a tab wipes the conversation from the server registry too, so it stops appearing on
    // every device (matches the 'a conversation lives until I delete the tab' rule).
    if (this.persistedSessions[sessionKey]) { delete this.persistedSessions[sessionKey]; this.saveSessionMap() }
    const session = this.sessions.get(sessionKey)
    if (!session) return
    this.sessions.delete(sessionKey)
    // Graceful close so the OpenViking memory lane can COMMIT this conversation before the process
    // dies: `close` makes the bridge break its loop -> spawn_agent_process closes the ACP conn ->
    // the Hermes child hits EOF and exits cleanly -> its atexit/on_session_end fires -> the lane
    // archives + extracts the turns (a VLM call — seconds). Closing stdin reinforces the EOF. The
    // old 2.5s SIGTERM killed that mid-extract; give it a long grace window and only force-kill if
    // it truly hangs. Runs in the background — the delete response already went out.
    try { session.proc.stdin.write(JSON.stringify({ type: 'close' }) + '\n') } catch { /* noop */ }
    try { session.proc.stdin.end() } catch { /* noop */ }
    const graceMs = Number(process.env.HERMES_COMMIT_GRACE_MS) || 60000
    setTimeout(() => { try { if (session.proc.exitCode === null) session.proc.kill('SIGTERM') } catch { /* noop */ } }, graceMs)
    setTimeout(() => { try { if (session.proc.exitCode === null) session.proc.kill('SIGKILL') } catch { /* noop */ } }, graceMs + 5000)
  }

  listSessions(): Array<{ agentId: string; startedAt: number; lastActivity: number; model?: unknown }> {
    return [...this.sessions.values()].map((s) => ({
      agentId: s.agentId, startedAt: s.startedAt, lastActivity: s.lastActivity,
      model: s.lastReady?.current_model,
    }))
  }

  /**
   * Per-AGENT activity, aggregated across that agent's sessions. Feeds the fleet
   * activity collector so "is this agent actually working?" is answerable for
   * Hermes agents the same way it is for Claude Code instances.
   *
   * We can answer this precisely — unlike the Claude Code side, which has to
   * infer from a transcript that lags — because the bridge already keeps
   * server-authoritative per-session `status` (set busy on prompt, idle on
   * turn_done/exit) plus a seq-stamped event ring.
   *
   * An agent is `busy` if ANY of its sessions is mid-turn; lastActivity is the
   * most recent across them.
   */
  listAgentActivity(): Array<{
    agentId: string
    status: 'idle' | 'busy'
    lastActivity: number
    lastEvent?: { t: string; summary: string; seq?: number }
    recent: Array<{ role: string; ts: string | null; uuid: string | null; summary: string }>
  }> {
    const byAgent = new Map<string, ReturnType<HermesAcpBridge['listAgentActivity']>[number]>()
    for (const sess of this.sessions.values()) {
      const prev = byAgent.get(sess.agentId)
      const busy = sess.status === 'busy' || prev?.status === 'busy'
      const lastActivity = Math.max(sess.lastActivity ?? 0, prev?.lastActivity ?? 0)
      // Only describe from the session that actually acted most recently.
      const useThis = !prev || (sess.lastActivity ?? 0) >= (prev.lastActivity ?? 0)
      byAgent.set(sess.agentId, {
        agentId: sess.agentId,
        status: busy ? 'busy' : 'idle',
        lastActivity,
        lastEvent: useThis ? HermesAcpBridge.describeEvents(sess.history).at(-1) : prev?.lastEvent,
        recent: useThis ? HermesAcpBridge.recentEntries(sess.history) : (prev?.recent ?? []),
      })
    }
    return [...byAgent.values()]
  }

  /** Collapse ACP events into human-readable one-liners; drops noise (ping/status/usage). */
  private static describeEvents(history: AcpEvent[]): Array<{ t: string; summary: string; seq?: number }> {
    const out: Array<{ t: string; summary: string; seq?: number }> = []
    for (const e of history) {
      const t = String(e.t ?? '')
      let summary = ''
      if (t === 'tool_start') summary = `Tool: ${String((e as any).title ?? (e as any).name ?? 'tool')}`
      else if (t === 'tool_progress') continue
      // Do NOT trim here: `message` events stream token-by-token and each token
      // carries its own leading space. Trimming per-token welds the words
      // together ("Received,claude1.I'mLoom—Icurate..."). Trim once at the end.
      else if (t === 'message') summary = String((e as any).text ?? '')
      else if (t === 'thought') continue
      else if (t === 'turn_done') summary = `Turn ended (${String((e as any).stop_reason ?? 'done')})`
      else if (t === 'error' || t === 'fatal') summary = `ERROR: ${String((e as any).message ?? t)}`
      else continue
      if (!summary || (t !== 'message' && !summary.trim())) continue
      const last = out.at(-1)
      // message events stream token-by-token — coalesce them into one line.
      if (last && t === 'message' && last.t === 'message') {
        last.summary = (last.summary + summary).slice(0, 400)
        last.seq = e.seq
        continue
      }
      out.push({ t, summary: (t === 'message' ? summary.trimStart() : summary).slice(0, 400), seq: e.seq })
    }
    return out
  }

  private static recentEntries(history: AcpEvent[], cap = 25) {
    return HermesAcpBridge.describeEvents(history)
      .slice(-cap)
      .map((d) => ({
        role: d.t === 'message' ? 'assistant' : d.t,
        ts: null as string | null,
        uuid: d.seq != null ? String(d.seq) : null,
        summary: d.summary,
      }))
  }

  /** Server-side conversation list (cross-device): every persisted conversation with a known agent,
   *  newest first. Powers the tab list so conversations follow the user to any browser/device. */
  listConversations(): Array<{ conversationId: string; agentId: string; title?: string; lastActive: number }> {
    return Object.entries(this.persistedSessions)
      .filter(([, m]) => !!m.agentId && !!(m.title && m.title.trim()))
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
