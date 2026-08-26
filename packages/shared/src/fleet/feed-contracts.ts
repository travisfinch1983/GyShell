/**
 * Fleet FEED contracts (messaging v2).
 *
 * These describe the /api/fleet/threads|thread|post|search|... surface, which proxies fleetd
 * (the canonical SQLite store on claude1:17900). They are DELIBERATELY separate from
 * ./contracts, which describes the older ConversationBus vertical (busEnvelope, agentActivity,
 * afterSeq replay). The two coexist until the reworked Fleet Feed tab replaces the old one.
 *
 * 🛑 Field names mirror fleetd's JSON exactly (snake_case). Do not "tidy" them to camelCase
 * here — the backend is a pure proxy, and renaming in one layer only is how a contract and its
 * server drift apart silently.
 */
import { z } from 'zod'

/**
 * ⏱ EVERY timestamp in this file is epoch SECONDS as a float (Python `time.time()`), NOT
 * milliseconds. `new Date(created_at)` renders 1970; use `new Date(created_at * 1000)`.
 * Zod cannot encode the unit, so it is stated here — this is the trap a consumer hits first.
 */
export const feedSecondsToDate = (epochSeconds: number): Date => new Date(epochSeconds * 1000)

export const feedVisibilitySchema = z.enum(['private', 'public'])
export type FeedVisibility = z.infer<typeof feedVisibilitySchema>

/** dm = addressed to specific agents; post = bulletin-board entry on the Feed. */
export const feedThreadKindSchema = z.enum(['dm', 'post'])
export type FeedThreadKind = z.infer<typeof feedThreadKindSchema>

export const feedAgentKindSchema = z.enum(['claude_code', 'hermes'])
export type FeedAgentKind = z.infer<typeof feedAgentKindSchema>

export const feedAttachmentKindSchema = z.enum(['document', 'image', 'flowchart'])
export type FeedAttachmentKind = z.infer<typeof feedAttachmentKindSchema>

/** Attachment REF as it rides along a message — metadata only, never bytes. */
export const feedAttachmentRefSchema = z.object({
  attachment_id: z.string(),
  filename: z.string().nullable(),
  media_type: z.string(),
  kind: feedAttachmentKindSchema,
  byte_size: z.number(),
  sha256: z.string().nullable(),
  created_at: z.number(),
})
export type FeedAttachmentRef = z.infer<typeof feedAttachmentRefSchema>

/** Per-recipient delivery state. `woke` is INFERRED from the recipient's turn counter moving
 *  after delivery — it is the evidence the message actually reached a model, not just a queue. */
export const feedReceiptStateSchema = z.enum(['queued', 'delivered', 'woke', 'acked', 'failed'])
export type FeedReceiptState = z.infer<typeof feedReceiptStateSchema>

export const feedReceiptSchema = z.object({
  recipient: z.string(),
  state: feedReceiptStateSchema,
  attempts: z.number(),
  queued_at: z.number().nullable(),
  delivered_at: z.number().nullable(),
  woke_at: z.number().nullable(),
  acked_at: z.number().nullable(),
  failure_stage: z.string().nullable(),   // a failure always names its stage: never "failed somewhere"
  failure_detail: z.string().nullable(),
})
export type FeedReceipt = z.infer<typeof feedReceiptSchema>

export const feedMessageSchema = z.object({
  message_id: z.string(),
  thread_id: z.string(),
  seq: z.number(),                       // gap-free per thread; this is the ordering key
  parent_id: z.string().nullable(),      // which message this replies to
  sender: z.string(),
  body: z.string(),
  kind: z.string(),
  created_at: z.number(),
  attachments: z.array(feedAttachmentRefSchema).default([]),
  receipts: z.array(feedReceiptSchema).optional(),   // present unless ?receipts=0
})
export type FeedMessage = z.infer<typeof feedMessageSchema>

export const feedThreadSchema = z.object({
  thread_id: z.string(),
  subject: z.string().nullable(),
  kind: feedThreadKindSchema,
  category: z.string().nullable(),
  visibility: feedVisibilitySchema,
  participants: z.array(z.string()),
  message_count: z.number(),
  unread_count: z.number().optional(),    // only when the feed is requested with ?unread=1
  last_sender: z.string().nullable(),
  last_snippet: z.string().nullable(),
  created_at: z.number(),   // epoch SECONDS (float) — see feedSecondsToDate
  updated_at: z.number(),   // epoch SECONDS (float)
})
export type FeedThread = z.infer<typeof feedThreadSchema>

/** `next_cursor` is OPAQUE — round-trip it, never parse it. It encodes (updated_at, thread_id)
 *  so threads updated in the same millisecond get a total order; a bare timestamp cursor
 *  duplicated or skipped rows on ties. */
