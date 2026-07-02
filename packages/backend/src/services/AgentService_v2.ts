import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { StateGraph, START, END, Annotation, MemorySaver } from '@langchain/langgraph'
import { RunnableLambda } from '@langchain/core/runnables'
import type { ChatSession, BackendSettings } from '../types'
import { TerminalService } from './TerminalService'
import type {
  IChatHistoryRuntime,
  ICommandPolicyRuntime,
  IMcpRuntime,
  ISkillRuntime,
  IMemoryRuntime
} from './runtimeContracts'
import type { UIHistoryService } from './UIHistoryService'
import { v4 as uuidv4 } from 'uuid'
import type { z } from 'zod'
import type { StartTaskInput } from './Gateway/types'
import type { StoredChatSession } from './ChatHistoryService'
import {
  buildToolsForModel,
  execCommandSchema,
  readTerminalTabSchema,
  readCommandOutputSchema,
  readFileSchema,
  writeStdinSchema,
  writeAndEditSchema,
  waitSchema,
  waitTerminalIdleSchema,
  waitCommandEndSchema,

  toolImplementations,
  buildSkillToolDescription,
  buildDelegateAgentDescription
} from './AgentHelper/tools'
import type { ToolExecutionContext } from './AgentHelper/types'
import { AgentHelpers } from './AgentHelper/helpers'
import { buildDebugRawResponse, captureRawResponseChunk } from './AgentHelper/utils/raw_response'
import {
  buildDynamicRequestHistory,
  invokeWithRetryAndSanitizedInput,
  stripRawResponseFromStoredMessages
} from './AgentHelper/utils/model_messages'
import { createStreamReasoningExtractor } from './AgentHelper/utils/stream_reasoning_extractor'
import { resolveRunExperimentalFlags } from './AgentHelper/utils/experimental_flags'
import { SelfCorrectionRuntimeManager } from './AgentHelper/utils/self_correction_runtime'
import { removeUnmatchedToolCallsFromHistory } from './AgentHelper/utils/tool_call_history'
import {
  clearAllCompressionArtifacts,
  sanitizeCompressionAfterRollback
} from './AgentHelper/utils/history_compression_maintenance'
import {
  CONTINUE_INSTRUCTION_TAG,
  SELF_CORRECTION_INPUT_TAG,
  USEFUL_SKILL_TAG,
  USER_INSERTED_INPUT_TAG,
  USER_INSERTED_INPUT_INSTRUCTION,
  createBaseSystemPromptText,
  prependSystemInfoToUserInput,
  upsertSingleSystemMessageByText,
  COMMAND_POLICY_DECISION_SCHEMA,
  WRITE_STDIN_POLICY_DECISION_SCHEMA,
  TASK_COMPLETION_DECISION_SCHEMA,
  TASK_CONTINUE_INSTRUCTION_SCHEMA,
  SELF_CORRECTION_AUDIT_DECISION_SCHEMA,
  SELF_CORRECTION_INSTRUCTION_SCHEMA,
  COMPACTION_SUMMARY_SCHEMA,
  createCommandPolicyUserPrompt,
  createCompactionSummaryUserPrompt,
  createSelfCorrectionAuditDecisionUserPrompt,
  createSelfCorrectionInstructionUserPrompt,
  createTaskCompletionDecisionUserPrompt,
  createTaskContinueInstructionUserPrompt,
  createWriteStdinPolicyUserPrompt,
  hasAnyNormalUserInputTag,
  WHAT_HAVE_DONE_IN_THE_PAST_TAG,
} from './AgentHelper/prompts'
import { runSkillTool } from './AgentHelper/tools/skill_tools'
import { TokenManager } from './AgentHelper/TokenManager'
import { InputParseHelper } from './AgentHelper/InputParseHelper'
import { ImageAttachmentService } from './ImageAttachmentService'
import { RunMarkerService, type RunMarker } from './RunMarkerService'

const Ann: any = Annotation
type StartupInputState = StartTaskInput | undefined

const StateAnnotation = Ann.Root({
  // Runtime/Persistence Context - single source of truth for the whole graph
  messages: Ann({
    reducer: (x: BaseMessage[], y?: BaseMessage | BaseMessage[]) => {
      if (!y) return x

      if (Array.isArray(y)) {
        return y
      }
      return [...x, y]
    },
    default: () => []
  }),
  // Token State - tracked separately
  token_state: Ann({
    reducer: (current: { current_tokens: number, max_tokens: number }, update?: Partial<{ current_tokens: number, max_tokens: number }>) => {
      if (!update) return current
      return { ...current, ...update }
    },
    default: () => ({ current_tokens: 0, max_tokens: 0 })
  }),
  // Add sessionId to the state to track which session this execution belongs to
  sessionId: Ann({
    reducer: (x: string, y?: string) => y ?? x,
    default: () => ""
  }),
  startup_input: Ann({
    reducer: (x: StartupInputState, y?: StartTaskInput) => y ?? x,
    default: (): StartupInputState => undefined
  }),
  startup_mode: Ann({
    reducer: (x: 'normal' | 'inserted', y?: 'normal' | 'inserted') => y ?? x,
    default: () => 'normal'
  }),
  pendingToolCalls: Ann({
    reducer: (x: any[], y?: any[] | any) => {
      if (!y) return x
      if (Array.isArray(y)) return y
      return x
    },
    default: () => []
  }),
  completionGuardDecision: Ann({
    reducer: (x: 'end' | 'continue', y?: 'end' | 'continue') => y ?? x,
    default: () => 'end'
  }),
  modelRequestPassCount: Ann({
    reducer: (x: number, y?: number) => (typeof y === 'number' ? y : x),
    default: () => 0
  }),
  runtimeThinkingCorrectionEnabled: Ann({
    reducer: (x: boolean, y?: boolean) => (typeof y === 'boolean' ? y : x),
    default: () => true
  }),
  taskFinishGuardEnabled: Ann({
    reducer: (x: boolean, y?: boolean) => (typeof y === 'boolean' ? y : x),
    default: () => true
  }),
  firstTurnThinkingModelEnabled: Ann({
    reducer: (x: boolean, y?: boolean) => (typeof y === 'boolean' ? y : x),
    default: () => false
  }),
  execCommandActionModelEnabled: Ann({
    reducer: (x: boolean, y?: boolean) => (typeof y === 'boolean' ? y : x),
    default: () => true
  }),
  writeStdinActionModelEnabled: Ann({
    reducer: (x: boolean, y?: boolean) => (typeof y === 'boolean' ? y : x),
    default: () => true
  }),
  // req 3 view-context: the sender's current-view snapshot for this run (or null).
  view_snapshot: Ann({
    reducer: (x: any, y?: any) => (y !== undefined ? y : x),
    default: () => null
  })
})

const MODEL_RETRY_MAX = 4
const MODEL_RETRY_DELAYS_MS = [1000, 2000, 4000, 6000]
const COMPACTION_PROTECTED_NORMAL_USER_ROUNDS = 2

interface SessionModelBinding {
  profileId: string
  model: ChatOpenAI
  actionModel: ChatOpenAI
  thinkingModel: ChatOpenAI
  compactionModel: ChatOpenAI
  actionModelSupportsStructuredOutput: boolean
  actionModelSupportsObjectToolChoice: boolean
  thinkingModelSupportsStructuredOutput: boolean
  thinkingModelSupportsObjectToolChoice: boolean
  compactionModelSupportsStructuredOutput: boolean
  compactionModelSupportsObjectToolChoice: boolean
  readFileSupport: { image: boolean }
  toolsForModel: any[]
  globalMaxTokens: number
  thinkingMaxTokens: number
  compactionMaxTokens: number
}

export class AgentService_v2 {
  private terminalService: TerminalService
  private chatHistoryService: IChatHistoryRuntime
  private commandPolicyService: ICommandPolicyRuntime
  private mcpToolService: IMcpRuntime
  private skillService: ISkillRuntime
  private memoryService: IMemoryRuntime
  private uiHistoryService: UIHistoryService
  private settings: BackendSettings | null = null

  private graph: any = null
  private helpers: AgentHelpers
  private checkpointer: MemorySaver
  private builtInToolEnabled: Record<string, boolean> = {}
  // Per-session so concurrent multi-agent runs on this singleton can't cross-contaminate
  // each other's aborted-partial capture (Phase-0 fleet hardening).
  private lastAbortedMessages: Map<string, BaseMessage> = new Map()
  private sessionModelBindings: Map<string, SessionModelBinding> = new Map()
  private selfCorrectionRuntimeManager = new SelfCorrectionRuntimeManager()
  // Persistent "run in flight" markers for boot-time recovery of turns
  // interrupted by a backend restart (Phase-0 fleet hardening).
  private runMarkers = new RunMarkerService()
  // req 3 view-context: last-injected ViewSnapshot hash per session, so an
  // unchanged view injects a one-liner instead of the full block (R2.3 dedup).
  private lastInjectedViewHash: Map<string, string> = new Map()
  private waitForFeedback: ((messageId: string, timeoutMs?: number) => Promise<any | null>) | null = null
  private imageAttachmentService: ImageAttachmentService | null = null

  constructor(
    terminalService: TerminalService,
    commandPolicyService: ICommandPolicyRuntime,
    mcpToolService: IMcpRuntime,
    skillService: ISkillRuntime,
    memoryService: IMemoryRuntime,
    uiHistoryService: UIHistoryService,
    chatHistoryService: IChatHistoryRuntime,
    imageAttachmentService?: ImageAttachmentService
  ) {
    this.terminalService = terminalService
    this.chatHistoryService = chatHistoryService
    this.commandPolicyService = commandPolicyService
    this.mcpToolService = mcpToolService
    this.skillService = skillService
    this.memoryService = memoryService
    this.uiHistoryService = uiHistoryService
    this.imageAttachmentService = imageAttachmentService || null
    this.helpers = new AgentHelpers()
    this.checkpointer = new MemorySaver()
    this.initializeGraph()
  }

  updateSettings(settings: BackendSettings): void {
    this.settings = settings
    this.builtInToolEnabled = settings.tools?.builtIn ?? {}
    this.initializeGraph()
  }

  setEventPublisher(publisher: (sessionId: string, event: any) => void): void {
    this.helpers.setEventPublisher(publisher)
  }

  setFeedbackWaiter(waiter: (messageId: string, timeoutMs?: number) => Promise<any | null>): void {
    this.waitForFeedback = waiter
  }

  isAbortError(error: unknown): boolean {
    return this.helpers.isAbortError(error)
  }

  private initializeGraph(): void {
    const workflow = new StateGraph(StateAnnotation) as any

    workflow.addNode('startup_message_builder', this.createStartupMessageBuilderNode())
    workflow.addNode('token_pruner_runtime', this.createTokenManagerNode())
    
    workflow.addNode('model_request', this.createModelRequestNode())
    workflow.addNode('batch_toolcall_executor', this.createBatchToolcallExecutorNode())
    workflow.addNode('task_completion_guard', this.createTaskCompletionGuardNode())
    workflow.addNode('tools', this.createToolsNode())
    workflow.addNode('command_tools', this.createCommandToolsNode())
    workflow.addNode('file_tools', this.createFileToolsNode())
    workflow.addNode('read_file', this.createReadFileNode())
    workflow.addNode('mcp_tools', this.createMcpToolsNode())
    workflow.addNode('final_output', this.createFinalOutputNode())

    workflow.addEdge(START, 'startup_message_builder')
    workflow.addEdge('startup_message_builder', 'token_pruner_runtime')
    workflow.addEdge('token_pruner_runtime', 'model_request')
    
    workflow.addEdge('model_request', 'batch_toolcall_executor')
    workflow.addConditionalEdges(
      'batch_toolcall_executor',
      this.routeModelOutput,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'task_completion_guard', 'final_output']
    )

