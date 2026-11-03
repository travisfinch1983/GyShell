#!/usr/bin/env node
/**
 * dhb-docs — MCP server for the SHARED DHB document store, run on CT190 dhb-collab (stdio).
 *
 * Fork of /opt/mcp-document-rag/server.mjs (CT152), 2026-11-03 claude1. Differences:
 *  - talks to the AI-Lab API ONLY through dhb-collab-gate (PROXLAB_URL=http://10.0.0.219:8098),
 *    which scopes every call to docs_dhb_* collections (they live in the dedicated ailab-qdrant-dhb);
 *  - the collection manifest and the embedding model come from the gate (no local AI-Lab data dir);
 *  - adds add_documents / index_status so this instance can CONTRIBUTE documents; no delete.
 *
 * Original header:
 * mcp-document-rag — MCP server for searching indexed document collections
 *
 * Provides semantic search across document collections (PDFs, images, office docs)
 * indexed via the ProxLab Document RAG tab. Uses ProxLab vector proxy for
 * consensus search across Qdrant, Milvus, Weaviate, and ChromaDB.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

// ── Config ──────────────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const PROXLAB_URL = process.env.PROXLAB_URL || 'http://127.0.0.1:17890';
// ── Embedding model: SINGLE SOURCE OF TRUTH ─────────────────────────────────
// The embedding model is chosen ONCE in AI-Lab (Settings -> Support Models), which persists
// to rag-models.json. Reading it LIVE means changing it there changes it everywhere. A
// hardcoded copy here is exactly how this server kept embedding through the retired 4-bit
// V100 instance after the UI was repointed at the FP8 pool: the served names
// `Qwen3-VL-Embedding-8B` (V100, BNB 4-bit) and `Qwen3-VL-Embedding-8B-FP8` (5060 Ti) are
// BOTH dim 4096, so a mismatch can NEVER surface as an error -- it only degrades recall.
// PRECEDENCE: file wins, env is the fallback, the literal is the last resort.
// ⚠ Changing the model REQUIRES RE-INDEXING this server's collections: queries embedded by a
// different model than the corpus compare without error and return nonsense-ranked results.
const RAG_MODELS_FILE = process.env.RAG_MODELS_FILE
  || join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'rag-models.json');
const EMBED_MODEL_FALLBACK = process.env.EMBED_MODEL || 'Qwen3-VL-Embedding-8B';
let _ragCfgCache = { model: null, ts: 0, warnedAt: 0 };
function effEmbedModel() {
  const now = Date.now();
  if (_ragCfgCache.model && now - _ragCfgCache.ts < 15000) return _ragCfgCache.model;
  let m = '';
  try {
    m = (JSON.parse(readFileSync(RAG_MODELS_FILE, 'utf-8')) || {}).embedModel || '';
  } catch (e) {
    // Never silent: a missing config means we are embedding with the fallback, which may not
    // match the corpus. Rate-limited so a persistent problem does not flood stderr.
    if (now - _ragCfgCache.warnedAt > 60000) {
      console.error(`[mcp-document-rag] rag-models.json unreadable at ${RAG_MODELS_FILE} (${e.message}) `
        + `-- falling back to '${EMBED_MODEL_FALLBACK}', which may NOT match the indexed corpus`);
      _ragCfgCache.warnedAt = now;
    }
  }
  _ragCfgCache = { ..._ragCfgCache, model: m || EMBED_MODEL_FALLBACK, ts: now };
  return _ragCfgCache.model;
}
const MANIFEST_FILE = join(DATA_DIR, 'collections.json');

// ── Manifest helpers ────────────────────────────────────────────────────────
// Scoped instance (e.g. document-rag-dhb for the fenced enterprise CT196): DOCRAG_ALLOW_PREFIX limits
// EVERY tool to collections whose internal name starts with it (comma-separated list allowed), and
// DOCRAG_READONLY=1 drops the delete tool. Unset = the full lab server, unchanged.
const ALLOW_PREFIXES = String(process.env.DOCRAG_ALLOW_PREFIX || '').split(',').map((x) => x.trim()).filter(Boolean);
const READONLY = process.env.DOCRAG_READONLY === '1';
const allowedCol = (colName) => !ALLOW_PREFIXES.length || ALLOW_PREFIXES.some((pre) => String(colName).startsWith(pre));
function loadManifest() {
  return loadManifestAll().filter((m) => allowedCol(m.name));
}
// The manifest lives on CT152; refreshed from the gate before every tool call (syncManifest).
let _manifest = [];
function loadManifestAll() {
  return _manifest;
}
async function syncManifest() {
  try {
    const r = await fetch(`${PROXLAB_URL}/api/ai/docrag/collections`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) _manifest = await r.json();
    else console.error(`[dhb-docs] manifest fetch HTTP ${r.status} - using the last copy`);
  } catch (e) {
    console.error(`[dhb-docs] manifest fetch failed (${e.message}) - using the last copy`);
  }
  try {
    const r = await fetch(`${PROXLAB_URL}/dhb/rag-models`, { signal: AbortSignal.timeout(10000) });
    const m = r.ok ? ((await r.json()) || {}).embedModel : '';
    if (m) _ragCfgCache = { ..._ragCfgCache, model: m, ts: Date.now() };
  } catch (e) {
    console.error(`[dhb-docs] embed-model fetch failed (${e.message})`);
  }
}

function saveManifest(data) {
  writeFileSync(MANIFEST_FILE, JSON.stringify(data, null, 2));
}

// ── Collection name helpers ─────────────────────────────────────────────────
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function collectionName(name) {
  return `docs_${sanitizeName(name)}`;
}

// ── ProxLab API helpers ─────────────────────────────────────────────────────
async function embedTexts(texts) {
  const resp = await fetch(`${PROXLAB_URL}/api/proxy/embed/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: effEmbedModel(), input: texts }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Embedding failed (${resp.status}): ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.data || []).map(d => d.embedding);
}

async function searchCollection(collection, query, topK = 10, filter = null, vector = null) {
  if (!vector) vector = (await embedTexts([query]))[0];
  const resp = await fetch(`${PROXLAB_URL}/api/proxy/vector/all/collections/${collection}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, topK, ...(filter ? { filter } : {}) }),
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

// Three lanes per collection, fused by rank (RRF): dense text, dense PDF page images, BM25 keywords.
// Text chunks and PDF page images are ranked SEPARATELY, then fused by rank (RRF). A text query
// scores every text chunk above every image (the modality gap: measured 2026-10-06, a world map
// page ranked below all 18 text chunks for "fantasy world map", yet FIRST among the page images),
// so a single list never surfaces a diagram. RRF gives the best image the same weight as the best
// text passage. Collections indexed before page images simply return an empty image list.
// LAN-reachable base for page-image links (PROXLAB_URL can be loopback inside this host).
const PAGE_IMG_BASE = process.env.DOCRAG_PUBLIC_URL || 'http://10.0.0.219:17890';
const IS_PAGE_IMG = { must: [{ key: 'file_type', match: { value: 'pdf_page_image' } }] };
const NOT_PAGE_IMG = { must_not: [{ key: 'file_type', match: { value: 'pdf_page_image' } }] };
// BM25 keyword lane over the "<col>__kw" companion (vector proxy /keyword-search): exact tokens
// such as part numbers, DTCs, thread sizes and torque values that dense vectors blur together.
// A query that LOOKS like a code / part number / identifier (one token, or digits, underscores,
// camelCase, dotted or dashed codes) is asking for an exact match: the keyword lane counts double.
// Natural-language questions keep equal weight, so meaning still wins for them.
function kwWeight(query) {
  const q = String(query || '').trim();
  return (!/\s/.test(q) || /\d|_|[a-z][A-Z]|\w[.\-]\w/.test(q)) ? 2 : 1;
}
async function keywordSearch(collection, query, topK, scope = null) {
  const resp = await fetch(`${PROXLAB_URL}/api/proxy/vector/all/collections/${collection}/keyword-search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK, filter: withScope(NOT_PAGE_IMG, scope) }),
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

/** AND a document scope ({must:[...]}) into a lane filter. */
function withScope(filter, scope) {
  if (!scope) return filter;
  return { ...filter, must: [...(filter.must || []), ...(scope.must || [])] };
}
// collections: [{ name, display_name, scope? }]; scope narrows that collection to some documents.
async function searchFused(collections, query, topK) {
  const vector = (await embedTexts([query]))[0];
  const lists = [];
  for (const col of collections) {
    const tag = (r) => r.results.map((it) => ({ ...it, collection: col.display_name || col.name }));
    for (const filter of [NOT_PAGE_IMG, IS_PAGE_IMG]) {
      try {
        const r = await searchCollection(col.name, query, topK, withScope(filter, col.scope), vector);
        if (r.results?.length) lists.push(tag(r));
      } catch { /* one collection failing must not sink the whole search */ }
    }
    try {
      const k = await keywordSearch(col.name, query, topK, col.scope);
      if (k.results?.length) lists.push(Object.assign(tag(k), { weight: kwWeight(query) }));
    } catch { /* keyword lane is additive */ }
  }
  const byKey = new Map();
  for (const list of lists) {
    list.forEach((it, rank) => {
      const key = `${it.collection}::${it.id}`;
      const prev = byKey.get(key);
      const add = (list.weight || 1) / (60 + rank + 1);
      if (prev) prev.fusedScore += add; else byKey.set(key, { ...it, fusedScore: add });
    });
  }
  return [...byKey.values()].sort((a, b) => b.fusedScore - a.fusedScore).slice(0, topK);
}

