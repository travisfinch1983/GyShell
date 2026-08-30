/**
 * Reports — their own domain, deliberately separate from scoping Pages and from
 * the Journal (Travis, 2026-08-30: "a toolset for Scoping Pages, a toolset for
 * Reports, and a toolset for maintenance claude to make his journal entries…
 * this way they don't accidentally get all mixed in together").
 *
 * A report has a TYPE chosen from a predefined list. Types are the extension
 * point for the whole fleet, not a maintenance-only concept: maintenance
 * reports today, security-camera reports and network-vulnerability reports as
 * those agents come online. Each type owns a RAG collection so one agent's
 * reports never dilute another's search.
 */
import { z } from 'zod'

export const reportIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'report id: alphanumeric slug (-, _)')

export const reportTypeIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'report type id: lowercase slug')

/** A report TYPE — the predefined list an agent picks from. */
export const reportTypeSchema = z.object({
  id: reportTypeIdSchema,
  label: z.string().min(1).max(64),
  /** Who this type is for, in the agent's own terms — shown in the picker. */
  description: z.string().max(300).optional(),
  /** RAG collection for this type's reports. */
  collection: z.string().min(1).max(64),
  /** STARTING template — a beginning to adapt, never a schema that rejects. */
  template: z.string().default(''),
})
export type ReportType = z.infer<typeof reportTypeSchema>

export const reportVersionSchema = z.object({
  version: z.number().int().positive(),
  title: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
  bytes: z.number().int().nonnegative(),
})
export type ReportVersion = z.infer<typeof reportVersionSchema>

export const reportMetaSchema = z.object({
  id: reportIdSchema,
  type: reportTypeIdSchema,
  title: z.string(),
  /** One-line summary of the problem/subject — the list column and journal link text. */
  summary: z.string().max(300).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  currentVersion: z.number().int().positive(),
  authors: z.array(z.string()).default([]),
  versions: z.array(reportVersionSchema),
  /** Free-form references: notification ids, hosts, services, other report ids. */
  links: z.array(z.string().max(300)).default([]),
})
export type ReportMeta = z.infer<typeof reportMetaSchema>

/**
 * The LIST endpoint's row shape: meta with `versions` stripped (the list must
 * not ship every version's history) and `versionCount` added. Its own schema
 * because parsing list rows against reportMetaSchema would REFUSE them —
 * `versions` is required there and absent here. (Nearly shipped that way:
 * the parse would have errored the whole Reports list into the error banner,
 * a louder failure than the silent one being fixed, but still a failure.)
 */
export const reportListEntrySchema = reportMetaSchema.omit({ versions: true }).extend({
  versionCount: z.number().int().nonnegative(),
})
export type ReportListEntry = z.infer<typeof reportListEntrySchema>

export const reportWriteRequestSchema = z.object({
  type: reportTypeIdSchema,
  title: z.string().min(1).max(200),
  body: z.string().max(4 * 1024 * 1024),
  summary: z.string().max(300).optional(),
  links: z.array(z.string().max(300)).max(20).optional(),
  author: z.string().max(64).optional(),
})
export type ReportWriteRequest = z.infer<typeof reportWriteRequestSchema>

export const reportReadResponseSchema = z.object({
  meta: reportMetaSchema,
  version: z.number().int().positive(),
  html: z.string(),
  source: z.string(),
})
export type ReportReadResponse = z.infer<typeof reportReadResponseSchema>
