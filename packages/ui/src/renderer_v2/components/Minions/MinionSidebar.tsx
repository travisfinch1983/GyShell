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
  Globe,
  ScrollText,
  Hammer,
  Bug,
} from 'lucide-react'
import { MinionStore } from '../../stores/MinionStore'
import type { MinionCard } from '../../stores/MinionStore'
import type { AppStore } from '../../stores/AppStore'
import './MinionSidebar.scss'

interface MinionSidebarProps {
  store: MinionStore
  appStore: AppStore
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

/** Pick a per-agent icon. Falls back to a generic Bot. */
function iconForAgent(name: string): React.FC<any> {
  const n = name.toLowerCase()
  if (n.includes('research')) return Globe
  if (n.includes('plan')) return ScrollText
  if (n.includes('cod')) return Hammer
  if (n.includes('debug')) return Bug
  if (n.includes('explor')) return Search
  return Bot
}

/**
 * One agent shortcut. Click sends a placeholder direct-route signal to the
 * chat (full delegate-direct wiring lands once the chat-window adaptation is
 * in). Badge in the corner shows how many invocations of this agent are
 * currently in flight — populated from the in-process pool exposed by the
 * backend (Phase B once the WS event surface is added).
 */
const AgentIcon: React.FC<{ name: string; activeCount: number; onClick: () => void }> = ({
  name,
  activeCount,
  onClick,
}) => {
  const Icon = iconForAgent(name)
  return (
    <button
      className="collapsed-minion-icon"
      onClick={onClick}
      title={`${name}${activeCount > 0 ? ` — ${activeCount} in flight` : ''}`}
    >
      <Icon size={14} />
      {activeCount > 0 && (
        <span
          className="collapsed-status-dot"
          style={{
            backgroundColor: 'var(--minion-active, #3b82f6)',
            // Reuse the existing badge dot styling but show the count instead
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
    </button>
  )
}

/**
 * Resolve the active profile's chat + coder model items so we can show them
 * as direct-message shortcuts. Falls back to the global model when chat or
 * coder isn't explicitly assigned.
 */
function useActiveProfileModels(appStore: AppStore) {
  const profiles = appStore.settings?.models?.profiles ?? []
  const items = appStore.settings?.models?.items ?? []
  const activeId = appStore.settings?.models?.activeProfileId
  const profile = profiles.find((p) => p.id === activeId) ?? profiles[0]
  if (!profile) return { chat: null as any, coder: null as any }
  const findItem = (id?: string) => (id ? items.find((m) => m.id === id) ?? null : null)
  const chat = findItem((profile as any).chatModelId) || findItem(profile.globalModelId)
  const coder = findItem((profile as any).coderModelId) || findItem(profile.globalModelId)
  return { chat, coder }
}

export const MinionSidebar = observer(({ store, appStore }: MinionSidebarProps) => {
  // Sort minions: selectable first (matches MinionCards' ordering).
  const minions = [...store.minionList].sort((a, b) => {
    const aSelectable = MinionStore.selectableRoles.has(a.role) ? 0 : 1
    const bSelectable = MinionStore.selectableRoles.has(b.role) ? 0 : 1
    return aSelectable - bSelectable
  })

  const { chat, coder } = useActiveProfileModels(appStore)
  const agents = appStore.agents ?? []

  // Click handlers — wiring of the actual direct-route message dispatch comes
  // with the chat-window adaptation. For now we set a hint on the chat store
  // that the next message should be routed directly to this model.
  const directRoute = (modelId: string | undefined, label: string) => {
    if (!modelId) return
    const chatStore = (appStore as any).chat
    if (chatStore) {
      // Tag the next outgoing message — the chat send path will read this
      // and override its routing once that adaptation is wired.
      ;(chatStore as any).nextDirectRouteModelId = modelId
      ;(chatStore as any).nextDirectRouteLabel = label
    }
    // eslint-disable-next-line no-console
    console.log(`[MinionSidebar] Next message will route directly to ${label} (${modelId})`)
  }

  const focusAgent = (agentName: string) => {
    const chatStore = (appStore as any).chat
    if (chatStore) {
      ;(chatStore as any).nextDirectAgentName = agentName
    }
    // eslint-disable-next-line no-console
    console.log(`[MinionSidebar] Next message will be delegated to agent "${agentName}"`)
  }

  return (
    <div className="minion-sidebar collapsed-sidebar">
      <button
        className={`collapsed-vision-toggle ${store.visionEnabled ? 'active' : ''}`}
        onClick={() => store.toggleVision()}
        title={store.visionEnabled ? 'Vision ON' : 'Vision OFF'}
      >
        <Eye size={14} />
      </button>

      {/* Models — click to force the next message directly at that model
          (skips agent routing). Two slots: chat + coder, populated from the
          active profile's role assignments. */}
      <div className="collapsed-icons-list" style={{ marginTop: 6 }}>
        {chat && (
          <button
            className="collapsed-minion-icon selectable"
            onClick={() => directRoute(chat.id, chat.name || chat.model)}
            title={`Chat model — ${chat.name || chat.model} (click to route next message directly)`}
          >
            <MessageCircle size={14} />
          </button>
        )}
        {coder && coder.id !== chat?.id && (
          <button
            className="collapsed-minion-icon selectable"
            onClick={() => directRoute(coder.id, coder.name || coder.model)}
            title={`Coder model — ${coder.name || coder.model} (click to route next message directly)`}
          >
            <Code size={14} />
          </button>
        )}
      </div>

      {/* Agents — click to delegate the next message to that specific agent.
          Badge count shows how many invocations are currently in flight (Phase B
          once the pool exposes per-agent counters via WS events; for now it's
          always 0 and the badge is hidden). */}
      {agents.length > 0 && (
        <div className="collapsed-icons-list" style={{ marginTop: 4 }}>
          {agents.map((a) => (
            <AgentIcon
              key={a.id}
              name={a.name}
              activeCount={0}
              onClick={() => focusAgent(a.name)}
            />
          ))}
        </div>
      )}

      {/* Minion-army members (existing). Kept as a third row so the user can
          still see/select remote minions even with the chat overlay closed. */}
      {minions.length > 0 && (
        <div className="collapsed-icons-list" style={{ marginTop: 4 }}>
          {minions.map((card) => (
            <CollapsedMinionIcon key={card.id} card={card} store={store} />
          ))}
        </div>
      )}

      <ActivityPulse store={store} />
    </div>
  )
})
