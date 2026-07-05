import { HermesManagementService } from './HermesManagementService'
import { HermesAcpBridge, type AcpEvent, type AcpHistory } from './HermesAcpBridge'
import type { HermesAgentSpec } from '@gyshell/shared'

export interface HermesServiceConfig {
  host: string // CT158
  sshKeyPath: string // AI-Lab key authorized on CT158
  /** JSON file where applied specs are persisted (for read-back / edit). */
  specsFile?: string
  /** JSON file where Provider Services entries (keyed non-model providers) are persisted. */
  providerServicesFile?: string
}

/**
 * HermesService — facade over the two backend-owned Hermes services (control plane):
 *   - HermesManagementService: create/configure/delete agent PROFILES (SSH + CLIs).
 *   - HermesAcpBridge: persistent, backend-owned ACP session runner (headless invariant).
 *
 * Adds `runTurn` (prompt → collect the assistant reply → resolve), used by both the HTTP
 * prompt route and (next increment) the ConversationBus autonomous subscriber. Streaming
 * observers use `bridge.onEvent` directly (SSE/WS). Everything here is server-side; a
 * browser is never required for an agent to run or be driven.
 */
export class HermesService {
  readonly mgmt: HermesManagementService
  readonly bridge: HermesAcpBridge

  constructor(cfg: HermesServiceConfig) {
    this.mgmt = new HermesManagementService({ host: cfg.host, sshKeyPath: cfg.sshKeyPath, specsFile: cfg.specsFile, providerServicesFile: cfg.providerServicesFile })
    this.bridge = new HermesAcpBridge({ host: cfg.host, sshKeyPath: cfg.sshKeyPath })
  }

  listAgents(): Promise<string[]> {
    return this.mgmt.listAgents()
  }

  /** The persisted spec for an agent, or undefined (never applied through AI-Lab). */
  getSpec(agentId: string): HermesAgentSpec | undefined {
    return this.mgmt.getSpec(agentId)
  }

  applySpec(spec: HermesAgentSpec): Promise<{ created: boolean; home: string }> {
    return this.mgmt.applySpec(spec)
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.bridge.stopSession(agentId)
    await this.mgmt.deleteAgent(agentId)
  }

  /** Ensure a live session and return its `ready` event (models/modes/commands).
   *  `sessionKey` scopes the session (a per-conversation id for chat tabs); defaults to
   *  the agentId (one-session-per-agent, e.g. the bus subscriber). */
  ensureReady(agentId: string, sessionKey: string = agentId): Promise<AcpEvent> {
    return this.bridge.ensureReady(sessionKey, agentId)
  }

  /** Subscribe to a session's normalized event stream (for SSE/WS observers). */
  onEvent(sessionKey: string, cb: (ev: AcpEvent) => void): () => void {
    return this.bridge.onEvent(sessionKey, cb)
  }

  /** End + WIPE a session (kill the backend process, drop its transcript). Used when a
   *  chat tab is closed so a same-agent reopen starts a brand-new conversation. */
  stopSession(sessionKey: string): void {
    this.bridge.stopSession(sessionKey)
  }

  /**
   * Buffered transcript for a live session (read-back on reload). `since` returns only the
   * events after that seq. undefined if the backend-owned session isn't running (nothing
   * buffered — the transcript's lifetime is the session's, per the headless invariant).
   */
  getHistory(sessionKey: string, since = 0): AcpHistory | undefined {
    return this.bridge.getHistory(sessionKey, since)
  }

  /**
   * Drive one turn and resolve with the assembled assistant reply. Ensures the session,
   * prompts, collects `message` chunks until `turn_done`. Used by the HTTP prompt route
   * and the (deferred) bus subscriber.
   */
  async runTurn(agentId: string, text: string, opts: { timeoutMs?: number; context?: string; screenshot?: string; sessionKey?: string } = {}): Promise<{ reply: string; stopReason?: string }> {
    const key = opts.sessionKey ?? agentId
    await this.bridge.ensureReady(key, agentId)
    const parts: string[] = []
    return new Promise<{ reply: string; stopReason?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`hermes runTurn timeout for ${agentId}`)) }, opts.timeoutMs ?? 240_000)
      const off = this.bridge.onEvent(key, (ev) => {
        if (ev.t === 'message') {
          parts.push(String((ev as { text?: unknown }).text ?? ''))
        } else if (ev.t === 'turn_done') {
          clearTimeout(timer); off()
          resolve({ reply: parts.join(''), stopReason: (ev as { stop_reason?: string }).stop_reason })
        } else if (ev.t === 'error') {
          clearTimeout(timer); off()
          reject(new Error(String((ev as { message?: unknown }).message ?? 'hermes acp error')))
        }
      })
      try {
        this.bridge.prompt(key, text, { context: opts.context, screenshot: opts.screenshot })
      } catch (e) {
        clearTimeout(timer); off(); reject(e as Error)
      }
    })
  }

  dispose(): void {
    this.bridge.disposeAll()
  }
}
