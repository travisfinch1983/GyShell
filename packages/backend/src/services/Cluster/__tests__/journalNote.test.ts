// Answers two questions raised from first live use of the journal:
//   1. does the repeat count actually announce on the SECOND note, or is it unwired?
//   2. are `links` stored-but-dropped, or do they survive into journal_read?
// Isolated: scratch dataDir (notes are append-only, a test entry would be permanent),
// dead RAG endpoint, maintainer route disarmed.
process.env.AILAB_MAINTAINER_AGENT = 'off'
process.env.UNIFIED_MEMORY_URL = 'http://127.0.0.1:9'
// @ts-ignore -- express has no types installed repo-wide.
import express from 'express'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPagesRouter } from '../pagesHttp.js'

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'journal-'))
  const app = express()
  app.use(createPagesRouter(dataDir))
  const srv = app.listen(0)
  const port = (srv.address() as any).port
  const B = `http://127.0.0.1:${port}`

  const note = (issue: string, links: string[] = []) =>
    fetch(`${B}/api/pages/journal/note`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'maintenance', issue, whyNoAction: 'benign', links }),
    }).then((r) => r.json() as any)

  let fail = 0
  const check = (label: string, ok: boolean, got?: unknown) => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — got ${JSON.stringify(got)}`}`)
    if (!ok) fail++
  }

  const first = await note('optane pruner false positive', ['7e4a654', 'event:mtg18o4y-1'])
  check('first note of its kind reports priorSimilar 0', first.priorSimilar === 0, first.priorSimilar)

  const second = await note('optane pruner false positive')
  check('SECOND identical note reports priorSimilar 1', second.priorSimilar === 1, second.priorSimilar)

  const third = await note('optane pruner false positive')
  check('third reports priorSimilar 2 (it counts, not just flags)', third.priorSimilar === 2, third.priorSimilar)

  const other = await note('something entirely different')
  check('an unrelated issue is not counted as a repeat', other.priorSimilar === 0, other.priorSimilar)

  const j: any = await fetch(`${B}/api/pages/journal?category=maintenance`).then((r) => r.json())
  const withLinks = (j.entries ?? []).find((e: any) => e.noteId === first.id)
  check('the note appears in the journal', !!withLinks, j.entries?.length)
  check('links survive into the journal entry', Array.isArray(withLinks?.links) && withLinks.links.length === 2, withLinks?.links)
  check('links keep their exact values', withLinks?.links?.includes('7e4a654') && withLinks?.links?.includes('event:mtg18o4y-1'), withLinks?.links)

  srv.close()
  console.log(fail === 0 ? '\nALL PASS — the repeat count is wired and counts; links reach the journal.' : `\n${fail} FAILURE(S)`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
