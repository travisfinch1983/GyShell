#!/usr/bin/env node
/**
 * ailab-pages MCP — agent authoring tools for the AI-Lab Pages tab.
 *
 * IDENTITY IS PROGRAMMATIC, never a tool argument (Travis, 2026-08-30): this is a
 * streamable-HTTP server with per-caller path routing, the same pattern as the unified
 * memory service. Each agent is registered on MCPJungle as `pages-<agent>` pinned to
 * /u/agent:<agent>/mcp, and the author recorded on every write is derived from THAT
 * path — an agent cannot forget it, mistype it, or spoof someone else's.
 *
 * Tools: page_write / page_get / page_list, mirroring the flowchart_* family. Pages are
 * versioned append-only on the backend, so overwrites can never destroy earlier work —
 * which is why any agent may write to any page. There is deliberately NO page_delete:
 * deletion stays a human act in the UI.
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_PAGES_MCP_PORT (default 9848),
 *      AILAB_API_TIMEOUT_MS (default 15000).
 * Deploy: /opt/mcp-ailab-pages/ with its own node_modules (same as mcp-ailab-flowchart);
 *         systemd unit ai-lab-pages-mcp.service alongside.
 */
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const BASE = (process.env.AILAB_API_URL ?? 'http://127.0.0.1:17890').replace(/\/+$/, '')
const PORT = Number(process.env.AILAB_PAGES_MCP_PORT ?? 9848)
const TIMEOUT = Number(process.env.AILAB_API_TIMEOUT_MS ?? 15000)
const enc = (s) => encodeURIComponent(String(s))
const q = (params) => {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`)
  return data
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })

/** One McpServer per request, closed over the caller identity from the URL path. */
function buildServer(author) {
  const mcp = new McpServer(
    { name: 'ailab-pages', version: '1.0.0' },
    {
      instructions:
        'Author and read AI-Lab Pages — rendered documents in the Pages tab. Writes are ' +
        'versioned append-only (your write adds a version; nothing is destroyed) and your ' +
        `authorship (${author}) is recorded automatically. Markdown is preferred; fenced ` +
        '```mermaid blocks render as diagrams, and {{flowchart:ID}} / {{svg:ID}} embed stored ' +
        'diagrams live (they update when the diagram is edited). No delete — that is human-only.',
    },
  )

  mcp.tool(
    'page_write',
    'Create a page or add a new version to an existing one. Append-only: earlier versions stay ' +
      'restorable, so writing to a page someone else authored is safe and records you as co-author.',
    {
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/).describe('page slug, e.g. optane-kv-cache'),
      title: z.string().min(1).max(200),
      body: z.string().max(4 * 1024 * 1024).describe('markdown (preferred) or raw HTML per content_type'),
      content_type: z.enum(['markdown', 'html']).default('markdown'),
    },
    async ({ id, title, body, content_type }) => {
      const r = await api('PUT', `/api/pages/${enc(id)}`, {
        title, body, contentType: content_type, author,
      })
      return text(`wrote page ${id} version ${r.version} (author: ${author}). View it in the Pages tab.`)
    },
  )

  mcp.tool(
    'page_get',
    'Read a page: returns the authored SOURCE (what page_write accepts back), plus title, ' +
      'version and author info. Pass version to read history.',
    {
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
      version: z.number().int().positive().optional(),
    },
    async ({ id, version }) => {
      const r = await api('GET', `/api/pages/${enc(id)}${version ? `?version=${version}` : ''}`)
      const m = r.meta
      const head =
        `page ${m.id} — "${m.title}" v${r.version}/${m.currentVersion}` +
        ` · ${m.contentType} · authors: ${(m.authors ?? []).join(', ') || 'unknown'}\n` +
        m.versions.map((v) => `  v${v.version} ${v.createdAt} by ${v.author ?? '?'}${v.restoredFrom ? ` (restored from v${v.restoredFrom})` : ''}`).join('\n')
      return text(`${head}\n--- source ---\n${r.source}`)
    },
  )

  mcp.tool('page_list', 'List all pages with title, latest version, and authors.', {}, async () => {
    const r = await api('GET', '/api/pages')
    if (!r.pages?.length) return text('(no pages)')
    return text(
      r.pages
        .map((p) => `${p.id} — "${p.title}" v${p.currentVersion} (${p.versionCount} versions) · ${p.kind ?? 'document'}${p.category ? `/${p.category}` : ''} · authors: ${(p.authors ?? []).join(', ') || 'unknown'} · updated ${p.updatedAt}`)
        .join('\n'),
    )
  })

  // ── Reports ────────────────────────────────────────────────────────────────
  // A report is a page with a CATEGORY (its own RAG collection) and the summary
  // fields the journal is derived from. Category is validated against the live
  // list server-side, so "which category" cannot be silently wrong — the same
  // principle that makes authorship unspoofable.

  mcp.tool(
    'report_categories',
    'List report categories and their STARTING templates. Call this before report_write: the template is a beginning to adapt, never a schema you must match.',
    {},
    async () => {
      const r = await api('GET', '/api/pages/report-categories')
      const rows = (r.categories ?? []).map(
        (c) => `${c.id} — ${c.label}${c.description ? `: ${c.description}` : ''}`,
      )
      return text(`report categories:\n${rows.join('\n')}\n\n(call report_template for a category's starting template)`)
    },
  )

  mcp.tool(
    'report_template',
    "Get one category's starting template — copy it, then change whatever the report needs. Sections that do not apply should be removed rather than left empty.",
    { category: z.string() },
    async ({ category }) => {
      const r = await api('GET', '/api/pages/report-categories')
      const cat = (r.categories ?? []).find((c) => c.id === category)
      if (!cat) return text(`no such category '${category}'. Available: ${(r.categories ?? []).map((c) => c.id).join(', ')}`)
      return text(`template for ${cat.id} (${cat.label}) — a STARTING point, modify freely:\n\n${cat.template}`)
    },
  )

  mcp.tool(
    'report_write',
    'File a report (or add a version to an existing one). Reports are versioned append-only and vectorised into their category\'s searchable collection. issue/cause/fix become the journal line — keep them to one line each; the detail belongs in the body.',
    {
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/).describe('report slug, e.g. maintenance-optane-pruner-20260830'),
      title: z.string().min(1).max(200),
      category: z.string().describe('must be one of report_categories'),
      issue: z.string().min(1).max(200).describe('short problem name — the journal\'s primary column'),
      cause: z.string().max(500).optional().describe('one line: what was actually wrong'),
      fix: z.string().max(500).optional().describe('one line: what you did about it'),
      links: z.array(z.string()).optional().describe('notification ids, service names, URLs, related page ids'),
      body: z.string().max(4 * 1024 * 1024).describe('the full report, markdown'),
    },
    async ({ id, title, category, issue, cause, fix, links, body }) => {
      const r = await api('PUT', `/api/pages/${enc(id)}`, {
        title, body, contentType: 'markdown', author, kind: 'report', category,
        report: { issue, cause, fix, links: links ?? [] },
      })
      const idx = r.indexed === false
        ? `\n⚠ saved but NOT vectorised (${r.indexError}) — the report is fine, semantic search will miss it until re-filed.`
        : ''
      return text(`filed report ${id} v${r.version} in ${category} (author: ${author}). Journal entry created automatically.${idx}`)
    },
  )

  mcp.tool(
    'report_search',
    'Semantic search across report collections. Use this BEFORE investigating a problem — a prior repair of the same issue is the fastest fix available.',
    { query: z.string().min(1), category: z.string().optional().describe('omit to search every category') },
    async ({ query, category }) => {
      const r = await api('GET', `/api/pages/report-search${q({ q: query, category })}`)
      const out = []
      for (const c of r.collections ?? []) {
        if (c.error) { out.push(`${c.category}: (search unavailable: ${c.error})`); continue }
        for (const hit of c.results ?? []) {
          out.push(`[${c.category}] ${hit.doc_id ?? '?'} (score ${hit.score ?? '?'}): ${String(hit.text ?? '').slice(0, 240).replace(/\n/g, ' ')}`)
        }
      }
      return text(out.length ? out.join('\n') : `no report matches for '${query}'`)
    },
  )

  mcp.tool(
    'journal_read',
    'The maintenance journal: every report as one skimmable line (when, issue, cause, fix, report id). Purpose is memory ACROSS context windows — read it to spot a repeat problem you have no memory of fixing.',
    { category: z.string().optional(), limit: z.number().int().positive().max(200).optional() },
    async ({ category, limit }) => {
      const r = await api('GET', `/api/pages/journal${q({ category })}`)
      const entries = (r.entries ?? []).slice(0, limit ?? 50)
      if (!entries.length) return text('(journal is empty — no reports filed yet)')
      return text(entries.map((e) =>
        `${e.receivedAt} · [${e.category}] ${e.issue}` +
        `${e.cause ? ` · cause: ${e.cause}` : ''}${e.fix ? ` · fix: ${e.fix}` : ''}` +
        ` · report: ${e.pageId} (v${e.version}${e.author ? `, ${e.author}` : ''})`,
      ).join('\n'))
    },
  )

  return mcp
}

/**
 * Caller identity from the path: /u/<caller>/mcp. The registered form is
 * agent:<profile>; the recorded author drops the prefix. Anything outside the
 * slug alphabet is refused — the memory service's lesson is that answering
 * every path yields silently-wrong namespaces, so unknown shapes 404 loudly.
 */
function callerFrom(url) {
  const m = /^\/u\/([A-Za-z0-9:_-]{1,80})\/mcp\/?$/.exec(url.split('?')[0])
  if (!m) return null
  return m[1].replace(/^agent:/, '')
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'ailab-pages-mcp' }))
    return
  }
  const caller = callerFrom(req.url ?? '')
  if (!caller) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'expected /u/<caller>/mcp' }))
    return
  }
  try {
    // Stateless streamable HTTP: fresh server+transport per request, identity baked in.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const mcp = buildServer(caller)
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(e?.message ?? e) }))
    }
  }
})

server.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`ailab-pages MCP listening on :${PORT} (backend ${BASE})\n`)
})
