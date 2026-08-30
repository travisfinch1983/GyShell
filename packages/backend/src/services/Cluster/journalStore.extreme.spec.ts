/**
 * Journal spec — occurrence counting, migration, and the working-log edits.
 * Run: tsx packages/backend/src/services/Cluster/journalStore.extreme.spec.ts
 *
 * 🛑 WHAT THIS SUITE IS FOR. The journal's whole job is answering "have I seen
 * this before?", and every way that answer has been wrong so far has been wrong
 * SILENTLY and PLAUSIBLY — a real repeat reported as first-of-kind, or a new
 * problem reported as one already dismissed. Neither looks like a failure.
 *
 * So the assertions come in matched pairs: things that MUST count as repeats,
 * and things that MUST NOT. The previous suite asserted only the first kind
 * (three identical strings), which is why it could not detect over-matching —
 * a key of "always match" would have passed it completely (claude1's own
 * assessment of his tests, 2026-08-30). A suite that only proves things match
 * cannot tell you whether matching means anything.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
// @ts-expect-error — express ships untyped in this repo
import express from 'express'
import { createJournalRouter } from './journalHttp'

let passed = 0
const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`FAILED: ${msg}`)
  passed++
  console.log(`  ok — ${msg}`)
}

// 🛑 Point the indexer at a dead port BEFORE anything can call it. A scratch
// dataDir isolates STORAGE, not the network: the default memory URL is a real
// service on this machine, and a spec that vectorises its fixtures would write
// test entries into the live collection. reportsRag reads this per call rather
// than at import, which is the only reason setting it here works at all.
process.env.UNIFIED_MEMORY_URL = 'http://127.0.0.1:9'
process.env.AILAB_JOURNAL_COLLECTION = 'spec_journal_never_written'

/** Every notify the router emits — asserted on, and never leaving the process. */
const emitted: Array<{ severity: string; source: string; message: string; detail?: string }> = []

const dataDir = mkdtempSync(join(tmpdir(), 'journal-spec-'))

// Seed the OLD store, in its real shape, before the router is constructed: the
// migration runs at construction and this is the only honest way to test it.
// These two ids are the live rows on CT152 (maintenance-claude, 17:08Z).
writeFileSync(join(dataDir, 'journal-notes.json'), JSON.stringify({
  notes: [
    {
      id: 'note-mtg2c927-vx4e', category: 'maintenance',
      createdAt: '2026-08-30T17:08:07.000Z',
      issue: '1 Optane pool(s) cannot be pruned',
      cause: 'no hotness sidecar and no live engine wired to them',
      whyNoAction: 'expected while the pools are idle; not a fault',
      author: 'maintenance-claude', links: ['notif-optane-1'],
    },
    {
      id: 'note-mtg2ceem-fjw0', category: 'maintenance',
      createdAt: '2026-08-30T17:08:14.000Z',
      issue: 'support model failover for tts',
      whyNoAction: 'failover behaved correctly; primary returned on its own',
      author: 'maintenance-claude', links: [],
    },
  ],
}))

const app = express()
app.use(createJournalRouter(dataDir, (i) => emitted.push(i)))
const server = http.createServer(app)

