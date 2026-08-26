import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  BROADCAST_ADDRESS,
  USER_AGENT_ID,
  busReplayRequestSchema,
  busSendRequestSchema,
  fleetGuardConfigSchema,
  relayInboundMessageSchema,
  type AgentActivity,
  type AgentRegistryEntry,
  type AgentStatus,
  type BusDeliveryState,
  type BusEnvelope,
  type BusRecord,
  type BusReplayResponse,
  type FleetGuardConfig,
} from '@gyshell/shared'
import type { BusStore } from './BusStore'
import { AgentRegistry } from './AgentRegistry'
import { GuardEngine } from './GuardEngine'

/** Reserved `from` for broker-emitted system notices (not a registry agent). */
export const BROKER_SENDER = 'broker'

/**
 * The seam to AgentService_v2 — injected so the bus is testable without it.
 * runTurn delivers a batch of envelopes as ONE turn on the agent's stable
 * session (R1.1 single-flight batching) and resolves when the turn ends.
 * Returns the session-transcript message id per delivered envelope, if known.
 */
export interface AgentInvoker {
  runTurn(
    agent: AgentRegistryEntry,
    batch: BusEnvelope[],
  ): Promise<{
    sessionMessageIds?: Record<number, string>
    /** The agent's reply text, if the turn produced one — the bus sends it back as a reply envelope. */
    replyBody?: string
  } | void>
}

export interface SendOptions {
  /** busSeq of the envelope this send replies to (threads the feed + marks the parent 'replied'). */
  parentSeq?: number
  /** true when a human turn directly caused this send — exempts it from the autonomy budget. */
  triggeredByHuman?: boolean
}

interface InboxEntry {
  envelope: BusEnvelope
}

/**
 * ConversationBus — the broker (doc §2a as amended by R1.1-R1.6).
 *
 * Envelopes are appended immutably; delivery lifecycle is separate records;
 * everything appended is emitted as a 'record' event (the TransportHub
 * fan-out seam). Local delivery is per-agent single-flight with batching,
 * and delivery-triggered inference sits behind guards whose kill switch
 * (autonomousRoutingEnabled) defaults OFF — with the switch off, envelopes
 * still append and fan out to viewers; local agents just don't run.
 */
export class ConversationBus extends EventEmitter {
  readonly registry: AgentRegistry
  readonly guards: GuardEngine
  private config: FleetGuardConfig
  private inboxes = new Map<string, InboxEntry[]>()
  private busy = new Set<string>()
  private budgetExhaustedNoticeSent = false

  constructor(
    private readonly store: BusStore,
    registry: AgentRegistry,
    private readonly configPath: string,
    private invoker: AgentInvoker | null = null,
    now: () => number = Date.now,
  ) {
    super()
    this.registry = registry
    this.config = this.loadConfig()
    this.guards = new GuardEngine(() => this.config, now)
  }

  // ─── Config / kill switch ─────────────────────────────────────────────────

  private loadConfig(): FleetGuardConfig {
    let raw: unknown = {}
    if (existsSync(this.configPath)) {
      try {
        raw = JSON.parse(readFileSync(this.configPath, 'utf8'))
      } catch (e) {
        console.warn(`[ConversationBus] bad config at ${this.configPath}, using defaults:`, e)
      }
    }
    const parsed = fleetGuardConfigSchema.safeParse(raw)
    return parsed.success ? parsed.data : fleetGuardConfigSchema.parse({})
  }

  getGuardConfig(): FleetGuardConfig {
    return { ...this.config }
  }

  setGuardConfig(patch: Partial<FleetGuardConfig>): FleetGuardConfig {
    const prev = this.config
    this.config = fleetGuardConfigSchema.parse({ ...prev, ...patch })
    mkdirSync(dirname(this.configPath), { recursive: true })
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    if (prev.autonomousRoutingEnabled !== this.config.autonomousRoutingEnabled) {
      this.systemNotice(
        this.config.autonomousRoutingEnabled
          ? 'Autonomous routing ENABLED — queued deliveries resuming.'
          : 'Autonomous routing DISABLED (kill switch) — deliveries will queue.',
      )
      this.budgetExhaustedNoticeSent = false
      if (this.config.autonomousRoutingEnabled) {
        for (const agentId of this.inboxes.keys()) void this.pump(agentId)
      }
    }
    return this.getGuardConfig()
  }

  setInvoker(invoker: AgentInvoker | null): void {
    this.invoker = invoker
  }

  // ─── Send path ────────────────────────────────────────────────────────────

