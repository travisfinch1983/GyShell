import React, { useEffect, useMemo } from 'react'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import { ChatPanel } from '../Chat/ChatPanel'
import './globalChat.scss'

interface Props {
  store: AppStore
  /** When true (sidebar expanded), the chat is shown overlaying the tab content. */
  visible: boolean
}

/**
 * Single-session global chat overlay. Shown whenever the model sidebar is
 * expanded; hidden when collapsed. Overlays the active tab's content with
 * a semi-transparent backdrop so the user can keep referencing what's
 * underneath while typing.
 *
 * Multi-session controls inside ChatPanel are still present but unused —
 * the global panel always renders the first session in store.chat.sessions
 * and routes selection back to the same id.
 */
export const GlobalChat: React.FC<Props> = observer(({ store, visible }) => {
  // Pick a stable single session — first existing, or create one if none.
  const sessionId = useMemo(() => {
    const sessions = store.chat?.sessions || []
    if (sessions.length > 0) return sessions[0].id
    // ChatStore should auto-create on first use; fall back to a placeholder
    // string so ChatPanel doesn't get null. The first message dispatch will
    // hydrate the actual session.
    return 'global-chat-session'
  }, [store.chat?.sessions?.length])

  // Make sure the chat store knows this is the active session — ChatPanel
  // reads from activeSessionId for some menu interactions.
  useEffect(() => {
    if (!visible) return
    if (store.chat && typeof (store.chat as any).setActiveSession === 'function') {
      try { (store.chat as any).setActiveSession(sessionId) } catch {}
    }
  }, [visible, sessionId, store.chat])

  if (!visible) return null

  return (
    <div className="ai-lab-global-chat">
      <ChatPanel
        store={store}
        panelId="global-chat"
        sessionIds={[sessionId]}
        activeSessionId={sessionId}
        onSelectSession={() => { /* single-session — no-op */ }}
        onRequestCloseTabs={undefined}
        onLayoutHeaderContextMenu={undefined}
      />
    </div>
  )
})
