import { runInAction } from 'mobx'
/**
 * MinionRouter — Chat-first routing with specialist dispatch.
 *
 * All unaddressed messages go to the chat model first. Chat acts as both
 * conversationalist and router — it responds to the user naturally, and
 * can optionally dispatch work to specialists via <route> tags.
 *
 * Direct specialist routing still works via card selection in the sidebar.
 */

import type { MinionStore, MinionRole } from '../stores/MinionStore'
import { parseMinionResponse } from './minionMessageParser'
import { getDiscoveredModel, getSlotEndpoint } from './ProxlabDiscovery'
import { isTtsEnabled, speakText } from './TtsPlayback'

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
    if (!stored.length) {
      console.log('[rehydrate] No stored minion messages')
      return
    }

    const appStore = (window as any).__appStore
    if (!appStore?.chat) return

    // Get the active session — messages may have been stored under a different session ID
    // (e.g., after Clear Chat created a new session)
    const activeSession = appStore.chat.activeSession || appStore.chat.sessions?.[0]
    if (!activeSession) {
      console.warn('[rehydrate] No active session to inject messages into')
      return
    }
    const activeSessionId = activeSession.id

    console.log(`[rehydrate] Found ${stored.length} stored messages, active session: ${activeSessionId.slice(0, 8)}`)

    for (const msg of stored) {
      // Try the stored session first, fall back to active session
      let session = appStore.chat.sessions?.find((s: any) => s.id === msg.sessionId)
      let targetSessionId = msg.sessionId
      if (!session) {
        // Session doesn't exist anymore — inject into active session
        session = activeSession
        targetSessionId = activeSessionId
      }
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
        sessionId: targetSessionId,
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

    console.log(`[rehydrate] Injected messages into session ${activeSessionId.slice(0, 8)}`)

    // Sort messages by timestamp in all affected sessions
    const sessionIds = new Set([activeSessionId, ...stored.map(m => m.sessionId).filter(Boolean)])
    for (const sid of sessionIds) {
      const session = appStore.chat.sessions?.find((s: any) => s.id === sid)
      if (!session) continue
      const sorted = [...session.messageIds].sort((a: string, b: string) => {
        const msgA = session.messagesById.get(a)
        const msgB = session.messagesById.get(b)
        return (msgA?.timestamp || 0) - (msgB?.timestamp || 0)
      })
      runInAction(() => { session.messageIds.length = 0
      session.messageIds.push(...sorted) })
    }
    // Rehydrate per-role conversation history from stored messages
    // This restores the context that gets sent to models on the next API call
    rehydrateConversationHistory(stored)

  } catch (e) {
    console.warn('[rehydrate] Error:', e)
  }
}

/**
 * Rebuild the per-role conversation history from persisted messages.
 * Maps stored chat messages back into the roleConversations Map so models
 * have context after a page refresh.
 */
