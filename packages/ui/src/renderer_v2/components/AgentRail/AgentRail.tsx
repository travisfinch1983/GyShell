import React from 'react'
import { observer } from 'mobx-react-lite'
import { MessageSquare } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { resolveAgentIcon } from '../../lib/agentIcons'
import './AgentRail.scss'

interface AgentRailProps {
  appStore: AppStore
  /** Whether the global chat overlay is currently visible. */
  chatOpen: boolean
  /** Toggle the chat overlay open/closed. */
  onChatToggle: () => void
}

/**
 * One configured-agent indicator — an informational icon plus an optional
 * in-flight count badge. No click handler; the icon color adapts to the theme.
 */
const AgentIcon: React.FC<{
  name: string
  iconName: string | undefined
  activeCount: number
}> = ({ name, iconName, activeCount }) => {
  const Icon = resolveAgentIcon(iconName)
  return (
    <div
      className="agent-rail-icon"
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

/**
 * AgentRail — the always-collapsed left icon strip: the chat-overlay toggle at
 * the top, then the configured agents (each with an in-flight count badge).
 * Replaces the retired legacy sidebar; agents come from AppStore, and the old
 * model-shortcuts / vision toggle / activity feed were removed with the
 * defunct legacy system.
 */
export const AgentRail = observer(({ appStore, chatOpen, onChatToggle }: AgentRailProps) => {
  // Configured agents — filtered by the per-agent showInSidebar flag so the
  // user can hide agents they rarely use without deleting them.
  const agents = (appStore.agents ?? []).filter((a) => a.showInSidebar !== false)

  return (
    <div className="agent-rail collapsed-sidebar">
      {/* Chat-overlay toggle — lives at the very top of the strip. This rail
          never auto-collapses, unlike the PrimarySidebar where this button
          used to live, so clicking it doesn't cause expand/collapse jitter. */}
      <button
        className={`agent-rail-toggle ${chatOpen ? 'active' : ''}`}
        onClick={onChatToggle}
        title={chatOpen ? 'Close chat' : 'Open chat'}
        style={{ color: 'var(--text-primary)' }}
      >
        <MessageSquare size={14} />
      </button>

      {/* Configured agents. Each agent's per-agent icon (set in Settings →
          Agents) is shown so the strip stays tied to whatever the user has
          configured. Badge counts show invocations currently in flight. */}
      {agents.length > 0 && (
        <div className="collapsed-icons-list" style={{ marginTop: 24 }}>
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
    </div>
  )
})
