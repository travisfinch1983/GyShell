import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CONTEXT_PACK_SLOTS,
  type AgentRegistryEntry,
  type ContextPack,
  type ContextPackSlot,
} from '@gyshell/shared'

/**
 * ContextPackStore (reqs 9-11, Phase 6) — per-agent "context pack": the
 * OpenClaw-style persona/context markdown docs that get assembled deterministically
 * into an agent's system prompt.
 *
 * Storage is on-disk, one file per slot, so the Phase-7 builder gets simple
 * per-file editing/diffing and the registry JSON stays lean (it carries only the
 * slot INDEX via `contextPackSlots`, never the bodies):
 *
 *     <baseDir>/<agentId>/<slot>.md
 *
 * The registry remains the single agent INDEX; the pack is agent-scoped content
 * addressed by agentId. Unknown/legacy files are ignored (only CONTEXT_PACK_SLOTS
 * are recognised).
 */

const SLOT_SET = new Set<string>(CONTEXT_PACK_SLOTS)
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/

/** Section headers used at assembly time. `null` = emit the body with no header (bootstrap = raw preamble). */
const SLOT_HEADERS: Record<ContextPackSlot, string | null> = {
  bootstrap: null,
  identity: '## Identity',
  soul: '## Operating Rules & Voice',
  user: '## About the User',
  tools: '## Tool Usage Guidance',
  agents: '## Fleet & Delegation',
  heartbeat: '## Heartbeat / Self-Check',
  memory: '## Agent Memory (supplements the global memory.md below)',
}

const PACK_MARKER = '=== AGENT CONTEXT PACK ==='

export class ContextPackStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(baseDir, { recursive: true })
  }

  private assertAgentId(agentId: string): void {
    if (!AGENT_ID_RE.test(agentId)) throw new Error(`ContextPackStore: invalid agentId "${agentId}"`)
  }

  private agentDir(agentId: string): string {
    this.assertAgentId(agentId)
    return join(this.baseDir, agentId)
  }

  private slotFile(agentId: string, slot: ContextPackSlot): string {
    return join(this.agentDir(agentId), `${slot}.md`)
  }

  /** Read a single slot's markdown body, or undefined if unauthored/empty. */
  readSlot(agentId: string, slot: ContextPackSlot): string | undefined {
    const file = this.slotFile(agentId, slot)
    if (!existsSync(file)) return undefined
    try {
      const body = readFileSync(file, 'utf8')
      return body.trim() ? body : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Write a slot. Empty/whitespace body DELETES the slot file (so clearing an
   * editor in the builder removes the slot rather than leaving a blank doc).
   */
  writeSlot(agentId: string, slot: ContextPackSlot, body: string): void {
    if (!SLOT_SET.has(slot)) throw new Error(`ContextPackStore: unknown slot "${slot}"`)
    const file = this.slotFile(agentId, slot)
    if (!body || !body.trim()) {
      if (existsSync(file)) rmSync(file)
      return
    }
    mkdirSync(this.agentDir(agentId), { recursive: true })
    writeFileSync(file, body)
  }

  /** Which slots have authored (non-empty) docs — the INDEX mirrored into the registry entry. */
  slotsFor(agentId: string): ContextPackSlot[] {
    this.assertAgentId(agentId)
    const dir = join(this.baseDir, agentId)
    if (!existsSync(dir)) return []
    const present: ContextPackSlot[] = []
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return []
    }
    // Preserve canonical slot order regardless of readdir order.
    for (const slot of CONTEXT_PACK_SLOTS) {
      if (entries.includes(`${slot}.md`) && this.readSlot(agentId, slot)) present.push(slot)
    }
    return present
  }

  /** Full pack (all authored slots) for an agent. */
  readPack(agentId: string): ContextPack {
    const pack: ContextPack = {}
    for (const slot of this.slotsFor(agentId)) {
      const body = this.readSlot(agentId, slot)
      if (body) pack[slot] = body
    }
    return pack
  }

  /** Replace an agent's whole pack; returns the resulting present-slot index. */
  writePack(agentId: string, pack: ContextPack): ContextPackSlot[] {
    for (const slot of CONTEXT_PACK_SLOTS) {
      this.writeSlot(agentId, slot, pack[slot] ?? '')
    }
    return this.slotsFor(agentId)
  }

  /** Remove an agent's entire pack directory (agent deletion). */
  deletePack(agentId: string): void {
    const dir = this.agentDir(agentId)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  /**
   * Assemble the pack into a system-prompt section for a run. Deterministic
   * CONTEXT_PACK_SLOTS order with section headers. Legacy fallback: if no
   * `identity` slot is authored but the entry carries a plain `persona` string,
   * that string is used as the identity body (back-compat with the pre-Phase-6
   * single-string persona). Returns undefined when the agent has no pack AND no
   * persona — callers then leave the base prompt unchanged.
   */
  assemble(entry: AgentRegistryEntry): string | undefined {
    const pack = this.readPack(entry.agentId)
    if (!pack.identity && entry.persona && entry.persona.trim()) {
      pack.identity = entry.persona.trim()
    }
    const present = CONTEXT_PACK_SLOTS.filter((s) => pack[s] && pack[s]!.trim())
    if (present.length === 0) return undefined

    const parts: string[] = [
      PACK_MARKER,
      `You are the agent "${entry.displayName}" (id: ${entry.agentId}). The section below defines who you are and how you operate for this session — adopt this identity, values, and operating rules as your own.`,
    ]
    for (const slot of present) {
      const header = SLOT_HEADERS[slot]
      const body = pack[slot]!.trim()
      if (header) parts.push('', header, body)
      else parts.push('', body)
    }
    return parts.join('\n')
  }
}
