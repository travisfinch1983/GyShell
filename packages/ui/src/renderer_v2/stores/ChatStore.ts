import { makeObservable, observable, action, runInAction, computed, ObservableMap } from 'mobx'
import { v4 as uuidv4 } from 'uuid'
import { ChatQueueStore, type QueueItem } from './ChatQueueStore'
import type { InputImageAttachment, UserInputPayload } from '../lib/userInput'

const buildAutoSessionTitle = (content: string): string => {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim()
  return normalized || 'New Chat'
}

export type MessageType =
  | 'text'
  | 'command'
  | 'tool_call'
  | 'file_edit'
  | 'sub_tool'
  | 'reasoning'
  | 'compaction'
  | 'alert'
  | 'error'
  | 'ask'
  | 'tokens_count'

export interface ChatMessage {
  id: string
  backendMessageId?: string
  role: 'user' | 'assistant' | 'system'
  type: MessageType
  content: string
  metadata?: {
    tabName?: string
    commandId?: string
    exitCode?: number
    output?: string
    diff?: string
    filePath?: string
    action?: 'created' | 'edited' | 'error'
    collapsed?: boolean
    isNowait?: boolean
    toolName?: string
    subToolTitle?: string
    subToolHint?: string
    subToolLevel?: 'info' | 'warning' | 'error'
    approvalId?: string
    decision?: 'allow' | 'deny'
    command?: string
    modelName?: string
    totalTokens?: number
    maxTokens?: number
    details?: string
    inputKind?: 'normal' | 'inserted'
    inputImages?: InputImageAttachment[]
    // Minion parsed message fields
    minionParsed?: boolean
    minionSummary?: string
    minionThinking?: string | null
    minionTo?: string
    minionCodeBlocks?: string[]
  }
  timestamp: number
  streaming?: boolean
}

export interface ChatSession {
  id: string
  title: string
  messagesById: ObservableMap<string, ChatMessage>
  messageIds: string[]
  renderListVersion: number
  isThinking: boolean
  isSessionBusy: boolean
  lockedProfileId: string | null
}

interface ChatHydrationPayload {
  id: string
  exists: boolean
  loaded: boolean
  title: string | null
  messages: ChatMessage[]
  isBusy: boolean
  lockedProfileId: string | null
}

export class ChatStore {
  sessions: ChatSession[] = []
  sessionInventoryHydrated = false
  activeSessionId: string | null = null
  queue = new ChatQueueStore()
  private queueRunner?: (sessionId: string, input: UserInputPayload) => Promise<boolean>
  private sessionsChangedListener?: (sessionIds: string[]) => void

  constructor() {
    makeObservable(this, {
      sessions: observable,
      sessionInventoryHydrated: observable,
      activeSessionId: observable,
      activeSession: computed,
      activeSessionLatestTokens: computed,
      activeSessionLatestMaxTokens: computed,
      hydrateSessionInventoryFromLayout: action,
      hydrateSessionsFromBackend: action,
      createSession: action,
      ensureSession: action,
      setActiveSession: action,
      closeSession: action,
      addMessage: action,
      updateMessage: action,
      removeMessage: action,
      setThinking: action,
      setSessionBusy: action,
      clear: action,
      handleUiUpdate: action,
      hydrateSessionFromBackend: action,
      loadChatHistory: action,
      deleteChatSession: action,
      renameChatSession: action,
      rollbackToMessage: action,
      setSessionLockedProfile: action,
      setQueueRunner: action,
      setSessionsChangedListener: action,
      setQueueMode: action,
      startQueue: action,
      stopQueue: action,
      addQueueItem: action,
      removeQueueItem: action,
      moveQueueItem: action
    })

    // Create default session
    this.createSession('New Chat')
  }

  private createEmptySession(id: string, title: string): ChatSession {
    return {
      id,
      title,
      messagesById: observable.map<string, ChatMessage>(),
      messageIds: [],
      renderListVersion: 0,
      isThinking: false,
      isSessionBusy: false,
      lockedProfileId: null
    }
  }

  private bumpSessionRenderListVersion(session: ChatSession): void {
    session.renderListVersion += 1
  }

  get activeSession(): ChatSession | null {
    return this.sessions.find(s => s.id === this.activeSessionId) || null
  }

  get activeSessionLatestTokens(): number {
    return this.getLatestTokens(this.activeSessionId)
  }

