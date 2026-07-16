// Codebase-RAG (/api/ai/rag/*) + Document-RAG (/api/ai/docrag/*) — ported verbatim from ProxLab
// server.js. Indexing engines clone/chunk/embed/upsert via SSH to the RAG host + the local vector/embed
// proxies. sshService.exec -> exec (shim), config.server.port -> selfPort.
/* eslint-disable */
// @ts-nocheck
import express from 'express'
import multer from 'multer'
import { readFile as readFileAsync, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve as pathResolve, dirname, basename } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Document extractors are optional — lazy + graceful so codebase-RAG never breaks if they're absent.
let pdfParse, mammoth, XLSX
try { pdfParse = (await import('pdf-parse')).default } catch { pdfParse = async () => { throw new Error('pdf-parse not installed') } }
try { mammoth = await import('mammoth') } catch { mammoth = { extractRawText: async () => { throw new Error('mammoth not installed') } } }
try { const _x = await import('xlsx'); XLSX = _x.default || _x } catch { XLSX = { read: () => { throw new Error('xlsx not installed') }, utils: { sheet_to_csv: () => '' } } }

// ─── RAG embed/reranker model selection (Support Models tab) ──────────────────
const RAG_DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data'
const RAG_MODELS_FILE = join(RAG_DATA_DIR, 'rag-models.json')
const ACTIVE_SERVICES_FILE = join(RAG_DATA_DIR, 'active-services.json')
const RAG_DEFAULT_EMBED_MODEL = 'Qwen3-VL-Embedding-8B'
const RAG_DEFAULT_RERANK_MODEL = 'nvidia/llama-nemotron-rerank-vl-1b-v2'

function readRagModels() {
  try { return existsSync(RAG_MODELS_FILE) ? JSON.parse(readFileSync(RAG_MODELS_FILE, 'utf-8')) : {} } catch { return {} }
}
function writeRagModels(cfg) { try { writeFileSync(RAG_MODELS_FILE, JSON.stringify(cfg, null, 2)) } catch {} }
function effEmbedModel() { return readRagModels().embedModel || RAG_DEFAULT_EMBED_MODEL }

// Probe-based service-type classification (resilient — NO name heuristics; open-source-safe). Cached.
const _svcTypeCache = new Map() // endpoint -> { type, ts }
const _SVC_TTL = 300000
async function probeServiceType(endpoint) {
  const hit = _svcTypeCache.get(endpoint)
  if (hit && Date.now() - hit.ts < _SVC_TTL) return hit.type
  const v1 = endpoint.replace(/\/+$/, '')
  const root = v1.replace(/\/v1$/, '')
  const postOk = async (url, body) => { try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3500) }); return r.ok } catch { return false } }
  const getJson = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(3500) }); return r.ok ? await r.json() : null } catch { return null } }
  const models = await getJson(`${v1}/models`)
  const model = models?.data?.[0]?.id || 'model'
  let type = 'llm'
  // Embedders answer /v1/embeddings; cross-encoder rerankers 404 that but answer /rerank|/score. Embed wins first.
  if (await postOk(`${v1}/embeddings`, { model, input: 'probe' })) type = 'embed'
  else if (await postOk(`${root}/rerank`, { model, query: 'q', documents: ['a'] })
        || await postOk(`${v1}/rerank`, { model, query: 'q', documents: ['a'] })
        || await postOk(`${root}/v2/rerank`, { model, query: 'q', documents: ['a'] })
        || await postOk(`${v1}/score`, { model, text_1: 'a', text_2: 'b' })) type = 'rerank'
  _svcTypeCache.set(endpoint, { type, ts: Date.now() })
  return type
}
async function classifyRagServices() {
  let state = {}
  try { state = existsSync(ACTIVE_SERVICES_FILE) ? JSON.parse(readFileSync(ACTIVE_SERVICES_FILE, 'utf-8')) : {} } catch { state = {} }
  const items = Object.values(state.services || state || {}).filter((s) => s && typeof s === 'object' && s.containerIp && s.port)
  const results = await Promise.all(items.map(async (s) => {
    const endpoint = `http://${s.containerIp}:${s.port}/v1`
    let type = 'llm'
    try { type = await probeServiceType(endpoint) } catch {}
    return { model: s.model || s.name, url: endpoint, containerIp: s.containerIp, port: s.port, type }
  }))
  return { embed: results.filter((r) => r.type === 'embed'), rerank: results.filter((r) => r.type === 'rerank') }
}

export function registerRagRoutes(app, { exec, selfPort }) {
  const MCPJUNGLE_HOST = process.env.MCPJUNGLE_HOST || '127.0.0.1'
  // Bundled AI-Lab MCP Gateway CLI (co-located on this host): dir + binary. Env-overridable.
  // (Was the stale /opt/mcpjungle + PATH=/usr/local/bin from the decommissioned 10.0.0.52 host.)
  const MCPJUNGLE_DIR = process.env.MCPJUNGLE_DIR || '/opt/ai-lab-mcp'
  const MCPJUNGLE_BIN = process.env.MCPJUNGLE_BIN || '/opt/ai-lab-mcp/mcpjungle'
  // JSON body parsing for the codebase-RAG POST routes (docrag/index uses multer instead).
  app.use('/api/ai/rag', express.json({ limit: '10mb' }))

  // ─── RAG support models: Embeddings + Reranker (probe-classified service picker) ───
  app.get('/api/ai/rag/models', async (_req, res) => {
    try {
      const cfg = readRagModels()
      const { embed, rerank } = await classifyRagServices()
      res.json({
        embed: { model: cfg.embedModel || RAG_DEFAULT_EMBED_MODEL, url: cfg.embedUrl || '', isDefault: !cfg.embedModel },
        rerank: { model: cfg.rerankModel || RAG_DEFAULT_RERANK_MODEL, url: cfg.rerankUrl || '', isDefault: !cfg.rerankModel },
        embedServices: embed,
        rerankServices: rerank,
      })
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }) }
  })
  app.put('/api/ai/rag/models', express.json(), (req, res) => {
    try {
      const b = req.body || {}
      const cfg = readRagModels()
      for (const [mk, uk] of [['embedModel', 'embedUrl'], ['rerankModel', 'rerankUrl']]) {
        if (mk in b) {
          if (b[mk]) { cfg[mk] = String(b[mk]); if (b[uk]) cfg[uk] = String(b[uk]) }
          else { delete cfg[mk]; delete cfg[uk] } // cleared -> back to the built-in default
        }
      }
      writeRagModels(cfg)
      res.json({ ok: true, ...cfg })
    } catch (e) { res.status(400).json({ error: String((e && e.message) || e) }) }
  })

  // Bridge-friendly doc upload: AI-Lab's browser reaches the backend over the WS bridge (JSON only),
  // so doc files arrive base64-encoded here, get written to temp files, then handed to runDocRagIndexing
  // exactly like the multer path. (Mirrors the CivitAI key-upload base64 pattern.)
  app.post('/api/ai/docrag/index-b64', express.json({ limit: '120mb' }), (req, res) => {
    const { collection, description, files } = req.body || {}
    if (!collection || !Array.isArray(files) || !files.length) return res.status(400).json({ error: 'collection and files are required' })
    if (docRagJob.active) return res.status(409).json({ error: 'A document indexing job is already running.' })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'docrag-'))
      const written = files.map((f, i) => {
        const safe = (f.name || `file_${i}`).replace(/[^a-zA-Z0-9._-]/g, '_')
        const p = join(dir, `${i}_${safe}`)
        writeFileSync(p, Buffer.from(f.dataB64 || '', 'base64'))
        return { path: p, originalname: f.name || `file_${i}` }
      })
      runDocRagIndexing(written, collection, description)
      res.json({ started: true, collection, fileCount: written.length })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

