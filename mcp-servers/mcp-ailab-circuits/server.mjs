#!/usr/bin/env node
/**
 * ailab-circuits MCP — design ESP32 circuits WITH Travis in AI-Lab's Circuit Designer
 * (Diagrams tab → Circuit Designer). Same designs he sees and edits; his open editor picks up
 * your changes within ~2 s.
 *
 * Talks to the AI-Lab backend REST (/api/circuits). Edits are atomic batches of operations
 * (circuit_edit), so you never read-modify-write a whole design and never clobber his work.
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_API_TIMEOUT_MS (default 20000),
 *      CIRCUITS_ACTOR (name stamped as "last saved by"; default "agent").
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = (process.env.AILAB_API_URL ?? 'http://127.0.0.1:17890').replace(/\/+$/, '')
const TIMEOUT = Number(process.env.AILAB_API_TIMEOUT_MS ?? 20000)
const ACTOR = process.env.CIRCUITS_ACTOR ?? 'agent'
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
  try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw new Error(`${res.status}: ${typeof data === 'object' && data?.error ? data.error : String(text).slice(0, 400)}`)
  return data
}

const server = new McpServer({ name: 'ailab-circuits', version: '0.1.0' })
const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true })
const tool = (name, desc, shape, fn) =>
  server.tool(name, desc, shape, async (a) => { try { return ok(await fn(a || {})) } catch (e) { return fail(e) } })

/** Compact, readable view of a design: parts, then wires as REF.PIN → REF.PIN. */
function describe(d, parts) {
  const byId = new Map(parts.map((p) => [p.id, p]))
  return {
    id: d.id, name: d.name, description: d.description, notes: d.notes, updatedAt: d.updatedAt, lastSavedBy: d.updatedBy,
    parts: d.parts.map((p) => ({ ref: p.ref, partId: p.partId, part: byId.get(p.partId)?.name ?? '(missing from library)', label: p.label, props: p.props, breadboard: p.bb, schematic: p.sch })),
    wires: d.wires.map((w) => ({ id: w.id, from: `${w.from.ref}.${w.from.pin}`, to: `${w.to.ref}.${w.to.pin}`, color: w.color, label: w.label })),
  }
}

// ── designs ──────────────────────────────────────────────────────────────────────────────────
tool('circuit_list',
  'List circuits in AI-Lab\'s Circuit Designer (Diagrams tab → Circuit Designer): id, name, part/wire counts, last update. Start here to find a design id.',
  {},
  async () => (await api('GET', '/api/circuits/designs')).designs)

tool('circuit_get',
  'Read one circuit: its parts (ref, partId, label, props, positions) and wires as "REF.PIN → REF.PIN". ' +
  'Set include_netlist to also get the electrical nets, the MCU pin assignments and the parts list.',
  {
    id: z.string().describe('Design id from circuit_list'),
    include_netlist: z.boolean().optional().describe('Also return nets, pinAssignments and bom'),
  },
  async ({ id, include_netlist }) => {
    const [{ design }, { parts }] = await Promise.all([api('GET', `/api/circuits/designs/${enc(id)}`), api('GET', '/api/circuits/parts?summary=1')])
    const out = describe(design, parts)
    if (include_netlist) Object.assign(out, await api('GET', `/api/circuits/designs/${enc(id)}/netlist`))
    return out
  })

tool('circuit_create',
  'Create a new, empty circuit (optionally with a description). Returns its id. Then add parts and wires with circuit_edit.',
  { name: z.string().min(1).max(200), description: z.string().max(4000).optional() },
  async ({ name, description }) => {
    const r = await api('POST', '/api/circuits/designs', { name, description })
    return { id: r.design.id, name: r.design.name, next: 'Use circuit_edit with add_part / connect ops.' }
  })