function rehydrateConversationHistory(stored: StoredChatMessage[]) {
  // Sort by timestamp to maintain conversation order
  const sorted = [...stored].sort((a, b) => a.timestamp - b.timestamp)

  // Only use recent messages (last N turns per role, matching MAX_CONVERSATION_TURNS)
  const roleMsgMap = new Map<string, Array<{ role: string; content: string }>>()

  for (const msg of sorted) {
    // Skip error messages and system messages
    if (msg.content?.includes('✗ Error') || msg.content?.includes('✗ Timeout')) continue
    if (msg.role === 'system') continue

    // Determine which role's history this belongs to
    let targetRole: string | null = null

    if (msg.role === 'assistant' && msg.metadata?.modelName) {
      // Model response — extract role from model name
      const modelName = (msg.metadata.modelName as string).toLowerCase()
      if (modelName.includes('chat') || modelName.includes('122b')) targetRole = 'chat'
      else if (modelName.includes('coder') || modelName.includes('kat-dev')) targetRole = 'coder'
      else if (modelName.includes('creative') || modelName.includes('darkidol') || modelName.includes('ballad')) targetRole = 'creative'
      else if (modelName.includes('architect') || modelName.includes('27b')) targetRole = 'architect'
      else if (modelName.includes('scout') || modelName.includes('4b')) targetRole = 'scout'
    } else if (msg.role === 'user' && msg.metadata?.minionTo) {
      // User message addressed to a specific role
      targetRole = (msg.metadata.minionTo as string).toLowerCase()
      // Normalize friendly names to roles
      if (targetRole === 'chat' || targetRole.includes('122b')) targetRole = 'chat'
      else if (targetRole.includes('coder') || targetRole.includes('kat-dev')) targetRole = 'coder'
      else if (targetRole.includes('creative')) targetRole = 'creative'
      else if (targetRole.includes('architect')) targetRole = 'architect'
      else if (targetRole.includes('scout')) targetRole = 'scout'
    }

    if (!targetRole) continue

    if (!roleMsgMap.has(targetRole)) roleMsgMap.set(targetRole, [])
    const history = roleMsgMap.get(targetRole)!

    // Strip the header we prepend (e.g., "**[Chat ✓]**\n\n")
    let content = msg.content || ''
    content = content.replace(/^\*\*\[.*?\]\*\*\s*\n*/, '').trim()
    if (!content) continue

    history.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content,
    })
  }

  // Apply to roleConversations, keeping only recent turns
  for (const [role, messages] of roleMsgMap) {
    const trimmed = messages.slice(-(MAX_CONVERSATION_TURNS * 2))
    roleConversations.set(role, trimmed)
    console.log(`[rehydrate] Restored ${trimmed.length} history entries for ${role}`)
  }
}

// ─── Model endpoint resolution ───────────────────────────────────────────────

interface ModelEndpoint {
  baseUrl: string
  modelId: string
  apiKey: string
}

function getModelEndpoint(role: string): ModelEndpoint | null {
  const appStore = (window as any).__appStore
  const settings = appStore?.settings
  if (!settings?.models) return null

  const profile = settings.models.profiles.find(
    (p: any) => p.id === settings.models.activeProfileId
  )
  if (!profile) return null

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

  let item = settings.models.items.find((m: any) => m.id === modelId)
  // Fallback: if item ID not found, the profile may reference an old ID — try matching by model name
  if (!item) {
    item = settings.models.items.find((m: any) => m.model === modelId)
  }
  if (!item) {
    console.warn(`[MinionRouter] No model item found for ${role} (id: ${modelId})`)
    return null
  }

  // Try ProxLab discovery first — get the slot-based endpoint
  const discovered = getDiscoveredModel(item.model)
  if (discovered) {
    return {
      baseUrl: getSlotEndpoint(discovered.slot),
      modelId: item.model,
      apiKey: item.apiKey || 'not-needed',
    }
  }

  // Fallback: rewrite the stored baseUrl for browser compatibility
  return {
    baseUrl: rewriteEndpointForBrowser(item.baseUrl),
    modelId: item.model,
    apiKey: item.apiKey || 'not-needed',
  }
}

/**
 * Rewrite model endpoint URLs for browser-side fetch.
 * Fallback for models not in ProxLab discovery (external endpoints).
 */
function rewriteEndpointForBrowser(baseUrl: string): string {
  if (!baseUrl) return baseUrl

  // Rewrite http://10.0.0.140:7777/api/proxy/... → /proxlab-api/...
  const localMatch = baseUrl.match(/^https?:\/\/10\.0\.0\.140:7777\/api\/proxy\/(.*)/)
  if (localMatch) return `/proxlab-api/${localMatch[1]}`

  // Rewrite http(s)://proxlab.deeveeyant.com/api/proxy/... → /proxlab-api/...
  const domainMatch = baseUrl.match(/^https?:\/\/proxlab\.deeveeyant\.com\/api\/proxy\/(.*)/)
  if (domainMatch) return `/proxlab-api/${domainMatch[1]}`

  return baseUrl
}

// ─── Per-model conversation history ──────────────────────────────────────────

const roleConversations = new Map<string, Array<{ role: string; content: string }>>()
// Expose for clearing from UI (Clear Chat View)
;(window as any).__roleConversations = roleConversations
const MAX_CONVERSATION_TURNS = 10

function getRoleHistory(role: string): Array<{ role: string; content: string }> {
  return roleConversations.get(role) || []
}

