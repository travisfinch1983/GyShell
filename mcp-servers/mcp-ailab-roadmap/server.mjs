#!/usr/bin/env node
/**
 * ailab-roadmap MCP — full CRUD over AI-Lab's multi-project roadmaps for agents / Claude Code.
 *
 * Each project is a TREE of nodes; any node can nest arbitrarily (section -> phase -> group -> item)
 * and any node can be checkable (`done`). Stable ids make every operation reliable. Backs the Roadmap
 * tab's project sub-tabs. Talks to the AI-Lab backend REST (/api/roadmap/*).
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_API_TIMEOUT_MS (default 15000).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = (process.env.AILAB_API_URL ?? 'http://127.0.0.1:17890').replace(/\/+$/, '')
const TIMEOUT = Number(process.env.AILAB_API_TIMEOUT_MS ?? 15000)
const enc = (s) => encodeURIComponent(String(s))
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

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

const server = new McpServer({ name: 'ailab-roadmap', version: '0.1.0' })
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true })
const tool = (name, desc, shape, fn) =>
  server.tool(name, desc, shape, async (a) => { try { return ok(await fn(a || {})) } catch (e) { return fail(e) } })

const KIND = z.enum(['section', 'phase', 'group', 'item'])

tool('roadmap_list_projects',
  'List all roadmap projects (each shows id, name, order, nodeCount, updatedAt). Every project is a separate ' +
  'sub-tab in the Roadmap UI. Start here to get a project id, then roadmap_get to read its tree.',
  {}, () => api('GET', '/api/roadmap/projects'))

tool('roadmap_get',
  'Get the full node tree for ONE project. Each node has: id, title, kind (section|phase|group|item), ' +
  'optional done (checkbox), optional note, and children[]. Use the node ids with edit/set_done/remove/move.',
  { project_id: z.string().min(1).describe('Project id from roadmap_list_projects') },
  (a) => api('GET', `/api/roadmap/projects/${enc(a.project_id)}`))

tool('roadmap_create_project',
  'STATE-CHANGING: Create a new roadmap project (adds a sub-tab). Returns the new project id.',
  { name: z.string().min(1).describe('Project name — shown as the sub-tab label') },
  (a) => api('POST', '/api/roadmap/projects', { name: a.name }))

tool('roadmap_rename_project',
  'STATE-CHANGING: Rename a roadmap project.',
  { project_id: z.string().min(1), name: z.string().min(1) },
  (a) => api('PATCH', `/api/roadmap/projects/${enc(a.project_id)}`, { name: a.name }))

tool('roadmap_set_meta',
  'STATE-CHANGING: Set a project\'s Overview metadata — the one-line description, its lifecycle ' +
  'status, and the id of its scoping document in Reporting. These drive the Roadmap tab\'s ' +
  'Overview (table of contents): the description is what someone reads to know what the project ' +
  'IS without opening it, and status is what the Kanban view groups by. Every field is optional ' +
  'and only the ones you PASS are changed, so setting a description cannot blank the status. ' +
  'Pass an empty string to clear a field. Statuses: idea | active | paused | blocked | done — ' +
  'use paused/blocked for work that has stalled rather than leaving it active, because the ' +
  'Overview flags untouched projects that still have open work and a wrong status hides them.',
  {
    project_id: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(['idea', 'active', 'paused', 'blocked', 'done', '']).optional(),
    report_id: z.string().optional(),
  },
  (a) => {
    const body = {}
    if (a.description !== undefined) body.description = a.description
    if (a.status !== undefined) body.status = a.status === '' ? null : a.status
    if (a.report_id !== undefined) body.reportId = a.report_id
    return api('PATCH', `/api/roadmap/projects/${enc(a.project_id)}`, body)
  })

tool('roadmap_delete_project',
  'STATE-CHANGING: Delete a roadmap project and every node in it. Irreversible.',
  { project_id: z.string().min(1) },
  (a) => api('DELETE', `/api/roadmap/projects/${enc(a.project_id)}`))

tool('roadmap_add_node',
  'STATE-CHANGING: Add a node to a project. kind organizes structure: section (top area like "Backend"/"UI"), ' +
  'phase (a phase within a section), group (a sub-grouping), item (a task). ANY node can also be checkable via ' +
  'done. Omit parent_id for a top-level node, or pass a parent node id to nest under it (build sections -> ' +
  'phases -> items this way). Returns the new node id.',
  {
    project_id: z.string().min(1),
    title: z.string().min(1).describe('The node text/title'),
    parent_id: z.string().optional().describe('Parent node id to nest under; omit for top level'),
    kind: KIND.optional().describe('section | phase | group | item (default item)'),
    done: z.boolean().optional().describe('Initial checked state'),
    note: z.string().optional().describe('Optional longer note/description shown under the node'),
    position: z.number().int().optional().describe('Insert index among siblings; omit to append'),
  },
  (a) => api('POST', `/api/roadmap/projects/${enc(a.project_id)}/nodes`,
    clean({ parentId: a.parent_id, title: a.title, kind: a.kind, done: a.done, note: a.note, position: a.position })))

tool('roadmap_edit_node',
  'STATE-CHANGING: Edit a node. Only the fields you pass change. done=true/false checks/unchecks; ' +
  'note="" clears the note; kind changes the node type.',
  {
    project_id: z.string().min(1), node_id: z.string().min(1),
    title: z.string().optional(), kind: KIND.optional(),
    done: z.boolean().optional(), note: z.string().optional(),
  },
  (a) => api('PATCH', `/api/roadmap/projects/${enc(a.project_id)}/nodes/${enc(a.node_id)}`,
    clean({ title: a.title, kind: a.kind, done: a.done, note: a.note })))

tool('roadmap_set_done',
  'STATE-CHANGING: Check or uncheck a node — mark it complete/incomplete (or revisited). ' +
  'Convenience wrapper for toggling progress.',
  { project_id: z.string().min(1), node_id: z.string().min(1), done: z.boolean().describe('true = complete, false = incomplete') },
  (a) => api('PATCH', `/api/roadmap/projects/${enc(a.project_id)}/nodes/${enc(a.node_id)}`, { done: a.done }))

tool('roadmap_remove_node',
  'STATE-CHANGING: Remove a node and all of its children from a project.',
  { project_id: z.string().min(1), node_id: z.string().min(1) },
  (a) => api('DELETE', `/api/roadmap/projects/${enc(a.project_id)}/nodes/${enc(a.node_id)}`))

tool('roadmap_move_node',
  'STATE-CHANGING: Re-parent a node (or move it to the top level by omitting parent_id) and optionally set its ' +
  'position among siblings. Cannot move a node into its own subtree.',
  {
    project_id: z.string().min(1), node_id: z.string().min(1),
    parent_id: z.string().optional().describe('New parent node id; omit for top level'),
    position: z.number().int().optional().describe('Index among the new siblings; omit to append'),
  },
  (a) => api('POST', `/api/roadmap/projects/${enc(a.project_id)}/nodes/${enc(a.node_id)}/move`,
    clean({ parentId: a.parent_id ?? null, position: a.position })))

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[ailab-roadmap-mcp] ready on stdio — 10 tools')