export const feedListSchema = z.object({
  threads: z.array(feedThreadSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
})
export type FeedList = z.infer<typeof feedListSchema>

export const feedThreadReadSchema = z.object({
  thread: feedThreadSchema,
  messages: z.array(feedMessageSchema),   // always ascending by seq, paged or not
  has_more: z.boolean(),                  // older messages exist before the window
  before_seq: z.number().nullable(),      // pass back as ?before_seq to page further back
})
export type FeedThreadRead = z.infer<typeof feedThreadReadSchema>

export const feedDirectoryEntrySchema = z.object({
  agent_id: z.string(),
  display_name: z.string(),
  kind: feedAgentKindSchema,
  endpoint: z.string().nullable(),
  enabled: z.boolean(),
  can_broadcast: z.boolean(),
  can_focused: z.boolean(),
  status: z.string().nullable(),
  presence_at: z.number().nullable(),
  turn_count: z.number().nullable(),
})
export type FeedDirectoryEntry = z.infer<typeof feedDirectoryEntrySchema>

export const feedCategorySchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.number(),
  thread_count: z.number(),
})
export type FeedCategory = z.infer<typeof feedCategorySchema>

/** Search hits are PUBLIC-only — enforced in the store's query, never by a caller flag. */
export const feedSearchHitSchema = z.object({
  message_id: z.string(),
  thread_id: z.string(),
  seq: z.number(),
  subject: z.string().nullable(),
  category: z.string().nullable(),
  sender: z.string(),
  body: z.string(),
  created_at: z.number(),
})
export type FeedSearchHit = z.infer<typeof feedSearchHitSchema>

// ---- request bodies -------------------------------------------------------

export const feedPostRequestSchema = z.object({
  sender: z.string(),
  subject: z.string().min(1),
  body: z.string(),
  category: z.string().optional(),
  visibility: feedVisibilitySchema.default('private'),   // private by DEFAULT, always
  thread_id: z.string().optional(),                       // reply into an existing post
  parent_id: z.string().optional(),
})
export type FeedPostRequest = z.infer<typeof feedPostRequestSchema>

export const feedSendRequestSchema = z.object({
  sender: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  body: z.string(),
  subject: z.string().optional(),
  thread_id: z.string().optional(),
  parent_id: z.string().optional(),
})
export type FeedSendRequest = z.infer<typeof feedSendRequestSchema>

export const feedVisibilityRequestSchema = z.object({
  actor: z.string(),                       // must be a participant; the store enforces it
  visibility: feedVisibilitySchema,
})
export type FeedVisibilityRequest = z.infer<typeof feedVisibilityRequestSchema>

export const feedAttachmentRequestSchema = z.object({
  message_id: z.string(),
  filename: z.string().optional(),
  media_type: z.string(),
  kind: feedAttachmentKindSchema.default('document'),
  content_b64: z.string().optional(),      // bytes for document/image
  structured: z.unknown().optional(),      // flowchart graph JSON — renderable, not a blob
})
export type FeedAttachmentRequest = z.infer<typeof feedAttachmentRequestSchema>

/** Errors carry fleetd's `stage` so the UI can tell a refusal from an outage. */
export const feedErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  stage: z.string().optional(),
})
export type FeedError = z.infer<typeof feedErrorSchema>

export const feedHealthSchema = z.object({
  ok: z.boolean(),
  fleetd: z.string(),
  reachable: z.boolean(),
})
export type FeedHealth = z.infer<typeof feedHealthSchema>

// ---- unread, guard ---------------------------------------------------------

export const feedReadRequestSchema = z.object({
  viewer: z.string(),
  up_to_seq: z.number(),   // a watermark, so replaying an older value can never lose a newer one
})
export type FeedReadRequest = z.infer<typeof feedReadRequestSchema>

export const feedUnreadSchema = z.object({
  unread: z.array(z.object({
    thread_id: z.string(),
    subject: z.string().nullable(),
    unread_count: z.number(),
  })),
})
export type FeedUnread = z.infer<typeof feedUnreadSchema>

/**
 * The delivery kill switch — Travis-facing, and the replacement for the one that dies with
 * ConversationBus. Served at /api/fleet/delivery-guard, NOT /api/fleet/guard: that path is
 * still claimed by the old router, which is mounted first and would shadow this one.
 */
export const feedGuardSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_at: z.number().nullable(),
})
export type FeedGuard = z.infer<typeof feedGuardSchema>

export const feedGuardRequestSchema = z.object({
  enabled: z.boolean(),
  actor: z.string().default('user'),
  reason: z.string().optional(),
})
export type FeedGuardRequest = z.infer<typeof feedGuardRequestSchema>

/** A flowchart's machine-readable form. Pixels are useless to another agent. */
export const feedStructuredSchema = z.object({
  attachment_id: z.string(),
  kind: feedAttachmentKindSchema,
  structured: z.unknown(),
})
export type FeedStructured = z.infer<typeof feedStructuredSchema>

/** The canonical viewer identity for Travis / the UI, registered in the directory as kind:user. */
export const FEED_VIEWER_ID = 'user'
