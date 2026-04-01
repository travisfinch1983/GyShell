/**
 * MinionChatBlock — Renders a multi-agent message in the chat feed.
 *
 * Three message layouts:
 * 1. User → Model: Header + full content (no collapse)
 * 2. Model → User: Header + full content + status badge (✓/✗)
 * 3. Model → Model: Header + summary + collapsed detail (expandable)
 */

import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import type { MinionMessage, MessageType } from '../../stores/MinionStore'
import './MinionChatBlock.scss'

const roleColors: Record<string, string> = {
  user: '#22c55e',
  system: '#6b7280',
  orchestrator: '#8b5cf6',
  chat: '#10b981',
  coder: '#3b82f6',
  creative: '#ec4899',
  architect: '#f59e0b',
  scout: '#22c55e',
  thinking: '#a855f7',
  compaction: '#64748b',
  action: '#6366f1',
}

function getColor(name: string): string {
  const lower = name.toLowerCase()
  if (roleColors[lower]) return roleColors[lower]
  for (const [key, color] of Object.entries(roleColors)) {
    if (lower.includes(key)) return color
  }
  return '#64748b'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function getStatusBadge(msg: MinionMessage): { icon: string; color: string; label: string } | null {
  if (msg.type === 'summary') {
    const status = msg.metadata?.status
    if (status === 'completed' || status === 'complete') {
      return { icon: '✓', color: '#22c55e', label: 'Completed' }
    }
    if (status === 'failed' || status === 'error') {
      return { icon: '✗', color: '#ef4444', label: 'Failed' }
    }
    if (status === 'needs_help') {
      return { icon: '?', color: '#f59e0b', label: 'Needs help' }
    }
    // Default for summaries — assume completed
    return { icon: '✓', color: '#22c55e', label: 'Completed' }
  }
  return null
}

function summarize(text: string, maxLen: number = 120): string {
  if (text.length <= maxLen) return text
  // Try to break at a sentence
  const truncated = text.substring(0, maxLen)
  const lastPeriod = truncated.lastIndexOf('.')
  const lastSpace = truncated.lastIndexOf(' ')
  const breakPoint = lastPeriod > maxLen * 0.5 ? lastPeriod + 1 : lastSpace > 0 ? lastSpace : maxLen
  return text.substring(0, breakPoint).trim() + '...'
}

interface MinionChatBlockProps {
  message: MinionMessage
}

export const MinionChatBlock = observer(({ message }: MinionChatBlockProps) => {
  const { from, to, type, content, timestamp } = message
  const [detailExpanded, setDetailExpanded] = useState(false)

  const fromColor = getColor(from)
  const toColor = getColor(to)
  const isFromUser = from === 'user'
  const isToUser = to === 'user'
  const isSystem = from === 'system'
  const isForward = type === 'forward'
  const isModelToModel = !isFromUser && !isToUser && !isSystem
  const statusBadge = getStatusBadge(message)

  const fromLabel = isFromUser ? 'You' : from
  const toLabel = isToUser ? 'You' : to === 'all' ? 'All' : to

  // Don't render tool-use or status messages in chat — they go to Activity Feed only
  if (type === 'tool-use' || type === 'status') return null

  // System/forward messages render as compact notices
  if (isSystem || isForward) {
    return (
      <div className="mcb-notice">
        <span className="mcb-notice-icon">{isForward ? '↗' : 'ℹ️'}</span>
        <span className="mcb-notice-text">{content}</span>
        <span className="mcb-notice-time">{formatTime(timestamp)}</span>
      </div>
    )
  }

  return (
    <div className={`mcb ${isFromUser ? 'mcb-from-user' : ''} ${isModelToModel ? 'mcb-model-to-model' : ''}`}>
      {/* Header Block */}
      <div className="mcb-header">
        <span className="mcb-from" style={{ color: fromColor }}>{fromLabel}</span>
        <span className="mcb-arrow">→</span>
        <span className="mcb-to" style={{ color: toColor }}>{toLabel}</span>
        {statusBadge && (
          <span
            className="mcb-status-badge"
            style={{ color: statusBadge.color, borderColor: statusBadge.color }}
            title={statusBadge.label}
          >
            {statusBadge.icon} {statusBadge.label}
          </span>
        )}
        <span className="mcb-time">{formatTime(timestamp)}</span>
      </div>

      {/* Content Block */}
      {isModelToModel ? (
        // Model → Model: Show summary + collapsed detail
        <>
          <div className="mcb-summary">
            {summarize(content)}
          </div>
          <div
            className="mcb-detail-toggle"
            onClick={() => setDetailExpanded(!detailExpanded)}
          >
            <span className="mcb-detail-chevron">{detailExpanded ? '▾' : '▸'}</span>
            <span className="mcb-detail-label">
              {detailExpanded ? 'Hide full message' : 'Show full message'}
            </span>
          </div>
          {detailExpanded && (
            <div className="mcb-detail">
              {content}
            </div>
          )}
        </>
      ) : (
        // User → Model or Model → User: Show full content
        <div className="mcb-content">
          {content}
        </div>
      )}
    </div>
  )
})