// ─── Document RAG: browse the AI-Lab container's filesystem + index in place ──
// The backend runs INSIDE CT152 where the NAS pools are mounted, so it lists and reads
// files directly — no upload round-trip from the user's machine.
app.get('/api/ai/docrag/browse', async (req, res) => {
  const DOC_EXT_RE = /\.(pdf|docx|xlsx|txt|md|csv|json|ya?ml|xml|html?|png|jpe?g|webp|gif|bmp)$/i;
  let dir = (typeof req.query.path === 'string' && req.query.path) ? req.query.path : '/nas';
  try {
    dir = pathResolve(dir);
    const ents = await readdir(dir, { withFileTypes: true });
    const dirs = ents
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const files = [];
    for (const e of ents) {
      if (e.isFile() && !e.name.startsWith('.') && DOC_EXT_RE.test(e.name)) {
        let size = 0; try { size = (await stat(join(dir, e.name))).size; } catch {}
        files.push({ name: e.name, path: join(dir, e.name), size });
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({ path: dir, parent: dir === '/' ? null : dirname(dir), dirs, files });
  } catch (err) {
    const msg = err.code === 'ENOENT' ? 'Folder not found'
      : err.code === 'EACCES' ? 'Permission denied' : err.message;
    res.status(400).json({ error: msg, path: dir });
  }
});

// Index files that already live on the container (selected via /docrag/browse). Reads them
// in place; keepSource:true so the shared cleanup never unlinks the user's real files.
app.post('/api/ai/docrag/index-paths', express.json({ limit: '2mb' }), async (req, res) => {
  const { collection, description, paths } = req.body || {};
  if (!collection || !Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'collection and paths are required' });
  if (docRagJob.active) return res.status(409).json({ error: 'A document indexing job is already running.' });
  const files = [];
  for (const p of paths) {
    try { const s = await stat(p); if (s.isFile()) files.push({ path: p, originalname: basename(p) }); } catch {}
  }
  if (!files.length) return res.status(400).json({ error: 'none of the given paths are readable files on the container' });
  runDocRagIndexing(files, collection, description, { keepSource: true });
  res.json({ started: true, collection, fileCount: files.length });
});

// ─── Codebase RAG (async indexing with progress) ────────────────────────────

/** Run mcpjungle CLI with a custom timeout */
async function mcpjungleCliLong(cmd, timeout = 60000) {
  const result = await exec(MCPJUNGLE_HOST, `cd ${MCPJUNGLE_DIR} && ${MCPJUNGLE_BIN} ${cmd} 2>&1`, { timeout });
  return (result.stdout || '') + (result.stderr || '');
}

function parseMcpToolResponse(output) {
  const textMatch = output.match(/\*\* Content \[text\] \*\*\n([\s\S]+)/);
  return textMatch ? textMatch[1].trim() : output;
}

// ── RAG Indexing Job State (in-memory, one job at a time) ───
const ragJob = {
  active: false,
  phase: '',       // cloning, scanning, embedding, done, error
  progress: 0,     // 0-100
  detail: '',      // human-readable status line
  result: null,    // final result on success
  error: null,     // error message on failure
  collection: '',
  url: '',
};

// ── RAG Queue (FIFO) ��─
const ragQueue = [];  // { type: 'index'|'update', url, collection, description, branch }
let ragAutoSyncTimer = null;

function ragStatus() {
  return {
    active: ragJob.active,
    phase: ragJob.phase,
    progress: ragJob.progress,
    detail: ragJob.detail,
    result: ragJob.result,
    error: ragJob.error,
    collection: ragJob.collection,
    url: ragJob.url,
    queue: ragQueue.map(q => ({ type: q.type, collection: q.collection, url: q.url })),
    queueLength: ragQueue.length,
  };
}

/** Process next item in the RAG queue */
function processRagQueue() {
  if (ragJob.active || ragQueue.length === 0) return;
  const next = ragQueue.shift();
  console.log(`[rag-queue] Processing: ${next.type} ${next.collection} (${ragQueue.length} remaining)`);
  if (next.type === 'update') {
    runRagUpdate(next.collection);
  } else {
    runRagIndexing(next.url, next.collection, next.description, next.branch);
  }
}

/** Watch for job completion and process queue */
function watchRagQueue() {
  const check = setInterval(() => {
    if (!ragJob.active && ragQueue.length > 0) {
      processRagQueue();
    }
  }, 3000);
  return check;
}
const ragQueueWatcher = watchRagQueue();

// ── File extension → language map ───
const RAG_LANG_MAP = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++',
  '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift',
  '.sh': 'Shell', '.bash': 'Shell', '.sql': 'SQL',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.vue': 'Vue',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
  '.md': 'Markdown', '.tf': 'Terraform', '.proto': 'Protobuf',
  '.graphql': 'GraphQL', '.svelte': 'Svelte', '.dart': 'Dart',
  '.kt': 'Kotlin', '.scala': 'Scala', '.ex': 'Elixir', '.zig': 'Zig',
  '.lua': 'Lua', '.r': 'R', '.jl': 'Julia', '.hs': 'Haskell',
};