    workflow.addConditionalEdges(
      'task_completion_guard',
      this.routeCompletionGuardOutput,
      ['token_pruner_runtime', 'final_output']
    )
    
    workflow.addConditionalEdges(
      'tools',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    workflow.addConditionalEdges(
      'command_tools',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    workflow.addConditionalEdges(
      'file_tools',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    workflow.addConditionalEdges(
      'read_file',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    workflow.addConditionalEdges(
      'mcp_tools',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    
    workflow.addEdge('final_output', END)

    this.graph = workflow.compile({ checkpointer: this.checkpointer })
  }

  private buildModelBindingFromProfileId(profileId: string): SessionModelBinding | null {
    const settings = this.settings
    if (!settings) return null

    const profile = settings.models.profiles.find((p) => p.id === profileId)
    if (!profile) {
      console.warn('[AgentService_v2] Profile not found for session binding:', profileId)
      return null
    }

    // Resolve the default model in fallback order so a stale globalModelId
    // (e.g. an auto-discovered service that got renamed at relaunch) doesn't
    // bring down the whole session. Try globalModelId, then chatModelId,
    // then coderModelId, then any valid item — whichever resolves first
    // becomes the session's default model.
    const findItemWithKey = (id: string | undefined) => {
      if (!id) return undefined
      const item = settings.models.items.find((m) => m.id === id)
      return item && item.apiKey ? item : undefined
    }
    let globalItem =
      findItemWithKey(profile.globalModelId) ||
      findItemWithKey((profile as any).chatModelId) ||
      findItemWithKey((profile as any).coderModelId)
    if (!globalItem) {
      // Last-ditch fallback: any item with a usable apiKey.
      globalItem = settings.models.items.find((m) => !!m.apiKey)
    }
    if (!globalItem) {
      console.warn('[AgentService_v2] No usable model could be resolved for session binding:', {
        profileId,
        globalModelId: profile.globalModelId,
        chatModelId: (profile as any).chatModelId,
        coderModelId: (profile as any).coderModelId,
      })
      return null
    }
    if (globalItem.id !== profile.globalModelId) {
      console.warn(
        `[AgentService_v2] Profile "${profileId}" globalModelId "${profile.globalModelId}" is stale; ` +
        `falling back to "${globalItem.id}". Re-pick the Default Model in Settings to silence this warning.`
      )
    }

    // The retired action/thinking/compaction role fields no longer exist on
    // ModelProfile (v7+). Read them off the profile defensively for any
    // pre-migration data, but in practice these will always be undefined and
    // the runtime will fall back to globalModelId for everything.
    const actionItem = (profile as any).actionModelId
      ? settings.models.items.find((m) => m.id === (profile as any).actionModelId)
      : undefined
    const thinkingItem = (profile as any).thinkingModelId
      ? settings.models.items.find((m) => m.id === (profile as any).thinkingModelId)
      : undefined
    const compactionItem = (profile as any).compactionModelId
      ? settings.models.items.find((m) => m.id === (profile as any).compactionModelId)
      : undefined

    const model = this.helpers.createChatModel(globalItem, 0.7)
    const actionModel = actionItem?.apiKey ? this.helpers.createChatModel(actionItem, 0.1) : model
    const thinkingModel = thinkingItem?.apiKey ? this.helpers.createChatModel(thinkingItem, 0.2) : model
    const compactionModel = compactionItem?.apiKey
      ? this.helpers.createChatModel(compactionItem, 0.2)
      : (thinkingItem?.apiKey ? thinkingModel : model)
    const actionModelSupportsStructuredOutput = actionItem?.apiKey
      ? actionItem.supportsStructuredOutput === true
      : globalItem.supportsStructuredOutput === true
    const actionModelSupportsObjectToolChoice = actionItem?.apiKey
      ? actionItem.supportsObjectToolChoice === true
      : globalItem.supportsObjectToolChoice === true
    const thinkingModelSupportsStructuredOutput = thinkingItem?.apiKey
      ? thinkingItem.supportsStructuredOutput === true
      : globalItem.supportsStructuredOutput === true
    const thinkingModelSupportsObjectToolChoice = thinkingItem?.apiKey
      ? thinkingItem.supportsObjectToolChoice === true
      : globalItem.supportsObjectToolChoice === true
    const compactionModelSupportsStructuredOutput = compactionItem?.apiKey
      ? compactionItem.supportsStructuredOutput === true
      : (thinkingItem?.apiKey
          ? thinkingItem.supportsStructuredOutput === true
          : globalItem.supportsStructuredOutput === true)
    const compactionModelSupportsObjectToolChoice = compactionItem?.apiKey
      ? compactionItem.supportsObjectToolChoice === true
      : (thinkingItem?.apiKey
          ? thinkingItem.supportsObjectToolChoice === true
          : globalItem.supportsObjectToolChoice === true)
    const readFileSupport = this.helpers.computeReadFileSupport(
      globalItem.profile,
      actionItem?.apiKey ? actionItem.profile : undefined,
      thinkingItem?.apiKey ? thinkingItem.profile : undefined,
      compactionItem?.apiKey ? compactionItem.profile : undefined
    )
    const toolsForModel = buildToolsForModel(readFileSupport)

    return {
      profileId,
      model,
      actionModel,
      thinkingModel,
      compactionModel,
      actionModelSupportsStructuredOutput,
      actionModelSupportsObjectToolChoice,
      thinkingModelSupportsStructuredOutput,
      thinkingModelSupportsObjectToolChoice,
      compactionModelSupportsStructuredOutput,
      compactionModelSupportsObjectToolChoice,
      readFileSupport,
      toolsForModel,
      globalMaxTokens: typeof globalItem.maxTokens === 'number' ? globalItem.maxTokens : 200000,
      thinkingMaxTokens: typeof thinkingItem?.maxTokens === 'number'
        ? thinkingItem.maxTokens
        : (typeof globalItem.maxTokens === 'number' ? globalItem.maxTokens : 200000),
      compactionMaxTokens: typeof compactionItem?.maxTokens === 'number'
        ? compactionItem.maxTokens
        : (typeof thinkingItem?.maxTokens === 'number'
            ? thinkingItem.maxTokens
            : (typeof globalItem.maxTokens === 'number' ? globalItem.maxTokens : 200000))
    }
  }

  private ensureSessionModelBinding(sessionId: string, profileId: string): SessionModelBinding {
    const existing = this.sessionModelBindings.get(sessionId)
    if (existing && existing.profileId === profileId) {
      return existing
    }

    const next = this.buildModelBindingFromProfileId(profileId)
    if (!next) {
      throw new Error(`Cannot initialize session model binding for profile: ${profileId}`)
    }

    this.sessionModelBindings.set(sessionId, next)
    return next
  }

  private getSessionModelBinding(sessionId: string): SessionModelBinding {
    const binding = this.sessionModelBindings.get(sessionId)
    if (!binding) {
      throw new Error(`Session model binding not found for session: ${sessionId}`)
    }
    return binding
  }

  private getEffectiveMaxTokensFromBinding(binding: SessionModelBinding): number {
    return Math.min(binding.globalMaxTokens, binding.thinkingMaxTokens, binding.compactionMaxTokens)
  }

  private getEffectiveMaxTokensForSession(sessionId: string): number | undefined {
    const binding = this.sessionModelBindings.get(sessionId)
    if (!binding) return undefined
    return this.getEffectiveMaxTokensFromBinding(binding)
  }

  releaseSessionModelBinding(sessionId: string): void {
    this.sessionModelBindings.delete(sessionId)
    this.selfCorrectionRuntimeManager.clearSession(sessionId)
  }

  // --- Graph Nodes ---
  
  private createTokenManagerNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const messages: BaseMessage[] = Array.isArray(state.messages) ? state.messages : []
      const tokenState = state.token_state || {}
      const dynamicRequestView = buildDynamicRequestHistory(messages)
      const estimatedRequestTokens = TokenManager.estimateMessages(dynamicRequestView)
      const currentTokensForCheck = Math.max(tokenState.current_tokens || 0, estimatedRequestTokens)
      if (!TokenManager.isOverflow(currentTokensForCheck, tokenState.max_tokens || 0)) {
        return {}
      }

      const pruneResult = TokenManager.applyPruneLabels(messages)
      let nextMessages = pruneResult.messages
      if (pruneResult.changed) {
        console.log(
          `[TokenManager] Labeled ${pruneResult.newlyTaggedCount} messages for dynamic pruning (~${pruneResult.estimatedPrunedTokens} tokens, sessionId=${state.sessionId || 'unknown'})`
        )
      }

      if (pruneResult.newlyTaggedCount === 0) {
        const compactionResult = await this.tryCompactHistory(
          state.sessionId,
          nextMessages,
          config?.signal
        )
        if (compactionResult.changed) {
          nextMessages = compactionResult.messages
        }
      }

      if (nextMessages !== messages) {
        return { messages: nextMessages }
      }
      return {}
    })
  }

  private createStartupMessageBuilderNode() {
    return RunnableLambda.from(async (state: any) => {
      const sessionId = state.sessionId
      if (!sessionId) return state
      const sessionBinding = this.getSessionModelBinding(sessionId)

      const startupInput: StartTaskInput = state.startup_input ?? ''
      const startupMode: 'normal' | 'inserted' = state.startup_mode === 'inserted' ? 'inserted' : 'normal'

      const messages: BaseMessage[] = [...state.messages]

      const userMessageId = uuidv4()
      const { enrichedContent, displayContent, inputImages, modelImages } = await InputParseHelper.parseAndEnrich(
        startupInput,
        this.skillService,
        this.terminalService,
        {
          userInputTag: startupMode === 'inserted' ? USER_INSERTED_INPUT_TAG : InputParseHelper.DEFAULT_USER_INPUT_TAG,
          includeContextDetails: true,
          userInputInstruction: startupMode === 'inserted' ? USER_INSERTED_INPUT_INSTRUCTION : undefined,
          keepTaggedBodyLiteral: startupMode === 'inserted',
          modelSupportsImage: sessionBinding.readFileSupport.image,
          imageAttachmentService: this.imageAttachmentService || undefined
        }
      )

      let injectedUserContent = enrichedContent
      if (startupMode === 'normal') {
        const tabs = this.terminalService.getAllTerminals()
        injectedUserContent = prependSystemInfoToUserInput(enrichedContent, tabs, sessionId)
      }

      // req 3 view-context: prepend a summary of what the user is looking at so
      // the agent can resolve context-dependent asks. Model-only — it rides
      // injectedUserContent (what the model sees), never displayContent (what's
      // shown/persisted), so it doesn't pollute the transcript. Hash-deduped.
      const viewInjection = this.buildViewContextInjection((state as any).view_snapshot, sessionId)
      if (viewInjection) {
        injectedUserContent = `${viewInjection}\n\n${injectedUserContent}`
      }

      const humanMessageContent =
        modelImages.length > 0
          ? ([
              { type: 'text', text: injectedUserContent || 'User attached image inputs.' },
              ...modelImages.map((item) => ({
                type: 'image_url' as const,
                image_url: { url: item.dataUrl }
              }))
            ] as any)
          : injectedUserContent

      const humanMessage = new HumanMessage(humanMessageContent)
      ;(humanMessage as any).additional_kwargs = {
        _gyshellMessageId: userMessageId,
        original_input: displayContent,
        input_kind: startupMode,
        ...(inputImages.length > 0 ? { input_images: inputImages } : {})
      }

      this.helpers.sendEvent(sessionId, {
        messageId: userMessageId,
        type: 'user_input',
        content: displayContent,
        inputKind: startupMode,
        ...(inputImages.length > 0 ? { inputImages } : {})
      })

      const memoryEnabled = this.settings?.memory?.enabled !== false

      let memoryPrompt:
        | {
            memoryFilePath: string
            memoryContent: string
          }
        | undefined
      if (memoryEnabled) {
        try {
          const snapshot = await this.memoryService.getMemorySnapshot()
          memoryPrompt = {
            memoryFilePath: snapshot.filePath,
            memoryContent: snapshot.content
          }
        } catch (error) {
          console.warn('[AgentService_v2] Failed to load memory.md for system prompt injection:', error)
        }
      }
      const baseSystemText = createBaseSystemPromptText(memoryPrompt)
      const newMessages = upsertSingleSystemMessageByText([...messages, humanMessage], baseSystemText)

      const maxTokens = this.getEffectiveMaxTokensFromBinding(sessionBinding)

      let currentTokens = 0
      for (let i = newMessages.length - 1; i >= 0; i--) {
        const m = newMessages[i]
        const usage = (m as any).usage_metadata || (m as any).additional_kwargs?.usage
        if (usage?.total_tokens) {
          currentTokens = usage.total_tokens
          break
        }
      }

      return {
        messages: newMessages,
        token_state: {
          max_tokens: maxTokens,
          current_tokens: currentTokens
        }
      }
    })
  }

  private createModelRequestNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')
      const sessionBinding = this.getSessionModelBinding(sessionId)
      const runtimeThinkingCorrectionEnabled = state.runtimeThinkingCorrectionEnabled !== false

      let fullHistoryMessages: BaseMessage[] = [...(state.messages as BaseMessage[])]

      const pendingInstruction = this.selfCorrectionRuntimeManager.consumePendingInstruction(sessionId)
      if (pendingInstruction && runtimeThinkingCorrectionEnabled) {
        const selfCorrectionMessage = new HumanMessage(
          `${SELF_CORRECTION_INPUT_TAG}${pendingInstruction.instruction}`
        )
        ;(selfCorrectionMessage as any).additional_kwargs = {
          _gyshellMessageId: uuidv4(),
          input_kind: 'self_correction'
        }
        fullHistoryMessages = [...fullHistoryMessages, selfCorrectionMessage]
      }

      const prevPassCount = typeof state.modelRequestPassCount === 'number' ? state.modelRequestPassCount : 0
      const nextPassCount = prevPassCount + 1
      if (runtimeThinkingCorrectionEnabled && nextPassCount % 8 === 0) {
        this.spawnSelfCorrectionAudit(sessionId, fullHistoryMessages, config?.signal, nextPassCount)
      }

      // Ensure we get the freshest list from disk
      await this.skillService.reload()
      const skills = await this.skillService.getEnabledSkills()
      
      // Filter built-in tools based on the latest enabled status
      const builtInTools = this.helpers.getEnabledBuiltInTools(sessionBinding.toolsForModel, this.builtInToolEnabled)
      
      // Update skill tool description with latest skills
      const skillToolIndex = builtInTools.findIndex(t => t.function.name === 'skill')
      if (skillToolIndex !== -1) {
        builtInTools[skillToolIndex].function.description = buildSkillToolDescription(skills)
      }

      // Update delegate_agent description with the latest configured agents
      const delegateToolIndex = builtInTools.findIndex(t => t.function.name === 'delegate_agent')
      if (delegateToolIndex !== -1) {
        builtInTools[delegateToolIndex].function.description = buildDelegateAgentDescription(this.settings?.agents ?? [])
      }

      const mcpTools = this.mcpToolService.getActiveTools()
      const shouldUseThinkingModelOnThisPass =
        state.firstTurnThinkingModelEnabled === true && nextPassCount === 1
      const modelInputMessages = buildDynamicRequestHistory(fullHistoryMessages, {
        modelSupportsImage: sessionBinding.readFileSupport.image
      })
      const baseModel = shouldUseThinkingModelOnThisPass
        ? (sessionBinding.thinkingModel || sessionBinding.model)
        : sessionBinding.model
      const modelWithTools = baseModel.bindTools([...builtInTools, ...mcpTools])

      const messageId = uuidv4()
      
      let partialText = ''
      let reasoningContent = ''
      let debugRawChunks: any[] = []
      const fullResponse = await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages: modelInputMessages,
        modelSupportsImage: sessionBinding.readFileSupport.image,
        signal: config?.signal,
        operation: async (streamInputMessages) => {
          const stream = await modelWithTools.stream(streamInputMessages, {
            signal: config?.signal
          })

          let response: any = null
          const streamReasoningExtractor = createStreamReasoningExtractor()
          const attemptDebugRawChunks: any[] = []
          let activeReasoningBannerId: string | null = null

          const startReasoningBanner = () => {
            if (activeReasoningBannerId) return
            activeReasoningBannerId = uuidv4()
            this.helpers.sendEvent(sessionId, {
              messageId: activeReasoningBannerId,
              type: 'sub_tool_started',
              title: 'Reasoning...',
              hint: ''
            })
          }

          const appendReasoningDelta = (delta: string) => {
            if (!delta) return
            startReasoningBanner()
            this.helpers.sendEvent(sessionId, {
              messageId: activeReasoningBannerId as string,
              type: 'sub_tool_delta',
              outputDelta: delta
            })
          }

          const finishReasoningBanner = () => {
            if (!activeReasoningBannerId) return
            this.helpers.sendEvent(sessionId, {
              messageId: activeReasoningBannerId,
              type: 'sub_tool_finished'
            })
            activeReasoningBannerId = null
          }
          try {
            for await (const chunk of stream) {
              const rawChunk = captureRawResponseChunk(chunk as any, attemptDebugRawChunks)
              const extracted = streamReasoningExtractor.processChunk(chunk as any, rawChunk)
              response = response ? response.concat(chunk) : chunk
              const rawDelta = this.helpers.extractText(chunk.content)
              if (rawDelta) {
                partialText += rawDelta
              }
              if (extracted.reasoning) {
                appendReasoningDelta(extracted.reasoning)
              } else {
                finishReasoningBanner()
              }
              if (extracted.content) {
                this.helpers.sendEvent(sessionId, {
                  messageId,
                  type: 'say',
                  content: extracted.content
                })
              }
            }
            const pendingContent = streamReasoningExtractor.flushPendingContent()
            if (pendingContent) {
              this.helpers.sendEvent(sessionId, {
                messageId,
                type: 'say',
                content: pendingContent
              })
            }
            finishReasoningBanner()
          } catch (err) {
            finishReasoningBanner()
            if (partialText.trim()) {
              this.lastAbortedMessages.set(sessionId, new AIMessage({
                content: partialText,
                additional_kwargs: { _gyshellMessageId: messageId, _gyshellAborted: true }
              }))
              console.log(`[AgentService_v2] Captured partial message from error/abort (sessionId=${sessionId}).`)
            }
            throw err
          }
          reasoningContent = streamReasoningExtractor.getReasoningContent()
          debugRawChunks = attemptDebugRawChunks
          return response
        },
        onRetry: (attempt) => {
          this.helpers.sendEvent(sessionId, {
            type: 'alert',
            message: `Retrying (${attempt}/${MODEL_RETRY_MAX})...`,
            level: 'info',
            messageId: `retry-${messageId}-${attempt}`
          })
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })

