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
  /** Short name of the thing worked on — the log's primary column. Editable. */
  issue: z.string().min(1).max(200),
  /**
   * The issue name this entry was FILED under, set once and never updated.
   *
   * 🛑 Occurrence counting must survive edits. If renaming an entry moved it out
   * of its own history, a later recurrence would count zero priors and report
   * itself as first-of-kind — the repeat detection returning the exact opposite
   * of the truth, silently (maintenance-claude, 2026-08-30). An edit is not a
   * new occurrence and must not erase old ones, so priors are matched against
   * this AND the current issue.
   */
  originalIssue: z.string().min(1).max(200),
  /**
   * STABLE IDENTITIES for occurrence counting — additive, never removed.
   *
   * 🛑 Counting repeats by matching human-readable alert text couples the count
   * to EMITTER WORDING, and wording is exactly what gets improved: the Optane
   * pruner alert was deliberately reworded to name pools instead of counting
   * them (7e4a654), which silently severed repeat detection for the very alert
   * whose fix that change was verifying (maintenance-claude, 2026-08-30). A
   * recurrence arrives with different prose, matches nothing, and reports
   * itself as first-of-kind.
   *
   * So identity is a KEY the source supplies — and it is `source:subject`,
   * never a bare source. `health` alone covers twelve dependencies, so keying on
   * it would make a brand-new outage report "you dismissed this before"
   * (maintenance-claude and claude1, 2026-08-30). That inverts the bug rather
   * than fixing it, and inverted is WORSE: an under-count makes a real repeat
   * look new, while an over-count is an argument for dismissing something new,
   * carrying the authority of the system built to prevent exactly that. Bare
   * sources are therefore REFUSED, not defaulted.
   *
   * ONE KEY PER SUBJECT, and matching is set INTERSECTION — which is why this is
   * an array and not a string. A run finding pools {A,B} unprunable files both
   * keys; the next run, with A fixed, files only B and still counts the earlier
   * occurrence. A joined subject ("A, B") would have been unstable in exactly
   * the way `$nosig` was, one level up, and order-dependent besides. The pool
   * that persists across runs is the one genuinely stuck, so it is the one the
   * count must follow.
   *
   * Append-only: an update ADDS keys, never replaces them, so an entry's
   * identity can only accumulate and editing cannot erase a prior occurrence.
   * Normalised text matching remains the visible FALLBACK for unkeyed entries,
   * so nothing filed before this is stranded.
   */
  keys: z.array(z.string().max(120)).default([]),
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
  /**
   * Set when this entry MUST NOT be used as a prior occurrence — holds the
   * reason, so presence is both the exclusion and its justification.
   *
   * 🛑 Some entries are worth keeping as records but cannot honestly count.
   * The two migrated notes are the case: one was filed from an alert that
   * carried no pool identity at all (naming the pools is what 7e4a654 ADDED),
   * so any key assigned now would be invented; the other's subject is a
   * synthetic probe that can never recur (maintenance-claude, 2026-08-30).
   *
   * Without this they would still have matched by normalised text — telling you
   * an aggregate alert fired before, but not whether the SAME pool did, which
   * is the only version of the question worth answering. A plausible number
   * that answers a different question is the failure this whole surface keeps
   * hitting, so an entry that cannot match is made visibly unable to match
   * rather than left to match weakly.
   */
  excludedFromCounts: z.string().max(300).optional(),
  /** Every prior body, kept — editable without being rewritable-in-secret. */
  revisions: z.array(journalRevisionSchema).default([]),
})
export type JournalEntry = z.infer<typeof journalEntrySchema>

export const journalCreateRequestSchema = z.object({
  issue: z.string().min(1).max(200),
  /** One `source:subject` identity (convenience for the single-subject case). */
  key: z.string().max(120).optional(),
  /** One key PER SUBJECT — `health:qdrant`, `optane-pruner:pool-a`. Unioned with `key`. */
  keys: z.array(z.string().max(120)).max(50).optional(),
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
  /** ADDS an identity (backfilling an older entry); never replaces one. */
  key: z.string().max(120).optional(),
  /** ADDS several; unioned with `key` and with what the entry already has. */
  keys: z.array(z.string().max(120)).max(50).optional(),
  notes: z.string().max(20000).optional(),
  status: journalStatusSchema.optional(),
  reportIds: z.array(z.string().max(80)).max(20).optional(),
  links: z.array(z.string().max(300)).max(20).optional(),
  author: z.string().max(64).optional(),
})
export type JournalUpdateRequest = z.infer<typeof journalUpdateRequestSchema>

/**
 * A key must name a SUBJECT, not just a source.
 *
 * 🛑 This is the guard that makes the rule real instead of advisory. `health`
 * covers twelve dependencies; accepting it would let a new outage read as a
 * repeat, which is the more dangerous direction of wrong. Requiring a separator
 * means the mistake cannot be made silently — it is refused at the door with a
 * message saying what to send instead.
 */
export const KEY_SHAPE = /^[a-z0-9][a-z0-9._-]*[:/][a-z0-9][a-z0-9._\/-]*$/i

export function badKeys(keys: string[]): string[] {
  return keys.filter((k) => !KEY_SHAPE.test(k.trim()))
}
