/**
 * MinionChatMessage — Renders a single message in the multi-agent chat feed.
 *
 * Each message has a header showing [From → To] with color-coded sender/recipient,
 * and the message body with type-appropriate styling.
 */

import { observer } from 'mobx-react-lite'
import type { MinionMessage, MessageType } from '../../stores/MinionStore'
import './MinionChatMessage.scss'

const senderColors: Record<string, string> = {
  user: '#22c55e',
  system: '#6b7280',
  orchestrator: '#8b5cf6',
  coder: '#3b82f6',
  creative: '#ec4899',
  architect: '#f59e0b',
  scout: '#22c55e',
}

function getSenderColor(name: string): string {
  const lower = name.toLowerCase()
  return senderColors[lower] || '#64748b'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function typeIcon(type: MessageType): string {
  switch (type) {
    case 'forward': return '↗'
    case 'summary': return '📋'
    case 'tool-use': return '🔧'
    case 'system': return 'ℹ'
    case 'status': return '•'
    default: return ''
  }
}

interface MinionChatMessageProps {
  message: MinionMessage
}

export const MinionChatMessage = observer(({ message }: MinionChatMessageProps) => {
  const { from, to, type, content, timestamp, toolName } = message
  const fromColor = getSenderColor(from)
  const toColor = getSenderColor(to)
  const icon = typeIcon(type)
  const isFromUser = from === 'user'
  const isSystem = from === 'system'
  const isForward = type === 'forward'

  return (
    <div className={`minion-chat-msg type-${type} ${isFromUser ? 'from-user' : ''} ${isSystem ? 'system-msg' : ''}`}>
      <div className="minion-msg-header">
        {icon && <span className="minion-msg-icon">{icon}</span>}
        <span className="minion-msg-sender" style={{ color: fromColor }}>
          {from === 'user' ? 'You' : from}
        </span>
        <span className="minion-msg-arrow">→</span>
        <span className="minion-msg-recipient" style={{ color: toColor }}>
          {to === 'user' ? 'You' : to === 'all' ? 'All' : to}
        </span>
        <span className="minion-msg-time">{formatTime(timestamp)}</span>
      </div>
      <div className={`minion-msg-body ${isForward ? 'forward' : ''}`}>
        {toolName && <span className="minion-msg-tool-badge">{toolName}</span>}
        <span className="minion-msg-content">{content}</span>
      </div>
    </div>
  )
})
