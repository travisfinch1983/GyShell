#!/usr/bin/env node
/**
 * ailab-svg MCP — let a model draw, LOOK at what it drew, revise, and export.
 *
 * Drawings live in AI-Lab's shared SVG store (/api/svgs) and open in the AI-Lab "SVG" tab
 * (self-hosted svgedit), so an agent and a human edit the same artwork — the same
 * one-store-two-authors shape as ailab-flowchart.
 *
 * THE LOOK STEP IS THE POINT, and it is why svg_render returns a URL rather than an image.
 * MCP image results do NOT reach Hermes agents (see reference_hermes_mcp_images_never_reach_model);
 * an inline image would look correct in Claude Code and silently deliver nothing to the
 * agents this exists for. A URL can be handed to analyze_image, or fetched by any client
 * that can see pixels. Saying so in the tool description matters more than it seems: a model
 * that does not know how to look will simply skip looking.
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_API_TIMEOUT_MS (default 20000),
 *      AILAB_PUBLIC_URL (optional; the base a VISION MODEL should use to fetch renders —
 *      defaults to AILAB_API_URL, which is correct on-box but wrong for a remote consumer).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = (process.env.AILAB_API_URL ?? 'http://127.0.0.1:17890').replace(/\/+$/, '')
const PUBLIC = (process.env.AILAB_PUBLIC_URL ?? BASE).replace(/\/+$/, '')
const TIMEOUT = Number(process.env.AILAB_API_TIMEOUT_MS ?? 20000)
const enc = (s) => encodeURIComponent(String(s))

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

const server = new McpServer({ name: 'ailab-svg', version: '0.1.0' })
const ok = (d) => ({ content: [{ type: 'text', text: typeof d === 'string' ? d : JSON.stringify(d, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: `ERROR: ${e?.message ?? e}` }], isError: true })
const tool = (name, desc, shape, fn) =>
  server.tool(name, desc, shape, async (a) => { try { return ok(await fn(a || {})) } catch (e) { return fail(e) } })

tool('svg_list',
  'List every drawing in the AI-Lab SVG store (id, size, last modified). Start here to find something to edit.',
  {},
  async () => api('GET', '/api/svgs'))

tool('svg_get',
  'Fetch a drawing\'s raw SVG source. Use this before editing so you revise the ACTUAL current document rather than re-generating from memory.',
  { id: z.string().min(1).describe('Drawing id, as returned by svg_list') },
  async (a) => api('GET', `/api/svgs/${enc(a.id)}`))

tool('svg_write',
  'Create or overwrite a drawing with raw SVG. Send the complete document starting with <svg ...> and ending with </svg> — NOT wrapped in a markdown code fence, which is rejected. '
  + 'Overwrites silently if the id exists, so svg_get first if you mean to revise rather than replace. '
  + 'After writing, call svg_render and LOOK at the result: text overflowing its box, shapes off-canvas and bad contrast are invisible in source and obvious in the render.',
  {
    id: z.string().min(1).describe('Drawing id — letters, digits, dot, underscore, hyphen. Becomes the filename.'),
    svg: z.string().min(1).describe('Complete SVG document. Include width/height or viewBox, or it may rasterise at an unexpected size.'),
  },
  async (a) => api('PUT', `/api/svgs/${enc(a.id)}`, { svg: a.svg }))

tool('svg_render',
  'Rasterise a drawing to PNG and return a URL to LOOK AT IT. This is how you check your own work.\n\n'
  + 'IMPORTANT: this returns a URL, not an inline image, because MCP image results do not reach Hermes agents. '
  + 'To actually see it, pass the returned url to a vision tool (e.g. analyze_image) or open it in a client that renders images. '
  + 'The render is never cached, so calling it again after svg_write always shows the CURRENT drawing.',
  {
    id: z.string().min(1),
    width: z.number().int().min(16).max(4096).optional().describe('Output width in px (default 1024). Larger helps when checking small text.'),
  },
  async (a) => {
    // Rasterise now so a broken document fails HERE with a reason, rather than handing back a
    // URL that 422s later in some other tool where the cause is much harder to see.
    const w = a.width ?? 1024
    const res = await fetch(`${BASE}/api/svgs/${enc(a.id)}/render.png?width=${w}`, { signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`)
    const bytes = (await res.arrayBuffer()).byteLength
    return {
      image_url: `${PUBLIC}/api/svgs/${enc(a.id)}/render.png?width=${w}`,
      svg_download_url: `${PUBLIC}/api/svgs/${enc(a.id)}/file.svg`,
      width: w,
      png_bytes: bytes,
      how_to_view: 'Pass image_url to a vision tool (e.g. analyze_image) or fetch it directly — '
        + 'it is a plain PNG. An inline MCP image result does not reach every agent runtime, '
        + 'which is why this is a URL.',
      note: PUBLIC.includes('127.0.0.1') || PUBLIC.includes('localhost')
        ? 'WARNING: this URL is loopback-only and will NOT resolve for a remote agent. '
          + 'Set AILAB_PUBLIC_URL on the ailab-svg MCP server to a reachable base URL.'
        : undefined,
    }
  })

tool('svg_map',
  'Draw a WORLD MAP from structure — you supply the geography, the server handles layout, styling and coastlines. Use this instead of hand-writing SVG for maps: authoring raw SVG across a multi-turn conversation is fragile, and this keeps you in control of WHERE things are while never touching markup.\n\n'
  + 'Regions are placed on a 0-100 grid (x=0 west, y=0 north). Coastlines are generated deterministically from each region id, so re-sending the same structure redraws IDENTICALLY — a map does not writhe as you add to it.\n\n'
  + 'biome: islands|coast|forest|mountain|desert|plains|swamp|tundra|city|ruins|ocean (unknown -> neutral + a warning, never a failure).\n'
  + 'connection kind: border|road|river|sea-route (unknown -> plain line + a warning). A connection naming a region that does not exist IS an error — otherwise you would believe you drew a route that is not on the map.\n\n'
  + 'Every element gets a stable id (region-<id>, shape-<id>, label-<id>, conn-<from>__<to>, ocean, map-title), so you can afterwards tweak ONE coastline or colour with svg_edit instead of regenerating the whole map.',
  {
    id: z.string().min(1).describe('Drawing id to store the map as'),
    title: z.string().optional(),
    regions: z.array(z.object({
      id: z.string().min(1).describe('Stable region id, referenced by connections'),
      name: z.string().optional().describe('Label shown on the map (defaults to id)'),
      biome: z.string().optional(),
      x: z.number().optional().describe('0-100, west to east'),
      y: z.number().optional().describe('0-100, north to south'),
      size: z.number().optional().describe('Landmass radius 18-160 (default 58) — scale it to importance'),
      description: z.string().optional().describe('Becomes a <title> tooltip'),
    })).min(1),
    connections: z.array(z.object({
      from: z.string().min(1), to: z.string().min(1),
      kind: z.string().optional(),
    })).optional(),
  },
  async (a) => api('PUT', `/api/svgs/${enc(a.id)}/map`, {
    title: a.title, regions: a.regions, connections: a.connections ?? [],
  }))

tool('svg_edit',
  'Edit INDIVIDUAL ELEMENTS of a drawing instead of replacing the whole document. Use this for incremental work — adding a region while something else edits a label — because whole-document svg_write is last-write-wins and will silently discard another writer\'s changes.\n\n'
  + 'Elements are addressed by their SVG id attribute, so give things ids when you create them (id="region-north", id="city-1") or you will not be able to revise them later.\n\n'
  + 'Ops apply in order and are STRICT: if any one fails, NOTHING is written and the error names the op index and reason. A half-applied map is worse than a rejected batch, because you would believe it succeeded.\n'
  + '  {op:"append", svg, parent?}    add a new element (optionally inside a parent id)\n'
  + '  {op:"set",    id, svg}         replace that element, or append it if absent\n'
  + '  {op:"attrs",  id, set?, remove?}  change attributes only, keeping children\n'
  + '  {op:"remove", id}',
  {
    id: z.string().min(1).describe('Drawing id'),
    ops: z.array(z.object({
      op: z.enum(['append', 'set', 'attrs', 'remove']),
      id: z.string().optional().describe('Target element id — required for set/attrs/remove'),
      svg: z.string().optional().describe('Element markup — required for append/set'),
      parent: z.string().optional().describe('append only: element id to append inside (default: document root)'),
      set: z.record(z.union([z.string(), z.number()])).optional().describe('attrs only: attributes to set'),
      remove: z.array(z.string()).optional().describe('attrs only: attribute names to delete'),
    })).min(1),
  },
  async (a) => api('POST', `/api/svgs/${enc(a.id)}/elements`, { ops: a.ops }))

tool('svg_links',
  'Get shareable URLs for a drawing WITHOUT rasterising: a PNG render link and a raw .svg download link. '
  + 'Use this when you just need to hand someone a link; use svg_render when you want to check the drawing yourself.',
  { id: z.string().min(1), width: z.number().int().min(16).max(4096).optional() },
  async (a) => {
    await api('GET', `/api/svgs/${enc(a.id)}`)   // 404 here rather than handing back dead links
    const w = a.width ?? 1024
    return {
      image_url: `${PUBLIC}/api/svgs/${enc(a.id)}/render.png?width=${w}`,
      svg_download_url: `${PUBLIC}/api/svgs/${enc(a.id)}/file.svg`,
    }
  })

tool('svg_import',
  'Import an SVG from a URL into the store so you can edit it and view the changes — the upload path for an agent holding a link rather than the document text. '
  + 'If you already HAVE the SVG source, use svg_write instead. Overwrites the id if it exists.',
  {
    id: z.string().min(1).describe('Id to store it under'),
    url: z.string().min(1).describe('http(s) URL serving the SVG document'),
  },
  async (a) => api('POST', `/api/svgs/${enc(a.id)}/import`, { url: a.url }))

tool('svg_export',
  'Write a drawing to a filesystem path on the AI-Lab server. Absolute path: a directory (written as <id>.svg inside) or a full path ending in .svg. '
  + 'CONFINED to the server export root (default /claude/svg-exports) — a path outside it is refused, and the error names the permitted root. '
  + 'If you are a REMOTE agent you probably want svg_links instead, and to download the file yourself.',
  {
    id: z.string().min(1),
    path: z.string().min(1).describe('Absolute destination — a directory, or a full path ending in .svg'),
  },
  async (a) => api('POST', `/api/svgs/${enc(a.id)}/export`, { path: a.path }))

tool('svg_delete',
  'Delete a drawing from the store. Does not touch anything previously exported with svg_export.',
  { id: z.string().min(1) },
  async (a) => api('DELETE', `/api/svgs/${enc(a.id)}`))

await server.connect(new StdioServerTransport())