const opSchema = z.object({
  op: z.enum(['add_part', 'move_part', 'remove_part', 'set_part', 'connect', 'disconnect', 'set_wire', 'set_meta', 'clear']),
  partId: z.string().optional().describe('add_part: library part id (from parts_search)'),
  ref: z.string().optional().describe('add_part: desired ref (auto U1/R1/... if omitted); move_part/remove_part/set_part: which part'),
  newRef: z.string().optional().describe('set_part: rename the reference'),
  label: z.string().optional().describe('add_part/set_part: human label, e.g. "Bedroom sensor"; connect/set_wire: net name'),
  props: z.record(z.string(), z.union([z.string(), z.null()])).optional().describe('add_part/set_part: e.g. {"value":"4.7k"} or {"i2cAddress":"0x77"}; null deletes a key'),
  x: z.number().optional(), y: z.number().optional(), rot: z.number().optional().describe('degrees: 0/90/180/270'),
  view: z.enum(['bb', 'sch']).optional().describe('which view x/y/rot apply to (default bb = breadboard)'),
  from: z.string().optional().describe('connect/disconnect: "REF.PIN", e.g. "U1.GPIO21" (pin id, printed name, "21" or an alt function like "I2C_SDA (default)")'),
  to: z.string().optional().describe('connect/disconnect: "REF.PIN"'),
  color: z.string().optional().describe('connect/set_wire: CSS colour (default: red for supply, black for ground)'),
  wireId: z.string().optional().describe('disconnect/set_wire: wire id from circuit_get'),
  name: z.string().optional(), description: z.string().optional(), notes: z.string().optional().describe('set_meta fields'),
}).passthrough()

tool('circuit_edit',
  'Change a circuit with an ATOMIC batch of operations (all apply or none do). Travis sees the result in his open editor within ~2 s.\n' +
  'Ops:\n' +
  '  {op:"add_part", partId, ref?, label?, props?, x?, y?, rot?}  — omit x/y to auto-place to the right of existing parts\n' +
  '  {op:"connect", from:"U1.GPIO21", to:"U2.SDA", color?, label?}\n' +
  '  {op:"disconnect", wireId} | {op:"disconnect", from, to?}  (from alone removes every wire on that pin)\n' +
  '  {op:"move_part", ref, x?, y?, rot?, view?} · {op:"remove_part", ref} (also removes its wires)\n' +
  '  {op:"set_part", ref, label?, props?, newRef?} · {op:"set_wire", wireId, color?, label?}\n' +
  '  {op:"set_meta", name?, description?, notes?} · {op:"clear"}\n' +
  'Coordinates are in units of 0.01" (10 = one 0.1" breadboard pitch). Pin refs accept the pin id, the printed name, a bare GPIO number ("4") or an alt function. ' +
  'Wrong pins fail with the list of valid pins. Run circuit_check afterwards.',
  {
    id: z.string().describe('Design id'),
    ops: z.array(opSchema).min(1).max(500),
  },
  async ({ id, ops }) => api('POST', `/api/circuits/designs/${enc(id)}/ops`, { ops, actor: ACTOR }))

tool('circuit_check',
  'Run the design checks on a circuit: shorts, 5 V on 3.3 V GPIOs, flash pins, strapping pins, input-only pins driving inputs, ' +
  'I2C address clashes, modules with no power/ground. Returns findings (error / warning / info) with the refs involved.',
  { id: z.string() },
  async ({ id }) => (await api('GET', `/api/circuits/designs/${enc(id)}/check`)).findings)

tool('circuit_export',
  'Export a circuit as text: "netlist", "bom" (parts list), "esphome" (substitutions block of GPIO assignments) or "arduino" (#define pin map).',
  { id: z.string(), format: z.enum(['netlist', 'bom', 'esphome', 'arduino']) },
  async ({ id, format }) => (await api('GET', `/api/circuits/designs/${enc(id)}/export?format=${enc(format)}`)).text)

tool('circuit_delete',
  'Delete a circuit (it moves to the server trash folder, recoverable). Only when Travis asked for it.',
  { id: z.string() },
  async ({ id }) => api('DELETE', `/api/circuits/designs/${enc(id)}`))