  /**
   * Identity is broker-enforced (claude1's impl guardrail): `trustedFrom`
   * comes from the calling integration (UI transport → USER_AGENT_ID, agent
   * turn → that agent's id, relay handler → mapped sender) and OVERRIDES
   * whatever the request body claims.
   */
  send(
    origin: BusEnvelope['origin'],
    trustedFrom: string,
    request: unknown,
    opts: SendOptions = {},
  ): BusEnvelope {
    const req = busSendRequestSchema.parse(request)
    if (req.from !== trustedFrom) {
      console.warn(`[ConversationBus] sender identity override: claimed "${req.from}", trusted "${trustedFrom}"`)
    }

    const dup = this.store.findBySenderMessageId(trustedFrom, req.id)
    if (dup) return dup

    const parent = opts.parentSeq !== undefined ? this.store.getEnvelope(opts.parentSeq) : undefined
    const triggeredByHuman = opts.triggeredByHuman ?? trustedFrom === USER_AGENT_ID
    const hopCount =
      parent !== undefined
        ? Math.max(0, parent.hopCount - 1)
        : this.config.defaultHopTtl
    const autonomous = !triggeredByHuman && trustedFrom !== USER_AGENT_ID

    const envelope: BusEnvelope = {
      busSeq: this.store.nextSeq(),
      id: req.id,
      ts: new Date().toISOString(),
      from: trustedFrom,
      to: req.to,
      kind: req.kind,
      body: req.body,
      replyToSeq: req.replyToSeq ?? opts.parentSeq,
      hopCount,
      autonomous,
      origin,
    }
    this.appendRecord({ type: 'envelope', envelope })

    // Reply linkage: the parent envelope is now answered.
    if (parent !== undefined) {
      this.appendDelivery(parent.busSeq, 'replied', { targetAgentId: trustedFrom })
    }

    // Send-time guards (hop TTL, pair rate) — envelope stays in the log
    // (audit trail); the drop is a feed-visible delivery record.
    const verdict = this.guards.checkSend(envelope.from, envelope.to, envelope.hopCount)
    if (!verdict.allow) {
      this.appendDelivery(envelope.busSeq, 'dropped', { reason: verdict.reason })
      return envelope
    }
    this.guards.notePairSend(envelope.from, envelope.to)

    for (const recipient of this.resolveRecipients(envelope)) {
      this.routeToRecipient(envelope, recipient)
    }
    return envelope
  }

  private resolveRecipients(envelope: BusEnvelope): AgentRegistryEntry[] {
    if (envelope.to === BROADCAST_ADDRESS) {
      return this.registry.deliverable().filter((a) => a.agentId !== envelope.from)
    }
    const target = this.registry.get(envelope.to)
    if (!target) {
      this.appendDelivery(envelope.busSeq, 'dropped', { reason: 'unknown_agent' })
      return []
    }
    return [target]
  }

  private routeToRecipient(envelope: BusEnvelope, recipient: AgentRegistryEntry): void {
    const targetAgentId = recipient.agentId
    if (recipient.kind === 'user') {
      // The feed IS the user's inbox — nothing to trigger.
      this.appendDelivery(envelope.busSeq, 'delivered', { targetAgentId })
      return
    }
    if (recipient.kind === 'relay') {
      // Phase 1 is inbound-only (R1.6); outbound bridging is Phase 5. The
      // envelope is still feed-visible — that's the dogfooding value.
      this.appendDelivery(envelope.busSeq, 'dropped', { targetAgentId, reason: 'relay_outbound_unwired' })
      return
    }
    if (!recipient.enabled) {
      this.appendDelivery(envelope.busSeq, 'dropped', { targetAgentId, reason: 'agent_disabled' })
      return
    }
    const inbox = this.inboxes.get(targetAgentId) ?? []
    const cap = recipient.limits?.maxQueueDepth ?? 20
    if (inbox.length >= cap) {
      this.appendDelivery(envelope.busSeq, 'dropped', { targetAgentId, reason: 'queue_full' })
      return
    }
    inbox.push({ envelope })
    this.inboxes.set(targetAgentId, inbox)
    this.appendDelivery(envelope.busSeq, 'queued', { targetAgentId })
    void this.pump(targetAgentId)
  }

  // ─── Delivery pump (single-flight per agent, batched) ─────────────────────

