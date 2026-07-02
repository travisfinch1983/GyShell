/**
 * Fleet contracts — shared schemas for the ConversationBus (broker), the
 * AgentRegistry, and the Fleet Feed. These are the frozen seam between the
 * bus vertical (fable) and the ViewContext/compaction verticals (claude1);
 * change them only by agreement in /claude/plans/ailab-chat-rework.md.
 *
 * Design rules these types encode (doc §Fable's review, ratified):
 * - R1.3  Bus log = routing/audit truth; session transcripts = conversation
 *         truth. Envelopes are IMMUTABLE; delivery lifecycle is separate
 *         append-only update records. The Fleet Feed renders only bus records.
 * - R1.2  Loop guards are broker-enforced schema fields (hopCount TTL,
 *         autonomous flag for budget accounting), not agent goodwill.
 * - R1.4  Replay is cursor-based (busSeq / afterSeq), never "full log".
 * - F1    autonomousRoutingEnabled defaults to FALSE — delivery-triggered
 *         inference stays dark until the guards are built and reviewed.
 */
import { z } from 'zod'

/** Reserved agentId for the human operator. */
export const USER_AGENT_ID = 'user'
/** Reserved `to` address that fans out to every enabled agent. */
export const BROADCAST_ADDRESS = 'broadcast'

const agentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'agentId: lowercase slug (a-z, 0-9, -, _)')

// ─── AgentRegistry ───────────────────────────────────────────────────────────

/**
 * Declarative registry entry (R1.5): agents are DECLARED, not inferred from
 * sessions. UI scratch sessions are not fleet agents unless promoted.
 */
export const agentRegistryEntrySchema = z.object({
  agentId: agentIdSchema,
  displayName: z.string().min(1),
  /** local = backed by an AgentService_v2 session; relay = external instance via claude-relay; user = the human. */
  kind: z.enum(['local', 'relay', 'user']),
  /** local only: model profile the agent's session runs with. */
  profileId: z.string().optional(),
  /** local only: system-prompt preamble. (Reqs 9-11 will evolve this into persona files — keep it a plain string here.) */
  persona: z.string().optional(),
  /**
   * local only: the agent's stable session id. Created lazily by the bus on
   * first delivery and written back to the registry; never auto-wiped.
   */
  sessionId: z.string().optional(),
  /** relay only: recipient name on the claude-relay directory (e.g. "claude1"). */
  relayRecipient: z.string().optional(),
  /** Per-agent overrides of fleet-level guard defaults. */
  limits: z
    .object({
      /** Inbound envelopes queued while busy before the broker starts dropping (with a feed-visible reason). */
      maxQueueDepth: z.number().int().positive(),
      /** Overrides FleetGuardConfig.autonomyBudgetPerHour for this agent. */
      maxAutonomousPerHour: z.number().int().nonnegative(),
    })
    .partial()
    .optional(),
  enabled: z.boolean().default(true),
})
export type AgentRegistryEntry = z.infer<typeof agentRegistryEntrySchema>

/** Runtime presence — kept by the broker, not persisted in the registry. */
export const agentRuntimeStatusSchema = z.enum(['offline', 'idle', 'queued', 'thinking'])
export type AgentRuntimeStatus = z.infer<typeof agentRuntimeStatusSchema>

export const agentStatusSchema = z.object({
  agentId: agentIdSchema,
  status: agentRuntimeStatusSchema,
  queueDepth: z.number().int().nonnegative(),
  /** busSeq of the envelope currently being processed, if thinking. */
  processingSeq: z.number().int().nonnegative().optional(),
  updatedAt: z.string(), // ISO-8601
})
export type AgentStatus = z.infer<typeof agentStatusSchema>

// ─── Envelopes (immutable) ───────────────────────────────────────────────────

export const busEnvelopeSchema = z.object({
  /** Broker-assigned, strictly monotonic per log. THE replay cursor. */
  busSeq: z.number().int().nonnegative(),
  /** Sender-supplied uuid — idempotency key; broker dedups on (from, id). */
  id: z.string().min(1),
  /** ISO-8601, broker-assigned at append. */
  ts: z.string(),
  /** Sending agentId (USER_AGENT_ID for the human; broker notices use "broker"). */
  from: z.string().min(1),
  /** Target agentId, or BROADCAST_ADDRESS. */
  to: z.string().min(1),
  /** system = broker-emitted notices (drops, budget exhaustion, kill-switch flips) — feed-visible audit events. */
  kind: z.enum(['dm', 'broadcast', 'system']),
  /** Markdown text. */
  body: z.string(),
  /** busSeq this replies to — threading in the feed. */
  replyToSeq: z.number().int().nonnegative().optional(),
  /**
   * Remaining TTL (R1.2). Broker sets defaultHopTtl on human-triggered sends,
   * decrements on each autonomous hop, and drops at 0 with a system notice.
   */
  hopCount: z.number().int().nonnegative(),
  /**
   * true when NOT directly triggered by a human turn — counted against the
   * autonomy budget. Broker derives this from provenance; senders can't unset it.
   */
  autonomous: z.boolean(),
  /** Where the envelope physically entered the bus. */
  origin: z.enum(['ui', 'agent', 'relay', 'broker']),
})
export type BusEnvelope = z.infer<typeof busEnvelopeSchema>

