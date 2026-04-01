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

function feedLabel(msg: MinionMessage): string {
  const from = msg.from === 'user' ? 'You' : msg.from
  const to = msg.to === 'user' ? 'You' : msg.to === 'all' ? 'All' : msg.to

  switch (msg.type) {
    case 'forward':
      return msg.content // Already a short label like "Routed to Coder"
    case 'tool-use':
      return `${from} used ${msg.toolName || 'tool'}`
    case 'summary':
      return `Result from ${from}`
    case 'system':
      return msg.content.length > 60 ? msg.content.substring(0, 60) + '...' : msg.content
    case 'chat':
      return `Message from ${from} to ${to}`
    default:
      return `${from} → ${to}`
  }
}

const FeedMessage: React.FC<{ msg: MinionMessage }> = ({ msg }) => {
  const { from, type, timestamp } = msg
  const icon = typeIcon(type)
  const label = feedLabel(msg)
  const isForward = type === 'forward'
  const isSystem = type === 'system'
  const color = isSystem ? '#6b7280' : getSenderColor(from)

  return (
    <div
      className={`feed-msg ${isSystem ? 'system' : ''} ${isForward ? 'forward' : ''}`}
      style={{ borderLeftColor: color }}
    >
      <span className="feed-msg-icon">{icon}</span>
      <span className="feed-msg-label" style={{ color }}>{label}</span>
      <span className="feed-msg-time">{formatTime(timestamp)}</span>
    </div>
  )
}

export const MinionFeed = observer(({ store }: MinionFeedProps) => {
  const messages = store.allMessages
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = React.useState(true)
  const [roleFilter, setRoleFilter] = React.useState<string | null>(null)

  const filteredMessages = roleFilter
    ? messages.filter((m) => {
        const lower = roleFilter.toLowerCase()
        return m.from.toLowerCase().includes(lower) ||
               m.to.toLowerCase().includes(lower) ||
               (m.metadata?.role || '').toLowerCase() === lower
      })
    : messages

  // Get unique roles that have activity
  const activeRoles = React.useMemo(() => {
    const roles = new Set<string>()
    for (const m of messages) {
      if (m.from !== 'user' && m.from !== 'system') roles.add(m.from)
      if (m.to !== 'user' && m.to !== 'all') roles.add(m.to)
    }
    return Array.from(roles)
  }, [messages.length])

  useEffect(() => {
    if (scrollRef.current && expanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filteredMessages.length, expanded])

  return (
    <div className="minion-feed-container">
      <div
        className="minion-feed-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="minion-feed-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="minion-feed-title">Activity Feed</span>
        {messages.length > 0 && (
          <span className="minion-feed-count">{filteredMessages.length}</span>
        )}
      </div>
      {expanded && activeRoles.length > 0 && (
        <div className="minion-feed-filters">
          <button
            className={`feed-filter-btn ${roleFilter === null ? 'active' : ''}`}
            onClick={() => setRoleFilter(null)}
          >All</button>
          {activeRoles.map((role) => (
            <button
              key={role}
              className={`feed-filter-btn ${roleFilter === role ? 'active' : ''}`}
              style={{
                borderColor: roleFilter === role ? getSenderColor(role) : undefined,
                color: getSenderColor(role),
              }}
              onClick={() => setRoleFilter(roleFilter === role ? null : role)}
            >{role}</button>
          ))}
        </div>
      )}
      {expanded && (
        <div className="minion-feed-messages" ref={scrollRef}>
          {filteredMessages.length === 0 ? (
            <div className="minion-feed-empty">
              {roleFilter ? `No activity for ${roleFilter}` : 'No activity yet'}
            </div>
          ) : (
            filteredMessages.map((msg) => (
              <FeedMessage key={msg.id} msg={msg} />
            ))
          )}
        </div>
      )}
    </div>
  )
})
