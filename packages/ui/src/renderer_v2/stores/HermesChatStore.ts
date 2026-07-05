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
import { hermesAgentsStore } from './HermesAgentsStore'
import { buildViewSnapshot } from '../lib/viewContext'
import { captureUI } from '../services/ScreenshotService'

export interface ChatItem {
  id: number
  kind: 'user' | 'assistant' | 'thought' | 'tool' | 'system' | 'error' | 'plan'
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
  error: string | null
}

function emptyState(): AgentChatState {
  return { items: [], connected: false, busy: false, commands: [], usage: null, currentModel: null, error: null }
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
      if (replayed > 0) {
        const s = this.state(conversationId)
        runInAction(() => {
          s.items.push({ id: this.nextId++, kind: 'system', text: 'transcript restored from server', ts: Date.now() })
        })
      }
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
        s.currentModel = ev.current_model ?? null
        push({ kind: 'system', text: `attached — session ${ev.session_id ?? '?'}${ev.current_model ? ` · ${ev.current_model}` : ''}` })
        break
      }
      case 'user':
        // History-replay only (the prompt route records user turns; the live
        // bridge never emits this) — rebuilds the user's own bubbles on restore.
        push({ kind: 'user', text: ev.text })
        break
      case 'message': {
        s.busy = true // covers turns initiated by other clients of the shared session
        const l = last()
        if (l && l.kind === 'assistant' && l.streaming) l.text += ev.text
        else push({ kind: 'assistant', text: ev.text, streaming: true })
        break
      }
      case 'thought': {
        s.busy = true
        const l = last()
        if (l && l.kind === 'thought' && l.streaming) l.text += ev.text
        else push({ kind: 'thought', text: ev.text, streaming: true })
        break
      }
      case 'tool_start':
        s.busy = true
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
      case 'permission_auto_allow':
        // The bridge auto-approves (mode-driven) — informational, nothing to ask the user.
        push({ kind: 'system', text: `permission auto-allowed (${ev.option_id ?? 'default option'})` })
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

  /**
   * Send one turn. The reply renders via the stream; the POST is for error surfacing.
   * Feature A (page-aware agents): viewContext rides along on EVERY turn; a
   * captureUI screenshot is attached ONLY when the bound agent's model is
   * vision-capable (backend heuristic via GET /agents capabilities). Context
   * augments the agent's turn server-side — the displayed message stays clean;
   * the transcript marks carrying turns with a chip (ctxAttached).
   */
  async send(agentId: string, conversationId: string, text: string): Promise<void> {
    const s = this.state(conversationId)
    const t = text.trim()
    if (!t || s.busy) return

    const extra: { context?: string; screenshot?: string; conversationId?: string } = { conversationId }
    try {
      const snapshot = buildViewSnapshot((window as any).__appStore)
      if (snapshot) extra.context = JSON.stringify(snapshot, null, 1)
    } catch { /* context is best-effort — never block the send */ }
    if (hermesAgentsStore.capabilities[agentId]?.visionCapable) {
      try {
        // HIDE the chat panel (display:none + reflow) — the agent must see the
        // full underlying view, exactly what Travis sees minus the panel.
        const shot = await captureUI({ hide: ['.ai-lab-global-chat'] })
        if (shot) extra.screenshot = shot
      } catch { /* screenshot is best-effort */ }
    }

    s.items.push({
      id: this.nextId++, kind: 'user', text: t, ts: Date.now(),
      ctxAttached: extra.screenshot ? 'vision' : extra.context ? 'text' : undefined,
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
