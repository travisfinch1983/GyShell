/**
 * discovery-service — SERVER-SIDE model/service discovery (core rule #1: the browser
 * makes zero connections; the server owns the discovery loop + connection status).
 *
 * Runs the loop the browser used to run, but against THIS backend's own universal proxy
 * on loopback (127.0.0.1:17890/api/proxy/*) — no CORS, no tunnel, no browser involvement.
 * The UI reads the cached snapshot via the `discovery:get` gateway RPC: one call, on demand.
 */

const PROXY_BASE = process.env.DISCOVERY_PROXY_BASE || 'http://127.0.0.1:17890/api/proxy'
const REFRESH_MS = 5 * 60_000

type Any = Record<string, any>

export interface DiscoverySnapshot {
  models: Any[]
  embedModel: string | null
  rerankModel: string | null
  services: Any
  ttsProviders: Any[]
  sttProviders: Any[]
  rvcModels: Any[]
  updatedAt: number
}

let cache: DiscoverySnapshot = {
  models: [], embedModel: null, rerankModel: null, services: {},
  ttsProviders: [], sttProviders: [], rvcModels: [], updatedAt: 0,
}
let timer: ReturnType<typeof setInterval> | null = null
let inflight: Promise<DiscoverySnapshot> | null = null

async function j(path: string, timeoutMs: number): Promise<any | null> {
  try {
    const r = await fetch(`${PROXY_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

async function discoverLlm(): Promise<Any[]> {
  const d = await j('/llm/v1/models', 10000)
  return (d?.data || []).map((m: Any) => ({
    id: m.id,
    slot: m._proxlab_slot,
    node: m._proxlab_node || '',
    provider: m._proxlab_provider || m.owned_by || '',
    ownedBy: m.owned_by || '',
    slots: typeof m._proxlab_slots === 'number' && m._proxlab_slots > 0 ? m._proxlab_slots : 1,
  }))
}

async function discoverFirst(path: string): Promise<string | null> {
  const d = await j(path, 5000)
  const models = d?.data || []
  return models.length ? models[0].id : null
}

async function discoverServices(): Promise<Any> {
  const d = await j('/services', 5000)
  if (!d) return {}
  const out: Any = {}
  for (const [type, svcs] of Object.entries(d)) {
    if (!Array.isArray(svcs)) continue
    out[type] = (svcs as Any[]).map((s: Any) => ({
      type, slot: s.slot || 0, model: s.model || '', node: s.node || '',
      provider: s.providerName || s.providerId || '', containerIp: s.containerIp || '', port: s.port || 0,
    }))
  }
  return out
}

async function discoverTts(): Promise<Any[]> {
  const d = await j('/tts/v1/providers', 5000)
  if (!d) return []
  const out: Any[] = []
  for (const p of d.providers || []) {
    const caps = p.capabilities || {}
    // Only poll sub-resources of providers that are actually up. A SUSPENDED service (or one
    // down for any reason) reports status !== 'healthy', so we skip its voices/models fetch —
    // no more 502 spam — and it rejoins automatically the moment it's healthy again (resumed).
    const live = p.status === 'healthy'
    let voices: string[] = []
    let models: string[] = []
    if (live && caps.voices) {
      const v = await j(`/tts/v1/providers/${p.slot}/voices`, 3000)
      voices = (v?.voices || []).map((x: Any) => (typeof x === 'string' ? x : x.id || x.name || ''))
    }
    if (live && caps.models) {
      const m = await j(`/tts/v1/providers/${p.slot}/models`, 3000)
      models = (m?.data || []).map((x: Any) => x.id || '')
    }
    out.push({
      slot: p.slot, providerId: p.providerId || '', providerName: p.providerName || p.providerId || '',
      node: p.node || '', status: p.status || 'unknown',
      capabilities: p.capabilities || { openai_compatible: false, voices: false, models: false, formats: [] },
      voices, models,
    })
  }
  return out
}

async function discoverStt(): Promise<Any[]> {
  const d = await j('/stt/v1/providers', 5000)
  if (!d) return []
  const out: Any[] = []
  for (const p of d.providers || []) {
    const m = p.status === 'healthy' ? await j(`/stt/v1/providers/${p.slot}/models`, 3000) : null
    out.push({
      slot: p.slot, providerId: p.providerId || '', providerName: p.providerName || p.providerId || '',
      node: p.node || '', status: p.status || 'unknown',
      models: (m?.data || []).map((x: Any) => x.id || ''),
    })
  }
  return out
}

async function discoverRvc(services: Any): Promise<Any[]> {
  const rvc = (services.tts || []).filter((s: Any) => String(s.provider).toLowerCase().includes('rvc'))
  if (!rvc.length) return []
  const d = await j(`/tts/${rvc[0].slot}/models`, 5000)
  return (d?.models || []).map((m: Any) => ({ name: m.name || '', loaded: m.loaded || false }))
}

async function refresh(): Promise<DiscoverySnapshot> {
  if (inflight) return inflight
  inflight = (async () => {
    const [models, embedModel, rerankModel, services, ttsProviders, sttProviders] = await Promise.all([
      discoverLlm(),
      discoverFirst('/embed/v1/models'),
      discoverFirst('/rerank/v1/models'),
      discoverServices(),
      discoverTts(),
      discoverStt(),
    ])
    const rvcModels = await discoverRvc(services)
    cache = { models, embedModel, rerankModel, services, ttsProviders, sttProviders, rvcModels, updatedAt: Date.now() }
    return cache
  })().finally(() => { inflight = null })
  return inflight
}

export const discoveryService = {
  start(): void {
    if (timer) return
    // Delay the first pass so the loopback universal proxy (:17890) is serving.
    setTimeout(() => void refresh(), 5000)
    timer = setInterval(() => void refresh(), REFRESH_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  },
  stop(): void {
    if (timer) { clearInterval(timer); timer = null }
  },
  /** Cached snapshot; refreshes in the background (awaited) if the cache is stale/empty. */
  async get(): Promise<DiscoverySnapshot> {
    const age = Date.now() - cache.updatedAt
    const stale = !cache.updatedAt || age > REFRESH_MS
    const emptyAndSettled = cache.models.length === 0 && age > 15_000
    if (stale || emptyAndSettled) {
      try { return await refresh() } catch { return cache }
    }
    return cache
  },
}
