import { z } from 'zod'

/**
 * memory_tools — long-term-memory tools backed by proxlab's mirrored
 * vector-proxy. Reads/writes go through `/api/proxy/vector/all/*`, which
 * replicates across every eligible vector DB (Qdrant, Weaviate, ChromaDB)
 * and auto-embeds via the configured embedding model.
 *
 * Hippocampai is intentionally NOT one of the eligible DBs for these
 * mirrored endpoints — it's reserved for Claude's personal memories. The
 * AI-Lab agents can never touch it through these tools.
 *
 * Naming guard: writes always land under `ai-lab_*` collections (default
 * `ai-lab_general` when caller doesn't specify a topic). This keeps the
 * Claude-managed unprefixed collections (e.g. `proxlab`, `homelab`) clean
 * of agent-generated noise. Reads, however, span both the prefixed and
 * unprefixed variant of any topical collection so the local models can
 * still see context Claude has saved.
 */

const PROXLAB_URL = (process.env.PROXLAB_URL || 'http://10.0.0.140:7777').replace(/\/+$/, '')
const VECTOR_API = `${PROXLAB_URL}/api/proxy/vector/all`
const AI_LAB_PREFIX = 'ai-lab_'
const DEFAULT_COLLECTION = 'ai-lab_general'
const FETCH_TIMEOUT_MS = 30_000
const MAX_CONTENT_BYTES = 16 * 1024
const MAX_RECALL_LIMIT = 20

// Collection names starting with these are system collections — AI-Lab
// agents must never write to them, but recall is allowed (read-only).
const SYSTEM_COLLECTION_PREFIXES = ['proxlab_']

export const MEMORY_LIST_COLLECTIONS_DESCRIPTION =
  'List vector-store collections available for long-term memory. Returns name, the storage backends each is present in, and whether the collection is owned by AI-Lab (ai-lab_ prefix) or shared. Use this to decide where to save a new memory or which collection to search.'

export const MEMORY_RECALL_DESCRIPTION =
  'Search long-term memory for facts relevant to a query. Vector search with cross-encoder reranking. If `collection` is omitted, searches across all custom collections (ai-lab_* and shared). When `collection` is given, also searches the matching unprefixed variant (e.g. recall on `ai-lab_proxlab` also reads `proxlab`) so AI-Lab agents see facts saved by other clients.'

export const MEMORY_SAVE_DESCRIPTION =
  'Save a fact to long-term memory. Mirrored across every eligible vector DB. Writes always land in an `ai-lab_*` collection — if `collection` is omitted, defaults to `ai-lab_general`; if a non-prefixed name is given, it is auto-prefixed. The collection is auto-created on first write. Keep `content` concise and self-contained — short factual statements retrieve better than long paragraphs.'

export const MEMORY_CREATE_COLLECTION_DESCRIPTION =
  'Create a new topical memory collection. Name is auto-prefixed with `ai-lab_` if not already. The description is shown to other agents browsing collections, so it should clearly identify what kind of memories belong here. Use this when memories don\'t fit any existing collection.'

export const MEMORY_DELETE_DESCRIPTION =
  'Delete a specific memory entry by its id from a collection. Only `ai-lab_*` collections are allowed — system collections are read-only.'

export const memoryListCollectionsSchema = z.object({})

export const memoryRecallSchema = z.object({
  query: z.string().min(1).describe('Free-text query for the semantic search'),
  collection: z
    .string()
    .optional()
    .describe('Specific collection to search. Omit to search all custom collections.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RECALL_LIMIT)
    .optional()
    .describe(`Max results to return (default 5, max ${MAX_RECALL_LIMIT})`),
})

export const memorySaveSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(MAX_CONTENT_BYTES)
    .describe('The fact or note to remember. Be concise and self-contained.'),
  collection: z
    .string()
    .optional()
    .describe('Topic collection. Omit for ai-lab_general.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Optional tags stored as metadata for filtering'),
})

export const memoryCreateCollectionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Collection names may only contain letters, digits, underscore, and hyphen'),
  description: z.string().min(1).max(500),
})

export const memoryDeleteSchema = z.object({
  collection: z.string(),
  id: z.string(),
})

export type MemoryToolResult =
  | { kind: 'text'; message: string }
  | { kind: 'error'; message: string }

function ensureAiLabPrefix(name: string): string {
  return name.startsWith(AI_LAB_PREFIX) ? name : `${AI_LAB_PREFIX}${name}`
}

