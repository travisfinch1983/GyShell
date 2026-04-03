/**
 * ProxlabDiscovery — Auto-discover models from ProxLab's universal LLM proxy.
 *
 * Fetches the aggregated model list, caches slot mappings, and auto-registers
 * discovered models in GyShell's settings so they appear in profile dropdowns.
 *
 * The ProxLab URL is hardcoded (rewritten for browser via Vite proxy).
 * Only the model-to-role assignment in profiles requires user configuration.
 */

// ProxLab local address — Vite proxy rewrites /proxlab-api/* to this
const PROXLAB_LOCAL = 'http://10.0.0.140:7777'
const PROXLAB_API_PREFIX = '/proxlab-api'
const DISCOVERY_INTERVAL_MS = 60_000 // Re-discover every 60s
const MODELS_ENDPOINT = '/llm/v1/models'

export interface DiscoveredModel {
  id: string            // e.g. "koboldcpp/Qwen3.5-122B-A10B-UD-Q6_K_XL-00001-of-00004"
  slot: number          // ProxLab slot number for per-slot routing
  node: string          // e.g. "px-gpu", "epyc-px"
  provider: string      // e.g. "koboldcpp"
  ownedBy: string       // from OpenAI models response
}

/** Cached discovery results */
let discoveredModels: DiscoveredModel[] = []
let modelSlotMap = new Map<string, DiscoveredModel>()
let discoveryTimer: ReturnType<typeof setInterval> | null = null

/**
 * Get the browser-safe API base URL.
 * When on HTTPS (Cloudflare tunnel), uses the Vite proxy path.
 * When on HTTP (local dev), hits ProxLab directly.
 */
export function getProxlabApiBase(): string {
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return PROXLAB_API_PREFIX
  }
  // On local HTTP, the Vite proxy also works (and avoids CORS)
  return PROXLAB_API_PREFIX
}

/**
 * Get the per-slot chat completions URL for a model.
 * Uses the Vite proxy path for browser-safe same-origin requests.
 */
export function getSlotEndpoint(slot: number): string {
  return `${getProxlabApiBase()}/llm/${slot}/v1`
}

/**
 * Look up a discovered model by its ID.
 */
export function getDiscoveredModel(modelId: string): DiscoveredModel | null {
  return modelSlotMap.get(modelId) || null
}

/**
 * Get all discovered models.
 */
export function getDiscoveredModels(): DiscoveredModel[] {
  return [...discoveredModels]
}

/**
 * Fetch the model list from ProxLab and update the cache.
 * Also auto-registers new models in GyShell settings.
 */
export async function discoverModels(): Promise<DiscoveredModel[]> {
  const url = `${getProxlabApiBase()}${MODELS_ENDPOINT}`

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })

    if (!resp.ok) {
      console.warn(`[ProxlabDiscovery] Failed to fetch models: ${resp.status}`)
      return discoveredModels
    }

    const data = await resp.json()
    const models: DiscoveredModel[] = (data.data || []).map((m: any) => ({
      id: m.id,
      slot: m._proxlab_slot,
      node: m._proxlab_node || '',
      provider: m._proxlab_provider || m.owned_by || '',
      ownedBy: m.owned_by || '',
    }))

    // Update cache
    discoveredModels = models
    modelSlotMap = new Map(models.map(m => [m.id, m]))
    console.log(`[ProxlabDiscovery] Discovered ${models.length} models:`)
    for (const m of models) {
      console.log(`  slot ${m.slot} (${m.node}): ${m.id}`)
    }

    // Auto-register in GyShell settings
    autoRegisterModels(models)

    return models
  } catch (err) {
    console.warn(`[ProxlabDiscovery] Discovery error:`, err)
    return discoveredModels
  }
}

/**
 * Auto-register discovered models in GyShell's settings.
 * Creates model items for any models not already in settings.
 * Does NOT modify existing items (preserves user customizations).
 */
function autoRegisterModels(models: DiscoveredModel[]) {
  const appStore = (window as any).__appStore
  const settings = appStore?.settings
  if (!settings?.models?.items) return

  const existingIds = new Set(settings.models.items.map((item: any) => item.model))
  let added = 0

  for (const model of models) {
    if (existingIds.has(model.id)) continue

    // Generate a human-friendly name from the model ID
    const friendlyName = model.id
      .replace(/^koboldcpp\//, '')
      .replace(/-UD-Q\d+_K(_XL)?(-\d+-of-\d+)?$/i, '')
      .replace(/\.Q\d+_K$/i, '')
      .replace(/-/g, ' ')

    // Generate a stable item ID from the model ID
    const itemId = `proxlab-${model.id.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`

    const newItem = {
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
    }

    settings.models.items.push(newItem)
    existingIds.add(model.id)
    added++
    console.log(`[ProxlabDiscovery] Auto-registered: ${friendlyName} (slot ${model.slot})`)
  }

  // Remove auto-discovered items that are no longer available
  const availableModelIds = new Set(models.map(m => m.id))
  const toRemove: number[] = []
  settings.models.items.forEach((item: any, idx: number) => {
    if (item._proxlabAutoDiscovered && !availableModelIds.has(item.model)) {
      toRemove.push(idx)
      console.log(`[ProxlabDiscovery] Removing stale: ${item.name}`)
    }
  })
  // Remove in reverse order to preserve indices
  for (const idx of toRemove.reverse()) {
    settings.models.items.splice(idx, 1)
  }

  if (added > 0 || toRemove.length > 0) {
    // Trigger settings save
    try {
      appStore.saveSettings?.()
    } catch {}
  }
}

/**
 * Start periodic model discovery.
 * Call once during app bootstrap.
 */
export function startDiscovery(): void {
  if (discoveryTimer) return

  // Initial discovery
  discoverModels()

  // Periodic refresh
  discoveryTimer = setInterval(() => {
    discoverModels()
  }, DISCOVERY_INTERVAL_MS)

  console.log(`[ProxlabDiscovery] Started (refresh every ${DISCOVERY_INTERVAL_MS / 1000}s)`)
}

/**
 * Stop periodic discovery.
 */
export function stopDiscovery(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer)
    discoveryTimer = null
  }
}
