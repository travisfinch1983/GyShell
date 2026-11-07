#!/usr/bin/env node
/**
 * ailab-image-inbox MCP — put an image in front of Travis that he can VIEW.
 *
 * Agents generate images all over the estate and Travis had to go find them in folders.
 * `image_inbox_post` sends one to AI-Lab; the TopBar "Images" button shows a count pip
 * (deliberately no popup — he opens the viewer himself). Talks to the AI-Lab backend REST
 * (/api/image-inbox), which COPIES the file, so the source may move or be deleted afterwards.
 *
 * Path posts are restricted server-side to the allowed roots (/imagegen); anything else
 * needs the base64 upload form.
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_API_TIMEOUT_MS (default 30000).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = (process.env.AILAB_API_URL ?? 'http://127.0.0.1:17890').replace(/\/+$/, '')
const TIMEOUT = Number(process.env.AILAB_API_TIMEOUT_MS ?? 30000)

async function api(method, apiPath, body) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`)
  try { return JSON.parse(text) } catch { return text }
}

const server = new McpServer({ name: 'ailab-image-inbox', version: '0.1.0' })
const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true })
const tool = (name, desc, shape, fn) =>
  server.tool(name, desc, shape, async (a) => { try { return ok(await fn(a || {})) } catch (e) { return fail(e) } })

tool('image_inbox_post',
  'Send Travis an image to VIEW: it lands in the AI-Lab TopBar "Images" viewer with a ' +
  'notification count (no popup — he opens it when he wants). Use it whenever you generated or ' +
  'found an image he should see, instead of printing a file path he has to go dig up. Pass a ' +
  'server file path under /imagegen (the usual case — the backend copies it), or upload raw ' +
  'bytes with data_base64 + filename for anything living elsewhere. Allowed types: png, jpg, ' +
  'webp, gif, avif, bmp.',
  {
    path: z.string().max(1024).optional().describe('Absolute file path on CT152 under an allowed root (/imagegen/...)'),
    data_base64: z.string().max(32 * 1024 * 1024).optional().describe('Raw image bytes, base64 — for files outside the allowed roots'),
    filename: z.string().max(255).optional().describe('Required with data_base64: a name carrying the image extension, e.g. render.png'),
    title: z.string().max(200).optional().describe('Short label shown on the entry'),
    caption: z.string().max(2000).optional().describe('Longer text shown under the image'),
    from: z.string().max(60).optional().describe('YOUR instance/agent name (claude1, wren, ...) — shown on the entry'),
  },
  async (a) => {
    const r = await api('POST', '/api/image-inbox', {
      path: a.path, dataBase64: a.data_base64, filename: a.filename,
      title: a.title, caption: a.caption, from: a.from,
    })
    return `Posted to the AI-Lab image inbox (id ${r?.item?.id ?? '?'}). Travis sees a count on the TopBar Images button and opens the viewer himself.`
  })

tool('image_inbox_list',
  'List what is in the AI-Lab image inbox (newest first): id, title, caption, sender, time, seen flag. Bytes are not returned.',
  {},
  async () => {
    const r = await api('GET', '/api/image-inbox')
    return { unseen: r?.unseen ?? 0, items: r?.items ?? [] }
  })

tool('image_inbox_clear',
  'STATE-CHANGING: Remove one image (pass id) or, with no id, everything from the AI-Lab image inbox. Deletes the stored copies.',
  { id: z.string().optional().describe('Entry id from image_inbox_list; omit to clear all') },
  (a) => a.id ? api('DELETE', `/api/image-inbox/${encodeURIComponent(a.id)}`) : api('DELETE', '/api/image-inbox'))

await server.connect(new StdioServerTransport())
