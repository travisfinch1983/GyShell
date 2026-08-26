/**
 * roadmapStore — multi-project structured roadmaps.
 *
 * Backs the Roadmap tab's project sub-tabs and the roadmap_* MCP tools. Stored as one JSON file
 * (roadmaps.json) in the backend data dir. Each project holds a TREE of nodes; any node can nest
 * arbitrarily (section -> phase -> group -> item) and any node can be checkable (`done`). Stable
 * IDs make agent operations (set_done, add_node under a parent) reliable.
 *
 * First run migrates the legacy single-doc roadmap.md into an "AI-Lab" project so nothing is lost.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export type NodeKind = 'section' | 'phase' | 'group' | 'item'
export interface RoadmapNode {
  id: string
  title: string
  kind: NodeKind
  done?: boolean
  note?: string
  order: number
  children: RoadmapNode[]
}
export interface RoadmapProject {
  id: string
  name: string
  order: number
  updatedAt: string
  nodes: RoadmapNode[]
}
export interface RoadmapData { projects: RoadmapProject[] }

const FILE = 'roadmaps.json'
const filePath = (dataDir: string) => join(dataDir, FILE)

export function loadRoadmaps(dataDir: string): RoadmapData {
  try {
    const p = filePath(dataDir)
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'))
      if (d && Array.isArray(d.projects)) return d as RoadmapData
    }
  } catch { /* fall through to empty */ }
  return { projects: [] }
}

export function saveRoadmaps(dataDir: string, data: RoadmapData): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  writeFileSync(filePath(dataDir), JSON.stringify(data, null, 2), 'utf8')
}

