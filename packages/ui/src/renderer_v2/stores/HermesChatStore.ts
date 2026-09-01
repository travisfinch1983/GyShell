import { isTtsEnabled, speakText, speakTextNow, type TtsOverride } from '../services/TtsPlayback'

/**
 * HermesChatStore — streaming chat sessions with Hermes agents (P0 chat surface).
 *
 * Consumes GET /api/hermes/agents/:id/stream (SSE, same-origin via the /api Vite
 * proxy) typed by hermesStreamEventSchema, and sends turns via POST /prompt.
 *
 * HEADLESS INVARIANT (hard requirement): this store is a pure OBSERVER. attach()
 * opens an EventSource, detach() closes it — nothing here can stop, pause, or
 * otherwise affect the backend-owned session. Closing the view mid-turn just
 * detaches; the agent keeps running and a re-attach resumes the live stream.
 *
 * Transcripts survive tab switches (module singleton) and reloads: on first
 * attach a conversation is RESTORED from the server transcript
 * (GET /history?conversationId — the same normalized event union, replayed
 * through reduce()), then the live stream resumes from the last seen seq.
 */
import { makeAutoObservable, runInAction } from 'mobx'
import { hermesStreamEventSchema, type HermesSlashCommand, type HermesStreamEvent } from '@gyshell/shared'
import { hermesApi } from './hermesApi'

/**
 * Conversation-load debug feed → the Bell panel's debug console (Travis's ask:
 * a conversation that never loads was SILENT — no way to see whether the load
 * was requested, fired, answered, or skipped). Every entry point and every
 * early-return in the load path reports here with its reason. Fire-and-forget,
 * never throws, never awaited; also mirrors to the browser console.
 */
function chatDebug(message: string): void {
  try {
    console.debug(`[chat-load] ${message}`)
    const bridge = (window as any).gyshell?.cluster
    if (bridge) void bridge.request('POST', '/api/notifications/debug', { source: 'chat-load', message }).catch(() => {})
  } catch { /* instrumentation must never break the thing it watches */ }
}
const cshort = (id: string): string => id.slice(0, 8)
import { buildViewSnapshot } from '../lib/viewContext'
import { captureUI, hasLiveShare, acquireScreenShare } from '../services/ScreenshotService'

export interface ChatItem {
  id: number
  kind: 'user' | 'assistant' | 'thought' | 'tool' | 'system' | 'error' | 'plan' | 'capture_consent'
  text: string
  /** tool cards: ACP tool_call id + latest status */
  toolId?: string | null
  title?: string | null
  status?: string | null
  /** plan cards: ACP plan entries (latest update replaces the card in place) */
  plan?: Array<{ content: string; status?: string; priority?: string }>
  /** assistant/thought: still receiving chunks */
  streaming?: boolean
  /** user turns: queued type-ahead — rendered immediately, POSTed when the in-flight turn ends. */
  queued?: boolean
  /** user turns: STEERED into the running turn (lands at the next tool boundary). */
  steering?: boolean
  /** user turns: what page context rode along ('text' = viewContext, 'vision' = +screenshot). */
  ctxAttached?: 'text' | 'vision'
  /** capture_consent: the pending view_screen request this button completes. */
  requestId?: string
  capConvId?: string
  ts: number
}

export interface AgentChatState {
  items: ChatItem[]
  connected: boolean
  /** a prompt turn is in flight (from this UI or any other client) */
  busy: boolean
  /** type-ahead: messages composed while busy; auto-sent on turn end (they used to vanish). */
  queue: Array<{ itemId: number; text: string }>
  commands: HermesSlashCommand[]
  /** context-window meter from usageUpdate: {used, size} */
  usage: { used: number; size: number } | null
  currentModel: string | null
  /** backend session id from `ready` — HEADER state, never a chat item (the
   *  old "attached — session…" items stacked one per tab-swap re-attach). */
  sessionId: string | null
  /** highest wire `seq` folded into this transcript. Re-attach resumes the stream
   *  from here (`&since=`) so switching conversations never re-replays history. */
  lastSeq: number
  error: string | null
}

function emptyState(): AgentChatState {
  return { items: [], connected: false, busy: false, queue: [], commands: [], usage: null, currentModel: null, sessionId: null, lastSeq: 0, error: null }
}

/**
 * A stream event that fails `hermesStreamEventSchema` is ALWAYS either a bug or a
 * bridge/UI version skew — it must never vanish without a trace. Standing rule
 * (Travis 2026-07-28): thorough logging is the default; a silently-dropped input
 * is itself a bug. `t:ping` is the one expected non-variant (heartbeat) and stays quiet.
 * First occurrence per (site,t) logs the full payload; repeats log a running count so
 * a hot loop cannot flood the console.
 */