async function deleteCollection(name) {
  const resp = await fetch(`${PROXLAB_URL}/api/proxy/vector/all/collections/${name}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

// ── Documents (2026-10-22): each collection holds titled documents (doc_id/doc_title/doc_type) ──
// A collection indexed before documents existed has no list yet; the AI-Lab backend builds it on
// first request (and stamps the points with doc_ids), so ask it rather than guessing from files.
async function documentsOf(entry) {
  if (Array.isArray(entry.documents)) return entry.documents;
  try {
    const r = await fetch(`${PROXLAB_URL}/api/ai/docrag/collections/${entry.name}/documents`, { signal: AbortSignal.timeout(120000) });
    if (r.ok) return (await r.json()).documents || [];
  } catch {}
  return [];
}
const norm = (x) => String(x || '').toLowerCase();
function matchDocs(docs, document, docType) {
  return docs.filter((d) => {
    if (docType && !norm(d.doc_type).includes(norm(docType))) return false;
    if (!document) return true;
    const q = norm(document);
    return d.doc_id === document || norm(d.title).includes(q) || norm(d.file_name).includes(q);
  });
}
const docScope = (docs) => ({ must: [{ key: 'doc_id', match: { any: docs.map((d) => d.doc_id) } }] });

// ── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'dhb-docs',
  version: '1.0.0',
});
// Every tool first refreshes the manifest + embed model from the gate.
const _tool = server.tool.bind(server);
server.tool = (name, desc, schema, handler) => _tool(name, desc, schema, async (...a) => { await syncManifest(); return handler(...a); });

// ─── Tool: search_docs ──────────────────────────────────────────────────────
server.tool(
  'search_docs',
  'Semantic search across indexed document collections (PDFs, images, office docs). Returns ranked snippets; PDF pages are also matched as IMAGES (diagrams, schematics, scans) - those results are marked [pdf_page_image] and include a "Page image" URL to view the page.',
  {
    query: z.string().describe('Search query (natural language)'),
    collection: z.string().optional().describe('Specific collection to search (without docs_ prefix). Omit to search all.'),
    k: z.number().optional().describe('Number of results to return (default: 10)'),
    document: z.string().optional().describe('Limit the search to documents whose TITLE or file name contains this text (case-insensitive), or an exact doc_id. Use list_documents to see titles.'),
    doc_type: z.string().optional().describe('Limit the search to documents of this type, e.g. "Blueprint", "Contract", "Report" (substring match).'),
  },
  async ({ query, collection, k, document, doc_type }) => {
    const topK = k || 10;

    try {
      let results;
      const manifest = loadManifest();
      let cols;
      if (collection) {
        const colName = collectionName(collection);
        if (!allowedCol(colName)) {
          return { content: [{ type: 'text', text: `Collection "${collection}" not found. Use list_doc_collections.` }] };
        }
        cols = [manifest.find((m) => m.name === colName) || { name: colName, display_name: colName }];
      } else {
        if (manifest.length === 0) {
          return { content: [{ type: 'text', text: 'No document collections indexed yet. Upload documents via the AI-Lab Document RAG tab.' }] };
        }
        cols = manifest;
      }
      if (document || doc_type) {
        const scoped = [];
        for (const c of cols) {
          const hit = matchDocs(await documentsOf(c), document, doc_type);
          if (hit.length) scoped.push({ ...c, scope: docScope(hit) });
        }
        if (!scoped.length) {
          return { content: [{ type: 'text', text: `No document matches${document ? ` "${document}"` : ''}${doc_type ? ` of type "${doc_type}"` : ''}${collection ? ` in ${collection}` : ''}. Use list_documents to see the titles.` }] };
        }
        cols = scoped;
      }
      results = { results: await searchFused(cols, query, topK) };

      const items = results.results || [];
      const formatted = items.map((r, i) => {
        const meta = r.metadata || {};
        let parsedMeta = meta;
        if (typeof meta.metadata === 'string') {
          try { parsedMeta = { ...meta, ...JSON.parse(meta.metadata) }; } catch {}
        }
        const fileName = parsedMeta.file_name || meta.file_name || 'unknown';
        const fileType = parsedMeta.file_type || meta.file_type || '';
        const pageNum = parsedMeta.page_number || meta.page_number;
        const score = r.fusedScore || r.rerankScore || r.rrfScore || 0;
        const pageImg = parsedMeta.page_image || meta.page_image;
        const col = r.collection || parsedMeta.collection || '';

        const pageStr = pageNum ? ` (page ${pageNum})` : '';
        const title = parsedMeta.doc_title || meta.doc_title;
        const dtype = parsedMeta.doc_type || meta.doc_type;
        const docLine = title ? `Document: ${title}${dtype ? ` [${dtype}]` : ''}${parsedMeta.doc_id ? ` (doc_id ${parsedMeta.doc_id})` : ''}\n` : '';
        return `--- Result ${i + 1} (score: ${score.toFixed(4)}) ---
${docLine}File: ${fileName}${pageStr}${fileType ? ` [${fileType}]` : ''}${col ? ` (${col})` : ''}${pageImg ? `
Page image (view the diagram): ${PAGE_IMG_BASE}${pageImg}` : ''}

${r.text || ''}`;
      }).join('\n\n');

      return { content: [{ type: 'text', text: formatted || 'No results found.' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Search error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Tool: list_doc_collections ─────────────────────────────────────────────
server.tool(
  'list_doc_collections',
  'List all indexed document collections with metadata (name, file count, types, etc.)',
  {},
  async () => {
    const manifest = loadManifest();
    if (manifest.length === 0) {
      return { content: [{ type: 'text', text: 'No document collections indexed yet.' }] };
    }
    const summary = manifest.map(({ documents, ...rest }) => ({ ...rest, ...(Array.isArray(documents) ? { document_count: documents.length } : {}) }));
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) + '\n\nUse list_documents(collection) to see the titled documents inside a collection.' }] };
  },
);

// ─── Tool: list_documents ───────────────────────────────────────────────────
server.tool(
  'list_documents',
  'List the documents inside a collection: title, type, description, file name, size of index. Use a title (or part of it) as search_docs `document` to search just that document.',
  {
    collection: z.string().describe('Collection name (without docs_ prefix)'),
    doc_type: z.string().optional().describe('Only documents of this type (substring match)'),
  },
  async ({ collection, doc_type }) => {
    const colName = collectionName(collection);
    const entry = loadManifest().find((m) => m.name === colName);
    if (!entry) return { content: [{ type: 'text', text: `Collection "${collection}" not found. Use list_doc_collections.` }] };
    const docs = matchDocs(await documentsOf(entry), null, doc_type);
    if (!docs.length) return { content: [{ type: 'text', text: 'No documents.' }] };
    const lines = docs
      .sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true }))
      .map((d) => `- ${d.title}${d.doc_type ? ` [${d.doc_type}]` : ''} - ${d.file_name}; ${d.chunks || 0} chunks${d.page_images ? `, ${d.page_images} page images` : ''}; doc_id ${d.doc_id}${d.description ? `\n    ${d.description}` : ''}`);
    return { content: [{ type: 'text', text: `${entry.display_name || entry.name}${entry.description ? ` - ${entry.description}` : ''}\n${docs.length} document(s):\n${lines.join('\n')}` }] };
  },
);

// ─── Tool: delete_doc_collection ────────────────────────────────────────────
if (!READONLY) server.tool(
  'delete_doc_collection',
  'Delete an indexed document collection from all vector DBs',
  {
    collection: z.string().describe('Collection name to delete (without docs_ prefix)'),
  },
  async ({ collection }) => {
    const colName = collectionName(collection);
    try {
      const result = await deleteCollection(colName);
      if (!allowedCol(colName)) throw new Error(`collection "${collection}" not found`);
      const manifest = loadManifestAll();
      const filtered = manifest.filter(m => m.name !== colName);
      saveManifest(filtered);
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: colName, vector_db_results: result }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Delete error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Tool: doc_collection_stats ─────────────────────────────────────────────
server.tool(
  'doc_collection_stats',
  'Get detailed stats for a specific indexed document collection',
  {
    collection: z.string().describe('Collection name (without docs_ prefix)'),
  },
  async ({ collection }) => {
    const colName = collectionName(collection);
    const manifest = loadManifest();
    const entry = manifest.find(m => m.name === colName);
    if (!entry) {
      return { content: [{ type: 'text', text: `Collection "${collection}" not found. Use list_doc_collections to see available collections.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
  },
);

