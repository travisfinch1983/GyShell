/**
 * Pages contracts — the Pages tab's /api/pages/* surface (scoped 2026-08-27,
 * built 2026-08-30). A page is an id, a title, a body, a content type and a
 * VERSION HISTORY: writes are append-only (a write adds a version, the tab
 * reads the latest), so agent rewrites are always inspectable and restorable.
 *
 * content_type 'markdown' is converted to HTML at WRITE time on the backend —
 * the renderer only ever sees HTML, so there is exactly one render path and
 * one sandbox story.
 */
import { z } from 'zod'

export const PAGE_CONTENT_TYPES = ['html', 'markdown'] as const
export const pageContentTypeSchema = z.enum(PAGE_CONTENT_TYPES)
export type PageContentType = z.infer<typeof pageContentTypeSchema>

export const pageIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'page id: alphanumeric slug (-, _)')

export const pageVersionInfoSchema = z.object({
  version: z.number().int().positive(),
  title: z.string(),
  contentType: pageContentTypeSchema,
  author: z.string().optional(),
  createdAt: z.string(), // ISO-8601
  bytes: z.number().int().nonnegative(),
  /** Set when this version was created by restoring an older one. */
  restoredFrom: z.number().int().positive().optional(),
})
export type PageVersionInfo = z.infer<typeof pageVersionInfoSchema>

/**
 * Documents vs reports. A report is a page with a CATEGORY (→ its own RAG
 * collection) and the summary fields the journal is built from. Categories are
 * first-class and extensible — config, never a hardcoded enum.
 */
export const PAGE_KINDS = ['document', 'report'] as const
export const pageKindSchema = z.enum(PAGE_KINDS)
export type PageKind = z.infer<typeof pageKindSchema>

/**
 * The journal line, carried ON the report. Deriving the journal from these
 * instead of maintaining a second document means it can never desync from the
 * reports and can never be forgotten — filing the report IS filing the entry.
 */
export const reportSummarySchema = z.object({
  /** Short name of the problem — the journal's primary column. */
  issue: z.string().min(1).max(200),
  /** One line: what was actually wrong. */
  cause: z.string().max(500).optional(),
  /** One line: what was done about it. */
  fix: z.string().max(500).optional(),
  /** Free-form references: notification ids, service names, URLs, other page ids. */
  links: z.array(z.string().max(300)).max(20).default([]),
})
export type ReportSummary = z.infer<typeof reportSummarySchema>

export const reportCategorySchema = z.object({
  id: z.string().min(1).max(48).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(64),
  /** RAG collection this category's reports are vectorised into. */
  collection: z.string().min(1).max(64),
  /** STARTING template — a beginning to modify, never a schema that rejects. */
  template: z.string().default(''),
  description: z.string().max(300).optional(),
})
export type ReportCategory = z.infer<typeof reportCategorySchema>

/**
 * A journal NOTE: the third triage outcome — "noted, nothing repaired".
 *
 * 🛑 Why this is first-class rather than derived. A repair is memorable and
 * leaves a report you can search; a benign recurring failure (an upstream API
 * that was briefly overloaded, a probe that blipped once) leaves nothing, and is
 * PRECISELY the thing nobody remembers across context windows. Deriving the
 * journal only from reports would make the most-forgettable outcome invisible,
 * so the agent would rediscover the same benign event every few days. Notes are
 * vectorised alongside reports so a search for the symptom surfaces "you already
 * dismissed this, three times".
 */
export const journalNoteSchema = z.object({
  id: z.string().min(1).max(80),
  category: z.string(),
  createdAt: z.string(),
  issue: z.string().min(1).max(200),
  cause: z.string().max(500).optional(),
  /** Why no repair was made — the field that makes a dismissal reviewable. */
  whyNoAction: z.string().min(1).max(500),
  author: z.string().max(64).optional(),
  links: z.array(z.string().max(300)).max(20).default([]),
})
export type JournalNote = z.infer<typeof journalNoteSchema>

export const journalNoteRequestSchema = journalNoteSchema.omit({ id: true, createdAt: true }).extend({
  category: z.string().max(48),
})
export type JournalNoteRequest = z.infer<typeof journalNoteRequestSchema>

/** One journal line: a filed repair (report) or a recorded dismissal (note). */
export const journalEntrySchema = z.object({
  kind: z.enum(['report', 'note']).default('report'),
  /** reports only — the page the entry was derived from. */
  pageId: pageIdSchema.optional(),
  /** notes only. */
  noteId: z.string().optional(),
  category: z.string(),
  receivedAt: z.string(),
  issue: z.string(),
  cause: z.string().optional(),
  /** reports only. */
  fix: z.string().optional(),
  /** notes only — why nothing was repaired. */
  whyNoAction: z.string().optional(),
  author: z.string().optional(),
  version: z.number().int().positive().optional(),
})
export type JournalEntry = z.infer<typeof journalEntrySchema>

export const pageMetaSchema = z.object({
  id: pageIdSchema,
  title: z.string(),
  contentType: pageContentTypeSchema,
  kind: pageKindSchema.default('document'),
  /** reports only — the category id, which selects the RAG collection. */
  category: z.string().optional(),
  /** reports only — journal fields. */
  report: reportSummarySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  currentVersion: z.number().int().positive(),
  /**
   * Distinct contributors in first-seen order — the creator first, then every
   * later co-author. Derived from the per-version author records, which are
   * ALSO the per-edit audit trail ("who made this individual change" is the
   * version history, no extra machinery).
   */
  authors: z.array(z.string()).default([]),
  versions: z.array(pageVersionInfoSchema),
})
export type PageMeta = z.infer<typeof pageMetaSchema>

export const pageListEntrySchema = pageMetaSchema.omit({ versions: true }).extend({
  versionCount: z.number().int().positive(),
})
export type PageListEntry = z.infer<typeof pageListEntrySchema>

export const pageListResponseSchema = z.object({ pages: z.array(pageListEntrySchema) })
export type PageListResponse = z.infer<typeof pageListResponseSchema>

/** Read response: meta + the requested (default latest) version's content. */
export const pageReadResponseSchema = z.object({
  meta: pageMetaSchema,
  version: z.number().int().positive(),
  /** Rendered HTML — what the sandboxed frame displays. */
  html: z.string(),
  /** The authored source (markdown when contentType is markdown, else the HTML itself). */
  source: z.string(),
})
export type PageReadResponse = z.infer<typeof pageReadResponseSchema>

export const pageWriteRequestSchema = z.object({
  title: z.string().min(1).max(200),
  contentType: pageContentTypeSchema,
  body: z.string().max(4 * 1024 * 1024),
  author: z.string().max(64).optional(),
  /** 'report' requires category + report.issue; 'document' (default) ignores both. */
  kind: pageKindSchema.optional(),
  category: z.string().max(48).optional(),
  report: reportSummarySchema.optional(),
})
export type PageWriteRequest = z.infer<typeof pageWriteRequestSchema>

export const pageRestoreRequestSchema = z.object({
  version: z.number().int().positive(),
})
export type PageRestoreRequest = z.infer<typeof pageRestoreRequestSchema>
