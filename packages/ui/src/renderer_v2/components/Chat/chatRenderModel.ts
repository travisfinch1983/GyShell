import type { ChatMessage, ChatSession } from '../../stores/ChatStore'

export type ChatVisibleRowKind = 'assistant' | 'user'

export interface ChatRenderItem {
  id: string
  kind: ChatVisibleRowKind
  estimatedHeight: number
  mergeWithPreviousAssistant: boolean
  showAssistantGroupCopy: boolean
  assistantGroupMessageIds: string[]
  // Seamless mode: when set, this item represents a group of tool-call messages
  seamlessGroupMessageIds?: string[]
  // Seamless mode: true if any message in the group is currently streaming
  seamlessGroupStreaming?: boolean
}

type RowDisplayKind = ChatVisibleRowKind | 'hidden'

interface VisibleRow {
  id: string
  kind: ChatVisibleRowKind
  msg: ChatMessage
}

const SPECIAL_ASSISTANT_TYPES: ReadonlySet<ChatMessage['type']> = new Set([
  'command',
  'tool_call',
  'file_edit',
  'sub_tool',
  'reasoning',
  'compaction',
  'ask',
  'alert',
  'error',
])

// Message types that are grouped into a single seamless tool-activity banner
const SEAMLESS_TOOL_TYPES: ReadonlySet<ChatMessage['type']> = new Set([
  'command',
  'tool_call',
  'file_edit',
  'sub_tool',
])

const isCompletedWhitespaceAssistantText = (message: ChatMessage): boolean =>
  message.role === 'assistant' &&
  message.type === 'text' &&
  message.streaming !== true &&
  !/\S/.test(String(message.content || ''))

const isSeamlessOverlayMessage = (
  message: ChatMessage,
  lastMessageId: string | null,
): boolean => {
  if (message.type === 'ask' || message.type === 'error') return true
  if (message.type === 'alert') {
    if (message.metadata?.subToolLevel === 'info') {
      return message.id === lastMessageId
    }
    return true
  }
  return false
}

const isHiddenTailMessage = (message: ChatMessage): boolean =>
  message.type === 'tokens_count' || isCompletedWhitespaceAssistantText(message)

export const resolveSeamlessOverlayMessages = (
  session: ChatSession | null,
): ChatMessage[] => {
  if (!session) return []

  const lastMessageId =
    session.messageIds.length > 0
      ? session.messageIds[session.messageIds.length - 1]
      : null
  const overlayMessages: ChatMessage[] = []

  for (let index = session.messageIds.length - 1; index >= 0; index -= 1) {
    const messageId = session.messageIds[index]
    const message = session.messagesById.get(messageId)
    if (!message) continue
    if (isHiddenTailMessage(message)) continue
    if (!isSeamlessOverlayMessage(message, lastMessageId)) break
    overlayMessages.unshift(message)
  }

  return overlayMessages
}

const getRowDisplayKind = (
  session: ChatSession,
  messageId: string,
  lastMessageId: string | null,
): RowDisplayKind => {
  const candidate = session.messagesById.get(messageId)
  if (!candidate) return 'hidden'
  if (candidate.type === 'tokens_count') return 'hidden'
  if (candidate.role === 'user') return 'user'
  if (isCompletedWhitespaceAssistantText(candidate)) return 'hidden'

  const isLastInSession = lastMessageId === messageId
  const isRetryHint =
    candidate.type === 'alert' && candidate.metadata?.subToolLevel === 'info'
  if (isRetryHint && !isLastInSession) return 'hidden'
  // Compaction banners are large summarization payloads — only keep the
  // most recent one so they don't clutter scrollback. Reasoning blocks
  // stay visible for their entire history so the user can see what the
  // model was thinking before each tool call. (The earlier filter that
  // also hid older reasoning was the culprit behind reasoning appearing
  // to "vanish" the moment the model emitted a follow-up tool call.)
  if (candidate.type === 'compaction' && !isLastInSession) {
    return 'hidden'
  }
  if (SPECIAL_ASSISTANT_TYPES.has(candidate.type)) return 'assistant'
  return candidate.role === 'assistant' ? 'assistant' : 'hidden'
}

const estimateRowHeight = (
  message: ChatMessage,
  kind: ChatVisibleRowKind,
): number => {
  if (kind === 'user') {
    return Array.isArray(message.metadata?.inputImages) &&
      message.metadata.inputImages.length > 0
      ? 156
      : 92
  }

  switch (message.type) {
    case 'command':
      return 168
    case 'tool_call':
      return 150
    case 'file_edit':
      return 176
    case 'sub_tool':
    case 'reasoning':
    case 'compaction':
      return 160
    case 'ask':
      return 132
    case 'alert':
    case 'error':
      return 118
    default:
      return 140
  }
}