      fullResponse.additional_kwargs = {
        ...(fullResponse.additional_kwargs || {}),
        _gyshellMessageId: messageId
      }
      if (reasoningContent) {
        fullResponse.additional_kwargs.reasoning_content = reasoningContent
      }
      if (this.shouldKeepDebugPayloadInPersistence()) {
        const persistedRawResponse = buildDebugRawResponse(debugRawChunks)
        if (typeof persistedRawResponse !== 'undefined') {
          fullResponse.additional_kwargs.__raw_response = persistedRawResponse
        }
      } else if (fullResponse.additional_kwargs?.__raw_response) {
        delete fullResponse.additional_kwargs.__raw_response
      }

      // Extract usage metadata if available
      const usage = (fullResponse as any).usage_metadata || (fullResponse as any).additional_kwargs?.usage
      let currentTokens = state.token_state.current_tokens
      
      if (usage) {
        currentTokens = usage.total_tokens || usage.totalTokens || 0
        const modelName = (fullResponse as any).response_metadata?.model_name
          || (baseModel as any)?.modelName
          || 'unknown'
        this.helpers.sendEvent(sessionId, {
          type: 'tokens_count',
          modelName,
          totalTokens: currentTokens,
          maxTokens: state.token_state.max_tokens // Use static max from state
        })
      }