const droppedCounts = new Map<string, number>()
function reportDroppedEvent(where: string, raw: unknown, err: unknown): void {
  const t = typeof (raw as any)?.t === 'string' ? (raw as any).t : '<no t field>'
  if (t === 'ping') return
  const key = `${where}:${t}`
  const n = (droppedCounts.get(key) ?? 0) + 1
  droppedCounts.set(key, n)
  if (n === 1) {
    console.warn(
      `[HermesChatStore] DROPPED stream event t="${t}" at ${where} — it does not match ` +
      `hermesStreamEventSchema, so it will NOT render. Add the variant in ` +
      `packages/shared/src/fleet/agent-platform.ts.`,
      { raw, issues: (err as any)?.issues ?? err },
    )
  } else {
    console.warn(`[HermesChatStore] DROPPED stream event t="${t}" at ${where} (x${n})`)
  }
}

class HermesChatStore {
  chats = new Map<string, AgentChatState>()
  private sources = new Map<string, EventSource>()
  private watchdogs = new Map<string, ReturnType<typeof setInterval>>()
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private agents = new Map<string, string>()
  private nextId = 1
  private restored = new Set<string>()

  constructor() {
    // The infra maps below are plumbing, not reactive state — exclude them so the liveness
    // watchdog / reconnect callbacks can mutate them without tripping MobX action enforcement.
    makeAutoObservable(this, {
      sources: false, watchdogs: false, reconnectTimers: false, agents: false, restored: false, nextId: false,
    }, { autoBind: true })
  }

  state(conversationId: string): AgentChatState {
    let s = this.chats.get(conversationId)
    if (!s) {
      // Read back after set: observable.map deep-converts values on insertion,
      // so the stored proxy — not the plain literal — must be what we mutate.
      this.chats.set(conversationId, emptyState())
      s = this.chats.get(conversationId)!
    }
    return s
  }

  /** Optimistic header update after a per-conversation model swap POST —
   *  the authoritative value re-arrives on the next `ready` event. */
  setCurrentModel(conversationId: string, modelId: string): void {
    this.state(conversationId).currentModel = modelId
  }

  /**
   * Open the observer stream (idempotent). Never affects the backend session.
   * Keys are CONVERSATION ids (per-tab isolation — per-agent keying is the
   * legacy path and exactly why an errored transcript survived tab closes);
   * agentId routes the HTTP call.
   */
  attach(agentId: string, conversationId: string): void {
    const existing = this.sources.get(conversationId)
    if (existing) {
      // readyState is the tell: 0/1 = a live stream (skip is correct);
      // 2 = a CLOSED zombie still in the map — attach would silently do
      // nothing forever, which is exactly the invisible-failure shape.
      chatDebug(`[${cshort(conversationId)}] attach skipped — stream already in map (readyState=${existing.readyState}${existing.readyState === 2 ? ' ⚠ CLOSED zombie' : ''}) agent=${agentId}`)
      return
    }
    const s = this.state(conversationId)
    chatDebug(`[${cshort(conversationId)}] attach requested agent=${agentId} (items=${s.items.length}, restoredOnce=${this.restored.has(conversationId)}, lastSeq=${s.lastSeq})`)
    // SERVER-TRUTH RESTORE (once per conversation per page load): replay the
    // stored transcript through reduce(), then attach the live stream from the
    // last replayed seq — no duplicates, no gap.
    if (!this.restored.has(conversationId) && s.items.length === 0) {
      this.restored.add(conversationId)
      void this.restoreThenStream(agentId, conversationId)
      return
    }
    chatDebug(`[${cshort(conversationId)}] skipping history restore (${this.restored.has(conversationId) ? 'already attempted this page load' : `items already present: ${s.items.length}`}) — opening live stream`)
    this.openStream(agentId, conversationId, s.lastSeq || undefined)
  }

