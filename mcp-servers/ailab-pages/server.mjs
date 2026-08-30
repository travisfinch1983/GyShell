#!/usr/bin/env node
/**
 * ailab-authoring MCP — THREE SEPARATE TOOLSETS served from one process.
 *
 * 🛑 Separate by design (Travis, 2026-08-30): "a toolset for Scoping Pages, a
 * toolset for Reports, and a toolset for maintenance claude to make his journal
 * entries… this way they don't accidentally get all mixed in together." An
 * agent holding only Reports cannot file into Pages by accident, and a
 * camera-monitoring agent never sees journal tools at all.
 *
 * Each toolset is its own URL prefix and therefore its own MCPJungle server,
 * assignable per agent independently:
 *   /pages/u/<caller>/mcp    → pages-<agent>    scoping documents
 *   /reports/u/<caller>/mcp  → reports-<agent>  typed reports (maintenance,
 *                              security, vulnerability, incident, research…)
 *   /journal/u/<caller>/mcp  → journal-<agent>  the working log
 *
 * IDENTITY IS PROGRAMMATIC: the author recorded on every write comes from the
 * caller path, never a tool argument — an agent cannot forget it, mistype it,
 * or spoof another's.
 *
 * ⚠ MCPJungle caches tool schemas AT REGISTRATION. Changing a toolset needs
 * `mcpjungle register --force` per server; restarting this process is not
 * enough and new tools stay invisible to every agent (claude1, 2026-08-30).
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_PAGES_MCP_PORT
 *      (default 9848), AILAB_API_TIMEOUT_MS (default 15000).
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
  const raw = await res.text()
  let data
  try { data = JSON.parse(raw) } catch { data = { raw } }
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`)
  return data
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)

// ── Toolset: SCOPING PAGES ───────────────────────────────────────────────────
function addPageTools(mcp, author) {
  mcp.tool(
    'page_write',
    'Create or revise a SCOPING PAGE — a design doc, plan, rundown or reference. NOT for reports or journal entries: those have their own toolsets. Append-only, so revising someone else\'s page is safe and records you as co-author.',
    {
      id: slug.describe('page slug, e.g. optane-kv-cache'),
      title: z.string().min(1).max(200),
      body: z.string().max(4 * 1024 * 1024).describe('markdown (preferred) or raw HTML per content_type'),
      content_type: z.enum(['markdown', 'html']).default('markdown'),
    },
    async ({ id, title, body, content_type }) => {
      const r = await api('PUT', `/api/pages/${enc(id)}`, { title, body, contentType: content_type, author })
      return text(`wrote page ${id} v${r.version} (author: ${author}). Pages tab → Documents.`)
    },
  )

  mcp.tool('page_get', 'Read a scoping page: authored source plus version and author history.',
    { id: slug, version: z.number().int().positive().optional() },
    async ({ id, version }) => {
      const r = await api('GET', `/api/pages/${enc(id)}${version ? `?version=${version}` : ''}`)
      const m = r.meta
      return text(
        `page ${m.id} — "${m.title}" v${r.version}/${m.currentVersion} · authors: ${(m.authors ?? []).join(', ') || 'unknown'}\n` +
        m.versions.map((v) => `  v${v.version} ${v.createdAt} by ${v.author ?? '?'}`).join('\n') +
        `\n--- source ---\n${r.source}`)
    })

  mcp.tool('page_list', 'List scoping pages.', {}, async () => {
    const r = await api('GET', '/api/pages')
    if (!r.pages?.length) return text('(no pages)')
    return text(r.pages.map((p) => `${p.id} — "${p.title}" v${p.currentVersion} · authors: ${(p.authors ?? []).join(', ') || 'unknown'} · ${p.updatedAt}`).join('\n'))
  })
}

// ── Toolset: REPORTS ─────────────────────────────────────────────────────────
function addReportTools(mcp, author) {
  mcp.tool(
    'report_types',
    'List the report TYPES you may file under, with what each is for. Call this first — the type decides which collection the report is searchable in and who reads it.',
    {},
    async () => {
      const r = await api('GET', '/api/reports/types')
      return text(`report types:\n${(r.types ?? []).map((t) => `  ${t.id} — ${t.label}${t.description ? `: ${t.description}` : ''}`).join('\n')}\n\n(report_template <type> for its starting template)`)
    },
  )

  mcp.tool(
    'report_template',
    'Get a type\'s STARTING template — copy it and change whatever the report needs. Sections that do not apply should be deleted, not left empty. It is a beginning, never a schema you must match.',
    { type: z.string() },
    async ({ type }) => {
      const r = await api('GET', '/api/reports/types')
      const t = (r.types ?? []).find((x) => x.id === type)
      if (!t) return text(`no such report type '${type}'. Available: ${(r.types ?? []).map((x) => x.id).join(', ')}`)
      return text(`template for ${t.id} (${t.label}) — a STARTING point, modify freely:\n\n${t.template}`)
    },
  )

  mcp.tool(
    'report_write',
    'File a report of a chosen TYPE (or add a version to an existing one). Reports are append-only and vectorised into their type\'s collection. The type cannot be changed later — it decides where the report is searchable.',
    {
      id: slug.describe('report slug, e.g. maintenance-optane-pruner-20260830'),
      type: z.string().describe('one of report_types'),
      title: z.string().min(1).max(200),
      summary: z.string().max(300).optional().describe('one line: what this is about — the list column'),
      body: z.string().max(4 * 1024 * 1024).describe('the full report, markdown'),
      links: z.array(z.string()).optional().describe('notification ids, hosts, services, other report ids'),
    },
    async ({ id, type, title, summary, body, links }) => {
      const r = await api('PUT', `/api/reports/${enc(id)}`, { type, title, summary, body, links, author })
      const idx = r.indexed === false
        ? `\n⚠ saved but NOT vectorised (${r.indexError}) — the report is safe; semantic search will miss it until re-filed.`
        : ''
      return text(`filed ${type} report ${id} v${r.version} (author: ${author}).${idx}\nIf you keep a journal, link this id there so the next lookup finds it.`)
    },
  )

  mcp.tool('report_get', 'Read a filed report.', { id: slug, version: z.number().int().positive().optional() },
    async ({ id, version }) => {
      const r = await api('GET', `/api/reports/${enc(id)}${version ? `?version=${version}` : ''}`)
      const m = r.meta
      return text(`report ${m.id} [${m.type}] — "${m.title}" v${r.version}/${m.currentVersion}` +
        `${m.summary ? `\nsummary: ${m.summary}` : ''}\nauthors: ${(m.authors ?? []).join(', ') || 'unknown'}\n--- source ---\n${r.source}`)
    })

  mcp.tool(
    'report_search',
    'Semantic search across report collections. Use this BEFORE investigating anything — a prior report on the same problem is the fastest fix available.',
    { query: z.string().min(1), type: z.string().optional().describe('omit to search every type') },
    async ({ query, type }) => {
      const r = await api('GET', `/api/reports-search${q({ q: query, type })}`)
      const out = []
      for (const c of r.collections ?? []) {
        if (c.error) { out.push(`${c.type}: (search unavailable: ${c.error})`); continue }
        for (const hit of c.results ?? []) {
          out.push(`[${c.type}] ${hit.doc_id ?? '?'} (score ${hit.score ?? '?'}): ${String(hit.text ?? '').slice(0, 240).replace(/\n/g, ' ')}`)
        }
      }
      return text(out.length ? out.join('\n') : `no report matches for '${query}'`)
    },
  )

  mcp.tool('report_list', 'List filed reports, newest first.', { type: z.string().optional() },
    async ({ type }) => {
      const r = await api('GET', `/api/reports${q({ type })}`)
      if (!r.reports?.length) return text('(no reports)')
      return text(r.reports.map((x) => `${x.id} [${x.type}] "${x.title}" v${x.currentVersion} · ${x.summary ?? ''} · ${x.updatedAt}`).join('\n'))
    })
}

// ── Toolset: JOURNAL ─────────────────────────────────────────────────────────
function addJournalTools(mcp, author) {
  mcp.tool(
    'journal_new',
    'Start a journal entry when you START work — not after. The journal is your memory across context windows: an entry you meant to write later is one you will not remember to write. The reply tells you how many times you have logged this same issue before.',
    {
      issue: z.string().min(1).max(200).describe('short name of what you are looking at — display text, free to reword later'),
      key: z.string().max(120).describe("REQUIRED for anything an emitter reported: 'source:subject' — the source AND the specific thing affected, e.g. 'health:qdrant', 'optane-pruner:pool-a', 'model-bindings:qwen3-30b'. NEVER a bare source ('health' covers a dozen dependencies, so it would report a brand-new outage as one you already dismissed) and NEVER a joined list ('pool-a, pool-b' changes as pools are fixed). Both are refused. Take source and subject from the alert's own fields, not its message text — messages interpolate counts and ids, so prose matching silently misses repeats. ONE ENTRY PER SUBJECT: if three pools are affected, that is three entries. Omit only for self-directed work with no emitter behind it, and expect a weaker, text-matched count."),
      notes: z.string().max(20000).optional().describe('what you know so far'),
      status: z.enum(['open', 'resolved', 'no-action']).optional().describe("default open; 'no-action' = looked at it, nothing to repair"),
      report_ids: z.array(z.string()).optional(),
      links: z.array(z.string()).optional().describe('notification ids, services, hosts'),
    },
    async ({ issue, key, notes, status, report_ids, links }) => {
      const r = await api('POST', '/api/journal', { issue, key, notes, status, reportIds: report_ids, links, author })
      if (r.priorSimilar) {
        const per = Object.entries(r.perKey ?? {}).filter(([, n]) => n > 0)
          .map(([k, n]) => `${k} ×${n}`).join(', ')
        return text(`logged ${r.id} (author: ${author}).\n` +
          `⚠ SEEN BEFORE: ${r.priorSimilar} prior entr${r.priorSimilar === 1 ? 'y' : 'ies'}` +
          `${per ? ` — ${per}` : ''} (matched by ${r.matchedBy}).\n` +
          `${r.keyed ? 'Look at those before treating this as new.' : 'This count came from TEXT matching and may be wrong in either direction — pass a source:subject key for a reliable one.'}`)
      }
      const repeat = r.priorSimilar > 0
        ? `\n⚠ You have logged this same issue ${r.priorSimilar} time(s) before. A recurring problem is itself a finding — check what you did last time before repeating it.`
        : ''
      return text(`journal entry ${r.id} started (${status ?? 'open'}).${repeat}\nAdd to it with journal_append as you work.`)
    },
  )

  mcp.tool(
    'journal_append',
    'Add a line to an entry as you work — findings, attempts, results. Appends are additive and timestamped; nothing is replaced. Use this rather than rewriting the entry.',
    {
      id: z.string(),
      text: z.string().min(1).max(20000),
      status: z.enum(['open', 'resolved', 'no-action']).optional().describe('set when the outcome becomes clear'),
      report_ids: z.array(z.string()).optional().describe('link the report when you file one'),
      links: z.array(z.string()).optional(),
    },
    async ({ id, text: line, status, report_ids, links }) => {
      const r = await api('POST', `/api/journal/${enc(id)}/append`, { text: line, status, reportIds: report_ids, links, author })
      return text(`appended to ${id} (status: ${r.status}).`)
    },
  )

  mcp.tool(
    'journal_update',
    'Correct an entry: replaces fields outright. The previous text is KEPT as a revision, so a correction never erases what the log used to say. Prefer journal_append for adding as you go.',
    {
      id: z.string(),
      issue: z.string().max(200).optional().describe('reword freely — repeat counting keys on `key`, not this'),
      key: z.string().max(120).optional().describe("ADD a 'source:subject' identity (e.g. backfilling an older entry). Keys accumulate — adding one never removes another — so this cannot erase an entry's history. Do not invent a key an alert never carried: an entry that cannot honestly match is better left uncounted than given a fabricated identity."),
      notes: z.string().max(20000).optional(),
      status: z.enum(['open', 'resolved', 'no-action']).optional(),
      report_ids: z.array(z.string()).optional(),
      links: z.array(z.string()).optional(),
    },
    async ({ id, issue, key, notes, status, report_ids, links }) => {
      const r = await api('PATCH', `/api/journal/${enc(id)}`, { issue, key, notes, status, reportIds: report_ids, links, author })
      return text(`updated ${id} (${r.revisions} revision(s) kept).`)
    },
  )

  mcp.tool(
    'journal_read',
    'Look up past work — this is what the journal is FOR. Read it before investigating anything that feels familiar: you may have already solved it in a context window you no longer have.',
    {
      q: z.string().optional().describe('text filter over issue and notes'),
      status: z.enum(['open', 'resolved', 'no-action']).optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ q: query, status, limit }) => {
      const r = await api('GET', `/api/journal${q({ q: query, status })}`)
      const entries = (r.entries ?? []).slice(0, limit ?? 40)
      let gapNote = ''
      try {
        const g = await api('GET', '/api/journal/gaps')
        if (g.unlogged?.length) {
          gapNote = `\n\n⚠ ${g.unlogged.length} report(s) have no journal entry — the log will not find them next time: ` +
            g.unlogged.slice(0, 8).map((u) => u.id).join(', ')
        }
      } catch { /* gaps are a nicety; never fail the read for them */ }
      if (!entries.length) return text(`(no matching journal entries)${gapNote}`)
      return text(entries.map((e) =>
        `${e.updatedAt} · [${e.status}] ${e.issue} (${e.id})` +
        `${e.reportIds?.length ? ` · reports: ${e.reportIds.join(', ')}` : ''}` +
        `${e.excludedFromCounts ? '\n    (record only — not counted as a prior occurrence)' : ''}` +
        `${e.notes ? `\n    ${String(e.notes).replace(/\n+/g, ' ').slice(0, 200)}` : ''}`,
      ).join('\n') + gapNote)
    },
  )

  mcp.tool('journal_get', 'Read one journal entry in full, including its revision history.',
    { id: z.string() },
    async ({ id }) => {
      const r = await api('GET', `/api/journal/${enc(id)}`)
      const e = r.entry
      return text(`${e.id} · [${e.status}] ${e.issue}\nauthor: ${e.author ?? '?'} · created ${e.createdAt} · updated ${e.updatedAt}` +
        `${e.reportIds?.length ? `\nreports: ${e.reportIds.join(', ')}` : ''}` +
        `${e.links?.length ? `\nlinks: ${e.links.join(', ')}` : ''}` +
        `\n\n${e.notes || '(no notes yet)'}` +
        `${e.revisions?.length ? `\n\n--- ${e.revisions.length} earlier revision(s) kept ---\n` + e.revisions.map((v) => `[${v.at}] ${String(v.previous).slice(0, 300)}`).join('\n') : ''}`)
    })
}