  private async pump(agentId: string): Promise<void> {
    if (this.busy.has(agentId)) return
    const agent = this.registry.get(agentId)
    if (!agent || agent.kind !== 'local') return
    const inbox = this.inboxes.get(agentId)
    if (!inbox || inbox.length === 0) return

    // Kill switch gates ALL delivery-triggered inference until reviewed.
    if (!this.config.autonomousRoutingEnabled) return
    if (!this.invoker) return

    // Budget applies to runs carrying any autonomous envelope; a purely
    // human-triggered batch runs regardless of remaining budget.
    const hasAutonomous = inbox.some((m) => m.envelope.autonomous)
    if (hasAutonomous) {
      const verdict = this.guards.checkAutonomousDelivery(agent)
      if (!verdict.allow) {
        if (verdict.reason === 'autonomy_budget' && !this.budgetExhaustedNoticeSent) {
          this.budgetExhaustedNoticeSent = true
          this.systemNotice(
            `Autonomy budget exhausted (${this.config.autonomyBudgetPerHour}/h) — autonomous deliveries paused until the window rolls.`,
          )
        }
        return // stays queued; a later pump (config change / next send) retries
      }
    }

    const batch = inbox.splice(0, inbox.length)
    this.busy.add(agentId)
    try {
      if (batch.some((m) => m.envelope.autonomous)) this.guards.noteAutonomousRun(agentId)
      for (const m of batch) {
        this.appendDelivery(m.envelope.busSeq, 'inference_started', { targetAgentId: agentId })
      }
      const result = await this.invoker.runTurn(agent, batch.map((m) => m.envelope))
      for (const m of batch) {
        this.appendDelivery(m.envelope.busSeq, 'delivered', {
          targetAgentId: agentId,
          sessionMessageId: result?.sessionMessageIds?.[m.envelope.busSeq],
        })
      }
      // Reply path: the agent's answer goes back onto the bus as a reply to the
      // most recent envelope in the batch, addressed to its sender. Autonomy is
      // inherited — a reply to a purely human-triggered batch stays budget-exempt,
      // while replies in agent↔agent chains stay autonomous (and hop-limited).
      const replyBody = result && 'replyBody' in (result as object) ? (result as { replyBody?: string }).replyBody : undefined
      if (replyBody && replyBody.trim().length > 0) {
        const last = batch[batch.length - 1].envelope
        this.send(
          'agent',
          agentId,
          { id: `reply-${agentId}-${last.busSeq}`, from: agentId, to: last.from, kind: 'dm', body: replyBody },
          { parentSeq: last.busSeq, triggeredByHuman: batch.every((m) => !m.envelope.autonomous) },
        )
      }
    } catch (e) {
      const reason = `invoker_error: ${e instanceof Error ? e.message : String(e)}`
      for (const m of batch) {
        this.appendDelivery(m.envelope.busSeq, 'dropped', { targetAgentId: agentId, reason })
      }
    } finally {
      this.busy.delete(agentId)
    }
    // Messages may have queued while we ran.
    void this.pump(agentId)
  }

  // ─── Inbound relay bridge (R1.6) ──────────────────────────────────────────

  /**
   * Accepts a claude-relay-style POST body; returns the appended envelope.
   * recipient "broadcast" fans out to every enabled agent (relay replacement:
   * this + cursor reads is the whole claude-relay surface).
   */
  handleRelayInbound(payload: unknown): BusEnvelope {
    const msg = relayInboundMessageSchema.parse(payload)
    const sender = this.registry.ensureRelayAgent(msg.sender)
    const wantsBroadcast = msg.recipient.toLowerCase() === BROADCAST_ADDRESS
    // Recipient: broadcast, an existing agentId, the user, or auto-registered relay name.
    const recipient = wantsBroadcast
      ? null
      : (this.registry.get(msg.recipient) ??
        (msg.recipient.toLowerCase() === USER_AGENT_ID
          ? this.registry.get(USER_AGENT_ID)!
          : this.registry.ensureRelayAgent(msg.recipient)))

    // Backpressure (R1.6): cap queued local deliveries per external sender.
    const queuedFromSender = [...this.inboxes.values()]
      .flat()
      .filter((m) => m.envelope.from === sender.agentId).length
    if (queuedFromSender >= this.config.relayInboundQueueCap) {
      throw new Error(`relay inbound queue cap reached for ${sender.agentId}`)
    }

    return this.send('relay', sender.agentId, {
      id: `relay-${msg.sender}-${this.store.nextSeq()}`,
      from: sender.agentId,
      to: wantsBroadcast ? BROADCAST_ADDRESS : recipient!.agentId,
      kind: wantsBroadcast ? 'broadcast' : 'dm',
      body: msg.message,
    })
  }

  // ─── Replay / status ──────────────────────────────────────────────────────

  replay(request: unknown): BusReplayResponse {
    const req = busReplayRequestSchema.parse(request)
    const records = this.store.readAfter(req.afterSeq, req.limit)
    const last = records[records.length - 1]
    return {
      records,
      nextAfterSeq: last ? (last.type === 'envelope' ? last.envelope.busSeq : last.update.seq) : req.afterSeq,
      latestSeq: this.store.latestSeq(),
    }
  }

  /**
   * Liveness reported by whoever actually delivers to an agent (the fleet
   * forwarder, which owns the dtach sockets and is the ONLY component that can
   * observe whether a session exists). Not persisted — presence is runtime state.
   */
  private heartbeats = new Map<string, { at: number; alive: boolean }>()

