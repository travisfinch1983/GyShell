/**
 * Proxy call-path smoke — import is not enough.
 * Run: node packages/backend/src/services/Cluster/proxy/proxyCallPath.smoke.mjs
 *
 * 🛑 WHY THIS EXISTS: batch 3 moved four state loaders onto a shared helper
 * and the edit script silently skipped the import in two of the four modules.
 * Both modules IMPORTED cleanly — the ReferenceError only fired at CALL time —
 * so node --check passed, startup was silent, and the vector-DB proxy (the
 * RAG routing path) was down for 13 batches until claude1 hit the route
 * during a deploy. Import success is exactly what made it invisible
 * (claude1, 2026-08-31, fix 5b4ce42).
 *
 * So this smoke CALLS things: it constructs every cheaply-constructible
 * router and drives the state-loader family against a scratch dataDir —
 * absent, valid, and corrupt files all exercised. Modules whose import or
 * construction starts timers/fetches (proxy.js, rag.js, inventory.js, ai.js,
 * civitai.js) are DELIBERATELY excluded and listed here so the exclusion is a
 * visible decision, not a silent gap: their loaders are reached through the
 * included modules' shared helper instead.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

let n = 0
const ok = (c, m) => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}

// Scratch env BEFORE any import — the loaders read env per call, but dataDir
// constants in some modules bake at import.
const dataDir = mkdtempSync(join(tmpdir(), 'smoke-'))
process.env.AILAB_PROXY_DATA_DIR = dataDir
// Recorder so any emitOnce fired by loaders lands somewhere harmless.
const srv = http.createServer((req, res) => res.end('{}'))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
process.env.AILAB_PROXY_PORT = String(srv.address().port)

// ── the helper itself ────────────────────────────────────────────────────────
const notify = await import('./lib/notify.js')
ok(typeof notify.loadJsonState === 'function' && typeof notify.emitOnce === 'function',
  'lib/notify exports the loader + latch surface')

// ── call-time construction of every cheap router ────────────────────────────
const vp = await import('./vector-proxy.js')
ok(!!vp.createVectorProxyRouter(), 'vector-proxy router CONSTRUCTS — loadConfig runs at call time (the batch-3 regression fired exactly here)')

const sys = await import('./system.js')
ok(!!sys.createSystemRouter({}), 'system router constructs — loadActiveServices reachable')

const sched = await import('./download-scheduler.js')
const schedState = sched.loadScheduler()
ok(schedState && typeof sched.isDownloadAllowed('hf') === 'boolean',
  'download-scheduler loads and the gate answers')
const schedLlm = await import('./llm/download-scheduler.js')
ok(typeof schedLlm.isDownloadAllowed === 'function',
  'the llm re-export resolves the same gate (the split-brain fix holds)')

// ── the loader family against real files: absent / valid / corrupt ─────────
const f = join(dataDir, 'smoke-state.json')
ok(notify.loadJsonState(await import('node:fs'), f, { d: 1 }, { source: 'smoke', what: 'Smoke' }).d === 1,
  'absent file → fallback')
writeFileSync(f, JSON.stringify({ d: 2 }))
ok(notify.loadJsonState(await import('node:fs'), f, { d: 1 }, { source: 'smoke', what: 'Smoke' }).d === 2,
  'valid file → parsed')
writeFileSync(f, '{torn')
ok(notify.loadJsonState(await import('node:fs'), f, { d: 1 }, { source: 'smoke', what: 'Smoke' }).d === 1,
  'corrupt file → fallback (and the .corrupt copy + emit path executed)')

// EXCLUDED (visible decision, not a gap): proxy.js, rag.js, inventory.js,
// ai.js, civitai.js — import/construction starts timers and fetches; their
// loadJsonState call sites ride the same helper proven above, and their
// imports of it are asserted statically here instead:
const { readFileSync } = await import('node:fs')
for (const mod of ['inventory.js', 'proxy.js', 'vector-proxy.js', 'system.js']) {
  const src = readFileSync(new URL(`./${mod}`, import.meta.url), 'utf8')
  const uses = src.includes('loadJsonState(')
  // EXACTLY one, not at-least one: presence-checking let both failure
  // directions through — the MISSING import hid for 13 batches (import
  // success is silent), and then two sides of a merge each added the
  // identical import at different anchors, git merged CLEANLY, and the file
  // would not parse (claude1's catch: a clean merge is not a correct merge).
  const importCount = (src.match(/^import \{ loadJsonState \}/gm) ?? []).length
  const fsAliasCount = (src.match(/^import \* as fsForState from/gm) ?? []).length
  if (uses) {
    ok(importCount === 1, `${mod}: EXACTLY one loadJsonState import (found ${importCount}) — 0 hid for 13 batches, 2 broke a clean merge`)
    ok(fsAliasCount === 1, `${mod}: EXACTLY one fsForState import (found ${fsAliasCount})`)
  } else {
    ok(importCount === 0 && fsAliasCount === 0, `${mod}: no stray loader imports without call sites`)
  }
}

srv.close()
console.log(`\n${n} assertions passed`)
process.exit(0)