const TOOLSETS = {
  pages: {
    add: addPageTools,
    instructions: (a) =>
      `Scoping pages for AI-Lab — design docs, plans, rundowns, references. Writes are versioned ` +
      `append-only and your authorship (${a}) is recorded automatically. Markdown preferred; fenced ` +
      '```mermaid blocks render as diagrams and {{flowchart:ID}} / {{svg:ID}} embed stored diagrams ' +
      'live. This toolset is NOT for reports or journal entries — those have their own tools.',
  },
  reports: {
    add: addReportTools,
    instructions: (a) =>
      `File and search REPORTS as ${a}. Every report has a TYPE (maintenance, security, ` +
      `vulnerability, incident, research…) which decides its searchable collection — call ` +
      `report_types first. Reports are append-only: a report records what was true when it was ` +
      `written and is never silently rewritten. Search before investigating; a prior report is ` +
      `the fastest fix available.`,
  },
  journal: {
    add: addJournalTools,
    instructions: (a) =>
      `Your working log, ${a}. Start an entry when work STARTS, append as you go, and set its ` +
      `status when the outcome is clear — including 'no-action' for things you looked at and ` +
      `decided needed no repair, which are exactly the ones you will not otherwise remember. ` +
      `Read it before investigating anything familiar: its purpose is memory across context windows.`,
  },
}

