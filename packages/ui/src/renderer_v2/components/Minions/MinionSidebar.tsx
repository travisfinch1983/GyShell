/**
 * MinionSidebar — Always-collapsed icon strip showing minion-army members,
 * the active profile's chat/coder models, and the configured agent set.
 *
 * The previous resizable-with-feed design was retired: the chat overlay now
 * controls its own visibility separately, so the sidebar's role is just the
 * icon strip with status badges.
 */

import React, { useRef, useState, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import {
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
  MessageSquare,
  Server,
} from 'lucide-react'
import { MinionStore } from '../../stores/MinionStore'
import type { MinionCard } from '../../stores/MinionStore'
import type { AppStore } from '../../stores/AppStore'
import { resolveAgentIcon } from '../../lib/agentIcons'
import { aiServicesStore } from '../../stores/AiServicesStore'
import './MinionSidebar.scss'

interface MinionSidebarProps {
  store: MinionStore
  appStore: AppStore
  /** Whether the global chat overlay is currently visible. */
  chatOpen: boolean
  /** Toggle the chat overlay open/closed. */
  onChatToggle: () => void
  /** Whether the global running-services drawer is visible. */
  servicesOpen: boolean
  /** Toggle the services drawer open/closed. */
  onServicesToggle: () => void
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

/**
 * One agent indicator in the sidebar — not a button, just an informational
 * icon plus an optional in-flight count badge. Rendered as a div with no
 * hover effect or click handler; the icon stroke color is set explicitly
 * via a CSS variable so it adapts to dark / light themes (matches the
 * rest of the UI's text color).
 */
const AgentIcon: React.FC<{
  name: string
  iconName: string | undefined
  activeCount: number
}> = ({ name, iconName, activeCount }) => {
  const Icon = resolveAgentIcon(iconName)
  return (
    <div
      className="collapsed-minion-icon"
      title={`${name}${activeCount > 0 ? ` — ${activeCount} in flight` : ''}`}
      style={{ color: 'var(--text-primary)', cursor: 'default' }}
    >
      <Icon size={14} strokeWidth={1.75} />
      {activeCount > 0 && (
        <span
          className="collapsed-status-dot"
          style={{
            backgroundColor: 'var(--accent, #3b82f6)',
            width: 12,
            height: 12,
            fontSize: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            fontWeight: 700,
          }}
        >
          {activeCount}
        </span>
      )}
    </div>
  )
}

export const MinionSidebar = observer(({ store, appStore, chatOpen, onChatToggle, servicesOpen, onServicesToggle }: MinionSidebarProps) => {
  // Now that the per-role model architecture is retired (chat + coder are
  // the only direct-target roles), filter the legacy minion list down to
  // those two roles. Drops orchestrator / thinking / compaction / action /
  // creative / architect / scout shortcuts that the UI used to surface but
  // that no longer correspond to user-targetable models.
  const targetableRoles = new Set(['chat', 'coder'])
  const minions = [...store.minionList]
    .filter((m) => targetableRoles.has(m.role))
    .sort((a, b) => (a.role === 'chat' ? -1 : b.role === 'chat' ? 1 : 0))

  // Configured agents — filtered by the per-agent showInSidebar flag so the
  // user can hide agents they rarely use without deleting them.
  const agents = (appStore.agents ?? []).filter((a) => a.showInSidebar !== false)

  // One-time load so the services-count badge is populated even before the drawer opens.
  useEffect(() => {
    if (!aiServicesStore.loaded) void aiServicesStore.load()
  }, [])
  const serviceCount = aiServicesStore.services.length

  return (
    <div className="minion-sidebar collapsed-sidebar">
      {/* Chat-overlay toggle — lives at the very top of the strip (above
          the vision toggle) since this strip never auto-collapses, unlike
          the PrimarySidebar where this button used to live. The 24px gap
          below the model icons row visually separates the "controls" zone
          (chat toggle + vision toggle) from the "configured items" zone
          (model shortcuts + agents) so the eye doesn't merge them. */}
      <button
        className={`collapsed-vision-toggle ${chatOpen ? 'active' : ''}`}
        onClick={onChatToggle}
        title={chatOpen ? 'Close chat' : 'Open chat'}
        style={{ color: 'var(--text-primary)' }}
      >
        <MessageSquare size={14} />
      </button>

      <button
        className={`collapsed-vision-toggle ${servicesOpen ? 'active' : ''}`}
        onClick={onServicesToggle}
        title={servicesOpen ? 'Close services' : `Open running services${serviceCount ? ` (${serviceCount})` : ''}`}
        style={{ color: 'var(--text-primary)', position: 'relative' }}
      >
        <Server size={14} />
        {serviceCount > 0 && (
          <span
            style={{
              position: 'absolute', top: -3, right: -3, minWidth: 14, height: 14, padding: '0 3px',
              borderRadius: 7, background: 'var(--accent)', color: '#06121f', fontSize: 9, fontWeight: 700,
              lineHeight: '14px', textAlign: 'center',
            }}
          >
            {serviceCount}
          </span>
        )}
      </button>

      <button
        className={`collapsed-vision-toggle ${store.visionEnabled ? 'active' : ''}`}
        onClick={() => store.toggleVision()}
        title={store.visionEnabled ? 'Vision ON' : 'Vision OFF'}
      >
        <Eye size={14} />
      </button>

      {/* Top row — chat + coder model shortcuts. Click to force the next
          message directly at that model (skips agent routing). The 24px
          top-margin separates this row from the controls zone above. */}
      {minions.length > 0 && (
        <div className="collapsed-icons-list" style={{ marginTop: 24 }}>
          {minions.map((card) => (
            <CollapsedMinionIcon key={card.id} card={card} store={store} />
          ))}
        </div>
      )}

      {/* Below the role models — configured agents. Each agent's per-agent
          icon (set in Settings → Agents) is shown so the strip stays tied
          to whatever the user has configured rather than hard-coded names.
          Badge counts show how many invocations are currently in flight
          (wire-up to the agent pool's per-agent counters lands once the WS
          event surface is added; currently always 0 / badge hidden). */}
      {agents.length > 0 && (
        <div className="collapsed-icons-list" style={{ marginTop: 4 }}>
          {agents.map((a) => (
            <AgentIcon
              key={a.id}
              name={a.name}
              iconName={a.icon}
              activeCount={appStore.agentActiveCounts[a.id] || 0}
            />
          ))}
        </div>
      )}

      <ActivityPulse store={store} />
    </div>
  )
})
