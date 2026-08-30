/**
 * Journal per-entry anchor — store-side resolution.
 * Run: tsx packages/ui/src/renderer_v2/stores/journalAnchor.extreme.spec.ts
 *
 * The anchor's one job is bringing a reader TO a cited entry (a work order
 * citing j-mtg5p44o-ti2s is the live case). The failure worth testing against
 * is the silent miss: a jump that resolves to nothing must SAY so — landing at
 * the top of the log unexplained reads as "it worked", which is the same
 * silent-failure family the whole sweep is removing. So the assertions come in
 * the usual pairs: ids that must resolve, and ids that must visibly not.
 */
import { bucketJournalByWeek } from './PagesStore'

let passed = 0
const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`FAILED: ${msg}`)
  passed++
  console.log(`  ok — ${msg}`)
}

// Minimal window+bridge stand-in BEFORE the store module binds to it. The
// bridge serves a fixed journal; no real backend, no live anything.
const entries = [
  {
    id: 'j-mtg5p44o-ti2s', issue: '21 model bindings vs suspended 27B', originalIssue: '21 model bindings vs suspended 27B',
    keys: ['model-bindings:qwen3.5-27b'], status: 'open', notes: 'recheck when the 27B resumes',
    reportIds: ['maintenance-27b-suspend'], links: [], createdAt: '2026-08-30T18:00:00Z', updatedAt: '2026-08-30T18:05:00Z',
    author: 'maintenance-claude', revisions: [],
  },
  {
    id: 'note-mtg2c927-vx4e', issue: '1 Optane pool(s) cannot be pruned', originalIssue: '1 Optane pool(s) cannot be pruned',
    keys: [], status: 'no-action', notes: 'migrated record', reportIds: [], links: [],
    createdAt: '2026-08-30T17:08:07Z', updatedAt: '2026-08-30T17:08:07Z', author: 'maintenance-claude', revisions: [],
    excludedFromCounts: 'migrated',
  },
]
;(globalThis as any).window = {
  gyshell: {
    cluster: {
      request: async (_m: string, path: string) => {
        if (path.startsWith('/api/journal')) return { entries }
        if (path.startsWith('/api/reports/types')) return { types: [] }
        if (path.startsWith('/api/reports')) return { reports: [] }
        return {}
      },
    },
  },
}

async function main(): Promise<void> {
  const { pagesStore } = await import('./PagesStore')
  const store = pagesStore as any

  // ── resolution: must land ─────────────────────────────────────────────────
  await store.openJournalEntry('j-mtg5p44o-ti2s')
  assert(store.view === 'journal', 'opening an entry switches to the Journal view')
  assert(store.anchorEntryId === 'j-mtg5p44o-ti2s', 'a known id resolves to the anchor')
  assert(store.anchorMissing === null, 'and reports no miss')

  store.clearJournalAnchor()
  assert(store.anchorEntryId === null, 'the panel can clear the anchor after the flash')

  await store.openJournalEntry('  note-mtg2c927-vx4e  ')
  assert(store.anchorEntryId === 'note-mtg2c927-vx4e',
    'a migrated note id resolves too (whitespace trimmed) — old citations stay live')

  // ── resolution: must MISS loudly ──────────────────────────────────────────
  await store.openJournalEntry('j-nonexistent-0000')
  assert(store.anchorEntryId === null, 'an unknown id sets NO anchor — no silent scroll-to-nowhere')
  assert(store.anchorMissing === 'j-nonexistent-0000',
    'and the miss is SURFACED with the id that failed, not swallowed')
  store.dismissAnchorMiss()
  assert(store.anchorMissing === null, 'the miss note is dismissible')

  await store.openJournalEntry('   ')
  assert(store.anchorEntryId === null && store.anchorMissing === null,
    'a blank jump is a no-op, not a miss report')

  // A new jump clears a stale miss — the banner must describe the LAST action.
  await store.openJournalEntry('j-nope')
  await store.openJournalEntry('j-mtg5p44o-ti2s')
  assert(store.anchorMissing === null && store.anchorEntryId === 'j-mtg5p44o-ti2s',
    'a successful jump clears a previous miss banner')

  // ── report→entry backlink ─────────────────────────────────────────────────
  const citing = store.entriesCiting('maintenance-27b-suspend')
  assert(citing.length === 1 && citing[0].id === 'j-mtg5p44o-ti2s',
    'entriesCiting finds the entry whose reportIds include the report')
  assert(store.entriesCiting('some-other-report').length === 0,
    'and returns nothing for an uncited report — no over-matching')

  // ── the anchor's week is findable (panel uses this to set the sidebar) ────
  const weeks = bucketJournalByWeek(store.journal)
  const wk = weeks.find((w: any) => w.entries.some((e: any) => e.id === 'j-mtg5p44o-ti2s'))
  assert(!!wk, 'the anchored entry is locatable inside a week bracket for the sidebar highlight')

  console.log(`\n${passed} assertions passed`)
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
