/**
 * MinionSidebar — Resizable panel containing model cards and activity feed
 * with a draggable divider, collapsible feed, and full sidebar collapse.
 *
 * When collapsed, shows a thin icon strip with role icons and an activity pulse.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import {
  PanelLeftClose,
  PanelLeftOpen,
  Brain,
  MessageCircle,
  Code,
  Palette,
  Blocks,
  Search,
  Zap,
  Lightbulb,
  Layers,
  Bot,
  Eye,
} from 'lucide-react'
import { MinionStore } from '../../stores/MinionStore'
import type { MinionCard } from '../../stores/MinionStore'
import { MinionCards } from './MinionCards'
import { MinionFeed } from './MinionFeed'
import './MinionSidebar.scss'

interface MinionSidebarProps {
  store: MinionStore
  collapsed: boolean
  onToggleCollapse: () => void
}

/** Map role names to lucide icons */
const roleIcons: Record<string, React.FC<any>> = {
  orchestrator: Brain,
  chat: MessageCircle,
  coder: Code,
  creative: Palette,
  architect: Blocks,
  scout: Search,
  action: Zap,
  thinking: Lightbulb,
  compaction: Layers,
}

const roleBadgeColors: Record<string, string> = {
  orchestrator: '#8b5cf6',
  chat: '#10b981',
  coder: '#3b82f6',
  creative: '#ec4899',
  architect: '#e0a832',
  scout: '#a855f7',
  action: '#6366f1',
  thinking: '#c084fc',
  compaction: '#64748b',
}

function statusColor(status: string): string {
  switch (status) {
    case 'idle': return 'var(--minion-idle, #6b7280)'
    case 'complete': return 'var(--minion-complete, #22c55e)'
    case 'error': return 'var(--minion-error, #ef4444)'
    case 'disconnected': return 'var(--minion-disconnected, #9ca3af)'
    case 'thinking':
    case 'planning':
    case 'analyzing':
      return 'var(--minion-thinking, #8b5cf6)'
    case 'generating':
    case 'writing-file':
    case 'editing-file':
    case 'running-command':
      return 'var(--minion-active, #3b82f6)'
    default:
      return 'var(--minion-working, #f59e0b)'
  }
}

function isAnimated(status: string): boolean {
  return status !== 'idle' && status !== 'complete' && status !== 'error' && status !== 'disconnected'
}

/** Collapsed icon for a single minion */
const CollapsedMinionIcon: React.FC<{
  card: MinionCard
  store: MinionStore
}> = observer(({ card, store }) => {
  const Icon = roleIcons[card.role] || Bot
  const color = roleBadgeColors[card.role] || '#6b7280'
  const dotColor = statusColor(card.status)
  const animated = isAnimated(card.status)
  const isSelectable = MinionStore.selectableRoles.has(card.role)
  const isSelected = store.isSelected(card.role)

  return (
    <div
      className={`collapsed-minion-icon ${isSelected ? 'selected' : ''} ${isSelectable ? 'selectable' : ''}`}
      onClick={() => isSelectable && store.toggleTarget(card.role)}
      title={`${card.friendlyName} — ${card.status}`}
    >
      <Icon size={16} color={color} />
      <span
        className={`collapsed-status-dot ${animated ? 'animated' : ''}`}
        style={{ backgroundColor: dotColor }}
      />
    </div>
  )
})

/** Activity pulse indicator that flashes with feed entry colors */
const ActivityPulse = observer(({ store }: { store: MinionStore }) => {
  const [pulseColor, setPulseColor] = useState<string | null>(null)
  const [pulseActive, setPulseActive] = useState(false)
  const lastCountRef = useRef(store.allMessages.length)

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

  useEffect(() => {
    const currentCount = store.allMessages.length
    if (currentCount > lastCountRef.current) {
      const latest = store.allMessages[currentCount - 1]
      if (latest) {
        const from = latest.from.toLowerCase()
        let color = senderColors[from] || '#64748b'
        for (const [key, c] of Object.entries(senderColors)) {
          if (from.includes(key)) { color = c; break }
        }
        setPulseColor(color)
        setPulseActive(true)
        const timer = setTimeout(() => setPulseActive(false), 1500)
        return () => clearTimeout(timer)
      }
    }
    lastCountRef.current = currentCount
  }, [store.allMessages.length])

  return (
    <div className="collapsed-activity-pulse-container">
      <div
        className={`collapsed-activity-pulse ${pulseActive ? 'active' : ''}`}
        style={pulseColor ? { backgroundColor: pulseColor, boxShadow: `0 0 8px ${pulseColor}` } : {}}
        title="Activity"
      />
    </div>
  )
})

