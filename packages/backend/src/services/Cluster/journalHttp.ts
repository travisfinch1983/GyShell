// @ts-expect-error — express ships untyped in this repo (same pattern as pagesHttp)
import express from 'express'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  journalAppendRequestSchema,
  journalCreateRequestSchema,
  journalUpdateRequestSchema,
  badKeys,
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
/**
 * Emitted on index failure. Same shape claude1 is using for the reports router,
 * so both surfaces report a degraded index the same way.
 */
export type NotifyFn = (input: {
  severity: 'info' | 'warning' | 'error'; source: string; message: string; detail?: string
}) => unknown

export function createJournalRouter(dataDir: string, notify?: NotifyFn): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '1mb' })
  const file = path.join(dataDir, 'journal.json')
  const fail = (res: Res, code: number, error: string) => res.status(code).json({ ok: false, error })

  /**
   * MIGRATION — journal-notes.json (the "noted, no repair" store) → journal.json.
   *
   * 🛑 Renaming a store without moving its rows does not lose them loudly: the
   * new file is simply absent, the journal reads empty, and priorSimilar
   * restarts at zero — so the next recurrence reports itself as first-of-kind
   * and the repeat detection states the OPPOSITE of the truth (claude1 caught
   * this pre-deploy, 2026-08-30). An empty journal is indistinguishable from
   * "this has never happened before", which is the exact failure this system
   * exists to prevent.
   *
   * Runs once at construction, idempotent, and NON-DESTRUCTIVE: the old file is
   * renamed to .migrated rather than deleted, so a bad conversion is recoverable.
   */
  const migrateNotes = (): void => {
    const oldFile = path.join(dataDir, 'journal-notes.json')
    if (!existsSync(oldFile)) return
    try {
      const raw = JSON.parse(readFileSync(oldFile, 'utf8'))
      const notes: Array<Record<string, any>> = Array.isArray(raw?.notes) ? raw.notes : []
      const existing: JournalEntry[] = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8'))?.entries ?? [])
        : []
      const known = new Set(existing.map((e) => e.id))
      const converted: JournalEntry[] = notes
        .filter((n) => n?.id && !known.has(n.id))
        .map((n) => ({
          id: String(n.id),
          issue: String(n.issue ?? '(untitled)'),
          originalIssue: String(n.issue ?? '(untitled)'),
          // No key: these predate stable identities. Text matching covers them
          // until backfilled with journal_update {key}.
          keys: [],
          // A note WAS the third triage outcome, so it maps to that status exactly.
          status: 'no-action' as const,
          notes: [n.cause ? `cause: ${n.cause}` : '', n.whyNoAction ? `why no action: ${n.whyNoAction}` : '']
            .filter(Boolean).join('\n'),
          reportIds: [],
          links: Array.isArray(n.links) ? n.links.map(String) : [],
          // Kept as a record, excluded from counting — see the schema note.
          excludedFromCounts:
            'migrated from journal-notes.json: filed before stable keys existed, and the ' +
            'originating alert carried no subject identity, so any key would be invented',
          createdAt: String(n.createdAt ?? new Date().toISOString()),
          updatedAt: String(n.createdAt ?? new Date().toISOString()),
          author: n.author ? String(n.author) : undefined,
          revisions: [],
        }))
      if (converted.length) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ entries: [...existing, ...converted] }, null, 2))
      }
      renameSync(oldFile, `${oldFile}.migrated`)
      console.log(`[journal] migrated ${converted.length} note(s) from journal-notes.json (old file kept as .migrated)`)
    } catch (e) {
      // Never throw: a failed migration must not take the journal offline, and
      // the old file stays put so it can be retried after the cause is fixed.
      console.warn('[journal] MIGRATION FAILED — journal-notes.json left in place:', (e as Error).message)
    }
  }

  /**
   * Text fallback for entries with no key — normalised, because alert messages
   * INTERPOLATE VALUES.
   *
   * 🛑 The Optane alert emits "$n Optane pool(s) cannot be pruned". A stored
   * "1 Optane pool(s)…" never string-equals a recurrence reporting 2, so the
   * count came out 0 and every recurrence read as first-of-kind — varying run to
   * run with no change to any code (claude1, 2026-08-30, correcting my earlier
   * belief that this was wording drift; the real mechanism is worse because it
   * needs nobody to touch anything). So digits, hex ids, ISO timestamps and
   * durations collapse to a placeholder before comparing.
   *
   * This is still prose matching and still fragile — hostnames and free text
   * defeat it. It is the floor for unkeyed entries, not the mechanism: pass a
   * `key` and none of this applies.
   */
  const norm = (s: string): string =>
    s.toLowerCase()
      .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '#t')      // timestamps
      .replace(/\b[0-9a-f]{8,}\b/g, '#id')                  // hex ids/hashes
      .replace(/\b\d+(\.\d+)?\s*(ms|s|m|h|gb|mb|kb|%)\b/g, '#q')  // quantities
      .replace(/\d+/g, '#')                                  // any other number
      .replace(/[^a-z#]+/g, ' ')
      .trim()

  /** Match on BOTH names, so renaming an entry never moves it out of its own history. */
  const textsMatch = (a: JournalEntry, b: JournalEntry): boolean => {
    const an = new Set([norm(a.issue), norm(a.originalIssue ?? a.issue)])
    return an.has(norm(b.issue)) || an.has(norm(b.originalIssue ?? b.issue))
  }

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

  /**
   * reportIds the report store does not hold. The gaps endpoint protects the
   * READER direction (reports no entry cites); this protects the WRITER: an
   * entry could cite a report that does not exist and nothing would ever say
   * so — the citation renders as a chip that 404s when clicked, and the
   * "cited in journal" backlink simply never appears (maintenance-claude,
   * 2026-08-30, after catching a fixture id presented as live state). A
   * WARNING, not a refusal: filing the entry before the report is a
   * legitimate order of operations.
   */
  const unknownReports = (ids: string[] | undefined): string[] => {
    if (!ids?.length) return []
    return ids.filter((rid) => !existsSync(path.join(dataDir, 'reports', rid, 'meta.json')))
  }

  /**
   * Vectorise, never blocking the write. An entry that saved but did not index
   * is a working entry with degraded search; a write refused because the
   * indexer was down would lose the operator's work — and the journal exists
   * precisely to survive the moment the operator's context does not.
   *
   * The failure has to leave the process, though: `indexed:false` in the
   * response is read only by whichever agent made the call, so a silently
   * unsearchable journal would look identical to an empty one. That is the same
   * shape of invisibility as the rename that orphaned the notes.
   */
  const index = async (entry: JournalEntry): Promise<{ indexed: boolean; indexError?: string }> => {
    try {
      const { indexJournalEntry } = await import('./reportsRag')
      await indexJournalEntry(entry)
      return { indexed: true }
    } catch (e) {
      const indexError = (e as Error).message
      console.warn(`[journal] ${entry.id} saved but NOT indexed:`, indexError)
      notify?.({
        severity: 'warning', source: 'journal-rag',
        message: `Journal entry ${entry.id} saved but not indexed`,
        detail: `"${entry.issue}" did not reach the ${process.env.AILAB_JOURNAL_COLLECTION || 'ailab_journal'} collection: ${indexError}. ` +
          `The entry is safe and readable; semantic search will not find it until it is re-indexed.`,
      })
      return { indexed: false, indexError }
    }
  }

  migrateNotes()

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

  /**
   * Reports nobody logged. The derived journal used to make "filed a report but
   * no entry" impossible by construction; a first-class working log cannot, so
   * the gap is DETECTED instead — and surfaced where the agent already looks
   * (journal_read) rather than waiting to be searched for.
   */
  router.get('/api/journal/gaps', (_req: Req, res: Res) => {
    try {
      const linked = new Set(load().flatMap((e) => e.reportIds))
      const reportsRoot = path.join(dataDir, 'reports')
      if (!existsSync(reportsRoot)) return res.json({ unlogged: [] })
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      const unlogged = readdirSync(reportsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !linked.has(d.name))
        .map((d) => {
          try {
            const m = JSON.parse(readFileSync(path.join(reportsRoot, d.name, 'meta.json'), 'utf8'))
            return { id: d.name, type: m.type, title: m.title, updatedAt: m.updatedAt }
          } catch { return { id: d.name } }
        })
      res.json({ unlogged })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  /** Semantic search — the "have I decided something like this before?" path. */
  router.get('/api/journal-search', async (req: Req, res: Res) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) return fail(res, 400, 'q is required')
    try {
      const { searchJournal } = await import('./reportsRag')
      res.json({ ok: true, results: await searchJournal(q, Number(req.query.limit) || 10) })
    } catch (e) { fail(res, 502, `journal search unavailable: ${(e as Error).message}`) }
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
  router.post('/api/journal', json, async (req: Req, res: Res) => {
    const parsed = journalCreateRequestSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, `bad entry: ${parsed.error.issues[0]?.message}`)
    // A bare source ("health") is REFUSED, never defaulted: it would match every
    // other alert from that source and report a new problem as one already seen.
    const incoming = [...new Set([...(parsed.data.keys ?? []), ...(parsed.data.key ? [parsed.data.key] : [])].map((k) => k.trim()))]
    const bad = badKeys(incoming)
    if (bad.length) {
      return fail(res, 400, `key must be source:subject, not a bare source — got ${bad.join(', ')}. ` +
        `Name the specific thing: health:qdrant, optane-pruner:pool-a, model-bindings:qwen3-30b. ` +
        `One key per subject; send several in "keys" when several are affected.`)
    }
    try {
      const entries = load()
      const now = stamp()
      const entry: JournalEntry = {
        id: `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        issue: parsed.data.issue,
        originalIssue: parsed.data.issue,
        keys: incoming,
        status: parsed.data.status ?? 'open',
        notes: parsed.data.notes ?? '',
        reportIds: parsed.data.reportIds ?? [],
        links: parsed.data.links ?? [],
        createdAt: now,
        updatedAt: now,
        author: parsed.data.author,
        revisions: [],
      }
      // Identity first, prose second — and prose only ever as a visible fallback.
      const mine = new Set(entry.keys)
      const keyHit = (e: JournalEntry) => (e.keys ?? []).some((k) => mine.has(k))
      // Set INTERSECTION, so a shrinking affected set still counts: {A,B} then
      // {B} means B has now happened twice, which is the fact worth surfacing.
      const matched = entries
        .filter((e) => !e.excludedFromCounts)
        .filter((e) => keyHit(e) || (!mine.size && textsMatch(entry, e)))
      const priorSimilar = matched.length
      // Per subject, because one number cannot answer "which of these is the
      // repeat?" when several subjects are in play — and that is the actual
      // question. A count with no breakdown invites the wrong conclusion.
      const perKey: Record<string, number> = {}
      for (const k of entry.keys) {
        perKey[k] = entries.filter((e) => !e.excludedFromCounts && (e.keys ?? []).includes(k)).length
      }
      // Say WHICH mechanism found them. A key match is identity and can be
      // trusted; a text match is a guess and must not be read as one. Reporting
      // a bare number is how "0" got believed in the first place.
      const matchedBy = !mine.size ? 'text (no key — pass source:subject keys for a reliable count)'
        : priorSimilar === 0 ? 'key' : 'key'
      entries.push(entry)
      save(entries)
      const idx = await index(entry)
      const unknownReportIds = unknownReports(entry.reportIds)
      res.json({ ok: true, id: entry.id, priorSimilar, perKey, matchedBy, keyed: entry.keys.length > 0, ...idx, ...(unknownReportIds.length ? { unknownReportIds } : {}) })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  /** Append — the "one more line as I go" path; never resends the body. */
  router.post('/api/journal/:id/append', json, async (req: Req, res: Res) => {
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
      // Re-index: doc_id is the entry id, so this replaces rather than duplicates.
      const idx = await index(entry)
      const unknownReportIds = unknownReports(entry.reportIds)
      res.json({ ok: true, id: entry.id, status: entry.status, ...idx, ...(unknownReportIds.length ? { unknownReportIds } : {}) })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  /** Update — replaces fields; the previous body is kept as a revision. */
  router.patch('/api/journal/:id', json, async (req: Req, res: Res) => {
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
      if (d.issue !== undefined) entry.issue = d.issue   // originalIssue deliberately untouched
      // Keys ACCUMULATE — backfilling an identity must never drop an existing one.
      const add = [...(d.keys ?? []), ...(d.key ? [d.key] : [])].map((k) => k.trim())
      const addBad = badKeys(add)
      if (addBad.length) return fail(res, 400, `key must be source:subject — got ${addBad.join(', ')}`)
      if (add.length) entry.keys = [...new Set([...(entry.keys ?? []), ...add])]
      if (d.status !== undefined) entry.status = d.status
      if (d.reportIds !== undefined) entry.reportIds = d.reportIds
      if (d.links !== undefined) entry.links = d.links
      if (d.author) entry.author = d.author
      entry.updatedAt = stamp()
      save(entries)
      const idx = await index(entry)
      const unknownReportIds = unknownReports(entry.reportIds)
      res.json({ ok: true, id: entry.id, revisions: entry.revisions.length, ...idx, ...(unknownReportIds.length ? { unknownReportIds } : {}) })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  return router
}
