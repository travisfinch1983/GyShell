/**
 * MinionChatOverlay — Renders minion messages inline in the chat area.
 *
 * This component sits at the bottom of the chat panel and shows
 * specialist messages that flow through the MinionStore.
 * It auto-scrolls to show new messages as they arrive.
 */

import React, { useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useMinionStore } from '../../stores/MinionContext'
import { MinionChatBlock } from './MinionChatBlock'
import './MinionChatOverlay.scss'

export const MinionChatOverlay = observer(() => {
  let store: ReturnType<typeof useMinionStore> | null = null
  try {
    store = useMinionStore()
  } catch {
    return null
  }
  if (!store) return null

  const messages = store.allMessages.filter(
    (m) => m.type !== 'tool-use' && m.type !== 'status'
  )

  if (messages.length === 0) return null

  return <MinionChatOverlayInner messages={messages} />
})

const MinionChatOverlayInner = observer(({ messages }: { messages: any[] }) => {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length])

  return (
    <div className="minion-chat-overlay" ref={scrollRef}>
      <div className="minion-chat-overlay-label">
        <span className="minion-chat-overlay-dot" />
        Specialist Activity
      </div>
      {messages.map((msg) => (
        <MinionChatBlock key={msg.id} message={msg} />
      ))}
    </div>
  )
})
