import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import { ChatPanel } from '../Chat/ChatPanel'
import { ChatHistoryPanel } from '../Chat/ChatHistoryPanel'
import { Bot, History, MessagesSquare, Plus, X } from 'lucide-react'
import { hermesAgentsStore } from '../../stores/HermesAgentsStore'
import { AgentConversation } from '../AgentChat/AgentChatPanel'
import { hermesChatStore } from '../../stores/HermesChatStore'
import { hermesConversationsStore } from '../../stores/hermesConversationsStore'
import './globalChat.scss'
import { newUuid } from '../../lib/uuid'

interface Props {
  store: AppStore
  /** When true (sidebar expanded), the chat is shown overlaying the tab content. */
  visible: boolean
}

/**
 * UNIFIED multi-agent chat overlay (Travis design 2026-07-04, supersedes the
 * Chat|Agents mode switch): the tab strip holds plain conversations, each
 * BOUND to an agent at creation via the + picker —
 *  - "AI-Lab Assistant" → a ChatStore session (AgentService_v2 engine;
 *    ChatPanel body with hideTabBar — the unified strip lives here instead).
 *  - any Hermes agent → an ACP streaming conversation (AgentConversation /
 *    HermesChatStore; one tab per agent — the picker focuses an existing tab).
 * Bindings survive reload: sessions persist via ChatStore as before; Hermes
 * tabs + the active tab id persist in localStorage.
 */

const HERMES_TABS_KEY = 'ai-lab-hermes-chat-tabs'
const ACTIVE_TAB_KEY = 'ai-lab-chat-active-tab' // 'session:<id>' | 'hermes:<conversationId>'

/** A Hermes chat tab = one CONVERSATION (own backend ACP session + transcript). */
interface HermesTab { cid: string; agentId: string }

const loadHermesTabs = (): HermesTab[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(HERMES_TABS_KEY) ?? '[]') as Array<string | HermesTab>
    // Migrate the pre-conversation format (plain agentId strings) — each old tab
    // becomes a fresh conversation (the old shared per-agent session is legacy).
    return raw
      .map((t) => (typeof t === 'string' ? { cid: newUuid(), agentId: t } : t))
      .filter((t) => t && typeof t.cid === 'string' && typeof t.agentId === 'string')
  } catch { return [] }
}

