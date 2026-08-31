// Local vector store for the cluster inventory's semantic search.
//
// This replaces the stub that shipped with the ProxLab port ("vector-store
// stubbed (not migrated)") — /api/ai/inventory/search answered 200 [] for
// months while cluster_search handed agents confident empty answers
// (Observability Sweep finding, cluster-inventory:inventory-search-stub).
//
// Deliberately IN-PROCESS and file-backed rather than qdrant-backed: the
// consumer interface in inventory.js is synchronous for search/getAll (no
// await at the call sites), and the corpus is tiny (~200 entries across
// hosts/inventory/credentials), so brute-force cosine over an in-memory
// Float32Array beats a network hop and keeps credentials OUT of the shared
// vector DBs — the vault should not replicate into every memory backend.
//
// Persistence: vectors ride as base64 Float32 (4 bytes/dim vs ~20 as JSON
// floats), written atomically (tmp+rename) and debounced. Corrupt state loads
// through loadJsonState — copied aside and announced, never silently emptied.
import { writeFileSync, renameSync } from 'fs'
import * as fsForState from 'fs'
import { loadJsonState } from './notify.js'

const b64FromVec = (vec) => Buffer.from(new Float32Array(vec).buffer).toString('base64')
const vecFromB64 = (b64) => {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

/**
 * @param {object} opts
 * @param {string} opts.file        persisted state path
 * @param {string} opts.embedUrl    OpenAI-style embeddings endpoint
 * @param {() => string} opts.embedModel  resolved at CALL time (rag-models.json can change)
 */
export function createLocalVectorStore({ file, embedUrl, embedModel }) {
  // { config: {enabled}, collections: { [col]: { [id]: {v: b64, data, textHash, model} } } }
  const persisted = loadJsonState(fsForState, file, { config: { enabled: true }, collections: {} },
    { source: 'cluster-inventory', what: 'Inventory vector store' })
  const config = { enabled: true, ...(persisted.config || {}) }
  /** in-memory: [col][id] = { vec: Float32Array, data, textHash, model } */
  const cols = {}
  for (const [col, entries] of Object.entries(persisted.collections || {})) {
    cols[col] = {}
    for (const [id, e] of Object.entries(entries)) {
      try { cols[col][id] = { vec: vecFromB64(e.v), data: e.data, textHash: e.textHash, model: e.model } }
      catch { /* one undecodable entry re-embeds on next sync (its textHash is gone) */ }
    }
  }

  let saveTimer = null
  let lastSavedAt = persisted.collections && Object.keys(persisted.collections).length ? 'loaded' : ''
  function persist() {
    const out = { config, collections: {} }
    for (const [col, entries] of Object.entries(cols)) {
      out.collections[col] = {}
      for (const [id, e] of Object.entries(entries)) {
        out.collections[col][id] = { v: b64FromVec(e.vec), data: e.data, textHash: e.textHash, model: e.model }
      }
    }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(out))
    renameSync(tmp, file)
    lastSavedAt = new Date().toISOString()
  }
  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try { persist() } catch (e) { console.warn(`[inventory-vectors] persist failed (state is in memory only until the next write): ${e.message}`) }
    }, 2000)
  }

  return {
    async vectorize(texts) {
      const model = embedModel()
      const resp = await fetch(embedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts.map((t) => (t.length > 5000 ? t.slice(0, 5000) : t)) }),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`embed HTTP ${resp.status}: ${body.slice(0, 150)}`)
      }
      const data = await resp.json()
      const vecs = (data.data || []).map((d) => d.embedding)
      if (vecs.length !== texts.length) {
        // HTTP 200 with the wrong count is still a failure (unified-memory lesson).
        throw new Error(`embed returned ${vecs.length} vectors for ${texts.length} inputs`)
      }
      return vecs
    },

    upsert(col, id, vector, data, textHash) {
      if (!cols[col]) cols[col] = {}
      cols[col][id] = { vec: new Float32Array(vector), data, textHash, model: embedModel() }
      scheduleSave()
    },

    updateData(col, id, data) {
      const e = cols[col]?.[id]
      if (e) { e.data = data; scheduleSave() }
    },

    delete(col, id) {
      if (cols[col]?.[id]) { delete cols[col][id]; scheduleSave() }
    },

    getTextHash(col, id) { return cols[col]?.[id]?.textHash ?? null },
    clearTextHash(col, id) { const e = cols[col]?.[id]; if (e) { e.textHash = null; scheduleSave() } },

    /** Brute-force cosine, SYNC (the search route does not await this). */
    search(col, queryVector, limit = 5) {
      if (!config.enabled) return []
      const entries = cols[col]
      if (!entries) return []
      const qv = new Float32Array(queryVector)
      const scored = []
      for (const [id, e] of Object.entries(entries)) {
        // An entry embedded at a different dimensionality (encoder swap that
        // changed dims) cannot be compared — skip it rather than fake a score.
        if (e.vec.length !== qv.length) continue
        scored.push({ id, score: cosine(e.vec, qv), data: e.data })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, limit)
    },

    getAll(col) {
      return Object.entries(cols[col] || {}).map(([id, e]) => ({ id, data: e.data }))
    },

    getById(col, id) { return cols[col]?.[id]?.data ?? null },

    getConfig() { return { ...config } },
    updateConfig(c) {
      if (c && typeof c === 'object') {
        if (typeof c.enabled === 'boolean') config.enabled = c.enabled
        scheduleSave()
      }
      return { ...config }
    },

    getStats() {
      const perCollection = {}
      for (const [col, entries] of Object.entries(cols)) {
        const ids = Object.keys(entries)
        perCollection[col] = {
          vectorized: ids.length,
          dimension: ids.length ? entries[ids[0]].vec.length : 0,
        }
      }
      return { perCollection, lastSavedAt, embedModel: embedModel() }
    },

    /** test/ops hook: force an immediate flush. */
    _flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null } persist() },
  }
}