const call = (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> =>
  new Promise((resolve, reject) => {
    const addr = server.address() as { port: number }
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, method, path, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          let json: any = {}
          try { json = buf ? JSON.parse(buf) : {} } catch { json = { _raw: buf } }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

const load = (): any[] => JSON.parse(readFileSync(join(dataDir, 'journal.json'), 'utf8')).entries

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))

  // ── MIGRATION ─────────────────────────────────────────────────────────────
  // Gate 1. The rename orphaned these rows: the new file was simply absent, the
  // journal read empty, and an empty journal is indistinguishable from "this has
  // never happened before" — the exact claim the system exists to disprove.
  console.log('\n[migration]')
  let r = await call('GET', '/api/journal')
  const ids = (r.json.entries ?? []).map((e: any) => e.id)
  assert(ids.includes('note-mtg2c927-vx4e'), 'the Optane note survived the rename')
  assert(ids.includes('note-mtg2ceem-fjw0'), 'the failover note survived the rename')

  const optane = r.json.entries.find((e: any) => e.id === 'note-mtg2c927-vx4e')
  assert(optane.status === 'no-action', 'a note maps to the no-action outcome it recorded')
  assert(optane.notes.includes('no hotness sidecar'), 'the cause text was carried over, not dropped')
  assert(optane.notes.includes('expected while the pools are idle'), 'whyNoAction carried over')
  assert(optane.createdAt === '2026-08-30T17:08:07.000Z', 'the original timestamp is preserved, not restamped')
  assert(optane.author === 'maintenance-claude', 'authorship survives migration')
  assert(optane.originalIssue === '1 Optane pool(s) cannot be pruned', 'filed-under name recorded')
  assert(optane.keys.length === 0, 'no key was INVENTED for it during migration')

  // Non-destructive: a bad conversion has to be recoverable, so the source is
  // renamed rather than deleted.
  assert(!existsSync(join(dataDir, 'journal-notes.json')), 'old file moved aside')
  assert(existsSync(join(dataDir, 'journal-notes.json.migrated')), 'old file KEPT as .migrated, not deleted')

  // Idempotent: a second construction must not duplicate rows.
  const app2 = express(); app2.use(createJournalRouter(dataDir, (i) => emitted.push(i)))
  const again = JSON.parse(readFileSync(join(dataDir, 'journal.json'), 'utf8'))
  assert(again.entries.filter((e: any) => e.id === 'note-mtg2c927-vx4e').length === 1,
    'constructing the router twice does not duplicate migrated rows')

  // ── COUNTING: what MUST be a repeat ───────────────────────────────────────
  console.log('\n[counting — must match]')

  // Gate 3, the case that actually bit us. The emitter interpolates the COUNT:
  // "$nosig Optane pool(s) cannot be pruned". A recurrence affecting two pools
  // is not string-equal to one affecting one, so exact matching returned 0 and
  // the recurrence read as first-of-kind — varying run to run with no change to
  // any code. Unkeyed entries fall back to normalised text, which collapses it.
  // Two fresh unkeyed entries whose text differs only by the interpolated count.
  // (The migrated note is deliberately excluded from counting, so this must not
  // lean on it — a test that passes via a row we marked uncountable would be
  // measuring the wrong thing.)
  r = await call('POST', '/api/journal', {
    issue: '3 widgets failed to reconcile', status: 'no-action', author: 'spec',
  })
  assert(r.json.priorSimilar === 0, 'first unkeyed occurrence counts 0')
  r = await call('POST', '/api/journal', {
    issue: '17 widgets failed to reconcile', status: 'no-action', author: 'spec',
  })
  assert(r.json.priorSimilar === 1,
    'a message differing only by an interpolated number counts as a repeat')
  assert(String(r.json.matchedBy).startsWith('text'),
    'and it says the count came from TEXT, so the number is not mistaken for identity')

  // Gate 2. Renaming an entry mid-work must not move it out of its own history.
  r = await call('POST', '/api/journal', {
    issue: 'qdrant unreachable', key: 'health:qdrant', author: 'spec',
  })
  const editable = r.json.id
  assert(r.json.priorSimilar === 0, 'first occurrence of a keyed issue counts 0')
  assert(r.json.matchedBy === 'key', 'a keyed write reports key matching, not text')

  r = await call('PATCH', `/api/journal/${editable}`, {
    issue: 'qdrant refusing connections on :6333 (tidied wording)', notes: 'looked closer', author: 'spec',
  })
  assert(r.status === 200, 'the entry can be edited as work proceeds')

  r = await call('POST', '/api/journal', { issue: 'qdrant unreachable again', key: 'health:qdrant', author: 'spec' })
  assert(r.json.priorSimilar === 1, 'EDITING AN ENTRY DOES NOT RESET THE COUNT — the edit is not a new occurrence')
  assert(r.json.perKey['health:qdrant'] === 1, 'and the count is attributed to the subject')

  // Same identity, deliberately unrecognisable prose.
  r = await call('POST', '/api/journal', {
    issue: 'vector store timing out — completely different words', key: 'health:qdrant', author: 'spec',
  })
  assert(r.json.priorSimilar === 2, 'same key + different display text still counts as a repeat')

  // claude1's fan-out assertion: the same subject keys identically no matter how
  // many others are affected in the same run, because each subject is its own note.
  await call('POST', '/api/journal', { issue: 'pool-a unprunable', key: 'optane-pruner:pool-a', author: 'spec' })
  await call('POST', '/api/journal', { issue: 'pool-b unprunable', key: 'optane-pruner:pool-b', author: 'spec' })
  r = await call('POST', '/api/journal', { issue: 'pool-b unprunable', key: 'optane-pruner:pool-b', author: 'spec' })
  assert(r.json.priorSimilar === 1,
    'when one pool is fixed, the pool that persists still counts its own prior occurrence')
  assert(r.json.perKey['optane-pruner:pool-b'] === 1, 'counted against pool-b specifically')

  // ── COUNTING: what MUST NOT be a repeat ───────────────────────────────────
  // The half the old suite was missing entirely. Without these, a key of
  // "always match" passes every assertion above.
  console.log('\n[counting — must NOT match]')

  r = await call('POST', '/api/journal', {
    issue: 'unified-memory MCP is DOWN', key: 'health:unified-memory', author: 'spec',
  })
  assert(r.json.priorSimilar === 0,
    'SAME SOURCE, DIFFERENT SUBJECT is not a repeat — health:qdrant must not match health:unified-memory')

  r = await call('POST', '/api/journal', { issue: 'pool-c unprunable', key: 'optane-pruner:pool-c', author: 'spec' })
  assert(r.json.priorSimilar === 0, 'a new pool is not a repeat of a different pool')

  r = await call('POST', '/api/journal', { issue: 'nothing whatsoever to do with the above', author: 'spec' })
  assert(r.json.priorSimilar === 0, 'an unrelated issue still counts 0')

  // ── KEY SHAPE ─────────────────────────────────────────────────────────────
  // Refusing bare sources is what makes the rule real rather than advisory: a
  // bare source over-matches, and over-matching is the more dangerous direction
  // — a spurious "you have dismissed this before" argues for ignoring something
  // new, with the authority of the system built to prevent that.
  console.log('\n[key shape]')
  r = await call('POST', '/api/journal', { issue: 'something', key: 'health', author: 'spec' })
  assert(r.status === 400, 'a BARE SOURCE key is refused, never silently accepted')
  assert(String(r.json.error).includes('health:qdrant'), 'and the refusal shows what to send instead')

  r = await call('POST', '/api/journal', { issue: 'joined', key: 'optane-pruner:pool-a, pool-b', author: 'spec' })
  assert(r.status === 400,
    'a JOINED subject list is refused — an unstable key is an emitter bug, made visible not accommodated')

  r = await call('PATCH', `/api/journal/${editable}`, { key: 'health', author: 'spec' })
  assert(r.status === 400, 'backfilling a bare source is refused on update too')

  // Backfill accumulates rather than replaces, so an entry can gain an identity
  // without losing what it already matched on.
  r = await call('PATCH', `/api/journal/${editable}`, { key: 'health:qdrant-6333', author: 'spec' })
  assert(r.status === 200, 'an entry can be backfilled with an additional key')
  r = await call('GET', `/api/journal/${editable}`)
  assert(r.json.entry.keys.includes('health:qdrant') && r.json.entry.keys.includes('health:qdrant-6333'),
    'keys ACCUMULATE — backfilling never drops the identity already there')
  r = await call('POST', '/api/journal', { issue: 'qdrant again', key: 'health:qdrant-6333', author: 'spec' })
  assert(r.json.priorSimilar === 1, 'and the backfilled identity matches a later recurrence')

  // ── WORKING LOG ───────────────────────────────────────────────────────────
  // Editable, but not rewritable in secret: the point of the log is remembering
  // across context windows, and a silently-rewritten memory is worse than none.
  console.log('\n[working log]')
  r = await call('POST', '/api/journal', { issue: 'a piece of work', notes: 'first finding', author: 'spec' })
  const wip = r.json.id
  r = await call('POST', `/api/journal/${wip}/append`, { text: 'second finding', author: 'spec' })
  assert(r.status === 200, 'append adds a line without resending the body')
  r = await call('GET', `/api/journal/${wip}`)
  assert(r.json.entry.notes.includes('first finding') && r.json.entry.notes.includes('second finding'),
    'append is ADDITIVE — it never replaces what was there')
  assert(r.json.entry.revisions.length === 0, 'an append is not a revision, because nothing was replaced')

  r = await call('PATCH', `/api/journal/${wip}`, { notes: 'rewritten entirely', status: 'resolved', author: 'spec' })
  r = await call('GET', `/api/journal/${wip}`)
  assert(r.json.entry.notes === 'rewritten entirely', 'update replaces the body')
  assert(r.json.entry.revisions[0].previous.includes('first finding'),
    'and the PREVIOUS text is kept — editable without being rewritable in secret')
  assert(r.json.entry.status === 'resolved', 'status moves with the work')

  // ── GAPS ──────────────────────────────────────────────────────────────────
  // The derived journal made "filed a report, logged nothing" impossible by
  // construction. A first-class working log cannot, so the gap is detected.
  console.log('\n[gaps]')
  // ── NON-COUNTING RECORDS ──────────────────────────────────────────────────
  // Both migrated notes are worth keeping and neither can honestly count: one
  // was filed from an alert with no pool identity (naming the pools is what
  // 7e4a654 added), the other's subject is a synthetic probe that cannot recur.
  // Without an explicit exclusion the first would still match by normalised
  // text — reporting that an aggregate alert repeated, while saying nothing
  // about whether the same pool did. A number that answers a different question
  // is exactly the failure this surface keeps hitting.
  console.log('\n[non-counting records]')
  r = await call('GET', '/api/journal/note-mtg2c927-vx4e')
  assert(!!r.json.entry.excludedFromCounts, 'the migrated note is marked non-counting')
  assert(r.json.entry.excludedFromCounts.includes('invented'),
    'and carries the REASON, so the exclusion is self-explaining rather than mysterious')
  assert(r.json.entry.notes.includes('no hotness sidecar'),
    'while still being kept in full as a record — excluded from counting is not deleted')

  r = await call('POST', '/api/journal', {
    issue: '9 Optane pool(s) cannot be pruned', status: 'no-action', author: 'spec',
  })
  const optaneRepeats = r.json.priorSimilar
  r = await call('POST', '/api/journal', {
    issue: '11 Optane pool(s) cannot be pruned', status: 'no-action', author: 'spec',
  })
  assert(r.json.priorSimilar === optaneRepeats + 1,
    'later real occurrences count each other normally — exclusion is per-entry, not a dead key')

  // ── INDEXING ──────────────────────────────────────────────────────────────
  // Dismissals produce no report, so report_search cannot reach them; without
  // vectorising the journal they would be findable only by exact key (which you
  // must already know) or substring (which fails on rewording — the exact defect
  // just removed from counting). So entries are indexed. The indexer is pointed
  // at a dead port here, which makes this also the failure-path test.
  console.log('\n[indexing]')
  r = await call('POST', '/api/journal', { issue: 'indexing probe', key: 'spec:probe', author: 'spec' })
  assert(r.status === 200 && r.json.ok, 'a write SUCCEEDS even when the indexer is unreachable')
  assert(r.json.indexed === false && !!r.json.indexError,
    'and reports indexed:false with the cause rather than pretending it worked')
  r = await call('GET', '/api/journal/gaps')
  assert(load().some((e: any) => e.issue === 'indexing probe'), 'the entry is durably stored despite the index failure')

  const idxWarn = emitted.filter((e) => e.source === 'journal-rag')
  assert(idxWarn.length > 0,
    'the index failure LEAVES THE PROCESS as a notification — indexed:false alone is read only by the calling agent')
  assert(idxWarn[0].severity === 'warning' && (idxWarn[0].detail ?? '').includes('safe and readable'),
    'and says the entry is safe, so a degraded index is not mistaken for lost work')

  r = await call('GET', '/api/journal-search?q=anything')
  assert(r.status === 502, 'search reports the indexer being down rather than returning an empty result set')

  console.log('\n[gaps]')
  r = await call('GET', '/api/journal/gaps')
  assert(r.status === 200 && Array.isArray(r.json.unlogged), 'unlogged reports are detectable, not merely searchable')

  console.log(`\n${passed} assertions passed`)
  server.close()
  void app2
}

main().catch((e) => {
  console.error(`\n${e.message}`)
  server.close()
  process.exit(1)
})
