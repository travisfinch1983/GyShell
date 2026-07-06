/**
 * Native-tool gating from the AI-Lab MCP Gateway (config federation, stage 2).
 *
 * The agent's built-in tools are enabled/disabled from the gateway webui (the `ailab-native`
 * server) rather than a local setting. This fetches the gateway's per-tool enable state and
 * shapes it as the `Record<name, boolean>` that getEnabledBuiltInTools consumes (a tool is
 * excluded only when explicitly false; missing = enabled).
 *
 * FALLBACK IS ALL-ENABLED: on any gateway error we return the last-known map, or {} — never
 * an all-false map — so a gateway blip can't silently strip the agent's tools.
 */
const GATEWAY = (process.env.MCPJUNGLE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
const PREFIX = 'ailab-native__'

let cache: Record<string, boolean> = {}
let cachedAt = 0
const TTL_MS = 30_000

export async function getGatewayNativeToolEnabledMap(force = false): Promise<Record<string, boolean>> {
  if (!force && Date.now() - cachedAt < TTL_MS) return cache
  try {
    const r = await fetch(`${GATEWAY}/api/v0/tools?server=ailab-native`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`gateway tools -> ${r.status}`)
    const tools = (await r.json()) as Array<{ name?: string; enabled?: boolean }>
    const map: Record<string, boolean> = {}
    for (const t of tools) {
      if (typeof t.name === 'string' && t.name.startsWith(PREFIX)) {
        map[t.name.slice(PREFIX.length)] = t.enabled !== false
      }
    }
    // Only adopt a non-empty map; an empty result (e.g. ailab-native not registered yet) shouldn't
    // wipe a good cache — and empty means all-enabled anyway.
    if (Object.keys(map).length > 0) {
      cache = map
      cachedAt = Date.now()
    }
    return cache
  } catch {
    return cache // last-known (or {} = all-enabled) — never strip tools on a gateway blip
  }
}