let _c = 0
function genId(prefix: string): string {
  _c = (_c + 1) % 1000000
  return `${prefix}-${Date.now().toString(36)}${_c.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}
const nowIso = () => new Date().toISOString()
const nextOrder = (arr: { order?: number }[]) => (arr.length ? Math.max(...arr.map(n => n.order || 0)) + 1 : 0)

interface Ctx { node: RoadmapNode; arr: RoadmapNode[]; parent: RoadmapNode | null }
function findCtx(project: RoadmapProject, id: string): Ctx | null {
  let found: Ctx | null = null
  const rec = (arr: RoadmapNode[], parent: RoadmapNode | null) => {
    for (const n of arr) {
      if (n.id === id) { found = { node: n, arr, parent }; return }
      if (n.children && n.children.length) { rec(n.children, n); if (found) return }
    }
  }
  rec(project.nodes, null)
  return found
}
function isDescendant(node: RoadmapNode, maybeAncestorId: string): boolean {
  // true if maybeAncestorId is node itself or inside node's subtree
  if (node.id === maybeAncestorId) return true
  return (node.children || []).some(c => isDescendant(c, maybeAncestorId))
}

// ---- project ops ----
export const getProject = (data: RoadmapData, id: string) => data.projects.find(p => p.id === id)
export function createProject(data: RoadmapData, name: string): RoadmapProject {
  const proj: RoadmapProject = { id: genId('proj'), name: String(name || 'Untitled'), order: nextOrder(data.projects), updatedAt: nowIso(), nodes: [] }
  data.projects.push(proj)
  return proj
}
export function renameProject(data: RoadmapData, id: string, name: string): boolean {
  const p = getProject(data, id); if (!p) return false
  p.name = String(name); p.updatedAt = nowIso(); return true
}
export function deleteProject(data: RoadmapData, id: string): boolean {
  const i = data.projects.findIndex(p => p.id === id); if (i < 0) return false
  data.projects.splice(i, 1); return true
}

// ---- node ops ----
interface AddArgs { parentId?: string | null; title: string; kind?: NodeKind; done?: boolean; note?: string; position?: number }
export function addNode(data: RoadmapData, pid: string, a: AddArgs): RoadmapNode | null {
  const proj = getProject(data, pid); if (!proj) return null
  let arr = proj.nodes
  if (a.parentId) { const ctx = findCtx(proj, a.parentId); if (!ctx) return null; ctx.node.children = ctx.node.children || []; arr = ctx.node.children }
  const node: RoadmapNode = { id: genId('node'), title: String(a.title || ''), kind: (a.kind || 'item'), order: 0, children: [] }
  if (a.done !== undefined) node.done = !!a.done
  if (a.note !== undefined && a.note !== null) node.note = String(a.note)
  if (typeof a.position === 'number' && a.position >= 0 && a.position <= arr.length) arr.splice(a.position, 0, node)
  else arr.push(node)
  arr.forEach((n, i) => { n.order = i })
  proj.updatedAt = nowIso()
  return node
}
interface EditArgs { title?: string; kind?: NodeKind; done?: boolean | null; note?: string | null }
export function editNode(data: RoadmapData, pid: string, nid: string, patch: EditArgs): RoadmapNode | null {
  const proj = getProject(data, pid); if (!proj) return null
  const ctx = findCtx(proj, nid); if (!ctx) return null
  const n = ctx.node
  if (patch.title !== undefined) n.title = String(patch.title)
  if (patch.kind !== undefined) n.kind = patch.kind
  if (patch.done !== undefined) { if (patch.done === null) delete n.done; else n.done = !!patch.done }
  if (patch.note !== undefined) { if (patch.note === null || patch.note === '') delete n.note; else n.note = String(patch.note) }
  proj.updatedAt = nowIso()
  return n
}
export const setDone = (data: RoadmapData, pid: string, nid: string, done: boolean) => editNode(data, pid, nid, { done })
export function removeNode(data: RoadmapData, pid: string, nid: string): boolean {
  const proj = getProject(data, pid); if (!proj) return false
  const ctx = findCtx(proj, nid); if (!ctx) return false
  const i = ctx.arr.indexOf(ctx.node); if (i < 0) return false
  ctx.arr.splice(i, 1); ctx.arr.forEach((n, k) => { n.order = k })
  proj.updatedAt = nowIso(); return true
}
export function moveNode(data: RoadmapData, pid: string, nid: string, newParentId: string | null, position?: number): boolean {
  const proj = getProject(data, pid); if (!proj) return false
  const ctx = findCtx(proj, nid); if (!ctx) return false
  if (newParentId) {
    if (newParentId === nid) return false
    const pc = findCtx(proj, newParentId); if (!pc) return false
    if (isDescendant(ctx.node, newParentId)) return false // cannot move into own subtree
  }
  const i = ctx.arr.indexOf(ctx.node); ctx.arr.splice(i, 1)
  let dest = proj.nodes
  if (newParentId) { const pc = findCtx(proj, newParentId)!; pc.node.children = pc.node.children || []; dest = pc.node.children }
  if (typeof position === 'number' && position >= 0 && position <= dest.length) dest.splice(position, 0, ctx.node)
  else dest.push(ctx.node)
  dest.forEach((n, k) => { n.order = k })
  proj.updatedAt = nowIso(); return true
}

// ---- markdown migration (legacy roadmap.md -> one structured project) ----
export function markdownToProject(md: string, name: string): RoadmapProject {
  const proj: RoadmapProject = { id: genId('proj'), name, order: 0, updatedAt: nowIso(), nodes: [] }
  const stack: { level: number; node: RoadmapNode }[] = []
  const curArr = () => (stack.length ? stack[stack.length - 1].node.children : proj.nodes)
  let lastItem: RoadmapNode | null = null
  for (const raw of String(md || '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      const kind: NodeKind = level <= 1 ? 'section' : level === 2 ? 'phase' : 'group'
      const node: RoadmapNode = { id: genId('node'), title: h[2].trim(), kind, order: nextOrder(curArr()), children: [] }
      curArr().push(node); stack.push({ level, node }); lastItem = null
      continue
    }
    const t = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/)
    if (t) {
      const indent = t[1].replace(/\t/g, '  ').length
      const node: RoadmapNode = { id: genId('node'), title: t[3].trim(), kind: 'item', done: t[2].toLowerCase() === 'x', order: 0, children: [] }
      let arr = curArr()
      if (indent >= 2 && lastItem) { lastItem.children = lastItem.children || []; arr = lastItem.children }
      node.order = nextOrder(arr); arr.push(node)
      if (indent < 2) lastItem = node
      continue
    }
    const b = line.match(/^(\s*)[-*]\s+(.*)$/)
    if (b) {
      const node: RoadmapNode = { id: genId('node'), title: b[2].trim(), kind: 'item', order: nextOrder(curArr()), children: [] }
      curArr().push(node); lastItem = node
      continue
    }
    if (line.trim() && stack.length) {
      const n = stack[stack.length - 1].node
      n.note = n.note ? n.note + '\n' + line.trim() : line.trim()
    }
  }
  return proj
}

/** Ensure roadmaps.json exists; on first run seed it from the legacy roadmap.md as project "AI-Lab". */
export function ensureSeeded(dataDir: string, roadmapMdFile?: string): RoadmapData {
  const p = filePath(dataDir)
  if (existsSync(p)) return loadRoadmaps(dataDir)
  const data: RoadmapData = { projects: [] }
  try {
    if (roadmapMdFile && existsSync(roadmapMdFile)) {
      const md = readFileSync(roadmapMdFile, 'utf8')
      if (md.trim()) data.projects.push(markdownToProject(md, 'AI-Lab'))
    }
  } catch { /* ignore, start empty */ }
  saveRoadmaps(dataDir, data)
  return data
}
