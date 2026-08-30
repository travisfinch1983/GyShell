// Proves the indexed:false emitter survived the toolset split. It was wired into pagesHttp
// (e0839e6); the split moved reports to their own router, which did not carry it forward --
// a functional revert that git could not flag because the code moved rather than changed.
//
// Isolated: scratch dataDir, RAG pointed at a dead port, maintainer route disarmed. A scratch
// dataDir isolates storage, not the network, and the default RAG target is a live service.
process.env.AILAB_MAINTAINER_AGENT = 'off'
process.env.UNIFIED_MEMORY_URL = 'http://127.0.0.1:9'
// @ts-ignore -- express has no types installed repo-wide (same as notesHttp/svgsHttp).
import express from 'express'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createReportsRouter } from '../reportsHttp.js'

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'reports-emit-'))
  const seen: Array<Record<string, unknown>> = []
  const app = express()
  app.use(createReportsRouter(dataDir, (e: Record<string, unknown>) => seen.push(e)))
  const srv = app.listen(0)
  const port = (srv.address() as { port: number }).port

  const res = await fetch(`http://127.0.0.1:${port}/api/reports/emit-probe`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Emitter probe', type: 'maintenance',
      summary: 'probe', body: 'probe body', author: 'claude1',
    }),
  })
  const body = await res.json() as Record<string, any>
  srv.close()

  let fail = 0
  const check = (label: string, ok: boolean, got?: unknown) => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — got ${JSON.stringify(got)}`}`)
    if (!ok) fail++
  }
  check('the report still SAVED despite the index failing', body?.ok === true, body)
  check('indexed reported false', body?.indexed === false, body?.indexed)
  check('exactly one notification raised', seen.length === 1, seen.length)
  check('severity warning (search degraded, record safe)', seen[0]?.severity === 'warning', seen[0]?.severity)
  check('source is reports-rag', seen[0]?.source === 'reports-rag', seen[0]?.source)
  check('detail names report, collection and cause',
    /emit-probe in \S+: .+/.test(String(seen[0]?.detail ?? '')), seen[0]?.detail)

  console.log(fail === 0 ? '\nALL PASS — the emitter survived the split.' : `\n${fail} FAILURE(S)`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
