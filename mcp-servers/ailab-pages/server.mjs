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
        .map((p) => `${p.id} — "${p.title}" v${p.currentVersion} (${p.versionCount} versions) · ${p.contentType} · authors: ${(p.authors ?? []).join(', ') || 'unknown'} · updated ${p.updatedAt}`)
        .join('\n'),
    )
  })

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
