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

  list(): AgentRegistryEntry[] {
    return [...this.agents.values()]
  }

  /** Enabled non-user agents — the broadcast recipient set (minus the sender). */
  deliverable(): AgentRegistryEntry[] {
    return this.list().filter((a) => a.enabled && a.kind !== 'user')
  }

  upsert(entry: unknown): AgentRegistryEntry {
    const parsed = agentRegistryEntrySchema.parse(entry)
    if (parsed.kind === 'user') throw new Error('the user entry is built-in and cannot be declared')
    this.agents.set(parsed.agentId, parsed)
    this.persist()
    return parsed
  }

  /** Written back when the bus lazily creates a local agent's stable session. */
  setSessionId(agentId: string, sessionId: string): void {
    const entry = this.agents.get(agentId)
    if (!entry || entry.kind !== 'local') throw new Error(`no local agent ${agentId}`)
    this.agents.set(agentId, { ...entry, sessionId })
    this.persist()
  }

  /**
   * Auto-register an unknown relay sender (R1.6: inbound bridge should make
   * claude1/fable/minion traffic appear without manual config). Slugifies the
   * relay name into an agentId.
   */
  ensureRelayAgent(relayName: string): AgentRegistryEntry {
    const agentId = relayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 64)
    const existing = this.agents.get(agentId)
    if (existing) return existing
    const entry = agentRegistryEntrySchema.parse({
      agentId,
      displayName: relayName,
      kind: 'relay',
      relayRecipient: relayName,
      enabled: true,
    })
    this.agents.set(agentId, entry)
    this.persist()
    return entry
  }
}
