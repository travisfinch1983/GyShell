import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import { ChatPanel } from '../Chat/ChatPanel'
import { ChatHistoryPanel } from '../Chat/ChatHistoryPanel'
import { Bot, History, MessagesSquare, Plus, X } from 'lucide-react'
import { hermesAgentsStore } from '../../stores/HermesAgentsStore'
import { AgentConversation } from '../AgentChat/AgentChatPanel'
import './globalChat.scss'

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
const ACTIVE_TAB_KEY = 'ai-lab-chat-active-tab' // 'session:<id>' | 'hermes:<agentId>'

const loadHermesTabs = (): string[] => {
  try { return JSON.parse(localStorage.getItem(HERMES_TABS_KEY) ?? '[]') } catch { return [] }
}

export const GlobalChat: React.FC<Props> = observer(({ store, visible }) => {
  const [hermesTabs, setHermesTabs] = useState<string[]>(loadHermesTabs)
  const [active, setActive] = useState<string>(() => localStorage.getItem(ACTIVE_TAB_KEY) || '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)

  // Computed inline (no useMemo) on purpose: observer handles MobX re-renders.
  const sessions = store.chat?.sessions || []

  // Make sure at least one session exists (ChatStore drops events for unknown ids).
  if (sessions.length === 0 && store.chat && typeof store.chat.createSession === 'function') {
    try { store.chat.createSession('Chat') } catch (err) { console.warn('[GlobalChat] createSession failed:', err) }
  }

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
  const activeHermes = kind === 'hermes' && hermesTabs.includes(ref) ? ref : null
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
  const saveHermesTabs = (tabs: string[]) => {
    setHermesTabs(tabs)
    localStorage.setItem(HERMES_TABS_KEY, JSON.stringify(tabs))
  }

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
    if (!hermesTabs.includes(agentId)) saveHermesTabs([...hermesTabs, agentId])
    pick(`hermes:${agentId}`)
  }
  const closeHermesTab = (agentId: string) => {
    // Unmount only detaches the observer stream — the backend session lives on.
    saveHermesTabs(hermesTabs.filter((a) => a !== agentId))
    if (activeHermes === agentId) pick(sessionIds[0] ? `session:${sessionIds[0]}` : '')
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
          {hermesTabs.map((agentId) => (
            <div key={agentId} className={`glc-tab hermes ${activeHermes === agentId ? 'active' : ''}`} onClick={() => pick(`hermes:${agentId}`)}>
              <Bot size={11} />
              <span className="glc-tab-title">{hermesAgentsStore.specs.get(agentId)?.displayName ?? agentId}</span>
              <button className="glc-tab-close" onClick={(e) => { e.stopPropagation(); closeHermesTab(agentId) }}><X size={11} /></button>
            </div>
          ))}
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
              {hermesAgentsStore.agents.map((id) => (
                <button key={id} className="glc-picker-item" onClick={() => openHermesTab(id)}>
                  <Bot size={13} /> {hermesAgentsStore.specs.get(id)?.displayName ?? id}
                  <span className="glc-picker-sub">{hermesTabs.includes(id) ? 'open tab' : 'Hermes agent'}</span>
                </button>
              ))}
              {hermesAgentsStore.loaded && hermesAgentsStore.agents.length === 0 && (
                <div className="glc-picker-sub" style={{ padding: '4px 12px' }}>No Hermes agents — create one in Settings › Agents.</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── body routes to the bound agent's engine ── */}
      {activeHermes ? (
        <div className="glc-agents-body">
          <AgentConversation key={activeHermes} agentId={activeHermes} />
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