/** What a sender submits; broker assigns busSeq/ts and derives autonomous/hopCount/origin. */
export const busSendRequestSchema = busEnvelopeSchema.pick({
  id: true,
  from: true,
  to: true,
  kind: true,
  body: true,
  replyToSeq: true,
})
export type BusSendRequest = z.infer<typeof busSendRequestSchema>

// ─── Delivery lifecycle (append-only updates; envelopes stay immutable) ─────

export const busDeliveryStateSchema = z.enum([
  'queued', // accepted, target busy or routing paused
  'delivered', // appended into the target's session transcript
  'inference_started', // target agent turn began
  'replied', // target produced a reply envelope (replyToSeq links it)
  'dropped', // guard-rejected — reason says which guard
])
export type BusDeliveryState = z.infer<typeof busDeliveryStateSchema>

export const busDeliveryUpdateSchema = z.object({
  /**
   * Broker-assigned position of this update itself, from the SAME monotonic
   * counter as envelope busSeq — so cursor replay (afterSeq) has a total
   * order over ALL records. Without this, a late update for an old envelope
   * would be invisible to a caught-up client (refSeq alone points backwards).
   */
  seq: z.number().int().nonnegative(),
  /** busSeq of the envelope this update describes. */
  refSeq: z.number().int().nonnegative(),
  /**
   * Which recipient this update belongs to. Omitted for DMs (unambiguous);
   * REQUIRED in practice for broadcast envelopes, where N agents each get
   * their own delivery lifecycle for the same refSeq.
   */
  targetAgentId: z.string().optional(),
  state: busDeliveryStateSchema,
  /** For dropped: 'hop_ttl' | 'pair_rate_limit' | 'autonomy_budget' | 'queue_full' | 'kill_switch' | 'unknown_agent' | free text. */
  reason: z.string().optional(),
  /** Set on 'delivered': message id inside the target session's transcript (R1.3 linkage, feeds F5 deep links). */
  sessionMessageId: z.string().optional(),
  ts: z.string(), // ISO-8601
})
export type BusDeliveryUpdate = z.infer<typeof busDeliveryUpdateSchema>

/** One jsonl line in the BusStore log. */
export const busRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('envelope'), envelope: busEnvelopeSchema }),
  z.object({ type: z.literal('delivery'), update: busDeliveryUpdateSchema }),
])
export type BusRecord = z.infer<typeof busRecordSchema>

// ─── Guards / fleet config (F1) ──────────────────────────────────────────────

export const fleetGuardConfigSchema = z.object({
  /**
   * Master switch for delivery-triggered inference (the kill switch).
   * DEFAULT FALSE — a half-built bus must not be able to spend GPU. Flipped
   * on only after the guards are reviewed; the Fleet Feed header toggles it.
   * When false, envelopes still append + fan out to viewers; local agents
   * just don't get startTask'd (deliveries stay 'queued').
   */
  autonomousRoutingEnabled: z.boolean().default(false),
  /** Fleet-wide cap on autonomous inferences per rolling hour. */
  autonomyBudgetPerHour: z.number().int().nonnegative().default(30),
  /** Initial hopCount for human-triggered envelopes. */
  defaultHopTtl: z.number().int().positive().default(4),
  /** Max envelopes between the same (from,to) pair per rolling 5 minutes. */
  perPairPerFiveMin: z.number().int().positive().default(10),
  /** Per-sender cap on queued inbound relay envelopes (R1.6 backpressure). */
  relayInboundQueueCap: z.number().int().positive().default(25),
})
export type FleetGuardConfig = z.infer<typeof fleetGuardConfigSchema>

/** Live budget accounting surfaced in the Fleet Feed header meter. */
export const autonomyBudgetStatusSchema = z.object({
  usedThisHour: z.number().int().nonnegative(),
  budgetPerHour: z.number().int().nonnegative(),
  /** ISO-8601 when the oldest counted inference ages out of the rolling window. */
  windowResetsAt: z.string().optional(),
})
export type AutonomyBudgetStatus = z.infer<typeof autonomyBudgetStatusSchema>

// ─── Replay (R1.4 — cursor-based, never full-log) ────────────────────────────

export const busReplayRequestSchema = z.object({
  /** Return records whose seq (envelope busSeq / delivery seq) is strictly greater than this. -1 = from the very start (explicit opt-in). */
  afterSeq: z.number().int().min(-1),
  limit: z.number().int().positive().max(500).default(200),
})
export type BusReplayRequest = z.infer<typeof busReplayRequestSchema>

export const busReplayResponseSchema = z.object({
  records: z.array(busRecordSchema),
  /** Pass back as the next afterSeq. */
  nextAfterSeq: z.number().int().min(-1),
  /** Highest seq the broker has — lets clients show "N behind" while paging. */
  latestSeq: z.number().int().min(-1),
})
export type BusReplayResponse = z.infer<typeof busReplayResponseSchema>

// ─── Inbound relay bridge (R1.6 — Phase 1, inbound only) ────────────────────

/** Shape of a claude-relay-style POST accepted by the bus's inbound handler. */
export const relayInboundMessageSchema = z.object({
  sender: z.string().min(1),
  recipient: z.string().min(1),
  message: z.string().min(1),
})
export type RelayInboundMessage = z.infer<typeof relayInboundMessageSchema>
