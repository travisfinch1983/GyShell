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
  kind: 'user' | 'assistant' | 'thought' | 'tool' | 'system' | 'error'
  text: string
  /** tool cards: ACP tool_call id + latest status */
  toolId?: string | null
  title?: string | null
  status?: string | null
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

class HermesChatStore {
  chats = new Map<string, AgentChatState>()
  private sources = new Map<string, EventSource>()
  private nextId = 1

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
    }
    return s
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
        // plan/mode/session-info passthroughs — no rendering yet.
        break
    }
  }

  /** Send one turn. The reply renders via the stream; the POST is for error surfacing. */
  async send(agentId: string, text: string): Promise<void> {
    const s = this.state(agentId)
    const t = text.trim()
    if (!t || s.busy) return
    s.items.push({ id: this.nextId++, kind: 'user', text: t, ts: Date.now() })
    s.busy = true
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