  get activeSessionLatestMaxTokens(): number {
    return this.getLatestMaxTokens(this.activeSessionId)
  }

  getLatestTokens(sessionId: string | null): number {
    const session = this.getSessionById(sessionId)
    if (!session) return 0
    for (let i = session.messageIds.length - 1; i >= 0; i--) {
      const msg = session.messagesById.get(session.messageIds[i])
      if (msg && msg.type === 'tokens_count') {
        return msg.metadata?.totalTokens || 0
      }
    }
    return 0
  }

  getLatestMaxTokens(sessionId: string | null): number {
    const session = this.getSessionById(sessionId)
    if (!session) return 0
    for (let i = session.messageIds.length - 1; i >= 0; i--) {
      const msg = session.messagesById.get(session.messageIds[i])
      if (msg && msg.type === 'tokens_count') {
        return msg.metadata?.maxTokens || 0
      }
    }
    return 0
  }

  getSessionById(sessionId: string | null): ChatSession | null {
    if (!sessionId) return null
    return this.sessions.find((session) => session.id === sessionId) || null
  }

  setSessionsChangedListener(listener?: (sessionIds: string[]) => void): void {
    this.sessionsChangedListener = listener
  }

  private emitSessionsChanged(): void {
    this.sessionsChangedListener?.(this.sessions.map((session) => session.id))
  }

  hydrateSessionInventoryFromLayout(
    sessionIds: string[],
    preferredActiveSessionId?: string | null
  ): void {
    const ids = Array.from(new Set((sessionIds || []).filter((id) => typeof id === 'string' && id.length > 0)))
    if (ids.length === 0) {
      this.sessionInventoryHydrated = true
      return
    }

    const existingById = new Map(this.sessions.map((session) => [session.id, session]))
    const nextSessions = ids.map((id) => existingById.get(id) || this.createEmptySession(id, 'New Chat'))
    this.sessions = nextSessions
    const normalizedPreferredActiveId =
      typeof preferredActiveSessionId === 'string' && preferredActiveSessionId.length > 0
        ? preferredActiveSessionId
        : null
    const preferredActiveExists = !!normalizedPreferredActiveId && nextSessions.some((session) => session.id === normalizedPreferredActiveId)
    const currentActiveExists =
      !!this.activeSessionId && nextSessions.some((session) => session.id === this.activeSessionId)

    if (preferredActiveExists) {
      this.activeSessionId = normalizedPreferredActiveId
    } else if (!currentActiveExists) {
      this.activeSessionId = nextSessions[0]?.id || null
    }
    this.sessionInventoryHydrated = true
  }

  private async resolveHydrationPayload(
    sessionId: string,
    fallbackTitle?: string | null
  ): Promise<ChatHydrationPayload> {
    let messages: ChatMessage[] = []
    let runtimeSnapshot:
      | Awaited<ReturnType<Window['gyshell']['agent']['getSessionSnapshot']>>
      | null = null

    try {
      const messagesRaw = await window.gyshell.agent.getUiMessages(sessionId)
      messages = Array.isArray(messagesRaw)
        ? (messagesRaw.filter((item) => item && typeof item.id === 'string') as ChatMessage[])
        : []
    } catch (error) {
      console.warn(`Failed to read UI messages for chat session ${sessionId}:`, error)
    }

    try {
      runtimeSnapshot = await window.gyshell.agent.getSessionSnapshot(sessionId)
    } catch (error) {
      console.warn(`Failed to read session snapshot for chat session ${sessionId}:`, error)
    }

    const normalizedFallbackTitle =
      typeof fallbackTitle === 'string' && fallbackTitle.trim().length > 0
        ? fallbackTitle.trim()
        : null
    const resolvedTitle = runtimeSnapshot?.title || normalizedFallbackTitle
    const exists = !!runtimeSnapshot || messages.length > 0 || !!resolvedTitle

    return {
      id: sessionId,
      exists,
      loaded: !!runtimeSnapshot || messages.length > 0,
      title: resolvedTitle,
      messages,
      isBusy: runtimeSnapshot?.isBusy === true,
      lockedProfileId: runtimeSnapshot?.lockedProfileId || null
    }
  }

