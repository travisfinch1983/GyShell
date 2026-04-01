/**
 * MinionRouter — Routes messages directly to specialist model endpoints.
 *
 * Calls KoboldCpp/vLLM endpoints via ProxLab proxy slots.
 * No Claude Code pipeline — clean context, fast responses.
 */

import type { MinionStore, MinionRole } from '../stores/MinionStore'

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

  // Always ensure GyShell doesn't think it's busy from our injected messages
  try {
    appStore.chat.setThinking(false, session.id)
    appStore.chat.setSessionBusy(false, session.id)
  } catch {}

  persistMinionMessage({ ...message, sessionId: session.id })

  // Record to transcript
  const ts = (window as any).__transcriptService
  if (ts) {
    ts.recordChatMessage({
      id: msgId,
      timestamp: message.timestamp,
      from: role === 'user' ? 'user' : (metadata?.modelName || 'assistant'),
      to: role === 'user' ? (metadata?.subToolTitle?.replace('→ ', '') || 'assistant') : 'user',
      content,
      role,
      metadata,
    })
  }
}

function persistMinionMessage(msg: StoredChatMessage) {
  try {
    const stored = JSON.parse(localStorage.getItem(MINION_CHAT_STORAGE_KEY) || '[]')
    stored.push(msg)
    if (stored.length > MAX_STORED_MESSAGES) stored.splice(0, stored.length - MAX_STORED_MESSAGES)
    localStorage.setItem(MINION_CHAT_STORAGE_KEY, JSON.stringify(stored))
  } catch {}
}

