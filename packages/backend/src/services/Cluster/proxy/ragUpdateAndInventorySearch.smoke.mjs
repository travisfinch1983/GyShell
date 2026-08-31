// Codebase-RAG update + inventory semantic search — the two features that ended
// the sweep's last standing "capability that looks present but is not" pair.
// Run: node packages/backend/src/services/Cluster/proxy/ragUpdateAndInventorySearch.smoke.mjs
//
// Everything runs against the REAL modules with only the two seams stubbed:
// `exec` (the ssh shim registerRagRoutes receives) and global fetch. History
// this spec pins: runRagUpdate was undefined and CRASHED the backend nightly
// 2026-08-16→20, then was guard-skipped ("queued work silently discarded")
// until 2026-08-31; inventory search was a stub answering 200 [] since the
// ProxLab port.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let n = 0
const ok = (cond, msg) => {
  if (!cond) { console.error('FAILED:', msg); process.exit(1) }
  n++; console.log('  ok —', msg)
}
const until = async (fn, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)) }
  return false
}

// Deterministic fake embeddings: direction keyed on the text's leading token so
// similar texts align and different ones don't. Dim 8 keeps files small.
const DIM = 8
function fakeVec(text) {
  const v = new Array(DIM).fill(0.01)
  let h = 0
  for (const c of String(text).slice(0, 24)) h = (h * 31 + c.charCodeAt(0)) % DIM
  v[h] = 1
  return v
}

const dataDir = mkdtempSync(join(tmpdir(), 'inv-rag-spec-'))
process.env.AILAB_PROXY_DATA_DIR = dataDir
process.env.AILAB_PROXY_PORT = '0'

// ── global fetch stub: embed + vector routes + notifications, all captured ──
const calls = []
let embedCalls = 0
let failVectorDelete = false
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = (opts.method || 'GET').toUpperCase()
  calls.push({ url: u, method })
  const respond = (obj, status = 200) => ({
    ok: status < 400, status,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  })
  if (u.includes('/api/proxy/embed/')) {
    embedCalls++
    const body = JSON.parse(opts.body)
    return respond({ data: body.input.map(t => ({ embedding: fakeVec(t) })) })
  }
  if (u.includes('/api/notifications/emit')) return respond({ ok: true })
  if (u.includes('/api/proxy/vector/all/collections')) {
    if (method === 'DELETE' && failVectorDelete) return respond({ error: 'down' }, 500)
    return respond({ ok: true })
  }
  return respond({}, 404)
}

