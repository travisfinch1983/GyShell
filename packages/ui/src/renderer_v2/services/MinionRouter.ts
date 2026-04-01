/**
 * MinionRouter — Routes messages to specialist models via the minion infrastructure.
 *
 * When a specialist card is selected, messages bypass GyShell's native agent
 * and go through the minion orchestrator API or directly to the specialist relay.
 */

import type { MinionStore } from '../stores/MinionStore'

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

    // Add routing notice to chat feed
    this.store.addMessage({
      from: 'system',
      to: 'all',
      type: 'forward',
      content: `Routed to ${minion.friendlyName}`,
      metadata: { role, reason: `Direct message to ${role}` },
    })

    // Add the user's message to the chat feed
    this.store.addMessage({
      from: 'user',
      to: minion.friendlyName,
      type: 'chat',
      content: message,
    })

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

        // Add result to chat feed
        this.store.addModelToUserMessage(sender, resultText, 'summary')
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