export function rehydrateMinionMessages() {
  try {
    const stored: StoredChatMessage[] = JSON.parse(localStorage.getItem(MINION_CHAT_STORAGE_KEY) || '[]')
    if (!stored.length) return

    const appStore = (window as any).__appStore
    if (!appStore?.chat) return

    // First, inject all messages via handleUiUpdate (appends to end)
    for (const msg of stored) {
      const session = appStore.chat.sessions?.find((s: any) => s.id === msg.sessionId)
      if (!session) continue
      if (session.messagesById?.has(msg.id)) continue

      let metadata = msg.metadata || {}
      if (!metadata.modelName && msg.role === 'assistant' && msg.id?.startsWith('minion-')) {
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

    // Now sort all messageIds by timestamp for each session that got minion messages
    const sessionIds = new Set(stored.map(m => m.sessionId).filter(Boolean))
    for (const sid of sessionIds) {
      const session = appStore.chat.sessions?.find((s: any) => s.id === sid)
      if (!session) continue

      // Sort messageIds by the timestamp of each message
      const sorted = [...session.messageIds].sort((a: string, b: string) => {
        const msgA = session.messagesById.get(a)
        const msgB = session.messagesById.get(b)
        return (msgA?.timestamp || 0) - (msgB?.timestamp || 0)
      })

      // Replace the array contents (triggers MobX reactivity)
      session.messageIds.length = 0
      session.messageIds.push(...sorted)
    }
  } catch (e) {
    console.warn('[rehydrate] Error:', e)
  }
}

// ─── Model endpoint resolution ───────────────────────────────────────────────

interface ModelEndpoint {
  baseUrl: string
  modelId: string
  apiKey: string
}

/**
 * Resolve the API endpoint for a given role from the active profile settings.
 */
function getModelEndpoint(role: string): ModelEndpoint | null {
  const appStore = (window as any).__appStore
  const settings = appStore?.settings
  if (!settings?.models) return null

  const profile = settings.models.profiles.find(
    (p: any) => p.id === settings.models.activeProfileId
  )
  if (!profile) return null

  // Map role to profile field
  const roleToField: Record<string, string> = {
    chat: 'chatModelId',
    coder: 'coderModelId',
    creative: 'creativeModelId',
    architect: 'architectModelId',
    scout: 'scoutModelId',
    thinking: 'thinkingModelId',
    action: 'actionModelId',
    orchestrator: 'globalModelId',
  }

  const fieldName = roleToField[role]
  if (!fieldName) return null

  const modelId = (profile as any)[fieldName]
  if (!modelId) return null

  const item = settings.models.items.find((m: any) => m.id === modelId)
  if (!item) return null

  return {
    baseUrl: item.baseUrl,
    modelId: item.model,
    apiKey: item.apiKey || 'not-needed',
  }
}

// ─── Per-model conversation history ──────────────────────────────────────────

/** Keep recent conversation history per role for context continuity */
const roleConversations = new Map<string, Array<{ role: string; content: string }>>()
const MAX_CONVERSATION_TURNS = 10

function getRoleHistory(role: string): Array<{ role: string; content: string }> {
  return roleConversations.get(role) || []
}

function addToRoleHistory(role: string, msg: { role: string; content: string }) {
  if (!roleConversations.has(role)) roleConversations.set(role, [])
  const history = roleConversations.get(role)!
  history.push(msg)
  // Keep only recent turns
  while (history.length > MAX_CONVERSATION_TURNS * 2) {
    history.shift()
  }
}

// ─── Default system prompts per role ─────────────────────────────────────────

const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  coder: 'You are a code specialist. You write clean, efficient, well-documented code. When asked to create scripts, programs, functions, or anything code-related, provide the complete implementation. Be concise and direct.',
  creative: 'You are a creative writing specialist. Write engaging, well-crafted text. Be expressive but professional. You handle documentation, descriptions, naming, brainstorming, and any writing-focused tasks.',
  architect: 'You are a systems architect. Analyze designs, suggest improvements, and think about scalability, maintainability, and trade-offs. Provide detailed technical analysis.',
  scout: 'You are a quick-check specialist. Give brief, direct answers. Be concise. You handle simple factual questions, status checks, and yes/no queries.',
  chat: 'You are a helpful assistant. Be conversational and thorough. Answer questions clearly and provide useful explanations.',
  thinking: 'You are a deep reasoning specialist. Think through problems carefully and explain your reasoning step by step.',
}

/**
 * Get the system prompt for a role, checking profile overrides first.
 */
function getRolePrompt(role: string): string {
  const appStore = (window as any).__appStore
  const settings = appStore?.settings
  if (settings?.models) {
    const profile = settings.models.profiles.find(
      (p: any) => p.id === settings.models.activeProfileId
    )
    if (profile?.rolePrompts?.[role]) {
      return profile.rolePrompts[role]
    }
  }
  return DEFAULT_ROLE_PROMPTS[role] || DEFAULT_ROLE_PROMPTS.chat
}

// ─── Orchestrator classification prompt ──────────────────────────────────────

const ORCHESTRATOR_CLASSIFY_PROMPT = `You are a message router. Your ONLY job is to classify messages and output JSON. No other text.

RULES:
- "coder" — ANY request involving code, scripts, programming, commands, functions, debugging, git, APIs, configs, technical how-to. If they say "write", "create", "make", "build", "fix" followed by anything technical, it's coder.
- "creative" — Writing prose, documentation, descriptions, naming things, brainstorming ideas, READMEs, commit messages, creative text.
- "architect" — System design, architecture decisions, infrastructure planning, comparing approaches, scalability analysis.
- "scout" — Quick factual lookups, simple questions with one-line answers, status checks, "what is X", "how many", yes/no.
- "chat" — ONLY use this for casual conversation, greetings, or messages that truly don't fit ANY specialist.

IMPORTANT: Prefer specialists over chat. Most technical questions should go to coder, not chat.

Output ONLY this JSON, nothing else:
{"role":"coder","reason":"brief reason"}`

// ─── MinionRouter class ─────────────────────────────────────────────────────

export class MinionRouter {
  private store: MinionStore
  private abortControllers = new Map<string, AbortController>()

  constructor(store: MinionStore) {
    this.store = store
  }

  /**
   * Cancel an in-flight request for a specific role.
   */
  cancelRequest(role: string): void {
    const controller = this.abortControllers.get(role)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(role)
      const minion = this.store.getMinionByRole(role as any)
      if (minion) {
        this.store.updateMinionStatus(minion.id, 'idle')
        this.store.addMessage({
          from: 'system',
          to: 'all',
          type: 'system',
          content: `Cancelled ${minion.friendlyName} request`,
        })
      }
    }
  }

  /**
   * Check if a role has an active request.
   */
  isRequestActive(role: string): boolean {
    return this.abortControllers.has(role)
  }

  /**
   * Send a message directly to a specialist model's API endpoint.
   * Clean context — no Claude Code pipeline.
   */
  async sendToSpecialist(role: string, message: string): Promise<void> {
    const minion = this.store.getMinionByRole(role as MinionRole)
    if (!minion) {
      console.error(`[MinionRouter] No minion for role: ${role}`)
      return
    }

    const endpoint = getModelEndpoint(role)
    if (!endpoint) {
      console.error(`[MinionRouter] No endpoint for role: ${role}`)
      this.store.updateMinionStatus(minion.id, 'error', 'No endpoint configured')
      return
    }

    // Add routing notice to activity feed
    this.store.addMessage({
      from: 'user',
      to: minion.friendlyName,
      type: 'chat',
      content: message,
    })

    // Inject user message into main chat
    injectChatMessage('user', message, {
      subToolTitle: `→ ${minion.friendlyName}`,
    })

    // Update card status
    this.store.updateMinionStatus(minion.id, 'thinking')

    // Build the request
    const systemPrompt = getRolePrompt(role)
    const history = getRoleHistory(role)
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ]

    // Conversation tracer — log what we're actually sending
    const totalTokensEstimate = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
    console.log(`[MinionRouter] ═══ TRACE ═══`)
    console.log(`[MinionRouter] Target: ${minion.friendlyName} (${role})`)
    console.log(`[MinionRouter] Endpoint: ${endpoint.baseUrl}/chat/completions`)
    console.log(`[MinionRouter] Model: ${endpoint.modelId}`)
    console.log(`[MinionRouter] Messages: ${messages.length} (est ~${totalTokensEstimate} tokens)`)
    messages.forEach((m, i) => {
      const preview = m.content.length > 100 ? m.content.substring(0, 100) + '...' : m.content
      console.log(`[MinionRouter]   [${i}] ${m.role}: ${preview} (${m.content.length} chars)`)
    })
    console.log(`[MinionRouter] ═════════════`)

    // Set up abort controller for this role
    this.abortControllers.get(role)?.abort()
    const abortController = new AbortController()
    this.abortControllers.set(role, abortController)

    try {
      const resp = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: endpoint.modelId,
          messages,
          max_tokens: 4096,
          temperature: 0.7,
          stream: false,
        }),
        signal: abortController.signal,
      })

      if (!resp.ok) {
        const err = await resp.text().catch(() => 'Unknown error')
        console.error(`[MinionRouter] API error:`, err)
        this.store.updateMinionStatus(minion.id, 'error', `API ${resp.status}`)
        injectChatMessage('assistant', `**[${minion.friendlyName} ✗ Error]**\n\nAPI error ${resp.status}: ${err.substring(0, 200)}`, {
          modelName: minion.friendlyName,
        })
        return
      }

      const data = await resp.json()
      const choice = data.choices?.[0]
      let responseText = choice?.message?.content || 'No response'

      // Strip <think> blocks if present (some models include thinking)
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()

      // Update conversation history
      addToRoleHistory(role, { role: 'user', content: message })
      addToRoleHistory(role, { role: 'assistant', content: responseText })

      // Update card status
      this.store.updateMinionStatus(minion.id, 'idle')

      // Add to activity feed
      this.store.addMessage({
        from: minion.friendlyName,
        to: 'user',
        type: 'summary',
        content: responseText.substring(0, 100) + (responseText.length > 100 ? '...' : ''),
        metadata: { status: 'completed' },
      })

      // Inject response into main chat
      injectChatMessage('assistant', `**[${minion.friendlyName} ✓]**\n\n${responseText}`, {
        modelName: minion.friendlyName,
      })

    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(`[MinionRouter] Request to ${minion.friendlyName} cancelled`)
      } else {
        console.error(`[MinionRouter] Fetch error:`, err)
        this.store.updateMinionStatus(minion.id, 'error', err.message)
        injectChatMessage('assistant', `**[${minion.friendlyName} ✗ Error]**\n\n${err.message}`, {
          modelName: minion.friendlyName,
        })
      }
    } finally {
      this.abortControllers.delete(role)
    }
  }

  /**
   * Route a message through the orchestrator (9B).
   * The orchestrator classifies the message and decides which specialist
   * or the chat model should handle it.
   */
  async routeViaOrchestrator(message: string): Promise<void> {
    const orchestrator = this.store.getMinionByRole('orchestrator')
    const endpoint = getModelEndpoint('orchestrator')

    if (!endpoint) {
      console.warn('[MinionRouter] No orchestrator endpoint, falling back to chat')
      await this.sendToSpecialist('chat', message)
      return
    }

    // Update orchestrator card
    if (orchestrator) this.store.updateMinionStatus(orchestrator.id, 'thinking')

    console.log(`[MinionRouter] ═══ ORCHESTRATOR CLASSIFY ═══`)
    console.log(`[MinionRouter] Message: ${message.substring(0, 80)}...`)

    try {
      const resp = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: endpoint.modelId,
          messages: [
            { role: 'system', content: ORCHESTRATOR_CLASSIFY_PROMPT },
            { role: 'user', content: message },
          ],
          max_tokens: 100,
          temperature: 0.1,
        }),
      })

      if (!resp.ok) {
        console.warn(`[MinionRouter] Orchestrator classify failed (${resp.status}), falling back to chat`)
        if (orchestrator) this.store.updateMinionStatus(orchestrator.id, 'idle')
        await this.sendToSpecialist('chat', message)
        return
      }

      const data = await resp.json()
      let responseText = data.choices?.[0]?.message?.content || ''

      // Strip think blocks
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()

      // Parse the JSON classification
      let targetRole = 'chat'
      let reason = 'default'
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          targetRole = parsed.role || 'chat'
          reason = parsed.reason || 'classified'
        }
      } catch {
        console.warn(`[MinionRouter] Failed to parse classification: ${responseText}`)
      }

      console.log(`[MinionRouter] Classification: ${targetRole} (${reason})`)

      // Update orchestrator card back to idle
      if (orchestrator) this.store.updateMinionStatus(orchestrator.id, 'idle')

      // Add routing notice to activity feed
      this.store.addMessage({
        from: 'orchestrator',
        to: targetRole,
        type: 'forward',
        content: `Routed to ${targetRole} — ${reason}`,
        metadata: { role: targetRole, reason },
      })

      // Route to the classified specialist
      await this.sendToSpecialist(targetRole, message)

    } catch (err: any) {
      console.error(`[MinionRouter] Orchestrator error:`, err)
      if (orchestrator) this.store.updateMinionStatus(orchestrator.id, 'error', err.message)
      // Fall back to chat on error
      await this.sendToSpecialist('chat', message)
    }
  }

  dispose(): void {
    // No polling needed anymore — direct API calls
  }
}
