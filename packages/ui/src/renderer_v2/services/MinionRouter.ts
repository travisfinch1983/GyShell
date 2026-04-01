/**
 * MinionRouter — Routes messages to specialist models via the minion infrastructure.
 *
 * When a specialist card is selected, messages bypass GyShell's native agent
 * and go through the minion orchestrator API or directly to the specialist relay.
 */

import type { MinionStore } from '../stores/MinionStore'

/**
 * Inject a message into the GyShell chat feed by synthesizing a ChatStore message.
 * Uses the AppStore's chat.handleUiUpdate to add messages inline with native chat.
 */
const MINION_CHAT_STORAGE_KEY = 'gyshell-minion-chat-messages'
const MAX_STORED_MESSAGES = 200

interface StoredChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  type: string
  content: string
  timestamp: number
  metadata?: Record<string, any>
  sessionId?: string
}

function injectChatMessage(role: 'user' | 'assistant' | 'system', content: string, metadata?: Record<string, any>) {
  const appStore = (window as any).__appStore
  if (!appStore?.chat) return
  // Use the active session, not just the first one
  const session = appStore.chat.activeSession || appStore.chat.sessions?.[0]
  if (!session) return

  const msgId = `minion-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
  const message = {
    id: msgId,
    role,
    type: role === 'system' ? 'alert' : 'text',
    content,
    timestamp: Date.now(),
    metadata,
  }

  appStore.chat.handleUiUpdate({
    type: 'ADD_MESSAGE',
    sessionId: session.id,
    message,
  })

  // Persist to localStorage for survival across refreshes
  persistMinionMessage({ ...message, sessionId: session.id })
}

function persistMinionMessage(msg: StoredChatMessage) {
  try {
    const stored = JSON.parse(localStorage.getItem(MINION_CHAT_STORAGE_KEY) || '[]')
    stored.push(msg)
    if (stored.length > MAX_STORED_MESSAGES) stored.splice(0, stored.length - MAX_STORED_MESSAGES)
    localStorage.setItem(MINION_CHAT_STORAGE_KEY, JSON.stringify(stored))
  } catch {}
}

/**
 * Re-inject persisted minion messages after page reload.
 * Call this after the ChatStore has hydrated its sessions.
 */
export function rehydrateMinionMessages() {
  try {
    const stored: StoredChatMessage[] = JSON.parse(localStorage.getItem(MINION_CHAT_STORAGE_KEY) || '[]')
    if (!stored.length) return

    const appStore = (window as any).__appStore
    if (!appStore?.chat) return

    for (const msg of stored) {
      const session = appStore.chat.sessions?.find((s: any) => s.id === msg.sessionId)
      if (!session) continue
      // Only inject if not already present
      if (session.messagesById?.has(msg.id)) continue

      // Backfill metadata.modelName for old messages that were persisted without it
      let metadata = msg.metadata || {}
      if (!metadata.modelName && msg.role === 'assistant' && msg.id?.startsWith('minion-')) {
        // Try to extract model name from content header like [minion-coder ✓ Completed]
        const match = msg.content?.match(/\[([^\s\]]+)\s+[✓✗?]/)
        if (match) {
          metadata = { ...metadata, modelName: match[1] }
        }
      }

      appStore.chat.handleUiUpdate({
        type: 'ADD_MESSAGE',
        sessionId: msg.sessionId,
        message: {
          id: msg.id,
          role: msg.role,
          type: msg.type,
          content: msg.content,
          timestamp: msg.timestamp,
          metadata,
        },
      })
    }
  } catch {}
}

const ORCHESTRATOR_API = 'http://10.0.0.52:6280'
const MINION_RELAY = 'http://10.0.0.52:6278'

// Poll interval for checking specialist results
const RESULT_POLL_MS = 5000
const RESULT_TIMEOUT_MS = 300000 // 5 min max wait

interface DispatchResult {
  ok: boolean
  error?: string
}

export class MinionRouter {
  private store: MinionStore
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(store: MinionStore) {
    this.store = store
    this.startResultPolling()
  }

  /**
   * Send a message directly to a specialist model via the minion relay.
   * The specialist's Claude Code instance will receive it via relay injection.
   */
  async sendToSpecialist(role: string, message: string): Promise<DispatchResult> {
    const minion = this.store.getMinionByRole(role as any)
    if (!minion) {
      return { ok: false, error: `No minion found for role: ${role}` }
    }

    // Map role to minion relay name
    const minionName = this.roleToMinionName(role)

    // Update card status
    this.store.updateMinionStatus(minion.id, 'thinking')

    // Add routing notice to activity feed
    this.store.addMessage({
      from: 'system',
      to: 'all',
      type: 'forward',
      content: `Routed to ${minion.friendlyName}`,
      metadata: { role, reason: `Direct message to ${role}` },
    })

    // Add the user's message to activity feed
    this.store.addMessage({
      from: 'user',
      to: minion.friendlyName,
      type: 'chat',
      content: message,
    })

    // Inject into main chat feed with routing header
    injectChatMessage('user', `**[Sent to ${minion.friendlyName}]**\n\n${message}`)

    try {
      const resp = await fetch(`${ORCHESTRATOR_API}/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minion: minionName,
          message: message,
        }),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Unknown error' }))
        this.store.updateMinionStatus(minion.id, 'error', err.error)
        return { ok: false, error: err.error }
      }

      return { ok: true }
    } catch (err: any) {
      this.store.updateMinionStatus(minion.id, 'error', err.message)
      return { ok: false, error: err.message }
    }
  }

  /**
   * Send a message through the orchestrator for auto-routing.
   * The orchestrator (9B) decides which specialist handles it.
   */
  async sendToOrchestrator(message: string): Promise<DispatchResult> {
    const orchestrator = this.store.getMinionByRole('orchestrator')
    if (orchestrator) {
      this.store.updateMinionStatus(orchestrator.id, 'thinking')
    }

    try {
      const resp = await fetch(`${ORCHESTRATOR_API}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: message,
          from: 'gyshell-user',
        }),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Unknown error' }))
        if (orchestrator) this.store.updateMinionStatus(orchestrator.id, 'error', err.error)
        return { ok: false, error: err.error }
      }

      const result = await resp.json()

      // Post routing decision to chat feed
      if (result.results) {
        for (const step of result.results) {
          this.store.addMessage({
            from: 'orchestrator',
            to: 'all',
            type: 'forward',
            content: `Routed to ${step.minion} — ${result.plan || 'Task dispatched'}`,
            metadata: { minion: step.minion, plan: result.plan },
          })

          // Update specialist card status
          const specialist = this.store.getMinionByName(step.minion)
          if (specialist) {
            this.store.updateMinionStatus(specialist.id, 'thinking')
          }
        }
      }

      if (orchestrator) this.store.updateMinionStatus(orchestrator.id, 'idle')
      return { ok: true }
    } catch (err: any) {
      if (orchestrator) this.store.updateMinionStatus(orchestrator.id, 'error', err.message)
      return { ok: false, error: err.message }
    }
  }

  /**
   * Poll the orchestrator for results from specialists.
   */
  private startResultPolling(): void {
    this.pollTimer = setInterval(() => this.checkResults(), RESULT_POLL_MS)
  }

  private async checkResults(): Promise<void> {
    try {
      const resp = await fetch(`${MINION_RELAY}/messages/orchestrator`)
      if (!resp.ok) return
      const data = await resp.json()
      const messages = data.messages || []

      if (messages.length === 0) return

      // Ack messages
      await fetch(`${MINION_RELAY}/messages/orchestrator/ack`, { method: 'POST' })

      for (const msg of messages) {
        const sender = msg.sender || '?'
        let content = msg.message || ''
        let resultText = content

        // Try to parse structured result
        try {
          const parsed = JSON.parse(content)
          if (parsed.type === 'result') {
            resultText = parsed.result || content
            const status = parsed.status === 'completed' ? 'complete' : 'error'
            // Update the specialist's card status
            const specialist = this.store.getMinionByName(sender)
            if (specialist) {
              this.store.updateMinionStatus(specialist.id, status === 'complete' ? 'idle' : 'error')
            }
          }
        } catch {
          // Not JSON, use raw content
        }

        // Determine status
        const parsedStatus = (() => {
          try { return JSON.parse(content).status } catch { return 'completed' }
        })()
        const statusIcon = parsedStatus === 'completed' ? '✓' : parsedStatus === 'failed' ? '✗' : '?'
        const statusLabel = parsedStatus === 'completed' ? 'Completed' : parsedStatus === 'failed' ? 'Failed' : 'Needs help'

        // Add to activity feed (compact)
        this.store.addMessage({
          from: sender,
          to: 'user',
          type: 'summary',
          content: resultText,
          metadata: { status: parsedStatus },
        })

        // Inject into main chat feed
        injectChatMessage('assistant', `**[${sender} ${statusIcon} ${statusLabel}]**\n\n${resultText}`, {
          modelName: sender,
        })
      }
    } catch {
      // Silently ignore poll errors
    }
  }

  /**
   * Map a role name to the minion relay recipient name.
   */
  private roleToMinionName(role: string): string {
    const map: Record<string, string> = {
      coder: 'minion-coder',
      creative: 'minion-creative',
      architect: 'minion-27',
      scout: 'minion-4',
      chat: 'minion-122',
      thinking: 'minion-27',
    }
    return map[role] || `minion-${role}`
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}
