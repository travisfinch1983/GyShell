import { z } from 'zod'
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { ChatOpenAI } from '@langchain/openai'
import type { AgentDefinition, ModelDefinition } from '../../../types'
import { runWebFetch, runWebSearch } from './web_tools'
import { runReadFile, readFileSchema } from './read_tools'
import { writeAndEdit, writeAndEditSchema } from './edit_tools'
import {
  runSkillTool,
  runCreateSkillTool,
  skillToolSchema,
  createSkillSchema,
} from './skill_tools'
import {
  runMemoryListCollections,
  runMemoryRecall,
  runMemorySave,
  runMemoryCreateCollection,
  runMemoryDelete,
} from './memory_tools'
import type { ToolExecutionContext } from '../types'
import type { ISkillRuntime } from '../../runtimeContracts'

export const MAX_DELEGATE_DEPTH = 3
export const MAX_DELEGATE_TURNS = 30

export const delegateAgentSchema = z.object({
  agent_name: z
    .string()
    .min(1)
    .describe('Name of the configured agent to delegate to (must match an entry from available_agents)'),
  prompt: z
    .string()
    .min(1)
    .describe('The task or question to send to the delegated agent. Be specific — include file paths, constraints, and the form of answer you want.'),
})

export type DelegateAgentResult =
  | { kind: 'text'; message: string }
  | { kind: 'error'; message: string }

export function buildDelegateAgentDescription(agents: AgentDefinition[]): string {
  const header = [
    'Delegate a focused subtask to a configured specialist agent.',
    'Each agent has its own system prompt, model, and tool allowlist tuned for a specific role (researcher, coder, planner, etc.).',
    'Use this when a subtask benefits from a different model or a more focused tool set than your own.',
    'You MUST choose a valid agent_name from the list below.',
    '',
    'PARALLEL DISPATCH: when you need to fan out N independent sub-tasks, emit N delegate_agent tool calls in the SAME response. They run concurrently. Emitting them across multiple responses runs them sequentially and the user waits N times longer. Never say "I will dispatch the rest in parallel" and then emit a single call — that is sequential. Put all the parallel calls in this turn, or they are not parallel.',
  ]
  if (agents.length === 0) {
    return [
      ...header,
      '',
      'No agents are configured yet. Open Settings → Agents to define one.',
    ].join('\n')
  }
  const available = agents.flatMap((a) => [
    '  <agent>',
    `    <name>${a.name}</name>`,
    `    <description>${a.description || '(no description)'}</description>`,
    `    <tools>${a.allowedTools.join(', ') || 'none'}</tools>`,
    '  </agent>',
  ])
  return [...header, '<available_agents>', ...available, '</available_agents>'].join('\n')
}

export interface ResolvedModelCandidate {
  /** Model profile id this candidate represents (key for pool tracking) */
  profileId: string
  /** Resolved model definition (baseUrl/apiKey/model name) used to instantiate the LLM */
  modelItem: ModelDefinition
  /**
   * Concurrency slots reported by the backend (proxlab's _proxlab_slots in /v1/models).
   * Falls back to 1 when unknown. The pool issues up to this many concurrent calls
   * against a given profile before routing the next one elsewhere or queuing.
   */
  slots: number
}

export interface DelegateAgentDeps {
  agents: AgentDefinition[]
  /** Resolve every model assigned to an agent + its slot count. Empty = no resolvable models. */
  resolveModels: (agent: AgentDefinition) => ResolvedModelCandidate[]
  createChatModel: (modelItem: ModelDefinition, temperature: number) => ChatOpenAI
  buildToolsForModel: (allowedNames: string[]) => any[]
  executionContext: ToolExecutionContext
  skillService: ISkillRuntime | null
  depth: number
}

/**
 * Per-agent pool that tracks how many concurrent calls each assigned model
 * profile is currently servicing. Acquire picks the first profile with free
 * capacity; if all are saturated, the call queues until a release wakes it.
 *
 * State is in-memory, scoped to the AgentService process. No backend
 * persistence — the pool resets cleanly on restart, and concurrent calls in
 * the same process share the same view.
 */
class AgentModelPool {
  /** agentId -> Map<profileId, currentlyInUse> */
  private inUse = new Map<string, Map<string, number>>()
  /** agentId -> FIFO queue of resolvers waiting for any profile to free up */
  private waiters = new Map<string, Array<() => void>>()
  /** Round-robin cursor per agent — biases new acquires to spread across profiles */
  private cursor = new Map<string, number>()
  /** Activity observer — called whenever per-agent in-flight totals change */
  private activityObserver: ((counts: Record<string, number>) => void) | null = null

  setActivityObserver(fn: ((counts: Record<string, number>) => void) | null): void {
    this.activityObserver = fn
  }

  getActivityCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [agentId, usage] of this.inUse.entries()) {
      let total = 0
      for (const c of usage.values()) total += c
      if (total > 0) out[agentId] = total
    }
    return out
  }

  private notifyActivityChanged(): void {
    if (!this.activityObserver) return
    try { this.activityObserver(this.getActivityCounts()) } catch {}
  }

  async acquire(
    agentId: string,
    candidates: ResolvedModelCandidate[],
    signal?: AbortSignal,
  ): Promise<{ candidate: ResolvedModelCandidate; release: () => void }> {
    if (candidates.length === 0) {
      throw new Error(`AgentModelPool.acquire: no candidates for agent ${agentId}`)
    }
    while (true) {
      if (signal?.aborted) throw new Error('AbortError')
      const usage = this.inUse.get(agentId) ?? new Map<string, number>()
      const startIdx = (this.cursor.get(agentId) ?? 0) % candidates.length
      // Walk candidates starting from the round-robin cursor so calls spread
      // across profiles instead of stacking on the first one with capacity.
      for (let offset = 0; offset < candidates.length; offset++) {
        const c = candidates[(startIdx + offset) % candidates.length]
        const cur = usage.get(c.profileId) ?? 0
        if (cur < c.slots) {
          usage.set(c.profileId, cur + 1)
          this.inUse.set(agentId, usage)
          this.cursor.set(agentId, (startIdx + offset + 1) % candidates.length)
          this.notifyActivityChanged()
          let released = false
          const release = () => {
            if (released) return
            released = true
            this.release(agentId, c.profileId)
          }
          return { candidate: c, release }
        }
      }
      // All saturated — wait for a release to wake us, then re-check.
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiters.get(agentId) ?? []
        const wakeup = () => {
          if (signal) signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          // Remove ourselves from the queue so a release doesn't try to wake a
          // waiter that's already aborted.
          const q = this.waiters.get(agentId)
          if (q) {
            const i = q.indexOf(wakeup)
            if (i >= 0) q.splice(i, 1)
          }
          reject(new Error('AbortError'))
        }
        queue.push(wakeup)
        this.waiters.set(agentId, queue)
        if (signal) {
          if (signal.aborted) {
            onAbort()
          } else {
            signal.addEventListener('abort', onAbort, { once: true })
          }
        }
      })
    }
  }

  private release(agentId: string, profileId: string) {
    const usage = this.inUse.get(agentId)
    if (!usage) return
    const n = (usage.get(profileId) ?? 0) - 1
    if (n <= 0) usage.delete(profileId)
    else usage.set(profileId, n)
    this.notifyActivityChanged()
    const queue = this.waiters.get(agentId)
    const next = queue?.shift()
    if (next) next()
  }
}

const agentModelPool = new AgentModelPool()

/**
 * Subscribe to per-agent in-flight count changes from the model pool.
 * The observer is called with a `{ agentId: count }` snapshot whenever the
 * pool's usage map mutates. Pass `null` to clear. Used by GatewayService to
 * broadcast counts over `agents:active` so the sidebar can render badges.
 */
export function setAgentPoolActivityObserver(
  fn: ((counts: Record<string, number>) => void) | null,
): void {
  agentModelPool.setActivityObserver(fn)
}

export function getAgentPoolActivityCounts(): Record<string, number> {
  return agentModelPool.getActivityCounts()
}

const STATELESS_TOOLS = new Set([
  'web_fetch',
  'web_search',
  'read_file',
  'create_or_edit',
  'skill',
  'create_skill',
  'memory_list_collections',
  'memory_recall',
  'memory_save',
  'memory_create_collection',
  'memory_delete',
])

async function dispatchSubTool(
  toolName: string,
  rawArgs: any,
  deps: DelegateAgentDeps,
): Promise<string> {
  const signal = deps.executionContext.signal
  if (signal?.aborted) throw new Error('AbortError')

  switch (toolName) {
    case 'web_fetch': {
      const out = await runWebFetch(rawArgs, signal)
      return out.message
    }
    case 'web_search': {
      const out = await runWebSearch(rawArgs, signal)
      return out.message
    }
    case 'read_file': {
      const args = readFileSchema.parse(rawArgs)
      const out = await runReadFile(args, deps.executionContext, { image: false })
      return out.resultText
    }
    case 'create_or_edit': {
      const args = writeAndEditSchema.parse(rawArgs)
      return await writeAndEdit(args, deps.executionContext)
    }
    case 'skill': {
      if (!deps.skillService) return 'Error: skill service not available in delegated context.'
      const args = skillToolSchema.parse(rawArgs)
      const out = await runSkillTool(args, deps.skillService, signal)
      return out.message
    }
    case 'create_skill': {
      if (!deps.skillService) return 'Error: skill service not available in delegated context.'
      const args = createSkillSchema.parse(rawArgs)
      const out = await runCreateSkillTool(args, deps.skillService, signal)
      return out.message
    }
    case 'memory_list_collections': {
      const out = await runMemoryListCollections(rawArgs, signal)
      return out.message
    }
    case 'memory_recall': {
      const out = await runMemoryRecall(rawArgs, signal)
      return out.message
    }
    case 'memory_save': {
      const out = await runMemorySave(rawArgs, signal)
      return out.message
    }
    case 'memory_create_collection': {
      const out = await runMemoryCreateCollection(rawArgs, signal)
      return out.message
    }
    case 'memory_delete': {
      const out = await runMemoryDelete(rawArgs, signal)
      return out.message
    }
    default:
      return `Tool "${toolName}" is not available in a delegated agent. Only stateless tools are supported here: ${Array.from(STATELESS_TOOLS).join(', ')}.`
  }
}

