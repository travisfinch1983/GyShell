#!/usr/bin/env node
/**
 * ailab-clipboard MCP — put text in front of Travis that he can COPY.
 *
 * Copying out of the AI-Lab terminal panes (ttyd/xterm iframes) is unreliable, and impossible on
 * a phone, so any URL, command, password or config snippet an agent printed had to be retyped.
 * `clipboard_post` sends the text to AI-Lab; a drawer slides down from the top of the page with a
 * Copy button on each entry. Talks to the AI-Lab backend REST (/api/clipboard).
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_API_TIMEOUT_MS (default 15000).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = (process.env.AILAB_API_URL ?? 'http://127.0.0.1:17890').replace(/\/+$/, '')
const TIMEOUT = Number(process.env.AILAB_API_TIMEOUT_MS ?? 15000)

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`)
  try { return JSON.parse(text) } catch { return text }
}

const server = new McpServer({ name: 'ailab-clipboard', version: '0.1.0' })
const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true })
const tool = (name, desc, shape, fn) =>
  server.tool(name, desc, shape, async (a) => { try { return ok(await fn(a || {})) } catch (e) { return fail(e) } })

tool('clipboard_post',
  'Put text in front of Travis so he can COPY it: a drawer slides down from the top of the AI-Lab ' +
  'page with a Copy button. Use this for ANYTHING he may need to paste somewhere else — URLs, ' +
  'commands, passwords/tokens, config snippets, IDs, file paths — instead of only printing it in ' +
  'your reply, because he often cannot copy text out of the AI-Lab terminal (and never on his ' +
  'phone). Post the EXACT text to copy (no surrounding prose or markdown fences); put the context ' +
  'in `title`. One value per call — post a URL and a password as two entries so each copies alone. ' +
  'Set sensitive=true for secrets: masked until revealed and never written to disk.',
  {
    text: z.string().min(1).max(64 * 1024).describe('The exact text to copy'),
    title: z.string().max(200).optional().describe('Short label shown above it, e.g. "Matrix password-change page"'),
    from: z.string().max(60).optional().describe('YOUR instance/agent name (claude1, wren, ...) — shown on the entry'),
    sensitive: z.boolean().optional().describe('Secret (password/token): masked in the UI, memory-only'),
  },
  async (a) => {
    const r = await api('POST', '/api/clipboard', a)
    return `Posted to the AI-Lab clipboard drawer (id ${r?.item?.id ?? '?'}). Travis sees it at the top of the AI-Lab page with a Copy button.`
  })

tool('clipboard_list',
  'List what is currently in the AI-Lab clipboard drawer (newest first). Sensitive entries are returned masked.',
  {},
  async () => {
    const r = await api('GET', '/api/clipboard')
    return (r?.items ?? []).map((i) => ({ ...i, text: i.sensitive ? '••••••••' : i.text }))
  })

tool('clipboard_clear',
  'STATE-CHANGING: Remove one entry (pass id) or, with no id, everything from the AI-Lab clipboard drawer.',
  { id: z.string().optional().describe('Entry id from clipboard_list; omit to clear all') },
  (a) => a.id ? api('DELETE', `/api/clipboard/${encodeURIComponent(a.id)}`) : api('DELETE', '/api/clipboard'))

await server.connect(new StdioServerTransport())
