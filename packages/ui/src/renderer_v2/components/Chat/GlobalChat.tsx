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
  // Pick a stable single session — first existing, or create a real one if
  // none. The session must actually exist in store.chat.sessions, otherwise
  // ChatStore.handleUiUpdate silently drops every backend event for it (it
  // intentionally won't synthesize a session from live updates), and the
  // user's message + the model's response both vanish into the void.
  const sessionId = useMemo(() => {
    const sessions = store.chat?.sessions || []
    if (sessions.length > 0) return sessions[0].id
    if (store.chat && typeof store.chat.createSession === 'function') {
      try {
        return store.chat.createSession('Chat')
      } catch (err) {
        console.warn('[GlobalChat] createSession failed:', err)
      }
    }
    // Last-resort placeholder. With createSession in place this branch
    // shouldn't fire; if it does, the user can reload to recover.
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
