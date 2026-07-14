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
  commands: HermesSlashCommand[]
  /** context-window meter from usageUpdate: {used, size} */
  usage: { used: number; size: number } | null
  currentModel: string | null
  /** backend session id from `ready` — HEADER state, never a chat item (the
   *  old "attached — session…" items stacked one per tab-swap re-attach). */
  sessionId: string | null
  error: string | null
}

function emptyState(): AgentChatState {
  return { items: [], connected: false, busy: false, commands: [], usage: null, currentModel: null, sessionId: null, error: null }
}

class HermesChatStore {
  chats = new Map<string, AgentChatState>()
  private sources = new Map<string, EventSource>()
  private nextId = 1
  private restored = new Set<string>()

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true })
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
    if (this.sources.has(conversationId)) return
    const s = this.state(conversationId)
    // SERVER-TRUTH RESTORE (once per conversation per page load): replay the
    // stored transcript through reduce(), then attach the live stream from the
    // last replayed seq — no duplicates, no gap.
    if (!this.restored.has(conversationId) && s.items.length === 0) {
      this.restored.add(conversationId)
      void this.restoreThenStream(agentId, conversationId)
      return
    }
    this.openStream(agentId, conversationId)
  }

  private async restoreThenStream(agentId: string, conversationId: string): Promise<void> {
    let since: number | undefined
    try {
      const h = await hermesApi.history(agentId, conversationId)
      const events: Array<Record<string, unknown>> = h?.events ?? []
      let replayed = 0
      for (const raw of events) {
        const r = hermesStreamEventSchema.safeParse(raw)
        if (!r.success) continue
        runInAction(() => this.reduce(conversationId, r.data))
        replayed++
        if (typeof raw.seq === 'number') since = raw.seq
      }
      // no "transcript restored" chat item — the restored transcript IS the
      // indicator, and the row re-stacked on re-attach (Travis had ~5).
      void replayed
    } catch { /* no history yet / route hiccup — stream from live */ }
    this.openStream(agentId, conversationId, since)
  }

  private openStream(agentId: string, conversationId: string, since?: number): void {
    if (this.sources.has(conversationId)) return
    const s = this.state(conversationId)
    const base = hermesApi.streamPath(agentId, conversationId)
    const es = new EventSource(since != null ? `${base}&since=${since}` : base)
    this.sources.set(conversationId, es)
    es.onopen = () => runInAction(() => { s.connected = true; s.error = null })
    es.onerror = () => runInAction(() => { s.connected = false })
    es.onmessage = (ev) => {
      let parsed: HermesStreamEvent
      try {
        const r = hermesStreamEventSchema.safeParse(JSON.parse(ev.data))
        if (!r.success) return // forward-compat: ignore unknown variants
        parsed = r.data
      } catch {
        return
      }
      runInAction(() => this.reduce(conversationId, parsed))
    }
  }

  /** Close the observer stream. The backend session keeps running (headless invariant). */
  detach(conversationId: string): void {
    this.sources.get(conversationId)?.close()
    this.sources.delete(conversationId)
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
        else push({ kind: 'assistant', text: ev.text, streaming: true })
        break
      }
      case 'thought': {
        const l = last()
        if (l && l.kind === 'thought' && l.streaming) l.text += ev.text
        else push({ kind: 'thought', text: ev.text, streaming: true })
        break
      }
      case 'tool_start':
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
        for (const i of s.items) i.streaming = false
        s.busy = false
        push({ kind: 'system', text: `turn done${ev.stop_reason ? ` · ${ev.stop_reason}` : ''}` })
        break
      }
      case 'error':
        s.busy = false
        push({ kind: 'error', text: `${ev.where ? `[${ev.where}] ` : ''}${ev.message}` })
        break
      default:
        // mode/session-info passthroughs — no rendering yet.
        break
    }
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

  async send(agentId: string, conversationId: string, text: string): Promise<void> {
    const s = this.state(conversationId)
    const t = text.trim()
    if (!t || s.busy) return

    const extra: { context?: string; screenshot?: string; conversationId?: string } = { conversationId }
    try {
      const snapshot = buildViewSnapshot((window as any).__appStore)
      if (snapshot) extra.context = JSON.stringify(snapshot, null, 1)
    } catch { /* context is best-effort — never block the send */ }
    // Screenshots are NOT auto-attached anymore (Travis: the every-send
    // panel-hide was jarring, and the agent should look when IT decides to).
    // On-demand capture arrives via claude1's capture-on-signal tool contract;
    // captureUI({hide:['.ai-lab-global-chat']}) is the ready-made mechanism.

    s.items.push({
      id: this.nextId++, kind: 'user', text: t, ts: Date.now(),
      ctxAttached: extra.context ? 'text' : undefined,
    })
    s.busy = true
    const r = await hermesApi.prompt(agentId, t, extra)
    runInAction(() => {
      if (!r.ok) {
        s.busy = false
        s.items.push({ id: this.nextId++, kind: 'error', text: r.error || 'prompt failed', ts: Date.now() })
      }
      // /prompt is FIRE-AND-ACK ({ok, fired}) — the reply arrives over the
      // stream, whose turn_done/error clears busy. Don't clear it here or the
      // composer re-enables in the gap between the ack and the first chunk.
    })
  }
}

export const hermesChatStore = new HermesChatStore()
