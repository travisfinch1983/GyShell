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
  } catch {}
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

// ─── System prompts per role ─────────────────────────────────────────────────

const ROLE_SYSTEM_PROMPTS: Record<string, string> = {
  coder: 'You are a code specialist. Write clean, efficient code. Be concise and direct.',
  creative: 'You are a creative writing specialist. Write engaging, well-crafted text. Be expressive but professional.',
  architect: 'You are a systems architect. Analyze designs, suggest improvements, and think about scalability and maintainability.',
  scout: 'You are a quick-check specialist. Give brief, direct answers. Be concise.',
  chat: 'You are a helpful assistant. Be conversational and thorough.',
  thinking: 'You are a deep reasoning specialist. Think through problems carefully and explain your reasoning.',
}

// ─── MinionRouter class ─────────────────────────────────────────────────────

export class MinionRouter {
  private store: MinionStore

  constructor(store: MinionStore) {
    this.store = store
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
    const systemPrompt = ROLE_SYSTEM_PROMPTS[role] || ROLE_SYSTEM_PROMPTS.chat
    const history = getRoleHistory(role)
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ]

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
      console.error(`[MinionRouter] Fetch error:`, err)
      this.store.updateMinionStatus(minion.id, 'error', err.message)
      injectChatMessage('assistant', `**[${minion.friendlyName} ✗ Error]**\n\n${err.message}`, {
        modelName: minion.friendlyName,
      })
    }
  }

  dispose(): void {
    // No polling needed anymore — direct API calls
  }
}
