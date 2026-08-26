/**
 * Load-balanced service pools for the universal embeddings + reranker endpoints.
 *
 * THE PROBLEM THIS SOLVES. The old embed cache mapped a model ID to ONE service:
 *     byModel.set(baseId, svc)   // first instance wins, forever
 * so running three copies of an embedding model sent every request to copy #1, and the only
 * way to reach the others was the decorated `model@2` / `model@3` alias. Rerank was worse --
 * it had no model routing at all, just "first reranker found". Per the proxy rework notes:
 *
 *   "Embeddings & reranker models can be automatically load balanced like the TTS providers
 *    are for instances using the same model. If say 3 copies of 1 embeddings model were
 *    running, and 2 copies of another, anything routing to the first model would be load
 *    balanced across those 3 copies, and anything routing to the 2nd model would be load
 *    balanced across those 2 copies."
 *
 * So a BARE model id now addresses a POOL and round-robins across it. The @N aliases are kept
 * (they are how you pin a specific instance for debugging or comparison), they just stop being
 * the only way to reach instances 2..N.
 *
 * Registration is implicit: the pool is rebuilt from the live service registry on a short TTL,
 * so bringing another copy online adds it to the rotation automatically, and stopping one
 * removes it -- no config step, matching "anytime another embeddings or reranker model is
 * brought online, it is automatically added to the proxy".
 */

const POOL_TTL_MS = 30_000
const PROBE_TIMEOUT_MS = 5_000

/** Consecutive-failure tracking so a dead instance drains out of rotation instead of eating
 *  1/N of all traffic until the next refresh. Keyed by ip:port. */
const FAIL_THRESHOLD = 3
const FAIL_COOLDOWN_MS = 30_000
const failures = new Map() // key -> { count, at }

const caches = new Map()   // type -> { models, byModel, pools, updatedAt }
const cursors = new Map()  // `${type}:${baseId}` -> rotating index

const keyOf = (svc) => `${svc.containerIp}:${svc.port}`

export function markFailure(svc) {
  if (!svc) return
  const k = keyOf(svc)
  const cur = failures.get(k) || { count: 0, at: 0 }
  failures.set(k, { count: cur.count + 1, at: Date.now() })
}

export function markSuccess(svc) {
  if (svc) failures.delete(keyOf(svc))
}

/** Is this instance currently benched for repeated failures? */
function isBenched(svc) {
  const f = failures.get(keyOf(svc))
  if (!f || f.count < FAIL_THRESHOLD) return false
  if (Date.now() - f.at > FAIL_COOLDOWN_MS) { failures.delete(keyOf(svc)); return false } // let it try again
  return true
}

/** Force the next refresh to refetch (called when services are registered/removed). */
export function invalidatePools() {
  for (const c of caches.values()) c.updatedAt = 0
}

/**
 * Rebuild the model -> instances mapping for one service type by querying each backend's
 * /v1/models. Returns { models, byModel, pools }:
 *   models  - aggregated list for GET /models, with @N decorations for duplicates
 *   byModel - EXACT id (including decorated `id@2`) -> a single service, for pinning
 *   pools   - BASE id -> [services], the round-robin rotation
 */
export async function refreshPool(type, findServicesByType) {
  const cached = caches.get(type)
  if (cached && Date.now() - cached.updatedAt < POOL_TTL_MS) return cached

  const services = findServicesByType(type)
  const raw = []

  await Promise.all(services.map(async (svc) => {
    const slot = svc.proxySlot || 0
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
      const resp = await fetch(`http://${svc.containerIp}:${svc.port}/v1/models`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!resp.ok) return
      const json = await resp.json()
      for (const m of (json.data || [])) {
        const id = (svc.aliasOverride && typeof svc.aliasOverride === 'string') ? svc.aliasOverride : m.id
        raw.push({ m: { ...m, id }, svc, slot })
      }
    } catch { /* an unreachable backend simply contributes nothing this cycle */ }
  }))

  raw.sort((a, b) => a.slot - b.slot)

  const byModel = new Map()
  const pools = new Map()
  const idCount = new Map()
  const models = []

  for (const { m, svc, slot } of raw) {
    const baseId = m.id
    const count = (idCount.get(baseId) || 0) + 1
    idCount.set(baseId, count)

    if (!pools.has(baseId)) pools.set(baseId, [])
    pools.get(baseId).push(svc)

    const enriched = { ...m, _proxlab_slot: slot, _proxlab_provider: svc.providerId }
    if (count === 1) {
      models.push(enriched)
      byModel.set(baseId, svc)          // exact-pin for the first instance
    } else {
      const decorated = `${baseId}@${count}`
      models.push({ ...enriched, id: decorated, _proxlab_base_id: baseId })
      byModel.set(decorated, svc)
    }
  }
  // `id@1` is a valid pin for the first instance when duplicates exist.
  for (const [baseId, total] of idCount) {
    if (total > 1) byModel.set(`${baseId}@1`, byModel.get(baseId))
  }
  // Advertise how many instances back each model so the UI can show the rotation size.
  for (const mdl of models) {
    const base = mdl._proxlab_base_id || mdl.id
    mdl._proxlab_instances = (pools.get(base) || []).length
  }

  const fresh = { models, byModel, pools, updatedAt: Date.now() }
  caches.set(type, fresh)
  return fresh
}

/**
 * Choose an instance for a requested model id.
 *
 * - a DECORATED id (`model@2`) pins that exact instance -- no balancing, that is the point of it
 * - a BARE id round-robins across every healthy instance serving it
 * - returns { svc, baseId } so the caller can rewrite the body back to the undecorated id
 */
export function pickInstance(type, cache, requestedId) {
  if (!requestedId) return { svc: null, baseId: null }

  const decorated = /@\d+$/.test(requestedId)
  if (decorated) {
    const svc = cache.byModel.get(requestedId) || null
    return { svc, baseId: svc ? requestedId.replace(/@\d+$/, '') : null }
  }

  const pool = cache.pools.get(requestedId)
  if (!pool || !pool.length) return { svc: null, baseId: null }

  const healthy = pool.filter((s) => !isBenched(s))
  const usable = healthy.length ? healthy : pool // all benched -> try anyway rather than 503
  const ck = `${type}:${requestedId}`
  const next = (cursors.get(ck) || 0) % usable.length
  cursors.set(ck, next + 1)
  return { svc: usable[next], baseId: requestedId, poolSize: usable.length }
}

/** Every instance serving a model, for diagnostics / the UI. */
export function poolFor(cache, baseId) {
  return cache.pools.get(baseId) || []
}
