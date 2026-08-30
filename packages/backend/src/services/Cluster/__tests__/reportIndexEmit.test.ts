// Proves the indexed:false emitter fires. Mounted in isolation with a scratch dataDir so no
// note reaches the real journal -- notes are append-only, so a test entry would be permanent.
// Storage isolation is not network isolation, so the RAG URL is pointed at a dead port and the
// maintainer route is disarmed: see feedback on the harness that woke maintenance-claude.
process.env.AILAB_MAINTAINER_AGENT = 'off'
process.env.UNIFIED_MEMORY_URL = 'http://127.0.0.1:9'   // dead: forces the index to fail
// @ts-ignore -- express has no types installed repo-wide (same as notesHttp/svgsHttp).
// @ts-ignore is deliberate over @ts-expect-error: if types are ever added, an expect-error
// would itself become an unused-directive error and break the baseline it protects.
import express from 'express'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPagesRouter } from '../pagesHttp.js'

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pages-emit-'))
  mkdirSync(path.join(dataDir, 'pages'), { recursive: true })
  writeFileSync(path.join(dataDir, 'pages', 'report-categories.json'), JSON.stringify({
    categories: [{ id: 'maintenance', label: 'Maintenance', description: 'test', collection: 'test_collection' }],
  }))

  const seen: any[] = []
  const app = express()
  app.use(createPagesRouter(dataDir, (e) => seen.push(e)))
  const srv = app.listen(0)
  const port = (srv.address() as any).port

  const res = await fetch(`http://127.0.0.1:${port}/api/pages/journal/note`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'maintenance', issue: 'emitter probe', whyNoAction: 'probe' }),
  })
  const body: any = await res.json()
  srv.close()

  let fail = 0
  const check = (label: string, ok: boolean, got: unknown) => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — got ${JSON.stringify(got)}`}`)
    if (!ok) fail++
  }
  check('the note still SAVED despite the index failing', body?.ok === true && !!body?.id, body)
  check('indexed reported false', body?.indexed === false, body?.indexed)
  check('indexError surfaced to the caller', typeof body?.indexError === 'string' && body.indexError.length > 0, body?.indexError)
  check('exactly one notification raised', seen.length === 1, seen.length)
  check('severity is warning (degraded, not broken)', seen[0]?.severity === 'warning', seen[0]?.severity)
  check('source is reports-rag', seen[0]?.source === 'reports-rag', seen[0]?.source)
  // The detail must let a reader act without opening a log: which note, which
  // collection it failed to reach, and why.
  check('detail names the note, its collection and the cause',
    /note-\S+ in \S+: .+/.test(seen[0]?.detail || ''), seen[0]?.detail)

  console.log(fail === 0 ? '\nALL PASS — a report that cannot be indexed now surfaces instead of degrading search silently.' : `\n${fail} FAILURE(S)`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
