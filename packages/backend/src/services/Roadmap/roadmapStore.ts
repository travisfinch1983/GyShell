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
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { TransitionLatch } from '../notifyLocal'
import { join } from 'path'

const roadmapLatch = new TransitionLatch(1, 'roadmap-store')

export type NodeKind = 'section' | 'phase' | 'group' | 'item'
/**
 * Where an unfinished item sits on the board. DELIBERATELY does not include a 'done' value:
 * `done` is the single source of truth for finished-ness, and this only describes the
 * NOT-done space. Two independent fields both claiming to say whether something is finished
 * is how a card reads "Done" while its checkbox is unticked — the same disagreeing-surfaces
 * problem this codebase has been paying for elsewhere.
 *
 * Column derivation, in one place (boardColumn below):
 *   done === true          -> Done      (whatever status says)
 *   done === false/absent  -> status, defaulting to 'todo'
 *   done absent entirely   -> Untracked (never triaged — the 96 items the Overview found)
 */
export type NodeStatus = 'todo' | 'doing' | 'blocked'
export const NODE_STATUSES: NodeStatus[] = ['todo', 'doing', 'blocked']

export type BoardColumn = 'untracked' | 'todo' | 'doing' | 'blocked' | 'done'
export const BOARD_COLUMNS: BoardColumn[] = ['untracked', 'todo', 'doing', 'blocked', 'done']

/** The ONLY place a column is decided, so the board and the tree can never disagree. */
export function boardColumn(n: RoadmapNode): BoardColumn {
  if (n.done === true) return 'done'
  if (typeof n.done !== 'boolean') return 'untracked'
  return n.status && NODE_STATUSES.includes(n.status) ? n.status : 'todo'
}

/** Inverse of boardColumn: the field changes a drop into `col` must make. Returning BOTH
 *  fields every time is what keeps them consistent — a move that set only one would leave the
 *  other stale, which is exactly how the two would drift apart. */
export function patchForColumn(col: BoardColumn): { done: boolean | null; status: NodeStatus | null } {
  if (col === 'done') return { done: true, status: null }
  if (col === 'untracked') return { done: null, status: null }
  return { done: false, status: col }
}

export interface RoadmapNode {
  id: string
  title: string
  kind: NodeKind
  done?: boolean
  /** Set ONLY when a non-owner created this node. The owner's own additions stay unmarked —
   *  badging everything would make the signal worthless. */
  addedBy?: string
  /** Set ONLY when a non-owner last changed this node (status, title, note, done). */
  updatedBy?: string
  /** When updatedBy last touched it — an attribution with no date ages into a mystery. */
  updatedByAt?: string
  /** Board lane while NOT done. Meaningless when done === true; cleared on completion. */
  status?: NodeStatus
  note?: string
  order: number
  children: RoadmapNode[]
}
/** A project's lifecycle state. Drives the Overview table of contents and is the seed the
 *  Kanban view will group by — which is why it lives on the PROJECT rather than being derived
 *  from checkbox counts: "every item done" and "we decided to stop" are different facts, and a
 *  project nobody has started looks identical to a finished one if you only count checkboxes. */
export type ProjectStatus = 'idea' | 'active' | 'paused' | 'blocked' | 'done'
export const PROJECT_STATUSES: ProjectStatus[] = ['idea', 'active', 'paused', 'blocked', 'done']

export interface RoadmapProject {
  id: string
  name: string
  order: number
  updatedAt: string
  nodes: RoadmapNode[]
  /** One line for the table of contents. Optional — older projects predate it. */
  description?: string
  status?: ProjectStatus
  /** Id of the scoping document in Reporting, if one has been written. */
  reportId?: string
  /**
   * Which Claude instance or agent owns this roadmap (e.g. 'claude1', 'claude2', 'claude-dhb').
   *
   * Ownership is BOOKKEEPING, not permission: anyone may edit any roadmap. What ownership
   * buys is attribution — a change made by someone other than the owner is stamped with who
   * made it, so the owner can see what happened to their project without having to diff it.
   * Deliberately not an access check; a lock would just get worked around and would stop the
   * cross-project help that actually happens.
   */
  owner?: string
}

