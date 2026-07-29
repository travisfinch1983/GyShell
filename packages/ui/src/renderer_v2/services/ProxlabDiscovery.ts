import { runInAction } from 'mobx'
/**
 * ProxlabDiscovery — Auto-discover models and services from the AI-Lab proxy.
 * (Named for the ProxLab proxy it originally targeted; that host
 * is decommissioned and the Vite `/proxlab-api` route now rewrites to AI-Lab's
 * own universal proxy, which serves the same /api/proxy/* discovery shapes.)
 *
 * Discovers:
 * - LLM models (chat/completions) via /llm/v1/models
 * - Embedding models via /embed/v1/models
 * - Reranker models via /rerank/v1/models
 * - Service inventory via /services
 *
 * Auto-registers discovered LLM models in settings.
 */

// Browser-safe prefix — Vite proxy rewrites to the AI-Lab proxy (127.0.0.1:17890)
const API_PREFIX = '/proxlab-api'

const DISCOVERY_INTERVAL_MS = 300_000 // 5min (was 60s — polling every provider incl. dead TTS/STT from the browser was noisy + wasteful over the tunnel)

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredModel {
  id: string
  slot: number
  node: string
  provider: string
  ownedBy: string
  /**
   * Number of concurrent request slots the backend serves. Reflects
   * --parallel (llama-server) / --multiuser (KoboldCpp). Drives the agent
   * pool's per-profile concurrency lanes. Defaults to 1 when missing.
   */
  slots: number
}

export interface DiscoveredService {
  type: string        // llm, tts, stt, embed, rerank, image, etc.
  slot: number
  model: string
  node: string
  provider: string
  containerIp: string
  port: number
}

export interface ProxlabServices {
  llm: DiscoveredService[]
  tts: DiscoveredService[]
  stt: DiscoveredService[]
  embed: DiscoveredService[]
  rerank: DiscoveredService[]
  image: DiscoveredService[]
  imagegen: DiscoveredService[]
  external: DiscoveredService[]
  anthropic: DiscoveredService[]
}

export interface TtsProvider {
  slot: number
  providerId: string
  providerName: string
  node: string
  status: string
  capabilities: {
    openai_compatible: boolean
    voices: boolean
    models: boolean
    formats: string[]
  }
  voices: string[]
  models: string[]
}

export interface SttProvider {
  slot: number
  providerId: string
  providerName: string
  node: string
  status: string
  models: string[]
}

export interface RvcModel {
  name: string
  loaded: boolean
}

// ─── Cache ──────────────────────────────────────────────────────────────────

let discoveredModels: DiscoveredModel[] = []
let modelSlotMap = new Map<string, DiscoveredModel>()
let services: Partial<ProxlabServices> = {}
let embedModel: string | null = null
let rerankModel: string | null = null
let ttsProviders: TtsProvider[] = []
let sttProviders: SttProvider[] = []
let rvcModels: RvcModel[] = []
let discoveryTimer: ReturnType<typeof setInterval> | null = null

// ─── URL Helpers ────────────────────────────────────────────────────────────

/** Get the browser-safe API prefix (Vite proxy path) */
export function getProxlabApiBase(): string {
  return API_PREFIX
}

/** Get per-slot LLM endpoint URL for browser fetch */
export function getSlotEndpoint(slot: number): string {
  return `${API_PREFIX}/llm/${slot}/v1`
}

/** Get the universal embeddings endpoint */
export function getEmbedEndpoint(): string {
  return `${API_PREFIX}/embed/v1`
}

/** Get the universal reranker endpoint */
export function getRerankEndpoint(): string {
  return `${API_PREFIX}/rerank/v1`
}

/** Get the TTS endpoint (numbered slot) */
export function getTtsEndpoint(slot = 1): string {
  return `${API_PREFIX}/tts/${slot}`
}

/** Get the STT endpoint (numbered slot) */
export function getSttEndpoint(slot = 1): string {
  return `${API_PREFIX}/stt/${slot}`
}

/** Get the full services inventory endpoint */
export function getServicesEndpoint(): string {
  return `${API_PREFIX}/services`
}

// ─── Accessors ──────────────────────────────────────────────────────────────

export function getDiscoveredModel(modelId: string): DiscoveredModel | null {
  return modelSlotMap.get(modelId) || null
}