  async hydrateSessionsFromBackend(
    sessionIds: string[],
    preferredActiveSessionId?: string | null
  ): Promise<void> {
    const ids = Array.from(new Set((sessionIds || []).filter((id) => typeof id === 'string' && id.length > 0)))
    if (ids.length === 0) return

    const allHistory = await this.getAllChatHistory()
    const titleById = new Map<string, string>()
    allHistory.forEach((item) => {
      if (!item || typeof item.id !== 'string') return
      if (typeof item.title !== 'string' || item.title.length === 0) return
      titleById.set(item.id, item.title)
    })

    const sessionPayloads = await Promise.all(
      ids.map((id) => this.resolveHydrationPayload(id, titleById.get(id)))
    )
    const payloadById = new Map(sessionPayloads.map((payload) => [payload.id, payload]))

    runInAction(() => {
      const existingById = new Map(this.sessions.map((session) => [session.id, session]))
      const nextSessions = ids
        .map((id) => {
          const existing = existingById.get(id) || this.createEmptySession(id, 'New Chat')
          const payload = payloadById.get(id)
          if (!payload) return existing
          if (!payload.exists) {
            return null
          }

          if (payload.loaded) {
            existing.messagesById.clear()
            existing.messageIds = []
            payload.messages.forEach((message) => {
              existing.messagesById.set(message.id, message)
              existing.messageIds.push(message.id)
            })
            this.bumpSessionRenderListVersion(existing)
            existing.isThinking = payload.isBusy
            existing.isSessionBusy = payload.isBusy
            existing.lockedProfileId = payload.lockedProfileId
          }

          if (payload.title && payload.title.length > 0) {
            existing.title = payload.title
          }

          return existing
        })
        .filter((session): session is ChatSession => session !== null)

      const resolvedSessions =
        nextSessions.length > 0
          ? nextSessions
          : [this.createEmptySession(uuidv4(), 'New Chat')]
      this.sessions = resolvedSessions

      const normalizedPreferredActiveId =
        typeof preferredActiveSessionId === 'string' && preferredActiveSessionId.length > 0
          ? preferredActiveSessionId
          : null
      const preferredExists =
        !!normalizedPreferredActiveId && resolvedSessions.some((session) => session.id === normalizedPreferredActiveId)
      const currentExists =
        !!this.activeSessionId && resolvedSessions.some((session) => session.id === this.activeSessionId)

      if (preferredExists) {
        this.activeSessionId = normalizedPreferredActiveId
      } else if (!currentExists) {
        this.activeSessionId = resolvedSessions[0]?.id || null
      }
      this.sessionInventoryHydrated = true
    })
    this.emitSessionsChanged()

    if (this.activeSessionId) {
      try {
        await window.gyshell.agent.loadChatSession(this.activeSessionId)
      } catch (error) {
        console.warn(`Failed to load active chat session ${this.activeSessionId}:`, error)
      }
    }
  }

  createSession(title: string = 'New Chat'): string {
    const id = uuidv4()
    const session = this.createEmptySession(id, title)
    runInAction(() => {
      this.sessions.push(session)
      this.activeSessionId = id
    })
    this.emitSessionsChanged()
    return id
  }

  ensureSession(id: string, title: string = 'New Chat'): void {
    const normalizedId = String(id || '').trim()
    if (!normalizedId) {
      return
    }
    if (this.getSessionById(normalizedId)) {
      return
    }
    const normalizedTitle = String(title || '').trim() || 'New Chat'
    const session = this.createEmptySession(normalizedId, normalizedTitle)
    runInAction(() => {
      this.sessions.push(session)
    })
    this.emitSessionsChanged()
  }

  setActiveSession(id: string) {
    this.activeSessionId = id
  }

  closeSession(id: string) {
    const idx = this.sessions.findIndex(s => s.id === id)
    if (idx === -1) return

    const nextSessions = this.sessions.filter(s => s.id !== id)
    let nextActiveId = this.activeSessionId

    if (this.activeSessionId === id) {
        nextActiveId = nextSessions[idx - 1]?.id || nextSessions[0]?.id || null
    }

    runInAction(() => {
        this.sessions = nextSessions
        this.activeSessionId = nextActiveId
    })
    this.queue.clearSession(id)

    if (this.sessions.length === 0) {
      this.createSession()
      return
    }
    this.emitSessionsChanged()
  }

