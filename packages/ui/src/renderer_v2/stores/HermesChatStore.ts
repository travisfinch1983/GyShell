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
 * The transcript is what this observer has seen: it survives tab switches (module
 * singleton) but not a page reload — there is no session-history read-back
 * endpoint yet (flagged to claude1).
 */
import { makeAutoObservable, runInAction } from 'mobx'
import { hermesStreamEventSchema, type HermesSlashCommand, type HermesStreamEvent } from '@gyshell/shared'
import { hermesApi } from './hermesApi'

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

/** Interim reload persistence (sessionStorage, bounded) until a backend
 *  session-history endpoint exists. The session itself always survives on the
 *  backend — this only preserves what THIS browser tab has already seen. */
const PERSIST_MAX_ITEMS = 300
function persistKey(agentId: string): string {
  return `hermesChat:${agentId}`
}

class HermesChatStore {
  chats = new Map<string, AgentChatState>()
  private sources = new Map<string, EventSource>()
  private nextId = 1
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true })
  }

  state(agentId: string): AgentChatState {
    let s = this.chats.get(agentId)
    if (!s) {
      // Read back after set: observable.map deep-converts values on insertion,
      // so the stored proxy — not the plain literal — must be what we mutate.
      this.chats.set(agentId, emptyState())
      s = this.chats.get(agentId)!
      this.hydrate(agentId, s)
    }
    return s
  }

  private hydrate(agentId: string, s: AgentChatState): void {
    if (typeof sessionStorage === 'undefined') return
    try {
      const raw = sessionStorage.getItem(persistKey(agentId))
      if (!raw) return
      const items = JSON.parse(raw) as ChatItem[]
      if (!Array.isArray(items) || !items.length) return
      s.items.push(...items.map((i) => ({ ...i, streaming: false })))
      this.nextId = Math.max(this.nextId, ...items.map((i) => i.id)) + 1
      s.items.push({ id: this.nextId++, kind: 'system', text: 'transcript restored (this browser session) — live from here', ts: Date.now() })
    } catch { /* corrupt cache — start fresh */ }
  }

  private schedulePersist(agentId: string): void {
    if (typeof sessionStorage === 'undefined') return
    const prev = this.saveTimers.get(agentId)
    if (prev) clearTimeout(prev)
    this.saveTimers.set(agentId, setTimeout(() => {
      this.saveTimers.delete(agentId)
      const s = this.chats.get(agentId)
      if (!s) return
      try {
        sessionStorage.setItem(persistKey(agentId), JSON.stringify(s.items.slice(-PERSIST_MAX_ITEMS)))
      } catch { /* quota — drop persistence, never the transcript */ }
    }, 400))
  }

  /** Open the observer stream (idempotent). Never affects the backend session. */
  attach(agentId: string): void {
    if (this.sources.has(agentId)) return
    const s = this.state(agentId)
    const es = new EventSource(hermesApi.streamPath(agentId))
    this.sources.set(agentId, es)
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
      runInAction(() => this.reduce(agentId, parsed))
    }
  }

  /** Close the observer stream. The backend session keeps running (headless invariant). */
  detach(agentId: string): void {
    this.sources.get(agentId)?.close()
    this.sources.delete(agentId)
    const s = this.chats.get(agentId)
    if (s) s.connected = false
  }

  /** Fold one wire event into the transcript. Exported for the spec. */
  reduce(agentId: string, ev: HermesStreamEvent): void {
    const s = this.state(agentId)
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
    this.schedulePersist(agentId)
  }

  /** Send one turn. The reply renders via the stream; the POST is for error surfacing. */
  async send(agentId: string, text: string): Promise<void> {
    const s = this.state(agentId)
    const t = text.trim()
    if (!t || s.busy) return
    s.items.push({ id: this.nextId++, kind: 'user', text: t, ts: Date.now() })
    s.busy = true
    this.schedulePersist(agentId)
    const r = await hermesApi.prompt(agentId, t)
    runInAction(() => {
      if (!r.ok) {
        s.busy = false
        s.items.push({ id: this.nextId++, kind: 'error', text: r.error || 'prompt failed', ts: Date.now() })
      }
      // On success the stream's turn_done already cleared busy; this is a no-op then.
      else s.busy = false
    })
  }
}

export const hermesChatStore = new HermesChatStore()