export const GlobalChat: React.FC<Props> = observer(({ store, visible }) => {
  const [hermesTabs, setHermesTabs] = useState<HermesTab[]>(loadHermesTabs)
  const [active, setActive] = useState<string>(() => localStorage.getItem(ACTIVE_TAB_KEY) || '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)

  // Computed inline (no useMemo) on purpose: observer handles MobX re-renders.
  const sessions = store.chat?.sessions || []

  useEffect(() => {
    if (visible && hermesTabs.length) void hermesAgentsStore.refresh()
  }, [visible, hermesTabs.length])

  useEffect(() => {
    if (!pickerOpen) return
    const close = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [pickerOpen])

  const sessionIds = sessions.map((s) => s.id)

  // Resolve the active tab; fall back to the first main session.
  const sep = active.indexOf(':')
  const [kind, ref] = sep > 0 ? [active.slice(0, sep), active.slice(sep + 1)] : ['session', '']
  const activeHermes = kind === 'hermes' ? (hermesTabs.find((t) => t.cid === ref && hermesConversationsStore.has(t.cid)) ?? null) : null
  // Tabs whose conversation still lives in the shared store — a delete in the full-page Chat tab
  // (hermesConversationsStore.remove) drops the conversation from this panel too.
  const visibleHermesTabs = hermesTabs.filter((t) => hermesConversationsStore.has(t.cid))
  const activeSessionId = !activeHermes
    ? (kind === 'session' && sessionIds.includes(ref)
        ? ref
        : store.chat?.activeSessionId && sessionIds.includes(store.chat.activeSessionId)
          ? store.chat.activeSessionId
          : sessionIds[0]) || null
    : null

  const pick = (id: string) => {
    setActive(id)
    localStorage.setItem(ACTIVE_TAB_KEY, id)
  }
  const saveHermesTabs = (tabs: HermesTab[]) => {
    setHermesTabs(tabs)
    localStorage.setItem(HERMES_TABS_KEY, JSON.stringify(tabs))
  }

  // Seed the shared store with this browser's tabs (so the full-page Chat tab sees them too), then
  // reconcile against the server registry.
  useLayoutEffect(() => {
    hermesTabs.forEach((t) => hermesConversationsStore.ensure(t.cid, t.agentId))
    void hermesConversationsStore.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When a conversation is deleted elsewhere (full-page Chat tab), the shared store drops it — prune
  // it from this panel's tabs + localStorage so it doesn't linger here or reappear on reload.
  useEffect(() => {
    setHermesTabs((prev) => {
      const kept = prev.filter((t) => hermesConversationsStore.has(t.cid))
      if (kept.length === prev.length) return prev
      localStorage.setItem(HERMES_TABS_KEY, JSON.stringify(kept))
      return kept
    })
  }, [hermesConversationsStore.list.length])

  // Cross-device: pull the server-side conversation list and add any conversations this browser
  // doesn't already have as tabs (localStorage is per-device; the server registry is authoritative).
  useEffect(() => {
    void (async () => {
      try {
        const b = (window as unknown as { gyshell?: { cluster?: { request: (m: string, p: string) => Promise<unknown> } } }).gyshell?.cluster
        const r = (await b?.request('GET', '/api/hermes/conversations')) as { conversations?: Array<{ conversationId: string; agentId: string }> } | undefined
        const convs = Array.isArray(r?.conversations) ? r!.conversations : []
        if (!convs.length) return
        setHermesTabs((prev) => {
          const have = new Set(prev.map((t) => t.cid))
          const extra = convs.filter((c) => c.conversationId && c.agentId && !have.has(c.conversationId)).map((c) => ({ cid: c.conversationId, agentId: c.agentId }))
          if (!extra.length) return prev
          const merged = [...prev, ...extra]
          localStorage.setItem(HERMES_TABS_KEY, JSON.stringify(merged))
          return merged
        })
      } catch { /* best-effort */ }
    })()
  }, [])

  // Keep ChatStore's activeSessionId in sync when a session tab is active.
  useEffect(() => {
    if (!visible || !activeSessionId) return
    if (store.chat?.activeSessionId !== activeSessionId && typeof store.chat?.setActiveSession === 'function') {
      try { store.chat.setActiveSession(activeSessionId) } catch { /* ok */ }
    }
  }, [visible, activeSessionId, store.chat])

  const newAssistantChat = () => {
    setPickerOpen(false)
    try {
      const id = store.chat.createSession()
      pick(`session:${id}`)
    } catch (err) { console.warn('[GlobalChat] createSession failed:', err) }
  }
  const openHermesTab = (agentId: string) => {
    setPickerOpen(false)
    // ALWAYS a new conversation (Travis): fresh cid → fresh backend session,
    // even when other tabs for the same agent exist — each has its own context.
    const tab: HermesTab = { cid: newUuid(), agentId }
    hermesConversationsStore.ensure(tab.cid, agentId)
    saveHermesTabs([...hermesTabs, tab])
    pick(`hermes:${tab.cid}`)
  }
  const closeHermesTab = (tab: HermesTab) => {
    // Shared-store delete: drops the conversation from the full-page Chat tab too (both observe the
    // store) AND wipes the backend session + transcript. Local tab + localStorage dropped as well.
    void hermesConversationsStore.remove(tab.cid, tab.agentId)
    saveHermesTabs(hermesTabs.filter((t) => t.cid !== tab.cid))
    if (activeHermes?.cid === tab.cid) pick(sessionIds[0] ? `session:${sessionIds[0]}` : '')
  }
  const closeSessionTab = (id: string) => {
    // Persistent delete (in-memory close would just rehydrate on reload).
    void store.chat.deleteChatSession(id).catch((err) => console.warn('[GlobalChat] deleteChatSession failed:', id, err))
    if (kind === 'session' && ref === id) pick('')
  }

  if (!visible) return null

  return (
    <div className="ai-lab-global-chat">
      {/* ── unified tab strip: every tab = one conversation bound to an agent ── */}
      <div className="glc-strip">
        <div className="glc-tabs">
          {sessions.map((s) => (
            <div key={s.id} className={`glc-tab ${!activeHermes && s.id === activeSessionId ? 'active' : ''}`} onClick={() => pick(`session:${s.id}`)}>
              <MessagesSquare size={11} />
              <span className="glc-tab-title">{s.title || 'Chat'}</span>
              <button className="glc-tab-close" onClick={(e) => { e.stopPropagation(); closeSessionTab(s.id) }}><X size={11} /></button>
            </div>
          ))}
          {visibleHermesTabs.map((t, i) => {
            const dupIndex = visibleHermesTabs.filter((x, j) => x.agentId === t.agentId && j <= i).length
            const dups = visibleHermesTabs.filter((x) => x.agentId === t.agentId).length
            const name = hermesAgentsStore.specs.get(t.agentId)?.displayName ?? t.agentId
            return (
              <div key={t.cid} className={`glc-tab hermes ${activeHermes?.cid === t.cid ? 'active' : ''}`} onClick={() => pick(`hermes:${t.cid}`)}>
                <Bot size={11} />
                <span className="glc-tab-title">{dups > 1 ? `${name} · ${dupIndex}` : name}</span>
                <button className="glc-tab-close" onClick={(e) => { e.stopPropagation(); closeHermesTab(t) }}><X size={11} /></button>
              </div>
            )
          })}
        </div>
        <div className="glc-actions" ref={pickerRef}>
          <button className="glc-act" title="New chat — pick an agent" onClick={() => { setPickerOpen((o) => !o); if (!pickerOpen) void hermesAgentsStore.refresh() }}>
            <Plus size={14} />
          </button>
          <button className="glc-act" title="Session history" onClick={() => setShowHistory(true)}>
            <History size={13} />
          </button>
          {pickerOpen && (
            <div className="glc-picker">
              <div className="glc-picker-head">New chat with…</div>
              <button className="glc-picker-item" onClick={newAssistantChat}>
                <MessagesSquare size={13} /> AI-Lab Assistant
                <span className="glc-picker-sub">main chat engine</span>
              </button>
              {hermesAgentsStore.chattableAgents.map((id) => (
                <button key={id} className="glc-picker-item" onClick={() => openHermesTab(id)}>
                  <Bot size={13} /> {hermesAgentsStore.specs.get(id)?.displayName ?? id}
                  <span className="glc-picker-sub">new conversation</span>
                </button>
              ))}
              {hermesAgentsStore.loaded && hermesAgentsStore.chattableAgents.length === 0 && (
                <div className="glc-picker-sub" style={{ padding: '4px 12px' }}>No Hermes agents — create one in Settings › Agents.</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── body routes to the bound agent's engine ── */}
      {activeHermes ? (
        <div className="glc-agents-body">
          <AgentConversation key={activeHermes.cid} agentId={activeHermes.agentId} conversationId={activeHermes.cid} />
        </div>
      ) : !activeSessionId ? (
        <div className="glc-empty">
          <button className="glc-empty-add" onClick={() => { setPickerOpen(true); void hermesAgentsStore.refresh() }}>
            <Plus size={16} /> New chat
          </button>
          <span>Pick an agent to start — the AI-Lab assistant or any Hermes agent.</span>
        </div>
      ) : (
        <ChatPanel
          store={store}
          panelId="global-chat"
          sessionIds={sessionIds}
          activeSessionId={activeSessionId}
          onSelectSession={(id) => pick(`session:${id}`)}
          onRequestCloseTabs={(ids) => ids.forEach(closeSessionTab)}
          onLayoutHeaderContextMenu={undefined}
          hideTabBar
        />
      )}

      {showHistory && <ChatHistoryPanel store={store} onClose={() => setShowHistory(false)} />}
    </div>
  )
})