  private async restoreThenStream(agentId: string, conversationId: string): Promise<void> {
    let since: number | undefined
    // Held across the whole replay INCLUDING the await, so a turn_done arriving in the
    // buffer cannot speak. Cleared in finally: leaking this flag would silently disable
    // TTS for the conversation for the rest of the page's life.
    this.replaying.add(conversationId)
    chatDebug(`[${cshort(conversationId)}] history request FIRING → GET /agents/${agentId}/history`)
    const t0 = Date.now()
    try {
      const h = await hermesApi.history(agentId, conversationId)
      const events: Array<Record<string, unknown>> = h?.events ?? []
      let replayed = 0
      let transcript = 0
      let sawResumedReady = false
      for (const raw of events) {
        // Raw-level: the schema strips unknown keys, and `resumed` is the one
        // that distinguishes "new conversation" from "backend claims it
        // resumed a prior session".
        if (raw.t === 'ready' && (raw as { resumed?: unknown }).resumed === true) sawResumedReady = true
        const r = hermesStreamEventSchema.safeParse(raw)
        if (!r.success) { reportDroppedEvent('history-replay', raw, r.error); continue }
        runInAction(() => this.reduce(conversationId, r.data))
        replayed++
        if (typeof raw.t === 'string' && /^(history|history_thought|history_tool|user|message)$/.test(raw.t)) transcript++
        if (typeof raw.seq === 'number') since = raw.seq
      }
      chatDebug(`[${cshort(conversationId)}] history answered in ${Date.now() - t0}ms: ${events.length} event(s), ${replayed} replayed, ${transcript} transcript turn(s)${sawResumedReady ? ', resumed=true' : ''}${since != null ? `, lastSeq=${since}` : ''}`)
      // A resumed session with ZERO transcript is the started≠started of chat:
      // the backend says "resumed" but returned no prior turns — typically the
      // agent session failed to REBUILD server-side (e.g. no LLM provider
      // configured for the profile). Without this, that failure renders
      // identically to a genuinely empty conversation. (claude1's finding,
      // 2026-08-31: only a bare ready event came back for loom/cinder/wren.)
      if (sawResumedReady && transcript === 0) {
        chatDebug(`[${cshort(conversationId)}] ⚠ RESUMED-BUT-EMPTY: backend resumed the session but returned no prior turns — the agent session likely failed to rebuild server-side`)
        runInAction(() => this.state(conversationId).items.push({
          id: this.nextId++, ts: Date.now(), kind: 'system',
          text: '⚠ This conversation\'s history could not be restored: the backend resumed the session but returned no prior turns. The agent session may have failed to rebuild (check the backend log for acp-bridge errors, e.g. a missing LLM provider). Your messages still send; earlier turns are not shown.',
        }))
      }
      // no "transcript restored" chat item — the restored transcript IS the
      // indicator, and the row re-stacked on re-attach (Travis had ~5).
    } catch (e) {
      // This catch was SILENT — a failed/never-answered history request was
      // indistinguishable from an empty conversation. Say what happened.
      chatDebug(`[${cshort(conversationId)}] ⚠ history request FAILED after ${Date.now() - t0}ms: ${(e as Error)?.message ?? e} — streaming live-only, no transcript restored`)
    }
    finally { this.replaying.delete(conversationId) }
    if (since != null) this.state(conversationId).lastSeq = since
    this.openStream(agentId, conversationId, since)
  }

  private openStream(agentId: string, conversationId: string, since?: number): void {
    if (this.sources.has(conversationId)) {
      chatDebug(`[${cshort(conversationId)}] openStream skipped — a stream is already in the map`)
      return
    }
    chatDebug(`[${cshort(conversationId)}] opening SSE stream${since != null ? ` since=${since}` : ' (from start)'}`)
    this.agents.set(conversationId, agentId)
    const s = this.state(conversationId)
    const base = hermesApi.streamPath(agentId, conversationId)
    const es = new EventSource(since != null ? `${base}&since=${since}` : base)
    this.sources.set(conversationId, es)
    let lastRecv = Date.now()
    const teardown = () => {
      es.close()
      if (this.sources.get(conversationId) === es) this.sources.delete(conversationId)
      const w = this.watchdogs.get(conversationId)
      if (w) { clearInterval(w); this.watchdogs.delete(conversationId) }
    }
    es.onopen = () => {
      chatDebug(`[${cshort(conversationId)}] stream CONNECTED`)
      runInAction(() => { s.connected = true; s.error = null })
    }
    es.onmessage = (ev) => {
      lastRecv = Date.now() // ANY byte (incl. the t:ping heartbeat) proves the socket is live
      let raw: any
      try {
        raw = JSON.parse(ev.data)
      } catch (e) {
        // The file's own standing rule: a silently-dropped input is itself a
        // bug. The schema-mismatch path two lines down reports; a frame that
        // cannot even PARSE (truncation, a mid-write disconnect) was dropped
        // with no trace — the harder failure got the softer handling.
        reportDroppedEvent('live-sse-unparseable', { t: '<unparseable>' }, e)
        return
      }
      const r = hermesStreamEventSchema.safeParse(raw)
      // Forward-compat: unknown variants are ignored rather than fatal — but LOUDLY,
      // so a bridge upgrade that adds an event type cannot silently break the UI again.
      if (!r.success) { reportDroppedEvent('live-sse', raw, r.error); return }
      runInAction(() => {
        this.reduce(conversationId, r.data)
        if (typeof raw.seq === 'number') s.lastSeq = raw.seq
      })
    }
    es.onerror = () => {
      chatDebug(`[${cshort(conversationId)}] stream ERROR (readyState=${es.readyState}) — tearing down, reopen scheduled`)
      runInAction(() => { s.connected = false })
      // Take control of reconnection: native EventSource retries the ORIGINAL url (stale
      // open-time cursor). Tear down and reopen from the latest folded seq instead.
      teardown()
      this.scheduleReopen(conversationId)
    }
    // Liveness watchdog — THE fix for \"reply never posts until refresh\": the backend heartbeats
    // every 15s, so >35s of total silence means the socket is half-open (a proxy stopped forwarding
    // without firing onerror). Force a clean reconnect from lastSeq; the buffered events replay and
    // the chat catches up on its own, no manual reload.
    const watchdog = setInterval(() => {
      if (Date.now() - lastRecv > 35000) {
        chatDebug(`[${cshort(conversationId)}] ⚠ stream SILENT ${Math.round((Date.now() - lastRecv) / 1000)}s (half-open socket) — forcing reconnect`)
        runInAction(() => { s.connected = false })
        teardown()
        this.scheduleReopen(conversationId)
      }
    }, 10000)
    this.watchdogs.set(conversationId, watchdog)
  }