function addToRoleHistory(role: string, msg: { role: string; content: string }) {
  if (!roleConversations.has(role)) roleConversations.set(role, [])
  const history = roleConversations.get(role)!
  history.push(msg)
  while (history.length > MAX_CONVERSATION_TURNS * 2) {
    history.shift()
  }
}

// ─── System prompts ─────────────────────────────────────────────────────────

export const SPECIALIST_PREAMBLE = `You are part of a multi-model team. The user is chatting with you through a group chat interface. Be direct, helpful, and thorough. Do not refuse reasonable requests. Do not lecture about safety, ethics, or your limitations unless the request is genuinely harmful.

When you reason through a problem, wrap your thinking in <think>...</think> tags. This is expected and encouraged — it helps the user understand your reasoning when they choose to view it. Always use <think> blocks for non-trivial reasoning before giving your answer.

`

export const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  chat: `You are the primary assistant in a multi-model group chat. You talk directly with the user and handle most conversations yourself. You are conversational, thoughtful, and thorough.

You also have the ability to delegate tasks to specialist models when appropriate. The available specialists are:
- **coder** — Code writing, debugging, scripts, technical implementation, CLI commands, configs
- **creative** — Creative writing, documentation, descriptions, naming, brainstorming, prose
- **architect** — System design, architecture analysis, infrastructure planning, trade-off evaluation
- **scout** — Quick factual lookups, simple yes/no answers, brief status checks

ROUTING RULES:
- Handle most messages yourself. You are the default — casual chat, questions, explanations, follow-ups.
- Only route to a specialist when the task clearly falls into their domain AND would benefit from their focused expertise.
- If you are already discussing something with the user, CONTINUE the conversation yourself. Do not switch to a specialist mid-conversation unless the user explicitly asks for one or the task clearly requires it.
- NEVER route messages that are conversational, follow-ups to your own messages, or questions about how this system works.

CRITICAL — HOW TO ROUTE:
When you decide to route a task, you MUST include the exact XML tag below in your response. Without this tag, the routing will NOT happen — just saying "I'll send this to the coder" does nothing. The tag is what triggers the actual dispatch.

Tag format (include this literally in your response, outside of think blocks):
<route>{"role":"SPECIALIST","message":"TASK DESCRIPTION"}</route>

- Replace SPECIALIST with: coder, creative, architect, or scout
- Replace TASK DESCRIPTION with a clear, self-contained description of the task
- Place the tag at the END of your response, after your acknowledgment to the user
- Do NOT put the <route> tag inside <think> blocks — it must be in the visible response
- The "message" should include enough context that the specialist can work independently

When you reason through a problem, wrap your thinking in <think>...</think> tags. This is expected and encouraged.

Example of routing:
User: "Can you write me a Python script that monitors CPU usage?"
You: "Sure! I'll have the coder put that together for you.
<route>{"role":"coder","message":"Write a Python script that monitors CPU usage and prints it at regular intervals. Use psutil library."}</route>"

Example of NOT routing:
User: "What does that script do?"
You: (answer the question yourself — this is a follow-up to the conversation)

IMPORTANT: If you decide in your thinking that a task should be routed, you MUST include the <route> tag in your visible response. Thinking about routing without including the tag means the task will NOT be sent.`,

  coder: SPECIALIST_PREAMBLE + `You are the **Coder** — a code specialist. You write clean, efficient, well-structured code.

Your responsibilities:
- Write complete implementations, not pseudocode or outlines
- Include all imports, error handling, and comments where logic isn't obvious
- When asked to create something, just create it — don't ask for permission or clarification unless genuinely ambiguous
- Use modern idioms and best practices for the language
- If a request involves shell commands, scripts, configs, git operations, or technical how-to, that's you
- Format code in proper markdown code blocks with language tags

When given a task, work on it independently. You receive a self-contained description of what to build. Do the work and return the result. Keep explanations brief — lead with the code.`,

  creative: SPECIALIST_PREAMBLE + `You are the **Creative** — a writing and creative specialist. You produce engaging, well-crafted text.

Your responsibilities:
- Write documentation, READMEs, descriptions, blog posts, commit messages, and any prose
- Brainstorm names, taglines, concepts, and creative directions
- Edit and refine existing text for clarity, tone, and impact
- Adapt your writing style to the context — technical docs are different from marketing copy
- Be expressive but purposeful — every word should earn its place

When given a task, deliver polished output. Don't explain your process unless asked.`,

  architect: SPECIALIST_PREAMBLE + `You are the **Architect** — a systems design specialist. You think about the big picture.

Your responsibilities:
- Analyze system designs and suggest improvements
- Evaluate trade-offs between approaches (performance, maintainability, cost, complexity)
- Plan infrastructure, data flows, API designs, and service boundaries
- Consider scalability, reliability, security, and operational concerns
- Draw from real-world patterns and anti-patterns

When given a design question, provide structured analysis. Use sections, bullet points, and concrete recommendations. Don't just list options — make a recommendation and defend it.`,

  scout: SPECIALIST_PREAMBLE + `You are the **Scout** — a quick-check specialist. You give fast, direct answers.

Your responsibilities:
- Answer simple factual questions in one or two sentences
- Provide brief status checks, yes/no answers, quick lookups
- Convert units, check syntax, verify facts
- If the answer is short, give a short answer — don't pad it

Be the fastest model to respond. No preamble, no filler. Just the answer.`,

  thinking: SPECIALIST_PREAMBLE + `You are the **Thinker** — a deep reasoning specialist. You work through complex problems methodically.

Your responsibilities:
- Break down complex problems into clear steps
- Analyze edge cases and failure modes
- Provide multi-angle analysis of difficult decisions
- Show your work — explain how you arrived at your conclusions

Always use extensive <think> blocks. Walk through your reasoning step by step, consider alternatives, then give a clear conclusion.`,
}

