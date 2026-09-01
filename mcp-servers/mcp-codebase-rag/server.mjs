#!/usr/bin/env node
/**
 * mcp-codebase-rag — MCP server for indexing and searching codebases
 *
 * Clones git repos, chunks code files, embeds via ProxLab proxy,
 * stores in vector DBs via ProxLab vector proxy, and provides
 * semantic search across indexed codebases.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'fs';
import { join, extname, relative } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

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
      console.error(`[mcp-codebase-rag] rag-models.json unreadable at ${RAG_MODELS_FILE} (${e.message}) `
        + `-- falling back to '${EMBED_MODEL_FALLBACK}', which may NOT match the indexed corpus`);
      _ragCfgCache.warnedAt = now;
    }
  }
  _ragCfgCache = { ..._ragCfgCache, model: m || EMBED_MODEL_FALLBACK, ts: now };
  return _ragCfgCache.model;
}
const EMBED_DIM = parseInt(process.env.EMBED_DIM || '4096', 10);
const MANIFEST_FILE = join(DATA_DIR, 'collections.json');

// Chunk settings
const MAX_FILE_SIZE = 512 * 1024; // Skip files > 512KB
const SMALL_FILE_THRESHOLD = 1500; // Files <= this size = one chunk
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH_SIZE = 16; // Max texts per embed call

// ── File type detection ─────────────────────────────────────────────────────
const LANG_MAP = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.pyx': 'Python',
  '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++',
  '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift',
  '.lua': 'Lua', '.r': 'R', '.R': 'R', '.jl': 'Julia',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell',
  '.sql': 'SQL', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.less': 'LESS', '.vue': 'Vue', '.svelte': 'Svelte',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
  '.xml': 'XML', '.md': 'Markdown', '.rst': 'reStructuredText',
  '.tf': 'Terraform', '.hcl': 'HCL',
  '.dockerfile': 'Dockerfile', '.proto': 'Protobuf',
  '.graphql': 'GraphQL', '.gql': 'GraphQL',
  '.zig': 'Zig', '.nim': 'Nim', '.ex': 'Elixir', '.exs': 'Elixir',
  '.erl': 'Erlang', '.hs': 'Haskell', '.ml': 'OCaml',
  '.scala': 'Scala', '.clj': 'Clojure', '.dart': 'Dart',
};

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', '.env',
  'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'target', 'vendor', '.idea', '.vscode', '.cache',
  'coverage', '.nyc_output', '.tox', 'egg-info',
]);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pyc', '.pyo', '.class', '.wasm',
  '.lock', '.min.js', '.min.css', '.map',
  '.DS_Store', '.env',
]);

const SKIP_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
  '.gitignore', '.gitattributes', '.editorconfig',
  'LICENSE', 'LICENSE.md', 'LICENSE.txt',
]);

// ── Manifest helpers ────────────────────────────────────────────────────────
function loadManifest() {
  try {
    if (existsSync(MANIFEST_FILE)) return JSON.parse(readFileSync(MANIFEST_FILE, 'utf-8'));
  } catch {}
  return [];
}

function saveManifest(data) {
  writeFileSync(MANIFEST_FILE, JSON.stringify(data, null, 2));
}

// ── Sanitize collection name ────────────────────────────────────────────────
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function collectionName(name) {
  return `codebase_${sanitizeName(name)}`;
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

async function createCollection(name) {
  const resp = await fetch(`${PROXLAB_URL}/api/proxy/vector/all/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dimension: EMBED_DIM }),
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

async function upsertPoints(collection, points) {
  const resp = await fetch(`${PROXLAB_URL}/api/proxy/vector/all/collections/${collection}/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
    signal: AbortSignal.timeout(120000),
  });
  return resp.json();
}

async function searchCollection(collection, query, topK = 10) {
  // Pre-vectorize the query ourselves (ProxLab's embed config may point elsewhere)
  const vecs = await embedTexts([query]);
  const vector = vecs[0];
  const resp = await fetch(`${PROXLAB_URL}/api/proxy/vector/all/collections/${collection}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, topK }),
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

async function deleteCollection(name) {
  const resp = await fetch(`${PROXLAB_URL}/api/proxy/vector/all/collections/${name}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

// ── File walking & chunking ─────────────────────────────────────────────────
function shouldSkip(filePath, name, includePatterns, excludePatterns) {
  // Check skip sets
  if (SKIP_FILENAMES.has(name)) return true;
  const ext = extname(name).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;
  if (!ext && !name.includes('.')) {
    // No extension — skip unless it's a known config file
    const knownNoExt = new Set(['Makefile', 'Dockerfile', 'Rakefile', 'Gemfile', 'Procfile', 'Vagrantfile']);
    if (!knownNoExt.has(name)) return true;
  }

  // Custom exclude patterns (glob-like)
  if (excludePatterns?.length) {
    for (const pat of excludePatterns) {
      if (filePath.includes(pat) || name.match(globToRegex(pat))) return true;
    }
  }

  // Custom include patterns — if specified, file must match at least one
  if (includePatterns?.length) {
    let matched = false;
    for (const pat of includePatterns) {
      if (filePath.includes(pat) || name.match(globToRegex(pat))) { matched = true; break; }
    }
    if (!matched) return true;
  }

  return false;
}

function globToRegex(glob) {
  try {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(escaped);
  } catch {
    return /(?!)/; // Never matches
  }
}

function walkDir(dir, basePath, includePatterns, excludePatterns) {
  const files = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return files; }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walkDir(fullPath, basePath, includePatterns, excludePatterns));
    } else if (entry.isFile()) {
      const relPath = relative(basePath, fullPath);
      if (shouldSkip(relPath, entry.name, includePatterns, excludePatterns)) continue;
      try {
        const stat = statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        if (stat.size === 0) continue;
        files.push({ fullPath, relPath, size: stat.size });
      } catch { continue; }
    }
  }
  return files;
}

function chunkFile(content, filePath, language) {
  const header = `// File: ${filePath}\n`;
  const chunks = [];

  if (content.length <= SMALL_FILE_THRESHOLD) {
    chunks.push({ text: header + content, filePath, language });
  } else {
    let offset = 0;
    let chunkIdx = 0;
    while (offset < content.length) {
      const end = Math.min(offset + CHUNK_SIZE, content.length);
      const slice = content.slice(offset, end);
      chunks.push({
        text: header + slice,
        filePath,
        language,
        chunkIndex: chunkIdx,
      });
      if (end >= content.length) break; // Last chunk
      offset = end - CHUNK_OVERLAP;
      chunkIdx++;
    }
  }
  return chunks;
}

// ── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'codebase-rag',
  version: '1.0.0',
});

// ─── Tool: index_repo ───────────────────────────────────────────────────────
server.tool(
  'index_repo',
  'Clone a git repo and index all code files into a named vector collection for semantic search',
  {
    url: z.string().describe('Git repository URL (GitHub, Gitea, etc.)'),
    collection: z.string().describe('Collection name (alphanumeric + hyphens, e.g. "my-project")'),
    description: z.string().optional().describe('Short description of the codebase'),
    branch: z.string().optional().describe('Branch to clone (default: default branch)'),
    include_patterns: z.array(z.string()).optional().describe('Only index files matching these patterns (e.g. ["*.py", "src/"])'),
    exclude_patterns: z.array(z.string()).optional().describe('Skip files matching these patterns (e.g. ["tests/", "*.test.js"])'),
  },
  async ({ url, collection, description, branch, include_patterns, exclude_patterns }) => {
    const colName = collectionName(collection);
    const tmpDir = `/tmp/codebase-rag-${randomUUID()}`;

    try {
      // 1. Clone repo
      const branchArg = branch ? `--branch ${branch}` : '';
      execSync(`git clone --depth 1 ${branchArg} "${url}" "${tmpDir}" 2>&1`, {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });

      // 2. Walk file tree
      const files = walkDir(tmpDir, tmpDir, include_patterns, exclude_patterns);
      if (files.length === 0) {
        rmSync(tmpDir, { recursive: true, force: true });
        return { content: [{ type: 'text', text: 'No indexable files found in repository.' }] };
      }

      // 3. Read files and create chunks
      const allChunks = [];
      const languageCounts = {};
      let totalFilesProcessed = 0;

      for (const file of files) {
        try {
          const content = readFileSync(file.fullPath, 'utf-8');
          // Skip binary-looking content
          if (content.includes('\0')) continue;

          const ext = extname(file.relPath).toLowerCase();
          const language = LANG_MAP[ext] || 'Unknown';
          languageCounts[language] = (languageCounts[language] || 0) + 1;

          const chunks = chunkFile(content, file.relPath, language);
          for (const chunk of chunks) {
            allChunks.push({
              id: `${colName}::${file.relPath}::${chunk.chunkIndex || 0}`,
              text: chunk.text,
              metadata: {
                file_path: chunk.filePath,
                language: chunk.language,
                repo_url: url,
                collection: colName,
              },
            });
          }
          totalFilesProcessed++;
        } catch { continue; }
      }

      if (allChunks.length === 0) {
        rmSync(tmpDir, { recursive: true, force: true });
        return { content: [{ type: 'text', text: 'No valid code content found to index.' }] };
      }

      // 4. Create collection in vector DBs
      await createCollection(colName);

      // 5. Batch embed and upsert (embed first, then send pre-vectorized points)
      let upsertedCount = 0;
      for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
        const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
        try {
          // Embed the batch
          const texts = batch.map(c => c.text);
          const embeddings = await embedTexts(texts);

          // Build pre-vectorized points
          const points = batch.map((c, idx) => ({
            id: c.id,
            vector: embeddings[idx],
            metadata: { text: c.text, ...c.metadata },
          }));

          await upsertPoints(colName, points);
          upsertedCount += batch.length;
        } catch (e) {
          // Log but continue — partial indexing is still useful
          console.error(`[codebase-rag] Batch embed/upsert failed at offset ${i}: ${e.message}`);
        }
      }

      // 6. Update manifest
      const manifest = loadManifest();
      const existing = manifest.findIndex(m => m.name === colName);
      const entry = {
        name: colName,
        display_name: collection,
        description: description || '',
        repo_url: url,
        branch: branch || 'default',
        files_indexed: totalFilesProcessed,
        chunks_created: upsertedCount,
        languages: languageCounts,
        indexed_at: new Date().toISOString(),
      };
      if (existing >= 0) manifest[existing] = entry;
      else manifest.push(entry);
      saveManifest(manifest);

      // 7. Cleanup
      rmSync(tmpDir, { recursive: true, force: true });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            collection: colName,
            files_indexed: totalFilesProcessed,
            chunks_created: upsertedCount,
            repo_url: url,
            languages: languageCounts,
          }, null, 2),
        }],
      };
    } catch (e) {
      // Cleanup on error
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return { content: [{ type: 'text', text: `Error indexing repo: ${e.message}` }], isError: true };
    }
  },
);

// ─── Tool: search_code ──────────────────────────────────────────────────────
server.tool(
  'search_code',
  'Semantic search across indexed codebase collections. Returns ranked code snippets matching the query.',
  {
    query: z.string().describe('Search query (natural language or code pattern)'),
    collection: z.string().optional().describe('Specific collection to search (without codebase_ prefix). Omit to search all.'),
    k: z.number().optional().describe('Number of results to return (default: 10)'),
    language: z.string().optional().describe('Filter by programming language (e.g. "Python", "JavaScript")'),
  },
  async ({ query, collection, k, language }) => {
    const topK = k || 10;

    try {
      let results;
      if (collection) {
        const colName = collectionName(collection);
        results = await searchCollection(colName, query, topK);
      } else {
        // Search all codebase collections
        const manifest = loadManifest();
        if (manifest.length === 0) {
          return { content: [{ type: 'text', text: 'No codebase collections indexed yet. Use index_repo first.' }] };
        }

        // Search each collection and merge
        const allResults = [];
        for (const col of manifest) {
          try {
            const r = await searchCollection(col.name, query, topK);
            if (r.results) {
              for (const item of r.results) {
                allResults.push({ ...item, collection: col.display_name });
              }
            }
          } catch { continue; }
        }

        // Sort by RRF score and take top K
        allResults.sort((a, b) => (b.rrfScore || b.rerankScore || 0) - (a.rrfScore || a.rerankScore || 0));
        results = { results: allResults.slice(0, topK) };
      }

      // Filter by language if requested
      let items = results.results || [];
      if (language) {
        items = items.filter(r => {
          const meta = r.metadata || {};
          const lang = meta.language || meta.metadata?.language || '';
          return lang.toLowerCase() === language.toLowerCase();
        });
      }

      // Format results
      const formatted = items.map((r, i) => {
        const meta = r.metadata || {};
        // Try to parse metadata if it's a JSON string
        let parsedMeta = meta;
        if (typeof meta.metadata === 'string') {
          try { parsedMeta = { ...meta, ...JSON.parse(meta.metadata) }; } catch {}
        }
        const filePath = parsedMeta.file_path || meta.file_path || 'unknown';
        const lang = parsedMeta.language || meta.language || '';
        const score = r.rerankScore || r.rrfScore || 0;
        const col = r.collection || parsedMeta.collection || '';

        return `--- Result ${i + 1} (score: ${score.toFixed(4)}) ---
File: ${filePath}${lang ? ` [${lang}]` : ''}${col ? ` (${col})` : ''}

${r.text || ''}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: formatted || 'No results found.',
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Search error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Tool: list_collections ─────────────────────────────────────────────────
server.tool(
  'list_collections',
  'List all indexed codebase collections with metadata (name, repo URL, file count, etc.)',
  {},
  async () => {
    const manifest = loadManifest();
    if (manifest.length === 0) {
      return { content: [{ type: 'text', text: 'No codebase collections indexed yet.' }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(manifest, null, 2),
      }],
    };
  },
);

// ─── Tool: delete_collection ────────────────────────────────────────────────
server.tool(
  'delete_collection',
  'Delete an indexed codebase collection from all vector DBs',
  {
    collection: z.string().describe('Collection name to delete (without codebase_ prefix)'),
  },
  async ({ collection }) => {
    const colName = collectionName(collection);

    try {
      const result = await deleteCollection(colName);

      // Remove from manifest
      const manifest = loadManifest();
      const filtered = manifest.filter(m => m.name !== colName);
      saveManifest(filtered);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ deleted: colName, vector_db_results: result }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Delete error: ${e.message}` }], isError: true };
    }
  },
);

// ─── Tool: collection_stats ─────────────────────────────────────────────────
server.tool(
  'collection_stats',
  'Get detailed stats for a specific indexed codebase collection',
  {
    collection: z.string().describe('Collection name (without codebase_ prefix)'),
  },
  async ({ collection }) => {
    const colName = collectionName(collection);
    const manifest = loadManifest();
    const entry = manifest.find(m => m.name === colName);

    if (!entry) {
      return { content: [{ type: 'text', text: `Collection "${collection}" not found. Use list_collections to see available collections.` }] };
    }

    // LIVE state, read from the vector store itself. The manifest numbers are
    // a record of the last SUCCESSFUL index — stats built only from them
    // reported a DEAD collection as healthy (files_indexed: 118 on a store
    // holding zero vectors; codebase_proxlab, 2026-08-31), and anyone
    // verifying an emptiness alert with this tool concluded the alert was
    // wrong. An authoritative surface must read the thing it claims to
    // describe, or say plainly that it cannot.
    let live = { status: 'unknown', points: null, detail: 'live count unavailable (vector proxy unreachable)' };
    try {
      const resp = await fetch(`${PROXLAB_URL}/api/proxy/vector/all/collections/${colName}/count`, {
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        const d = await resp.json();
        if (typeof d.maxCount === 'number') {
          live = d.maxCount > 0
            ? { status: 'live', points: d.counts, detail: `${d.maxCount} points in the best-populated backend` }
            : { status: 'EMPTY', points: d.counts, detail: 'ZERO vectors in every answering backend — search on this collection returns nothing. The historical numbers below describe an index that NO LONGER EXISTS in the store.' };
        }
      }
    } catch { /* live stays 'unknown' — cannot-count is stated, never guessed */ }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          name: entry.name,
          display_name: entry.display_name,
          description: entry.description,
          repo_url: entry.repo_url,
          branch: entry.branch,
          live_state: live,
          last_successful_index: {
            note: 'HISTORICAL — recorded when the last index run finished. NOT live store state; see live_state for that.',
            files_indexed: entry.files_indexed,
            chunks_created: entry.chunks_created,
            languages: entry.languages,
            indexed_at: entry.indexed_at,
          },
        }, null, 2),
      }],
    };
  },
);

// ── Start server ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
