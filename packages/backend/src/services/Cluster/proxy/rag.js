// Codebase-RAG (/api/ai/rag/*) + Document-RAG (/api/ai/docrag/*) — ported verbatim from ProxLab
// server.js. Indexing engines clone/chunk/embed/upsert via SSH to the RAG host + the local vector/embed
// proxies. sshService.exec -> exec (shim), config.server.port -> selfPort.
/* eslint-disable */
// @ts-nocheck
import express from 'express'
import { emitNotification, emitDebug } from './lib/notify.js';
import { stripLoneSurrogates, embedSafeText } from './lib/text-safety.js';
import multer from 'multer'
import { readFile as readFileAsync, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve as pathResolve, dirname, basename } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, statSync as statSyncFs, readdirSync as readdirSyncFs, rmSync, renameSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

// ─── Embed input safety ──────────────────────────────────────────────────────
// JS string slicing works on UTF-16 CODE UNITS, so truncating at a fixed length can cut a
// surrogate pair in half and leave a LONE surrogate behind. That string serialises into JSON
// fine and passes the embed API's type validation, then dies inside the tokenizer with
// "TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]".
// It is deterministic per chunk, so every retry fails identically — and because the vector
// delete happens BEFORE the re-index, the collection is left EMPTY rather than stale.
// Reproduced exactly (2026-09-16): 4999 chars + one emoji, sliced to 5000, is a guaranteed 400.
// Also strips unpaired surrogates ALREADY present in a malformed source file, which fail the
// same way with no truncation involved, and coerces null/undefined instead of throwing on .length.
// Sanitise WITHOUT truncating — for the stored point payload, which is never sliced and so
// can only carry a lone surrogate that was already in the source file. Qdrant's JSON parser
// REJECTS those ("lone leading surrogate in hex escape"), while weaviate and chromadb accept
// them — so an unsanitised payload makes qdrant silently drop a batch the others keep, and the
// backends diverge by exactly that much. Observed 8 times on 2026-09-16, qdrant-only.
// Deliberately NOT capped: the payload is the text we serve back, and truncating it here to the
// embedding limit would silently shorten stored content.

// Truncate FIRST, then strip — truncation is what creates the dangling half.

// Document extractors are optional — lazy + graceful so codebase-RAG never breaks if they're absent.
let pdfParse, mammoth, XLSX
try { pdfParse = (await import('pdf-parse')).default } catch { pdfParse = async () => { throw new Error('pdf-parse not installed') } }
try { mammoth = await import('mammoth') } catch { mammoth = { extractRawText: async () => { throw new Error('mammoth not installed') } } }
try { const _x = await import('xlsx'); XLSX = _x.default || _x } catch { XLSX = { read: () => { throw new Error('xlsx not installed') }, utils: { sheet_to_csv: () => '' } } }

// ─── RAG embed/reranker model selection (Support Models tab) ──────────────────
const RAG_DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data'
const RAG_MODELS_FILE = join(RAG_DATA_DIR, 'rag-models.json')
const ACTIVE_SERVICES_FILE = join(RAG_DATA_DIR, 'active-services.json')
// Fallback only when rag-models.json is absent. The old value here was the
// RETIRED 4-bit served-name, which the proxy now 404s — a dead fallback fails
// exactly when nobody can see why.
const RAG_DEFAULT_EMBED_MODEL = 'Qwen3-VL-Embedding-8B-FP8'
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
/**
 * One row per MODEL from a universal endpoint's deduplicated pool, not one row per instance.
 *
 * The pickers previously listed every service separately using the registry `model` field, which
 * is the on-disk PATH and therefore identical for every replica of a model -- five embedders
 * rendered as five indistinguishable rows, and choosing one pinned that single instance instead
 * of using the pool. These rows carry the SERVED model id (what actually goes in an API `model`
 * field), the instance count, and the universal URL so the selection load-balances.
 */
async function poolModels(selfPort, kind) {
  const url = `http://127.0.0.1:${selfPort}/api/proxy/${kind}/v1/models`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) return null
    const d = await r.json()
    return (d.data || [])
      // Skip the @N pins -- those address one instance, which is the opposite of what the
      // default-model picker wants. They stay available for anyone who needs to target one.
      .filter((m) => !/@\d+$/.test(m.id))
      .map((m) => ({
        model: m.id,
        url: `http://127.0.0.1:${selfPort}/api/proxy/${kind}/v1`,
        instances: m._proxlab_instances || 1,
        type: kind === 'embed' ? 'embed' : 'rerank',
      }))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Legacy per-instance probe. Retained as the fallback when the proxy cannot be reached, so the
 *  picker degrades to something usable instead of going empty. */
async function classifyRagServices() {
  let state = {}
  try { state = existsSync(ACTIVE_SERVICES_FILE) ? JSON.parse(readFileSync(ACTIVE_SERVICES_FILE, 'utf-8')) : {} } catch { state = {} }
  const items = Object.values(state.services || state || {}).filter((s) => s && typeof s === 'object' && s.containerIp && s.port)
  const results = await Promise.all(items.map(async (s) => {
    const endpoint = `http://${s.containerIp}:${s.port}/v1`
    let type = 'llm'
    try { type = await probeServiceType(endpoint) } catch (e) {
        // A service failing classification silently filed as 'llm' and vanished
        // from the embed/rerank pickers with no record of which endpoint or why.
        console.warn(`[rag] service-type probe failed for ${endpoint} — defaulting to 'llm' (${e?.message})`)
      }
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
      // Prefer the pool view (one row per model, load-balanced); fall back to the per-instance
      // probe only if the proxy is unreachable.
      let embed = await poolModels(selfPort, 'embed')
      let rerank = await poolModels(selfPort, 'rerank')
      if (!embed || !rerank) {
        const legacy = await classifyRagServices()
        if (!embed) embed = legacy.embed
        if (!rerank) rerank = legacy.rerank
      }
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
  // Embedding-space health. Encoder drift degrades recall SILENTLY -- every
  // build in use is dim 4096, so querying a corpus with the wrong encoder can
  // never raise, it just returns worse neighbours. Previously this was only
  // announced in hippo's container boot log, which nobody can see after the
  // fact. ?deep=1 additionally samples vectors to catch degenerate (shared)
  // vectors written by a failing embedder -- costs real bandwidth, so opt-in.
  app.get('/api/ai/rag/embedding-health', async (req, res) => {
    const deep = String(req.query?.deep || '') === '1'
    try {
      const r = await fetch('http://127.0.0.1:9847/rest/embedding-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deep }),
        signal: AbortSignal.timeout(deep ? 180000 : 45000),
      })
      if (!r.ok) return res.status(502).json({ error: `memory MCP HTTP ${r.status}` })
      res.json(await r.json())
    } catch (e) {
      res.status(502).json({ error: String(e?.message || e) })
    }
  })

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

/** The user-supplied per-document fields an upload may carry (anything else is ignored). */
function docFileMeta(f) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const out = { title: str(f?.title, 200), description: str(f?.description, 2000), doc_type: str(f?.doc_type, 60) };
  if (typeof f?.replaceDocId === 'string' && /^[a-f0-9]{6,24}$/.test(f.replaceDocId)) out.replaceDocId = f.replaceDocId;
  return out;
}

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
  // paths: ["/nas/a.pdf", ...] or [{ path, title?, description?, doc_type?, replaceDocId? }, ...]
  const { collection, description, paths, pageImages } = req.body || {};
  if (!collection || !Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'collection and paths are required' });
  if (docRagJob.active) return res.status(409).json({ error: 'A document indexing job is already running.' });
  const files = [];
  for (const item of paths) {
    const p = typeof item === 'string' ? item : item?.path;
    if (typeof p !== 'string') continue;
    try { const s = await stat(p); if (s.isFile()) files.push({ path: p, originalname: basename(p), keep: true, ...(typeof item === 'object' ? docFileMeta(item) : {}) }); } catch {}
  }
  if (!files.length) return res.status(400).json({ error: 'none of the given paths are readable files on the container' });
  runDocRagIndexing(files, collection, description, { keepSource: true, pageImages: pageImages !== false });
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

// ── RAG Queue ──
// FIFO, except that a run someone ASKED for jumps the scheduled ones: Travis queued the SiteMap repo
// for the enterprise instance on 2026-10-27 and it landed behind five nightly refreshes (hours).
// Order: interrupted-run resumes and earlier manual requests stay ahead (FIFO among themselves),
// then the new manual request, then scheduled 'update' runs. The RUNNING job is never preempted.
const ragQueue = [];  // { type: 'index'|'update', url, collection, description, branch, manual?, resume? }
function enqueueManual(item) {
  const at = ragQueue.findIndex((q) => !q.manual && !q.resume);
  const entry = { ...item, manual: true };
  if (at === -1) ragQueue.push(entry); else ragQueue.splice(at, 0, entry);
  return (at === -1 ? ragQueue.length : at + 1);   // 1-based position
}
const queueView = () => ragQueue.map((q) => ({ type: q.type, collection: q.collection, url: q.url, manual: !!q.manual, resume: !!q.resume }));
// Set by POST /rag/index/cancel (Travis, 2026-10-10: a misfired daily update ran for hours during the day
// and the only way to stop it was killing the backend). The indexer checks it between batches; the
// checkpoint is kept so the next scheduled run resumes, and a cancel never triggers the auto-retry.
let ragCancelRequested = false;
class RagCancelled extends Error { constructor() { super('cancelled by user'); this.cancelled = true; } }
// A cancel must survive a backend restart: the startup sweep below re-queues every collection with a
// checkpoint, which is how a cancelled daytime run came straight back after a restart. While this file
// exists the sweep only logs; the scheduled run (or a manual index/update) removes it.
const RAG_HOLD_PATH = join(RAG_DATA_DIR, 'rag-hold.json');
function setRagHold(info) {
  try { writeFileSync(RAG_HOLD_PATH, JSON.stringify({ heldAt: new Date().toISOString(), ...info }, null, 2)); }
  catch (e) { console.warn(`[rag] could not write ${RAG_HOLD_PATH}: ${e.message}`); }
}
function clearRagHold(why) {
  try { if (existsSync(RAG_HOLD_PATH)) { unlinkSync(RAG_HOLD_PATH); console.log(`[rag] hold cleared (${why})`); } }
  catch (e) { console.warn(`[rag] could not clear ${RAG_HOLD_PATH}: ${e.message}`); }
}
function ragHold() {
  try { return existsSync(RAG_HOLD_PATH) ? JSON.parse(readFileSync(RAG_HOLD_PATH, 'utf-8')) : null; }
  catch { return { heldAt: '?' }; }
}

// ── Auto-retry for interrupted indexing ──
// An interruption is usually transient (clone timeout, embedder blip, a backend restart
// mid-run). Falling straight to a manual Resume button meant ~10 collections sat half-indexed
// until someone noticed. Retries RESUME from the existing checkpoint, so each costs only the
// files that were still outstanding.
const RAG_MAX_ATTEMPTS = Number(process.env.AILAB_RAG_MAX_ATTEMPTS || 3);
const RAG_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];   // 30s, 2m, 5m
const ragAttempts = new Map();   // collection -> attempts so far
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
    queue: queueView(),
    queueLength: ragQueue.length,
  };
}