      // Always reset pendingToolCalls here to avoid stale queue influencing routing.
      return { 
          messages: [...fullHistoryMessages, fullResponse],
          token_state: { current_tokens: currentTokens },
          sessionId,
          pendingToolCalls: [],
          modelRequestPassCount: nextPassCount
      }
    })
  }

  private createBatchToolcallExecutorNode() {
    return RunnableLambda.from(async (state: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const messages: BaseMessage[] = [...state.messages]
      const lastMessage = messages[messages.length - 1]

      let pendingToolCalls: any[] = []

      if (!AIMessage.isInstance(lastMessage)) {
        return { messages, sessionId, pendingToolCalls }
      }

      const toolCalls: any[] = Array.isArray((lastMessage as any).tool_calls) ? (lastMessage as any).tool_calls : []

      // Always clean tool-call chunk/invalid metadata to prevent context bloat,
      // and then decide how many tool calls we keep/enqueue.
      if (!toolCalls || toolCalls.length === 0) {
        this.cleanupModelToolCallMetadata(lastMessage, [])
        return { messages, sessionId, pendingToolCalls }
      }

      // If only one tool call, just enqueue it and continue (no extra checks needed).
      if (toolCalls.length === 1) {
        pendingToolCalls = toolCalls.slice(0, 1)
        this.cleanupModelToolCallMetadata(lastMessage, pendingToolCalls)
        return { messages, sessionId, pendingToolCalls }
      }

    // If ANY exec_command is present, force single-tool: keep only the first tool call.
      const hasExecCommand = toolCalls.some((tc) => tc?.name === 'exec_command')
      if (hasExecCommand) {
        pendingToolCalls = toolCalls.slice(0, 1)
        this.cleanupModelToolCallMetadata(lastMessage, pendingToolCalls)
        return { messages, sessionId, pendingToolCalls }
      }

      const skillCall = toolCalls.find((tc) => tc?.name === 'skill')
      if (skillCall) {
        pendingToolCalls = [skillCall]
        this.cleanupModelToolCallMetadata(lastMessage, pendingToolCalls)
        return { messages, sessionId, pendingToolCalls }
      }

      // Otherwise (no exec_command), allow executing ALL tool calls sequentially.
      pendingToolCalls = toolCalls.slice()
      this.cleanupModelToolCallMetadata(lastMessage, pendingToolCalls)
      return { messages, sessionId, pendingToolCalls }
    })
  }

  private createToolsNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId;
      if (!sessionId) throw new Error('No session ID in state')
      const sessionBinding = this.getSessionModelBinding(sessionId)

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall) return state

      // Parallelize consecutive delegate_agent calls from the queue head.
      // The model often emits 2+ delegate_agent calls in one response when
      // it wants to fan out work — without this batch we'd run them serially
      // and the multi-model pool would never see overlap. Other tool kinds
      // (file edits, exec_command) stay sequential to avoid races.
      const delegateBatch: any[] = []
      while (delegateBatch.length < queue.length && queue[delegateBatch.length]?.name === 'delegate_agent') {
        delegateBatch.push(queue[delegateBatch.length])
      }
      if (delegateBatch.length > 1) {
        const messages: BaseMessage[] = []
        const deps = this.buildDelegateAgentDeps(this.createExecutionContext(
          sessionId,
          this.createToolMessage(toolCall).additional_kwargs._gyshellMessageId as string,
          config,
        ))
        const results = await Promise.all(delegateBatch.map(async (tc: any) => {
          const tm = this.createToolMessage(tc)
          try {
            const out = await toolImplementations.runDelegateAgent(tc.args || {}, deps)
            tm.content = out.message
          } catch (err: any) {
            if (err?.name === 'AbortError') throw err
            tm.content = `delegate_agent failed: ${err?.message || String(err)}`
          }
          return tm
        }))
        for (const tm of results) messages.push(tm)
        return {
          messages: [...state.messages, ...messages],
          sessionId,
          pendingToolCalls: queue.slice(delegateBatch.length),
        }
      }

      const toolMessage = this.createToolMessage(toolCall)
      const executionContext = this.createExecutionContext(
        sessionId,
        toolMessage.additional_kwargs._gyshellMessageId as string,
        config
      )
      const messageHistory: BaseMessage[] = state.messages
      let result = ''
      switch (toolCall.name) {
        case 'skill': {
          let args: any = toolCall.args || {}
          if (typeof args === 'string') {
            try {
              args = this.helpers.parseStrictJsonObject(args)
            } catch {
              args = {}
            }
          }
          const messageId = toolMessage.additional_kwargs._gyshellMessageId as string
          this.helpers.sendEvent(sessionId, {
            messageId,
            type: 'sub_tool_started',
            title: 'Skill',
            hint: `${args.name || 'unknown'}...`,
            input: JSON.stringify(args)
          })
          const outcome = await runSkillTool(args, this.skillService, config?.signal)
          result = outcome.message

          // Only emit content delta on success: error messages do not contain USEFUL_SKILL_TAG
          // and splitting by it would yield undefined at index [1].
          if (outcome.kind === 'text') {
            const skillContent = result.split(USEFUL_SKILL_TAG)[1].trim()
            this.helpers.sendEvent(sessionId, {
              messageId,
              type: 'sub_tool_delta',
              outputDelta: skillContent
            })
          }

          this.helpers.sendEvent(sessionId, {
            messageId,
            type: 'sub_tool_finished'
          })
          break
        }
        case 'create_skill': {
          let args: any = toolCall.args || {}
          if (typeof args === 'string') {
            try {
              args = this.helpers.parseStrictJsonObject(args)
            } catch {
              args = {}
            }
          }
          const messageId = toolMessage.additional_kwargs._gyshellMessageId as string
          const outcome = await toolImplementations.runCreateSkillTool(args, this.skillService, config?.signal)
          result = outcome.message
          
          // Force a reload of the graph to pick up the new tool definition if needed,
          // though the dynamic fetching in model_request node should handle it.
          // But we must ensure the local toolsForModel is updated if we use it elsewhere.
          
          this.helpers.sendEvent(sessionId, {
            messageId,
            type: 'tool_call',
            toolName: 'create_skill',
            input: JSON.stringify(args),
            output: result
          })
          break
        }
        case 'read_terminal_tab': {
          try {
            const validatedArgs = readTerminalTabSchema.parse(toolCall.args || {})
            result = await toolImplementations.readTerminalTab(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for read_terminal_tab: ${(err as Error).message}`
          }
          break
        }
        case 'read_command_output': {
          try {
            const validatedArgs = readCommandOutputSchema.parse(toolCall.args || {})
            result = await toolImplementations.readCommandOutput(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for read_command_output: ${(err as Error).message}`
          }
          break
        }
        case 'write_stdin': {
          try {
            const validatedArgs = writeStdinSchema.parse(toolCall.args || {})
            // const messageId = toolMessage.additional_kwargs._gyshellMessageId as string

            if (state.writeStdinActionModelEnabled !== false && sessionBinding.actionModel) {
              // Build temporary history for action model
              const finalActionMessages = this.helpers.buildActionModelHistory(state.messages as BaseMessage[])

              // Call action model for write_stdin policy check
              const user = createWriteStdinPolicyUserPrompt({ chars: validatedArgs.sequence ?? [] })
              const finalMessagesForActionModel = [...finalActionMessages, user]

              let decision: z.infer<typeof WRITE_STDIN_POLICY_DECISION_SCHEMA>
              try {
                decision = await this.getActionModelPolicyDecision(
                  sessionId,
                  finalMessagesForActionModel,
                  WRITE_STDIN_POLICY_DECISION_SCHEMA,
                  config?.signal,
                  'write_stdin'
                )
              } catch (err: any) {
                console.warn('[AgentService_v2] Action model decision for write_stdin failed after retries, falling back to allow:', err)
                decision = { decision: 'allow', reason: 'Action model error' }
              }

              if (decision.decision === 'block') {
                const blockReason = `This call was blocked because the auditor found issues: ${decision.reason}\n\nActually, your intention might be different. Please re-read the description of the write_stdin tool to confirm what you really want to do, and then call write_stdin again with the correct parameters.`
                console.log('[AgentService_v2] Action model decision for write_stdin blocked:', blockReason)
                toolMessage.content = blockReason
                return {
                  messages: [...state.messages, toolMessage],
                  sessionId,
                  pendingToolCalls: queue.slice(1)
                }
              }
            }

            result = await toolImplementations.writeStdin(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for write_stdin: ${(err as Error).message}`
          }
          break
        }
        case 'wait': {
          try {
            const validatedArgs = waitSchema.parse(toolCall.args || {})
            result = await toolImplementations.wait(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for wait: ${(err as Error).message}`
          }
          break
        }
        case 'wait_terminal_idle': {
          try {
            const validatedArgs = waitTerminalIdleSchema.parse(toolCall.args || {})
            result = await toolImplementations.waitTerminalIdle(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for wait_terminal_idle: ${(err as Error).message}`
          }
          break
        }
        case 'wait_command_end': {
          try {
            const validatedArgs = waitCommandEndSchema.parse(toolCall.args || {})
            result = await toolImplementations.waitCommandEnd(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for wait_command_end: ${(err as Error).message}`
          }
          break
        }
        case 'web_fetch': {
          const out = await toolImplementations.runWebFetch(toolCall.args || {}, executionContext.signal)
          result = out.message
          break
        }
        case 'web_search': {
          const out = await toolImplementations.runWebSearch(toolCall.args || {}, executionContext.signal)
          result = out.message
          break
        }
        case 'exec_headless': {
          // Pass full executionContext so the tool can run its per-tool
          // permission check + use the same approval-prompt path
          // exec_command uses (banner in the chat with Approve/Deny).
          const out = await toolImplementations.runExecHeadless(toolCall.args || {}, executionContext)
          result = out.message
          break
        }
        case 'delegate_agent': {
          const out = await toolImplementations.runDelegateAgent(toolCall.args || {}, this.buildDelegateAgentDeps(executionContext))
          result = out.message
          break
        }
        case 'memory_list_collections': {
          const out = await toolImplementations.runMemoryListCollections(toolCall.args || {}, executionContext.signal)
          result = out.message
          break
        }
        case 'memory_recall': {
          const out = await toolImplementations.runMemoryRecall(toolCall.args || {}, executionContext.signal)
          result = out.message
          break
        }
        case 'memory_save': {
          const out = await toolImplementations.runMemorySave(toolCall.args || {}, executionContext.signal)
          result = out.message
          break
        }
        case 'memory_create_collection': {
          const out = await toolImplementations.runMemoryCreateCollection(toolCall.args || {}, executionContext.signal)
          result = out.message
          break
        }
        case 'memory_delete': {
          const out = await toolImplementations.runMemoryDelete(toolCall.args || {}, executionContext.signal)
          result = out.message
          break
        }
        default:
          result = `Tool "${toolCall.name}" is not supported.`
      }

      toolMessage.content = result
      return {
        messages: [...messageHistory, toolMessage],
        sessionId,
        pendingToolCalls: queue.slice(1)
      }
    })
  }

  private createCommandToolsNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall || toolCall.name !== 'exec_command') return state

      const toolMessage = this.createToolMessage(toolCall)
      const executionContext = this.createExecutionContext(sessionId, toolMessage.additional_kwargs._gyshellMessageId as string, config)
      const messageHistory: BaseMessage[] = state.messages

      let validated: z.infer<typeof execCommandSchema>
      try {
        validated = execCommandSchema.parse(toolCall.args || {})
      } catch (err) {
        toolMessage.content = `Parameter validation error for exec_command: ${(err as Error).message}`
        return { 
            messages: [...messageHistory, toolMessage], 
            sessionId, 
            pendingToolCalls: queue.slice(1) 
        }
      }

      const { found, bestMatch } = this.terminalService.resolveTerminal(validated.tabIdOrName)
      if (!bestMatch) {
        toolMessage.content = found.length > 1
            ? `Error: Multiple terminal tabs found with name "${validated.tabIdOrName}".`
            : `Error: Terminal tab "${validated.tabIdOrName}" not found.`
        return { 
            messages: [...messageHistory, toolMessage], 
            sessionId, 
            pendingToolCalls: queue.slice(1) 
        }
      }

      let resultText = ''
      if (validated.waitMode === 'nowait') {
        const res = await toolImplementations.runCommandNowait(validated, executionContext)
        resultText = res + "\nThis command may hang, so it is run asynchronously. Please use read_terminal_tab to check the result/status!"
      } else {
        const recent = this.terminalService.getRecentOutput(bestMatch.id) || ''

        let autoSwitchToNowait = false
        let autoSwitchReason = ''
        let waitActive = true

        const actionDecisionController = new AbortController()
        const forwardAbortToActionModel = () => actionDecisionController.abort()
        if (config?.signal) {
          if (config.signal.aborted) {
            actionDecisionController.abort()
          } else {
            config.signal.addEventListener('abort', forwardAbortToActionModel, { once: true })
          }
        }

        const actionDecisionTask = state.execCommandActionModelEnabled !== false
          ? (async () => {
              // Keep action-model judgment independent: do not include global waitMode choice in prompt.
              const finalActionMessages = this.helpers.buildActionModelHistory(state.messages as BaseMessage[])
              const user = createCommandPolicyUserPrompt({
                tabTitle: bestMatch.title,
                tabId: bestMatch.id,
                tabType: bestMatch.type,
                command: validated.command,
                recentOutput: recent
              })
              const finalMessagesForActionModel = [...finalActionMessages, user]

              const decision = await this.getActionModelPolicyDecision(
                sessionId,
                finalMessagesForActionModel,
                COMMAND_POLICY_DECISION_SCHEMA,
                actionDecisionController.signal,
                'exec_command_parallel_audit'
              )

              const decisionReason = this.normalizeLogReason(decision.reason)
              if (decision.decision === 'nowait') {
                console.log(
                  `[AgentService_v2][exec_command_guard] Triggered nowait switch. reason=${decisionReason}`
                )
              } else {
                console.log(
                  `[AgentService_v2][exec_command_guard] Decision kept wait mode. reason=${decisionReason}`
                )
              }

              if (waitActive && decision.decision === 'nowait') {
                autoSwitchToNowait = true
                autoSwitchReason = String(decision.reason || '').trim()
              }
            })()
              .catch((err: any) => {
                if (this.helpers.isAbortError(err) || actionDecisionController.signal.aborted) {
                  console.log('[AgentService_v2][exec_command_guard] Abort trigger received. keep wait mode.')
                  return
                }
                console.log('[AgentService_v2][exec_command_guard] Decision skipped, keep wait mode.')
              })
          : Promise.resolve()

        try {
          resultText = await toolImplementations.runCommand(validated, executionContext, {
            shouldSkipWait: () => autoSwitchToNowait,
            getSkipWaitReason: () => (autoSwitchToNowait ? (autoSwitchReason || 'action model decided this command should not block') : undefined)
          })
        } finally {
          waitActive = false
          actionDecisionController.abort()
          if (config?.signal) {
            config.signal.removeEventListener('abort', forwardAbortToActionModel)
          }
          await actionDecisionTask
        }
      }

      toolMessage.content = resultText
      return { 
          messages: [...messageHistory, toolMessage], 
          sessionId, 
          pendingToolCalls: queue.slice(1) 
      }
    })
  }

  private createFileToolsNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall || toolCall.name !== 'create_or_edit') return state

      const toolMessage = this.createToolMessage(toolCall)
      const executionContext = this.createExecutionContext(sessionId, toolMessage.additional_kwargs._gyshellMessageId as string, config)
      const messageHistory: BaseMessage[] = state.messages

      let result: string
      try {
        const validatedArgs = writeAndEditSchema.parse(toolCall.args || {})
        result = await toolImplementations.writeAndEdit(validatedArgs, executionContext)
      } catch (err) {
        result = `Parameter validation or execution error for create_or_edit: ${(err as Error).message}`
      }

      toolMessage.content = result
      return { 
          messages: [...messageHistory, toolMessage], 
          sessionId, 
          pendingToolCalls: queue.slice(1) 
      }
    })
  }

  private createReadFileNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')
      const sessionBinding = this.getSessionModelBinding(sessionId)

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall || toolCall.name !== 'read_file') return state

      const toolMessage = this.createToolMessage(toolCall)
      const messageId = toolMessage.additional_kwargs._gyshellMessageId as string
      const executionContext = this.createExecutionContext(sessionId, messageId, config)
      const messageHistory: BaseMessage[] = state.messages

      let resultText: string
      let imageMessage: HumanMessage | null = null
      let meaningLessAIMessage: AIMessage | null = null

      try {
        const validatedArgs = readFileSchema.parse(toolCall.args || {})
        const result = await toolImplementations.runReadFile(
          validatedArgs,
          executionContext,
          sessionBinding.readFileSupport
        )
        resultText = result.resultText
        imageMessage = result.imageMessage ?? null
        meaningLessAIMessage = result.meaningLessAIMessage ?? null
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err)
        // Ensure frontend gets a banner even on validation errors / unexpected failures.
        this.helpers.sendEvent(sessionId, {
          messageId,
          type: 'file_read',
          level: 'warning',
          filePath: String((toolCall.args as any)?.filePath || 'unknown file'),
          input: JSON.stringify(toolCall.args || {}),
          output: resultText
        })
      }

      toolMessage.content = resultText

      const updates = imageMessage
        ? [toolMessage, meaningLessAIMessage, imageMessage]
        : [toolMessage]

      return {
        messages: [...messageHistory, ...updates],
        sessionId,
        pendingToolCalls: queue.slice(1)
      }
    })
  }

  private createMcpToolsNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall || !this.mcpToolService.isMcpToolName(toolCall.name)) return state

      const toolMessage = this.createToolMessage(toolCall)
      const messageId = toolMessage.additional_kwargs._gyshellMessageId as string
      const messageHistory: BaseMessage[] = state.messages

      let args: any = toolCall.args || {}
      if (typeof args === 'string') {
        try {
          args = this.helpers.parseStrictJsonObject(args)
        } catch {}
      }

      const signal = config?.signal
      let resultText: string
      try {
        const result = await this.mcpToolService.invokeTool(toolCall.name, args, signal)
        resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      } catch (err) {
        if (this.helpers.isAbortError(err)) throw err
        resultText = err instanceof Error ? err.message : String(err)
      }

      this.helpers.sendEvent(sessionId, {
        messageId,
        type: 'tool_call',
        toolName: toolCall.name,
        input: JSON.stringify(args ?? {}),
        output: resultText
      })

      toolMessage.content = resultText
      return { 
          messages: [...messageHistory, toolMessage], 
          sessionId, 
          pendingToolCalls: queue.slice(1) 
      }
    })
  }

  private createTaskCompletionGuardNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const messages: BaseMessage[] = [...state.messages]
      const lastMessage = messages[messages.length - 1]

      if (!AIMessage.isInstance(lastMessage)) {
        return {
          messages,
          sessionId,
          pendingToolCalls: [],
          completionGuardDecision: 'end' as const
        }
      }

      const toolCalls: any[] = Array.isArray((lastMessage as any).tool_calls) ? (lastMessage as any).tool_calls : []
      if (toolCalls.length > 0) {
        return {
          messages,
          sessionId,
          pendingToolCalls: [],
          completionGuardDecision: 'continue' as const
        }
      }

      let completionDecision: z.infer<typeof TASK_COMPLETION_DECISION_SCHEMA>
      try {
        completionDecision = await this.getThinkingModelDecision(
          sessionId,
          [...messages, createTaskCompletionDecisionUserPrompt()],
          TASK_COMPLETION_DECISION_SCHEMA,
          config?.signal,
          'task_completion_guard'
        )
      } catch (err) {
        if (this.helpers.isAbortError(err) || config?.signal?.aborted) {
          console.log('[AgentService_v2][task_guard] Abort trigger received during completion audit.')
          throw err
        }
        console.log('[AgentService_v2][task_guard] Completion audit unavailable. fallback=end.')
        completionDecision = {
          is_fully_completed: true,
          reason: 'Completion audit unavailable'
        }
      }

      if (completionDecision.is_fully_completed) {
        console.log(
          `[AgentService_v2][task_guard] Completion confirmed. reason=${this.normalizeLogReason(completionDecision.reason)}`
        )
        return {
          messages,
          sessionId,
          pendingToolCalls: [],
          completionGuardDecision: 'end' as const
        }
      }
      console.log(
        `[AgentService_v2][task_guard] Triggered continue. reason=${this.normalizeLogReason(completionDecision.reason)}`
      )

      let continueInstruction: z.infer<typeof TASK_CONTINUE_INSTRUCTION_SCHEMA>
      try {
        continueInstruction = await this.getThinkingModelDecision(
          sessionId,
          [
            ...messages,
            createTaskCompletionDecisionUserPrompt(),
            new AIMessage({
              content: JSON.stringify(completionDecision)
            }),
            createTaskContinueInstructionUserPrompt({ completionReason: completionDecision.reason })
          ],
          TASK_CONTINUE_INSTRUCTION_SCHEMA,
          config?.signal,
          'task_continue_instruction'
        )
      } catch (err) {
        if (this.helpers.isAbortError(err) || config?.signal?.aborted) {
          console.log('[AgentService_v2][task_guard] Abort trigger received during continue-instruction generation.')
          throw err
        }
        console.log('[AgentService_v2][task_guard] Continue instruction generation unavailable. use generic instruction.')
        continueInstruction = {
          continue_instruction:
            'Continue the task. Re-check unmet requirements, choose the next best tool/approach, execute it, and verify result.'
        }
      }

      const removedBackendMessageId = (lastMessage as any)?.additional_kwargs?._gyshellMessageId as string | undefined

      if (removedBackendMessageId) {
        this.helpers.sendEvent(sessionId, {
          type: 'remove_message',
          messageId: removedBackendMessageId
        })
      }

      const continueMessage = new HumanMessage(
        `${CONTINUE_INSTRUCTION_TAG}${continueInstruction.continue_instruction}`
      )
      ;(continueMessage as any).additional_kwargs = {
        _gyshellMessageId: uuidv4(),
        input_kind: 'continue_instruction'
      }

      return {
        messages: [...messages, continueMessage],
        sessionId,
        pendingToolCalls: [],
        completionGuardDecision: 'continue' as const
      }
    })
  }


  private createFinalOutputNode() {
    return RunnableLambda.from(async (state: any) => {
      const sessionId = state.sessionId;
      if (!sessionId) return state;

      // Persist UI history at task boundary (avoid sync disk writes during streaming).
      try {
        this.uiHistoryService.flush(sessionId)
      } catch (e) {
        console.warn('[AgentService_v2] Failed to flush UI history on done:', e)
      }

      this.helpers.sendEvent(sessionId, { 
        type: 'debug_history', 
        history: JSON.parse(JSON.stringify(state.messages)) 
      })
      this.helpers.sendEvent(sessionId, { type: 'done' })
      return state
    })
  }

  // --- Helpers ---

  private createToolMessage(toolCall: any): ToolMessage {
    const toolMessage = new ToolMessage({
      content: '',
      tool_call_id: toolCall.id || '',
      name: toolCall.name
    })
    const messageId = uuidv4()
    ;(toolMessage as any).additional_kwargs = { _gyshellMessageId: messageId }
    return toolMessage
  }

  /**
   * Per-session memo of which tools have been approved this session, driving
   * the 'ask-once-session' permission. Cleared when the session ends so a new
   * session starts fresh.
   */
  private sessionApprovedToolsBySession = new Map<string, Set<string>>()

  private getSessionApprovedTools(sessionId: string): Set<string> {
    let set = this.sessionApprovedToolsBySession.get(sessionId)
    if (!set) {
      set = new Set<string>()
      this.sessionApprovedToolsBySession.set(sessionId, set)
    }
    return set
  }

  private createExecutionContext(sessionId: string, messageId: string, config: any): ToolExecutionContext {
    return {
      sessionId,
      messageId,
      terminalService: this.terminalService,
      sendEvent: this.helpers.sendEvent.bind(this.helpers),
      waitForFeedback: this.waitForFeedback ?? undefined,
      commandPolicyService: this.commandPolicyService,
      commandPolicyMode: this.settings?.commandPolicyMode || 'standard',
      signal: config?.signal,
      toolPermissions: this.settings?.tools?.builtInPermissions,
      sessionApprovedTools: this.getSessionApprovedTools(sessionId),
    }
  }

  /**
   * Per-(baseUrl, modelName) cache of slot counts discovered via /v1/models.
   * Reads the proxlab-injected `_proxlab_slots` field; falls back to 1 when
   * the backend is non-proxlab or unreachable. Cached for 30 seconds so
   * repeated delegate_agent calls don't re-fetch on every invocation.
   */
  private slotCache = new Map<string, { slots: number; expiresAt: number }>()
  private readonly SLOT_CACHE_TTL_MS = 30_000

  private async discoverSlots(baseUrl: string, modelName: string, apiKey?: string): Promise<number> {
    const key = `${baseUrl}|${modelName}`
    const cached = this.slotCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.slots
    let slots = 1
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)
      const headers: Record<string, string> = {}
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
      const url = baseUrl.replace(/\/+$/, '') + '/v1/models'
      const resp = await fetch(url, { headers, signal: ctrl.signal })
      clearTimeout(timer)
      if (resp.ok) {
        const json = (await resp.json()) as any
        const entries: any[] = Array.isArray(json?.data) ? json.data : []
        const match = entries.find((m) => m?.id === modelName) ?? entries[0]
        const reported = match?._proxlab_slots
        if (typeof reported === 'number' && reported > 0) slots = Math.floor(reported)
      }
    } catch { /* fall through to slots=1 */ }
    this.slotCache.set(key, { slots, expiresAt: Date.now() + this.SLOT_CACHE_TTL_MS })
    return slots
  }

  private buildDelegateAgentDeps(executionContext: ToolExecutionContext) {
    const settings = this.settings
    const agents = settings?.agents ?? []
    const allModels = settings?.models?.items ?? []
    const profiles = settings?.models?.profiles ?? []
    const activeProfileId = settings?.models?.activeProfileId

    // Resolve a model item by its definition id, then fall back to the
    // active profile's globalModelId so an empty allowlist still works
    // ("inherit caller's active profile" semantics).
    const resolveModelById = (id: string) => {
      if (!id) return null
      const direct = allModels.find((m) => m.id === id)
      if (direct) return direct
      // Back-compat: callers used to pass profile ids. If the id matches a
      // profile, dereference to its globalModelId.
      const profile = profiles.find((p) => p.id === id)
      if (profile) return allModels.find((m) => m.id === profile.globalModelId) ?? null
      return null
    }
    const resolveActiveProfileModel = () => {
      if (!activeProfileId) return null
      const profile = profiles.find((p) => p.id === activeProfileId)
      if (!profile) return null
      return allModels.find((m) => m.id === profile.globalModelId) ?? null
    }

    // Build the candidate list for an agent. The agent stores model item ids
    // directly; if the array is empty we fall back to the caller's active
    // profile so the agent is still usable. Each candidate carries the slot
    // count discovered from /v1/models so the pool knows its concurrency
    // capacity for this profile.
    const resolveModels = (agent: any): Array<{ profileId: string; modelItem: any; slots: number }> => {
      const ids: string[] = Array.isArray(agent.modelProfileIds) ? agent.modelProfileIds : []
      const out: Array<{ profileId: string; modelItem: any; slots: number }> = []
      const seen = new Set<string>()
      const push = (id: string, modelItem: any) => {
        if (!modelItem || seen.has(modelItem.id)) return
        seen.add(modelItem.id)
        const baseUrl = modelItem.baseUrl ?? ''
        // Auto-discovered items already carry _proxlabSlots; otherwise fall
        // back to the slot cache (or 1) and kick off an async refresh.
        const cachedHttp = baseUrl
          ? this.slotCache.get(`${baseUrl}|${modelItem.model}`)
          : undefined
        const slots = (typeof modelItem._proxlabSlots === 'number' && modelItem._proxlabSlots > 0)
          ? modelItem._proxlabSlots
          : (cachedHttp?.slots ?? 1)
        out.push({ profileId: id, modelItem, slots })
        if (baseUrl) {
          void this.discoverSlots(baseUrl, modelItem.model, modelItem.apiKey)
        }
      }

      if (ids.length > 0) {
        for (const id of ids) push(id, resolveModelById(id))
      }
      if (out.length === 0) {
        push('__active__', resolveActiveProfileModel())
      }
      return out
    }

    const buildToolsForAllowedNames = (allowedNames: string[]) => {
      const all = buildToolsForModel({ image: false })
      const allowSet = new Set(allowedNames)
      return all.filter((t: any) => allowSet.has(t?.function?.name))
    }

    return {
      agents,
      resolveModels,
      createChatModel: this.helpers.createChatModel.bind(this.helpers),
      buildToolsForModel: buildToolsForAllowedNames,
      executionContext,
      skillService: this.skillService,
      depth: 0,
    }
  }

  private async tryCompactHistory(
    sessionId: string,
    messages: BaseMessage[],
    signal: AbortSignal | undefined
  ): Promise<{ changed: boolean; messages: BaseMessage[] }> {
    if (!sessionId) {
      return { changed: false, messages }
    }

    const insertionIndex = this.findCompactionInsertionIndex(messages)
    if (insertionIndex < 0) {
      console.log(
        `[TokenManager] Overflow remains but compaction skipped: fewer than ${COMPACTION_PROTECTED_NORMAL_USER_ROUNDS + 1} normal user rounds (sessionId=${sessionId}).`
      )
      return { changed: false, messages }
    }
    if (this.hasCompactionMarkerAtInsertion(messages, insertionIndex)) {
      console.log(
        `[TokenManager] Overflow remains but compaction skipped: insertion index=${insertionIndex} already compacted once (sessionId=${sessionId}).`
      )
      return { changed: false, messages }
    }

    const compactionMessageId = uuidv4()
    this.helpers.sendEvent(sessionId, {
      messageId: compactionMessageId,
      type: 'sub_tool_started',
      title: 'Compaction...',
      level: 'info'
    })

    const historyBeforeProtectedRounds = messages.slice(0, insertionIndex)
    let summaryDecision: z.infer<typeof COMPACTION_SUMMARY_SCHEMA>
    try {
      summaryDecision = await this.getCompactionModelDecision(
        sessionId,
        [
          ...historyBeforeProtectedRounds,
          createCompactionSummaryUserPrompt({
            protectedRounds: COMPACTION_PROTECTED_NORMAL_USER_ROUNDS
          })
        ],
        COMPACTION_SUMMARY_SCHEMA,
        signal,
        'history_compaction'
      )
    } catch (error) {
      if (this.helpers.isAbortError(error) || signal?.aborted) {
        console.log('[AgentService_v2][history_compaction_guard] Abort trigger received.')
        this.helpers.sendEvent(sessionId, {
          messageId: compactionMessageId,
          type: 'sub_tool_finished'
        })
        throw error
      }
      console.log('[AgentService_v2][history_compaction_guard] Summary generation unavailable. skip compaction.')
      this.helpers.sendEvent(sessionId, {
        messageId: compactionMessageId,
        type: 'sub_tool_finished'
      })
      return { changed: false, messages }
    }

    const summaryText = String(summaryDecision.summary || '').trim()
    if (!summaryText) {
      this.helpers.sendEvent(sessionId, {
        messageId: compactionMessageId,
        type: 'sub_tool_finished'
      })
      return { changed: false, messages }
    }

    const summaryMessage = new HumanMessage(`${WHAT_HAVE_DONE_IN_THE_PAST_TAG}${summaryText}`)
    ;(summaryMessage as any).additional_kwargs = {
      _gyshellMessageId: uuidv4(),
      [TokenManager.LAST_COMPACTION_FLAG_KEY]: true
    }

    const compactedMessages = [
      ...messages.slice(0, insertionIndex),
      summaryMessage,
      ...messages.slice(insertionIndex)
    ]

    console.log(
      `[TokenManager] Compaction inserted summary at index=${insertionIndex} (sessionId=${sessionId}).`
    )
    this.helpers.sendEvent(sessionId, {
      messageId: compactionMessageId,
      type: 'sub_tool_finished'
    })

    // req 6: tell the UI which prior messages are now represented by the summary
    // so it can collapse them under a summary block (visible transcript == what
    // the model now sees). The messages before the insertion index are the ones
    // dropped from the model request by buildDynamicRequestHistory going forward.
    const supersededMessageIds = historyBeforeProtectedRounds
      .map((m) => (m as any)?.additional_kwargs?._gyshellMessageId)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
    this.helpers.sendEvent(sessionId, {
      type: 'compaction_summary',
      messageId: `compaction-summary-${compactionMessageId}`,
      summary: summaryText,
      supersededMessageIds
    })

    return { changed: true, messages: compactedMessages }
  }

  private findCompactionInsertionIndex(messages: BaseMessage[]): number {
    const normalUserRoundIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.type !== 'human') continue
      if (hasAnyNormalUserInputTag(message.content)) {
        normalUserRoundIndices.push(i)
      }
    }
    if (normalUserRoundIndices.length <= COMPACTION_PROTECTED_NORMAL_USER_ROUNDS) {
      return -1
    }

    // Insert before the earliest message of the protected tail rounds.
    return normalUserRoundIndices[normalUserRoundIndices.length - COMPACTION_PROTECTED_NORMAL_USER_ROUNDS]
  }

  private hasCompactionMarkerAtInsertion(messages: BaseMessage[], insertionIndex: number): boolean {
    if (insertionIndex < 0 || insertionIndex > messages.length) {
      return false
    }

    const markerAtInsertion =
      insertionIndex < messages.length && TokenManager.hasLastCompactionFlag(messages[insertionIndex])
    const markerBeforeInsertion =
      insertionIndex > 0 && TokenManager.hasLastCompactionFlag(messages[insertionIndex - 1])

    return markerAtInsertion || markerBeforeInsertion
  }

  private spawnSelfCorrectionAudit(
    sessionId: string,
    messages: BaseMessage[],
    parentSignal: AbortSignal | undefined,
    passCount: number
  ): void {
    const controller = new AbortController()
    this.selfCorrectionRuntimeManager.addController(sessionId, controller)

    const forwardAbort = () => controller.abort()
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort()
      } else {
        parentSignal.addEventListener('abort', forwardAbort, { once: true })
      }
    }

    void (async () => {
      const auditDecision = await this.getThinkingModelDecision(
        sessionId,
        [...messages, createSelfCorrectionAuditDecisionUserPrompt()],
        SELF_CORRECTION_AUDIT_DECISION_SCHEMA,
        controller.signal,
        'self_correction_audit'
      )
      if (auditDecision.is_on_reasonable_path) return
      console.log(
        `[AgentService_v2][self_correction_guard] Triggered correction. reason=${this.normalizeLogReason(auditDecision.reason)}`
      )

      const correctionInstruction = await this.getThinkingModelDecision(
        sessionId,
        [
          ...messages,
          createSelfCorrectionAuditDecisionUserPrompt(),
          new AIMessage({ content: JSON.stringify(auditDecision) }),
          createSelfCorrectionInstructionUserPrompt({ auditReason: auditDecision.reason })
        ],
        SELF_CORRECTION_INSTRUCTION_SCHEMA,
        controller.signal,
        'self_correction_instruction'
      )

      const instructionText = String(correctionInstruction.correction_instruction || '').trim()
      if (!instructionText) return

      this.selfCorrectionRuntimeManager.setPendingInstruction(sessionId, {
        passCount,
        instruction: instructionText
      })
      console.log(
        `[AgentService_v2][self_correction_guard] Correction instruction queued. pass=${passCount}`
      )
    })()
      .catch((err) => {
        if (this.helpers.isAbortError(err) || controller.signal.aborted) {
          console.log('[AgentService_v2][self_correction_guard] Abort trigger received.')
          return
        }
        console.log('[AgentService_v2][self_correction_guard] Audit unavailable. skip this round.')
      })
      .finally(() => {
        this.selfCorrectionRuntimeManager.removeController(sessionId, controller)
        if (parentSignal) {
          parentSignal.removeEventListener('abort', forwardAbort)
        }
      })
  }

  private routeModelOutput = (state: any): string => {
    const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
    const first = queue[0]
    
    if (first?.name) {
      // Security: Double-check if the tool is actually enabled before routing.
      // This prevents the Agent from calling tools that were disabled during the session.
      if (this.builtInToolEnabled[first.name] === false) {
        console.warn(`[AgentService_v2] LLM tried to call disabled tool: ${first.name}`)
        return 'final_output'
      }

      if (first.name === 'skill' || first.name === 'create_skill') return 'tools'
      if (this.mcpToolService.isMcpToolName(first.name)) return 'mcp_tools'
      if (first.name === 'exec_command') return 'command_tools'
      if (first.name === 'create_or_edit') return 'file_tools'
      if (first.name === 'read_file') return 'read_file'
      return 'tools'
    }

    if (state.taskFinishGuardEnabled !== false) {
      return 'task_completion_guard'
    }
    return 'final_output'
  }

  private routeCompletionGuardOutput = (state: any): string => {
    return state.completionGuardDecision === 'continue' ? 'token_pruner_runtime' : 'final_output'
  }

  private routeAfterToolCall = (state: any): string => {
    const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
    const first = queue[0]
    if (!first) {
      return 'token_pruner_runtime'
    }
    if (first?.name) {
      if (this.mcpToolService.isMcpToolName(first.name)) return 'mcp_tools'
      if (first.name === 'exec_command') return 'command_tools'
      if (first.name === 'create_or_edit') return 'file_tools'
      if (first.name === 'read_file') return 'read_file'
      if (first.name === 'skill' || first.name === 'create_skill') return 'tools'
      return 'tools'
    }
    return 'token_pruner_runtime'
  }

  private cleanupModelToolCallMetadata(msg: any, keepToolCalls: any[]): void {
    // Keep only chosen tool calls (0/1/many) while removing tool-call chunk/invalid artifacts.
    if (Array.isArray(msg?.tool_calls)) {
      msg.tool_calls = Array.isArray(keepToolCalls) ? keepToolCalls : []
    }
    if (Array.isArray(msg?.invalid_tool_calls)) {
      msg.invalid_tool_calls = []
    }
    if (Array.isArray(msg?.tool_call_chunks)) {
      msg.tool_call_chunks = []
    }
    if (msg?.additional_kwargs?.tool_calls) {
      delete msg.additional_kwargs.tool_calls
    }
  }

  private shouldKeepDebugPayloadInPersistence(): boolean {
    return this.settings?.debugMode === true
  }

  private normalizeLogReason(reason: unknown): string {
    const text = typeof reason === 'string' ? reason : String(reason ?? '')
    const compact = text.replace(/\s+/g, ' ').trim()
    return compact || 'no reason provided'
  }

  private async getActionModelPolicyDecision<T extends z.ZodTypeAny>(
    sessionId: string,
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string
  ): Promise<z.infer<T>> {
    const sessionBinding = this.getSessionModelBinding(sessionId)
    const actionModel = sessionBinding.actionModel
    if (sessionBinding.actionModelSupportsStructuredOutput) {
      const structuredModel = actionModel.withStructuredOutput(schema, { method: 'jsonSchema' })
      return await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages,
        modelSupportsImage: sessionBinding.readFileSupport.image,
        signal,
        operation: async (sanitizedMessages) => {
          return await structuredModel.invoke(sanitizedMessages, { signal }) as any
        },
        onRetry: (attempt) => {
          console.log(`[AgentService_v2] Retrying action model decision for ${decisionName} (attempt ${attempt + 1})...`)
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })
    }

    if (sessionBinding.actionModelSupportsObjectToolChoice) {
      return await this.invokeActionModelPolicyDecisionWithoutSchema(
        sessionId,
        messages,
        schema,
        signal,
        decisionName
      )
    }

    return await this.invokeModelDecisionByPlainToolCall(
      sessionId,
      messages,
      schema,
      signal,
      decisionName,
      'action'
    )
  }

  private async invokeActionModelPolicyDecisionWithoutSchema<T extends z.ZodTypeAny>(
    sessionId: string,
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string
  ): Promise<z.infer<T>> {
    const sessionBinding = this.getSessionModelBinding(sessionId)
    const actionModel = sessionBinding.actionModel
    const functionCallingModel = actionModel.withStructuredOutput(schema, { method: 'functionCalling' })
    const result = await invokeWithRetryAndSanitizedInput({
      helpers: this.helpers,
      messages,
      modelSupportsImage: sessionBinding.readFileSupport.image,
      signal,
      operation: async (sanitizedMessages) => {
        return await functionCallingModel.invoke(sanitizedMessages, { signal }) as any
      },
      onRetry: (attempt) => {
        console.log(`[AgentService_v2] Retrying tool-call action model decision for ${decisionName} (attempt ${attempt + 1})...`)
      },
      maxRetries: MODEL_RETRY_MAX,
      delaysMs: MODEL_RETRY_DELAYS_MS
    })
    return result as z.infer<T>
  }

  private async getThinkingModelDecision<T extends z.ZodTypeAny>(
    sessionId: string,
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string
  ): Promise<z.infer<T>> {
    const sessionBinding = this.getSessionModelBinding(sessionId)
    const model = sessionBinding.thinkingModel || sessionBinding.model
    const processedMessages = buildDynamicRequestHistory(messages, {
      modelSupportsImage: sessionBinding.readFileSupport.image
    })

    if (sessionBinding.thinkingModelSupportsStructuredOutput) {
      const structuredModel = model.withStructuredOutput(schema, { method: 'jsonSchema' })
      return await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages: processedMessages,
        modelSupportsImage: sessionBinding.readFileSupport.image,
        signal,
        operation: async (sanitizedMessages) => {
          return await structuredModel.invoke(sanitizedMessages, { signal }) as any
        },
        onRetry: (attempt) => {
          console.log(`[AgentService_v2] Retrying thinking model decision for ${decisionName} (attempt ${attempt + 1})...`)
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })
    }

    if (sessionBinding.thinkingModelSupportsObjectToolChoice) {
      const functionCallingModel = model.withStructuredOutput(schema, { method: 'functionCalling' })
      return await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages: processedMessages,
        modelSupportsImage: sessionBinding.readFileSupport.image,
        signal,
        operation: async (sanitizedMessages) => {
          return await functionCallingModel.invoke(sanitizedMessages, { signal }) as any
        },
        onRetry: (attempt) => {
          console.log(`[AgentService_v2] Retrying tool-call thinking decision for ${decisionName} (attempt ${attempt + 1})...`)
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })
    }

    return await this.invokeModelDecisionByPlainToolCall(
      sessionId,
      processedMessages,
      schema,
      signal,
      decisionName,
      'thinking'
    )
  }

  private async getCompactionModelDecision<T extends z.ZodTypeAny>(
    sessionId: string,
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string
  ): Promise<z.infer<T>> {
    const sessionBinding = this.getSessionModelBinding(sessionId)
    const model = sessionBinding.compactionModel
    const processedMessages = buildDynamicRequestHistory(messages, {
      modelSupportsImage: sessionBinding.readFileSupport.image
    })

    if (sessionBinding.compactionModelSupportsStructuredOutput) {
      const structuredModel = model.withStructuredOutput(schema, { method: 'jsonSchema' })
      return await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages: processedMessages,
        modelSupportsImage: sessionBinding.readFileSupport.image,
        signal,
        operation: async (sanitizedMessages) => {
          return await structuredModel.invoke(sanitizedMessages, { signal }) as any
        },
        onRetry: (attempt) => {
          console.log(`[AgentService_v2] Retrying compaction model decision for ${decisionName} (attempt ${attempt + 1})...`)
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })
    }

    if (sessionBinding.compactionModelSupportsObjectToolChoice) {
      const functionCallingModel = model.withStructuredOutput(schema, { method: 'functionCalling' })
      return await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages: processedMessages,
        modelSupportsImage: sessionBinding.readFileSupport.image,
        signal,
        operation: async (sanitizedMessages) => {
          return await functionCallingModel.invoke(sanitizedMessages, { signal }) as any
        },
        onRetry: (attempt) => {
          console.log(`[AgentService_v2] Retrying tool-call compaction decision for ${decisionName} (attempt ${attempt + 1})...`)
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })
    }

    return await this.invokeModelDecisionByPlainToolCall(
      sessionId,
      processedMessages,
      schema,
      signal,
      decisionName,
      'compaction'
    )
  }

  private async invokeModelDecisionByPlainToolCall<T extends z.ZodTypeAny>(
    sessionId: string,
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string,
    kind: 'action' | 'thinking' | 'compaction'
  ): Promise<z.infer<T>> {
    const sessionBinding = this.getSessionModelBinding(sessionId)
    const model = kind === 'action'
      ? sessionBinding.actionModel
      : kind === 'compaction'
        ? sessionBinding.compactionModel
      : (sessionBinding.thinkingModel || sessionBinding.model)
    const toolName = `decision_${decisionName.replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 60)
    const tool = convertToOpenAITool({
      name: toolName,
      description: `Return the structured decision payload for ${decisionName}.`,
      schema
    } as any)
    const modelWithTool = model.bindTools([tool])
    const mustUseToolCallPrompt = new HumanMessage(
      [
        `You must return the decision by calling tool "${toolName}".`,
        'Do not return plain text. Return only one tool call.'
      ].join('\n')
    )
    const decisionMessages = [...messages, mustUseToolCallPrompt]

    return await invokeWithRetryAndSanitizedInput({
      helpers: this.helpers,
      messages: decisionMessages,
      modelSupportsImage: sessionBinding.readFileSupport.image,
      signal,
      operation: async (sanitizedMessages) => {
        const stream = await modelWithTool.stream(sanitizedMessages, { signal })
        let response: any = null
        for await (const chunk of stream) {
          response = response ? response.concat(chunk) : chunk
        }

        if (!response) {
          throw new Error(`No response was returned for ${decisionName}`)
        }

        const toolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : []
        const call = toolCalls.find((item: any) => item?.name === toolName) || toolCalls[0]
        if (call) {
          const rawArgs = typeof call.args === 'string'
            ? this.helpers.parseStrictJsonObject(call.args)
            : call.args
          return schema.parse(rawArgs) as z.infer<T>
        }

        const responseText = String(this.helpers.extractText(response?.content) || '').slice(0, 2000)
        const rawToolCalls = Array.isArray(response?.additional_kwargs?.tool_calls)
          ? response.additional_kwargs.tool_calls
          : []
        const invalidToolCalls = Array.isArray(response?.invalid_tool_calls)
          ? response.invalid_tool_calls
          : []

        const firstRawFunctionArguments = rawToolCalls[0]?.function?.arguments
        console.warn('[AgentService_v2] No tool call returned for schema decision.', {
          decisionName,
          kind,
          modelToolName: toolName,
          strategy: 'plain_tool_call_without_tool_choice_stream',
          responseText,
          parsedToolCalls: toolCalls,
          rawToolCalls,
          invalidToolCalls,
          firstRawFunctionArguments
        })
        throw new Error(`No tool call was returned for ${decisionName}`)
      },
      onRetry: (attempt) => {
        console.log(`[AgentService_v2] Retrying plain-tool-stream ${kind} decision for ${decisionName} (attempt ${attempt + 1})...`)
      },
      maxRetries: MODEL_RETRY_MAX,
      delaysMs: MODEL_RETRY_DELAYS_MS
    })
  }


  // --- Execution Core ---

  async run(context: any, input: StartTaskInput, signal: AbortSignal, startMode: 'normal' | 'inserted' = 'normal'): Promise<void> {
    if (!this.graph) throw new Error('Graph not initialized')

    const { sessionId } = context
    this.lastAbortedMessages.delete(sessionId)
    // Mark this run in-flight so a backend restart mid-turn is recoverable on boot.
    this.runMarkers.set({ sessionId, startedAt: Date.now(), startMode })
    const lockedProfileId = String(context.lockedProfileId || '')
    if (!lockedProfileId) {
      throw new Error(`Missing locked profile for session ${sessionId}`)
    }
    this.selfCorrectionRuntimeManager.clearSession(sessionId)
    const sessionBinding = this.ensureSessionModelBinding(sessionId, lockedProfileId)
    const currentRunMaxTokens = this.getEffectiveMaxTokensFromBinding(sessionBinding)
    const recursionLimit = this.settings?.recursionLimit ?? 200
    const loadedSession = this.chatHistoryService.loadSession(sessionId)
    let baseMessages = loadedSession
      ? mapStoredMessagesToChatMessages(Array.from(loadedSession.messages.values()))
      : []

    const shouldResetCompressionArtifacts =
      !!loadedSession &&
      (typeof loadedSession.lastProfileMaxTokens !== 'number' ||
        currentRunMaxTokens > loadedSession.lastProfileMaxTokens)
    if (shouldResetCompressionArtifacts && baseMessages.length > 0) {
      const reset = clearAllCompressionArtifacts(baseMessages)
      if (reset.changed) {
        baseMessages = reset.messages
        console.log(
          `[AgentService_v2] Cleared compression artifacts before run (sessionId=${sessionId}, prevMaxTokens=${loadedSession?.lastProfileMaxTokens ?? 'unknown'}, nextMaxTokens=${currentRunMaxTokens}).`
        )
      }
    }
    const runExperimentalFlags = resolveRunExperimentalFlags(context, this.settings)

    const initialState = {
      messages: [...baseMessages],
      sessionId: sessionId,
      startup_input: input,
      startup_mode: startMode,
      runtimeThinkingCorrectionEnabled: runExperimentalFlags.runtimeThinkingCorrectionEnabled,
      taskFinishGuardEnabled: runExperimentalFlags.taskFinishGuardEnabled,
      firstTurnThinkingModelEnabled: runExperimentalFlags.firstTurnThinkingModelEnabled,
      execCommandActionModelEnabled: runExperimentalFlags.execCommandActionModelEnabled,
      writeStdinActionModelEnabled: runExperimentalFlags.writeStdinActionModelEnabled,
      view_snapshot: (context as any)?.metadata?.viewSnapshot ?? null
    }

    try {
      const result = await this.graph.invoke(initialState, {
        recursionLimit: recursionLimit,
        signal,
        configurable: { thread_id: sessionId }
      })

      // Persistence
      if (result && result.messages) {
        const finalMessages = result.messages
        const sessionToSave = loadedSession || {
          id: sessionId,
          title: 'New Session',
          messages: new Map(),
          lastCheckpointOffset: 0,
          lastProfileMaxTokens: currentRunMaxTokens
        }
        this.updateSessionFromMessages(sessionToSave, finalMessages as BaseMessage[], currentRunMaxTokens)
        this.chatHistoryService.saveSession(sessionToSave)
      }
    } catch (err: any) {
      const isAbort = this.helpers.isAbortError(err)

      // For any stop path or internal failure, try to save all history in the current Checkpoint.
      await this.trySaveSessionFromCheckpoint(sessionId)

      if (isAbort) {
        console.log(`[AgentService_v2] Run abort trigger received (sessionId=${sessionId}).`)
        return
      }

      console.error(`[AgentService_v2] Run task failed (sessionId=${sessionId}):`, err)
      // Use our new detail extraction helper
      const errorDetails = this.helpers.extractErrorDetails(err)
      const errorMessage = err.message || String(err)
      
      // Broadcast with full details
      this.helpers.sendEvent(sessionId, {
        type: 'error',
        message: errorMessage,
        details: errorDetails
      })

      throw err // Throw to Gateway for UI notification
    } finally {
      this.selfCorrectionRuntimeManager.clearSession(sessionId)
      this.runMarkers.clear(sessionId)
      await this.clearCheckpoint(sessionId)
    }
  }

  /**
   * Boot-time recovery: any run marker still present means the backend was
   * restarted/crashed mid-turn. Surface a visible warning in each affected
   * session's transcript (so the user sees the turn was cut off rather than a
   * silent gap) and clear the marker. Annotate-only by design — we do NOT
   * auto-re-run on boot (a crash could leave several markers → a thundering
   * herd of unattended GPU work); re-send is the user's explicit choice.
   * Returns the sessionIds that were annotated. Safe to call once at startup.
   */
  /**
   * req 3 view-context: format the injected block from a ViewSnapshot. Returns
   * null when there's no usable snapshot. Hash-dedup (R2.3): if the view is
   * unchanged since the last injected turn in this session, emit a terse
   * one-liner instead of the full block to keep turns cheap. Adapter fallback
   * (R2.4) already happened in the renderer (summary always present).
   */
  private buildViewContextInjection(snapshot: any, sessionId: string): string | null {
    if (!snapshot || typeof snapshot !== 'object') return null
    const summary = String(snapshot.summary || '').trim()
    if (!summary) return null
    const kind = String(snapshot.activePanelKind || 'unknown')
    const tab = snapshot.activeTabTitle ? ` — "${String(snapshot.activeTabTitle)}"` : ''
    const hash = typeof snapshot.hash === 'string' ? snapshot.hash : ''
    const unchanged = !!hash && this.lastInjectedViewHash.get(sessionId) === hash
    if (hash) this.lastInjectedViewHash.set(sessionId, hash)
    if (unchanged) {
      return `[USER'S CURRENT VIEW — unchanged since last message: ${kind}${tab}]`
    }
    return [
      `[USER'S CURRENT VIEW]`,
      `The user is looking at the AI-Lab "${kind}"${tab} panel.`,
      summary,
      `If their message plausibly refers to what they're viewing, use this context to answer; if it's genuinely ambiguous, ask them to clarify rather than guessing.`
    ].join('\n')
  }

  recoverInterruptedRuns(): { recovered: string[] } {
    const recovered: string[] = []
    let markers: RunMarker[] = []
    try {
      markers = this.runMarkers.getAll()
    } catch (e) {
      console.warn('[AgentService_v2] Could not read run markers for recovery:', e)
      return { recovered }
    }
    for (const marker of markers) {
      try {
        const { sessionId, startedAt } = marker
        // Only annotate sessions that still exist on disk.
        if (this.chatHistoryService.loadSession(sessionId)) {
          const when = new Date(startedAt).toLocaleString()
          this.uiHistoryService.recordEvent(sessionId, {
            type: 'alert',
            level: 'warning',
            message: `⚠ The previous turn (started ${when}) was interrupted by a backend restart and did not finish. Re-send your message to continue.`,
            messageId: `run-recovery-${sessionId}-${startedAt}`
          } as any)
          this.uiHistoryService.flush(sessionId)
          recovered.push(sessionId)
        }
      } catch (e) {
        console.warn(`[AgentService_v2] Recovery annotation failed for ${marker.sessionId}:`, e)
      } finally {
        this.runMarkers.clear(marker.sessionId)
      }
    }
    if (recovered.length > 0) {
      console.log(`[AgentService_v2] Recovered ${recovered.length} interrupted run(s): ${recovered.join(', ')}`)
    }
    return { recovered }
  }

  private async clearCheckpoint(sessionId: string): Promise<void> {
    try {
      // Clear MemorySaver state for this thread after task completion/error.
      await this.checkpointer.deleteThread(sessionId)
    } catch {
      // best-effort cleanup
    }
  }

  private async trySaveSessionFromCheckpoint(sessionId: string): Promise<void> {
    if (!this.graph) return
    try {
      const snapshot = await this.graph.getState({ configurable: { thread_id: sessionId } })
      let messages = (snapshot as any)?.values?.messages as BaseMessage[] | undefined
      if (!messages || messages.length === 0) return
      
      // Check if there's an aborted message captured in the instance variable
      const abortedMessage = this.lastAbortedMessages.get(sessionId)
      if (abortedMessage) {
        console.log(`[AgentService_v2] Appending aborted message to history (sessionId=${sessionId}).`)
        messages = [...messages, abortedMessage]
        this.lastAbortedMessages.delete(sessionId) // Clear after use
      }
      
      const session = this.chatHistoryService.loadSession(sessionId) || {
        id: sessionId,
        title: 'New Session',
        messages: new Map(),
        lastCheckpointOffset: 0,
        lastProfileMaxTokens: this.getEffectiveMaxTokensForSession(sessionId)
      }
      this.updateSessionFromMessages(
        session,
        messages,
        this.getEffectiveMaxTokensForSession(sessionId)
      )
      this.chatHistoryService.saveSession(session)
    } catch (error) {
      console.warn('[AgentService_v2] Failed to save session from checkpoint:', error)
    }
  }

  // --- Session Management (Legacy / Internal) ---

  private updateSessionFromMessages(
    session: ChatSession,
    messages: BaseMessage[],
    lastProfileMaxTokens?: number
  ): void {
    let persisted = messages.filter((m) => !this.helpers.isEphemeral(m))
    const toolCallCleanResult = removeUnmatchedToolCallsFromHistory(persisted)
    persisted = toolCallCleanResult.messages
    if (toolCallCleanResult.removedToolCallCount > 0) {
      console.warn(
        `[AgentService_v2] Removed ${toolCallCleanResult.removedToolCallCount} orphan tool_calls before history persistence.`
      )
    }

    // Check if the last message is an empty AI message and remove it if so
    // if (persisted.length > 0) {
    //   const lastMsg = persisted[persisted.length - 1]
    //   if (AIMessage.isInstance(lastMsg)) {
    //     const content = this.helpers.extractText(lastMsg.content).trim()
    //     const hasToolCalls = (lastMsg as AIMessage).tool_calls && (lastMsg as AIMessage).tool_calls!.length > 0
    //     if (!content && !hasToolCalls) {
    //       persisted = persisted.slice(0, -1)
    //     }
    //   }
    // }

    const storedMessages = mapChatMessagesToStoredMessages(persisted)
    if (!this.shouldKeepDebugPayloadInPersistence()) {
      stripRawResponseFromStoredMessages(storedMessages as any[])
    }
    const newMessagesMap = new Map<string, typeof storedMessages[0]>()

    for (const msg of storedMessages) {
      const msgId =
        (msg as any)?.data?.additional_kwargs?._gyshellMessageId ||
        (msg as any)?.additional_kwargs?._gyshellMessageId ||
        uuidv4()
      newMessagesMap.set(msgId, msg)
    }

    session.messages = newMessagesMap
    if (typeof lastProfileMaxTokens === 'number') {
      session.lastProfileMaxTokens = lastProfileMaxTokens
    }
  }

  loadChatSession(sessionId: string): ChatSession | null {
    return this.chatHistoryService.loadSession(sessionId)
  }

  listStoredChatSessions(): StoredChatSession[] {
    return this.chatHistoryService.getAllSessions()
  }

  deleteChatSession(sessionId: string): void {
    this.releaseSessionModelBinding(sessionId)
    this.chatHistoryService.deleteSession(sessionId)
    this.uiHistoryService.deleteSession(sessionId)
  }

  renameChatSession(sessionId: string, newTitle: string): void {
    this.chatHistoryService.renameSession(sessionId, newTitle)
    this.uiHistoryService.renameSession(sessionId, newTitle)
  }

  exportChatSession(sessionId: string): any | null {
    return this.chatHistoryService.exportSession(sessionId)
  }

  rollbackToMessage(sessionId: string, messageId: string): { ok: boolean; removedCount: number } {
    const session = this.chatHistoryService.loadSession(sessionId)
    if (!session) {
      return { ok: false, removedCount: 0 }
    }

    const entries = Array.from(session.messages.entries())
    const idx = entries.findIndex(([id, msg]) => {
      if (id === messageId) return true
      const storedId = (msg as any)?.data?.additional_kwargs?._gyshellMessageId
      return storedId === messageId
    })
    if (idx === -1) {
      return { ok: false, removedCount: 0 }
    }

    const kept = entries.slice(0, idx)
    const keptStoredMessages = kept.map(([, msg]) => msg)
    const keptMessages = mapStoredMessagesToChatMessages(keptStoredMessages as any[])
    const rollbackSanitized = sanitizeCompressionAfterRollback(keptMessages, {
      pruneToolWindow: 10,
      protectedNormalRounds: COMPACTION_PROTECTED_NORMAL_USER_ROUNDS
    })

    this.updateSessionFromMessages(
      session,
      rollbackSanitized.messages,
      session.lastProfileMaxTokens
    )
    this.chatHistoryService.saveSession(session)

    return { ok: true, removedCount: entries.length - idx }
  }

  getAllChatHistory() {
    // Union both stores. The chatHistoryService snapshot only updates when a
    // task path explicitly calls saveSession (task completion success or
    // checkpoint-on-abort). The uiHistoryService snapshot updates on every
    // event, with debounced disk flushing. Sessions can therefore exist in
    // ui-history but not in chat-history — and the rehydrate-on-page-reload
    // code consumes this method to discover sessions, so it MUST see those
    // ui-only sessions or we silently lose them on reload.
    const backendSessions = this.chatHistoryService.getAllSessions()
    const uiSessions = this.uiHistoryService.getAllSessions()
    const uiById = new Map(uiSessions.map((u) => [u.id, u]))
    const seen = new Set<string>()

    const merged = backendSessions.map((backend) => {
      seen.add(backend.id)
      const ui = uiById.get(backend.id)
      return {
        ...backend,
        title: ui?.title || backend.title,
        // Prefer the UI session's updatedAt when fresher, since UI history
        // updates more often than chat history.
        updatedAt: Math.max(backend.updatedAt || 0, ui?.updatedAt || 0),
        messagesCount: ui?.messages.length || 0,
      }
    })

    // Append sessions that exist only in UI history. Synthesize a
    // chat-history-shaped record so callers don't have to special-case.
    for (const ui of uiSessions) {
      if (seen.has(ui.id)) continue
      merged.push({
        id: ui.id,
        title: ui.title || 'New Session',
        messages: [],
        lastCheckpointOffset: 0,
        createdAt: ui.updatedAt || Date.now(),
        updatedAt: ui.updatedAt || Date.now(),
        messagesCount: ui.messages.length,
      } as any)
    }

    return merged
  }
}