  /** Heartbeats older than this are ignored; the reporter polls every ~5s. */
  private static readonly HEARTBEAT_STALE_MS = 30_000

  recordHeartbeat(agentId: string, alive: boolean): void {
    if (!agentId) return
    this.heartbeats.set(agentId, { at: Date.now(), alive })
  }

  /**
   * Activity reported by a collector (transcript tailer for Claude Code
   * instances, ACP-ring reader for Hermes agents). Runtime state, not persisted.
   */
  private activity = new Map<string, AgentActivity>()

  /** Beyond this the reading itself is suspect — the COLLECTOR may be down. */
  private static readonly ACTIVITY_STALE_MS = 120_000

  recordActivity(a: AgentActivity): void {
    if (!a?.agentId) return
    // MERGE, don't replace. Collectors ship the `recent` window only when the
    // agent has newly acted (otherwise idle agents would push hundreds of KB
    // every poll), so a wholesale replace would erase the window on the very
    // next report and `available` would sit at 0 forever.
    const prev = this.activity.get(a.agentId)
    this.activity.set(a.agentId, {
      ...a,
      recent: a.recent ?? prev?.recent,
    })
  }

  /**
   * @param agentId omit for every known agent.
   * Returns `unknown` rather than inventing a state when no collector has
   * reported, and downgrades to `unknown` when the reading has gone stale —
   * a confidently wrong "idle" is what made this whole class of bug invisible.
   */
  agentActivity(agentId?: string): AgentActivity[] {
    const now = Date.now()
    const stale = (a: AgentActivity): AgentActivity => {
      const age = now - Date.parse(a.observedAt)
      if (!Number.isFinite(age) || age < ConversationBus.ACTIVITY_STALE_MS) return a
      return {
        ...a,
        state: 'unknown',
        lastEventSummary:
          `${a.lastEventSummary ?? 'n/a'} (STALE: no collector report for ${Math.round(age / 1000)}s)`,
      }
    }
    if (agentId) {
      const one = this.activity.get(agentId)
      return one ? [stale(one)] : []
    }
    return [...this.activity.values()].map(stale)
  }

  agentStatuses(): AgentStatus[] {
    const now = Date.now()
    return this.registry.list().map((a) => {
      const queueDepth = this.inboxes.get(a.agentId)?.length ?? 0
      const hb = this.heartbeats.get(a.agentId)
      const hbFresh = !!hb && now - hb.at < ConversationBus.HEARTBEAT_STALE_MS

      let status: AgentStatus['status']
      let statusSource: AgentStatus['statusSource']
      if (this.busy.has(a.agentId)) {
        status = 'thinking'; statusSource = 'busy'
      } else if (queueDepth > 0) {
        status = 'queued'; statusSource = 'queue'
      } else if (hbFresh) {
        // A real observation beats any structural guess.
        status = hb!.alive ? 'idle' : 'offline'
        statusSource = 'heartbeat'
      } else if (hb) {
        // We heard from it once, but not recently — say so rather than
        // implying we know it is down.
        status = 'offline'; statusSource = 'stale-heartbeat'
      } else {
        // Nobody has ever reported on this agent. Preserved legacy behaviour,
        // but flagged so callers can tell it apart from a real observation.
        status = a.kind === 'local' ? 'idle' : 'offline'
        statusSource = 'kind-fallback'
      }

      return {
        agentId: a.agentId,
        status,
        queueDepth,
        updatedAt: new Date(now).toISOString(),
        ...(hb ? { lastSeenAt: new Date(hb.at).toISOString() } : {}),
        statusSource,
      }
    })
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private appendRecord(record: BusRecord): void {
    this.store.append(record)
    this.emit('record', record)
  }

  private appendDelivery(
    refSeq: number,
    state: BusDeliveryState,
    extra: { targetAgentId?: string; reason?: string; sessionMessageId?: string } = {},
  ): void {
    this.appendRecord({
      type: 'delivery',
      update: {
        seq: this.store.nextSeq(),
        refSeq,
        state,
        ts: new Date().toISOString(),
        ...extra,
      },
    })
  }

  /** Broker-emitted feed-visible notice (kill switch flips, budget exhaustion). */
  private systemNotice(body: string): void {
    const envelope: BusEnvelope = {
      busSeq: this.store.nextSeq(),
      id: `notice-${this.store.nextSeq()}`,
      ts: new Date().toISOString(),
      from: BROKER_SENDER,
      to: BROADCAST_ADDRESS,
      kind: 'system',
      body,
      hopCount: 0,
      autonomous: false,
      origin: 'broker',
    }
    this.appendRecord({ type: 'envelope', envelope })
  }
}