/** Process next item in the RAG queue.
 *
 *  A QUEUE ITEM MUST NEVER KILL THE BACKEND. It used to: `type: 'update'` called
 *  `runRagUpdate`, which is not defined anywhere in the backend, and the resulting
 *  ReferenceError was thrown from inside watchRagQueue's setInterval callback — an
 *  uncaught throw in a timer callback takes the whole Node process down. rag-autosync
 *  queues update items every night at 01:00, so ai-lab.service died nightly (confirmed
 *  2026-08-16 through 2026-08-20) and systemd restarted it ~5s later, which is exactly
 *  why it went unnoticed for weeks. It also meant codebase-RAG auto-update never ran.
 *
 *  So: dispatch by CAPABILITY rather than assuming the handler exists, and contain any
 *  failure to the item that caused it. The item is already shift()ed off the queue
 *  before dispatch, so a bad item is dropped rather than retried forever.
 */
/** Re-index an existing collection from its manifest entry — REPLACE semantics.
 *
 *  Chunk ids are stable (`col::path::idx`), so upserting over the old points
 *  would keep chunks of files that were DELETED from the repo forever; the
 *  honest refresh drops the collection's vectors first and re-indexes from a
 *  fresh clone. The empty-search window equals one indexing run (same as the
 *  initial index) — fine for a nightly job. A mid-run failure leaves the
 *  checkpoint runRagIndexing wrote, so /api/ai/rag/resume can finish it.
 */
/**
 * Days the indexed branch must trail a development branch before it is worth a notification. A
 * judgement call, not a measurement -- low enough to have caught SillyTavern (10 days) and ai-lab (69).
 */
const BRANCH_DRIFT_WARN_DAYS = Number(process.env.AILAB_RAG_BRANCH_DRIFT_DAYS || 7);
/**
 * Commits a branch must be AHEAD of the indexed one to count as "where development lives".
 * Newest-commit-on-any-branch fired on every pushed work branch (maintenance-claude, 2026-10-27:
 * 4 open alerts). A work branch is a handful of commits; the ai-lab incident was 424 (647 by
 * 10-27). 50 sits between them -- also a judgement call.
 */
const BRANCH_DRIFT_MIN_AHEAD = Number(process.env.AILAB_RAG_BRANCH_DRIFT_MIN_AHEAD || 50);
/** Bound on per-branch ahead-count API calls per check (newest candidates first). */
const BRANCH_DRIFT_MAX_PROBES = 10;

/**
 * Warn when a collection is faithfully indexing a branch the repo's development has moved off.
 *
 * WHY THIS EXISTS (2026-09-24): codebase_ai_lab indexes branch "default", which resolves to main,
 * which had not moved since 2026-07-17 while all work happened on claude1/chat-rework -- 424
 * commits and 69 days ahead. Every agent searching that codebase read July code. Nothing in the
 * system reported it, because nothing was broken: the index was a CORRECT index of exactly what
 * it was configured to index. maintenance-claude and I both spent hours on a phantom "RAG is
 * serving deleted files" bug that was only ever this. A silent, correct-looking wrong answer is
 * the defect class this whole project exists for, so it gets a signal.
 *
 * 🛑 ASK THE HOST WHAT "default" RESOLVES TO -- never assume main/master. Of 23 collections, 22
 * use branch:"default", and SillyTavern's default branch is `release`. A heuristic that guesses
 * main/master gets that one wrong, which is the same assumption error this check is about.
 *
 * WHAT COUNTS AS DRIFT (reworked 2026-10-27). The first version compared against the newest
 * commit on ANY branch, so every pushed feature branch looked like "development moved". A branch
 * now counts only when it is >= BRANCH_DRIFT_WARN_DAYS newer AND either
 *   - it is the repo's DEFAULT branch while the collection is pinned elsewhere, or
 *   - it is >= BRANCH_DRIFT_MIN_AHEAD commits ahead of the indexed branch (counted by the host).
 * Gitea PULL MIRRORS are skipped outright: they replay an upstream we do not develop in (the
 * hermes-agent mirror carries ~2,800 upstream branches, 79-commit feature branches among them),
 * which is the same reasoning that already exempts the github-hosted upstreams below.
 *
 * The notification's message holds only stable facts (collection, indexed branch, development
 * branch) so the backend's identical-while-unacked dedup folds a standing condition into ONE row;
 * the day/commit counts change every run and live in `detail`. The old message carried the day
 * count and spawned a fresh row every night.
 *
 * Diagnostic only: never throws, never blocks the refresh. A refresh that works must not be taken
 * down by the thing watching it.
 */
async function checkBranchDrift(colName, repoUrl, requestedBranch) {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(repoUrl || ''));
  if (!m) {
    void emitDebug('rag-branch-drift', `'${colName}': repo_url ${repoUrl} is not owner/repo shaped - drift not checked`);
    return;
  }
  const [, host, owner, repo] = m;
  const api = `http://${host}/api/v1/repos/${owner}/${repo}`;
  try {
    const infoResp = await fetch(api, { signal: AbortSignal.timeout(15000) });
    if (!infoResp.ok) {
      // Non-gitea hosts (github et al) land here. Not a fault, and not a gap worth closing:
      // as of 2026-09-24 all 9 are third-party UPSTREAM repos (esphome, ProxMenux, LightX2V...)
      // where we do not develop, so indexing their default branch is correct by design. Drift
      // risk lives on the repos we commit to, which are exactly the 14 gitea-hosted ones.
      void emitDebug('rag-branch-drift', `'${colName}': ${host} has no gitea API (HTTP ${infoResp.status}) - drift not checked`);
      return;
    }
    const info = await infoResp.json();
    if (info.mirror) {
      void emitDebug('rag-branch-drift', `'${colName}': ${owner}/${repo} is a pull mirror of an upstream - drift not checked`);
      return;
    }
    // The resolved name, NOT the literal "default" the manifest stores.
    const indexed = requestedBranch || info.default_branch;
    const branches = [];
    for (let page = 1; page <= 10; page++) {
      const brResp = await fetch(`${api}/branches?limit=50&page=${page}`, { signal: AbortSignal.timeout(20000) });
      if (!brResp.ok) {
        void emitDebug('rag-branch-drift', `'${colName}': branches API returned ${brResp.status} - drift not checked`);
        return;
      }
      const chunk = await brResp.json();
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      branches.push(...chunk);
      if (chunk.length < 50) break;
    }
    if (branches.length === 0) {
      void emitDebug('rag-branch-drift', `'${colName}': branches API returned nothing usable - drift not checked`);
      return;
    }
    const at = (b) => Date.parse(b?.commit?.timestamp || '') || 0;
    const mine = branches.find((b) => b.name === indexed);
    if (!mine) {
      console.warn(`[rag-branch-drift] '${colName}': indexed branch '${indexed}' is NOT in the repo's branch list`);
      return;
    }
    const daysAhead = (b) => Math.floor((at(b) - at(mine)) / 86400000);
    const candidates = branches
      .filter((b) => b.name !== indexed && daysAhead(b) >= BRANCH_DRIFT_WARN_DAYS)
      .sort((a, b) => at(b) - at(a));
    if (candidates.length === 0) return;                       // nothing meaningfully newer

    // Commits on `branch` that are not on the indexed branch, as counted by the host.
    const aheadCount = async (branch) => {
      const q = `sha=${encodeURIComponent(branch)}&not=${encodeURIComponent(indexed)}&limit=1&stat=false&verification=false&files=false`;
      const r = await fetch(`${api}/commits?${q}`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`commits API ${r.status} for '${branch}'`);
      const n = Number(r.headers.get('x-total-count'));
      if (!Number.isFinite(n)) throw new Error(`no X-Total-Count for '${branch}'`);
      return n;
    };

    let hit = null;
    const def = requestedBranch && candidates.find((b) => b.name === info.default_branch);
    if (def) hit = { branch: def, why: 'the repo default branch', ahead: await aheadCount(def.name).catch(() => null) };
    let probed = 0;
    for (const b of candidates) {
      if (hit) break;
      if (probed >= BRANCH_DRIFT_MAX_PROBES) {
        void emitDebug('rag-branch-drift', `'${colName}': ${candidates.length} newer branches, probed the newest ${probed} - none >= ${BRANCH_DRIFT_MIN_AHEAD} commits ahead`);
        break;
      }
      probed++;
      const n = await aheadCount(b.name);
      if (n >= BRANCH_DRIFT_MIN_AHEAD) hit = { branch: b, why: `${n} commits ahead`, ahead: n };
    }
    if (!hit) return;                                          // only work branches are newer

    const days = daysAhead(hit.branch);
    const how = requestedBranch ? `pinned to '${indexed}'` : `on "default" (= '${indexed}')`;
    console.warn(`[rag-branch-drift] '${colName}': ${how}, ${days}d behind '${hit.branch.name}' (${hit.why})`);
    void emitNotification('warning', 'codebase-rag',
      `Codebase-RAG '${colName}' indexes '${indexed}' but development is on '${hit.branch.name}'`,
      `The collection is ${how}, last commit ${new Date(at(mine)).toISOString().slice(0, 10)}. `
      + `'${hit.branch.name}' is ${hit.why}${hit.ahead != null && !/commits ahead/.test(hit.why) ? ` (${hit.ahead} commits ahead)` : ''}, `
      + `last commit ${new Date(at(hit.branch)).toISOString().slice(0, 10)} -- ${days} days newer. `
      + `The index is CORRECT for what it was told to index -- nothing is broken -- but every agent searching `
      + `'${colName}' is reading code that old. Either repoint the collection at '${hit.branch.name}' or merge that branch.`);
  } catch (e) {
    console.warn(`[rag-branch-drift] '${colName}': drift check failed (${e?.message || e}) - refresh continues`);
  }
}

