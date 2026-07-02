import type { InputImageAttachment } from './index'

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
    // req 6 compaction UI: on a 'compaction' summary block, the backendMessageIds
    // it replaced (so the UI can offer "show originals"). On a superseded message,
    // compactedAway marks it hidden/collapsed under its summary block.
    supersededMessageIds?: string[]
    compactedAway?: boolean
  }
  timestamp: number
  streaming?: boolean
}

export interface UIChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
}

export type UIUpdateAction =
  | { type: 'ADD_MESSAGE'; sessionId: string; message: ChatMessage }
  | { type: 'REMOVE_MESSAGE'; sessionId: string; messageId: string }
  | { type: 'APPEND_CONTENT'; sessionId: string; messageId: string; content: string }
  | { type: 'APPEND_OUTPUT'; sessionId: string; messageId: string; outputDelta: string }
  | { type: 'UPDATE_MESSAGE'; sessionId: string; messageId: string; patch: Partial<ChatMessage> }
  | { type: 'DONE'; sessionId: string }
  | { type: 'SESSION_PROFILE_LOCKED'; sessionId: string; lockedProfileId: string | null }
  | { type: 'SESSION_READY'; sessionId: string }
  | { type: 'ROLLBACK'; sessionId: string; messageId: string }
  // req 6: compaction collapsed the range `supersededMessageIds` into `message`
  // (a 'compaction' summary block). Frontend hides the superseded messages under
  // it so the visible transcript matches what the model now sees.
  | { type: 'COMPACTION_SUMMARY'; sessionId: string; message: ChatMessage; supersededMessageIds: string[] }