const RAG_SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.zip', '.tar', '.gz',
  '.exe', '.dll', '.so', '.o', '.a', '.woff', '.woff2', '.ttf',
  '.pyc', '.class', '.wasm', '.lock', '.min.js', '.min.css', '.map',
]);

const RAG_SKIP_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'poetry.lock', 'go.sum', 'LICENSE', 'LICENSE.md', 'LICENSE.txt',
]);

function sanitizeCollectionName(name) {
  return 'codebase_' + name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

/** Chunk a file's content into overlapping pieces */
function chunkFileContent(content, filePath, language) {
  const CHUNK_SIZE = 1500;  // ~1000-1200 tokens max, safe for 2048 token embed limit
  const OVERLAP = 150;
  const header = `// File: ${filePath}\n`;
  const chunks = [];
  if (content.length <= CHUNK_SIZE) {
    chunks.push({ text: header + content, filePath, language });
  } else {
    let offset = 0, idx = 0;
    while (offset < content.length) {
      const end = Math.min(offset + CHUNK_SIZE, content.length);
      chunks.push({ text: header + content.slice(offset, end), filePath, language, chunkIndex: idx });
      if (end >= content.length) break; // Last chunk — done
      offset = end - OVERLAP;
      idx++;
    }
  }
  return chunks;
}

// ── Checkpoint helpers for resumable indexing ──
async function writeCheckpoint(colName, data) {
  const jsonStr = JSON.stringify(data);
  const b64 = Buffer.from(jsonStr).toString('base64');
  const cpPath = `/opt/mcp-codebase-rag/data/${colName}_checkpoint.json`;
  // For large checkpoints (>50KB base64), write in chunks to avoid arg length limits
  if (b64.length > 50000) {
    const CHUNK = 40000;
    for (let i = 0; i < b64.length; i += CHUNK) {
      const slice = b64.slice(i, i + CHUNK);
      const op = i === 0 ? '>' : '>>';
      await exec(MCPJUNGLE_HOST,
        `printf '%s' '${slice}' ${op} /tmp/_cp_${colName}.b64`,
        { timeout: 10000 });
    }
    await exec(MCPJUNGLE_HOST,
      `base64 -d /tmp/_cp_${colName}.b64 > ${cpPath} && rm -f /tmp/_cp_${colName}.b64`,
      { timeout: 10000 });
  } else {
    await exec(MCPJUNGLE_HOST,
      `echo '${b64}' | base64 -d > ${cpPath}`,
      { timeout: 10000 });
  }
}

async function readCheckpoint(colName) {
  const result = await exec(MCPJUNGLE_HOST,
    `cat /opt/mcp-codebase-rag/data/${colName}_checkpoint.json 2>/dev/null || echo "null"`,
    { timeout: 10000 });
  try { return JSON.parse(result.stdout); } catch { return null; }
}

async function deleteCheckpoint(colName) {
  await exec(MCPJUNGLE_HOST,
    `rm -f /opt/mcp-codebase-rag/data/${colName}_checkpoint.json`,
    { timeout: 10000 }).catch(() => {});
}

async function listCheckpoints() {
  const result = await exec(MCPJUNGLE_HOST,
    `for f in /opt/mcp-codebase-rag/data/*_checkpoint.json; do [ -f "$f" ] && cat "$f"; echo "___SEP___"; done`,
    { timeout: 15000 });
  return (result.stdout || '').split('___SEP___').filter(s => s.trim()).map(s => {
    try { return JSON.parse(s.trim()); } catch { return null; }
  }).filter(Boolean);
}

/** Run the full indexing pipeline asynchronously (streaming — no full accumulation) */
async function runRagIndexing(url, collection, description, branch, resume = false) {
  const colName = sanitizeCollectionName(collection);
  ragJob.active = true;
  ragJob.phase = resume ? 'resuming' : 'cloning';
  ragJob.progress = 0;
  ragJob.detail = resume ? 'Resuming — re-cloning repository...' : 'Cloning repository...';
  ragJob.result = null;
  ragJob.error = null;
  ragJob.collection = collection;
  ragJob.url = url;

  // Load checkpoint data for resume
  let checkpoint = null;
  if (resume) {
    checkpoint = await readCheckpoint(colName);
    if (!checkpoint) {
      ragJob.phase = 'error';
      ragJob.error = 'No checkpoint found for this collection.';
      ragJob.detail = ragJob.error;
      ragJob.active = false;
      return;
    }
    console.log(`[rag] Resuming ${url} as ${colName} — ${checkpoint.completedFiles?.length || 0} files already done`);
  } else {
    console.log(`[rag] Indexing ${url} as ${colName}`);
  }

  let tmpDir = '';
  try {
    // ── Phase 1: Clone via SSH on MCPJungle ──
    tmpDir = `/tmp/codebase-rag-${Date.now()}`;
    const branchArg = branch ? `--branch ${branch}` : '';
    const cloneResult = await exec(MCPJUNGLE_HOST,
      `git clone --depth 1 ${branchArg} "${url}" "${tmpDir}" 2>&1 && echo "__CLONE_OK__"`,
      { timeout: 120000 });
    const cloneOut = (cloneResult.stdout || '') + (cloneResult.stderr || '');
    if (!cloneOut.includes('__CLONE_OK__')) {
      throw new Error(`Failed to clone repository: ${cloneOut.slice(0, 300)}`);
    }
    ragJob.progress = 10;
    ragJob.detail = 'Repository cloned. Scanning files...';

    // ── Phase 2: Scan files remotely ──
    ragJob.phase = 'scanning';
    const scanResult = await exec(MCPJUNGLE_HOST,
      `find "${tmpDir}" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/vendor/*' -not -path '*/.next/*' | head -5000`,
      { timeout: 30000 });
    const allFiles = (scanResult.stdout || '').trim().split('\n').filter(f => f);

    const codeFiles = allFiles.filter(f => {
      const name = f.split('/').pop();
      if (RAG_SKIP_NAMES.has(name)) return false;
      const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (RAG_SKIP_EXTS.has(ext)) return false;
      if (!ext && !['Makefile', 'Dockerfile', 'Rakefile', 'Gemfile', 'Procfile'].includes(name)) return false;
      return true;
    });

    if (codeFiles.length === 0) {
      throw new Error('No indexable code files found in repository.');
    }

    // Build set of already-completed files (for resume)
    const completedSet = new Set(checkpoint?.completedFiles || []);
    const pendingFiles = resume
      ? codeFiles.filter(f => !completedSet.has(f.replace(tmpDir + '/', '')))
      : codeFiles;

    if (resume) {
      console.log(`[rag] Resume: ${completedSet.size} files already done, ${pendingFiles.length} remaining`);
      ragJob.progress = 15;
      ragJob.detail = `Found ${codeFiles.length} files (${completedSet.size} already indexed). Resuming...`;
    } else {
      ragJob.progress = 15;
      ragJob.detail = `Found ${codeFiles.length} code files. Creating collection...`;
    }
    console.log(`[rag] ${codeFiles.length} code files found`);

    // ── Phase 3: Create collection in vector DBs (skip on resume — already exists) ──
    ragJob.phase = 'embedding';
    if (!resume) {
      try {
        const createResp = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: colName, dimension: 4096 }),
          signal: AbortSignal.timeout(30000),
        });
        const createText = await createResp.text().catch(() => '');
        if (!createResp.ok) {
          console.warn(`[rag] Collection create returned ${createResp.status}: ${createText.slice(0, 200)}`);
        }
      } catch (e) {
        console.warn(`[rag] Collection create error (may already exist): ${e.message}`);
      }
    }

    // ── Phase 4: Stream — read batch → chunk → embed → upsert → discard ──
    const READ_BATCH = 20;   // Files read per SSH call
    const EMBED_BATCH = 16;  // Chunks embedded per API call
    const languageCounts = resume ? { ...(checkpoint.languageCounts || {}) } : {};
    let filesRead = resume ? (checkpoint.filesRead || 0) : 0;
    let totalChunks = 0;
    let upsertedCount = resume ? (checkpoint.upsertedCount || 0) : 0;
    let embedErrors = 0;
    const allRelPaths = codeFiles.map(f => f.replace(tmpDir + '/', ''));

    // Initialize checkpoint on fresh start
    if (!resume) {
      await writeCheckpoint(colName, {
        collection: colName, url, branch: branch || '',
        description: description || '', allFiles: allRelPaths,
        completedFiles: [], filesRead: 0, upsertedCount: 0,
        languageCounts: {}, startedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      }).catch(e => console.warn(`[rag] Checkpoint init failed: ${e.message}`));
    }

    for (let i = 0; i < pendingFiles.length; i += READ_BATCH) {
      const batch = pendingFiles.slice(i, i + READ_BATCH);

      // Read this batch of files via SSH
      const catCmd = batch.map(f => {
        const relPath = f.replace(tmpDir + '/', '');
        return `echo "===FILE_START===${relPath}==="; cat "${f}" 2>/dev/null; echo "===FILE_END==="`;
      }).join('; ');

      let batchChunks = [];
      const batchCompletedPaths = [];
      try {
        const catResult = await exec(MCPJUNGLE_HOST, catCmd, { timeout: 30000 });
        const output = catResult.stdout || '';
        const fileBlocks = output.split('===FILE_START===').filter(b => b.trim());

        for (const block of fileBlocks) {
          const headerEnd = block.indexOf('===\n');
          if (headerEnd < 0) continue;
          const relPath = block.slice(0, headerEnd).trim();
          const endIdx = block.indexOf('===FILE_END===');
          const content = endIdx > 0 ? block.slice(headerEnd + 4, endIdx) : block.slice(headerEnd + 4);

          if (!content.trim() || content.includes('\0') || content.length > 512 * 1024) {
            batchCompletedPaths.push(relPath); // Skip but mark as done
            continue;
          }

          const ext = (relPath.match(/\.[^.]+$/) || [''])[0].toLowerCase();
          const language = RAG_LANG_MAP[ext] || 'Other';
          languageCounts[language] = (languageCounts[language] || 0) + 1;

          const chunks = chunkFileContent(content, relPath, language);
          for (const chunk of chunks) {
            batchChunks.push({
              id: `${colName}::${chunk.filePath}::${chunk.chunkIndex || 0}`,
              text: chunk.text,
              metadata: { file_path: chunk.filePath, language: chunk.language, repo_url: url, collection: colName },
            });
          }
          filesRead++;
          batchCompletedPaths.push(relPath);
        }
      } catch (e) {
        console.warn(`[rag] File read batch ${i} failed: ${e.message}`);
      }

      // Embed and upsert this batch immediately, then discard
      for (let j = 0; j < batchChunks.length; j += EMBED_BATCH) {
        const embedBatch = batchChunks.slice(j, j + EMBED_BATCH);
        try {
          // Truncate any chunks that might exceed token limit (safety net)
          const truncatedTexts = embedBatch.map(c => c.text.length > 5000 ? c.text.slice(0, 5000) : c.text);
          const embedResp = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/embed/v1/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: effEmbedModel(), input: truncatedTexts }),
            signal: AbortSignal.timeout(120000),
          });

          if (!embedResp.ok) {
            const errBody = await embedResp.text().catch(() => '');
            embedErrors++;
            if (embedErrors >= 5) throw new Error(`Embedding model returned ${embedResp.status} on 5 consecutive batches. Server may be down. Last error: ${errBody.slice(0, 200)}`);
            console.warn(`[rag] Embed batch failed (${embedErrors}/5): HTTP ${embedResp.status} - ${errBody.slice(0, 150)}`);
            continue;
          }
          embedErrors = 0;

          const embedData = await embedResp.json();
          const embeddings = (embedData.data || []).map(d => d.embedding);

          if (!embeddings.length || !embeddings[0]?.length) {
            embedErrors++;
            if (embedErrors >= 5) throw new Error('Embedding model returned empty vectors on 5 consecutive batches. Check the embedding server.');
            console.warn(`[rag] Empty embeddings (${embedErrors}/5)`);
            continue;
          }

          const points = embedBatch.map((c, idx) => ({
            id: c.id,
            vector: embeddings[idx],
            metadata: { text: c.text, ...c.metadata },
          }));

          const upsertResp = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}/upsert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points }),
            signal: AbortSignal.timeout(60000),
          });
          await upsertResp.text().catch(() => {}); // Consume response body to free memory
          upsertedCount += embedBatch.length;

        } catch (e) {
          if (e.message.includes('Embedding model')) throw e;
          console.warn(`[rag] Embed/upsert batch failed: ${e.message}`);
        }
      }

      totalChunks += batchChunks.length;
      batchChunks = null; // Free memory immediately

      // Update checkpoint with newly completed files
      for (const p of batchCompletedPaths) completedSet.add(p);
      await writeCheckpoint(colName, {
        collection: colName, url, branch: branch || '',
        description: description || '', allFiles: allRelPaths,
        completedFiles: [...completedSet], filesRead, upsertedCount,
        languageCounts, startedAt: checkpoint?.startedAt || new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      }).catch(e => console.warn(`[rag] Checkpoint write failed: ${e.message}`));

      const doneFiles = completedSet.size;
      const pct = 20 + Math.round((doneFiles / codeFiles.length) * 70);
      ragJob.progress = Math.min(pct, 92);
      const resumeNote = resume ? ` (${checkpoint.completedFiles?.length || 0} previously indexed)` : '';
      ragJob.detail = `Processing: ${doneFiles}/${codeFiles.length} files${resumeNote}, ${upsertedCount} chunks indexed`;
      if (i % (READ_BATCH * 5) === 0 || i + READ_BATCH >= pendingFiles.length) {
        console.log(`[rag] Progress: ${doneFiles}/${codeFiles.length} files, ${upsertedCount} chunks, ${ragJob.progress}%`);
      }
    }

    if (upsertedCount === 0 && totalChunks === 0 && !resume) {
      throw new Error('No readable code content found after scanning files.');
    }

    // ── Phase 5: Update MCP server manifest via SSH ──
    ragJob.progress = 95;
    ragJob.detail = 'Updating collection manifest...';
    const manifestData = {
      name: colName, display_name: collection, description: description || '',
      embed_model: effEmbedModel(), repo_url: url, branch: branch || 'default', files_indexed: filesRead,
      chunks_created: upsertedCount, languages: languageCounts,
      indexed_at: new Date().toISOString(),
    };
    const manifestB64 = Buffer.from(JSON.stringify(manifestData)).toString('base64');
    await exec(MCPJUNGLE_HOST,
      `mkdir -p /opt/mcp-codebase-rag/data && node -e "
        const fs = require('fs'), p = '/opt/mcp-codebase-rag/data/collections.json';
        let m = []; try { m = JSON.parse(fs.readFileSync(p,'utf-8')); } catch {}
        const entry = JSON.parse(Buffer.from('${manifestB64}','base64').toString());
        const idx = m.findIndex(c => c.name === entry.name);
        if (idx >= 0) m[idx] = entry; else m.push(entry);
        fs.writeFileSync(p, JSON.stringify(m, null, 2));
        console.log('manifest updated');
      "`, { timeout: 10000 }).catch(e => console.warn(`[rag] Manifest update failed: ${e.message}`));

    // ── Phase 6: Preserve clone for incremental updates ──
    const repoDir = `/opt/mcp-codebase-rag/data/repos/${colName}`;
    await exec(MCPJUNGLE_HOST,
      `rm -rf "${repoDir}" && mv "${tmpDir}" "${repoDir}"`,
      { timeout: 30000 }).catch(() => {
        // Fallback: if move fails, clean up tmp
        exec(MCPJUNGLE_HOST, `rm -rf "${tmpDir}"`, { timeout: 15000 }).catch(() => {});
      });

    // Delete checkpoint on successful completion
    await deleteCheckpoint(colName);
    console.log(`[rag] Checkpoint deleted for ${colName} (indexing complete)`);

    ragJob.phase = 'done';
    ragJob.progress = 100;
    ragJob.detail = `Indexed ${filesRead} files (${upsertedCount} chunks)`;
    ragJob.result = {
      collection: colName, files_indexed: filesRead,
      chunks_created: upsertedCount, repo_url: url, languages: languageCounts,
    };
  } catch (e) {
    ragJob.phase = 'error';
    ragJob.progress = 0;
    ragJob.error = e.message;
    ragJob.detail = `Error: ${e.message}`;
    // Preserve partial progress — checkpoint file stays for resume
    // Only clean up the temporary clone directory
    console.warn(`[rag] Indexing failed for ${colName}: ${e.message} — checkpoint preserved for resume`);
    // Keep clone for resume — move to persistent dir if possible
    if (tmpDir) {
      const repoDir = `/opt/mcp-codebase-rag/data/repos/${colName}`;
      await exec(MCPJUNGLE_HOST,
        `[ ! -d "${repoDir}" ] && mv "${tmpDir}" "${repoDir}" || rm -rf "${tmpDir}"`,
        { timeout: 15000 }).catch(() => {});
    }
  } finally {
    ragJob.active = false;
    setTimeout(processRagQueue, 500);
  }
}