/**
 * Leaf progress for the table of contents. Reports THREE numbers, because two of them lie.
 *
 * An `item` with no `done` flag is a real task that was written down and never given a
 * checkbox. Counting only checkboxes made every project read as finished while carrying that
 * work invisibly: measured 2026-09-01, SiteMap showed 49/49 with 25 such items, Marinara 30/30
 * with 41, Network Overhaul 9/9 with 19 — 96 tasks across the board, including things like
 * "Call the ISP: can you get a /29 static block". A progress bar that reaches 100% while work
 * remains is the failure this whole Overview exists to end, so `untracked` is a first-class
 * number rather than being folded into either side.
 *
 * `group`/`section`/`phase` are containers and are never counted — they would inflate both.
 */
export function progressOf(nodes: RoadmapNode[]): { done: number; open: number; untracked: number; total: number } {
  let done = 0, open = 0, untracked = 0
  const walk = (arr: RoadmapNode[]): void => {
    for (const n of arr) {
      if (typeof n.done === 'boolean') { if (n.done) done++; else open++ }
      else if (n.kind === 'item') untracked++
      if (n.children?.length) walk(n.children)
    }
  }
  walk(nodes)
  return { done, open, untracked, total: done + open + untracked }
}
export interface RoadmapData { projects: RoadmapProject[] }

const FILE = 'roadmaps.json'
const filePath = (dataDir: string) => join(dataDir, FILE)

/**
 * 🛑 Corrupt-read-then-overwrite was TOTAL SILENT DATA LOSS here: a parse
 * failure fell through to {projects:[]}, and the very next roadmap_* mutation
 * saved that empty object over roadmaps.json — every project gone, reported
 * to the caller as ok:true. The non-atomic write below could CREATE the
 * corrupt file (crash mid-write) that triggered it. This store now holds the
 * Observability Sweep's own tracking, so the stakes are not hypothetical.
 *
 * The contract now: a corrupt file is copied aside and POISONS the store —
 * every save refuses loudly until the file is repaired or removed. Absent
 * stays a normal first boot. Writes are atomic (tmp+rename), so a crash can
 * no longer manufacture the corrupt state.
 */
const poisoned = new Map<string, string>()   // dataDir → reason

export function loadRoadmaps(dataDir: string): RoadmapData {
  const p = filePath(dataDir)
  if (!existsSync(p)) return { projects: [] }
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'))
    if (d && Array.isArray(d.projects)) {
      poisoned.delete(dataDir)   // repaired file re-arms saving
      return d as RoadmapData
    }
    throw new Error('parsed but has no projects array')
  } catch (e) {
    let saved = ''
    try { copyFileSync(p, `${p}.corrupt-${Date.now()}`); saved = 'copied aside' } catch { saved = 'backup ALSO failed' }
    const reason = `${p} is unreadable (${(e as Error).message}; original ${saved})`
    poisoned.set(dataDir, reason)
    console.error(`[roadmap] ${reason} — serving EMPTY and REFUSING saves until repaired`)
    roadmapLatch.once(`corrupt:${p}`, 'critical',
      'Roadmap store is corrupt — read-only until repaired',
      `${reason}. Every project reads as missing and every save is refused: saving now would write the emptiness over the file, which is permanent loss. Repair or remove the file (the .corrupt copy holds the bytes) and reload.`)
    return { projects: [] }
  }
}

export function saveRoadmaps(dataDir: string, data: RoadmapData): void {
  const reason = poisoned.get(dataDir)
  if (reason) {
    // Refusal is the DESIGNED outcome, not an error path: the alternative is
    // silently replacing every project with the empty set we loaded.
    throw new Error(`roadmap store is corrupt and saves are refused (${reason}) — repair the file first`)
  }
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  // Atomic: the old non-atomic write could crash mid-file and CREATE the
  // corrupt state the load path then destroyed.
  const p = filePath(dataDir)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, p)
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

/** Patch a project's metadata. Every field is optional and only touched when PRESENT, so a
 *  caller editing the description cannot blank the status by omission — the same
 *  replace-not-merge trap that made Hermes profiles lose their provider. Passing null for
 *  description/reportId clears that one field explicitly. */