async function main() {
  // ════ Part A: localVectorStore directly ════
  const { createLocalVectorStore } = await import('./lib/localVectorStore.js')
  const storeFile = join(dataDir, 'store-a.json')
  let model = 'model-A'
  const store = createLocalVectorStore({
    file: storeFile,
    embedUrl: 'http://embed.test/api/proxy/embed/v1/embeddings',
    embedModel: () => model,
  })
  const texts = ['gpu server with eight V100s', 'nas storage box', 'router appliance']
  const vecs = await store.vectorize(texts)
  ok(vecs.length === 3 && vecs[0].length === DIM, 'vectorize returns one vector per input')
  texts.forEach((t, i) => store.upsert('inv', `id${i}`, vecs[i], { name: t }, `h${i}`))

  const [qv] = await store.vectorize(['gpu server with eight V100s'])
  const hits = store.search('inv', qv, 2)
  ok(hits[0]?.id === 'id0' && hits[0].score > 0.99, 'search ranks the matching entry first (sync, no await)')
  const [qv2] = await store.vectorize(['zzz nonsense query'])
  ok(store.search('inv', qv2, 1)[0]?.score < 0.99,
    'negative control: an unrelated query does NOT produce a perfect score')

  store.upsert('inv', 'wrongdim', new Array(DIM + 4).fill(0.5), { name: 'mismatch' }, 'hx')
  ok(!store.search('inv', qv, 10).some(h => h.id === 'wrongdim'),
    'an entry with a different dimensionality is SKIPPED, never faked into a score')

  // HTTP 200 with the wrong vector count must throw (unified-memory lesson)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' })
  let threw = false
  try { await store.vectorize(['a', 'b']) } catch { threw = true }
  globalThis.fetch = realFetch
  ok(threw, '200-with-wrong-count from the embedder THROWS instead of returning short')

  store._flush()
  const reloaded = createLocalVectorStore({ file: storeFile, embedUrl: 'http://embed.test/x', embedModel: () => model })
  ok(reloaded.search('inv', qv, 1)[0]?.id === 'id0', 'persisted vectors survive a reload (base64 round-trip)')
  ok(reloaded.getTextHash('inv', 'id1') === 'h1', 'text hashes survive the reload too')

  writeFileSync(join(dataDir, 'store-corrupt.json'), '{not json')
  const corrupt = createLocalVectorStore({ file: join(dataDir, 'store-corrupt.json'), embedUrl: 'http://x', embedModel: () => model })
  ok(corrupt.getAll('inv').length === 0 && readdirSync(dataDir).some(f => f.startsWith('store-corrupt.json.corrupt-')),
    'corrupt state file: store starts empty AND the bytes are preserved aside (loadJsonState contract)')

  store.updateConfig({ enabled: false })
  ok(store.search('inv', qv, 5).length === 0, 'disabled store answers [] — and the config round-trips')
  store.updateConfig({ enabled: true })

  // ════ Part B: inventory routes end to end (revectorize → search) ════
  writeFileSync(join(dataDir, 'inventory.json'), JSON.stringify({
    entries: [
      { id: 'ct-101', name: 'ai-gpu', description: 'gpu compute node', tags: ['gpu'] },
      { id: 'ct-102', name: 'nas-box', description: 'storage host', tags: [] },
    ], scanConfig: { enabled: false }, version: 1,
  }))
  writeFileSync(join(dataDir, 'hosts.json'), JSON.stringify({ entries: [{ id: 'h1', name: 'px-gpu' }] }))
  writeFileSync(join(dataDir, 'credentials.json'), JSON.stringify({ entries: [] }))
  writeFileSync(join(dataDir, 'rag-models.json'), JSON.stringify({ embedModel: 'model-A' }))

  const inv = await import('./inventory.js')
  const { invRouter } = inv.createInventoryRouter(null)
  // An express Router IS a middleware function — invoke it directly.
  const invoke = (method, path, body = {}) => new Promise((resolve) => {
    const req = { method: method.toUpperCase(), url: path, originalUrl: path, body, params: {}, query: {}, headers: {} }
    const res = {
      _status: 200,
      status(c) { this._status = c; return this },
      json(payload) { resolve({ status: this._status, body: payload }) },
    }
    invRouter(req, res, () => resolve({ status: 404, body: { error: 'no route' } }))
  })

  const revec = await invoke('POST', '/revectorize')
  ok(revec.body?.status === 'started', 'POST /revectorize accepts')
  ok(await until(() => embedCalls >= 2), 'revectorize embeds the seeded entries (inventory + hosts)')
  await new Promise(r => setTimeout(r, 200))

  const search = await invoke('POST', '/search', { query: 'gpu compute node', limit: 3 })
  ok(Array.isArray(search.body.results) && search.body.results.length > 0,
    'THE HEADLINE: /search returns real results — the stub era of confident 200 [] is over')
  ok(search.body.results[0]?.data?.name === 'ai-gpu' || search.body.results[0]?.data?.id === 'ct-101',
    'the gpu query ranks the gpu entry first across collections')
  ok(search.body.coverage && search.body.coverage.proxlab_inventory?.vectorized === 2,
    'coverage travels IN the response — a consumer can see what was actually searchable')

  // model swap invalidates every entry even though no text changed (FP8 lesson)
  writeFileSync(join(dataDir, 'rag-models.json'), JSON.stringify({ embedModel: 'model-B' }))
  const before = embedCalls
  await invoke('POST', '/revectorize')
  ok(await until(() => embedCalls > before), 'after an embed-MODEL swap, revectorize re-embeds entries whose text never changed')

  // ════ Part C: runRagUpdate through the real queue ════
  const FILE1 = 'src/alpha.js'
  const FILE2 = 'src/beta.py'
  const manifestWrites = []
  const makeExec = ({ cloneOk = true }) => async (_host, cmd) => {
    if (cmd.includes('collections.json') && cmd.startsWith('cat')) {
      // Production manifests store the SANITIZED name (phase 5 writes colName)
      return { stdout: JSON.stringify([{ name: 'codebase_demo', repo_url: 'http://git.test/demo.git', branch: 'default', description: 'demo repo' }]) }
    }
    if (cmd.includes('git clone')) return { stdout: cloneOk ? '__CLONE_OK__' : 'fatal: repo not found' }
    if (cmd.startsWith('find ')) {
      const tmp = cmd.match(/"([^"]+)"/)?.[1] ?? '/tmp/x'
      return { stdout: `${tmp}/${FILE1}\n${tmp}/${FILE2}\n` }
    }
    if (cmd.includes('===FILE_START===')) {
      return { stdout: `===FILE_START===${FILE1}===\nconst alpha = 1\n===FILE_END===\n===FILE_START===${FILE2}===\nbeta = 2\n===FILE_END===\n` }
    }
    if (cmd.includes('collections.json') && cmd.includes('node -e')) { manifestWrites.push(cmd); return { stdout: 'manifest updated' } }
    return { stdout: '' }  // checkpoints, rm/mv, mkdir — accepted silently
  }

  const routes = {}
  const app = {
    use: () => {},
    get: (p, h) => { routes[`GET ${p}`] = h },
    post: (p, ...hs) => { routes[`POST ${p}`] = hs[hs.length - 1] },
    delete: (p, h) => { routes[`DELETE ${p}`] = h },
    put: (p, h) => { routes[`PUT ${p}`] = h },
  }
  const rag = await import('./rag.js')
  rag.registerRagRoutes(app, { exec: makeExec({ cloneOk: true }), selfPort: 0 })

  const call = (key, body = {}) => new Promise((resolve) => {
    routes[key]({ body, params: {}, query: {} }, {
      _s: 200, status(c) { this._s = c; return this }, json(p) { resolve({ status: this._s, body: p }) },
    })
  })

  calls.length = 0
  const ua = await call('POST /api/ai/rag/update-all')
  ok(ua.body.queued === 1 && ua.body.willRun === true,
    'update-all now answers willRun:true — the honesty flag flipped itself the day the handler landed')

  ok(await until(() => calls.some(c => c.method === 'POST' && c.url.includes('/collections/codebase_demo/upsert'))),
    'the queued update re-indexes into the SAME collection (sanitize is idempotent — no codebase_codebase_ twin)')
  const delIdx = calls.findIndex(c => c.method === 'DELETE' && c.url.includes('/collections/codebase_demo'))
  const upsertIdx = calls.findIndex(c => c.method === 'POST' && c.url.includes('/collections/codebase_demo/upsert'))
  ok(delIdx !== -1 && delIdx < upsertIdx,
    'REPLACE semantics: the old vectors are deleted BEFORE re-indexing (stale chunks of deleted files cannot linger)')
  ok(await until(() => manifestWrites.length > 0), 'the collection manifest is refreshed after the run')
  ok(!calls.some(c => c.url.includes('/api/notifications/emit')),
    'a clean refresh emits NOTHING (silent-clean rule)')

  // failure path: clone fails after the delete — the warning must name the collection
  const rag2 = await import('./rag.js?fail=1').catch(() => null)
  // (module cache: same instance is fine — fresh registration = fresh queue state)
  rag.registerRagRoutes(app, { exec: makeExec({ cloneOk: false }), selfPort: 0 })
  calls.length = 0
  const ua2 = await call('POST /api/ai/rag/update-all')
  ok(ua2.body.queued === 1, 'failure scenario queues')
  ok(await until(() => calls.some(c => c.url.includes('/api/notifications/emit'))),
    'a FAILED refresh emits a warning instead of vanishing (the old lane was silent for weeks)')
  void rag2

  console.log(`\n${n} assertions passed`)
  process.exit(0)  // registerRagRoutes starts queue-watcher intervals
}

main().catch((e) => { console.error('SPEC CRASHED:', e); process.exit(1) })