async function runRagUpdate(collection) {
  const colName = sanitizeCollectionName(collection);
  // Manifest lookup — the collection's repo_url/branch live on the MCP server's manifest.
  let entry = null;
  try {
    const manifestResult = await exec(MCPJUNGLE_HOST,
      'cat /opt/mcp-codebase-rag/data/collections.json 2>/dev/null || echo "[]"',
      { timeout: 10000 });
    const manifest = JSON.parse(manifestResult.stdout || '[]');
    entry = manifest.find(c => c.name === colName) || manifest.find(c => c.name === collection) || null;
  } catch (e) {
    console.warn(`[rag-update] '${colName}': manifest unreadable — skipping this refresh (${e.message})`);
    return;
  }
  if (!entry?.repo_url) {
    // Not an error: collections without a repo_url are indexed-by-hand and
    // update-all's producer already filters them; reaching here means the
    // manifest changed between queueing and processing.
    console.warn(`[rag-update] '${colName}': no manifest entry with a repo_url — skipping`);
    return;
  }
  const branch = entry.branch && entry.branch !== 'default' ? entry.branch : '';

  // PREFLIGHT before anything destructive (m-c's incident, 2026-08-31:
  // delete-then-clone destroyed codebase_proxlab when the repo went private —
  // the clone 404'd AFTER the vectors were gone, and this function's own
  // alert announced the loss it had just caused). ls-remote is cheap, needs
  // no disk, and fails on exactly the class that killed us: unreachable,
  // unauthorized, or deleted upstream.
  //
  // ⚠ RESIDUAL WINDOW (claude1's TOCTOU review, narrowed 2026-10-18): the
  // clone now completes BEFORE the drop (below), so network/clone failures no
  // longer empty a collection. What remains is the indexing phase itself —
  // an embedder/vector-DB failure after the drop leaves a partial collection
  // until checkpoint/resume or the next successful run. The closing fix is
  // stage-and-swap (index into <col>__staging, atomically repoint on
  // success), which needs a rename/alias primitive the vector proxy does not
  // have across its four backends — qdrant has aliases, milvus/weaviate/
  // chroma need per-backend work. If refreshes ever lose a collection
  // through THIS window, build that primitive rather than widening the
  // preflight: a second verification clone would double traffic and still
  // share fate with the real clone seconds later.
  const preflight = await exec(MCPJUNGLE_HOST,
    `GIT_TERMINAL_PROMPT=0 git ls-remote "${entry.repo_url}" HEAD >/dev/null 2>&1 && echo __REACHABLE__ || echo __UNREACHABLE__`,
    { timeout: 30000 });
  if (!(preflight.stdout || '').includes('__REACHABLE__')) {
    console.warn(`[rag-update] '${colName}': repo ${entry.repo_url} is NOT cloneable (auth/404/network) — refresh SKIPPED, existing vectors preserved`);
    void emitNotification('warning', 'codebase-rag',
      'A codebase-RAG refresh was skipped — its repo is not cloneable',
      `Collection '${colName}': git ls-remote failed for ${entry.repo_url} (private repo without credentials, deleted upstream, or network). `
      + `The EXISTING vectors are preserved — search keeps working on the last successful index. `
      + `Fix the repo access (or remove the collection's repo_url) to resume refreshes.`);
    return;
  }

  // Diagnostic, not a gate: a correct index of a stale branch is invisible otherwise.
  await checkBranchDrift(colName, entry.repo_url, branch);

  // CLONE FIRST, DROP SECOND (2026-10-18, m-c alert mvdom1y4-6). The drop used to precede the clone,
  // so a clone that timed out on slow GitHub left codebase_proxmenux EMPTY. Now the full clone must
  // finish before anything is deleted; any clone failure leaves yesterday's index serving.
  const cloneDir = `/tmp/codebase-rag-${Date.now()}`;
  ragJob.phase = 'cloning';
  ragJob.detail = 'Cloning repository (before touching existing vectors)...';
  try {
    await cloneRepoGuarded(entry.repo_url, cloneDir, branch, colName);
  } catch (e) {
    if (e?.cancelled) { console.warn(`[rag-update] '${colName}': cancelled during clone — vectors untouched`); return; }
    console.warn(`[rag-update] '${colName}': clone failed (${e.message}) — refresh SKIPPED, existing vectors preserved`);
    void emitNotification('warning', 'codebase-rag',
      'A codebase-RAG refresh was skipped — the clone failed',
      `Collection '${colName}': cloning ${entry.repo_url} failed (${e.message}). Nothing was deleted: `
      + `search keeps serving the last successful index. The next nightly run retries.`);
    return;
  }

  // Drop the old vectors (all backends), then re-index over a clean collection.
  //
  // 🛑 THIS BUDGET MUST EXCEED THE PROXY'S OWN INNER BUDGET, and it did not.
  // vector-proxy drops each backend in parallel and gives chromadb 120s (dropping is O(size)
  // there). This caller gave the whole request 60s. On 2026-09-24 01:06:23 the nightly refresh
  // hit codebase_ai_lab, chromadb's 35,699-point drop ran past 60s, THIS timeout fired at
  // 01:07:23, and the TimeoutError propagated out of the refresh — so the drop actually
  // SUCCEEDED server-side while the caller aborted and never re-indexed. Net result: the
  // orphans were correctly removed and the collection was left EMPTY in chromadb.
  // A caller timeout shorter than the work it is waiting on manufactures exactly that
  // half-applied state, and it looks like a failure in the log while having partly worked.
  // 660s = the 600s inner budget plus margin. The outer budget must ALWAYS exceed the inner
  // one; when it did not (60s outer vs 120s inner) the caller killed a drop that was still
  // legitimately running, which is how a half-applied state gets manufactured.
  let delResp;
  try {
    delResp = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(660000),
    });
    if (!delResp.ok && delResp.status !== 404) {
      throw new Error(`vector delete returned ${delResp.status} — refusing to re-index over stale chunks`);
    }
  } catch (e) {
    await exec(MCPJUNGLE_HOST, `rm -rf "${cloneDir}"`, { timeout: 30000 }).catch(() => {});
    throw e;
  }
  // 🛑 THE STATUS ALONE IS A LIE. vector-proxy's /all handler ALWAYS returns 200 with a
  // per-backend `results` array, whatever failed inside it — so `delResp.ok` can never be
  // false and the guard below was UNREACHABLE. Discarding the body threw away the only
  // record of a failed drop. Measured consequence (2026-09-23): chromadb's drop times out
  // at 10s on large collections, reports ok:false, was ignored, and fresh chunks were
  // upserted on top — codebase_ai_lab reached 35,699 points against 5,630 real chunks (84%
  // orphans), and search was returning the ConversationBus tree, deleted 2026-09-01, as
  // live code. Same defect family as reportsRag's callTool: a transport success wrapping a
  // payload failure, with the payload unread.
  const delBody = await delResp.json().catch(() => null);
  const delFailed = Array.isArray(delBody?.results)
    ? delBody.results.filter((r) => !r?.ok)
    : [];
  // 🛑 DELIBERATELY DO NOT THROW HERE, and the reason is not obvious.
  // The drop is PER-BACKEND. Throwing would abort before re-indexing, which leaves every
  // backend that DID drop cleanly empty and unrebuilt — strictly worse than the bug, since
  // today qdrant/weaviate at least end up correct. So: re-index anyway (the healthy
  // backends come back right) and make the partial failure LOUD instead. The stale backend
  // is no worse off than it already was, and it is now visible rather than silent.
  if (delFailed.length) {
    const who = delFailed.map((r) => r.db).join(', ');
    console.error(`[rag-update] '${colName}': vector delete INCOMPLETE on ${who} — `
      + `re-indexing anyway so the healthy backends are correct; ${who} will accumulate stale chunks.`);
    void emitNotification('warning', 'codebase-rag',
      `A codebase-RAG drop FAILED on ${who} — that backend now holds stale chunks`,
      `Collection '${colName}': the pre-index drop did not complete on ${who} `
      + `(${delFailed.map((r) => `${r.db}: ${r.error || 'ok=false'}`).join('; ')}). `
      + `The re-index proceeded, so the backends that dropped cleanly are correct — but ${who} `
      + `is now carrying chunks from files that may no longer exist, and SEARCH CAN RETURN THEM `
      + `as if they were live code. Fix the cause and re-run the refresh to rebuild ${who} cleanly.`);
  }

  console.log(`[rag-update] Refreshing '${colName}' from ${entry.repo_url}${branch ? ` (${branch})` : ''}`);
  await runRagIndexing(entry.repo_url, colName, entry.description || '', branch, false, { preClonedDir: cloneDir });
  // runRagIndexing reports failure via ragJob.error, not by throwing.
  if (ragJob.error) {
    throw new Error(`re-index failed after vector delete: ${ragJob.error}. `
      + `The collection is EMPTY until this is repaired — resume via /api/ai/rag/resume/${colName}.`);
  }
  console.log(`[rag-update] '${colName}' refreshed: ${ragJob.result?.files_indexed ?? '?'} files, ${ragJob.result?.chunks_created ?? '?'} chunks`);
}

function processRagQueue() {
  if (ragJob.active || ragQueue.length === 0) return;
  ragCancelRequested = false;   // a new run starts clean
  const next = ragQueue.shift();
  console.log(`[rag-queue] Processing: ${next.type} ${next.collection} (${ragQueue.length} remaining)`);
  void emitDebug('rag-queue', `dequeued ${next.type} '${next.collection}'`
    + `${next.resume ? ' (resume)' : ''} — ${ragQueue.length} still queued`);
  try {
    if (next.type === 'update') {
      // Implemented 2026-08-31 (it crashed the backend nightly 2026-08-16→20
      // while undefined, then was guard-skipped with a warning until now).
      // Same containment as the indexing branch: an unhandled rejection in a
      // timer callback is just as fatal as a throw.
      // Claim the runner slot SYNCHRONOUSLY. runRagUpdate spends its first phases in
      // awaits (manifest read, ls-remote preflight, vector drop) before runRagIndexing
      // sets ragJob.active — the 3s queue ticker used to dequeue MORE items through that
      // window (2026-10-09: five collections re-indexing in parallel, embedder queue 82
      // deep, shared status garbled). One flag claimed before the first await closes it;
      // every exit of runRagUpdate releases it via the .finally below, and the release
      // runs in microtasks, ahead of the 500ms re-dispatch the inner indexer schedules.
      ragJob.active = true;
      ragJob.phase = 'preparing';
      ragJob.progress = 0;
      ragJob.detail = 'Refresh starting: manifest + preflight\u2026';
      ragJob.collection = next.collection;
      ragJob.error = null;
      runRagUpdate(next.collection).catch((err) => {
        console.error(`[rag-queue] update '${next.collection}' failed:`, err);
        ragJob.error = ragJob.error || String(err?.message ?? err);
        ragJob.phase = 'error';
        void emitNotification('warning', 'codebase-rag',
          'A codebase-RAG collection refresh failed',
          `Collection '${next.collection}': ${err?.message ?? err}`);
      }).finally(() => { ragJob.active = false; });
    } else {
      // next.resume is set by the auto-retry path: resume finishes the outstanding files
      // from the checkpoint instead of re-cloning and re-indexing the whole repo.
      const p = runRagIndexing(next.url, next.collection, next.description, next.branch,
                               !!next.resume);
      // runRagIndexing is async and is deliberately not awaited here; without this
      // catch an unhandled rejection is just as fatal under Node 22 as a throw.
      if (p && typeof p.catch === 'function') {
        p.catch((err) => console.error(`[rag-queue] indexing '${next.collection}' failed:`, err));
      }
    }
  } catch (err) {
    console.error(`[rag-queue] item '${next.type} ${next.collection}' threw — dropping it and `
      + `continuing. The queue must not take the process down:`, err);
  }
}

