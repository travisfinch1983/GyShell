/**
 * MinionStore — Multi-agent message bus and model status tracking.
 *
 * Manages the state for the minion horde chat system:
 * - Message routing between user and models
 * - Per-model status tracking (idle, thinking, writing, etc.)
 * - Selective context management (each model sees only its messages)
 * - Activity summaries for the orchestrator
 */

import { makeAutoObservable, runInAction } from 'mobx'

// ─── Types ───────────────────────────────────────────────────────────────────

export type MinionRole =
  | 'orchestrator'
  | 'chat'
  | 'coder'
  | 'creative'
  | 'architect'
  | 'scout'
  | 'action'
  | 'thinking'
  | 'compaction'

export type MinionStatus =
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'reading-file'
  | 'writing-file'
  | 'editing-file'
  | 'running-command'
  | 'using-tool'
  | 'searching'
  | 'analyzing'
  | 'planning'
  | 'waiting'
  | 'reviewing'
  | 'debugging'
  | 'installing'
  | 'cloning'
  | 'committing'
  | 'compacting'
  | 'summarizing'
  | 'error'
  | 'complete'
  | 'disconnected'

export type MessageType =
  | 'chat'        // Normal conversation message
  | 'status'      // Status update (model changed state)
  | 'forward'     // Forwarded message (condensed)
  | 'summary'     // Summary/result from a model
  | 'system'      // System notification
  | 'tool-use'    // Tool invocation details

export interface MinionMessage {
  id: string
  timestamp: number
  from: string           // 'user' | model friendly name
  to: string             // 'user' | model friendly name | 'all'
  type: MessageType
  content: string
  toolName?: string      // For tool-use messages
  metadata?: Record<string, any>
}

export interface MinionCard {
  id: string             // Model definition ID from settings
  role: MinionRole
  friendlyName: string
  modelName: string      // Actual model identifier
  status: MinionStatus
  statusDetail?: string  // e.g., tool name, file path
  connected: boolean
  lastActivity?: number
  currentTaskSummary?: string
}

// ─── Store ───────────────────────────────────────────────────────────────────

