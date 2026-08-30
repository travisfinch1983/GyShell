// @ts-expect-error — express ships untyped in this repo (same pattern as pagesHttp)
import express from 'express'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  journalAppendRequestSchema,
  journalCreateRequestSchema,
  journalUpdateRequestSchema,
  type JournalEntry,
} from '@gyshell/shared'

type Req = express.Request
type Res = express.Response

/**
 * Journal — /api/journal/*, its own surface and its own toolset.
 *
 * A WORKING LOG, not an archive: an entry is created when work starts and grows
 * as it proceeds (Travis: "create basic journal entries, and then add to/edit
 * them as he works"). Hence append and update, which reports deliberately do
 * not have.
 *
 * Editable ≠ rewritable in secret: an update keeps the previous body as a
 * revision. The log can be corrected while still showing what it said before —
 * which matters precisely because its purpose is remembering across context
 * windows, and a silently-rewritten memory is worse than none.
 *
 * Entries link to reports rather than containing them: the journal answers
 * "have I seen this before, and what did I do?", the report holds the detail.
 */
export function createJournalRouter(dataDir: string): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '1mb' })
  const file = path.join(dataDir, 'journal.json')
  const fail = (res: Res, code: number, error: string) => res.status(code).json({ ok: false, error })

  const load = (): JournalEntry[] => {
    try {
      if (!existsSync(file)) return []
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(raw?.entries) ? raw.entries : []
    } catch (e) {
      console.warn('[journal] unreadable:', (e as Error).message)
      return []
    }
  }
  const save = (entries: JournalEntry[]): void => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ entries }, null, 2))
  }
  const stamp = (): string => new Date().toISOString()

  /** Newest first; ?status= and ?q= narrow it. The log is for looking things up. */
  router.get('/api/journal', (req: Req, res: Res) => {
    const status = req.query.status ? String(req.query.status) : null
    const q = req.query.q ? String(req.query.q).toLowerCase() : null
    const entries = load()
      .filter((e) => !status || e.status === status)
      .filter((e) => !q || `${e.issue} ${e.notes}`.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    res.json({ entries })
  })

  router.get('/api/journal/:id', (req: Req, res: Res) => {
    const entry = load().find((e) => e.id === req.params.id)
    if (!entry) return fail(res, 404, `no journal entry ${req.params.id}`)
    res.json({ entry })
  })

  /**
   * Create. Returns `priorSimilar` — how many existing entries share this issue
   * — because spotting the REPEAT is the journal's whole purpose, and a signal
   * that requires curiosity to discover is one that gets missed.
   */
  router.post('/api/journal', json, (req: Req, res: Res) => {
    const parsed = journalCreateRequestSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, `bad entry: ${parsed.error.issues[0]?.message}`)
    try {
      const entries = load()
      const now = stamp()
      const entry: JournalEntry = {
        id: `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        issue: parsed.data.issue,
        status: parsed.data.status ?? 'open',
        notes: parsed.data.notes ?? '',
        reportIds: parsed.data.reportIds ?? [],
        links: parsed.data.links ?? [],
        createdAt: now,
        updatedAt: now,
        author: parsed.data.author,
        revisions: [],
      }
      const needle = entry.issue.trim().toLowerCase()
      const priorSimilar = entries.filter((e) => e.issue.trim().toLowerCase() === needle).length
      entries.push(entry)
      save(entries)
      res.json({ ok: true, id: entry.id, priorSimilar })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  /** Append — the "one more line as I go" path; never resends the body. */
  router.post('/api/journal/:id/append', json, (req: Req, res: Res) => {
    const parsed = journalAppendRequestSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, `bad append: ${parsed.error.issues[0]?.message}`)
    try {
      const entries = load()
      const entry = entries.find((e) => e.id === req.params.id)
      if (!entry) return fail(res, 404, `no journal entry ${req.params.id}`)
      const now = stamp()
      // Appends are additive, so they are NOT revisions — nothing was replaced.
      entry.notes = entry.notes ? `${entry.notes}\n\n[${now}] ${parsed.data.text}` : `[${now}] ${parsed.data.text}`
      if (parsed.data.status) entry.status = parsed.data.status
      if (parsed.data.reportIds?.length) entry.reportIds = [...new Set([...entry.reportIds, ...parsed.data.reportIds])]
      if (parsed.data.links?.length) entry.links = [...new Set([...entry.links, ...parsed.data.links])]
      entry.updatedAt = now
      if (parsed.data.author) entry.author = parsed.data.author
      save(entries)
      res.json({ ok: true, id: entry.id, status: entry.status })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  /** Update — replaces fields; the previous body is kept as a revision. */
  router.patch('/api/journal/:id', json, (req: Req, res: Res) => {
    const parsed = journalUpdateRequestSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, `bad update: ${parsed.error.issues[0]?.message}`)
    try {
      const entries = load()
      const entry = entries.find((e) => e.id === req.params.id)
      if (!entry) return fail(res, 404, `no journal entry ${req.params.id}`)
      const d = parsed.data
      if (d.notes !== undefined && d.notes !== entry.notes) {
        entry.revisions.push({ at: stamp(), author: d.author ?? entry.author, previous: entry.notes })
        entry.notes = d.notes
      }
      if (d.issue !== undefined) entry.issue = d.issue
      if (d.status !== undefined) entry.status = d.status
      if (d.reportIds !== undefined) entry.reportIds = d.reportIds
      if (d.links !== undefined) entry.links = d.links
      if (d.author) entry.author = d.author
      entry.updatedAt = stamp()
      save(entries)
      res.json({ ok: true, id: entry.id, revisions: entry.revisions.length })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  return router
}