/** Watch for job completion and process queue */
function watchRagQueue() {
  const check = setInterval(() => {
    // Belt AND braces: processRagQueue already contains its own failures, but this is a
    // timer callback, so anything that escapes here would kill the process.
    try {
      if (!ragJob.active && ragQueue.length > 0) {
        processRagQueue();
      }
    } catch (err) {
      console.error('[rag-queue] watcher tick threw (contained):', err);
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
  // IDEMPOTENT: manifest entries store the already-sanitized name, and
  // runRagUpdate feeds them back through here — always-prepending turned a
  // refresh of 'codebase_x' into a new 'codebase_codebase_x' collection while
  // the real one sat deleted (caught by ragUpdateAndInventorySearch.smoke).
  const clean = String(name || '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
  // A symbol-only name ('!!!', '___') is truthy so it passes the route guards, but
  // sanitizes to '' -> 'codebase_' -> and on the NEXT pass the trailing-underscore strip
  // runs before the prefix check, giving 'codebase_codebase'. Same forked-twin data loss,
  // one edge case further in. Named constant keeps f(f(x)) == f(x).
  if (!clean) return 'codebase_unnamed';
  return clean.startsWith('codebase_') ? clean : 'codebase_' + clean;
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

// ── Clone with a STALL guard, not a wall-clock cap ──
// The clone used to get a flat 120s. On 2026-10-18 GitHub was crawling LAN-wide (~300-400 KB/s),
// ProxMenux (~2 GB) could not finish in 120s, and because the nightly refresh had already dropped
// the vectors the collection was left EMPTY (maintenance-claude alert mvdom1y4-6). A slow clone that
// is still moving is not a failure. So the clone runs detached on the host and is killed only when
// it stops making progress (bytes on disk + progress log unchanged for RAG_CLONE_STALL_S), with a
// generous absolute ceiling so a trickle can never hold the queue forever.
const RAG_CLONE_STALL_S = Number(process.env.AILAB_RAG_CLONE_STALL_S || 180);
const RAG_CLONE_MAX_S = Number(process.env.AILAB_RAG_CLONE_MAX_S || 7200);
const RAG_CLONE_POLL_MS = 10000;

/** Clone `url` into `dir` on MCPJUNGLE_HOST. Resolves when the clone succeeds; throws (after killing
 *  the clone and removing `dir`) on git failure, a stall, the absolute ceiling, or a user cancel. */
async function cloneRepoGuarded(url, dir, branch, label) {
  const branchArg = branch ? `--branch ${branch}` : '';
  const log = `${dir}.clone.log`, rcFile = `${dir}.clone.rc`;
  // setsid: the clone leads its own process group, so a stall kill takes git AND its children
  // (git-remote-https, index-pack). $! is that group's id.
  const start = await exec(MCPJUNGLE_HOST,
    `rm -rf "${dir}" "${log}" "${rcFile}"; `
    + `setsid sh -c 'GIT_TERMINAL_PROMPT=0 git clone --progress --depth 1 ${branchArg} "${url}" "${dir}" >"${log}" 2>&1; echo $? >"${rcFile}"' `
    + `</dev/null >/dev/null 2>&1 & echo "__PID__$!"`,
    { timeout: 15000 });
  const pid = Number((/__PID__(\d+)/.exec(start.stdout || '') || [])[1]);
  if (!pid) throw new Error(`clone did not start: ${(start.stdout || '') + (start.stderr || '')}`.slice(0, 300));

  const killClone = async (why) => {
    console.warn(`[rag] ${label}: killing clone (pgid ${pid}): ${why}`);
    await exec(MCPJUNGLE_HOST, `kill -TERM -- -${pid} 2>/dev/null; sleep 2; kill -KILL -- -${pid} 2>/dev/null; rm -rf "${dir}"`,
      { timeout: 20000 }).catch((e) => console.warn(`[rag] ${label}: clone kill failed: ${e.message}`));
  };
  const t0 = Date.now();
  let lastSig = '', lastMoveAt = Date.now();
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, RAG_CLONE_POLL_MS));
      if (ragCancelRequested) { await killClone('cancelled by user'); throw new RagCancelled(); }
      const st = await exec(MCPJUNGLE_HOST,
        `cat "${rcFile}" 2>/dev/null || echo RUNNING; du -sb "${dir}" 2>/dev/null | cut -f1; stat -c %s "${log}" 2>/dev/null; tail -c 300 "${log}" 2>/dev/null | tr '\\r' '\\n' | tail -1`,
        { timeout: 30000 });
      const lines = (st.stdout || '').split('\n');
      const rc = lines[0].trim();
      if (rc !== 'RUNNING') {
        const tail = await exec(MCPJUNGLE_HOST, `tail -c 400 "${log}"; rm -f "${log}" "${rcFile}"`, { timeout: 10000 })
          .then((r) => r.stdout || '').catch(() => '');
        if (rc === '0') {
          console.log(`[rag] ${label}: cloned in ${Math.round((Date.now() - t0) / 1000)}s`);
          return;
        }
        await exec(MCPJUNGLE_HOST, `rm -rf "${dir}"`, { timeout: 30000 }).catch(() => {});
        throw new Error(`Failed to clone repository (git exit ${rc}): ${tail.slice(-300)}`);
      }
      const sig = `${lines[1] || ''}/${lines[2] || ''}`;
      if (sig !== lastSig) { lastSig = sig; lastMoveAt = Date.now(); }
      const mb = (Number(lines[1]) || 0) / 1048576;
      ragJob.detail = `Cloning repository... ${mb.toFixed(0)} MB (${Math.round((Date.now() - t0) / 1000)}s) ${(lines[3] || '').trim().slice(0, 80)}`;
      if (Date.now() - lastMoveAt > RAG_CLONE_STALL_S * 1000) {
        await killClone(`no progress for ${RAG_CLONE_STALL_S}s`);
        throw new Error(`clone stalled: no progress for ${RAG_CLONE_STALL_S}s at ${mb.toFixed(0)} MB (AILAB_RAG_CLONE_STALL_S)`);
      }
      if (Date.now() - t0 > RAG_CLONE_MAX_S * 1000) {
        await killClone(`exceeded ${RAG_CLONE_MAX_S}s ceiling`);
        throw new Error(`clone still running after ${RAG_CLONE_MAX_S}s at ${mb.toFixed(0)} MB (AILAB_RAG_CLONE_MAX_S)`);
      }
    }
  } catch (e) {
    // exec() itself failing (ssh/host hiccup) mid-poll must not orphan a running clone.
    if (!e?.cancelled && !/^(Failed to clone|clone stalled|clone still running)/.test(e?.message || '')) {
      await killClone(`poll error: ${e?.message || e}`);
    }
    throw e;
  }
}

/** Run the full indexing pipeline asynchronously (streaming — no full accumulation).
 *  opts.preClonedDir: a finished clone to index instead of cloning here (runRagUpdate clones
 *  BEFORE dropping vectors, so a failed clone never empties a collection). Ownership of the dir
 *  passes to this function — it is moved/removed exactly like a clone made here. */
async function runRagIndexing(url, collection, description, branch, resume = false, opts = {}) {
  void emitDebug('rag', `${resume ? 'resuming' : 'starting'} index of ${collection || url}`
    + `${branch ? ` (branch ${branch})` : ''} from ${url}`);
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
      // A failure BEFORE the first checkpoint (clone timeout, empty scan) leaves nothing to resume, yet
      // the auto-retry queues resume:true. Erroring here made every such retry a no-op, so a collection
      // emptied by a failed refresh stayed empty (codebase_proxmenux / marinara_engine, 2026-10-18).
      // Nothing to resume = start fresh.
      console.warn(`[rag] ${colName}: resume requested but no checkpoint exists - indexing from scratch`);
      resume = false;
      ragJob.phase = 'cloning';
      ragJob.detail = 'No checkpoint - indexing from scratch...';
    }
  }
  if (resume) {
    console.log(`[rag] Resuming ${url} as ${colName} — ${checkpoint.completedFiles?.length || 0} files already done`);
  } else {
    console.log(`[rag] Indexing ${url} as ${colName}`);
  }

  let tmpDir = '';
  try {
    // ── Phase 1: Clone via SSH on MCPJungle (stall-guarded; skipped when the caller pre-cloned) ──
    if (opts.preClonedDir) {
      tmpDir = opts.preClonedDir;
    } else {
      tmpDir = `/tmp/codebase-rag-${Date.now()}`;
      await cloneRepoGuarded(url, tmpDir, branch, colName);
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
      if (ragCancelRequested) throw new RagCancelled();
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
              text: stripLoneSurrogates(chunk.text),
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
          const truncatedTexts = embedBatch.map(c => embedSafeText(c.text));
          const embedResp = await embedFetch(`http://127.0.0.1:${selfPort}/api/proxy/embed/v1/embeddings`, {
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
            // Sanitise AT THE SERIALISATION BOUNDARY as well as at chunk construction.
            // c.text is already clean on this path, but qdrant's JSON parser is what
            // actually rejects a lone surrogate, so the invariant belongs where the
            // stringify happens — not only in every producer that feeds it.
            metadata: { text: stripLoneSurrogates(c.text), ...c.metadata },
          }));

          const upsertResp = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}/upsert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points }),
            signal: AbortSignal.timeout(60000),
          });
          // Count what LANDED, not what was sent. The proxy returns per-backend { ok, count }
          // plus a conservative `stored` (the MINIMUM across backends that answered). Discarding
          // this body is how a batch rejected by TWO of three backends still counted as fully
          // indexed — and upsertedCount is the number that becomes chunks_created, the run's
          // headline total, and the checkpoint. The body is a few per-backend summaries, not the
          // points, so reading it costs nothing the old comment was protecting against.
          //
          // A 4xx here is DETERMINISTIC: it fails identically on every retry, which is exactly the
          // pathology that burned three automatic retries and left a collection empty on
          // 2026-09-16. Record it and move on — never retry it.
          let stored = embedBatch.length;
          try {
            const body = JSON.parse(await upsertResp.text());
            if (typeof body?.stored === 'number') stored = body.stored;
            const failedDbs = Array.isArray(body?.failed) ? body.failed : [];
            if (failedDbs.length) {
              const deterministic = upsertResp.status >= 400 && upsertResp.status < 500;
              console.warn(`[rag] upsert PARTIAL: ${stored}/${embedBatch.length} stored, rejected by `
                + `${failedDbs.join(', ')}${deterministic ? ' — 4xx, deterministic, not retried' : ''}`);
            }
          } catch {
            // Unreadable body: fall back to the optimistic count rather than losing the batch from
            // the tally entirely. Over-counting here is the lesser error than under-counting.
          }
          upsertedCount += stored;

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

    ragAttempts.delete(colName);   // a success resets the retry budget for next time
    ragJob.phase = 'done';
    ragJob.progress = 100;
    ragJob.detail = `Indexed ${filesRead} files (${upsertedCount} chunks)`;
    emitDebug('rag', `${colName}: finished — ${filesRead} files, ${upsertedCount} chunks`);
    ragJob.result = {
      collection: colName, files_indexed: filesRead,
      chunks_created: upsertedCount, repo_url: url, languages: languageCounts,
    };
  } catch (e) {
    if (e && e.cancelled) {
      ragJob.phase = 'cancelled'; ragJob.progress = 0; ragJob.error = null;
      ragJob.detail = `Cancelled - checkpoint kept; the next scheduled run resumes ${colName}`;
      console.warn(`[rag] ${colName}: cancelled by user, checkpoint preserved`);
      emitDebug('rag', `${colName}: cancelled by user (checkpoint kept)`);
      return;
    }
    const attempts = (ragAttempts.get(colName) || 0) + 1;
    ragAttempts.set(colName, attempts);
    const willRetry = attempts < RAG_MAX_ATTEMPTS;

    ragJob.phase = willRetry ? 'retrying' : 'error';
    ragJob.progress = 0;
    ragJob.error = e.message;
    ragJob.detail = willRetry
      ? `Attempt ${attempts}/${RAG_MAX_ATTEMPTS} failed: ${e.message} — retrying automatically`
      : `Error: ${e.message}`;
    // Preserve partial progress — checkpoint file stays for resume
    // Only clean up the temporary clone directory
    console.warn(`[rag] Indexing failed for ${colName}: ${e.message} — checkpoint preserved for resume`);

    if (willRetry) {
      const delay = RAG_RETRY_DELAYS_MS[Math.min(attempts - 1, RAG_RETRY_DELAYS_MS.length - 1)];
      emitDebug('rag', `${colName}: attempt ${attempts}/${RAG_MAX_ATTEMPTS} failed (${e.message}) — retrying in ${Math.round(delay / 1000)}s`);
      // 🛑 Wrapped: an uncaught throw inside setTimeout takes the whole Node process down.
      // That is precisely how rag-autosync killed ai-lab.service nightly for weeks.
      setTimeout(() => {
        try {
          ragQueue.push({ type: 'index', url, collection: colName, description, branch, resume: true });
          emitDebug('rag', `${colName}: queued retry ${attempts + 1}/${RAG_MAX_ATTEMPTS} (resuming from checkpoint)`);
          processRagQueue();
        } catch (err) {
          console.warn(`[rag] retry scheduling failed for ${colName}: ${err?.message || err}`);
        }
      }, delay);
    } else {
      // Out of automatic attempts: NOW it becomes a human's problem, and it says so where a
      // human is actually looking rather than on a button in a panel nobody has open.
      emitNotification('warning', 'rag-index',
        'Codebase indexing gave up after automatic retries',
        `${colName} failed ${attempts} times; last error: ${e.message}. Partial progress is `
        + `checkpointed — resume manually from the Codebase RAG panel, or via `
        + `POST /api/ai/rag/resume. The collection may be incomplete until then.`);
      emitDebug('rag', `${colName}: FAILED after ${attempts} attempts — manual resume required`);
    }
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
  clearRagHold('manual index');
  const { url, collection, description, branch } = req.body || {};
  if (!url || !collection) return res.status(400).json({ error: 'url and collection are required' });
  if (ragJob.active) {
    // Queue it instead of rejecting -- ahead of scheduled refreshes (enqueueManual).
    const position = enqueueManual({ type: 'index', url, collection, description, branch });
    console.log(`[rag-queue] manual index ${collection} queued at position ${position}/${ragQueue.length}`);
    void emitDebug('rag', `manual index ${collection} queued at position ${position} of ${ragQueue.length} (ahead of scheduled updates)`);
    return res.json({ queued: true, collection, url, position });
  }
  runRagIndexing(url, collection, description, branch);
  res.json({ started: true, collection, url });
});