let messageCounter = 0
function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageCounter}`
}

export class MinionStore {
  messages: MinionMessage[] = []
  minions: Map<string, MinionCard> = new Map()
  selectedTarget: string | null = null // null = orchestrator routes, string = direct to specialist
  visionEnabled = false
  maxMessages = 500

  /** Roles that can be directly selected by clicking their card */
  static selectableRoles = new Set(['chat', 'coder', 'creative', 'architect', 'scout'])
  /** Roles that are internal/background — shown but not interactive */
  static internalRoles = new Set(['orchestrator', 'thinking', 'compaction', 'action'])

  constructor() {
    makeAutoObservable(this)
  }

  // ─── Minion Management ───────────────────────────────────────────────

  registerMinion(card: MinionCard): void {
    this.minions.set(card.id, card)
  }

  unregisterMinion(id: string): void {
    this.minions.delete(id)
  }

  updateMinionStatus(id: string, status: MinionStatus, detail?: string): void {
    const minion = this.minions.get(id)
    if (minion) {
      // Replace with a new object to trigger MobX reactivity
      this.minions.set(id, {
        ...minion,
        status,
        statusDetail: detail,
        lastActivity: Date.now(),
      })
    }
  }

  updateMinionConnection(id: string, connected: boolean): void {
    const minion = this.minions.get(id)
    if (minion) {
      this.minions.set(id, {
        ...minion,
        connected,
        status: connected ? minion.status : 'disconnected',
      })
    }
  }

  getMinionByRole(role: MinionRole): MinionCard | undefined {
    for (const minion of this.minions.values()) {
      if (minion.role === role) return minion
    }
    return undefined
  }

  getMinionByName(name: string): MinionCard | undefined {
    const lower = name.toLowerCase()
    for (const minion of this.minions.values()) {
      if (minion.friendlyName.toLowerCase() === lower) return minion
      if (minion.role === lower) return minion
      // Match relay names like "minion-coder" → role "coder"
      if (lower.startsWith('minion-') && lower.substring(7) === minion.role) return minion
      // Match by model name
      if (minion.modelName.toLowerCase().includes(lower)) return minion
    }
    return undefined
  }

  get minionList(): MinionCard[] {
    return Array.from(this.minions.values())
  }

  // ─── Message Management ──────────────────────────────────────────────

  addMessage(msg: Omit<MinionMessage, 'id' | 'timestamp'>): MinionMessage {
    const message: MinionMessage = {
      ...msg,
      id: nextMessageId(),
      timestamp: Date.now(),
    }
    this.messages.push(message)
    // Trim old messages
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages)
    }

    // Record to activity transcript
    const ts = (window as any).__transcriptService
    if (ts) {
      ts.recordActivityEntry({
        id: message.id,
        timestamp: message.timestamp,
        from: message.from,
        to: message.to,
        content: message.content,
        messageType: message.type,
        metadata: message.metadata,
      })
    }

    return message
  }

  /**
   * Send a message from the user to a target model.
   */
  sendUserMessage(content: string, target?: string): MinionMessage {
    const to = target || this.selectedTarget || 'orchestrator'
    return this.addMessage({
      from: 'user',
      to,
      type: 'chat',
      content,
    })
  }

  /**
   * Record a model sending a message to the user.
   */
  addModelToUserMessage(fromModel: string, content: string, type: MessageType = 'chat'): MinionMessage {
    return this.addMessage({
      from: fromModel,
      to: 'user',
      type,
      content,
    })
  }

  /**
   * Record a model-to-model message.
   */
  addModelToModelMessage(from: string, to: string, content: string, type: MessageType = 'chat'): MinionMessage {
    return this.addMessage({ from, to, type, content })
  }

  /**
   * Add a forwarding notification (condensed).
   */
  addForwardNotice(from: string, to: string, originalSender?: string): MinionMessage {
    return this.addMessage({
      from,
      to: 'user',
      type: 'forward',
      content: `Forwarded to: ${to}`,
      metadata: { originalSender },
    })
  }

  /**
   * Add a tool-use status message.
   */
  addToolUseMessage(modelName: string, toolName: string, detail?: string): MinionMessage {
    return this.addMessage({
      from: modelName,
      to: 'user',
      type: 'tool-use',
      content: detail || `Using ${toolName}`,
      toolName,
    })
  }

  /**
   * Add a system notification.
   */
  addSystemMessage(content: string): MinionMessage {
    return this.addMessage({
      from: 'system',
      to: 'all',
      type: 'system',
      content,
    })
  }

  // ─── Context Retrieval ───────────────────────────────────────────────

  /**
   * Get messages visible to a specific model (only messages addressed TO it).
   */
  getMessagesForModel(modelName: string): MinionMessage[] {
    return this.messages.filter(
      (m) => m.to === modelName || m.to === 'all'
    )
  }

  /**
   * Get activity summaries since a given timestamp.
   * Used to catch up the orchestrator on what happened while it was idle.
   */
  getActivitySummariesSince(since: number): string[] {
    const summaries: string[] = []
    for (const msg of this.messages) {
      if (msg.timestamp <= since) continue
      if (msg.type === 'system') continue
      const header = `[${msg.from} → ${msg.to}]`
      if (msg.type === 'forward') {
        summaries.push(`${header} ${msg.content}`)
      } else if (msg.type === 'summary' || msg.type === 'tool-use') {
        summaries.push(`${header} ${msg.content}`)
      } else {
        // For chat messages, include a truncated preview
        const preview = msg.content.length > 100
          ? msg.content.substring(0, 100) + '...'
          : msg.content
        summaries.push(`${header} ${preview}`)
      }
    }
    return summaries
  }

  /**
   * Get all messages for the chat feed (user sees everything).
   */
  get allMessages(): MinionMessage[] {
    return this.messages
  }

  // ─── Target Selection ────────────────────────────────────────────────

  /**
   * Toggle selection of a specialist card.
   * If already selected, deselect (revert to orchestrator routing).
   * Only selectable roles can be toggled.
   */
  toggleTarget(role: string): void {
    if (!MinionStore.selectableRoles.has(role)) return
    this.selectedTarget = this.selectedTarget === role ? null : role
  }

  /**
   * Toggle vision mode — when enabled, UI screenshots are sent with messages.
   */
  toggleVision(): void {
    this.visionEnabled = !this.visionEnabled
  }

  /**
   * Clear any direct selection — messages go through orchestrator.
   */
  clearTarget(): void {
    this.selectedTarget = null
  }

  /**
   * Whether a specific role's card is currently selected for direct messaging.
   */
  isSelected(role: string): boolean {
    return this.selectedTarget === role
  }

  /**
   * Get the effective message destination.
   * null = orchestrator decides, string = direct to that specialist.
   */
  get effectiveTarget(): string {
    return this.selectedTarget || 'orchestrator'
  }

  // ─── Status Helpers ──────────────────────────────────────────────────

  /**
   * Map a tool name to a human-readable status.
   */
  static toolToStatus(toolName: string): { status: MinionStatus; detail: string } {
    const lower = toolName.toLowerCase()
    if (lower.includes('read') || lower === 'cat' || lower === 'head') {
      return { status: 'reading-file', detail: toolName }
    }
    if (lower.includes('write') || lower.includes('create')) {
      return { status: 'writing-file', detail: toolName }
    }
    if (lower.includes('edit') || lower.includes('sed') || lower.includes('patch')) {
      return { status: 'editing-file', detail: toolName }
    }
    if (lower.includes('bash') || lower.includes('exec') || lower.includes('command') || lower.includes('terminal')) {
      return { status: 'running-command', detail: toolName }
    }
    if (lower.includes('grep') || lower.includes('glob') || lower.includes('search') || lower.includes('find')) {
      return { status: 'searching', detail: toolName }
    }
    if (lower.includes('git clone')) {
      return { status: 'cloning', detail: toolName }
    }
    if (lower.includes('git commit') || lower.includes('git push')) {
      return { status: 'committing', detail: toolName }
    }
    if (lower.includes('install') || lower.includes('pip') || lower.includes('npm') || lower.includes('apt')) {
      return { status: 'installing', detail: toolName }
    }
    if (lower.includes('compact') || lower.includes('summarize') || lower.includes('summary')) {
      return { status: 'summarizing', detail: toolName }
    }
    if (lower.includes('agent') || lower.includes('plan')) {
      return { status: 'planning', detail: toolName }
    }
    if (lower.includes('debug') || lower.includes('test')) {
      return { status: 'debugging', detail: toolName }
    }
    if (lower.includes('review') || lower.includes('analyze')) {
      return { status: 'analyzing', detail: toolName }
    }
    return { status: 'using-tool', detail: toolName }
  }

  /**
   * Get a human-readable label for a status.
   */
  static statusLabel(status: MinionStatus, detail?: string): string {
    const labels: Record<MinionStatus, string> = {
      'idle': 'Idle',
      'thinking': 'Thinking...',
      'generating': 'Generating...',
      'reading-file': 'Reading file',
      'writing-file': 'Writing file',
      'editing-file': 'Editing file',
      'running-command': 'Running command',
      'using-tool': detail ? `Using ${detail}` : 'Using tool',
      'searching': 'Searching',
      'analyzing': 'Analyzing',
      'planning': 'Planning',
      'waiting': 'Waiting for response',
      'reviewing': 'Reviewing',
      'debugging': 'Debugging',
      'installing': 'Installing',
      'cloning': 'Cloning repo',
      'committing': 'Committing',
      'compacting': 'Compacting context',
      'summarizing': 'Summarizing',
      'error': 'Error',
      'complete': 'Complete',
      'disconnected': 'Disconnected',
    }
    return labels[status] || status
  }
}
