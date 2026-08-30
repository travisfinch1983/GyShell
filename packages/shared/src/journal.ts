/**
 * The Journal — a working log, not an archive.
 *
 * Travis's framing (2026-08-30): "a quick looking up the work he has done over
 * the past… a way to just create basic journal entries, and then add to/edit
 * them as he works". So an entry is created when work STARTS and grows as it
 * proceeds — which is why entries are editable here, unlike reports.
 *
 * Editable does not mean rewritable-without-trace: an update keeps the previous
 * text as a revision, so the log can be corrected while still showing what it
 * said before. Appending is the common case and is its own operation, because
 * "add a line as I go" should not require resending the whole entry.
 */
import { z } from 'zod'

export const journalEntryIdSchema = z.string().min(1).max(80)

export const journalRevisionSchema = z.object({
  at: z.string(),
  author: z.string().optional(),
  /** What the entry said before this revision — never discarded. */
  previous: z.string(),
})
export type JournalRevision = z.infer<typeof journalRevisionSchema>

export const journalStatusSchema = z.enum(['open', 'resolved', 'no-action'])
export type JournalStatus = z.infer<typeof journalStatusSchema>

export const journalEntrySchema = z.object({
  id: journalEntryIdSchema,
  /** Short name of the thing worked on — the log's primary column. */
  issue: z.string().min(1).max(200),
  /**
   * open      — work in progress
   * resolved  — fixed (usually with a report linked)
   * no-action — looked at, nothing to repair (the third triage outcome; the
   *             entries nobody remembers otherwise, so they must be loggable)
   */
  status: journalStatusSchema.default('open'),
  /** The running body: what was found, what was tried, what happened. */
  notes: z.string().default(''),
  /** Reports this entry refers to — the link back to the full write-up. */
  reportIds: z.array(z.string().max(80)).default([]),
  /** Other references: notification ids, services, hosts. */
  links: z.array(z.string().max(300)).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.string().max(64).optional(),
  /** Every prior body, kept — editable without being rewritable-in-secret. */
  revisions: z.array(journalRevisionSchema).default([]),
})
export type JournalEntry = z.infer<typeof journalEntrySchema>

export const journalCreateRequestSchema = z.object({
  issue: z.string().min(1).max(200),
  notes: z.string().max(20000).optional(),
  status: journalStatusSchema.optional(),
  reportIds: z.array(z.string().max(80)).max(20).optional(),
  links: z.array(z.string().max(300)).max(20).optional(),
  author: z.string().max(64).optional(),
})
export type JournalCreateRequest = z.infer<typeof journalCreateRequestSchema>

/** Append: the common "one more line as I go" path — never resends the body. */
export const journalAppendRequestSchema = z.object({
  text: z.string().min(1).max(20000),
  status: journalStatusSchema.optional(),
  reportIds: z.array(z.string().max(80)).max(20).optional(),
  links: z.array(z.string().max(300)).max(20).optional(),
  author: z.string().max(64).optional(),
})
export type JournalAppendRequest = z.infer<typeof journalAppendRequestSchema>

/** Update: replace fields outright; the previous body becomes a revision. */
export const journalUpdateRequestSchema = z.object({
  issue: z.string().min(1).max(200).optional(),
  notes: z.string().max(20000).optional(),
  status: journalStatusSchema.optional(),
  reportIds: z.array(z.string().max(80)).max(20).optional(),
  links: z.array(z.string().max(300)).max(20).optional(),
  author: z.string().max(64).optional(),
})
export type JournalUpdateRequest = z.infer<typeof journalUpdateRequestSchema>