// POST /api/ai/rag/index/cancel - stop the codebase-RAG run: empties the queue and stops the running
// job at its next batch (checkpoint kept, no auto-retry). The next scheduled run starts clean.
app.post('/api/ai/rag/index/cancel', (req, res) => {
  const dropped = ragQueue.splice(0, ragQueue.length).map((q) => q.collection);
  const running = ragJob.active ? ragJob.collection : null;
  ragCancelRequested = !!running;
  setRagHold({ stopped: running, dropped });
  console.warn(`[rag] cancel requested: running=${running || 'none'}, dropped ${dropped.length} queued: ${dropped.join(', ')}`);
  emitDebug('rag', `cancel requested: stopping ${running || 'nothing'}, dropped ${dropped.length} queued`);
  res.json({ ok: true, stopping: running, dropped });
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
  limits: { fileSize: 1024 * 1024 * 1024 },   // service manuals run to hundreds of MB
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
    collection: docRagJob.collection, colName: docRagJob.colName || '', fileCount: docRagJob.fileCount,
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
    // pdftotext (poppler) emits a form feed after EVERY page, so page numbers are real. pdf-parse
    // never did: its text has no \f, so every chunk of every PDF was labelled "page 1" (found
    // 2026-10-06), which also broke matching a page's text to its page image. pdf-parse remains
    // the fallback for files poppler rejects.
    try {
      const text = await new Promise((resolve, reject) => {
        const child = spawn('pdftotext', ['-enc', 'UTF-8', filePath, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
        const out = []; let err = '';
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`pdftotext exit ${code}: ${err.trim().slice(0, 160)}`))));
      });
      const pages = text.split('\f');
      if (pages.length > 1 || text.trim()) {
        return pages.map((t, i) => ({ text: t.trim(), page_number: i + 1 })).filter((p) => p.text);
      }
    } catch (e) {
      console.warn(`[docrag] pdftotext failed for ${originalName} (${e.message}); falling back to pdf-parse`);
    }
    const buffer = await readFileAsync(filePath);
    const data = await pdfParse(buffer);
    const pages = (data.text || '').split(/\f/);
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

// ─── PDF page images (2026-10-06) ───────────────────────────────────────────
// pdf-parse sees only the text layer, so diagrams, exploded views and scanned pages were invisible
// to search. Each page is also rendered and embedded as an IMAGE with the same VL embedder, so a
// query like "ECM connector pinout" can land on the diagram itself. Page JPEGs are kept (served by
// GET /api/ai/docrag/page-image) so a search hit can be opened. Long side 1536 px: about 1,650
// vision tokens, inside the embedder's 4,096-token window, and enough detail for wiring diagrams.
const DOC_PAGES_ROOT = join(RAG_DATA_DIR, 'docrag-pages');
const PAGE_LONG_SIDE = 1536;
const pageSlug = (name) => String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 150) || 'file';
function docPagesDir(colName, fileName) { return join(DOC_PAGES_ROOT, colName, pageSlug(fileName)); }
async function renderPdfPages(pdfPath, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('pdftoppm', ['-jpeg', '-jpegopt', 'quality=82', '-scale-to', String(PAGE_LONG_SIDE), pdfPath, join(outDir, 'p')],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pdftoppm exit ${code}: ${err.trim().slice(0, 200)}`))));
  });
  // pdftoppm names pages p-1.jpg / p-01.jpg / p-001.jpg depending on page count: normalise to p<N>.jpg
  const out = [];
  for (const f of readdirSyncFs(outDir)) {
    const m = f.match(/^p-0*(\d+)\.jpg$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const dest = join(outDir, `p${n}.jpg`);
    renameSync(join(outDir, f), dest);
    out.push({ page: n, path: dest });
  }
  return out.sort((a, b) => a.page - b.page);
}
/** Upsert and report what was really STORED (the proxy says so) instead of assuming the batch. */
async function upsertDocPoints(port, colName, points) {
  const r = await fetch(`http://127.0.0.1:${port}/api/proxy/vector/all/collections/${colName}/upsert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }), signal: AbortSignal.timeout(60000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`upsert HTTP ${r.status}`);
  return typeof d.stored === 'number' ? d.stored : points.length;
}

/**
 * fetch() for the embedder that rides out a restart. A 5xx or a connection error is retried with
 * backoff for up to EMBED_RETRY_MS (5 min) before the response or error is handed back to the caller's
 * own failure counting. Before this, an embedder that dropped for a minute (crash, watchdog restart,
 * a GPU move) failed every remaining page of the current PDF in about a second and then aborted the
 * whole job: the Nissan Juke manual died 4 of 57 files in on 2026-10-06. Each attempt gets its own
 * timeout; any signal the caller passed is replaced, since one shared timeout would expire mid-retry.
 */
const EMBED_RETRY_MS = Number(process.env.EMBED_RETRY_MS || 5 * 60 * 1000);
async function embedFetch(url, init = {}) {
  // Attribution for the vector-activity panel: name the job driving this call.
  init.headers = { ...(init.headers || {}), 'x-ailab-source':
    ragJob.active && docRagJob.active ? 'rag (mixed)' : docRagJob.active ? 'doc-rag' : 'codebase-rag' };
  const deadline = Date.now() + EMBED_RETRY_MS;
  let delay = 5000, attempt = 0;
  for (;;) {
    attempt++;
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(180000) });
      if (r.status < 500 || Date.now() + delay > deadline) return r;
      console.warn(`[embed-retry] HTTP ${r.status} from the embedder (attempt ${attempt}); retrying in ${delay / 1000}s`);
    } catch (e) {
      if (Date.now() + delay > deadline) throw e;
      console.warn(`[embed-retry] ${e.message} (attempt ${attempt}); retrying in ${delay / 1000}s`);
    }
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(delay * 2, 60000);
  }
}

