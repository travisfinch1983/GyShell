/**
 * Pages store spec: append-only versioning, markdown→HTML at write time,
 * restore-as-new-version, move-to-trash delete.
 * Run: tsx packages/backend/src/services/Cluster/pagesStore.extreme.spec.ts
 */
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
// @ts-expect-error — express ships untyped in this repo
import express from 'express'
import { createPagesRouter } from './pagesHttp'

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(msg)
}

const dataDir = mkdtempSync(join(tmpdir(), 'pages-spec-'))
const app = express()
app.use(createPagesRouter(dataDir))
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

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))

  // First write creates the page at version 1, converting markdown at write time.
  let r = await call('PUT', '/api/pages/spec-page', {
    title: 'Spec Page', contentType: 'markdown', body: '# Heading\n\nSENTINEL_ONE', author: 'spec',
  })
  assert(r.status === 200 && r.json.version === 1, `first write -> v1 (${JSON.stringify(r.json)})`)

  r = await call('GET', '/api/pages/spec-page')
  assert(r.json.html.includes('<h1>') && r.json.html.includes('SENTINEL_ONE'), 'markdown converted at write')
  assert(r.json.source.startsWith('# Heading'), 'markdown source preserved')

  // Second write appends — version 1 remains readable (append-only).
  r = await call('PUT', '/api/pages/spec-page', {
    title: 'Spec Page v2', contentType: 'html', body: '<p>SENTINEL_TWO</p>',
  })
  assert(r.json.version === 2, 'second write -> v2')
  r = await call('GET', '/api/pages/spec-page?version=1')
  assert(r.json.html.includes('SENTINEL_ONE'), 'v1 still readable after v2')
  r = await call('GET', '/api/pages/spec-page')
  assert(r.json.html.includes('SENTINEL_TWO') && r.json.meta.currentVersion === 2, 'latest is v2')

  // Restore copies forward as a NEW version and records provenance.
  r = await call('POST', '/api/pages/spec-page/restore', { version: 1 })
  assert(r.json.version === 3 && r.json.restoredFrom === 1, 'restore appends v3 from v1')
  r = await call('GET', '/api/pages/spec-page')
  assert(r.json.html.includes('SENTINEL_ONE'), 'restored content is live')
  const v3 = r.json.meta.versions.find((v: any) => v.version === 3)
  assert(v3.restoredFrom === 1, 'restore provenance recorded in history')

  // List carries counts, not version arrays.
  r = await call('GET', '/api/pages')
  assert(r.json.pages.length === 1 && r.json.pages[0].versionCount === 3, 'list shows one page, 3 versions')

  // Delete is a move to .trash, never an unlink.
  r = await call('DELETE', '/api/pages/spec-page')
  assert(r.json.ok === true, 'delete ok')
  assert(!existsSync(join(dataDir, 'pages', 'spec-page')), 'page dir gone from live store')
  const trash = readdirSync(join(dataDir, 'pages', '.trash'))
  assert(trash.some((d) => d.startsWith('spec-page-')), 'page recoverable from .trash')

  // Bad ids and bad bodies are refusals, not crashes.
  r = await call('PUT', '/api/pages/../evil', { title: 'x', contentType: 'html', body: 'x' })
  assert(r.status === 400 || r.status === 404, 'path traversal id refused')
  r = await call('PUT', '/api/pages/ok-id', { title: '', contentType: 'html', body: 'x' })
  assert(r.status === 400, 'empty title refused')

  server.close()
  console.log('pagesStore.extreme.spec: all assertions passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
