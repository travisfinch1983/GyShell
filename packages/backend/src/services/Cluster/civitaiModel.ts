/**
 * Server-side CivitAI model fetch for the Review browser. ProxLab's UI hit civitai.com directly
 * from the browser; AI-Lab proxies it backend-side (rule #1 — no browser→external data fetches).
 * Returns the raw CivitAI model JSON (modelVersions[] → files, images, baseModel, creator, tags).
 */
const cache = new Map<string, { data: any; ts: number }>()
const TTL = 120_000

/** Extract the numeric modelId + optional ?modelVersionId from a pasted civitai.com / civitai.red URL or bare id. */
export function parseCivitaiUrl(input: string): { modelId: string; versionId?: string } | null {
  const s = (input || '').trim()
  if (/^\d+$/.test(s)) return { modelId: s }
  const m = s.match(/\/models\/(\d+)/)
  if (!m) return null
  const vid = s.match(/[?&]modelVersionId=(\d+)/)
  return { modelId: m[1], versionId: vid?.[1] }
}

export async function fetchCivitaiModel(modelId: string, token?: string): Promise<any> {
  const hit = cache.get(modelId)
  if (hit && Date.now() - hit.ts < TTL) return hit.data
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(`https://civitai.com/api/v1/models/${modelId}`, { headers, signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`CivitAI returned ${r.status} for model ${modelId}`)
  const data = await r.json()
  cache.set(modelId, { data, ts: Date.now() })
  return data
}
