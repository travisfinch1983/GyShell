/**
 * Vector Database Proxy
 *
 * Routes requests to configured vector databases through a unified endpoint.
 * Similar to the LLM proxy, but connections are manually configured in settings
 * since vector DBs run on separate containers (not AI agent containers).
 *
 * Endpoints:
 *   GET  /api/proxy/vector/list              — List available vector DBs
 *   ALL  /api/proxy/vector/:name/*           — Proxy to named vector DB
 *
 * Settings (data/vector-db-config.json):
 *   [{ name: "milvus", type: "milvus", host: "10.0.0.138", port: 19530, ... }]
 */

import { Router, json as jsonParser } from 'express';
import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import * as fsForState from 'fs';
import { loadJsonState } from './lib/notify.js';

const CONFIG_FILE = join(process.env.AILAB_PROXY_DATA_DIR || join(process.cwd(), 'data'), 'vector-db-config.json');

function loadConfig() {
  return loadJsonState(fsForState, CONFIG_FILE, [],
    { source: 'vector-proxy', what: 'Vector-DB configuration' });
}

function saveConfig(dbs) {
  mkdirSync(process.env.AILAB_PROXY_DATA_DIR || join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(dbs, null, 2));
}

/**
 * Check health of a vector DB endpoint
 */
async function checkHealth(db) {
  const healthPaths = {
    milvus: '/v2/vectordb/collections/list',
    weaviate: '/v1/meta',
    chromadb: '/api/v2/heartbeat',
    qdrant: '/collections',
    hippocampai: '/v1/intelligence/health',
  };

  const path = healthPaths[db.type] || '/health';
  const method = db.type === 'milvus' ? 'POST' : 'GET';
  const body = db.type === 'milvus' ? '{}' : null;

  return new Promise((resolve) => {
    const opts = {
      hostname: db.host,
      port: db.port,
      path,
      method,
      timeout: 5000,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        resolve({
          healthy: res.statusCode >= 200 && res.statusCode < 400,
          statusCode: res.statusCode,
          version: tryParseVersion(data, db.type),
        });
      });
    });

    req.on('error', () => resolve({ healthy: false, statusCode: 0, version: null }));
    req.on('timeout', () => { req.destroy(); resolve({ healthy: false, statusCode: 0, version: null }); });

    if (body) req.write(body);
    req.end();
  });
}

function tryParseVersion(data, type) {
  try {
    const d = JSON.parse(data);
    if (type === 'weaviate') return d.version;
    if (type === 'hippocampai') return d.version || null;
    if (type === 'chromadb') return null;
    if (type === 'qdrant') return null;
    if (type === 'milvus') return null;
  } catch {}
  return null;
}

