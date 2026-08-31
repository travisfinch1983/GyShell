import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  agentRegistryEntrySchema,
  USER_AGENT_ID,
  type AgentRegistryEntry,
} from '@gyshell/shared'

/**
 * Declarative agent registry (doc R1.5): agents are DECLARED here, not
 * inferred from chat sessions. Persisted as a small JSON file. The reserved
 * `user` entry always exists in memory (never needs declaring).
 */
export class AgentRegistry {
  private agents = new Map<string, AgentRegistryEntry>()

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.load()
  }

  private load(): void {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as { agents?: unknown[] }
        for (const entry of raw.agents ?? []) {
          const parsed = agentRegistryEntrySchema.safeParse(entry)
          if (parsed.success) this.agents.set(parsed.data.agentId, parsed.data)
          else console.warn('[ConversationBus] AgentRegistry: skipping invalid entry:', parsed.error.message)
        }
      } catch (e) {
        console.warn(`[ConversationBus] AgentRegistry: failed to read ${this.filePath}:`, e)
      }
    }
    if (!this.agents.has(USER_AGENT_ID)) {
      this.agents.set(USER_AGENT_ID, {
        agentId: USER_AGENT_ID,
        displayName: 'Travis',
        kind: 'user',
        enabled: true,
      })
    }
  }

  private persist(): void {
    // The built-in user entry is implicit; keep the file to declared agents.
    const agents = [...this.agents.values()].filter((a) => a.kind !== 'user')
    writeFileSync(this.filePath, JSON.stringify({ agents }, null, 2))
  }

  get(agentId: string): AgentRegistryEntry | undefined {
    return this.agents.get(agentId)
  }

  /**
   * Reverse lookup used by the context-pack assembly (reqs 9-11): map a running
   * session back to its declared agent so the agent's pack can be injected into
   * the system prompt. Undefined for plain UI scratch sessions (not fleet agents).
   */
  getBySessionId(sessionId: string): AgentRegistryEntry | undefined {
    if (!sessionId) return undefined
    for (const entry of this.agents.values()) {
      if (entry.kind === 'local' && entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  list(): AgentRegistryEntry[] {
    return [...this.agents.values()]
  }

  upsert(entry: unknown): AgentRegistryEntry {
    const parsed = agentRegistryEntrySchema.parse(entry)
    if (parsed.kind === 'user') throw new Error('the user entry is built-in and cannot be declared')
    this.agents.set(parsed.agentId, parsed)
    this.persist()
    return parsed
  }

  // (deliverable(), setSessionId() and ensureRelayAgent() REMOVED, 2026-08-31.
  // All three were ConversationBus write paths with zero callers after the bus
  // retirement — and ensureRelayAgent still MUTATED registry.json if anything
  // ever reached it: a retired path that accepts writes is stale state waiting
  // to breed confusion, which is the exact wording of Travis's retire ruling.
  // The registry itself stays: ContextPackStore still resolves personas
  // through it.)
}