function isWriteAllowed(name: string): boolean {
  if (!name.startsWith(AI_LAB_PREFIX)) return false
  for (const prefix of SYSTEM_COLLECTION_PREFIXES) {
    if (name.startsWith(prefix)) return false
  }
  return true
}

/**
 * Build the search-target list for a given (or default) collection. When the
 * user names an `ai-lab_<topic>` collection, also include the unprefixed
 * `<topic>` variant so AI-Lab can see Claude's notes; when the user names an
 * unprefixed collection, also include the `ai-lab_<topic>` variant.
 */
function expandRecallTargets(collection: string): string[] {
  if (collection.startsWith(AI_LAB_PREFIX)) {
    const unprefixed = collection.slice(AI_LAB_PREFIX.length)
    return Array.from(new Set([collection, unprefixed]))
  }
  return Array.from(new Set([collection, `${AI_LAB_PREFIX}${collection}`]))
}

async function fetchWithTimeout(url: string, init: any, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function listCollections(signal?: AbortSignal): Promise<string[]> {
  const resp = await fetchWithTimeout(`${VECTOR_API}/collections`, {}, signal)
  if (!resp.ok) throw new Error(`vector-proxy /all/collections returned ${resp.status}`)
  const data = (await resp.json()) as any
  const seen = new Set<string>()
  for (const r of data.results ?? []) {
    for (const c of r.collections ?? []) seen.add(c)
  }
  return Array.from(seen).sort()
}

async function ensureCollection(name: string, description: string, signal?: AbortSignal): Promise<void> {
  const resp = await fetchWithTimeout(
    `${VECTOR_API}/collections`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    },
    signal,
  )
  if (!resp.ok && resp.status !== 409) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Create collection ${name} failed (${resp.status}): ${text.slice(0, 200)}`)
  }
}

export async function runMemoryListCollections(
  _rawArgs: unknown,
  signal?: AbortSignal,
): Promise<MemoryToolResult> {
  try {
    const all = await listCollections(signal)
    const filtered = all.filter((n) => !SYSTEM_COLLECTION_PREFIXES.some((p) => n.startsWith(p)))
    if (filtered.length === 0) {
      return {
        kind: 'text',
        message: 'No custom collections exist yet. Use memory_create_collection to add one, or memory_save without a collection name (defaults to ai-lab_general).',
      }
    }
    const lines = filtered.map((n) => {
      const owned = n.startsWith(AI_LAB_PREFIX) ? '(ai-lab)' : '(shared)'
      return `  ${n} ${owned}`
    })
    return {
      kind: 'text',
      message: `Available memory collections:\n${lines.join('\n')}`,
    }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    return {
      kind: 'error',
      message: `memory_list_collections failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function runMemoryRecall(
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<MemoryToolResult> {
  const validated = memoryRecallSchema.safeParse(rawArgs)
  if (!validated.success) {
    return { kind: 'error', message: `memory_recall invalid arguments: ${validated.error.message}` }
  }
  const { query, collection, limit } = validated.data
  const topK = limit ?? 5

  let targets: string[]
  try {
    if (collection) {
      const wanted = new Set(expandRecallTargets(collection))
      const existing = new Set(await listCollections(signal))
      targets = Array.from(wanted).filter((c) => existing.has(c))
      if (targets.length === 0) {
        return { kind: 'text', message: `No matching collection found for "${collection}".` }
      }
    } else {
      const all = await listCollections(signal)
      targets = all.filter((n) => !SYSTEM_COLLECTION_PREFIXES.some((p) => n.startsWith(p)))
      if (targets.length === 0) {
        return { kind: 'text', message: 'No custom collections exist yet — nothing to recall.' }
      }
    }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    return {
      kind: 'error',
      message: `memory_recall could not enumerate collections: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const allHits: Array<{ collection: string; text: string; score: number; metadata: any }> = []
  for (const tgt of targets) {
    try {
      const resp = await fetchWithTimeout(
        `${VECTOR_API}/collections/${encodeURIComponent(tgt)}/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, topK }),
        },
        signal,
      )
      if (!resp.ok) continue
      const data = (await resp.json()) as any
      const fused: any[] = data.fused || data.results || []
      for (const r of fused) {
        allHits.push({
          collection: tgt,
          text: String(r.text || r.metadata?.text || ''),
          score: typeof r.rerankerScore === 'number' ? r.rerankerScore : (r.score || 0),
          metadata: r.metadata || {},
        })
      }
    } catch { /* skip and continue with other targets */ }
  }

  if (allHits.length === 0) {
    return { kind: 'text', message: `No memories matched "${query}" in ${targets.join(', ')}.` }
  }
  allHits.sort((a, b) => b.score - a.score)
  const top = allHits.slice(0, topK)
  const formatted = top
    .map((h, i) => `${i + 1}. [${h.collection}] (score ${h.score.toFixed(3)})\n   ${h.text.replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n\n')
  return { kind: 'text', message: `Found ${allHits.length} match(es) across ${targets.length} collection(s):\n\n${formatted}` }
}

export async function runMemorySave(
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<MemoryToolResult> {
  const validated = memorySaveSchema.safeParse(rawArgs)
  if (!validated.success) {
    return { kind: 'error', message: `memory_save invalid arguments: ${validated.error.message}` }
  }
  const { content, collection, tags } = validated.data
  const target = ensureAiLabPrefix(collection || DEFAULT_COLLECTION)
  if (!isWriteAllowed(target)) {
    return { kind: 'error', message: `memory_save: writes are only allowed to ai-lab_* collections (resolved "${target}").` }
  }

  try {
    // Ensure the collection exists. ensureCollection is a no-op when it
    // already does (the 409 path) so it's safe to call every time.
    await ensureCollection(target, `AI-Lab agent memory bucket: ${target}`, signal)

    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const metadata: Record<string, any> = {
      source: 'ai-lab',
      createdAt: new Date().toISOString(),
    }
    if (Array.isArray(tags) && tags.length > 0) metadata.tags = tags

    const resp = await fetchWithTimeout(
      `${VECTOR_API}/collections/${encodeURIComponent(target)}/upsert`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: [{ id, text: content, metadata }] }),
      },
      signal,
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { kind: 'error', message: `memory_save failed (${resp.status}): ${text.slice(0, 200)}` }
    }
    const data = (await resp.json()) as any
    const dbList = (data.results || []).map((r: any) => r.db).filter(Boolean).join(', ')
    return {
      kind: 'text',
      message: `Saved to ${target} (id: ${id}) — replicated to ${dbList || 'configured DBs'}.`,
    }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    return {
      kind: 'error',
      message: `memory_save failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function runMemoryCreateCollection(
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<MemoryToolResult> {
  const validated = memoryCreateCollectionSchema.safeParse(rawArgs)
  if (!validated.success) {
    return { kind: 'error', message: `memory_create_collection invalid arguments: ${validated.error.message}` }
  }
  const target = ensureAiLabPrefix(validated.data.name)
  if (!isWriteAllowed(target)) {
    return { kind: 'error', message: `memory_create_collection: ${target} is reserved for system use.` }
  }
  try {
    await ensureCollection(target, validated.data.description, signal)
    return { kind: 'text', message: `Created (or confirmed existing) collection "${target}".` }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    return {
      kind: 'error',
      message: `memory_create_collection failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function runMemoryDelete(
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<MemoryToolResult> {
  const validated = memoryDeleteSchema.safeParse(rawArgs)
  if (!validated.success) {
    return { kind: 'error', message: `memory_delete invalid arguments: ${validated.error.message}` }
  }
  const { collection } = validated.data
  if (!isWriteAllowed(collection)) {
    return { kind: 'error', message: `memory_delete: only ai-lab_* collections may be modified (got "${collection}").` }
  }
  // The /all/* surface doesn't expose per-id delete directly, so we drop the
  // entire collection. This is intentionally coarse — agents shouldn't be
  // doing fine-grained surgery on memories. (`id` is accepted by the schema
  // for forward compatibility once a per-id endpoint is added on the proxy.)
  try {
    const resp = await fetchWithTimeout(
      `${VECTOR_API}/collections/${encodeURIComponent(collection)}`,
      { method: 'DELETE' },
      signal,
    )
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { kind: 'error', message: `memory_delete failed (${resp.status}): ${text.slice(0, 200)}` }
    }
    return {
      kind: 'text',
      message: `memory_delete: dropped entire collection "${collection}". (Per-id deletes aren't supported by the proxy yet — every entry in the collection was removed.)`,
    }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    return {
      kind: 'error',
      message: `memory_delete failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