export const MinionSidebar = observer(({ store, collapsed, onToggleCollapse }: MinionSidebarProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [feedHeight, setFeedHeight] = useState(200)
  const [feedExpanded, setFeedExpanded] = useState(true)
  const [dragging, setDragging] = useState(false)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(0)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    dragStartY.current = e.clientY
    dragStartHeight.current = feedHeight

    const onMouseMove = (ev: MouseEvent) => {
      const delta = dragStartY.current - ev.clientY
      const newHeight = Math.max(60, Math.min(600, dragStartHeight.current + delta))
      setFeedHeight(newHeight)
    }

    const onMouseUp = () => {
      setDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [feedHeight])

  const toggleFeed = () => setFeedExpanded(!feedExpanded)

  // Sort minions same as MinionCards: selectable first
  const minions = [...store.minionList].sort((a, b) => {
    const aSelectable = MinionStore.selectableRoles.has(a.role) ? 0 : 1
    const bSelectable = MinionStore.selectableRoles.has(b.role) ? 0 : 1
    return aSelectable - bSelectable
  })

  // ─── Collapsed mode ─────────────────────────────────────────────
  if (collapsed) {
    return (
      <div className="minion-sidebar collapsed-sidebar" ref={containerRef}>
        <button
          className="sidebar-collapse-toggle"
          onClick={onToggleCollapse}
          title="Expand sidebar"
        >
          <PanelLeftOpen size={14} />
        </button>

        <button
          className={`collapsed-vision-toggle ${store.visionEnabled ? 'active' : ''}`}
          onClick={() => store.toggleVision()}
          title={store.visionEnabled ? 'Vision ON' : 'Vision OFF'}
        >
          <Eye size={14} />
        </button>

        <div className="collapsed-icons-list">
          {minions.map((card) => (
            <CollapsedMinionIcon key={card.id} card={card} store={store} />
          ))}
        </div>

        <ActivityPulse store={store} />
      </div>
    )
  }

  // ─── Expanded mode ──────────────────────────────────────────────
  return (
    <div className="minion-sidebar" ref={containerRef}>
      <div className="sidebar-collapse-header">
        <button
          className={`vision-toggle-btn ${store.visionEnabled ? 'active' : ''}`}
          onClick={() => store.toggleVision()}
          title={store.visionEnabled ? 'Vision ON — UI screenshots sent with messages' : 'Enable vision — send UI screenshots to models'}
        >
          <Eye size={13} />
          <span className="vision-toggle-label">Vision</span>
        </button>
        <button
          className="sidebar-collapse-toggle"
          onClick={onToggleCollapse}
          title="Collapse sidebar"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      <div className="minion-sidebar-cards" style={feedExpanded ? { flex: `1 1 0`, minHeight: 80 } : { flex: 1 }}>
        <MinionCards store={store} />
      </div>

      {feedExpanded && (
        <div
          className={`minion-sidebar-divider ${dragging ? 'active' : ''}`}
          onMouseDown={onDragStart}
        >
          <div className="minion-divider-grip" />
        </div>
      )}

      <div
        className={`minion-sidebar-feed ${feedExpanded ? '' : 'collapsed'}`}
        style={feedExpanded ? { height: feedHeight, minHeight: 60 } : {}}
      >
        <div className="minion-feed-toggle" onClick={toggleFeed}>
          <span className="minion-feed-toggle-chevron">{feedExpanded ? '▾' : '▴'}</span>
          <span className="minion-feed-toggle-label">Activity</span>
          <span className="minion-feed-toggle-count">
            {store.allMessages.length || ''}
          </span>
        </div>
        {feedExpanded && (
          <div className="minion-sidebar-feed-content">
            <MinionFeed store={store} />
          </div>
        )}
      </div>
    </div>
  )
})
