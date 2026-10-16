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

export interface JournalRouterDeps {
  /** Override the vectoriser (specs). Default: reportsRag.indexJournalEntry. */
  indexEntry?: (entry: JournalEntry) => Promise<void>
  /** Override semantic search (specs). Default: reportsRag.searchJournal. */
  searchJournal?: (q: string, limit: number) => Promise<unknown>
  /** Retry backoff schedule; one in-process retry per slot. */
  retryDelaysMs?: number[]
  /** Delay before the startup sweep that re-queues persisted failures. */
  startupSweepDelayMs?: number
}

export function createJournalRouter(dataDir: string, notify?: NotifyFn, deps?: JournalRouterDeps): express.Router {
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
  const doIndex = deps?.indexEntry ?? (async (entry: JournalEntry) => {
    const { indexJournalEntry } = await import('./reportsRag')
    await indexJournalEntry(entry)
  })

  /** An entry whose LATEST index attempt failed. Entries from before state
   *  tracking carry neither field; their absence is "not tracked", never
   *  "unindexed", so they are deliberately not matched here. */
  const needsIndex = (e: JournalEntry): boolean =>
    !!e.indexError && (!e.indexedAt || e.indexedAt < e.indexError.at)

  /** Re-load → apply ONLY index-state fields → save. The index attempt awaits a
   *  network call, and a content write can land in that window; writing the
   *  whole stale entry back would silently erase it. */
  const persistIndexState = (id: string, apply: (e: JournalEntry) => void): void => {
    const fresh = load()
    const e = fresh.find((x) => x.id === id)
    if (!e) return
    apply(e)
    save(fresh)
  }

  /**
   * Retry with backoff — the dependency being down is transient by nature
   * (j-mtui4had-qn85 failed because the embed backends came up 40 seconds
   * AFTER the attempt). One warning per failure EPISODE, not per attempt:
   * the first failure notifies, retries log to console, recovery notifies.
   * Bounded per process; the persisted state plus the startup sweep carry
   * an outage longer than the schedule across the next restart, and the
   * journal_search warning + reindex affordance cover the gap between.
   */
  const RETRY_DELAYS_MS = deps?.retryDelaysMs ?? [30_000, 120_000, 600_000, 1_800_000, 3_600_000]
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const processAttempts = new Map<string, number>()
  const scheduleRetry = (id: string): void => {
    if (retryTimers.has(id)) return
    const n = processAttempts.get(id) ?? 0
    if (n >= RETRY_DELAYS_MS.length) return   // exhausted this process; sweep re-arms after restart
    processAttempts.set(id, n + 1)
    const t = setTimeout(() => {
      retryTimers.delete(id)
      const entry = load().find((e) => e.id === id)
      if (entry && needsIndex(entry)) void index(entry)
    }, RETRY_DELAYS_MS[n])
    ;(t as { unref?: () => void }).unref?.()
    retryTimers.set(id, t)
  }

  const index = async (entry: JournalEntry): Promise<{ indexed: boolean; indexError?: string }> => {
    const priorAttempts = entry.indexError?.attempts ?? 0
    try {
      await doIndex(entry)
      const recovered = priorAttempts > 0
      const at = stamp()
      entry.indexedAt = at
      delete entry.indexError
      persistIndexState(entry.id, (e) => { e.indexedAt = at; delete e.indexError })
      processAttempts.delete(entry.id)
      if (recovered) {
        console.log(`[journal] ${entry.id} indexed after ${priorAttempts} failed attempt(s)`)
        notify?.({
          severity: 'info', source: 'journal-rag',
          message: `Journal entry ${entry.id} indexed after ${priorAttempts} failed attempt(s)`,
          detail: `"${entry.issue}" now reaches semantic search. Positive evidence, not a timeout: the store accepted the vector.`,
        })
      }
      return { indexed: true }
    } catch (e) {
      const indexError = (e as Error).message
      const state = { at: stamp(), error: indexError.slice(0, 500), attempts: priorAttempts + 1 }
      entry.indexError = state
      persistIndexState(entry.id, (x) => { x.indexError = state })
      if (state.attempts === 1) {
        console.warn(`[journal] ${entry.id} saved but NOT indexed:`, indexError)
        notify?.({
          severity: 'warning', source: 'journal-rag',
          message: `Journal entry ${entry.id} saved but not indexed`,
          detail: `"${entry.issue}" did not reach the ${process.env.AILAB_JOURNAL_COLLECTION || 'ailab_journal'} collection: ${indexError}. ` +
            `The entry is safe and readable; semantic search will not find it until it is re-indexed. ` +
            `Retrying with backoff; journal_search warns while it is missing, and journal_reindex forces a retry.`,
        })
      } else {
        console.warn(`[journal] ${entry.id} re-index attempt ${state.attempts} failed:`, indexError)
      }
      scheduleRetry(entry.id)
      return { indexed: false, indexError }
    }
  }

  migrateNotes()

  // Startup sweep: failures persisted by a previous process get retried, so an
  // outage longer than one process's backoff schedule still converges. Delayed,
  // because the likeliest moment for this code to run is right after the same
  // reboot that took the embed backends down.
  const sweepT = setTimeout(() => {
    const pending = load().filter(needsIndex)
    if (!pending.length) return
    console.log(`[journal] startup sweep: ${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} saved but not indexed — retrying`)
    for (const e of pending) void index(e)
  }, deps?.startupSweepDelayMs ?? 20_000)
  ;(sweepT as { unref?: () => void }).unref?.()

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
    // The unindexed list rides on EVERY search response: semantic search does not
    // error on a missing entry — it returns a page of other, plausible entries —
    // so an incomplete index is indistinguishable from "never logged" unless the
    // response itself says what is missing.
    const unindexed = load().filter(needsIndex)
      .map((e) => ({ id: e.id, issue: e.issue, failedAt: e.indexError!.at, attempts: e.indexError!.attempts }))
    try {
      const doSearch = deps?.searchJournal ?? (async (qq: string, lim: number) => {
        const { searchJournal } = await import('./reportsRag')
        return searchJournal(qq, lim)
      })
      res.json({ ok: true, results: await doSearch(q, Number(req.query.limit) || 10), ...(unindexed.length ? { unindexed } : {}) })
    } catch (e) { fail(res, 502, `journal search unavailable: ${(e as Error).message}`) }
  })

  /**
   * Reindex WITHOUT mutation — the recovery lever. The only lever before this
   * was journal_append, which mutates the record to fix its metadata. By id for
   * one entry (allowed even without a recorded failure, e.g. after a collection
   * wipe); bare for every entry whose last attempt failed; ?all=1 for the whole
   * journal.
   */
  router.post('/api/journal/reindex', async (req: Req, res: Res) => {
    try {
      const entries = load()
      const targets = String(req.query.all ?? '') === '1' ? entries : entries.filter(needsIndex)
      const results = { attempted: targets.length, indexed: 0, failed: [] as Array<{ id: string; error: string }> }
      for (const e of targets) {
        const r = await index(e)
        if (r.indexed) results.indexed++
        else results.failed.push({ id: e.id, error: r.indexError ?? 'unknown' })
      }
      res.json({ ok: true, ...results })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  router.post('/api/journal/:id/reindex', async (req: Req, res: Res) => {
    try {
      const entry = load().find((e) => e.id === req.params.id)
      if (!entry) return fail(res, 404, `no journal entry ${req.params.id}`)
      const idx = await index(entry)
      res.json({ ok: true, id: entry.id, ...idx })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
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
