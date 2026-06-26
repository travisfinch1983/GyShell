/**
 * Capability-based service-type detection. Instead of guessing from the model name, we ask the
 * endpoint what it actually serves: a cheap `/rerank` or `/v1/embeddings` POST succeeds only on a
 * server running that task (others reject with 4xx — no generation is triggered). Adapts across
 * engines (vLLM, TEI, Infinity, …) and re-classifies if a slot's model is swapped.
 *
 * Only disambiguates the ambiguous OpenAI-style bucket → 'llm' | 'embed' | 'rerank'. TTS/STT/image
 * stay provider-classified. Runs backend-side (rule #1). Results cached per endpoint (5 min).
 */
const cache = new Map<string, { type: string; ts: number }>()
const TTL = 300_000

async function getJson(url: string): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}
async function postOk(url: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    })
    return r.status >= 200 && r.status < 300
  } catch {
    return false
  }
}

export async function detectServiceType(endpoint: string): Promise<'llm' | 'embed' | 'rerank'> {
  const hit = cache.get(endpoint)
  if (hit && Date.now() - hit.ts < TTL) return hit.type as any
  const v1 = endpoint.replace(/\/+$/, '')
  const root = v1.replace(/\/v1$/, '')
  const models = await getJson(`${v1}/models`)
  const model = models?.data?.[0]?.id || 'model'

  let type: 'llm' | 'embed' | 'rerank' = 'llm'
  const rerankBody = { model, query: 'q', documents: ['a'] }
  if (
    (await postOk(`${root}/rerank`, rerankBody)) ||
    (await postOk(`${v1}/rerank`, rerankBody)) ||
    (await postOk(`${root}/v2/rerank`, rerankBody)) ||
    (await postOk(`${v1}/score`, { model, text_1: 'a', text_2: 'b' }))
  ) {
    type = 'rerank'
  } else if (await postOk(`${v1}/embeddings`, { model, input: 'probe' })) {
    type = 'embed'
  }
  cache.set(endpoint, { type, ts: Date.now() })
  return type
}

export async function detectServiceTypes(items: Array<{ id: string; endpoint?: string }>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    items.map(async (it) => {
      if (it.endpoint) out[it.id] = await detectServiceType(it.endpoint)
    }),
  )
  return out
}