export interface ProjectPatch {
  name?: string
  description?: string | null
  status?: ProjectStatus | null
  reportId?: string | null
  owner?: string | null
}
export function updateProject(data: RoadmapData, id: string, patch: ProjectPatch): RoadmapProject | null {
  const p = getProject(data, id); if (!p) return null
  let touched = false
  if (patch.name !== undefined) { p.name = String(patch.name); touched = true }
  if (patch.description !== undefined) {
    const v = patch.description === null ? '' : String(patch.description).trim()
    if (v) p.description = v; else delete p.description
    touched = true
  }
  if (patch.status !== undefined) {
    if (patch.status && PROJECT_STATUSES.includes(patch.status)) p.status = patch.status
    else delete p.status
    touched = true
  }
  if (patch.reportId !== undefined) {
    const v = patch.reportId === null ? '' : String(patch.reportId).trim()
    if (v) p.reportId = v; else delete p.reportId
    touched = true
  }
  if (patch.owner !== undefined) {
    const v = patch.owner === null ? '' : String(patch.owner).trim()
    if (v) p.owner = v; else delete p.owner
    touched = true
  }
  if (touched) p.updatedAt = nowIso()
  return p
}
export function deleteProject(data: RoadmapData, id: string): boolean {
  const i = data.projects.findIndex(p => p.id === id); if (i < 0) return false
  data.projects.splice(i, 1); return true
}

// ---- node ops ----
interface AddArgs { parentId?: string | null; title: string; kind?: NodeKind; done?: boolean; note?: string; position?: number; actor?: string }

/** True when `actor` is someone other than the project's owner. Unknown actor or unowned
 *  project => no stamp: inventing an attribution is worse than having none, and stamping
 *  every edit on an unowned roadmap would be pure noise. */
function isForeign(proj: RoadmapProject, actor?: string): boolean {
  const a = (actor || '').trim()
  if (!a || !proj.owner) return false
  return a.toLowerCase() !== proj.owner.trim().toLowerCase()
}
export function addNode(data: RoadmapData, pid: string, a: AddArgs): RoadmapNode | null {
  const proj = getProject(data, pid); if (!proj) return null
  let arr = proj.nodes
  if (a.parentId) { const ctx = findCtx(proj, a.parentId); if (!ctx) return null; ctx.node.children = ctx.node.children || []; arr = ctx.node.children }
  const node: RoadmapNode = { id: genId('node'), title: String(a.title || ''), kind: (a.kind || 'item'), order: 0, children: [] }
  if (isForeign(proj, a.actor)) node.addedBy = String(a.actor).trim()
  if (a.done !== undefined) node.done = !!a.done
  if (a.note !== undefined && a.note !== null) node.note = String(a.note)
  if (typeof a.position === 'number' && a.position >= 0 && a.position <= arr.length) arr.splice(a.position, 0, node)
  else arr.push(node)
  arr.forEach((n, i) => { n.order = i })
  proj.updatedAt = nowIso()
  return node
}
interface EditArgs { title?: string; kind?: NodeKind; done?: boolean | null; note?: string | null; status?: NodeStatus | null; actor?: string }
export function editNode(data: RoadmapData, pid: string, nid: string, patch: EditArgs): RoadmapNode | null {
  const proj = getProject(data, pid); if (!proj) return null
  const ctx = findCtx(proj, nid); if (!ctx) return null
  const n = ctx.node
  if (patch.title !== undefined) n.title = String(patch.title)
  if (patch.kind !== undefined) n.kind = patch.kind
  if (patch.done !== undefined) { if (patch.done === null) delete n.done; else n.done = !!patch.done }
  if (patch.note !== undefined) { if (patch.note === null || patch.note === '') delete n.note; else n.note = String(patch.note) }
  if (patch.status !== undefined) {
    if (patch.status && NODE_STATUSES.includes(patch.status)) n.status = patch.status
    else delete n.status
  }
  // A finished item has no lane. Leaving a stale 'doing' on a ticked box is precisely the
  // disagreement the single-source-of-truth rule above exists to prevent.
  if (n.done === true) delete n.status
  if (isForeign(proj, patch.actor)) {
    n.updatedBy = String(patch.actor).trim()
    n.updatedByAt = nowIso()
  }
  proj.updatedAt = nowIso()
  return n
}
export const setDone = (data: RoadmapData, pid: string, nid: string, done: boolean, actor?: string) => editNode(data, pid, nid, { done, actor })
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
  } catch (e) {
    // The legacy roadmap.md was the SOURCE for this migration; discarding it
    // silently meant the move to structured storage could eat the document it
    // migrated from.
    console.warn('[roadmap] legacy roadmap.md migration failed — starting empty; the source doc is untouched on disk:', (e as Error).message)
  }
  saveRoadmaps(dataDir, data)
  return data
}