export function getDiscoveredModels(): DiscoveredModel[] {
  return [...discoveredModels]
}

export function getServices(): Partial<ProxlabServices> {
  return { ...services }
}

export function getEmbedModelId(): string | null {
  return embedModel
}

export function getRerankModelId(): string | null {
  return rerankModel
}

export function isServiceAvailable(type: keyof ProxlabServices): boolean {
  return (services[type]?.length ?? 0) > 0
}

export function getTtsProviders(): TtsProvider[] {
  return [...ttsProviders]
}

export function getSttProviders(): SttProvider[] {
  return [...sttProviders]
}

export function getRvcModels(): RvcModel[] {
  return [...rvcModels]
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** Discover LLM models from the universal proxy */
async function discoverLlmModels(): Promise<DiscoveredModel[]> {
  try {
    const resp = await fetch(`${API_PREFIX}/llm/v1/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return discoveredModels

    const data = await resp.json()
    return (data.data || []).map((m: any) => ({
      id: m.id,
      slot: m._proxlab_slot,
      node: m._proxlab_node || '',
      provider: m._proxlab_provider || m.owned_by || '',
      ownedBy: m.owned_by || '',
      slots: typeof m._proxlab_slots === 'number' && m._proxlab_slots > 0 ? m._proxlab_slots : 1,
    }))
  } catch {
    return discoveredModels
  }
}

/** Discover embedding model */
async function discoverEmbedModel(): Promise<string | null> {
  try {
    const resp = await fetch(`${API_PREFIX}/embed/v1/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const models = data.data || []
    return models.length > 0 ? models[0].id : null
  } catch {
    return null
  }
}

/** Discover reranker model */
async function discoverRerankModel(): Promise<string | null> {
  try {
    const resp = await fetch(`${API_PREFIX}/rerank/v1/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const models = data.data || []
    return models.length > 0 ? models[0].id : null
  } catch {
    return null
  }
}

/** Discover all service types from /services */
async function discoverServices(): Promise<Partial<ProxlabServices>> {
  try {
    const resp = await fetch(`${API_PREFIX}/services`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return services

    const data = await resp.json()
    const result: Partial<ProxlabServices> = {}

    for (const [type, svcs] of Object.entries(data)) {
      if (!Array.isArray(svcs)) continue
      result[type as keyof ProxlabServices] = svcs.map((svc: any) => ({
        type,
        slot: svc.slot || 0,
        model: svc.model || '',
        node: svc.node || '',
        provider: svc.providerName || svc.providerId || '',
        containerIp: svc.containerIp || '',
        port: svc.port || 0,
      }))
    }

    return result
  } catch {
    return services
  }
}

/** Discover TTS providers with their voices and models */
async function discoverTtsProviders(): Promise<TtsProvider[]> {
  try {
    const resp = await fetch(`${API_PREFIX}/tts/v1/providers`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return ttsProviders
    const data = await resp.json()
    const providers: TtsProvider[] = []

    for (const p of data.providers || []) {
      let voices: string[] = []
      let models: string[] = []
      const caps = p.capabilities || {}

      // Only fetch voices/models from providers that support them
      if (caps.voices) {
        try {
          const vResp = await fetch(`${API_PREFIX}/tts/v1/providers/${p.slot}/voices`, {
            signal: AbortSignal.timeout(3000),
          })
          if (vResp.ok) {
            const vData = await vResp.json()
            voices = (vData.voices || []).map((v: any) => typeof v === 'string' ? v : v.id || v.name || '')
          }
        } catch {}
      }

      if (caps.models) {
        try {
          const mResp = await fetch(`${API_PREFIX}/tts/v1/providers/${p.slot}/models`, {
            signal: AbortSignal.timeout(3000),
          })
          if (mResp.ok) {
            const mData = await mResp.json()
            models = (mData.data || []).map((m: any) => m.id || '')
          }
        } catch {}
      }

      providers.push({
        slot: p.slot,
        providerId: p.providerId || '',
        providerName: p.providerName || p.providerId || '',
        node: p.node || '',
        status: p.status || 'unknown',
        capabilities: p.capabilities || { openai_compatible: false, voices: false, models: false, formats: [] },
        voices,
        models,
      })
    }
    return providers
  } catch {
    return ttsProviders
  }
}

/** Discover STT providers with their models */
async function discoverSttProviders(): Promise<SttProvider[]> {
  try {
    const resp = await fetch(`${API_PREFIX}/stt/v1/providers`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return sttProviders
    const data = await resp.json()
    const providers: SttProvider[] = []

    for (const p of data.providers || []) {
      let models: string[] = []
      try {
        const mResp = await fetch(`${API_PREFIX}/stt/v1/providers/${p.slot}/models`, {
          signal: AbortSignal.timeout(3000),
        })
        if (mResp.ok) {
          const mData = await mResp.json()
          models = (mData.data || []).map((m: any) => m.id || '')
        }
      } catch {}

      providers.push({
        slot: p.slot,
        providerId: p.providerId || '',
        providerName: p.providerName || p.providerId || '',
        node: p.node || '',
        status: p.status || 'unknown',
        models,
      })
    }
    return providers
  } catch {
    return sttProviders
  }
}

/** Discover RVC voice models via ProxLab proxy (never direct HTTP — avoids mixed content) */
async function discoverRvcModels(svcData: Partial<ProxlabServices>): Promise<RvcModel[]> {
  const ttsSvcs = svcData.tts || []
  const rvcSvcs = ttsSvcs.filter(s => s.provider.toLowerCase().includes('rvc'))

  if (rvcSvcs.length === 0) return rvcModels

  const svc = rvcSvcs[0]
  // Always go through the Vite proxy — direct HTTP is blocked on HTTPS pages
  try {
    const proxyResp = await fetch(`${API_PREFIX}/tts/${svc.slot}/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!proxyResp.ok) return rvcModels
    const data = await proxyResp.json()
    return (data.models || []).map((m: any) => ({
      name: m.name || '',
      loaded: m.loaded || false,
    }))
  } catch {
    return rvcModels
  }
}

/** Run full discovery cycle */
export async function discoverModels(): Promise<DiscoveredModel[]> {
  // Rule #1: the browser makes ZERO connections. On the WEB the backend runs the discovery
  // loop + owns connection status; we just read its cached snapshot over the ONE gateway RPC.
  // In Electron (trusted desktop, no gateway `discovery` bridge) we aggregate locally.
  const gw = (window as any).gyshell?.discovery
  let llmModels: DiscoveredModel[]
  let embed: string | null
  let rerank: string | null
  let svcData: Partial<ProxlabServices>
  let tts: TtsProvider[]
  let stt: SttProvider[]
  let rvc: RvcModel[]
  if (gw?.get) {
    let agg: any = null
    try { agg = await gw.get() } catch (e) { console.warn('[ProxlabDiscovery] gateway discovery:get failed', e) }
    if (!agg) return discoveredModels // keep current caches; never fall back to browser fetches on web
    llmModels = agg.models || []
    embed = agg.embedModel ?? null
    rerank = agg.rerankModel ?? null
    svcData = agg.services || {}
    tts = agg.ttsProviders || []
    stt = agg.sttProviders || []
    rvc = agg.rvcModels || []
  } else {
    ;[llmModels, embed, rerank, svcData, tts, stt] = await Promise.all([
      discoverLlmModels(),
      discoverEmbedModel(),
      discoverRerankModel(),
      discoverServices(),
      discoverTtsProviders(),
      discoverSttProviders(),
    ])
    rvc = await discoverRvcModels(svcData)
  }

  // Update caches
  discoveredModels = llmModels
  modelSlotMap = new Map(llmModels.map(m => [m.id, m]))
  embedModel = embed
  rerankModel = rerank
  services = svcData
  ttsProviders = tts
  sttProviders = stt
  rvcModels = rvc

  // One concise line (the full per-model dump was console spam on every load).
  const ttsVoices = tts.reduce((sum, p) => sum + p.voices.length, 0)
  console.log(`[ProxlabDiscovery] ${llmModels.length} LLM${embed ? ' +embed' : ''}${rerank ? ' +rerank' : ''} | tts:${tts.length}(${ttsVoices}v) stt:${stt.length} rvc:${rvc.length}`)

  // Sync discovered LLM models into settings.models.items so they appear
  // in profile role dropdowns. Marked with _proxlabAutoDiscovered so the
  // "External Model Connections" UI list filters them out.
  syncModelsToSettings(llmModels)

  return llmModels
}

/**
 * Sync discovered models into GyShell settings for profile dropdown population.
 * Adds new models, removes stale ones. Does not touch user-created items.
 */
/**
 * The previous implementation keyed auto-discovered items by `proxlab-${slot}`
 * and only marked stale entries as `_proxlabDisconnected` rather than
 * removing them. Slot numbers get reused as services rotate, which produced
 * duplicate ids in the items array — the dropdown's React key collapsed them
 * silently and clicking option N triggered the FIRST item sharing its key.
 *
 * Fix: derive a stable id from the discovered model's API id (the actual
 * served-model name, which is unique per service), keep an index of
 * discovered ids, and HARD-DELETE stale auto-discovered entries when
 * discovery returns a non-empty result. When discovery is empty (proxy
 * down), we leave entries as-is so user-assigned profiles don't break.
 */
function syncModelsToSettings(models: DiscoveredModel[]) {
  const appStore = (window as any).__appStore
  const settings = appStore?.settings
  if (!settings?.models?.items) return

  // Stable id derived from the API model id — guaranteed unique per service.
  // We sanitize it so it's safe as a settings key.
  const stableId = (modelId: string) => `proxlab:${modelId}`

  const discoveredById = new Map<string, DiscoveredModel>()
  for (const m of models) discoveredById.set(stableId(m.id), m)

  runInAction(() => {
    // Hard-delete stale auto-discovered items when discovery produced results.
    // (If discovery returned empty, the proxy is probably down — keep entries
    // so saved profile assignments still resolve when it comes back.)
    if (models.length > 0) {
      settings.models.items = settings.models.items.filter((item: any) => {
        if (!item._proxlabAutoDiscovered) return true
        return discoveredById.has(item.id)
      })
    }

    const existingByStableId = new Map<string, number>()
    settings.models.items.forEach((item: any, idx: number) => {
      if (item._proxlabAutoDiscovered) existingByStableId.set(item.id, idx)
    })

    // Upsert: update existing entries, insert new ones, skip ids the user has
    // a manual entry for already.
    for (const m of models) {
      const id = stableId(m.id)
      const existingIdx = existingByStableId.get(id)
      if (existingIdx !== undefined) {
        const cur = settings.models.items[existingIdx]
        cur._proxlabSlot = m.slot
        cur._proxlabSlots = m.slots
        cur._proxlabNode = m.node
        cur._proxlabDisconnected = false
        // Refresh baseUrl — the backend (CT152) reaches its own proxy on localhost.
        // (Was the old ProxLab host until 2026-07-03; it is gone now.)
        cur.baseUrl = `http://127.0.0.1:17890/api/proxy/llm/${m.slot}/v1`
        continue
      }
      // Don't shadow a user's manual entry pointing at the same model.
      if (settings.models.items.some((i: any) => i.model === m.id && !i._proxlabAutoDiscovered)) continue

      const friendlyName = m.id
        .replace(/^koboldcpp\//, '')
        .replace(/-UD-Q\d+_K(_XL)?(-\d+-of-\d+)?$/i, '')
        .replace(/\.Q\d+_K$/i, '')
        .replace(/-/g, ' ')

      settings.models.items.push({
        id,
        name: friendlyName,
        model: m.id,
        apiKey: 'not-needed',
        baseUrl: `http://127.0.0.1:17890/api/proxy/llm/${m.slot}/v1`,
        maxTokens: 200000,
        structuredOutputMode: 'auto',
        supportsStructuredOutput: true,
        supportsObjectToolChoice: false,
        _proxlabSlot: m.slot,
        _proxlabNode: m.node,
        _proxlabSlots: m.slots,
        _proxlabAutoDiscovered: true,
        _proxlabDisconnected: false,
      })
    }

    // If discovery is empty, mark surviving auto-discovered items as
    // disconnected for UI feedback but leave them in place.
    if (models.length === 0) {
      for (const item of settings.models.items) {
        if (item._proxlabAutoDiscovered) item._proxlabDisconnected = true
      }
    }
  })
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function startDiscovery(): void {
  // No browser-side loop (rule #1). One snapshot on load; the SERVER keeps its cache fresh
  // (5-min server loop) and owns connection status. Callers re-invoke discoverModels() on
  // demand (e.g. opening the model/TTS settings) — a single gateway RPC, never a browser fetch.
  void discoverModels()
}

export function stopDiscovery(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer)
    discoveryTimer = null
  }
}