export async function runDelegateAgent(
  rawArgs: unknown,
  deps: DelegateAgentDeps,
): Promise<DelegateAgentResult> {
  const validated = delegateAgentSchema.safeParse(rawArgs)
  if (!validated.success) {
    return { kind: 'error', message: `delegate_agent invalid arguments: ${validated.error.message}` }
  }
  const { agent_name, prompt } = validated.data

  if (deps.depth >= MAX_DELEGATE_DEPTH) {
    return {
      kind: 'error',
      message: `delegate_agent: max delegation depth (${MAX_DELEGATE_DEPTH}) exceeded. The chain of delegating agents is too deep.`,
    }
  }

  const agent = deps.agents.find((a) => a.name === agent_name)
  if (!agent) {
    const available = deps.agents.map((a) => a.name).join(', ') || 'none'
    return {
      kind: 'error',
      message: `delegate_agent: agent "${agent_name}" not found. Available agents: ${available}`,
    }
  }

  const candidates = deps.resolveModels(agent)
  if (candidates.length === 0) {
    return {
      kind: 'error',
      message: `delegate_agent: agent "${agent_name}" has no resolvable model. Assign one or more model profiles in Settings → Agents.`,
    }
  }

  const allowedSet = new Set(agent.allowedTools)
  const filteredAllowed = agent.allowedTools.filter((t) => STATELESS_TOOLS.has(t))
  const toolDefs = deps.buildToolsForModel(filteredAllowed)

  const skippedTools = agent.allowedTools.filter((t) => !STATELESS_TOOLS.has(t))
  const headerNotes: string[] = []
  if (skippedTools.length > 0) {
    headerNotes.push(
      `Note: the following allowlisted tools are not yet supported in delegated context and were excluded: ${skippedTools.join(', ')}.`,
    )
  }

  // Acquire a slot from the agent's model pool. Picks the first profile with
  // free capacity (round-robin biased), or queues if all are saturated.
  // Released in finally so a thrown error or abort doesn't leak a busy slot.
  const acquired = await agentModelPool.acquire(agent.id, candidates, deps.executionContext.signal)
  try {
    const model = deps.createChatModel(acquired.candidate.modelItem, 0.7)
    const modelWithTools = toolDefs.length > 0 ? model.bindTools(toolDefs) : model

    const messages: BaseMessage[] = [
      new SystemMessage(agent.systemPrompt || ''),
      new HumanMessage(prompt),
    ]

    const profileTag = candidates.length > 1 ? ` via ${acquired.candidate.profileId}` : ''

    for (let turn = 0; turn < MAX_DELEGATE_TURNS; turn++) {
      if (deps.executionContext.signal?.aborted) throw new Error('AbortError')

      const response = (await modelWithTools.invoke(messages)) as AIMessage
      messages.push(response)

      const toolCalls = response.tool_calls ?? []
      if (toolCalls.length === 0) {
        const text = typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content)
        const finalMessage = [
          ...headerNotes,
          `[delegate_agent → ${agent.name}${profileTag}, turns: ${turn + 1}]`,
          text,
        ].filter(Boolean).join('\n\n')
        return { kind: 'text', message: finalMessage }
      }

      for (const tc of toolCalls) {
        let result: string
        if (!allowedSet.has(tc.name)) {
          result = `Tool "${tc.name}" is not in this agent's allowlist.`
        } else {
          try {
            result = await dispatchSubTool(tc.name, tc.args, deps)
          } catch (err) {
            if ((err as any)?.name === 'AbortError') throw err
            result = `Tool error: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        messages.push(
          new ToolMessage({
            content: result,
            tool_call_id: tc.id ?? '',
          }),
        )
      }
    }

    const lastAi = [...messages].reverse().find((m) => AIMessage.isInstance(m)) as AIMessage | undefined
    const partial = lastAi
      ? typeof lastAi.content === 'string'
        ? lastAi.content
        : JSON.stringify(lastAi.content)
      : ''
    return {
      kind: 'text',
      message: [
        ...headerNotes,
        `[delegate_agent → ${agent.name}${profileTag}: hit max turns (${MAX_DELEGATE_TURNS}); returning latest partial output]`,
        partial,
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  } finally {
    acquired.release()
  }
}
