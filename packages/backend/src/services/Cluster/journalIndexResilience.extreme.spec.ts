/**
 * Journal index resilience — a saved entry must not silently vanish from search.
 * Run: tsx packages/backend/src/services/Cluster/journalIndexResilience.extreme.spec.ts
 *
 * The case this encodes (j-mtui4had-qn85): an entry saved during a reboot window
 * failed to vectorise ("operation aborted due to timeout" — the embed backends
 * answered 40s AFTER the attempt) and was never retried. It stayed readable in
 * journal_read and invisible to journal_search, which does not error on a missing
 * entry — it returns other, plausible entries — so the loss presented as "I guess
 * I never logged that". Drives the REAL router over HTTP; only the vectoriser and
 * semantic search are injected.
 */
// @ts-expect-error — express ships untyped in this repo
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournalRouter, type NotifyFn } from './journalHttp'

let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'journal-spec-'))
  const emitted: Array<{ severity: string; source: string; message: string; detail?: string }> = []
  const notify: NotifyFn = (e) => emitted.push(e)

  let indexerUp = false
  let indexCalls = 0
  const deps = {
    indexEntry: async () => { indexCalls++; if (!indexerUp) throw new Error('operation aborted due to timeout') },
    searchJournal: async () => [{ text: 'some other, plausible entry' }],
    retryDelaysMs: [60, 60, 60],
    // long, so the FIRST router's sweep can never race the assertions — only the
    // second router (the simulated restart) uses a short sweep delay
    startupSweepDelayMs: 60_000,
  }
  const app = express()
  app.use(createJournalRouter(dir, notify, deps))
  const srv = app.listen(0)
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await fetch(`${base}${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    return r.json()
  }

  // ── 1. a write while the indexer is down SAVES, reports indexed:false, notifies once ──
  const made = await api('POST', '/api/journal', { issue: 'mlx4 CATAS during reboot', key: 'health:mlx4', notes: 'first look' })
  ok(made.ok === true && made.indexed === false && /timeout/.test(made.indexError),
    'a write during an indexer outage saves and reports indexed:false — never blocks or loses the entry')
  const id = made.id as string
  const got1 = await api('GET', `/api/journal/${id}`)
  ok(got1.entry.indexError?.attempts === 1 && !got1.entry.indexedAt,
    'the failure is PERSISTED on the entry (attempts=1) — index state survives a restart')
  ok(emitted.filter((e) => e.severity === 'warning' && e.message.includes(id)).length === 1,
    'exactly one warning notification for the failure')

  // ── 2. journal-search WARNS about the unindexed entry — including on a miss ──
  const sr = await api('GET', '/api/journal-search?q=mlx4')
  ok(Array.isArray(sr.unindexed) && sr.unindexed.length === 1 && sr.unindexed[0].id === id,
    'journal-search names the unindexed entry — an incomplete index is distinguishable from "never logged"')

  // ── 3. retry with backoff converges once the dependency returns ──
  await sleep(90)   // first retry fires at 60ms and fails (indexer still down)
  const afterRetry = await api('GET', `/api/journal/${id}`)
  ok(afterRetry.entry.indexError.attempts >= 2,
    'the retry fired on its own and recorded the attempt (attempts>=2)')
  ok(emitted.filter((e) => e.severity === 'warning' && e.message.includes(id)).length === 1,
    'retry failures do NOT re-notify — one warning per episode, not per attempt')
  indexerUp = true
  await sleep(90)   // next backoff slot succeeds
  const healed = await api('GET', `/api/journal/${id}`)
  ok(!!healed.entry.indexedAt && !healed.entry.indexError,
    'backoff retry indexed the entry once the backend returned: indexedAt set, indexError cleared')
  ok(emitted.some((e) => e.severity === 'info' && e.message.includes('after') && e.message.includes(id)),
    'recovery notifies with the attempt count — positive evidence, visible end')
  const sr2 = await api('GET', '/api/journal-search?q=mlx4')
  ok(!sr2.unindexed, 'the search warning clears once the entry is indexed')

  // ── 4. reindex by id does NOT mutate the entry ──
  indexerUp = true
  const before = await api('GET', `/api/journal/${id}`)
  const ri = await api('POST', `/api/journal/${id}/reindex`)
  const after = await api('GET', `/api/journal/${id}`)
  ok(ri.ok === true && ri.indexed === true, 'reindex by id succeeds')
  ok(after.entry.notes === before.entry.notes && after.entry.revisions.length === before.entry.revisions.length
     && after.entry.updatedAt === before.entry.updatedAt,
    'reindex touches NO content — no revision, no updatedAt bump (the old lever, journal_append, mutated the record)')

  // ── 5. bulk reindex retries exactly the failed set ──
  indexerUp = false
  const m2 = await api('POST', '/api/journal', { issue: 'embedder flap two', key: 'health:embed-2' })
  const m3 = await api('POST', '/api/journal', { issue: 'embedder flap three', key: 'health:embed-3' })
  ok(m2.indexed === false && m3.indexed === false, 'two more entries fail while the indexer is down')
  indexerUp = true
  const bulk = await api('POST', '/api/journal/reindex')
  ok(bulk.attempted === 2 && bulk.indexed === 2,
    'bulk reindex targets exactly the entries whose last attempt failed (not the healthy one)')

  // ── 6. the startup sweep re-queues persisted failures after a restart ──
  indexerUp = false
  const m4 = await api('POST', '/api/journal', { issue: 'saved during the reboot window', key: 'health:reboot-window' })
  ok(m4.indexed === false, 'entry fails while down (pre-restart)')
  srv.close()
  // a NEW router over the same dataDir = the restarted process
  const calls0 = indexCalls
  indexerUp = true
  const app2 = express()
  app2.use(createJournalRouter(dir, notify, { ...deps, startupSweepDelayMs: 30 }))
  const srv2 = app2.listen(0)
  const base2 = `http://127.0.0.1:${(srv2.address() as { port: number }).port}`
  await sleep(120)
  const m4after = await (await fetch(`${base2}/api/journal/${m4.id}`)).json()
  ok(indexCalls > calls0 && !!m4after.entry.indexedAt && !m4after.entry.indexError,
    'the startup sweep found the persisted failure and indexed it — an outage outlives one process, the state outlives the outage')
  srv2.close()

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