// ── Documents inside a collection (2026-10-22) ──────────────────────────────
// A collection holds many DOCUMENTS (prints, contracts, reports...). Each has a stable doc_id plus
// a title / description / type the user gives it, and every point carries them as payload
// (doc_id, doc_rev, doc_title, doc_description, doc_type) so search can be scoped to a document.
// The manifest entry keeps the per-document list; its totals are DERIVED from that list, never
// overwritten by whichever batch ran last (they used to be - a 1-file add made a 20-file
// collection read "1 file").
// SAFETY: adding to or replacing inside an existing collection NEVER drops the collection. A new
// version is written under a fresh doc_rev and the old rev is deleted only after the new one
// stored something; a failed file deletes only its own partial rev. (Before this, any job failure
// auto-dropped the WHOLE collection - including every document added by earlier jobs.)
let docManifestChain = Promise.resolve();
function readDocManifest() {
  try { const m = JSON.parse(readFileSync(DOC_RAG_MANIFEST, 'utf-8')); return Array.isArray(m) ? m : []; } catch { return []; }
}
/** Serialised read-modify-write (atomic rename) so concurrent edits cannot lose each other. */
function updateDocManifest(fn) {
  const run = docManifestChain.then(() => {
    const m = readDocManifest();
    const out = fn(m) || m;
    mkdirSync(dirname(DOC_RAG_MANIFEST), { recursive: true });
    const tmp = `${DOC_RAG_MANIFEST}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(out, null, 2));
    renameSync(tmp, DOC_RAG_MANIFEST);
    return out;
  });
  docManifestChain = run.catch((e) => console.warn(`[docrag] manifest write failed: ${e.message}`));
  return run;
}
function recomputeDocEntry(e) {
  const docs = Array.isArray(e.documents) ? e.documents : [];
  e.files_indexed = docs.length;
  e.chunks_created = docs.reduce((a, d) => a + (d.chunks || 0) + (d.page_images || 0), 0);
  const ft = {};
  for (const d of docs) { const k = d.file_kind || 'other'; ft[k] = (ft[k] || 0) + 1; }
  e.file_types = ft;
  return e;
}
const docColFromParam = (raw) => (String(raw).startsWith('docs_') ? String(raw) : sanitizeDocCollectionName(String(raw)));
const newDocId = () => randomBytes(6).toString('hex');
const stripExt = (n) => String(n).replace(/\.[A-Za-z0-9]{1,5}$/, '');
const fileKindOf = (name) => { const ext = extname(String(name)).toLowerCase(); return IMAGE_EXTS.has(ext) ? 'image' : (ext.replace('.', '') || 'other'); };
const docIdFilter = (docId) => ({ must: [{ key: 'doc_id', match: { value: docId } }] });

async function vectorOp(colName, op, body) {
  const r = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}/${op}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
  });
  const d = await r.json().catch(() => ({}));
  const failed = (d.results || []).filter((x) => !x.ok);
  if (!r.ok && r.status !== 207) throw new Error(`${op} HTTP ${r.status}: ${d.error || ''}`);
  if (failed.length) throw new Error(`${op} failed on ${failed.map((x) => `${x.target || x.db}: ${x.error}`).join('; ')}`);
  return d;
}
async function scrollAllPoints(colName, keys) {
  const out = []; let offset = null;
  for (let guard = 0; guard < 500; guard++) {
    const r = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}/scroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, limit: 2000, ...(offset != null ? { offset } : {}) }), signal: AbortSignal.timeout(60000),
    });
    if (r.status === 404) return out;
    const d = await r.json();
    if (!r.ok) throw new Error(`scroll ${colName}: ${d.error || r.status}`);
    out.push(...(d.points || []));
    if (d.next == null) return out;
    offset = d.next;
  }
  throw new Error(`scroll ${colName}: too many pages`);
}
/** Collections indexed before documents existed: build the list from the points themselves and
 *  stamp each file's points with a doc_id so they can be replaced/removed/filtered like new ones. */
async function ensureDocList(colName) {
  const have = readDocManifest().find((c) => c.name === colName);
  if (have && Array.isArray(have.documents)) return have;
  const pts = await scrollAllPoints(colName, ['file_name', 'file_type', 'doc_id']);
  const byFile = new Map();
  for (const p of pts) {
    const fn = p.payload?.file_name || '(unknown)';
    const g = byFile.get(fn) || { file_name: fn, chunks: 0, page_images: 0, doc_id: p.payload?.doc_id || null };
    if (p.payload?.file_type === 'pdf_page_image') g.page_images++; else g.chunks++;
    if (!g.doc_id && p.payload?.doc_id) g.doc_id = p.payload.doc_id;
    byFile.set(fn, g);
  }
  const now = new Date().toISOString();
  const docs = [];
  for (const g of byFile.values()) {
    const docId = g.doc_id || newDocId();
    if (!g.doc_id) {
      await vectorOp(colName, 'set-payload', {
        filter: { must: [{ key: 'file_name', match: { value: g.file_name } }] },
        payload: { doc_id: docId, doc_rev: 'legacy', doc_title: stripExt(g.file_name), doc_description: '', doc_type: '' },
      });
    }
    docs.push({ doc_id: docId, rev: 'legacy', file_name: g.file_name, title: stripExt(g.file_name), description: '', doc_type: '',
      file_kind: fileKindOf(g.file_name), chunks: g.chunks, page_images: g.page_images, size: null, indexed_at: have?.indexed_at || now });
  }
  console.log(`[docrag] ${colName}: built document list from ${pts.length} points -> ${docs.length} documents`);
  const m = await updateDocManifest((m) => {
    let e = m.find((c) => c.name === colName);
    if (!e) { e = { name: colName, display_name: colName.replace(/^docs_/, ''), description: '', embed_model: effEmbedModel(), indexed_at: now }; m.push(e); }
    e.documents = docs;
    recomputeDocEntry(e);
    return m;
  });
  return m.find((c) => c.name === colName);
}

/**
 * files: [{ path, originalname, title?, description?, doc_type?, replaceDocId? }]
 * A file whose name matches a document already in the collection REPLACES that document (no
 * side-by-side duplicates); replaceDocId replaces a specific document whatever the new file is called.
 */
async function runDocRagIndexing(files, collection, description, opts = {}) {
  const colName = readDocManifest().some((c) => c.name === collection) ? collection : sanitizeDocCollectionName(collection);
  const port = selfPort;
  docRagJob.active = true;
  docRagJob.phase = 'processing';
  docRagJob.progress = 0;
  docRagJob.detail = `Processing ${files.length} files...`;
  docRagJob.result = null;
  docRagJob.error = null;
  docRagJob.collection = collection;
  docRagJob.colName = colName;
  docRagJob.fileCount = files.length;
  console.log(`[docrag] Indexing ${files.length} files into ${colName}`);

  let existed = !!readDocManifest().find((c) => c.name === colName);
  let currentRev = null;   // the rev being written right now (cleaned up if the job dies mid-file)
  let currentDoc = null;
  const succeeded = [];
  try {
    if (!existed) {
      try {
        const c = await (await fetch(`http://127.0.0.1:${port}/api/proxy/vector/all/collections/${colName}/count`, { signal: AbortSignal.timeout(10000) })).json();
        existed = (c.maxCount || 0) > 0;
      } catch {}
    }
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
    if (existed) {
      docRagJob.detail = 'Reading the collection\'s document list...';
      await ensureDocList(colName);
    }
    await updateDocManifest((m) => {
      let e = m.find((c) => c.name === colName);
      if (!e) {
        e = { name: colName, display_name: collection, description: description || '', embed_model: effEmbedModel(),
          created_at: new Date().toISOString(), indexed_at: new Date().toISOString(), documents: [] };
        m.push(e);
      } else if (description && String(description).trim()) e.description = String(description).trim();
      if (!Array.isArray(e.documents)) e.documents = [];
      recomputeDocEntry(e);
      return m;
    });

    const EMBED_BATCH = 16;
    const pageImages = opts.pageImages !== false;
    let upsertedCount = 0;
    let pageImageCount = 0;
    const skipped = [];
    let embedErrors = 0;
    let filesProcessed = 0;

    for (const file of files) {
      const origName = file.originalname;
      const ext = extname(origName).toLowerCase();
      const typeKey = fileKindOf(origName);
      const curDocs = readDocManifest().find((c) => c.name === colName)?.documents || [];
      const prev = file.replaceDocId ? curDocs.find((d) => d.doc_id === file.replaceDocId) : curDocs.find((d) => d.file_name === origName);
      if (file.replaceDocId && !prev) { skipped.push(`${origName} (the document to replace no longer exists)`); filesProcessed++; continue; }
      const docId = prev?.doc_id || newDocId();
      const rev = randomBytes(4).toString('hex');
      const pick = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
      const title = pick(file.title, prev?.title || stripExt(origName));
      const docDescription = pick(file.description, prev?.description || '');
      const docType = pick(file.doc_type, prev?.doc_type || '');
      const docMeta = { doc_id: docId, doc_rev: rev, doc_title: title, doc_description: docDescription, doc_type: docType };
      // Title/type go into what is EMBEDDED (not the stored text), so "the civil grading plan" lands on that print.
      const embedHeader = `[${docType ? docType + ': ' : ''}${title}]\n`;
      currentRev = rev; currentDoc = docId;
      let fileChunks = [], storedText = 0, storedImage = 0, filePages = 0;

      try {
        const contents = await extractDocContent(file.path, origName);
        for (const part of contents) {
          if (part.isImage) {
            const imgBuffer = await readFileAsync(file.path);
            const b64 = imgBuffer.toString('base64');
            const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
            const mime = mimeMap[ext] || 'image/png';
            try {
              const embedResp = await embedFetch(`http://127.0.0.1:${port}/api/proxy/embed/v1/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: effEmbedModel(),
                  messages: [{ role: 'user', content: [
                    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
                  ] }],
                  encoding_format: 'float',
                }),
              });
              if (embedResp.ok) {
                const vector = (await embedResp.json()).data?.[0]?.embedding;
                if (vector?.length) {
                  const n = await upsertDocPoints(port, colName, [{
                    id: `${colName}::${docId}::${rev}::img::0`,
                    vector,
                    metadata: { text: `[image: ${title}]${docDescription ? ' ' + docDescription : ''}`, file_name: origName, file_type: 'image', collection: colName, ...docMeta },
                  }]);
                  storedImage += n; upsertedCount += n;
                }
              } else {
                console.warn(`[docrag] Image embed failed for ${origName}: HTTP ${embedResp.status}`);
              }
            } catch (e) {
              console.warn(`[docrag] Image embed error for ${origName}: ${e.message}`);
            }
          } else {
            const extra = part.page_number != null ? { page_number: part.page_number } : {};
            fileChunks.push(...chunkDocText(part.text, origName, typeKey, extra));
          }
        }

        for (let j = 0; j < fileChunks.length; j += EMBED_BATCH) {
          const batch = fileChunks.slice(j, j + EMBED_BATCH);
          try {
            const truncated = batch.map(c => embedSafeText(embedHeader + c.text));
            const embedResp = await embedFetch(`http://127.0.0.1:${port}/api/proxy/embed/v1/embeddings`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: effEmbedModel(), input: truncated }),
            });
            if (!embedResp.ok) {
              embedErrors++;
              if (embedErrors >= 5) throw new Error(`Embedding model returned ${embedResp.status} on 5 consecutive batches`);
              continue;
            }
            embedErrors = 0;
            const embeddings = ((await embedResp.json()).data || []).map(d => d.embedding);
            if (!embeddings.length || !embeddings[0]?.length) {
              embedErrors++;
              if (embedErrors >= 5) throw new Error('Empty vectors on 5 consecutive batches');
              continue;
            }
            const points = batch.map((c, idx) => ({
              id: `${colName}::${docId}::${rev}::${c.page_number != null ? 'p' + c.page_number : 'c'}::${c.chunk_index}`,
              vector: embeddings[idx],
              metadata: { text: stripLoneSurrogates(c.text), file_name: c.file_name, file_type: c.file_type, page_number: c.page_number || null, chunk_index: c.chunk_index, collection: colName, ...docMeta },
            }));
            const n = await upsertDocPoints(port, colName, points);
            storedText += n; upsertedCount += n;
          } catch (e) {
            if (e.message.includes('consecutive batches')) throw e;
            console.warn(`[docrag] Embed/upsert batch failed: ${e.message}`);
          }
          docRagJob.detail = `Processing: ${filesProcessed}/${files.length} files - ${title}: ${Math.min(j + EMBED_BATCH, fileChunks.length)}/${fileChunks.length} chunks`;
        }

        if (pageImages && ext === '.pdf') {
          let pages = [];
          try { pages = await renderPdfPages(file.path, docPagesDir(colName, origName)); }
          catch (e) { console.warn(`[docrag] page render failed for ${origName}: ${e.message}`); }
          const textByPage = new Map(contents.filter((c) => c.page_number != null).map((c) => [c.page_number, c.text || '']));
          for (const pg of pages) {
            docRagJob.detail = `Processing: ${filesProcessed}/${files.length} files - ${title} page image ${pg.page}/${pages.length}`;
            try {
              const b64 = (await readFileAsync(pg.path)).toString('base64');
              const er = await embedFetch(`http://127.0.0.1:${port}/api/proxy/embed/v1/embeddings`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: effEmbedModel(), messages: [{ role: 'user', content: [
                  { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
                ] }], encoding_format: 'float' }),
              });
              if (!er.ok) { console.warn(`[docrag] page ${pg.page} of ${origName}: embed HTTP ${er.status}`); continue; }
              const vector = (await er.json()).data?.[0]?.embedding;
              if (!vector?.length) continue;
              const pageText = stripLoneSurrogates((textByPage.get(pg.page) || '').replace(/\s+/g, ' ').trim());
              const stored = await upsertDocPoints(port, colName, [{
                id: `${colName}::${docId}::${rev}::pimg::${pg.page}`,
                vector,
                metadata: {
                  text: `[page image: ${title} p.${pg.page}]${pageText ? ' ' + pageText.slice(0, 600) : ' (no text layer - diagram/scan)'}`,
                  file_name: origName, file_type: 'pdf_page_image', page_number: pg.page, collection: colName, ...docMeta,
                  page_image: `/api/ai/docrag/page-image?collection=${encodeURIComponent(colName)}&file=${encodeURIComponent(origName)}&page=${pg.page}`,
                },
              }]);
              pageImageCount += stored; upsertedCount += stored; filePages += stored;
            } catch (e) {
              console.warn(`[docrag] page ${pg.page} of ${origName}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        if (e.message.includes('consecutive batches')) throw e;
        console.warn(`[docrag] Error processing ${origName}: ${e.message}`);
        skipped.push(`${origName} (${String(e.message).slice(0, 80)})`);
      }

      const storedAll = storedText + storedImage + filePages;
      if (storedAll > 0) {
        // New version is in: now (and only now) retire the previous version's points.
        if (prev) {
          try { await vectorOp(colName, 'delete-points', { filter: { must: [{ key: 'doc_id', match: { value: docId } }], must_not: [{ key: 'doc_rev', match: { value: rev } }] } }); }
          catch (e) { console.warn(`[docrag] ${colName}/${docId}: old version cleanup failed: ${e.message}`); skipped.push(`${origName} (new version indexed, but removing the old version failed: ${e.message.slice(0, 80)})`); }
          if (prev.file_name !== origName && !curDocs.some((d) => d.doc_id !== docId && d.file_name === prev.file_name)) {
            try { rmSync(docPagesDir(colName, prev.file_name), { recursive: true, force: true }); } catch {}
          }
        }
        let size = null; try { size = statSyncFs(file.path).size; } catch {}
        const docEntry = {
          doc_id: docId, rev, file_name: origName, title, description: docDescription, doc_type: docType, file_kind: typeKey,
          chunks: storedText + storedImage, page_images: filePages, size, indexed_at: new Date().toISOString(),
          created_at: prev?.created_at || prev?.indexed_at || new Date().toISOString(), version: (prev?.version || 1) + (prev ? 1 : 0),
        };
        await updateDocManifest((m) => {
          const e = m.find((c) => c.name === colName);
          if (!e) return m;
          e.documents = [...(e.documents || []).filter((d) => d.doc_id !== docId), docEntry];
          e.indexed_at = docEntry.indexed_at;
          e.embed_model = effEmbedModel();
          recomputeDocEntry(e);
          return m;
        });
        succeeded.push({ doc_id: docId, title, replaced: !!prev });
      } else {
        if (!skipped.some((x) => x.startsWith(origName))) skipped.push(`${origName} (no text or images could be extracted)`);
        // Drop any partial points of this rev; the previous version (if any) is untouched.
        try { await vectorOp(colName, 'delete-points', { filter: { must: [{ key: 'doc_rev', match: { value: rev } }] } }); } catch {}
      }
      currentRev = null; currentDoc = null;

      filesProcessed++;
      const pct = 10 + Math.round((filesProcessed / files.length) * 80);
      docRagJob.progress = Math.min(pct, 92);
      docRagJob.detail = `Processing: ${filesProcessed}/${files.length} files, ${upsertedCount} chunks indexed`;
    }

    if (!succeeded.length) {
      throw new Error(`Nothing could be indexed${skipped.length ? `: ${skipped.slice(0, 3).join(', ')}` : ''}`);
    }

    docRagJob.phase = 'done';
    docRagJob.progress = 100;
    const replacedN = succeeded.filter((x) => x.replaced).length;
    docRagJob.detail = `Indexed ${succeeded.length} document${succeeded.length === 1 ? '' : 's'}${replacedN ? ` (${replacedN} replaced)` : ''} (${upsertedCount} chunks`
      + `${pageImageCount ? `, incl. ${pageImageCount} page images` : ''})`
      + `${skipped.length ? `; skipped ${skipped.length}: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}` : ''}`;
    docRagJob.result = {
      collection: colName, files_indexed: succeeded.length, documents: succeeded,
      chunks_created: upsertedCount, page_images: pageImageCount, skipped,
    };
  } catch (e) {
    docRagJob.phase = 'error';
    docRagJob.progress = 0;
    docRagJob.error = e.message;
    docRagJob.detail = `Error: ${e.message}`;
    console.warn(`[docrag] Indexing failed for ${colName}: ${e.message}`);
    if (currentRev) {
      try { await vectorOp(colName, 'delete-points', { filter: { must: [{ key: 'doc_rev', match: { value: currentRev } }] } }); }
      catch (e2) { console.warn(`[docrag] ${colName}: partial cleanup of ${currentDoc}@${currentRev} failed: ${e2.message}`); }
    }
    // Only a collection THIS job created, and that ended up with nothing in it, is removed.
    if (!existed && !succeeded.length) {
      try {
        await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}`, {
          method: 'DELETE', signal: AbortSignal.timeout(30000),
        }).then(r => r.text().catch(() => ''));
      } catch {}
      try { await updateDocManifest((m) => m.filter((c) => c.name !== colName)); } catch {}
    }
  } finally {
    docRagJob.active = false;
    for (const file of files) {
      if (opts.keepSource || file.keep) continue;   // never unlink a user's real file browsed on the container
      // rmAsync was never defined: the ReferenceError was swallowed and temp uploads were never removed.
      try { rmSync(file.path, { force: true }); } catch (e) { console.warn(`[docrag] temp cleanup ${file.path}: ${e.message}`); }
    }
  }
}