// ── parts library ────────────────────────────────────────────────────────────────────────────
tool('parts_search',
  'Search the Circuit Designer parts library (built-in boards, sensors, passives, plus Travis\'s custom parts). ' +
  'Matches name, tags, category, and pin names/functions (e.g. "i2c temperature", "relay", "esp32-s3"). Empty query lists everything.',
  { query: z.string().optional(), category: z.string().optional() },
  async ({ query, category }) => {
    const qs = new URLSearchParams({ summary: '1' })
    if (query) qs.set('q', query)
    if (category) qs.set('category', category)
    return (await api('GET', `/api/circuits/parts?${qs}`)).parts
  })

tool('part_get',
  'Full definition of one library part: every pin with id, printed name, type (gpio/power/ground/input/output/analog/passive), ' +
  'voltage, alternate functions, warning flags (strapping, input-only, adc2, flash, psram-octal, usb) and notes. Art is omitted.',
  { id: z.string() },
  async ({ id }) => {
    const { part } = await api('GET', `/api/circuits/parts/${enc(id)}`)
    const { svg, image, ...rest } = part
    return { ...rest, art: svg ? 'svg' : image ? 'image' : 'none' }
  })

tool('part_create',
  'Add a CUSTOM part to the library (e.g. from a datasheet pinout). Positions are in units of 0.01" on the part\'s breadboard art ' +
  '(10 = 0.1" pitch, so a 2.54 mm header is 10 apart). Without svg/image a plain labelled box is drawn. ' +
  'Pin ids should be "GPIO<n>" for MCU GPIOs so checks and exports understand them. Use replace=true to overwrite an existing custom part.',
  {
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe('default: custom-<name>'),
    name: z.string().min(1).max(120),
    category: z.string().max(60).optional(),
    refPrefix: z.string().regex(/^[A-Z]{1,3}$/).optional().describe('U, R, C, D, SW, J, K, Q'),
    description: z.string().max(4000).optional(),
    tags: z.array(z.string()).optional(),
    width: z.number().min(5).max(3000), height: z.number().min(5).max(3000),
    pins: z.array(z.object({
      id: z.string(), name: z.string().optional(), x: z.number(), y: z.number(),
      side: z.enum(['L', 'R', 'T', 'B']).optional(),
      type: z.enum(['power', 'ground', 'gpio', 'input', 'output', 'analog', 'passive', 'nc', 'other']).optional(),
      voltage: z.number().optional(), functions: z.array(z.string()).optional(), flags: z.array(z.string()).optional(), notes: z.string().optional(),
    })).min(1),
    svg: z.string().optional().describe('Breadboard art as an <svg> document sized width × height'),
    props: z.record(z.string(), z.any()).optional().describe('e.g. {"i2cAddress":["0x44","0x45"],"supplyMin":3.3,"supplyMax":5}'),
    color: z.string().optional().describe('box colour when no svg is given'),
    replace: z.boolean().optional(),
  },
  async (a) => {
    const body = { ...a }
    if (!body.svg) {
      const label = String(a.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 24)
      const w = a.width, h = a.height
      body.svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="3" fill="${a.color ?? '#334155'}" stroke="#0b0b0b" stroke-width="0.8"/>` +
        a.pins.map((p) => `<rect x="${p.x - 3}" y="${p.y - 3}" width="6" height="6" rx="1" fill="#d4a017"/><circle cx="${p.x}" cy="${p.y}" r="1.4" fill="#222"/>`).join('') +
        `<text x="${w / 2}" y="${h / 2 + 2}" font-size="5" font-weight="bold" font-family="sans-serif" fill="#ffffffcc" text-anchor="middle">${label}</text></svg>`
    }
    delete body.replace; delete body.color
    const r = a.replace && a.id
      ? await api('PUT', `/api/circuits/parts/${enc(a.id)}`, body)
      : await api('POST', '/api/circuits/parts', body)
    return { id: r.part.id, name: r.part.name, pins: r.part.pins.length }
  })

await server.connect(new StdioServerTransport())
