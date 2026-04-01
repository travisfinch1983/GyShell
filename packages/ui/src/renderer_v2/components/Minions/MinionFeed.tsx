/**
 * MinionFeed — Live multi-agent message feed.
 *
 * Shows all inter-agent messages with [From → To] headers.
 * Appears as a collapsible panel below the minion cards in the sidebar.
 */

import React, { useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import type { MinionStore, MinionMessage, MessageType } from '../../stores/MinionStore'
import './MinionFeed.scss'

interface MinionFeedProps {
  store: MinionStore
}

const senderColors: Record<string, string> = {
  user: '#22c55e',
  system: '#6b7280',
  orchestrator: '#8b5cf6',
  coder: '#3b82f6',
  creative: '#ec4899',
  architect: '#f59e0b',
  scout: '#22c55e',
  chat: '#10b981',
}

function getSenderColor(name: string): string {
  const lower = name.toLowerCase()
  // Check direct match
  if (senderColors[lower]) return senderColors[lower]
  // Check if it contains a known role
  for (const [key, color] of Object.entries(senderColors)) {
    if (lower.includes(key)) return color
  }
  return '#64748b'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function typeIcon(type: MessageType): string {
  switch (type) {
    case 'forward': return '↗'
    case 'summary': return '📋'
    case 'tool-use': return '🔧'
    case 'system': return 'ℹ️'
    case 'status': return '•'
    default: return ''
  }
}

const FeedMessage: React.FC<{ msg: MinionMessage }> = ({ msg }) => {
  const { from, to, type, content, timestamp, toolName } = msg
  const fromColor = getSenderColor(from)
  const isSystem = type === 'system'
  const isForward = type === 'forward'

  return (
    <div className={`feed-msg ${isSystem ? 'system' : ''} ${isForward ? 'forward' : ''}`}>
      <div className="feed-msg-header">
        <span className="feed-msg-icon">{typeIcon(type)}</span>
        <span className="feed-msg-from" style={{ color: fromColor }}>
          {from === 'user' ? 'You' : from}
        </span>
        <span className="feed-msg-arrow">→</span>
        <span className="feed-msg-to">
          {to === 'user' ? 'You' : to === 'all' ? 'All' : to}
        </span>
        <span className="feed-msg-time">{formatTime(timestamp)}</span>
      </div>
      <div className={`feed-msg-body ${isForward ? 'forward' : ''}`}>
        {toolName && <span className="feed-tool-badge">{toolName}</span>}
        {content.length > 200 ? content.substring(0, 200) + '...' : content}
      </div>
    </div>
  )
}

export const MinionFeed = observer(({ store }: MinionFeedProps) => {
  const messages = store.allMessages
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = React.useState(true)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current && expanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, expanded])

  return (
    <div className="minion-feed-container">
      <div
        className="minion-feed-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="minion-feed-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="minion-feed-title">Activity Feed</span>
        {messages.length > 0 && (
          <span className="minion-feed-count">{messages.length}</span>
        )}
      </div>
      {expanded && (
        <div className="minion-feed-messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="minion-feed-empty">No activity yet</div>
          ) : (
            messages.map((msg) => (
              <FeedMessage key={msg.id} msg={msg} />
            ))
          )}
        </div>
      )}
    </div>
  )
})