  addMessage(msg: Omit<ChatMessage, 'id' | 'timestamp'>, sessionId: string): string {
    const id = uuidv4()
    const fullMsg: ChatMessage = {
      ...msg,
      id,
      timestamp: Date.now()
    }
    
    runInAction(() => {
      const session = this.sessions.find(s => s.id === sessionId)
      if (session) {
        session.messagesById.set(id, fullMsg)
        session.messageIds.push(id)
        this.bumpSessionRenderListVersion(session)
        // Auto-update title based on first user message if title is default
        if (msg.role === 'user') {
          const userMsgCount = session.messageIds.filter(msgId => {
            const m = session.messagesById.get(msgId)
            return m && m.role === 'user'
          }).length
          if (userMsgCount === 1) {
            session.title = buildAutoSessionTitle(msg.content)
          }
        }
      }
    })
    return id
  }

  updateMessage(id: string, patch: Partial<ChatMessage>, sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return

    const msg = session.messagesById.get(id)
    if (msg) {
      runInAction(() => {
        Object.assign(msg, patch)
        this.bumpSessionRenderListVersion(session)
      })
    }
  }

  removeMessage(id: string, sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return
    runInAction(() => {
      session.messagesById.delete(id)
      session.messageIds = session.messageIds.filter(msgId => msgId !== id)
      this.bumpSessionRenderListVersion(session)
    })
  }

  setThinking(thinking: boolean, sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (session) {
        runInAction(() => {
            session.isThinking = thinking
        })
    }
  }