  /** Reopen the observer stream from the last folded seq after a drop/half-open, debounced so a
   *  flapping connection can't spin up parallel EventSources. */
  private scheduleReopen(conversationId: string): void {
    if (this.reconnectTimers.has(conversationId)) return
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(conversationId)
      const agentId = this.agents.get(conversationId)
      if (!agentId || !this.chats.has(conversationId)) {
        chatDebug(`[${cshort(conversationId)}] reopen ABORTED — ${!agentId ? 'no agent mapping' : 'conversation ended'} (won't resurrect)`)
        return // ended/never-attached — don't resurrect
      }
      if (this.sources.has(conversationId)) return
      chatDebug(`[${cshort(conversationId)}] reopening stream after drop`)
      this.openStream(agentId, conversationId, this.state(conversationId).lastSeq || undefined)
    }, 1200)
    this.reconnectTimers.set(conversationId, timer)
  }

  /** Close the observer stream. The backend session keeps running (headless invariant). */
  detach(conversationId: string): void {
    if (this.sources.has(conversationId)) chatDebug(`[${cshort(conversationId)}] detach — closing stream (agent session keeps running)`)
    this.sources.get(conversationId)?.close()
    this.sources.delete(conversationId)
    const w = this.watchdogs.get(conversationId)
    if (w) { clearInterval(w); this.watchdogs.delete(conversationId) }
    const rt = this.reconnectTimers.get(conversationId)
    if (rt) { clearTimeout(rt); this.reconnectTimers.delete(conversationId) }
    const s = this.chats.get(conversationId)
    if (s) s.connected = false
  }

  /** END + WIPE (tab close): detach, kill the backend session + its transcript,
   *  drop the local state — a same-agent reopen starts brand new. */
  async end(agentId: string, conversationId: string): Promise<void> {
    this.detach(conversationId)
    this.chats.delete(conversationId)
    this.restored.delete(conversationId)
    await hermesApi.endConversation(agentId, conversationId)
  }

  /** Edit / Regenerate / Delete the tail turn, then rebuild the transcript from the server's
   *  post-rewind state. The backend soft-deletes (active=0) via Hermes' native rewind and, for
   *  edit/regenerate, re-prompts — so the streamed reply arrives over the re-attached stream. */
  async rewindTail(agentId: string, conversationId: string, mode: 'edit' | 'regenerate' | 'delete', editedText?: string): Promise<void> {
    const r = await hermesApi.rewind(agentId, conversationId, mode, editedText)
    if (r?.error) throw new Error(String(r.error))
    // Rebuild the view: drop the stream, clear items, re-restore from the server (attach re-runs
    // restoreThenStream because items are empty + not in `restored`).
    this.detach(conversationId)
    runInAction(() => {
      const s = this.state(conversationId)
      s.items.splice(0, s.items.length)
      s.queue.length = 0
      s.error = null
    })
    this.restored.delete(conversationId)
    this.attach(agentId, conversationId)
  }

  /** Fold one wire event into the transcript. Exported for the spec. */
  reduce(conversationId: string, ev: HermesStreamEvent): void {
    const s = this.state(conversationId)
    const push = (item: Omit<ChatItem, 'id' | 'ts'>) => {
      s.items.push({ ...item, id: this.nextId++, ts: Date.now() })
    }
    const last = () => s.items[s.items.length - 1]

    switch (ev.t) {
      case 'ready': {
        // Header state only — no chat item. `ready` re-arrives on EVERY
        // re-attach (tab swap → openStream → backend re-sends it), so pushing
        // an item here stacked one "attached — session…" row per swap.
        s.currentModel = ev.current_model ?? null
        s.sessionId = ev.session_id ?? null
        break
      }
      case 'user':
        // History-replay only (the prompt route records user turns; the live
        // bridge never emits this) — rebuilds the user's own bubbles on restore.
        push({ kind: 'user', text: ev.text })
        break
      // ── resumed-session replay (bridge persistence): the prior transcript
      // arrives BEFORE `ready` as complete turns — same bubbles as live, just
      // backfilled, never streaming, and never flipping `busy`. ─────────────
      case 'history':
        push({ kind: ev.role === 'user' ? 'user' : 'assistant', text: ev.text, streaming: false })
        break
      case 'history_thought':
        push({ kind: 'thought', text: ev.text, streaming: false })
        break
      case 'history_tool':
        push({ kind: 'tool', toolId: ev.id ?? null, title: ev.title ?? ev.kind ?? 'tool', status: 'completed', text: '' })
        break
      case 'message': {
        const l = last()
        if (l && l.kind === 'assistant' && l.streaming) l.text += ev.text
        // A NEW bubble supersedes whatever came before it, so nothing older can
        // still be streaming. Without this, every bubble in a multi-step turn keeps
        // its caret and the chat fills with blinking cursors until turn_done.
        else { for (const i of s.items) i.streaming = false; push({ kind: 'assistant', text: ev.text, streaming: true }) }
        break
      }
      case 'thought': {
        const l = last()
        if (l && l.kind === 'thought' && l.streaming) l.text += ev.text
        else { for (const i of s.items) i.streaming = false; push({ kind: 'thought', text: ev.text, streaming: true }) }
        break
      }
      // The steer landed. Hermes acked it on the same session; the bridge diverted the ack
      // here so it could not be appended into the streaming assistant bubble.
      case 'steer_ack': {
        for (let i = s.items.length - 1; i >= 0; i--) {
          const it = s.items[i]
          if (it.kind === 'user' && it.steering) { it.steering = undefined; break }
        }
        break
      }
      case 'tool_start':
        // The message above a tool call is complete — the agent stopped talking to
        // go run something. This is the case that fires repeatedly in a tool loop.
        this.speakFinished(s, conversationId)
        for (const i of s.items) i.streaming = false
        push({ kind: 'tool', toolId: ev.id ?? null, title: ev.title ?? ev.kind ?? 'tool', status: 'running', text: '' })
        break
      case 'tool_progress': {
        const card = [...s.items].reverse().find((i) => i.kind === 'tool' && i.toolId === (ev.id ?? null))
        if (card) card.status = ev.status ?? card.status
        else push({ kind: 'tool', toolId: ev.id ?? null, title: 'tool', status: ev.status ?? null, text: '' })
        break
      }
      case 'commands':
        s.commands = ev.commands
        break
      case 'usageUpdate': {
        const raw = ev.raw as { used?: unknown; size?: unknown } | null
        if (raw && typeof raw.used === 'number' && typeof raw.size === 'number') s.usage = { used: raw.used, size: raw.size }
        break
      }
      case 'agentPlanUpdate':
      case 'plan': {
        // ACP Plan: { entries: [{ content, status?, priority? }] }. Updates replace
        // the plan card in place (a plan is a living checklist, not a transcript).
        const raw = ev.raw as { entries?: Array<{ content?: unknown; status?: unknown; priority?: unknown }> } | null
        const entries = (raw?.entries ?? [])
          .filter((e) => typeof e?.content === 'string')
          .map((e) => ({
            content: e.content as string,
            status: typeof e.status === 'string' ? e.status : undefined,
            priority: typeof e.priority === 'string' ? e.priority : undefined,
          }))
        if (!entries.length) break
        const card = [...s.items].reverse().find((i) => i.kind === 'plan')
        if (card) card.plan = entries
        else push({ kind: 'plan', text: '', plan: entries })
        break
      }
      case 'capture_request':
        // Signal, not transcript: the agent decided to LOOK. Run the
        // panel-hidden capture and POST it back; render only the outcome.
        void this.handleCaptureRequest(conversationId, ev.requestId)
        break
      case 'permission_auto_allow':
        // The bridge auto-approves (mode-driven) — informational, nothing to ask the user.
        push({ kind: 'system', text: `permission auto-allowed (${ev.option_id ?? 'default option'})` })
        break
      case 'status':
        // SERVER-AUTHORITATIVE turn state — the single source of truth for the Stop button. Set here
        // (not guessed from stream activity), so reconnects and other-device turns are always right.
        s.busy = ev.status === 'busy'
        break
      case 'turn_done': {
        this.speakFinished(s, conversationId)
        for (const i of s.items) i.streaming = false
        s.busy = false
        push({ kind: 'system', text: `turn done${ev.stop_reason ? ` · ${ev.stop_reason}` : ''}` })
        break
      }
      case 'error':
        s.busy = false
        push({ kind: 'error', text: `${ev.where ? `[${ev.where}] ` : ''}${ev.message}` })
        break
      case 'fatal': {
        // The bridge died mid-turn. Clear busy so the composer unlocks, and SAY SO —
        // this event was dropped entirely until 2026-07-28, so a dead bridge simply
        // looked like a turn that never finished.
        s.busy = false
        const detail = [ev.reason, ev.message].filter(Boolean).join(': ') || 'bridge stream died'
        push({ kind: 'error', text: `[fatal] ${detail}${ev.recoverable ? ' — send another message to restart the session.' : ''}` })
        console.error('[HermesChatStore] bridge fatal', ev)
        break
      }
      case 'model_set':
        console.info('[HermesChatStore] model set ->', ev.model_id)
        break
      default:
        // mode/session-info passthroughs — no rendering yet.
        break
    }

    // Type-ahead: once the agent returns to idle, auto-send the next queued message. Deferred so
    // we never re-enter fire() mid-reduce; flushQueue re-checks busy, so it can't double-send.
    if (!s.busy && s.queue.length > 0) setTimeout(() => this.flushQueue(conversationId), 0)
  }

  /** view_screen round-trip: capture with the chat panel removed from layout,
   *  POST back keyed by requestId. On failure: no POST — the backend times out
   *  (20s) and tells the agent it couldn't see. Panel restore is captureUI's
   *  own finally. */
  private async handleCaptureRequest(conversationId: string, requestId: string): Promise<void> {
    if (typeof document === 'undefined') return // spec env
    if (!hasLiveShare()) {
      // getDisplayMedia needs a user gesture, which the agent's request lacks — surface a one-click
      // grant. The button acquires the stream (gesture) and completes THIS capture; the stream then
      // persists so every later capture is silent.
      const s = this.state(conversationId)
      runInAction(() => {
        s.items.push({ id: this.nextId++, kind: 'capture_consent', text: 'wants to see your screen', requestId, capConvId: conversationId, ts: Date.now() })
      })
      return
    }
    await this.doCapture(conversationId, requestId)
  }

  /** Grab a still from the live share stream and POST it back. On failure: no POST — the backend's
   *  20s timeout tells the agent it couldn't see, and we surface a visible error. */
  private async doCapture(conversationId: string, requestId: string): Promise<void> {
    const fail = (why: string) => {
      const s = this.state(conversationId)
      runInAction(() => {
        s.items.push({ id: this.nextId++, kind: 'error', text: `screen capture failed — the agent's view_screen will time out (${why})`, ts: Date.now() })
      })
    }
    try {
      const shot = await captureUI()
      if (!shot) { fail('capture returned no image'); return }
      await hermesApi.screenCapture(requestId, shot)
      const s = this.state(conversationId)
      runInAction(() => {
        s.items.push({ id: this.nextId++, kind: 'system', text: '📸 agent viewed your screen', ts: Date.now() })
      })
    } catch (e) {
      fail(String((e as Error)?.message ?? e))
    }
  }

  /** Wired to the capture_consent button (user gesture): acquire the share stream, drop the prompt,
   *  then complete the pending capture. Later captures reuse the stream silently. */
  async grantScreenShareAndCapture(conversationId: string, requestId: string): Promise<void> {
    const ok = await acquireScreenShare()
    const s = this.state(conversationId)
    runInAction(() => {
      for (let i = s.items.length - 1; i >= 0; i--) {
        if (s.items[i].kind === 'capture_consent' && s.items[i].requestId === requestId) s.items.splice(i, 1)
      }
    })
    if (!ok) {
      runInAction(() => {
        s.items.push({ id: this.nextId++, kind: 'system', text: 'screen share not granted — the agent will time out', ts: Date.now() })
      })
      return
    }
    await this.doCapture(conversationId, requestId)
  }

  /**
   * Send one turn. The reply renders via the stream; the POST is for error surfacing.
   * Feature A (page-aware agents): viewContext rides along on EVERY turn; a
   * captureUI screenshot is attached ONLY when the bound agent's model is
   * vision-capable (backend heuristic via GET /agents capabilities). Context
   * augments the agent's turn server-side — the displayed message stays clean;
   * the transcript marks carrying turns with a chip (ctxAttached).
   */
  /** Stop button — cancel the in-flight turn. Purely a REQUEST to the server; we do NOT optimistically
   *  flip busy — the authoritative idle status arrives back over the stream once the model actually
   *  stops, so the button state always reflects the real backend state. */
  stop(agentId: string, conversationId: string): void {
    void hermesApi.stop(agentId, conversationId)
  }

  /**
   * Speak the assistant bubble that is finishing right now, if TTS is on.
   *
   * Called at the two points where a bubble is finalized (a tool call starting above
   * it, or the turn ending) — the same invariant that stops its caret. Speaking here
   * rather than at turn end means a multi-step turn is narrated as it happens instead
   * of arriving as one burst afterwards.
   *
   * Only `assistant` bubbles: thoughts and tool cards are deliberately never spoken.
   * The agentId rides along as TtsPlayback's `role`, which is how it resolves a
   * per-agent voice/RVC override.
   */
  private speakFinished(s: AgentChatState, conversationId: string): void {
    if (this.replaying.has(conversationId)) return  // historical, not happening now
    if (!this.ttsOnFor(conversationId)) {
      // Not an error, but say so: "muted" and "broken" look identical otherwise.
      console.debug(`[chat] not speaking — auto-TTS is off for this chat `
        + `(per-chat=${this.chatTtsMode(conversationId) ?? 'inherit'}, global=${isTtsEnabled()})`)
      return
    }
    const item = [...s.items].reverse().find((i) => i.streaming && i.kind === 'assistant')
    if (!item?.text?.trim()) {
      console.debug('[chat] not speaking — no finished assistant text at this point')
      return
    }
    const agentId = this.agents.get(conversationId)
    const text = item.text
    // speakTextNow, NOT speakText. speakText re-checks the GLOBAL auto-speak flag and
    // returns silently — so a per-chat "Speaking" override while global was off passed
    // ttsOnFor() here and was then vetoed one layer down, and nothing ever reached the
    // TTS pool. The per-chat decision has ALREADY been made by ttsOnFor(); re-deciding it
    // downstream is what made the override useless.
    console.log(`[chat] speaking ${text.length} chars as ${agentId ?? 'unknown agent'}`)
    void this.agentVoice(agentId)
      .then((override) => speakTextNow(text, agentId, override))
      .catch((e) => { console.warn(`[chat] TTS failed for ${agentId ?? 'unknown agent'}:`, e) })
  }

  /**
   * The agent's own voice, from its server-side spec.tts. Cached per agent — this runs on
   * every finished bubble and the spec changes only when someone edits it.
   *
   * Only `ailab` yields an override: the other providers are native Hermes TTS, which the
   * UI does not synthesize. undefined means "fall back to the role map / global default",
   * which is exactly the behaviour before per-agent voices existed.
   */
  /**
   * Conversations currently replaying buffered history. Speech is SUPPRESSED for these.
   *
   * The replayed events are the original types (message, turn_done), not history_*, so
   * they run the same reducer path as live ones — which meant every attach re-spoke the
   * last turn. Refreshing mid-sentence started the reply over, and a second tab spoke it
   * again from its own replay. Audio is a side effect of something happening NOW; replaying
   * a transcript is not that.
   */
  private replaying = new Set<string>()

  private voiceCache = new Map<string, TtsOverride | undefined>()

  /**
   * Per-conversation Auto-TTS override, beating the global toggle.
   *
   * THREE states, and the third one matters: undefined = follow the global setting,
   * 'on'/'off' = an explicit decision for this chat only. Without the inherit state a
   * chat would be frozen to whatever global happened to be the first time it rendered,
   * and changing global afterwards would mysteriously affect some chats and not others.
   *
   * Persisted per conversation so it survives a reload — a chat you muted should stay
   * muted, otherwise you re-mute it every refresh.
   */
  private chatTts = new Map<string, 'on' | 'off'>()

  private chatTtsKey(conversationId: string): string { return `ailab-chat-tts:${conversationId}` }

  chatTtsMode(conversationId: string): 'on' | 'off' | undefined {
    if (this.chatTts.has(conversationId)) return this.chatTts.get(conversationId)
    let v: 'on' | 'off' | undefined
    try {
      const raw = localStorage.getItem(this.chatTtsKey(conversationId))
      if (raw === 'on' || raw === 'off') v = raw
    } catch { /* private mode / storage disabled — inherit is a fine answer */ }
    if (v) this.chatTts.set(conversationId, v)
    return v
  }

  /** Pass undefined to clear the override and go back to following the global setting. */
  setChatTtsMode(conversationId: string, mode: 'on' | 'off' | undefined): void {
    if (mode) this.chatTts.set(conversationId, mode)
    else this.chatTts.delete(conversationId)
    try {
      if (mode) localStorage.setItem(this.chatTtsKey(conversationId), mode)
      else localStorage.removeItem(this.chatTtsKey(conversationId))
    } catch { /* non-fatal: the in-memory value still applies for this session */ }
  }

  /** Effective Auto-TTS for one chat: explicit override if set, else the global toggle. */
  ttsOnFor(conversationId: string): boolean {
    const m = this.chatTtsMode(conversationId)
    return m === 'on' ? true : m === 'off' ? false : isTtsEnabled()
  }

  private async agentVoice(agentId?: string): Promise<TtsOverride | undefined> {
    if (!agentId) return undefined
    if (this.voiceCache.has(agentId)) return this.voiceCache.get(agentId)
    let resolved: TtsOverride | undefined
    try {
      const r = await fetch(`/api/hermes/agents/${encodeURIComponent(agentId)}`)
      if (r.ok) {
        const t = (await r.json())?.spec?.tts
        if (t?.provider === 'ailab') {
          resolved = { voice: t.voiceId, model: t.modelId, rvcEnabled: t.rvcEnabled, rvcModel: t.rvcModel, preset: t.preset }
          // RESOLVE the preset to its concrete voice+model. Passing `preset` through was
          // useless: the synthesis request never carried it, so an agent with a preset
          // spoke in the GLOBAL default voice — and because choosing a preset leaves the
          // voice field blank by design, there was nothing else to fall back to.
          // Resolving here means every downstream path works without preset support.
          if (t.preset) {
            try {
              const pr = await fetch(`/api/proxy/multi-tts/voice-presets/${encodeURIComponent(t.preset)}`)
              if (pr.ok) {
                const p = await pr.json()
                if (p?.voice) resolved.voice = p.voice
                if (p?.model) resolved.model = p.model
                console.log(`[chat] preset '${t.preset}' -> voice ${p?.voice}, model ${p?.model}`)
              } else {
                console.warn(`[chat] preset '${t.preset}' could not be resolved (HTTP ${pr.status}) — `
                  + `falling back to the voice field, which a preset normally leaves blank`)
              }
            } catch (e) {
              console.warn(`[chat] preset '${t.preset}' lookup failed:`, e)
            }
          }
        }
      }
    } catch (e) {
      // Cached as undefined either way, so a dead spec endpoint degrades to the global
      // voice instead of re-requesting on every single bubble.
      console.warn(`[chat] could not read voice config for ${agentId}:`, e)
    }
    this.voiceCache.set(agentId, resolved)
    return resolved
  }

  /** Drop a cached voice so an edit in the agent editor takes effect without a reload. */
  invalidateVoice(agentId: string): void { this.voiceCache.delete(agentId) }

  /**
   * Speak one specific message on demand, in the agent's own voice.
   *
   * Deliberately does NOT consult the Auto-TTS setting: "read me this one" and "read me
   * everything" are separate requests, and refusing an explicit click because a global
   * toggle is off would be indefensible. Errors surface to the caller so the button can
   * show a failure rather than doing nothing.
   */
  async speakMessage(agentId: string, text: string): Promise<void> {
    const t = text.trim()
    if (!t) return
    const override = await this.agentVoice(agentId)
    await speakTextNow(t, agentId, override)
  }

  async send(agentId: string, conversationId: string, text: string): Promise<void> {
    const s = this.state(conversationId)
    const t = text.trim()
    if (!t) return
    this.agents.set(conversationId, agentId)

    // ALWAYS render the user's message immediately — it must never vanish.
    const item: ChatItem = { id: this.nextId++, kind: 'user', text: t, ts: Date.now() }
    s.items.push(item)

    // MID-TURN => STEER, always. Travis: "Anytime I send a message while an agent is working,
    // it means I want them to see it ASAP" — if he wanted it to land after the turn he would
    // have waited. Hermes injects it at the next tool boundary rather than at turn end.
    // Queueing survives only as the fallback for when steering is impossible.
    if (s.busy) {
      runInAction(() => { item.steering = true })
      const r = await hermesApi.steer(agentId, t, { conversationId })
      if (r.ok) return
      // No live session (409) or the write failed: fall back to type-ahead so the message is
      // still delivered. Log the reason — a steer silently degrading to a queue looks like
      // steering is broken, and the difference is invisible from the transcript alone.
      console.warn(`[chat] steer rejected (${r.error || 'unknown'}) — falling back to queue`)
      runInAction(() => { item.steering = undefined; item.queued = true })
      s.queue.push({ itemId: item.id, text: t })
      return
    }
    await this.fire(agentId, conversationId, t, item)
  }

  /** POST one turn. Sets busy synchronously so a concurrent flush can't double-fire. The reply
   *  renders via the stream; the POST is for error surfacing + view-context attach. */
  private async fire(agentId: string, conversationId: string, t: string, item: ChatItem): Promise<void> {
    const s = this.state(conversationId)
    s.busy = true
    const extra: { context?: string; screenshot?: string; conversationId?: string } = { conversationId }
    try {
      // Context is snapshotted at SEND time (for a queued msg, that's when it actually fires).
      const snapshot = buildViewSnapshot((window as any).__appStore)
      if (snapshot) { extra.context = JSON.stringify(snapshot, null, 1); item.ctxAttached = 'text' }
    } catch { /* context is best-effort — never block the send */ }
    // Screenshots are NOT auto-attached (Travis: the every-send panel-hide was jarring; the agent
    // looks when IT decides to, via claude1's capture-on-signal contract).
    const r = await hermesApi.prompt(agentId, t, extra)
    runInAction(() => {
      if (!r.ok) {
        s.busy = false
        s.items.push({ id: this.nextId++, kind: 'error', text: r.error || 'prompt failed', ts: Date.now() })
        // A failed send must not wedge the queue — drain the next one.
        setTimeout(() => this.flushQueue(conversationId), 0)
      }
      // /prompt is FIRE-AND-ACK ({ok, fired}) — the reply arrives over the stream, whose
      // turn_done/error clears busy. Don't clear it here or the composer re-enables in the gap
      // between the ack and the first chunk.
    })
  }

  /** Send the next queued (type-ahead) message once the agent is idle. Called (deferred) from
   *  reduce() on every busy->idle transition; guarded so overlapping calls can't double-send. */
  private flushQueue(conversationId: string): void {
    const s = this.chats.get(conversationId)
    if (!s || s.busy || s.queue.length === 0) return
    const agentId = this.agents.get(conversationId)
    if (!agentId) return
    const next = s.queue.shift()!
    const item = s.items.find((i) => i.id === next.itemId)
    if (item) item.queued = undefined
    if (!item) { // bubble was removed (rewind/end) — skip it but keep draining
      setTimeout(() => this.flushQueue(conversationId), 0)
      return
    }
    void this.fire(agentId, conversationId, next.text, item)
  }
}

export const hermesChatStore = new HermesChatStore()
