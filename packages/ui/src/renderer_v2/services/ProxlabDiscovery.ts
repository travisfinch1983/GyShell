/**
 * ProxlabDiscovery — Auto-discover models and services from ProxLab proxy.
 *
 * Discovers:
 * - LLM models (chat/completions) via /llm/v1/models
 * - Embedding models via /embed/v1/models
 * - Reranker models via /rerank/v1/models
 * - Service inventory via /services
 *
 * The ProxLab URL is hardcoded and accessed via Vite proxy (/proxlab-api/*).
 * Auto-registers discovered LLM models in GyShell settings.
 */

// Browser-safe prefix — Vite proxy rewrites to http://10.0.0.140:7777
const API_PREFIX = '/proxlab-api'

const DISCOVERY_INTERVAL_MS = 60_000 // 60s

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredModel {
  id: string
  slot: number
  node: string
  provider: string
  ownedBy: string
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

      // Fetch voices and models for each provider
      try {
        const vResp = await fetch(`${API_PREFIX}/tts/v1/providers/${p.slot}/voices`, {
          signal: AbortSignal.timeout(3000),
        })
        if (vResp.ok) {
          const vData = await vResp.json()
          voices = (vData.voices || []).map((v: any) => typeof v === 'string' ? v : v.id || v.name || '')
        }
      } catch {}

      try {
        const mResp = await fetch(`${API_PREFIX}/tts/v1/providers/${p.slot}/models`, {
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
  // Discover all in parallel
  const [llmModels, embed, rerank, svcData, tts, stt] = await Promise.all([
    discoverLlmModels(),
    discoverEmbedModel(),
    discoverRerankModel(),
    discoverServices(),
    discoverTtsProviders(),
    discoverSttProviders(),
  ])

  // Discover RVC models (needs services data, so runs after)
  const rvc = await discoverRvcModels(svcData)

  // Update caches
  discoveredModels = llmModels
  modelSlotMap = new Map(llmModels.map(m => [m.id, m]))
  embedModel = embed
  rerankModel = rerank
  services = svcData
  ttsProviders = tts
  sttProviders = stt
  rvcModels = rvc

  // Log results
  console.log(`[ProxlabDiscovery] Discovered ${llmModels.length} LLM models`)
  for (const m of llmModels) {
    console.log(`  slot ${m.slot} (${m.node}): ${m.id}`)
  }
  if (embed) console.log(`[ProxlabDiscovery] Embeddings: ${embed}`)
  if (rerank) console.log(`[ProxlabDiscovery] Reranker: ${rerank}`)
  if (tts.length) console.log(`[ProxlabDiscovery] TTS: ${tts.length} providers, ${tts.reduce((s, p) => s + p.voices.length, 0)} voices`)
  if (stt.length) console.log(`[ProxlabDiscovery] STT: ${stt.length} providers`)
  if (rvc.length) console.log(`[ProxlabDiscovery] RVC: ${rvc.length} voice models`)

  const svcSummary = Object.entries(svcData)
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k}:${(v as any[]).length}`)
    .join(', ')
  if (svcSummary) console.log(`[ProxlabDiscovery] Services: ${svcSummary}`)

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
function syncModelsToSettings(models: DiscoveredModel[]) {
  const appStore = (window as any).__appStore
  const settings = appStore?.settings
  if (!settings?.models?.items) return

  const availableIds = new Set(models.map(m => m.id))
  const existingProxlab = new Map<string, number>()

  // Index existing auto-discovered items
  settings.models.items.forEach((item: any, idx: number) => {
    if (item._proxlabAutoDiscovered) {
      existingProxlab.set(item.model, idx)
    }
  })

  // Add new models
  for (const model of models) {
    if (existingProxlab.has(model.id)) {
      // Update slot if changed
      const idx = existingProxlab.get(model.id)!
      settings.models.items[idx]._proxlabSlot = model.slot
      continue
    }

    // Skip if user already has a manual entry for this model
    if (settings.models.items.some((item: any) => item.model === model.id && !item._proxlabAutoDiscovered)) {
      continue
    }

    const friendlyName = model.id
      .replace(/^koboldcpp\//, '')
      .replace(/-UD-Q\d+_K(_XL)?(-\d+-of-\d+)?$/i, '')
      .replace(/\.Q\d+_K$/i, '')
      .replace(/-/g, ' ')

    settings.models.items.push({
      id: `proxlab-${model.slot}`,
      name: friendlyName,
      model: model.id,
      apiKey: 'not-needed',
      baseUrl: `http://10.0.0.140:7777/api/proxy/llm/${model.slot}/v1`,
      maxTokens: 200000,
      structuredOutputMode: 'auto',
      supportsStructuredOutput: true,
      supportsObjectToolChoice: false,
      _proxlabSlot: model.slot,
      _proxlabNode: model.node,
      _proxlabAutoDiscovered: true,
    })
  }

  // Mark stale auto-discovered items as disconnected (don't remove — profile may reference them)
  // Only remove if a full discovery returned results and this model wasn't in it
  if (models.length > 0) {
    for (const item of settings.models.items) {
      if (item._proxlabAutoDiscovered) {
        item._proxlabDisconnected = !availableIds.has(item.model)
      }
    }
  } else {
    // Discovery returned empty — mark all as disconnected but keep them
    for (const item of settings.models.items) {
      if (item._proxlabAutoDiscovered) {
        item._proxlabDisconnected = true
      }
    }
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function startDiscovery(): void {
  if (discoveryTimer) return
  discoverModels()
  discoveryTimer = setInterval(discoverModels, DISCOVERY_INTERVAL_MS)
  console.log(`[ProxlabDiscovery] Started (refresh every ${DISCOVERY_INTERVAL_MS / 1000}s)`)
}

export function stopDiscovery(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer)
    discoveryTimer = null
  }
}