  setSessionBusy(busy: boolean, sessionId: string) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (session) {
        runInAction(() => {
            session.isSessionBusy = busy
        })
    }
  }

  setSessionLockedProfile(sessionId: string, profileId: string | null) {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return
    runInAction(() => {
      session.lockedProfileId = profileId
    })
  }

  clear() {
    if (!this.activeSessionId) return
    const session = this.sessions.find(s => s.id === this.activeSessionId)
    if (session) {
        runInAction(() => {
            session.messagesById.clear()
            session.messageIds = []
            this.bumpSessionRenderListVersion(session)
        })
    }
  }

  handleUiUpdate(update: any) {
    const { type, sessionId } = update
    const session = this.sessions.find((s) => s.id === sessionId)
    if (!session) {
      // Do not create a synthetic session from live updates.
      // If the session is not currently opened in the UI, keep UI stable and let
      // users load the real session explicitly from history.
      return
    }

    runInAction(() => {
      switch (type) {
        case 'ADD_MESSAGE': {
          const msg = update.message
          if (!msg || typeof msg.id !== 'string' || msg.id.length === 0) {
            break
          }
          const existed = session.messagesById.has(msg.id)
          session.messagesById.set(msg.id, msg)
          if (!existed) {
            session.messageIds.push(msg.id)
            this.bumpSessionRenderListVersion(session)
          }
          // Auto-update title logic if needed (backend also does this, but for UX we can do it here too)
          if (!existed && msg.role === 'user') {
            const userMsgCount = session.messageIds.filter(msgId => {
              const m = session.messagesById.get(msgId)
              return m && m.role === 'user'
            }).length
            if (userMsgCount === 1) {
              session.title = buildAutoSessionTitle(msg.content)
            }
          }
          break
        }
        case 'REMOVE_MESSAGE': {
          session.messagesById.delete(update.messageId)
          session.messageIds = session.messageIds.filter((id) => id !== update.messageId)
          this.bumpSessionRenderListVersion(session)
          break
        }
        case 'APPEND_CONTENT': {
          const msg = session.messagesById.get(update.messageId)
          if (msg) {
            msg.content += update.content
          }
          break
        }
        case 'APPEND_OUTPUT': {
          const msg = session.messagesById.get(update.messageId)
          if (msg) {
            msg.metadata = { ...(msg.metadata || {}), output: (msg.metadata?.output || '') + (update.outputDelta || '') }
          }
          break
        }
        case 'UPDATE_MESSAGE': {
          const msg = session.messagesById.get(update.messageId)
          if (msg) {
            Object.assign(msg, update.patch)
            this.bumpSessionRenderListVersion(session)
          }
          break
        }
        case 'DONE':
          session.isThinking = false
          break
        case 'SESSION_PROFILE_LOCKED':
          session.isSessionBusy = true
          session.lockedProfileId = update.lockedProfileId || null
          break
        case 'SESSION_READY':
          session.isSessionBusy = false
          session.lockedProfileId = null
          if (this.queue.shouldDispatchNextOnSessionReady(sessionId)) {
            void this.runNextQueueItem(sessionId)
          }
          break
        case 'ROLLBACK': {
          const rollbackIndex = session.messageIds.findIndex((messageId) => {
            const message = session.messagesById.get(messageId)
            return message?.backendMessageId === update.messageId
          })
          if (rollbackIndex !== -1) {
            const removedIds = session.messageIds.slice(rollbackIndex)
            removedIds.forEach((messageId) => session.messagesById.delete(messageId))
            session.messageIds = session.messageIds.slice(0, rollbackIndex)
            this.bumpSessionRenderListVersion(session)
          }
          session.isThinking = false
          session.isSessionBusy = false
          session.lockedProfileId = null
          break
        }
      }
    })

    if (type === 'ADD_MESSAGE' && update.message?.role === 'user') {
      runInAction(() => {
        session.isThinking = true
        session.isSessionBusy = true
      })
    }

    if (type === 'ADD_MESSAGE' && update.message?.type === 'error') {
      this.stopQueue(sessionId)
      return
    }
  }

  async hydrateSessionFromBackend(
    sessionId: string,
    options?: {
      activate?: boolean
      loadAgentContext?: boolean
    }
  ): Promise<void> {
    try {
      // Get all history first to find the title
      const allHistory = await this.getAllChatHistory()
      const sessionInfo = allHistory.find(h => h.id === sessionId)
      const payload = await this.resolveHydrationPayload(sessionId, sessionInfo?.title)
      if (!payload.exists) {
        throw new Error(`Session not found: ${sessionId}`)
      }
      
      runInAction(() => {
        const existingSession = this.sessions.find(s => s.id === sessionId)
        if (existingSession) {
          // Convert array to Map + IDs
          existingSession.messagesById.clear()
          existingSession.messageIds = []
          payload.messages.forEach(msg => {
            existingSession.messagesById.set(msg.id, msg)
            existingSession.messageIds.push(msg.id)
          })
          this.bumpSessionRenderListVersion(existingSession)
          existingSession.isThinking = payload.isBusy
          existingSession.isSessionBusy = payload.isBusy
          existingSession.lockedProfileId = payload.lockedProfileId
          if (payload.title) {
            existingSession.title = payload.title
          }
        } else {
          const messagesById = observable.map<string, ChatMessage>()
          const messageIds: string[] = []
          payload.messages.forEach(msg => {
            messagesById.set(msg.id, msg)
            messageIds.push(msg.id)
          })
          this.sessions.push({
            id: sessionId,
            title: payload.title || 'Loaded Session',
            messagesById,
            messageIds,
            renderListVersion: 0,
            isThinking: payload.isBusy,
            isSessionBusy: payload.isBusy,
            lockedProfileId: payload.lockedProfileId
          })
        }

        if (options?.activate !== false) {
          this.activeSessionId = sessionId
        }
      })
      this.emitSessionsChanged()

      if (options?.loadAgentContext !== false) {
        // Also load backend session for agent context when the caller is doing
        // a user-visible navigation to this session.
        await window.gyshell.agent.loadChatSession(sessionId)
      }
    } catch (error) {
      console.error('Failed to load chat history:', error)
      throw error
    }
  }

  async loadChatHistory(
    sessionId: string,
    options?: {
      activate?: boolean
      loadAgentContext?: boolean
    }
  ): Promise<void> {
    await this.hydrateSessionFromBackend(sessionId, {
      activate: options?.activate !== false,
      loadAgentContext: options?.loadAgentContext !== false
    })
  }

  async getAllChatHistory(): Promise<any[]> {
    try {
      // Get backend sessions for all available sessions
      return await window.gyshell.agent.getAllChatHistory()
    } catch (error) {
      console.error('Failed to get chat history:', error)
      return []
    }
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    try {
      await window.gyshell.agent.deleteChatSession(sessionId)
      
      runInAction(() => {
        const wasActive = this.activeSessionId === sessionId
        this.sessions = this.sessions.filter(s => s.id !== sessionId)
        
        if (wasActive) {
          // If we deleted the active session, we need a new active session
          // But we don't necessarily want to trigger UI navigation if we're in a modal
          if (this.sessions.length > 0) {
            this.activeSessionId = this.sessions[0].id
          }
        }
      })
      this.queue.clearSession(sessionId)
      if (this.sessions.length === 0) {
        this.createSession()
        return
      }
      this.emitSessionsChanged()
    } catch (error) {
      console.error('Failed to delete chat session:', error)
      throw error
    }
  }

  async renameChatSession(sessionId: string, newTitle: string): Promise<void> {
    try {
      await window.gyshell.agent.renameSession(sessionId, newTitle)
      runInAction(() => {
        const session = this.sessions.find(s => s.id === sessionId)
        if (session) {
          session.title = newTitle
        }
      })
    } catch (error) {
      console.error('Failed to rename chat session:', error)
      throw error
    }
  }

  rollbackToMessage(sessionId: string, backendMessageId: string): void {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return
    
    // Find the index of the message to rollback to
    const idx = session.messageIds.findIndex(msgId => {
      const msg = session.messagesById.get(msgId)
      return msg && msg.backendMessageId === backendMessageId
    })
    if (idx === -1) return

    runInAction(() => {
      // Remove messages after the rollback point
      const keptIds = session.messageIds.slice(0, idx)
      const removedIds = session.messageIds.slice(idx)
      
      // Delete from Map
      removedIds.forEach(msgId => session.messagesById.delete(msgId))
      
      // Update IDs array
      session.messageIds = keptIds
      this.bumpSessionRenderListVersion(session)
      session.isThinking = false
    })
  }

  setQueueRunner(runner: (sessionId: string, input: UserInputPayload) => Promise<boolean>): void {
    this.queueRunner = runner
  }

  setQueueMode(sessionId: string, enabled: boolean): void {
    this.queue.setQueueMode(enabled, sessionId)
    const session = this.sessions.find(s => s.id === sessionId)
    const isBusy = !!session?.isSessionBusy
    if (enabled) {
      if (isBusy) {
        // Inherit active run from normal mode; queue continues seamlessly after current run.
        this.queue.startRun(sessionId)
      } else {
        this.queue.stopRun(sessionId)
      }
      return
    }
    if (isBusy && this.queue.isRunning(sessionId)) {
      // Switching to normal while queue is running: finish current run, then stop queue dispatch.
      this.queue.requestStopAfterCurrent(sessionId)
    } else {
      this.queue.stopRun(sessionId)
    }
  }

  addQueueItem(sessionId: string, content: string, images?: InputImageAttachment[]): QueueItem | null {
    const trimmed = String(content || '').trim()
    const normalizedImages = Array.isArray(images)
      ? images.filter((item) => {
          const hasAttachmentId = !!String(item?.attachmentId || '').trim()
          const hasLocalFile = (item as any)?.localFile instanceof File
          return hasAttachmentId || hasLocalFile
        })
      : []
    if (!trimmed && normalizedImages.length === 0) return null
    return this.queue.addItem(sessionId, trimmed, normalizedImages)
  }

  removeQueueItem(sessionId: string, itemId: string): void {
    this.queue.removeItem(sessionId, itemId)
  }

  moveQueueItem(sessionId: string, fromIndex: number, toIndex: number): void {
    this.queue.moveItem(sessionId, fromIndex, toIndex)
  }

  startQueue(sessionId: string): void {
    if (this.queue.isRunning(sessionId)) return
    if (this.queue.getQueue(sessionId).length === 0) return
    this.queue.startRun(sessionId)
    void this.runNextQueueItem(sessionId)
  }

  stopQueue(sessionId: string): void {
    if (!sessionId) return
    this.queue.stopRun(sessionId)
  }

  private async runNextQueueItem(sessionId: string): Promise<void> {
    const next = this.queue.shiftItem(sessionId)
    if (!next) {
      this.queue.stopRun(sessionId)
      return
    }
    if (!this.queue.isRunning(sessionId)) {
      this.queue.unshiftItem(sessionId, next)
      return
    }
    if (
      !this.queueRunner ||
      !(await this.queueRunner(sessionId, {
        text: next.content,
        ...(Array.isArray(next.images) && next.images.length > 0 ? { images: next.images } : {})
      }))
    ) {
      this.queue.unshiftItem(sessionId, next)
      this.queue.stopRun(sessionId)
      return
    }
  }
}