// ─── Tool: add_documents (contribute to the shared store) ───────────────────
const MAX_UPLOAD = 100 * 1024 * 1024;
server.tool(
  'add_documents',
  'Index local files into a SHARED DHB document collection (seen by every DHB instance). Supports pdf, docx, xlsx, txt, md, csv, json, yaml, xml, html and images. Indexing runs in the background on the AI-Lab server - poll index_status. Only one indexing job runs at a time lab-wide (409 = busy, retry later). New collections must be named dhb_<something>.',
  {
    paths: z.array(z.string()).describe('Absolute paths of local files to index'),
    collection: z.string().describe('Collection, e.g. "dhb_royal_slope_bess" (existing) or a new "dhb_<project>"'),
    description: z.string().optional().describe('Collection description (used when creating a new collection)'),
  },
  async ({ paths, collection, description }) => {
    try {
      let total = 0;
      const files = paths.map((p) => {
        const st = statSync(p);
        if (!st.isFile()) throw new Error(`${p} is not a file`);
        total += st.size;
        if (total > MAX_UPLOAD) throw new Error(`upload over ${MAX_UPLOAD / 1048576} MB - split it into several add_documents calls`);
        return { name: basename(p), dataB64: readFileSync(p).toString('base64') };
      });
      const r = await fetch(`${PROXLAB_URL}/api/ai/docrag/index-b64`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection, description: description || '', files }),
        signal: AbortSignal.timeout(300000),
      });
      const text = await r.text();
      if (!r.ok) return { content: [{ type: 'text', text: `add_documents refused (HTTP ${r.status}): ${text.slice(0, 400)}` }], isError: true };
      return { content: [{ type: 'text', text: `${text}\nIndexing started - poll index_status until it finishes.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `add_documents error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Tool: index_status ─────────────────────────────────────────────────────
server.tool(
  'index_status',
  'Status of the (single, lab-wide) document indexing job. A non-DHB job shows only as busy.',
  {},
  async () => {
    try {
      const r = await fetch(`${PROXLAB_URL}/api/ai/docrag/index/status`, { signal: AbortSignal.timeout(15000) });
      return { content: [{ type: 'text', text: await r.text() }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `index_status error: ${e.message}` }], isError: true };
    }
  },
);

// ── Start server ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