export function createVectorProxyRouter() {
  const router = Router();

  // ─── Config CRUD ───

  // GET /api/proxy/vector/config — List all configured vector DBs
  router.get('/config', (req, res) => {
    res.json(loadConfig());
  });

  // PUT /api/proxy/vector/config — Save vector DB configuration
  router.put('/config', (req, res) => {
    try {
      saveConfig(req.body || []);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Discovery ───

  // GET /api/proxy/vector/list — Available vector DBs with health status
  router.get('/list', async (req, res) => {
    const dbs = loadConfig();
    const results = await Promise.all(dbs.map(async (db) => {
      const health = await checkHealth(db);
      return {
        name: db.name,
        type: db.type,
        host: db.host,
        port: db.port,
        healthy: health.healthy,
        version: health.version,
        description: db.description || '',
        excludeFromAll: db.excludeFromAll || false,
        proxyUrl: `/api/proxy/vector/${db.name}`,
        directUrl: `http://${db.host}:${db.port}`,
      };
    }));
    res.json({ databases: results, count: results.length });
  });

  // ─── Unified "All" Endpoint ───
  // Operations replicated across all eligible vector DBs simultaneously.
  // DBs with excludeFromAll=true are skipped.

  // Embedding model via this proxlab's own /api/proxy/embed proxy (loopback so
  // we don't depend on a separate proxy instance being reachable). The
  // underlying service is configured via active-services + universal proxy.
  const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:7777/api/proxy/embed/v1/embeddings';
  const EMBED_MODEL = process.env.EMBED_MODEL || 'Qwen3-VL-Embedding-8B';

  // Reranker via this proxlab's own /api/proxy/rerank loopback.
  const RERANKER_URL = process.env.RERANKER_URL || 'http://127.0.0.1:7777/api/proxy/rerank/v2/rerank';
  const RERANKER_MODEL = process.env.RERANKER_MODEL || 'nvidia/llama-nemotron-rerank-vl-1b-v2';

  // Live-read the selected embed/reranker models (Support Models tab -> rag-models.json); the loopback
  // /embed //rerank proxy routes are kept (migration-safe). Fallback to env/default. Cached ~15s.
  const RAG_MODELS_FILE = join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'rag-models.json');
  let _ragCache = { cfg: null, ts: 0 };
  function ragModelCfg() {
    const now = Date.now();
    if (_ragCache.cfg && now - _ragCache.ts < 15000) return _ragCache.cfg;
    let c = {};
    try { if (existsSync(RAG_MODELS_FILE)) c = JSON.parse(readFileSync(RAG_MODELS_FILE, 'utf-8')); } catch {}
    _ragCache = { cfg: { embedModel: c.embedModel || EMBED_MODEL, rerankModel: c.rerankModel || RERANKER_MODEL }, ts: now };
    return _ragCache.cfg;
  }

  // ─── Embedding-model fingerprint → collection routing ───
  // The SAME served model name can cover multiple quantisations (Qwen3-VL-Embedding-8B
  // is both the 4-bit and the FP8 build) and their vectors are only ~0.96 apart —
  // close enough to look plausible while silently ranking wrong. So we fingerprint on
  // model id + the weights `root` the endpoint reports, and route to the collections
  // that encoder actually produced. Mirrors collection_suffix() in the unified memory
  // MCP; the manifest is shared.
  //
  // The suffix is PER BACKEND: qdrant's 4-bit set is suffixed (__bnb4) because the
  // FP8 re-embed took the base names, while weaviate/chroma were never re-embedded so
  // their 4-bit data IS the base name. That inverts once they are re-embedded.
  const FINGERPRINT_FILE = join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'collection-fingerprints.json');
  let _fpManifest = { data: null, ts: 0 };
  let _fpCache = { fp: null, ts: 0 };

  function fingerprintManifest() {
    const now = Date.now();
    if (_fpManifest.data && now - _fpManifest.ts < 60000) return _fpManifest.data;
    let d = {};
    try { if (existsSync(FINGERPRINT_FILE)) d = JSON.parse(readFileSync(FINGERPRINT_FILE, 'utf-8')); } catch {}
    _fpManifest = { data: d, ts: now };
    return d;
  }

  /** sha1(model_id|root)[:12] for the embedder currently behind EMBED_URL. '' if unknown. */
  async function embedFingerprint() {
    const now = Date.now();
    if (_fpCache.fp !== null && now - _fpCache.ts < 60000) return _fpCache.fp;
    let fp = '';
    try {
      const base = EMBED_URL.replace(/\/embeddings$/, '');
      const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      const model = ragModelCfg().embedModel;
      const entry = (d.data || []).find(m => m.id === model);
      if (entry) fp = createHash('sha1').update(`${model}|${entry.root || ''}`).digest('hex').slice(0, 12);
    } catch (e) {
      console.warn(`[vector-fp] fingerprint probe failed: ${e.message}`);
    }
    _fpCache = { fp, ts: now };
    return fp;
  }

  /** Collection name for the ACTIVE embedder, for a given backend type. */
  async function resolveCollection(dbType, collection) {
    const man = fingerprintManifest();
    const fp = await embedFingerprint();
    const entry = (man.by_fingerprint || {})[fp];
    let sfx = '';
    if (entry) {
      sfx = typeof entry.suffix === 'object' ? (entry.suffix[dbType] || '') : (entry.suffix || '');
    } else if (fp) {
      console.warn(`[vector-fp] embed fingerprint ${fp} not in ${FINGERPRINT_FILE}; using base collection names for ${dbType}`);
    }
    return sfx ? `${collection}${sfx}` : collection;
  }

  /** Rerank documents using the cross-encoder reranker. Fails gracefully. */
  async function rerank(query, documents) {
    try {
      const resp = await fetch(RERANKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ragModelCfg().rerankModel, query, documents }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.results || null;
    } catch (e) {
      console.warn(`[vector-search] Reranker unavailable: ${e.message}`);
      return null;
    }
  }

  /** Get eligible DBs (excludeFromAll filtered out) */
  function getEligibleDbs() {
    return loadConfig().filter(db => !db.excludeFromAll);
  }

  /** Vectorize text using the embedding model (OpenAI-compatible format) */
  async function vectorize(texts) {
    const input = Array.isArray(texts) ? texts : [texts];
    const resp = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ragModelCfg().embedModel, input }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`Embedding failed: ${resp.status}`);
    const data = await resp.json();
    // OpenAI format: { data: [{ embedding: [...] }] }
    return (data.data || []).map(d => d.embedding);
  }

  /** Get embedding dimension from the model */
  async function getEmbedDim() {
    const vecs = await vectorize('test');
    return vecs[0]?.length || 4096;
  }

  /** Create a collection in a specific vector DB */
  async function createCollectionInDb(db, name, dim) {
    const url = `http://${db.host}:${db.port}`;
    try {
      switch (db.type) {
        case 'qdrant':
          return await fetch(`${url}/collections/${name}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vectors: { size: dim, distance: 'Cosine' } }),
            signal: AbortSignal.timeout(10000),
          }).then(r => ({ db: db.name, status: r.status, ok: r.ok }));

        case 'milvus': {
          // Create collection with explicit schema
          const createR = await fetch(`${url}/v2/vectordb/collections/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              collectionName: name,
              schema: {
                autoId: true,
                enableDynamicField: true,
                fields: [
                  { fieldName: 'id', dataType: 'Int64', isPrimary: true },
                  { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: String(dim) } },
                  { fieldName: 'text', dataType: 'VarChar', elementTypeParams: { max_length: '65535' } },
                  { fieldName: '_metadata_json', dataType: 'VarChar', elementTypeParams: { max_length: '65535' } },
                  { fieldName: '_original_id', dataType: 'VarChar', elementTypeParams: { max_length: '512' } },
                ],
              },
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (createR.ok) {
            // Create index on vector field
            await fetch(`${url}/v2/vectordb/indexes/create`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ collectionName: name, indexParams: [{ fieldName: 'vector', metricType: 'COSINE', indexType: 'AUTOINDEX' }] }),
              signal: AbortSignal.timeout(10000),
            }).catch(() => {});
            // Load collection into memory
            await fetch(`${url}/v2/vectordb/collections/load`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ collectionName: name }),
              signal: AbortSignal.timeout(10000),
            }).catch(() => {});
          }
          return { db: db.name, status: createR.status, ok: createR.ok };
        }

        case 'weaviate':
          return await fetch(`${url}/v1/schema`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              class: name,
              vectorizer: 'none',
              properties: [
                { name: 'text', dataType: ['text'] },
                { name: 'metadata', dataType: ['text'] },
              ],
            }),
            signal: AbortSignal.timeout(10000),
          }).then(r => ({ db: db.name, status: r.status, ok: r.ok }));

        case 'chromadb':
          return await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, metadata: { dimension: dim } }),
            signal: AbortSignal.timeout(10000),
          }).then(r => ({ db: db.name, status: r.status, ok: r.ok }));

        default:
          return { db: db.name, status: 0, ok: false, error: `Unsupported type: ${db.type}` };
      }
    } catch (e) {
      return { db: db.name, status: 0, ok: false, error: e.message };
    }
  }

  /** Drop a collection from a specific vector DB */
  async function dropCollectionInDb(db, name) {
    const url = `http://${db.host}:${db.port}`;
    try {
      switch (db.type) {
        case 'qdrant':
          return await fetch(`${url}/collections/${name}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) })
            .then(r => ({ db: db.name, ok: r.ok }));
        case 'milvus':
          return await fetch(`${url}/v2/vectordb/collections/drop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collectionName: name }),
            signal: AbortSignal.timeout(10000),
          }).then(r => ({ db: db.name, ok: r.ok }));
        case 'weaviate':
          return await fetch(`${url}/v1/schema/${name}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) })
            .then(r => ({ db: db.name, ok: r.ok }));
        case 'chromadb': {
          // ChromaDB v2 API: DELETE by collection name (not UUID)
          return await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections/${name}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) })
            .then(r => ({ db: db.name, ok: r.ok || r.status === 404 }));
        }
        default:
          return { db: db.name, ok: false, error: `Unsupported type: ${db.type}` };
      }
    } catch (e) {
      return { db: db.name, ok: false, error: e.message };
    }
  }

  /** Upsert vectors into a collection in a specific vector DB */
  /** Hash a string to a stable positive integer for Qdrant point IDs */
  function stableHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % Number.MAX_SAFE_INTEGER || 1;
  }

  async function upsertInDb(db, collection, points) {
    const url = `http://${db.host}:${db.port}`;
    try {
      switch (db.type) {
        case 'qdrant': {
          const qUpCol = await resolveCollection('qdrant', collection);
          const qResp = await fetch(`${url}/collections/${qUpCol}/points?wait=true`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              points: points.map((p) => ({
                id: typeof p.id === 'number' ? p.id : stableHash(String(p.id)),
                vector: p.vector,
                payload: { ...(p.metadata || {}), _original_id: String(p.id || '') },
              })),
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!qResp.ok) {
            const errBody = await qResp.text().catch(() => '');
            console.warn(`[vector-all] Qdrant upsert error ${qResp.status}: ${errBody.slice(0, 200)}`);
          }
          return { db: db.name, ok: qResp.ok, count: points.length };
        }

        case 'milvus': {
          return await fetch(`${url}/v2/vectordb/entities/upsert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              collectionName: collection,
              data: points.map(p => ({
                vector: p.vector,
                text: p.metadata?.text || '',
                _original_id: String(p.id || ''),
                _metadata_json: JSON.stringify(p.metadata || {}),
              })),
            }),
            signal: AbortSignal.timeout(30000),
          }).then(r => ({ db: db.name, ok: r.ok, count: points.length }));
        }

        case 'weaviate': {
          const wvClass = collection.charAt(0).toUpperCase() + collection.slice(1);
          // Use deterministic UUIDs from entry ID so re-upserts overwrite
          function deterministicUUID(str) {
            let h = 0x811c9dc5;
            for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
            h = h >>> 0;
            const hex = h.toString(16).padStart(8, '0');
            return `${hex.slice(0,8)}-${hex.slice(0,4)}-4${hex.slice(1,4)}-8${hex.slice(1,4)}-${hex}0000`;
          }
          const wvResp = await fetch(`${url}/v1/batch/objects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              objects: points.map(p => ({
                id: deterministicUUID(String(p.id || '')),
                class: wvClass,
                vector: p.vector,
                properties: {
                  text: p.metadata?.text || '',
                  metadata: JSON.stringify(p.metadata || {}),
                  doc_id: String(p.id || ''),
                },
              })),
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!wvResp.ok) return { db: db.name, ok: false, error: `HTTP ${wvResp.status}` };
          const wvResults = await wvResp.json();
          const wvFailed = (Array.isArray(wvResults) ? wvResults : []).filter(r => r.result?.status === 'FAILED');
          if (wvFailed.length) {
            const firstErr = wvFailed[0].result?.errors?.error?.[0]?.message || 'unknown';
            console.warn(`[vector-all] Weaviate batch: ${wvFailed.length}/${points.length} failed. First: ${firstErr.slice(0, 200)}`);
          }
          return { db: db.name, ok: wvFailed.length === 0, count: points.length - wvFailed.length };
        }

        case 'chromadb': {
          // ChromaDB needs collection ID — use upsert instead of add to handle duplicates
          const listResp = await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections`, { signal: AbortSignal.timeout(10000) });
          const cols = await listResp.json();
          const col = (Array.isArray(cols) ? cols : []).find(c => c.name === collection);
          if (!col) return { db: db.name, ok: false, error: 'Collection not found' };
          return await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections/${col.id}/upsert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ids: points.map((p, i) => String(p.id || `doc-${i}`)),
              embeddings: points.map(p => p.vector),
              metadatas: points.map(p => p.metadata || {}),
              documents: points.map(p => p.metadata?.text || ''),
            }),
            signal: AbortSignal.timeout(30000),
          }).then(r => ({ db: db.name, ok: r.ok, count: points.length }));
        }

        default:
          return { db: db.name, ok: false, error: `Unsupported type: ${db.type}` };
      }
    } catch (e) {
      return { db: db.name, ok: false, error: e.message };
    }
  }

  // POST /api/proxy/vector/all/collections — Create collection in all eligible DBs
  router.post('/all/collections', jsonParser(), async (req, res) => {
    const { name, dimension } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const dim = dimension || await getEmbedDim();
    const dbs = getEligibleDbs();
    const results = await Promise.all(dbs.map(db => createCollectionInDb(db, name, dim)));
    res.json({ collection: name, dimension: dim, results });
  });

  // DELETE /api/proxy/vector/all/collections/:name — Drop collection from all eligible DBs
  router.delete('/all/collections/:name', async (req, res) => {
    const dbs = getEligibleDbs();
    const results = await Promise.all(dbs.map(db => dropCollectionInDb(db, req.params.name)));
    res.json({ collection: req.params.name, results });
  });

  // POST /api/proxy/vector/all/collections/:name/upsert — Upsert vectors to all eligible DBs
  // Body: { points: [{ id, vector, metadata }] }
  // Or with auto-vectorize: { documents: [{ id, text, metadata }] }
  router.post('/all/collections/:name/upsert', jsonParser({ limit: '50mb' }), async (req, res) => {
    const { points, documents } = req.body || {};
    const collection = req.params.name;

    let upsertPoints;
    if (documents && documents.length) {
      // Auto-vectorize text documents
      try {
        const texts = documents.map(d => d.text);
        const embeddings = await vectorize(texts);
        upsertPoints = documents.map((d, i) => ({
          id: d.id || `doc-${i}`,
          vector: embeddings[i],
          metadata: { text: d.text, ...(d.metadata || {}) },
        }));
      } catch (e) {
        return res.status(502).json({ error: `Vectorization failed: ${e.message}` });
      }
    } else if (points && points.length) {
      upsertPoints = points;
    } else {
      return res.status(400).json({ error: 'Provide either "points" (pre-vectorized) or "documents" (auto-vectorize)' });
    }

    const dbs = getEligibleDbs();
    const results = await Promise.all(dbs.map(db => upsertInDb(db, collection, upsertPoints)));
    res.json({ collection, count: upsertPoints.length, results });
  });

  // GET /api/proxy/vector/all/collections — List collections from all eligible DBs
  router.get('/all/collections', async (req, res) => {
    const dbs = getEligibleDbs();
    const results = await Promise.all(dbs.map(async (db) => {
      const url = `http://${db.host}:${db.port}`;
      try {
        switch (db.type) {
          case 'qdrant': {
            const r = await fetch(`${url}/collections`, { signal: AbortSignal.timeout(5000) });
            const d = await r.json();
            return { db: db.name, collections: (d.result?.collections || []).map(c => c.name) };
          }
          case 'milvus': {
            const r = await fetch(`${url}/v2/vectordb/collections/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
            const d = await r.json();
            return { db: db.name, collections: d.data || [] };
          }
          case 'weaviate': {
            const r = await fetch(`${url}/v1/schema`, { signal: AbortSignal.timeout(5000) });
            const d = await r.json();
            return { db: db.name, collections: (d.classes || []).map(c => c.class) };
          }
          case 'chromadb': {
            const r = await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections`, { signal: AbortSignal.timeout(5000) });
            const d = await r.json();
            return { db: db.name, collections: (Array.isArray(d) ? d : []).map(c => c.name) };
          }
          default:
            return { db: db.name, collections: [], error: 'unsupported' };
        }
      } catch (e) {
        return { db: db.name, collections: [], error: e.message };
      }
    }));
    res.json({ results });
  });

  // ─── Consensus Search ───
  // Queries all eligible vector DBs in parallel, merges results using
  // Reciprocal Rank Fusion (RRF), and returns a unified ranked list.

  /** Search a single vector DB and return scored results */
  async function searchDb(db, queryVector, collection, topK) {
    const url = `http://${db.host}:${db.port}`;
    try {
      switch (db.type) {
        case 'qdrant': {
          const qCol = await resolveCollection('qdrant', collection);
          const r = await fetch(`${url}/collections/${qCol}/points/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: queryVector, limit: topK, with_payload: true }),
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json();
          return (d.result?.points || []).map((p, rank) => ({
            id: String(p.payload?._original_id || p.id),
            score: p.score || 0,
            rank: rank + 1,
            text: p.payload?.text || '',
            metadata: p.payload || {},
          }));
        }
        case 'milvus': {
          const r = await fetch(`${url}/v2/vectordb/entities/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              collectionName: collection,
              data: [queryVector],
              annsField: 'vector',
              limit: topK,
              outputFields: ['*'],
            }),
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json();
          return (d.data || []).map((p, rank) => ({
            id: String(p.id || rank),
            score: p.distance || p.score || 0,
            rank: rank + 1,
            text: p.text || '',
            metadata: p,
          }));
        }
        case 'weaviate': {
          // Weaviate auto-capitalizes class names
          const weaviateClass = collection.charAt(0).toUpperCase() + collection.slice(1);
          const r = await fetch(`${url}/v1/graphql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: `{ Get { ${weaviateClass}(nearVector: {vector: ${JSON.stringify(queryVector)}}, limit: ${topK}) { text metadata _additional { id distance } } } }`,
            }),
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json();
          const results = d.data?.Get?.[weaviateClass] || [];
          return results.map((p, rank) => ({
            id: p._additional?.id || String(rank),
            score: 1 - (p._additional?.distance || 0),
            rank: rank + 1,
            text: p.text || '',
            metadata: { text: p.text, metadata: p.metadata },
          }));
        }
        case 'chromadb': {
          // Need collection ID first
          const listR = await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections`, { signal: AbortSignal.timeout(5000) });
          const cols = await listR.json();
          const col = (Array.isArray(cols) ? cols : []).find(c => c.name === collection);
          if (!col) return [];
          const r = await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections/${col.id}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query_embeddings: [queryVector],
              n_results: topK,
              include: ['documents', 'metadatas', 'distances'],
            }),
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json();
          const ids = d.ids?.[0] || [];
          const docs = d.documents?.[0] || [];
          const dists = d.distances?.[0] || [];
          const metas = d.metadatas?.[0] || [];
          return ids.map((id, rank) => ({
            id: String(id),
            score: 1 - (dists[rank] || 0), // ChromaDB returns distance, convert to similarity
            rank: rank + 1,
            text: docs[rank] || '',
            metadata: metas[rank] || {},
          }));
        }
        default:
          return [];
      }
    } catch (e) {
      console.warn(`[vector-search] ${db.name} search failed: ${e.message}`);
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion — merges ranked lists from multiple sources.
   * RRF score = sum(1 / (k + rank_i)) for each source that returned the document.
   * k is a constant (typically 60) that dampens the effect of high rankings.
   */
  function reciprocalRankFusion(resultsByDb, k = 60) {
    const scores = new Map(); // id -> { score, text, metadata, sources }

    for (const [dbName, results] of Object.entries(resultsByDb)) {
      for (const r of results) {
        const key = r.text || r.id; // Deduplicate by text content if available
        const existing = scores.get(key) || {
          id: r.id,
          text: r.text,
          metadata: r.metadata,
          rrfScore: 0,
          sources: [],
          nativeScores: {},
        };
        existing.rrfScore += 1 / (k + r.rank);
        existing.sources.push(dbName);
        existing.nativeScores[dbName] = { rank: r.rank, score: r.score };
        scores.set(key, existing);
      }
    }

    // Sort by RRF score descending
    return Array.from(scores.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .map((r, i) => ({
        rank: i + 1,
        id: r.id,
        text: r.text,
        rrfScore: Math.round(r.rrfScore * 10000) / 10000,
        consensus: r.sources.length,
        sources: r.sources,
        nativeScores: r.nativeScores,
        metadata: r.metadata,
      }));
  }

  // POST /api/proxy/vector/all/collections/:name/search — Consensus search across all DBs
  // Body: { query: "search text", topK: 10 }
  // Or pre-vectorized: { vector: [...], topK: 10 }
  router.post('/all/collections/:name/search', jsonParser(), async (req, res) => {
    const { query, vector, topK = 10 } = req.body || {};
    const collection = req.params.name;

    // Get query vector
    let queryVector;
    if (vector && vector.length) {
      queryVector = vector;
    } else if (query) {
      try {
        const vecs = await vectorize(query);
        queryVector = vecs[0];
      } catch (e) {
        return res.status(502).json({ error: `Vectorization failed: ${e.message}` });
      }
    } else {
      return res.status(400).json({ error: 'Provide either "query" (text) or "vector" (pre-computed)' });
    }

    // Search all eligible DBs in parallel
    const dbs = getEligibleDbs();
    const searchResults = {};
    const dbResults = await Promise.all(dbs.map(async (db) => {
      const results = await searchDb(db, queryVector, collection, topK);
      return { db: db.name, results, count: results.length };
    }));

    for (const { db, results } of dbResults) {
      if (results.length) searchResults[db] = results;
    }

    // Merge with Reciprocal Rank Fusion
    const fused = reciprocalRankFusion(searchResults, 60);

    // Optional: rerank the fused results using the cross-encoder
    let finalResults = fused;
    let reranked = false;
    if (query && fused.length > 1) {
      const docs = fused.filter(r => r.text).map(r => r.text);
      if (docs.length > 1) {
        const rerankerScores = await rerank(query, docs);
        if (rerankerScores) {
          reranked = true;
          // Map reranker scores back to fused results
          const scoreMap = new Map();
          for (const s of rerankerScores) {
            scoreMap.set(s.index, s.relevance_score);
          }
          // Re-sort by reranker score
          const textsInOrder = docs;
          finalResults = fused
            .filter(r => r.text)
            .map((r, i) => ({
              ...r,
              rerankerScore: scoreMap.get(textsInOrder.indexOf(r.text)) || 0,
            }))
            .sort((a, b) => b.rerankerScore - a.rerankerScore)
            .map((r, i) => ({ ...r, rank: i + 1 }));
        }
      }
    }

    res.json({
      collection,
      query: query || '(pre-vectorized)',
      topK,
      reranked,
      dbsQueried: dbResults.map(r => ({ db: r.db, hits: r.count })),
      results: finalResults.slice(0, topK),
      totalCandidates: fused.length,
    });
  });

  // ─── Proxy ───

  // ALL /api/proxy/vector/:name/* — Proxy requests to named vector DB
  router.all('/:name/{*rest}', (req, res) => {
    const dbs = loadConfig();
    const db = dbs.find(d => d.name === req.params.name);
    if (!db) {
      return res.status(404).json({ error: `Vector DB '${req.params.name}' not configured` });
    }

    // Build the proxy path — req.params.rest may be string or array in Express 5
    const rawRest = Array.isArray(req.params.rest) ? req.params.rest.join('/') : String(req.params.rest || '');
    const proxyPath = rawRest.startsWith('/') ? rawRest : '/' + rawRest;
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';

    // Collect request body first (stream may already be partially consumed)
    const bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);

      const opts = {
        hostname: db.host,
        port: db.port,
        path: proxyPath + queryString,
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] || 'application/json',
          'accept': req.headers['accept'] || '*/*',
          'host': `${db.host}:${db.port}`,
        },
        timeout: 30000,
      };

      if (body.length > 0) {
        opts.headers['content-length'] = body.length;
      }

      const proxyReq = http.request(opts, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });

      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.status(502).json({ error: `Proxy error: ${err.message}` });
        }
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
          res.status(504).json({ error: 'Proxy timeout' });
        }
      });

      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  });

  // Catch-all for /api/proxy/vector/:name (no trailing path)
  router.all('/:name', (req, res) => {
    const dbs = loadConfig();
    const db = dbs.find(d => d.name === req.params.name);
    if (!db) {
      return res.status(404).json({ error: `Vector DB '${req.params.name}' not configured` });
    }
    // Return info about this DB
    res.json({
      name: db.name,
      type: db.type,
      directUrl: `http://${db.host}:${db.port}`,
      proxyUrl: `/api/proxy/vector/${db.name}`,
    });
  });

  return router;
}
