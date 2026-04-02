/**
 * MinionCards — Sidebar showing model status cards.
 *
 * Displays each registered minion with:
 * - Friendly name and role badge
 * - Connection status indicator (dot)
 * - Current activity status with live updates
 * - Model name subtitle
 */

import { observer } from 'mobx-react-lite'
import { MinionStore, MinionCard, MinionStatus } from '../../stores/MinionStore'
import './MinionCards.scss'

interface MinionCardsProps {
  store: MinionStore
}

function statusColor(status: MinionStatus): string {
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

function isAnimated(status: MinionStatus): boolean {
  return status !== 'idle' && status !== 'complete' && status !== 'error' && status !== 'disconnected'
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

function MinionCardItem({ card, store }: { card: MinionCard; store: MinionStore }) {
  const label = MinionStore.statusLabel(card.status, card.statusDetail)
  const color = statusColor(card.status)
  const animated = isAnimated(card.status)
  const badgeColor = roleBadgeColors[card.role] || '#6b7280'
  const isSelectable = MinionStore.selectableRoles.has(card.role)
  const isSelected = store.isSelected(card.role)
  const isInternal = MinionStore.internalRoles.has(card.role)
  const isActive = isAnimated(card.status) // True when model is working (not idle/complete/error/disconnected)

  return (
    <div
      className={[
        'minion-card',
        card.status === 'disconnected' ? 'disconnected' : '',
        isSelected ? 'selected' : '',
        isSelectable ? 'selectable' : '',
        isInternal ? 'internal' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => isSelectable && store.toggleTarget(card.role)}
      title={isSelectable
        ? `${card.friendlyName} — Click to ${isSelected ? 'deselect' : 'message directly'}`
        : `${card.friendlyName} — ${card.modelName}`}
    >
      <div className="minion-card-header">
        <span
          className={`minion-status-dot ${animated ? 'animated' : ''}`}
          style={{ backgroundColor: color }}
        />
        <span className="minion-friendly-name">{card.friendlyName}</span>
        <span className="minion-role-badge" style={{ backgroundColor: badgeColor }}>
          {card.role}
        </span>
      </div>
      <div className="minion-card-body">
        <span className="minion-status-label" style={{ color }}>
          {label}
        </span>
        {isActive && (
          <button
            className="minion-stop-btn"
            onClick={(e) => {
              e.stopPropagation()
              const router = (window as any).__minionRouter
              if (router) router.cancelRequest(card.role)
            }}
            title={`Stop ${card.friendlyName}`}
          >
            ■
          </button>
        )}
      </div>
      <div className="minion-card-footer">
        <span className="minion-model-name">{card.modelName}</span>
      </div>
    </div>
  )
}

export const MinionCards = observer(({ store }: MinionCardsProps) => {
  // Sort: selectable cards first, then internal
  const minions = [...store.minionList].sort((a, b) => {
    const aSelectable = MinionStore.selectableRoles.has(a.role) ? 0 : 1
    const bSelectable = MinionStore.selectableRoles.has(b.role) ? 0 : 1
    return aSelectable - bSelectable
  })

  if (minions.length === 0) {
    return (
      <div className="minion-cards-empty">
        <p>No models assigned</p>
        <p className="minion-cards-hint">Configure models in Settings → Profiles</p>
      </div>
    )
  }

  const selected = store.selectedTarget
  const selectedMinion = selected ? store.getMinionByName(selected) : null

  return (
    <div className="minion-cards-container">
      <div className="minion-cards-header">
        <span className="minion-cards-title">Minion Horde</span>
        <span className="minion-cards-count">{minions.length}</span>
      </div>
      <div className="minion-routing-indicator">
        {selectedMinion ? (
          <span className="routing-direct">
            Direct → <strong>{selectedMinion.friendlyName}</strong>
            <button className="routing-clear" onClick={() => store.clearTarget()} title="Clear selection">✕</button>
          </span>
        ) : (
          <span className="routing-auto">Auto routing</span>
        )}
      </div>
      <div className="minion-cards-list">
        {minions.map((card) => (
          <MinionCardItem
            key={card.id}
            card={card}
            store={store}
          />
        ))}
      </div>
    </div>
  )
})
