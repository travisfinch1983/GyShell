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

// ProxLab local address — used for backend probes and model item baseUrl
const PROXLAB_LOCAL = 'http://10.0.0.140:7777'

// Browser-safe prefix — Vite proxy rewrites to PROXLAB_LOCAL
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

// ─── Cache ──────────────────────────────────────────────────────────────────

let discoveredModels: DiscoveredModel[] = []
let modelSlotMap = new Map<string, DiscoveredModel>()
let services: Partial<ProxlabServices> = {}
let embedModel: string | null = null
let rerankModel: string | null = null
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

/** Run full discovery cycle */
export async function discoverModels(): Promise<DiscoveredModel[]> {
  // Discover all in parallel
  const [llmModels, embed, rerank, svcData] = await Promise.all([
    discoverLlmModels(),
    discoverEmbedModel(),
    discoverRerankModel(),
    discoverServices(),
  ])

  // Update caches
  discoveredModels = llmModels
  modelSlotMap = new Map(llmModels.map(m => [m.id, m]))
  embedModel = embed
  rerankModel = rerank
  services = svcData

  // Log results
  console.log(`[ProxlabDiscovery] Discovered ${llmModels.length} LLM models`)
  for (const m of llmModels) {
    console.log(`  slot ${m.slot} (${m.node}): ${m.id}`)
  }
  if (embed) console.log(`[ProxlabDiscovery] Embeddings: ${embed}`)
  if (rerank) console.log(`[ProxlabDiscovery] Reranker: ${rerank}`)

  const svcSummary = Object.entries(svcData)
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k}:${(v as any[]).length}`)
    .join(', ')
  if (svcSummary) console.log(`[ProxlabDiscovery] Services: ${svcSummary}`)

  // Auto-register LLM models in GyShell settings
  autoRegisterModels(llmModels)

  return llmModels
}

// ─── Auto-registration ──────────────────────────────────────────────────────

function autoRegisterModels(models: DiscoveredModel[]) {
  const appStore = (window as any).__appStore
  const settings = appStore?.settings
  if (!settings?.models?.items) return

  const existingIds = new Set(settings.models.items.map((item: any) => item.model))
  let added = 0

  for (const model of models) {
    if (existingIds.has(model.id)) continue

    const friendlyName = model.id
      .replace(/^koboldcpp\//, '')
      .replace(/-UD-Q\d+_K(_XL)?(-\d+-of-\d+)?$/i, '')
      .replace(/\.Q\d+_K$/i, '')
      .replace(/-/g, ' ')

    const itemId = `proxlab-${model.id.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`

    settings.models.items.push({
      id: itemId,
      name: friendlyName,
      model: model.id,
      apiKey: 'not-needed',
      baseUrl: `${PROXLAB_LOCAL}/api/proxy/llm/${model.slot}/v1`,
      maxTokens: 200000,
      structuredOutputMode: 'auto',
      supportsStructuredOutput: true,
      supportsObjectToolChoice: false,
      _proxlabSlot: model.slot,
      _proxlabNode: model.node,
      _proxlabAutoDiscovered: true,
    })
    existingIds.add(model.id)
    added++
    console.log(`[ProxlabDiscovery] Auto-registered: ${friendlyName} (slot ${model.slot})`)
  }

  // Remove stale auto-discovered items
  const availableModelIds = new Set(models.map(m => m.id))
  const toRemove: number[] = []
  settings.models.items.forEach((item: any, idx: number) => {
    if (item._proxlabAutoDiscovered && !availableModelIds.has(item.model)) {
      toRemove.push(idx)
    }
  })
  for (const idx of toRemove.reverse()) {
    settings.models.items.splice(idx, 1)
  }

  if (added > 0 || toRemove.length > 0) {
    try { appStore.saveSettings?.() } catch {}
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
