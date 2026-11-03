/**
 * createSwrRefresher: one rebuild at a time, stale served while it runs, invalidation honoured.
 * Run: node packages/backend/src/services/Cluster/proxy/lib/swr-cache.extreme.spec.mjs
 */
import { createSwrRefresher, createSourceTimer } from './swr-cache.js'

let n = 0
const ok = (c, m) => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}
const quiet = { warn: () => {} }
const tick = () => new Promise((r) => setImmediate(r))

function rig({ ttl = 30_000, staleMax = 600_000 } = {}) {
  let t = 1_000_000
  let cache = { v: 0, updatedAt: 0 }
  let builds = 0
  let gate = null
  const now = () => t
  const build = async () => {
    builds++
    const myBuild = builds
    await new Promise((r) => { gate = r })
    cache = { v: myBuild, updatedAt: t }
    return cache
  }
  const refresh = createSwrRefresher({ name: 't', ttlMs: ttl, staleMaxMs: staleMax, getCache: () => cache, build, now, log: quiet })
  return {
    refresh, now,
    adv: (ms) => { t += ms },
    release: async () => { await tick(); gate?.(); await tick(); await tick() },
    get builds() { return builds }, get cache() { return cache }, set cache(c) { cache = c },
  }
}

// 1. cold cache: callers WAIT, and concurrent callers share one build
{
  const r = rig()
  const a = r.refresh(), b = r.refresh(), c = r.refresh()
  await r.release()
  const [x, y, z] = await Promise.all([a, b, c])
  ok(r.builds === 1, 'cold: 3 concurrent callers → 1 build')
  ok(x.v === 1 && y.v === 1 && z.v === 1, 'cold: all callers get the built cache')
}

// 2. fresh cache: no build
{
  const r = rig()
  const p = r.refresh(); await r.release(); await p
  r.adv(10_000)
  const c = await r.refresh()
  ok(r.builds === 1 && c.v === 1, 'fresh (<ttl): served from cache, no build')
}

// 3. stale cache: served IMMEDIATELY while one background build runs (the incident case)
{
  const r = rig()
  const p = r.refresh(); await r.release(); await p
  r.adv(31_000)
  let settled = 0
  const calls = Array.from({ length: 16 }, () => r.refresh().then((c) => { settled++; return c }))
  await tick(); await tick()
  ok(settled === 16, 'stale: 16 callers answered while the rebuild is still hanging')
  ok((await calls[0]).v === 1, 'stale: callers got the previous map')
  ok(r.builds === 2, 'stale: exactly one background rebuild for 16 callers')
  await r.release()
  ok(r.cache.v === 2, 'stale: background rebuild lands')
}

// 4. too old (> staleMax): wait for the rebuild
{
  const r = rig({ staleMax: 60_000 })
  const p = r.refresh(); await r.release(); await p
  r.adv(61_000)
  let settled = false
  const q = r.refresh().then((c) => { settled = true; return c })
  await tick(); await tick()
  ok(!settled, '>staleMax: caller waits')
  await r.release()
  ok((await q).v === 2, '>staleMax: caller gets the new map')
}

// 5. force (routing miss) waits, and joins a rebuild already running
{
  const r = rig()
  const p = r.refresh(); await r.release(); await p
  r.adv(31_000)
  r.refresh()                    // background rebuild starts
  const f = r.refresh({ force: true })
  await r.release()
  ok((await f).v === 2 && r.builds === 2, 'force: waits and shares the running rebuild')
}

// 6. invalidate() while a rebuild runs: the waiter gets a rebuild that STARTED after it
{
  const r = rig()
  const p = r.refresh(); await r.release(); await p
  r.adv(31_000)
  r.refresh()                    // build #2 in flight, predates the change
  r.refresh.invalidate(); r.cache = { ...r.cache, updatedAt: 0 }
  const w = r.refresh()
  await r.release()              // #2 finishes
  await r.release()              // follow-up #3 finishes
  ok((await w).v === 3 && r.builds === 3, 'invalidate: waiter is answered by the post-invalidate rebuild')
}

// 7. a throwing build keeps the previous cache and the next call retries
{
  let t = 0, calls = 0
  let cache = { v: 'old', updatedAt: 1 }
  const refresh = createSwrRefresher({
    name: 't', ttlMs: 10, staleMaxMs: 1e9, now: () => t, log: quiet,
    getCache: () => cache, build: async () => { calls++; throw new Error('boom') },
  })
  t = 100
  ok((await refresh({ force: true })).v === 'old', 'throwing build: previous cache returned')
  await tick()
  await refresh({ force: true })
  ok(calls === 2, 'throwing build: next call retries')
}

// 8. source timer names a slow source and rate-limits repeated failures
{
  let t = 0
  const lines = []
  const timed = createSourceTimer({ name: 'c', slowMs: 2000, errEveryMs: 600_000, now: () => t, log: { warn: (l) => lines.push(l) } })
  await timed('slowsvc', async () => { t += 2500; return 1 })
  ok(lines.some((l) => l.includes('slow source slowsvc: 2500ms')), 'timer: slow source logged by name')
  for (let i = 0; i < 5; i++) await timed('down', async () => { throw new Error('ECONNREFUSED') }).catch(() => {})
  ok(lines.filter((l) => l.includes('source down failed')).length === 1, 'timer: fast failure logged once per window')
  await timed('hang', async () => { t += 5000; const e = new Error('x'); e.name = 'TimeoutError'; throw e }).catch(() => {})
  ok(lines.some((l) => l.includes('hang failed in 5000ms: timed out')), 'timer: timeout reported with duration')
}

console.log(`swr-cache: ${n} checks passed`)