// multer errors (file too large, wrong type) answer as JSON instead of an HTML error page, so the
// UI can show the reason rather than "upload failed".
const docUploadMw = (req, res, next) => docUpload.array('files', 2000)(req, res, (err) => {   // a manual split into many small PDFs
  if (err) return res.status(400).json({ error: `upload rejected: ${err.message || err}` });
  next();
});
// ─── Document RAG: chunked staging upload ──────────────────────────────────
// Every request stays small whatever the file or batch size, so the upload works through
// Cloudflare (100 MB per request) as well as on the LAN:
//   POST /docrag/staging                              -> { session }
//   PUT  /docrag/staging/:session/:idx?name=&offset=  raw bytes (<= 64 MB), appended at offset
//   GET  /docrag/staging/:session/:idx                -> { size }   (resume point after a failure)
//   POST /docrag/staging/:session/index {collection, description, files:[{idx, name, size}]}
// Files are reassembled in a per-session dir, indexed in place, then the dir is removed.
const STAGING_ROOT = '/tmp/docrag-staging';
const STAGING_MAX_AGE_MS = 24 * 3600_000;
const stagingDir = (session) => (/^[a-f0-9]{24}$/.test(String(session)) ? join(STAGING_ROOT, session) : null);
const stagedName = (idx, name) => `${idx}_${String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)}`;
function sweepStaging() {
  try {
    for (const d of readdirSyncFs(STAGING_ROOT)) {
      const p = join(STAGING_ROOT, d);
      try { if (Date.now() - statSyncFs(p).mtimeMs > STAGING_MAX_AGE_MS) rmSync(p, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}
app.post('/api/ai/docrag/staging', (req, res) => {
  sweepStaging();
  const session = randomBytes(12).toString('hex');
  mkdirSync(join(STAGING_ROOT, session), { recursive: true });
  res.json({ session });
});
app.get('/api/ai/docrag/staging/:session/:idx', (req, res) => {
  const dir = stagingDir(req.params.session); const idx = parseInt(req.params.idx, 10);
  if (!dir || !existsSync(dir) || !(idx >= 0)) return res.status(404).json({ error: 'unknown upload session' });
  const f = readdirSyncFs(dir).find((n) => n.startsWith(`${idx}_`));
  res.json({ size: f ? statSyncFs(join(dir, f)).size : 0 });
});
app.put('/api/ai/docrag/staging/:session/:idx', express.raw({ type: '*/*', limit: '64mb' }), (req, res) => {
  const dir = stagingDir(req.params.session); const idx = parseInt(req.params.idx, 10);
  const offset = parseInt(String(req.query.offset ?? ''), 10);
  if (!dir || !existsSync(dir)) return res.status(404).json({ error: 'unknown upload session' });
  if (!(idx >= 0) || !(offset >= 0)) return res.status(400).json({ error: 'idx and offset are required' });
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const p = join(dir, stagedName(idx, req.query.name));
  const have = existsSync(p) ? statSyncFs(p).size : 0;
  // Strictly sequential: a gap or overlap means the client is out of step; tell it where we are.
  if (offset !== have) return res.status(409).json({ error: `offset ${offset} does not match received ${have}`, size: have });
  const fd = openSync(p, have ? 'r+' : 'w');
  try { writeSync(fd, body, 0, body.length, offset); } finally { closeSync(fd); }
  res.json({ size: have + body.length });
});
app.post('/api/ai/docrag/staging/:session/index', express.json({ limit: '2mb' }), (req, res) => {
  const dir = stagingDir(req.params.session);
  if (!dir || !existsSync(dir)) return res.status(404).json({ error: 'unknown upload session' });
  const { collection, description, files } = req.body || {};
  if (!collection || !Array.isArray(files) || !files.length) return res.status(400).json({ error: 'collection and files are required' });
  if (docRagJob.active) return res.status(409).json({ error: 'A document indexing job is already running.' });
  const ready = [], bad = [];
  for (const f of files) {
    const p = join(dir, stagedName(parseInt(f.idx, 10), f.name));
    const got = existsSync(p) ? statSyncFs(p).size : -1;
    if (got !== Number(f.size)) bad.push(`${f.name} (${got < 0 ? 'missing' : `${got} of ${f.size} bytes`})`);
    else ready.push({ path: p, originalname: String(f.name), ...docFileMeta(f) });
  }
  if (bad.length) return res.status(400).json({ error: `incomplete upload: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` and ${bad.length - 5} more` : ''}` });
  for (const item of Array.isArray(req.body?.serverFiles) ? req.body.serverFiles : []) {
    const sp = typeof item === 'string' ? item : item?.path;
    if (typeof sp !== 'string') continue;
    try { if (statSyncFs(sp).isFile()) ready.push({ path: sp, originalname: basename(sp), keep: true, ...(typeof item === 'object' ? docFileMeta(item) : {}) }); } catch {}
  }
  console.log(`[docrag] staged upload ${req.params.session}: ${ready.length} files ready`);
  Promise.resolve(runDocRagIndexing(ready, collection, description, { pageImages: req.body?.pageImages !== false }))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  res.json({ started: true, collection, fileCount: ready.length });
});

app.post('/api/ai/docrag/index', docUploadMw, (req, res) => {
  if (docRagJob.active) return res.status(409).json({ error: 'A document indexing job is already running.', status: docRagStatus() });
  const collection = req.body?.collection;
  const description = req.body?.description || '';
  const files = req.files || [];
  if (!collection) return res.status(400).json({ error: 'collection name is required' });
  if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
  runDocRagIndexing(files, collection, description, { pageImages: String(req.body?.pageImages ?? 'true') !== 'false' });
  res.json({ started: true, collection, fileCount: files.length });
});

// A page image from a search hit (metadata.page_image). Path is rebuilt from validated parts,
// never taken from the query string, so it cannot leave DOC_PAGES_ROOT.
app.get('/api/ai/docrag/page-image', (req, res) => {
  const col = String(req.query.collection || ''); const page = parseInt(String(req.query.page || ''), 10);
  if (!/^docs_[a-z0-9_]+$/.test(col) || !(page > 0)) return res.status(400).json({ error: 'collection (docs_*) and page are required' });
  const p = join(docPagesDir(col, String(req.query.file || '')), `p${page}.jpg`);
  if (!existsSync(p)) return res.status(404).json({ error: 'no page image (indexed without page images, or deleted)' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  // dotfiles:'allow' - the data dir is .gybackend-data, and send() 404s any dot-path by default.
  res.sendFile(p, { dotfiles: 'allow' });
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
  // Document collections are stored as docs_<name> (runDocRagIndexing prefixes it). Accept either
  // form: deleting by the bare name used to drop a non-existent collection, report every backend
  // "ok", and leave the real one in place.
  const raw = String(req.params.name || '');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return res.status(400).json({ error: 'bad collection name' });
  const colName = raw.startsWith('docs_') ? raw : `docs_${raw}`;
  try {
    const delResp = await fetch(`http://127.0.0.1:${selfPort}/api/proxy/vector/all/collections/${colName}`, {
      method: 'DELETE', signal: AbortSignal.timeout(30000),
    });
    const delData = await delResp.json().catch(() => ({}));
    try { rmSync(join(DOC_PAGES_ROOT, colName), { recursive: true, force: true }); } catch {}
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

// ── Documents in a collection: list / edit / delete (replace = upload with replaceDocId) ──
const docBusy = (colName) => docRagJob.active && docRagJob.colName === colName;
app.get('/api/ai/docrag/collections/:name/documents', async (req, res) => {
  const raw = String(req.params.name || '');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return res.status(400).json({ error: 'bad collection name' });
  const colName = docColFromParam(raw);
  try {
    if (!readDocManifest().some((c) => c.name === colName)) return res.status(404).json({ error: `no collection ${colName}` });
    // A legacy backfill stamps payloads; never race it against an indexing job on the same collection.
    const e = readDocManifest().find((c) => c.name === colName);
    if (!Array.isArray(e?.documents) && docBusy(colName)) return res.status(409).json({ error: 'this collection is being indexed - try again when it finishes' });
    const entry = await ensureDocList(colName);
    res.json({ ...entry, documents: [...(entry.documents || [])].sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true })), busy: docBusy(colName) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.patch('/api/ai/docrag/collections/:name', express.json(), async (req, res) => {
  const colName = docColFromParam(req.params.name);
  const d = typeof req.body?.description === 'string' ? req.body.description.slice(0, 2000) : null;
  if (d == null) return res.status(400).json({ error: 'description is required' });
  let found = false;
  await updateDocManifest((m) => { const e = m.find((c) => c.name === colName); if (e) { e.description = d.trim(); found = true; } return m; });
  if (!found) return res.status(404).json({ error: `no collection ${colName}` });
  res.json({ ok: true });
});
app.patch('/api/ai/docrag/collections/:name/documents/:docId', express.json(), async (req, res) => {
  const colName = docColFromParam(req.params.name);
  const docId = String(req.params.docId || '');
  if (docBusy(colName)) return res.status(409).json({ error: 'this collection is being indexed - try again when it finishes' });
  const m = docFileMeta(req.body || {});
  const patch = {};
  if (m.title !== undefined) { if (!m.title.trim()) return res.status(400).json({ error: 'title cannot be empty' }); patch.title = m.title.trim(); }
  if (m.description !== undefined) patch.description = m.description.trim();
  if (m.doc_type !== undefined) patch.doc_type = m.doc_type.trim();
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change (title, description, doc_type)' });
  try {
    const entry = await ensureDocList(colName);
    if (!entry.documents.some((x) => x.doc_id === docId)) return res.status(404).json({ error: 'no such document' });
    const payload = {};
    if (patch.title !== undefined) payload.doc_title = patch.title;
    if (patch.description !== undefined) payload.doc_description = patch.description;
    if (patch.doc_type !== undefined) payload.doc_type = patch.doc_type;
    await vectorOp(colName, 'set-payload', { filter: docIdFilter(docId), payload });
    await updateDocManifest((mm) => {
      const e = mm.find((c) => c.name === colName);
      const doc = e?.documents?.find((x) => x.doc_id === docId);
      if (doc) Object.assign(doc, patch, { edited_at: new Date().toISOString() });
      return mm;
    });
    res.json({ ok: true, doc_id: docId, ...patch });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.delete('/api/ai/docrag/collections/:name/documents/:docId', async (req, res) => {
  const colName = docColFromParam(req.params.name);
  const docId = String(req.params.docId || '');
  if (docBusy(colName)) return res.status(409).json({ error: 'this collection is being indexed - try again when it finishes' });
  try {
    const entry = await ensureDocList(colName);
    const doc = entry.documents.find((x) => x.doc_id === docId);
    if (!doc) return res.status(404).json({ error: 'no such document' });
    // Vectors first: if that fails the document stays listed (and searchable) rather than becoming a ghost.
    await vectorOp(colName, 'delete-points', { filter: docIdFilter(docId) });
    if (!entry.documents.some((x) => x.doc_id !== docId && x.file_name === doc.file_name)) {
      try { rmSync(docPagesDir(colName, doc.file_name), { recursive: true, force: true }); } catch {}
    }
    await updateDocManifest((mm) => {
      const e = mm.find((c) => c.name === colName);
      if (e) { e.documents = (e.documents || []).filter((x) => x.doc_id !== docId); recomputeDocEntry(e); }
      return mm;
    });
    console.log(`[docrag] ${colName}: deleted document ${docId} (${doc.title})`);
    res.json({ ok: true, deleted: docId, title: doc.title });
  } catch (e) { res.status(502).json({ error: e.message }); }
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
  res.json({ queue: queueView(), length: ragQueue.length });
});

// POST /api/ai/rag/queue/promote { collection } - move a QUEUED run to the front (next after the
// running job). Matches the display name or the codebase_ name. Does not preempt the running job.
app.post('/api/ai/rag/queue/promote', (req, res) => {
  const want = String(req.body?.collection || '');
  if (!want) return res.status(400).json({ error: 'collection is required' });
  const norm = (c) => String(c || '').replace(/^codebase_/, '');
  const i = ragQueue.findIndex((q) => norm(q.collection) === norm(want));
  if (i === -1) return res.status(404).json({ error: `'${want}' is not in the queue`, queue: queueView() });
  const [item] = ragQueue.splice(i, 1);
  item.manual = true;
  ragQueue.unshift(item);
  console.log(`[rag-queue] promoted ${item.collection} from position ${i + 1} to 1`);
  void emitDebug('rag', `promoted ${item.collection} from queue position ${i + 1} to next`);
  res.json({ ok: true, promoted: item.collection, from: i + 1, queue: queueView() });
});

// ── Update-all: re-index every collection that has a repo_url ──
app.post('/api/ai/rag/update-all', async (req, res) => {
  clearRagHold('update-all');
  try {
    const manifestResult = await exec(MCPJUNGLE_HOST,
      'cat /opt/mcp-codebase-rag/data/collections.json 2>/dev/null || echo "[]"',
      { timeout: 10000 });
    const manifest = JSON.parse(manifestResult.stdout || '[]');
    // Optional body.collections: refresh only these (same replace semantics as the nightly run).
    const only = Array.isArray(req.body?.collections) && req.body.collections.length
      ? new Set(req.body.collections.map(String)) : null;
    let queued = 0;
    for (const col of manifest) {
      if (!col.repo_url) continue;
      if (only && !only.has(col.name)) continue;
      ragQueue.push({ type: 'update', collection: col.name });
      queued++;
    }
    if (!ragJob.active && ragQueue.length > 0) processRagQueue();
    // Tell the caller the truth about what will actually happen — a 200 that
    // counts discarded work as queued is how this stayed dark. willRun stays
    // accurate automatically the day runRagUpdate lands.
    const willRun = typeof runRagUpdate === 'function';
    if (queued > 0 && !willRun) {
      void emitNotification('warning', 'codebase-rag',
        'RAG update-all queued collections that will all be skipped',
        `${queued} update item(s) queued this run; runRagUpdate is not implemented, so none will refresh.`);
    }
    res.json({ queued, willRun, collections: manifest.map(c => c.name) });
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
    // The schedule is wall-clock LOCAL time (Travis's, not the host's): CT152 runs
    // Etc/UTC, so getHours() made "01:00" fire at 18:00 in Arizona. America/Phoenix
    // has no DST, but Intl handles it correctly even if the zone is ever changed.
    const TZ = process.env.AILAB_LOCAL_TZ || 'America/Phoenix';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(now);
    const part = (t) => parts.find((p) => p.type === t)?.value || '';
    const hhmm = part('hour') + ':' + part('minute');
    if (hhmm !== (cfg.time || '01:00')) return;
    if (cfg.frequency === 'weekly' && part('weekday') !== 'Sun') return;
    console.log('[rag-autosync] Running scheduled update-all at ' + hhmm);
    clearRagHold('scheduled run');
      void emitDebug('rag-autosync', `scheduled ${cfg.frequency} update-all firing at ${hhmm}`);
    try {
      const resp = await fetch('http://127.0.0.1:' + selfPort + '/api/ai/rag/update-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      console.log('[rag-autosync] Queued ' + data.queued + ' collections for update');
        void emitDebug('rag-autosync', data.queued
          ? `queued ${data.queued} collection(s) for update`
          : 'no collections needed updating');
    } catch (e) {
        console.warn('[rag-autosync] Failed:', e.message);
        // A scheduler that silently stops is indistinguishable from one with nothing to do.
        void emitNotification('warning', 'rag-autosync',
          'Scheduled codebase-RAG update failed to start',
          `The ${cfg.frequency} update-all at ${cfg.time} could not be dispatched: ${e.message}`);
      }
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

// ── Task Progress mirror (Travis, 2026-10-09) ────────────────────────────────────
// A running RAG index was invisible: nothing reported it to the Task Progress
// registry, so the panel showed no entry while the embedder sat pinned for hours.
// A 2s poller mirrors ragJob/docRagJob into POST /api/notifications/task (the
// documented reporter path; same process, loopback). Poller-origin, per the
// registry's knower-beats-inferrer rule.
function mirrorJobToTask(job, idBase, labelPrefix, queueLen, st) {
  const post = (body) => fetch(`http://127.0.0.1:${selfPort}/api/notifications/task`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  const m = /([0-9]+)\/([0-9]+) files/.exec(job.detail || '');
  const done = m ? Number(m[1]) : 0;
  const total = m ? Number(m[2]) : 0;
  const base = {
    id: `${idBase}:index`, source: idBase, origin: 'poller',
    label: `${labelPrefix}: ${job.collection || '\u2026'}`,
    done, total, ...(total > 0 ? {} : { percent: Number(job.progress) || 0 }),
  };
  if (job.active) {
    st.wasActive = true;
    void post({ ...base, state: 'running',
      detail: `${job.phase || ''} \u2014 ${job.detail || ''}${queueLen ? ` (+${queueLen} queued)` : ''}` });
  } else if (st.wasActive) {
    st.wasActive = false;
    // A cancelled run must not wear the success label: phase 'cancelled' has no error set,
    // which previously read as state 'done' with a stale "Processing X/Y" detail.
    const cancelled = job.phase === 'cancelled';
    void post({ ...base, state: job.error ? 'failed' : cancelled ? 'failed' : 'done',
      detail: job.error || (cancelled ? 'cancelled by user \u2014 checkpoint kept; the next scheduled sync resumes' : job.detail || 'finished') });
  }
}
const _ragTaskMirror = { rag: { wasActive: false }, doc: { wasActive: false } };
setInterval(() => {
  try {
    mirrorJobToTask(ragJob, 'codebase-rag', 'RAG index', ragQueue.length, _ragTaskMirror.rag);
    mirrorJobToTask(docRagJob, 'doc-rag', 'Doc index', 0, _ragTaskMirror.doc);
  } catch (e) { console.warn(`[rag-task-mirror] tick failed (contained): ${e?.message || e}`); }
}, 2000).unref?.();

  // ── Resume anything a restart interrupted ──
  // Runs once, shortly after boot so the embedder and vector DBs have settled. Every failure is
  // contained: this is startup code, and an uncaught throw here would take the backend with it.
  setTimeout(async () => {
    try {
      const hold = ragHold();
      if (hold) {
        console.log(`[rag] startup: resume HELD (cancelled ${hold.heldAt}) - checkpoints wait for the next scheduled run`);
        void emitDebug('rag', `startup: resume held since ${hold.heldAt} (cancelled); the next scheduled run picks it up`);
        return;
      }
      const cps = await listCheckpoints();
      if (!cps || !cps.length) {
        void emitDebug('rag', 'startup: no interrupted indexing to resume');
        return;
      }
      void emitDebug('rag',
        `startup: found ${cps.length} interrupted collection(s) — queueing automatic resume`);
      for (const cp of cps) {
        const colName = cp.collection || cp.name;
        if (!colName || !cp.url) {
          void emitDebug('rag', `startup: skipping a checkpoint with no collection/url recorded`);
          continue;
        }
        const displayName = String(colName).replace(/^codebase_/, '');
        ragQueue.push({
          type: 'index', url: cp.url, collection: displayName,
          description: cp.description, branch: cp.branch, resume: true,
        });
        const doneN = cp.completedFiles?.length ?? cp.filesCompleted ?? 0;
        const allN = cp.allFiles?.length ?? cp.filesTotal ?? 0;
        void emitDebug('rag',
          `startup: queued resume of ${displayName} (${doneN}/${allN} files already indexed)`);
      }
      processRagQueue();
    } catch (e) {
      console.warn('[rag] startup resume sweep failed:', e?.message || e);
      void emitNotification('warning', 'rag-index',
        'Could not check for interrupted codebase indexing at startup',
        `The resume sweep failed: ${e?.message || e}. Any half-indexed collection stays on its `
        + `manual Resume button in the Codebase RAG panel.`);
    }
  }, 20_000);
}