export const buildChatRenderItems = (
  session: ChatSession | null,
  isThinking: boolean,
  displayMode: 'classic' | 'seamless' = 'classic',
): ChatRenderItem[] => {
  if (!session) return []

  const visibleRows: VisibleRow[] = []
  const lastMessageId =
    session.messageIds.length > 0
      ? session.messageIds[session.messageIds.length - 1]
      : null

  session.messageIds.forEach((messageId) => {
    const msg = session.messagesById.get(messageId)
    if (!msg) return

    // In seamless mode, overlay types (ask/alert/error) are shown in the
    // floating overlay above the input area, not inline in the message list.
    if (
      displayMode === 'seamless' &&
      isSeamlessOverlayMessage(msg, lastMessageId)
    ) {
      return
    }

    const kind = getRowDisplayKind(session, messageId, lastMessageId)
    if (kind === 'hidden') return

    visibleRows.push({
      id: messageId,
      kind,
      msg,
    })
  })

  const items: ChatRenderItem[] = []
  let visibleIndex = 0
  while (visibleIndex < visibleRows.length) {
    const row = visibleRows[visibleIndex]
    if (row.kind !== 'assistant') {
      items.push({
        id: row.id,
        kind: row.kind,
        estimatedHeight: estimateRowHeight(row.msg, row.kind),
        mergeWithPreviousAssistant: false,
        showAssistantGroupCopy: false,
        assistantGroupMessageIds: [],
      })
      visibleIndex += 1
      continue
    }

    // In seamless mode, group consecutive tool-call messages into one render item
    if (displayMode === 'seamless' && SEAMLESS_TOOL_TYPES.has(row.msg.type)) {
      const groupFirstId = row.id
      const seamlessGroupMessageIds: string[] = [row.id]
      let isGroupStreaming = !!row.msg.streaming

      while (
        visibleIndex + 1 < visibleRows.length &&
        visibleRows[visibleIndex + 1].kind === 'assistant' &&
        SEAMLESS_TOOL_TYPES.has(visibleRows[visibleIndex + 1].msg.type)
      ) {
        visibleIndex += 1
        const nextRow = visibleRows[visibleIndex]
        seamlessGroupMessageIds.push(nextRow.id)
        if (nextRow.msg.streaming) isGroupStreaming = true
      }

      // Merge if this is not the first assistant item in the turn.
      const prevIsAssistant = items.length > 0 && items[items.length - 1].kind === 'assistant'

      items.push({
        id: groupFirstId,
        kind: 'assistant',
        estimatedHeight: 48 + seamlessGroupMessageIds.length * 22,
        mergeWithPreviousAssistant: prevIsAssistant,
        showAssistantGroupCopy: false,
        assistantGroupMessageIds: [],
        seamlessGroupMessageIds,
        seamlessGroupStreaming: isGroupStreaming,
      })

      visibleIndex += 1
      continue
    }

    const runStart = visibleIndex
    const assistantGroupMessageIds: string[] = [row.id]
    while (
      visibleIndex + 1 < visibleRows.length &&
      visibleRows[visibleIndex + 1].kind === 'assistant' &&
      // In seamless mode, don't extend a run into tool types (they're grouped separately)
      !(displayMode === 'seamless' && SEAMLESS_TOOL_TYPES.has(visibleRows[visibleIndex + 1].msg.type))
    ) {
      visibleIndex += 1
      assistantGroupMessageIds.push(visibleRows[visibleIndex].id)
    }

    const runEnd = visibleIndex
    const nextVisibleRow = visibleRows[runEnd + 1]
    const nextVisibleKind = nextVisibleRow?.kind ?? null
    const runMessages = visibleRows.slice(runStart, runEnd + 1).map((entry) => entry.msg)
    const canShowGroupCopy =
      runMessages.length > 0 &&
      runMessages.every((message) => !message.streaming) &&
      (nextVisibleKind === 'user' ||
        (!nextVisibleRow && !isThinking))

    // In seamless mode, the ASSISTANT label is shown on the first item in each
    // AI turn (whether tool group or text). Check if any prior assistant item
    // in this turn already received the label.
    // In classic mode, only text messages render the label so this is always false.
    const turnAlreadyHasLabel = displayMode === 'seamless' && (() => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === 'user') return false
        if (items[i].kind === 'assistant') return true
      }
      return false
    })()
    let firstTextLabelShown = !!turnAlreadyHasLabel
    for (let index = runStart; index <= runEnd; index += 1) {
      const assistantRow = visibleRows[index]
      const isTextType = !SPECIAL_ASSISTANT_TYPES.has(assistantRow.msg.type)

      // Show the ASSISTANT label on the first text message in this turn
      let shouldMerge: boolean
      if (isTextType && !firstTextLabelShown) {
        shouldMerge = false
        firstTextLabelShown = true
      } else {
        shouldMerge = index > runStart ||
          (index === runStart && !!turnAlreadyHasLabel)
      }

      items.push({
        id: assistantRow.id,
        kind: assistantRow.kind,
        estimatedHeight: estimateRowHeight(assistantRow.msg, assistantRow.kind),
        mergeWithPreviousAssistant: shouldMerge,
        showAssistantGroupCopy: canShowGroupCopy && index === runEnd,
        assistantGroupMessageIds:
          canShowGroupCopy && index === runEnd
            ? assistantGroupMessageIds
            : [],
      })
    }

    visibleIndex += 1
  }

  return items
}