function getRolePrompt(role: string): string {
  const appStore = (window as any).__appStore
  const settings = appStore?.settings
  if (settings?.models) {
    // 1. Check profile-level override
    const profile = settings.models.profiles.find(
      (p: any) => p.id === settings.models.activeProfileId
    )
    if (profile?.rolePrompts?.[role]) {
      return profile.rolePrompts[role]
    }
    // 2. Check saved defaults (user-edited base prompts)
    if (settings.models.defaultRolePrompts?.[role]) {
      return settings.models.defaultRolePrompts[role]
    }
  }
  // 3. Fall back to code defaults
  return DEFAULT_ROLE_PROMPTS[role] || DEFAULT_ROLE_PROMPTS.chat
}

// ─── Route tag parsing ──────────────────────────────────────────────────────

interface RouteTag {
  role: string
  message: string
}

/**
 * Extract a <route> tag from a chat model response.
 * Returns the route info and the cleaned message (tag stripped).
 */
function extractRouteTag(text: string): { route: RouteTag | null; cleanText: string } {
  const routeMatch = text.match(/<route>\s*(\{[\s\S]*?\})\s*<\/route>/)
  if (!routeMatch) return { route: null, cleanText: text }

  try {
    const parsed = JSON.parse(routeMatch[1])
    if (parsed.role && parsed.message) {
      const cleanText = text.replace(/<route>[\s\S]*?<\/route>\s*/g, '').trim()
      return {
        route: { role: parsed.role, message: parsed.message },
        cleanText,
      }
    }
  } catch {
    console.warn('[MinionRouter] Failed to parse route tag:', routeMatch[1])
  }

  return { route: null, cleanText: text }
}

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

  isRequestActive(role: string): boolean {
    return this.abortControllers.has(role)
  }

  /**
   * Send a message directly to a specialist model's API endpoint.
   * Used for: card-selected direct routing AND chat-dispatched specialist tasks.
   *
   * @param role - The specialist role to send to
   * @param message - The message/task for the specialist
   * @param options.showUserMessage - Whether to inject a user message in chat (default: true)
   * @param options.dispatchedBy - If dispatched by chat model, show as forwarded
   */
  async sendToSpecialist(
    role: string,
    message: string,
    options?: { showUserMessage?: boolean; dispatchedBy?: string; screenshotDataUrl?: string }
  ): Promise<void> {
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

    const showUserMsg = options?.showUserMessage !== false
    const dispatchedBy = options?.dispatchedBy
    const screenshotDataUrl = options?.screenshotDataUrl

    // Add routing notice to activity feed
    if (dispatchedBy) {
      this.store.addMessage({
        from: dispatchedBy,
        to: minion.friendlyName,
        type: 'forward',
        content: `Dispatched to ${minion.friendlyName}`,
        metadata: { role, reason: 'chat-routed' },
      })
    } else {
      this.store.addMessage({
        from: 'user',
        to: minion.friendlyName,
        type: 'chat',
        content: message,
      })
    }

    // Inject user message into main chat (only for direct sends, not chat-dispatched)
    if (showUserMsg) {
      injectChatMessage('user', message, {
        subToolTitle: `→ ${minion.friendlyName}`,
        minionTo: minion.friendlyName,
      })
    }

    // Update card status
    this.store.updateMinionStatus(minion.id, 'thinking')

    // Build the request
    const systemPrompt = getRolePrompt(role)
    const history = getRoleHistory(role)

    // Build user message — multimodal if screenshot provided
    const userMessage: any = screenshotDataUrl
      ? { role: 'user', content: [
          { type: 'text', text: message },
          { type: 'image_url', image_url: { url: screenshotDataUrl } },
        ]}
      : { role: 'user', content: message }

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      userMessage,
    ]

    // Conversation tracer
    const totalTokensEstimate = messages.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + Math.ceil(m.content.length / 4)
      if (Array.isArray(m.content)) {
        return sum + m.content.reduce((s: number, part: any) => {
          if (part.type === 'text') return s + Math.ceil(part.text.length / 4)
          if (part.type === 'image_url') return s + 765
          return s
        }, 0)
      }
      return sum
    }, 0)
    console.log(`[MinionRouter] ═══ TRACE ═══`)
    console.log(`[MinionRouter] Target: ${minion.friendlyName} (${role})`)
    console.log(`[MinionRouter] Endpoint: ${endpoint.baseUrl}/chat/completions`)
    console.log(`[MinionRouter] Model: ${endpoint.modelId}`)
    console.log(`[MinionRouter] Vision: ${screenshotDataUrl ? 'YES (' + Math.round(screenshotDataUrl.length / 1024) + 'KB)' : 'no'}`)
    console.log(`[MinionRouter] Messages: ${messages.length} (est ~${totalTokensEstimate} tokens)`)
    if (dispatchedBy) console.log(`[MinionRouter] Dispatched by: ${dispatchedBy}`)
    messages.forEach((m, i) => {
      const content = typeof m.content === 'string' ? m.content : '[multimodal: text + image]'
      const preview = content.length > 100 ? content.substring(0, 100) + '...' : content
      console.log(`[MinionRouter]   [${i}] ${m.role}: ${preview} (${typeof m.content === 'string' ? m.content.length : 'multimodal'} chars)`)
    })
    console.log(`[MinionRouter] ═════════════`)

    // Set up abort controller with 5 minute timeout for long generations
    this.abortControllers.get(role)?.abort()
    const abortController = new AbortController()
    this.abortControllers.set(role, abortController)
    const timeoutId = setTimeout(() => {
      console.warn(`[MinionRouter] Request to ${role} timed out after 5 minutes`)
      abortController.abort()
    }, 300000) // 5 min

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
      const rawResponse = choice?.message?.content || 'No response'

      // Parse response into structured blocks
      const parsed = parseMinionResponse(rawResponse)

      // Update conversation history
      addToRoleHistory(role, { role: 'user', content: message })
      addToRoleHistory(role, { role: 'assistant', content: parsed.body })

      // Update card status
      this.store.updateMinionStatus(minion.id, 'idle')

      // Add to activity feed
      this.store.addMessage({
        from: minion.friendlyName,
        to: 'user',
        type: 'summary',
        content: parsed.summary,
        metadata: { status: 'completed' },
      })

      // Inject response into main chat
      injectChatMessage('assistant', `**[${minion.friendlyName} ✓]**\n\n${parsed.body}`, {
        modelName: minion.friendlyName,
        minionParsed: true,
        minionSummary: parsed.summary,
        minionThinking: parsed.thinking,
        minionTo: 'user',
      })

      // Auto-TTS: speak the clean body text (no thinking, no tool calls)
      if (isTtsEnabled()) speakText(parsed.body, role)

    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(`[MinionRouter] Request to ${minion.friendlyName} cancelled/timed out`)
        this.store.updateMinionStatus(minion.id, 'error', 'Request timed out')
        injectChatMessage('assistant', `**[${minion.friendlyName} ✗ Timeout]**\n\nRequest timed out after 5 minutes. The model may still be generating — try again or send a simpler request.`, {
          modelName: minion.friendlyName,
        })
      } else {
        console.error(`[MinionRouter] Fetch error for ${minion.friendlyName}:`, err)
        console.error(`[MinionRouter] Endpoint was: ${endpoint.baseUrl}/chat/completions`)
        this.store.updateMinionStatus(minion.id, 'error', err.message)
        injectChatMessage('assistant', `**[${minion.friendlyName} ✗ Error]**\n\n${err.message}\n\nEndpoint: ${endpoint.baseUrl}`, {
          modelName: minion.friendlyName,
        })
      }
    } finally {
      clearTimeout(timeoutId)
      this.abortControllers.delete(role)
    }
  }

  /**
   * Route a message through the chat model.
   *
   * Chat handles the message itself AND decides whether to dispatch to a specialist.
   * If chat includes a <route> tag, the specialist task is dispatched in the background
   * while chat's response is shown to the user immediately.
   */
  async routeViaChat(message: string, screenshotDataUrl?: string): Promise<void> {
    const chatMinion = this.store.getMinionByRole('chat')
    const endpoint = getModelEndpoint('chat')

    if (!endpoint) {
      console.warn('[MinionRouter] No chat endpoint configured')
      return
    }

    // Add to activity feed
    this.store.addMessage({
      from: 'user',
      to: chatMinion?.friendlyName || 'Chat',
      type: 'chat',
      content: message,
    })

    // Inject user message into main chat
    injectChatMessage('user', message, {
      subToolTitle: `→ Chat`,
      minionTo: 'chat',
    })

    // Update card status
    if (chatMinion) this.store.updateMinionStatus(chatMinion.id, 'thinking')

    // Build context — include recent activity summaries so chat knows what's been happening
    const systemPrompt = getRolePrompt('chat')
    const history = getRoleHistory('chat')

    // Get recent activity summaries for context awareness
    const recentActivity = this.store.getActivitySummariesSince(Date.now() - 5 * 60 * 1000) // last 5 min
    let contextBlock = ''
    if (recentActivity.length > 0) {
      contextBlock = '\n\n[Recent activity in the group chat]\n' + recentActivity.slice(-10).join('\n') + '\n'
    }

    // Build user message — multimodal if screenshot provided
    const userMessage: any = screenshotDataUrl
      ? { role: 'user', content: [
          { type: 'text', text: message },
          { type: 'image_url', image_url: { url: screenshotDataUrl } },
        ]}
      : { role: 'user', content: message }

    const messages: any[] = [
      { role: 'system', content: systemPrompt + contextBlock },
      ...history,
      userMessage,
    ]

    // Conversation tracer
    const totalTokensEstimate = messages.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + Math.ceil(m.content.length / 4)
      if (Array.isArray(m.content)) {
        return sum + m.content.reduce((s: number, part: any) => {
          if (part.type === 'text') return s + Math.ceil(part.text.length / 4)
          if (part.type === 'image_url') return s + 765
          return s
        }, 0)
      }
      return sum
    }, 0)
    console.log(`[MinionRouter] ═══ CHAT ROUTE ═══`)
    console.log(`[MinionRouter] Endpoint: ${endpoint.baseUrl}/chat/completions`)
    console.log(`[MinionRouter] Model: ${endpoint.modelId}`)
    console.log(`[MinionRouter] Vision: ${screenshotDataUrl ? 'YES (' + Math.round(screenshotDataUrl.length / 1024) + 'KB)' : 'no'}`)
    console.log(`[MinionRouter] Messages: ${messages.length} (est ~${totalTokensEstimate} tokens)`)
    console.log(`[MinionRouter] Activity context: ${recentActivity.length} entries`)
    messages.forEach((m, i) => {
      const content = typeof m.content === 'string' ? m.content : '[multimodal: text + image]'
      const preview = content.length > 150 ? content.substring(0, 150) + '...' : content
      console.log(`[MinionRouter]   [${i}] ${m.role}: ${preview} (${typeof m.content === 'string' ? m.content.length : 'multimodal'} chars)`)
    })
    console.log(`[MinionRouter] ══════════════════`)

    // Set up abort controller
    this.abortControllers.get('chat')?.abort()
    const abortController = new AbortController()
    this.abortControllers.set('chat', abortController)

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
        console.error(`[MinionRouter] Chat API error:`, err)
        if (chatMinion) this.store.updateMinionStatus(chatMinion.id, 'error', `API ${resp.status}`)
        injectChatMessage('assistant', `**[Chat ✗ Error]**\n\nAPI error ${resp.status}: ${err.substring(0, 200)}`, {
          modelName: chatMinion?.friendlyName || 'Chat',
        })
        return
      }

      const data = await resp.json()
      const choice = data.choices?.[0]
      const rawResponse = choice?.message?.content || 'No response'

      // Extract route tags BEFORE parsing (model may put them inside think blocks)
      const { route: rawRoute } = extractRouteTag(rawResponse)

      // Parse response — extract thinking, summary, body
      const parsed = parseMinionResponse(rawResponse)

      // Check for route tags in the clean body as well (belt and suspenders)
      const { route: bodyRoute, cleanText } = extractRouteTag(parsed.body)
      const route = bodyRoute || rawRoute

      // Log routing result for debugging
      if (route) {
        console.log(`[MinionRouter] Route tag found: ${route.role} — "${route.message.substring(0, 80)}..."`)
        console.log(`[MinionRouter] Route source: ${bodyRoute ? 'body' : 'raw (inside think block)'}`)
      } else {
        // Check if the model mentioned routing without using the tag
        const mentionsRouting = rawResponse.match(/route|coder|specialist|dispatch/i)
        if (mentionsRouting) {
          console.warn(`[MinionRouter] Chat mentioned routing but no <route> tag found in response`)
          console.warn(`[MinionRouter] Raw response (last 300 chars): ${rawResponse.slice(-300)}`)
        }
      }

      // Update conversation history with the clean text (no route tags)
      addToRoleHistory('chat', { role: 'user', content: message })
      addToRoleHistory('chat', { role: 'assistant', content: cleanText })

      // Update card status
      if (chatMinion) this.store.updateMinionStatus(chatMinion.id, 'idle')

      // Add to activity feed
      const chatName = chatMinion?.friendlyName || 'Chat'
      this.store.addMessage({
        from: chatName,
        to: 'user',
        type: 'summary',
        content: parsed.summary,
        metadata: { status: 'completed', hasRoute: !!route },
      })

      // Inject chat's response into main chat
      injectChatMessage('assistant', `**[${chatName} ✓]**\n\n${cleanText}`, {
        modelName: chatName,
        minionParsed: true,
        minionSummary: parsed.summary,
        minionThinking: parsed.thinking,
        minionTo: 'user',
      })

      // Auto-TTS: speak the clean text (no thinking, no route tags)
      if (isTtsEnabled()) speakText(cleanText, 'chat')

      // If chat dispatched to a specialist, fire that off in the background
      if (route) {
        console.log(`[MinionRouter] Chat dispatched to ${route.role}: ${route.message.substring(0, 80)}...`)
        // Don't await — specialist works in background while user sees chat's response
        this.sendToSpecialist(route.role, route.message, {
          showUserMessage: false,
          dispatchedBy: chatName,
          screenshotDataUrl,
        })
      }

    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(`[MinionRouter] Chat request cancelled`)
      } else {
        console.error(`[MinionRouter] Chat fetch error:`, err)
        if (chatMinion) this.store.updateMinionStatus(chatMinion.id, 'error', err.message)
        injectChatMessage('assistant', `**[Chat ✗ Error]**\n\n${err.message}`, {
          modelName: chatMinion?.friendlyName || 'Chat',
        })
      }
    } finally {
      this.abortControllers.delete('chat')
    }
  }

  /**
   * @deprecated Use routeViaChat instead. Kept for backwards compatibility.
   */
  async routeViaOrchestrator(message: string, screenshotDataUrl?: string): Promise<void> {
    return this.routeViaChat(message, screenshotDataUrl)
  }

  dispose(): void {
    // No polling needed — direct API calls
  }
}