app.post('/api/ai/rag/index', (req, res) => {
  const { url, collection, description, branch } = req.body || {};
  if (!url || !collection) return res.status(400).json({ error: 'url and collection are required' });
  if (ragJob.active) {
    // Queue it instead of rejecting
    ragQueue.push({ type: 'index', url, collection, description, branch });
    return res.json({ queued: true, collection, url, position: ragQueue.length });
  }
  runRagIndexing(url, collection, description, branch);
  res.json({ started: true, collection, url });
});

app.get('/api/ai/rag/index/status', (req, res) => {
  res.json(ragStatus());
});

app.get('/api/ai/rag/collections', async (req, res) => {
  try {
    const result = await exec(MCPJUNGLE_HOST,
      'cat /opt/mcp-codebase-rag/data/collections.json 2>/dev/null || echo "[]"',
      { timeout: 10000 });
    try { res.json(JSON.parse(result.stdout || '[]')); } catch { res.json([]); }
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/ai/rag/collections/:name', async (req, res) => {
  const colName = req.params.name;
  try {
    // Delete from all vector DBs via proxy (name is already the full collection name e.g. codebase_xxx)
    const delResp = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(30000),
    });
    const delData = await delResp.json().catch(() => ({}));

    // Remove from MCPJungle manifest
    await exec(MCPJUNGLE_HOST,
      `node -e "
        const fs = require('fs'), p = '/opt/mcp-codebase-rag/data/collections.json';
        let m = []; try { m = JSON.parse(fs.readFileSync(p,'utf-8')); } catch {}
        m = m.filter(c => c.name !== '${colName}');
        fs.writeFileSync(p, JSON.stringify(m, null, 2));
        console.log('removed');
      "`, { timeout: 10000 }).catch(() => {});

    res.json({ deleted: colName, vector_db_results: delData });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Resume / Checkpoint routes ──

app.get('/api/ai/rag/checkpoints', async (req, res) => {
  try {
    const checkpoints = await listCheckpoints();
    res.json(checkpoints.map(cp => ({
      collection: cp.collection,
      displayName: (cp.collection || '').replace(/^codebase_/, ''),
      url: cp.url,
      branch: cp.branch,
      description: cp.description,
      filesTotal: cp.allFiles?.length || 0,
      filesCompleted: cp.completedFiles?.length || 0,
      upsertedCount: cp.upsertedCount || 0,
      lastUpdated: cp.lastUpdated,
    })));
  } catch (e) { res.json([]); }
});

app.post('/api/ai/rag/resume', async (req, res) => {
  if (ragJob.active) return res.status(409).json({ error: 'A job is already running.' });
  const { collection } = req.body || {};
  if (!collection) return res.status(400).json({ error: 'collection is required' });
  const colName = collection.startsWith('codebase_') ? collection : sanitizeCollectionName(collection);
  const checkpoint = await readCheckpoint(colName);
  if (!checkpoint) return res.status(404).json({ error: 'No checkpoint found for this collection' });
  const displayName = colName.replace(/^codebase_/, '');
  runRagIndexing(checkpoint.url, displayName, checkpoint.description, checkpoint.branch, true);
  res.json({ resumed: true, collection: colName, filesRemaining: (checkpoint.allFiles?.length || 0) - (checkpoint.completedFiles?.length || 0) });
});

app.delete('/api/ai/rag/checkpoints/:name', async (req, res) => {
  const colName = req.params.name;
  try {
    await deleteCheckpoint(colName);
    // Also delete partial collection from vector DBs
    await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}`, {
      method: 'DELETE', signal: AbortSignal.timeout(30000),
    }).catch(() => {});
    // Remove from manifest if present
    await exec(MCPJUNGLE_HOST,
      `node -e "const fs=require('fs'),p='/opt/mcp-codebase-rag/data/collections.json';let m=[];try{m=JSON.parse(fs.readFileSync(p,'utf-8'))}catch{}m=m.filter(c=>c.name!=='${colName}');fs.writeFileSync(p,JSON.stringify(m,null,2))"`,
      { timeout: 10000 }).catch(() => {});
    res.json({ deleted: colName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ai/rag/collections/:name/stats', async (req, res) => {
  try {
    const result = await exec(MCPJUNGLE_HOST,
      `node -e "
        const fs = require('fs'), p = '/opt/mcp-codebase-rag/data/collections.json';
        let m = []; try { m = JSON.parse(fs.readFileSync(p,'utf-8')); } catch {}
        const c = m.find(c => c.name === '${req.params.name}');
        console.log(JSON.stringify(c || {error: 'not found'}));
      "`, { timeout: 10000 });
    try { res.json(JSON.parse(result.stdout || '{}')); } catch { res.json({}); }
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Document RAG Indexing ─────────────────────────────────────────────────────

const DOC_RAG_MANIFEST = '/opt/mcp-document-rag/data/collections.json';

const docUpload = multer({
  dest: '/tmp/docrag-uploads/',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(pdf|docx|xlsx|png|jpg|jpeg|webp|gif|bmp|txt|md|csv|json|yaml|yml|xml|html)$/i;
    cb(null, allowed.test(file.originalname));
  },
});

const docRagJob = {
  active: false, phase: '', progress: 0, detail: '',
  result: null, error: null, collection: '', fileCount: 0,
};

function docRagStatus() {
  return {
    active: docRagJob.active, phase: docRagJob.phase, progress: docRagJob.progress,
    detail: docRagJob.detail, result: docRagJob.result, error: docRagJob.error,
    collection: docRagJob.collection, fileCount: docRagJob.fileCount,
  };
}

function sanitizeDocCollectionName(name) {
  return 'docs_' + name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.html']);

/** Chunk text content into overlapping pieces for embedding */
function chunkDocText(text, fileName, fileType, extraMeta) {
  const CHUNK_SIZE = 1500;
  const OVERLAP = 150;
  const chunks = [];
  const cleanText = text.replace(/\0/g, '').trim();
  if (!cleanText) return chunks;

  if (cleanText.length <= CHUNK_SIZE) {
    chunks.push({ text: cleanText, ...extraMeta, file_name: fileName, file_type: fileType, chunk_index: 0 });
  } else {
    let offset = 0, idx = 0;
    while (offset < cleanText.length) {
      const end = Math.min(offset + CHUNK_SIZE, cleanText.length);
      chunks.push({ text: cleanText.slice(offset, end), ...extraMeta, file_name: fileName, file_type: fileType, chunk_index: idx });
      if (end >= cleanText.length) break;
      offset = end - OVERLAP;
      idx++;
    }
  }
  return chunks;
}

/** Extract text from a file based on its type. Returns array of { text, page_number? } */
async function extractDocContent(filePath, originalName) {
  const ext = extname(originalName).toLowerCase();

  if (ext === '.pdf') {
    const buffer = await readFileAsync(filePath);
    const data = await pdfParse(buffer);
    // Split by page markers or just return full text
    const pages = (data.text || '').split(/\f/); // form-feed = page break
    return pages.map((text, i) => ({ text: text.trim(), page_number: i + 1 })).filter(p => p.text);
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return [{ text: result.value || '' }];
  }

  if (ext === '.xlsx') {
    const buffer = await readFileAsync(filePath);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const pages = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) pages.push({ text: `Sheet: ${sheetName}\n${csv}`, page_number: pages.length + 1 });
    }
    return pages;
  }

  if (IMAGE_EXTS.has(ext)) {
    return [{ text: null, isImage: true }]; // Signal for multimodal embedding
  }

  if (TEXT_EXTS.has(ext)) {
    const content = await readFileAsync(filePath, 'utf-8');
    return [{ text: content }];
  }

  return [];
}

async function runDocRagIndexing(files, collection, description, opts = {}) {
  const colName = sanitizeDocCollectionName(collection);
  const port = selfPort;
  docRagJob.active = true;
  docRagJob.phase = 'processing';
  docRagJob.progress = 0;
  docRagJob.detail = `Processing ${files.length} files...`;
  docRagJob.result = null;
  docRagJob.error = null;
  docRagJob.collection = collection;
  docRagJob.fileCount = files.length;
  console.log(`[docrag] Indexing ${files.length} files as ${colName}`);

  try {
    // Create collection in all vector DBs
    try {
      await fetch(`http://127.0.0.1:${port}/api/proxy/vector/all/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: colName, dimension: 4096 }),
        signal: AbortSignal.timeout(30000),
      }).then(r => r.text().catch(() => ''));
    } catch (e) {
      console.warn(`[docrag] Collection create warning: ${e.message}`);
    }

    const EMBED_BATCH = 16;
    let upsertedCount = 0;
    let embedErrors = 0;
    const fileTypes = {};
    let filesProcessed = 0;

    for (const file of files) {
      const origName = file.originalname;
      const ext = extname(origName).toLowerCase();
      const typeKey = IMAGE_EXTS.has(ext) ? 'image' : ext.replace('.', '');
      fileTypes[typeKey] = (fileTypes[typeKey] || 0) + 1;

      try {
        const contents = await extractDocContent(file.path, origName);

        // Collect chunks for this file
        const fileChunks = [];
        for (const part of contents) {
          if (part.isImage) {
            // Image — embed via multimodal messages format (one at a time)
            const imgBuffer = await readFileAsync(file.path);
            const b64 = imgBuffer.toString('base64');
            const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
            const mime = mimeMap[ext] || 'image/png';

            try {
              const embedResp = await fetch(`http://127.0.0.1:${port}/api/proxy/embed/v1/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: effEmbedModel(),
                  messages: [{ role: 'user', content: [
                    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
                  ] }],
                  encoding_format: 'float',
                }),
                signal: AbortSignal.timeout(120000),
              });
              if (embedResp.ok) {
                const embedData = await embedResp.json();
                const vector = embedData.data?.[0]?.embedding;
                if (vector?.length) {
                  const point = {
                    id: `${colName}::${origName}::img::0`,
                    vector,
                    metadata: { text: `[image: ${origName}]`, file_name: origName, file_type: 'image', collection: colName },
                  };
                  await fetch(`http://127.0.0.1:${port}/api/proxy/vector/all/collections/${colName}/upsert`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ points: [point] }),
                    signal: AbortSignal.timeout(60000),
                  }).then(r => r.text().catch(() => ''));
                  upsertedCount++;
                }
              } else {
                console.warn(`[docrag] Image embed failed for ${origName}: HTTP ${embedResp.status}`);
              }
            } catch (e) {
              console.warn(`[docrag] Image embed error for ${origName}: ${e.message}`);
            }
          } else {
            // Text content — chunk it
            const extra = part.page_number != null ? { page_number: part.page_number } : {};
            const chunks = chunkDocText(part.text, origName, typeKey, extra);
            fileChunks.push(...chunks);
          }
        }

        // Embed text chunks in batches
        for (let j = 0; j < fileChunks.length; j += EMBED_BATCH) {
          const batch = fileChunks.slice(j, j + EMBED_BATCH);
          try {
            const truncated = batch.map(c => c.text.length > 5000 ? c.text.slice(0, 5000) : c.text);
            const embedResp = await fetch(`http://127.0.0.1:${port}/api/proxy/embed/v1/embeddings`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: effEmbedModel(), input: truncated }),
              signal: AbortSignal.timeout(120000),
            });

            if (!embedResp.ok) {
              embedErrors++;
              if (embedErrors >= 5) throw new Error(`Embedding model returned ${embedResp.status} on 5 consecutive batches`);
              continue;
            }
            embedErrors = 0;
            const embedData = await embedResp.json();
            const embeddings = (embedData.data || []).map(d => d.embedding);

            if (!embeddings.length || !embeddings[0]?.length) {
              embedErrors++;
              if (embedErrors >= 5) throw new Error('Empty vectors on 5 consecutive batches');
              continue;
            }

            const points = batch.map((c, idx) => ({
              id: `${colName}::${c.file_name}::${c.page_number != null ? 'p' + c.page_number : 'c'}::${c.chunk_index}`,
              vector: embeddings[idx],
              metadata: { text: c.text, file_name: c.file_name, file_type: c.file_type, page_number: c.page_number || null, chunk_index: c.chunk_index, collection: colName },
            }));

            await fetch(`http://127.0.0.1:${port}/api/proxy/vector/all/collections/${colName}/upsert`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ points }),
              signal: AbortSignal.timeout(60000),
            }).then(r => r.text().catch(() => ''));
            upsertedCount += batch.length;
          } catch (e) {
            if (e.message.includes('consecutive batches')) throw e;
            console.warn(`[docrag] Embed/upsert batch failed: ${e.message}`);
          }
        }
      } catch (e) {
        if (e.message.includes('consecutive batches')) throw e;
        console.warn(`[docrag] Error processing ${origName}: ${e.message}`);
      }

      filesProcessed++;
      const pct = 10 + Math.round((filesProcessed / files.length) * 80);
      docRagJob.progress = Math.min(pct, 92);
      docRagJob.detail = `Processing: ${filesProcessed}/${files.length} files, ${upsertedCount} chunks indexed`;
    }

    if (upsertedCount === 0) {
      throw new Error('No content could be extracted and embedded from the uploaded files.');
    }

    // Update manifest on MCPJungle
    docRagJob.progress = 95;
    docRagJob.detail = 'Updating collection manifest...';
    const manifestData = {
      name: colName, display_name: collection, description: description || '',
      embed_model: effEmbedModel(), files_indexed: filesProcessed, chunks_created: upsertedCount, file_types: fileTypes,
      indexed_at: new Date().toISOString(),
    };
    const manifestB64 = Buffer.from(JSON.stringify(manifestData)).toString('base64');
    await exec(MCPJUNGLE_HOST,
      `mkdir -p /opt/mcp-document-rag/data && node -e "
        const fs = require('fs'), p = '${DOC_RAG_MANIFEST}';
        let m = []; try { m = JSON.parse(fs.readFileSync(p,'utf-8')); } catch {}
        const entry = JSON.parse(Buffer.from('${manifestB64}','base64').toString());
        const idx = m.findIndex(c => c.name === entry.name);
        if (idx >= 0) m[idx] = entry; else m.push(entry);
        fs.writeFileSync(p, JSON.stringify(m, null, 2));
        console.log('manifest updated');
      "`, { timeout: 10000 }).catch(e => console.warn(`[docrag] Manifest update failed: ${e.message}`));

    docRagJob.phase = 'done';
    docRagJob.progress = 100;
    docRagJob.detail = `Indexed ${filesProcessed} files (${upsertedCount} chunks)`;
    docRagJob.result = {
      collection: colName, files_indexed: filesProcessed,
      chunks_created: upsertedCount, file_types: fileTypes,
    };
  } catch (e) {
    docRagJob.phase = 'error';
    docRagJob.progress = 0;
    docRagJob.error = e.message;
    docRagJob.detail = `Error: ${e.message}`;
    console.warn(`[docrag] Indexing failed for ${colName}: ${e.message}`);
    // Auto-drop partial collection
    try {
      await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}`, {
        method: 'DELETE', signal: AbortSignal.timeout(30000),
      }).then(r => r.text().catch(() => ''));
    } catch {}
    try {
      await exec(MCPJUNGLE_HOST,
        `node -e "const fs=require('fs'),p='${DOC_RAG_MANIFEST}';let m=[];try{m=JSON.parse(fs.readFileSync(p,'utf-8'))}catch{}m=m.filter(c=>c.name!=='${colName}');fs.writeFileSync(p,JSON.stringify(m,null,2))"`,
        { timeout: 10000 });
    } catch {}
  } finally {
    docRagJob.active = false;
    // Clean up temp uploaded files — but NEVER server-browsed source files (keepSource).
    if (!opts.keepSource) for (const file of files) {
      try { await rmAsync(file.path, { force: true }); } catch {}
    }
  }
}

app.post('/api/ai/docrag/index', docUpload.array('files', 50), (req, res) => {
  if (docRagJob.active) return res.status(409).json({ error: 'A document indexing job is already running.', status: docRagStatus() });
  const collection = req.body?.collection;
  const description = req.body?.description || '';
  const files = req.files || [];
  if (!collection) return res.status(400).json({ error: 'collection name is required' });
  if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
  runDocRagIndexing(files, collection, description);
  res.json({ started: true, collection, fileCount: files.length });
});

app.get('/api/ai/docrag/index/status', (req, res) => {
  res.json(docRagStatus());
});

app.get('/api/ai/docrag/collections', async (req, res) => {
  try {
    const result = await exec(MCPJUNGLE_HOST,
      `cat ${DOC_RAG_MANIFEST} 2>/dev/null || echo "[]"`,
      { timeout: 10000 });
    try { res.json(JSON.parse(result.stdout || '[]')); } catch { res.json([]); }
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/ai/docrag/collections/:name', async (req, res) => {
  const colName = req.params.name;
  try {
    const delResp = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}`, {
      method: 'DELETE', signal: AbortSignal.timeout(30000),
    });
    const delData = await delResp.json().catch(() => ({}));
    await exec(MCPJUNGLE_HOST,
      `node -e "
        const fs = require('fs'), p = '${DOC_RAG_MANIFEST}';
        let m = []; try { m = JSON.parse(fs.readFileSync(p,'utf-8')); } catch {}
        m = m.filter(c => c.name !== '${colName}');
        fs.writeFileSync(p, JSON.stringify(m, null, 2));
      "`, { timeout: 10000 }).catch(() => {});
    res.json({ deleted: colName, vector_db_results: delData });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/ai/docrag/collections/:name/stats', async (req, res) => {
  try {
    const result = await exec(MCPJUNGLE_HOST,
      `node -e "
        const fs = require('fs'), p = '${DOC_RAG_MANIFEST}';
        let m = []; try { m = JSON.parse(fs.readFileSync(p,'utf-8')); } catch {}
        const c = m.find(c => c.name === '${req.params.name}');
        console.log(JSON.stringify(c || {error: 'not found'}));
      "`, { timeout: 10000 });
    try { res.json(JSON.parse(result.stdout || '{}')); } catch { res.json({}); }
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── RAG Queue status ──
app.get('/api/ai/rag/queue', (req, res) => {
  res.json({ queue: ragQueue.map(q => ({ type: q.type, collection: q.collection, url: q.url })), length: ragQueue.length });
});

// ── Update-all: re-index every collection that has a repo_url ──
app.post('/api/ai/rag/update-all', async (req, res) => {
  try {
    const manifestResult = await exec(MCPJUNGLE_HOST,
      'cat /opt/mcp-codebase-rag/data/collections.json 2>/dev/null || echo "[]"',
      { timeout: 10000 });
    const manifest = JSON.parse(manifestResult.stdout || '[]');
    let queued = 0;
    for (const col of manifest) {
      if (!col.repo_url) continue;
      ragQueue.push({ type: 'update', collection: col.name });
      queued++;
    }
    if (!ragJob.active && ragQueue.length > 0) processRagQueue();
    res.json({ queued, collections: manifest.map(c => c.name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RAG Auto-Sync Config + scheduler ──
const AUTOSYNC_PATH = join(process.env.AILAB_PROXY_DATA_DIR || '/tmp', 'rag-autosync.json');
// (ragAutoSyncTimer is already declared in the ported body above)
function loadRagAutoSyncConfig() {
  try { if (existsSync(AUTOSYNC_PATH)) return JSON.parse(readFileSync(AUTOSYNC_PATH, 'utf-8')); } catch {}
  return { enabled: false, frequency: 'daily', time: '01:00' };
}
function saveRagAutoSyncConfig(cfg) {
  try { mkdirSync(process.env.AILAB_PROXY_DATA_DIR || '/tmp', { recursive: true }); } catch {}
  writeFileSync(AUTOSYNC_PATH, JSON.stringify(cfg, null, 2));
}
function setupRagAutoSync(cfg) {
  if (ragAutoSyncTimer) { clearInterval(ragAutoSyncTimer); ragAutoSyncTimer = null; }
  if (!cfg.enabled) return;
  ragAutoSyncTimer = setInterval(async () => {
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (hhmm !== (cfg.time || '01:00')) return;
    if (cfg.frequency === 'weekly' && now.getDay() !== 0) return;
    console.log('[rag-autosync] Running scheduled update-all at ' + hhmm);
    try {
      const resp = await fetch('http://127.0.0.1:' + selfPort + '/api/ai/rag/update-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      console.log('[rag-autosync] Queued ' + data.queued + ' collections for update');
    } catch (e) { console.warn('[rag-autosync] Failed:', e.message); }
  }, 60000);
  console.log('[rag-autosync] Scheduled ' + cfg.frequency + ' at ' + cfg.time);
}
app.get('/api/ai/rag/autosync', (req, res) => { res.json(loadRagAutoSyncConfig()); });
app.put('/api/ai/rag/autosync', express.json(), (req, res) => {
  const { enabled, frequency, time } = req.body || {};
  const cfg = { enabled: !!enabled, frequency: frequency || 'daily', time: time || '01:00' };
  saveRagAutoSyncConfig(cfg);
  setupRagAutoSync(cfg);
  res.json(cfg);
});
try { setupRagAutoSync(loadRagAutoSyncConfig()); } catch {}
}
