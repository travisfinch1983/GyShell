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

export const pageMetaSchema = z.object({
  id: pageIdSchema,
  title: z.string(),
  contentType: pageContentTypeSchema,
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
})
export type PageWriteRequest = z.infer<typeof pageWriteRequestSchema>

export const pageRestoreRequestSchema = z.object({
  version: z.number().int().positive(),
})
export type PageRestoreRequest = z.infer<typeof pageRestoreRequestSchema>