function buildServer(author, toolset) {
  const spec = TOOLSETS[toolset]
  const mcp = new McpServer(
    { name: `ailab-${toolset}`, version: '2.0.0' },
    { capabilities: { tools: {} }, instructions: spec.instructions(author) },
  )
  spec.add(mcp, author)
  return mcp
}

/**
 * Route: /<toolset>/u/<caller>/mcp. Caller identity comes from the path, and an
 * unknown shape 404s LOUDLY rather than defaulting — the memory service's
 * lesson was that answering every path yields silently-wrong identities.
 */
function parse(url) {
  const m = /^\/(pages|reports|journal)\/u\/([A-Za-z0-9:_-]{1,80})\/mcp\/?$/.exec(url.split('?')[0])
  if (!m) return null
  return { toolset: m[1], caller: m[2].replace(/^agent:/, '') }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'ailab-authoring-mcp', toolsets: Object.keys(TOOLSETS) }))
    return
  }
  const route = parse(req.url ?? '')
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'expected /<pages|reports|journal>/u/<caller>/mcp' }))
    return
  }
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const mcp = buildServer(route.caller, route.toolset)
    res.on('close', () => { void transport.close(); void mcp.close() })
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
  process.stderr.write(`ailab-authoring MCP on :${PORT} — toolsets ${Object.keys(TOOLSETS).join(', ')} (backend ${BASE})\n`)
})
