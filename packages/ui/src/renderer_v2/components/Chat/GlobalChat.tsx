import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import { ChatPanel } from '../Chat/ChatPanel'
import { Bot, MessagesSquare } from 'lucide-react'
import { hermesAgentsStore } from '../../stores/HermesAgentsStore'
import { AgentConversation } from '../AgentChat/AgentChatPanel'
import './globalChat.scss'

interface Props {
  store: AppStore
  /** When true (sidebar expanded), the chat is shown overlaying the tab content. */
  visible: boolean
}

/**
 * Multi-session global chat overlay. Shown whenever the model sidebar is
 * expanded; hidden when collapsed. Overlays the active tab's content with
 * a semi-transparent backdrop so the user can keep referencing what's
 * underneath while typing.
 *
 * Renders every session in store.chat.sessions as a tab in ChatPanel, with
 * tab selection / new-tab / close-tab routed back through ChatStore. The
 * synthetic panelId "global-chat" is intentionally not registered in the
 * layout tree — layout-store calls referencing it (e.g. attachTabToPanel)
 * harmlessly no-op, since this overlay manages its own tab state via
 * ChatStore.activeSessionId.
 */
export const GlobalChat: React.FC<Props> = observer(({ store, visible }) => {
  // Chat = AgentService_v2 (main chat, unchanged). Agents = Hermes fleet agents
  // over ACP streaming (AgentConversation) — tab-independent, per Travis.
  const [mode, setMode] = useState<'chat' | 'agents'>(
    () => (localStorage.getItem('ai-lab-chat-mode') as 'chat' | 'agents') || 'chat',
  )
  const [agentId, setAgentId] = useState<string | null>(null)
  const pickMode = (m: 'chat' | 'agents') => {
    setMode(m)
    localStorage.setItem('ai-lab-chat-mode', m)
  }
  useEffect(() => {
    if (!visible || mode !== 'agents') return
    void hermesAgentsStore.refresh().then(() => {
      setAgentId((a) => a ?? hermesAgentsStore.agents[0] ?? null)
    })
  }, [visible, mode])

  // Computed inline (no useMemo) on purpose: useMemo's dep array uses plain
  // JS equality, which doesn't reliably re-fire on MobX mutations. The
  // observer wrapper handles re-renders for us.
  const sessions = store.chat?.sessions || []

  // Make sure at least one session exists. ChatStore.handleUiUpdate silently
  // drops events for unknown sessionIds, so the placeholder must be a real
  // session in the store, not a synthetic id.
  if (sessions.length === 0 && store.chat && typeof store.chat.createSession === 'function') {
    try {
      store.chat.createSession('Chat')
    } catch (err) {
      console.warn('[GlobalChat] createSession failed:', err)
    }
  }

  const sessionIds = sessions.map((s) => s.id)
  const activeSessionId =
    (store.chat?.activeSessionId && sessionIds.includes(store.chat.activeSessionId)
      ? store.chat.activeSessionId
      : sessionIds[0]) || null

  // Keep ChatStore's activeSessionId in sync if it ever falls out of the list.
  useEffect(() => {
    if (!visible) return
    if (
      activeSessionId &&
      store.chat?.activeSessionId !== activeSessionId &&
      typeof store.chat?.setActiveSession === 'function'
    ) {
      try { store.chat.setActiveSession(activeSessionId) } catch {}
    }
  }, [visible, activeSessionId, store.chat])

  if (!visible) return null

  return (
    <div className="ai-lab-global-chat">
      <div className="glc-mode-row">
        <button className={`glc-mode ${mode === 'chat' ? 'active' : ''}`} onClick={() => pickMode('chat')} title="Main chat (AgentService_v2)">
          <MessagesSquare size={13} /> Chat
        </button>
        <button className={`glc-mode ${mode === 'agents' ? 'active' : ''}`} onClick={() => pickMode('agents')} title="Hermes fleet agents (live ACP stream)">
          <Bot size={13} /> Agents
        </button>
        {mode === 'agents' && (
          <select
            className="glc-agent-pick"
            value={agentId ?? ''}
            onChange={(e) => setAgentId(e.target.value || null)}
          >
            {hermesAgentsStore.agents.length === 0 && <option value="">no agents</option>}
            {hermesAgentsStore.agents.map((id) => (
              <option key={id} value={id}>{hermesAgentsStore.specs.get(id)?.displayName ?? id}</option>
            ))}
          </select>
        )}
      </div>
      {mode === 'agents' ? (
        <div className="glc-agents-body">
          {agentId ? (
            <AgentConversation key={agentId} agentId={agentId} />
          ) : (
            <div className="glc-empty">{hermesAgentsStore.loaded ? 'No Hermes agents yet — create one in Settings › Agents.' : 'Loading agents…'}</div>
          )}
        </div>
      ) : (
      <ChatPanel
        store={store}
        panelId="global-chat"
        sessionIds={sessionIds}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => {
          try { store.chat.setActiveSession(id) } catch {}
        }}
        onRequestCloseTabs={(ids) => {
          // In overlay mode, closing a tab means the user wants the session
          // gone. We always rehydrate the full session list on reload, so
          // anything we leave on disk would just reappear next refresh.
          // Use deleteChatSession (persistent) instead of closeSession
          // (in-memory only).
          for (const id of ids) {
            void store.chat.deleteChatSession(id).catch((err) => {
              console.warn('[GlobalChat] deleteChatSession failed:', id, err)
            })
          }
        }}
        onLayoutHeaderContextMenu={undefined}
      />
      )}
    </div>
  )
})
