/**
 * RoadmapPanel — multi-project roadmaps with live project sub-tabs.
 *
 * Data-driven: projects and their node trees come from /api/roadmap/projects (backend roadmapStore).
 * Adding a project/section/item via the UI or the roadmap_* MCP tools appears here with NO rebuild.
 * Each project is a tree of nodes (section/phase/group/item); any node is checkable (done). Full
 * programmatic control lives in the roadmap_* MCP tools; this panel is view + quick-check + light edit.
 *
 * House rules honored: no window.confirm/alert/prompt — inline inputs and a two-step delete confirm.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Map as MapIcon, Plus, RefreshCw, Trash2, ChevronRight, ChevronDown, ChevronLeft } from 'lucide-react'
import { RoadmapOverview, type ProjMeta as OverviewMeta } from './RoadmapOverview'
import { RoadmapBoard, type BoardColumn } from './RoadmapBoard'
import './roadmap.scss'

function bridge(): any { return (window as any).gyshell?.cluster }

/** Edits made in this UI are Travis's, not an agent's. Sent on every write so an item he
 *  changes on someone else's roadmap is attributed to him rather than appearing to be the
 *  owner's own work. */
const UI_ACTOR = 'travis'

type NodeKind = 'section' | 'phase' | 'group' | 'item'
interface RNode { id: string; title: string; kind: NodeKind; done?: boolean; note?: string; order: number; children: RNode[] }
interface RProject { id: string; name: string; order: number; updatedAt: string; nodes: RNode[] }
type ProjMeta = OverviewMeta

/** The Overview is a pseudo-project id rather than a real stored project: the table of contents
 *  IS the project list, so making it a real project would duplicate every name and description
 *  and immediately drift from the thing it describes. */
const OVERVIEW = '__overview__'

const KINDS: NodeKind[] = ['section', 'phase', 'group', 'item']

export const RoadmapPanel: React.FC = () => {
  const [projects, setProjects] = useState<ProjMeta[]>([])
  const [activePid, setActivePid] = useState<string>('')
  const [tree, setTree] = useState<RProject | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [status, setStatus] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Tree vs Board are two lenses on the SAME nodes — not two datasets. Persisted so the choice
  // survives a reload, per project-agnostic preference.
  const [view, setView] = useState<'tree' | 'board'>(
    () => (localStorage.getItem('rm-view') === 'board' ? 'board' : 'tree'))
  const setViewPersist = (v: 'tree' | 'board') => { setView(v); localStorage.setItem('rm-view', v) }
  // Falls back to the list entry so the breadcrumb has a name during the tree fetch rather
  // than flashing empty.
  const activeName = projects.find(p => p.id === activePid)?.name ?? ''

  const loadProjects = useCallback(async (selectId?: string) => {
    try {
      const data = await bridge().request('GET', '/api/roadmap/projects')
      const list: ProjMeta[] = Array.isArray(data?.projects) ? data.projects : []
      setProjects(list)
      // Default to the Overview. Landing on whichever project happens to sort first is how a
      // project nobody opens stays invisible — the table of contents exists to prevent that.
      const pick = selectId && (selectId === OVERVIEW || list.some(p => p.id === selectId)) ? selectId
        : (activePid && (activePid === OVERVIEW || list.some(p => p.id === activePid)) ? activePid : OVERVIEW)
      setActivePid(pick)
      return pick
    } catch { setState('error'); return '' }
  }, [activePid])

  const patchProject = useCallback(async (pid: string, patch: Record<string, unknown>) => {
    try {
      await bridge().request('PATCH', `/api/roadmap/projects/${encodeURIComponent(pid)}`, { ...patch, actor: UI_ACTOR })
      const data = await bridge().request('GET', '/api/roadmap/projects')
      setProjects(Array.isArray(data?.projects) ? data.projects : [])
    } catch (e) { setStatus('Save failed: ' + ((e as Error)?.message || e)) }
  }, [])

  /** Move a card between board columns. The SERVER decides which fields a column implies
   *  (POST …/column) — sending done+status from here would put that invariant in two places. */
  const moveCard = useCallback(async (nodeId: string, column: BoardColumn) => {
    if (!activePid) return
    try {
      await bridge().request('POST', `/api/roadmap/projects/${encodeURIComponent(activePid)}/nodes/${encodeURIComponent(nodeId)}/column`, { column, actor: UI_ACTOR })
      const data = await bridge().request('GET', `/api/roadmap/projects/${encodeURIComponent(activePid)}`)
      setTree(data?.project ?? null)
      const list = await bridge().request('GET', '/api/roadmap/projects')
      setProjects(Array.isArray(list?.projects) ? list.projects : [])
    } catch (e) { setStatus('Move failed: ' + ((e as Error)?.message || e)) }
  }, [activePid])

  const loadTree = useCallback(async (pid: string) => {
    if (!pid || pid === OVERVIEW) { setTree(null); setState('ready'); return }
    try {
      const data = await bridge().request('GET', `/api/roadmap/projects/${encodeURIComponent(pid)}`)
      setTree(data?.project ?? null); setState('ready')
    } catch { setState('error') }
  }, [])

  useEffect(() => { void (async () => { const pid = await loadProjects(); await loadTree(pid) })() }, []) // eslint-disable-line
  useEffect(() => { if (activePid) void loadTree(activePid) }, [activePid, loadTree])

  const refresh = async () => { setState('loading'); const pid = await loadProjects(activePid); await loadTree(pid || activePid) }

  /** The Overview owns the input now, so the name arrives as an argument. Stays on the
   *  Overview afterwards rather than jumping into the empty new project — you almost always
   *  want to add a description next, and that is here. */
  const createProject = async (name: string) => {
    const n = name.trim(); if (!n) return
    try {
      await bridge().request('POST', '/api/roadmap/projects', { name: n })
      await loadProjects(OVERVIEW)
    } catch (e) { setStatus(`create failed — ${String((e as Error)?.message ?? e)}`) }
  }
  const deleteProject = async (pid: string) => {
    try { await bridge().request('DELETE', `/api/roadmap/projects/${encodeURIComponent(pid)}`); const next = await loadProjects(); await loadTree(next) }
    catch (e) { setStatus(`delete failed — ${String((e as Error)?.message ?? e)}`) }
  }

  const addNode = async (parentId: string | null, title: string, kind: NodeKind) => {
    if (!activePid || !title.trim()) return
    try { await bridge().request('POST', `/api/roadmap/projects/${encodeURIComponent(activePid)}/nodes`, { parentId, title: title.trim(), kind, actor: UI_ACTOR }); await loadTree(activePid); await loadProjects(activePid) }
    catch (e) { setStatus(`add failed — ${String((e as Error)?.message ?? e)}`) }
  }
  const toggleDone = async (nid: string, done: boolean) => {
    if (!activePid) return
    setTree(t => t ? { ...t, nodes: mapTree(t.nodes, n => n.id === nid ? { ...n, done } : n) } : t)
    try { await bridge().request('PATCH', `/api/roadmap/projects/${encodeURIComponent(activePid)}/nodes/${encodeURIComponent(nid)}`, { done, actor: UI_ACTOR }) }
    catch (e) {
      // Say WHY the checkbox reverted. This catch used to be silent, which hid a
      // transport bug (PATCH rejected at the bridge) for weeks — the box just
      // snapped back and the failure looked like a mis-click.
      setStatus(`save failed — ${String((e as Error)?.message ?? e)}`)
      void loadTree(activePid)
    }
  }
  const editTitle = async (nid: string, title: string) => {
    if (!activePid || !title.trim()) return
    try { await bridge().request('PATCH', `/api/roadmap/projects/${encodeURIComponent(activePid)}/nodes/${encodeURIComponent(nid)}`, { title: title.trim(), actor: UI_ACTOR }); await loadTree(activePid) }
    catch (e) { setStatus(`edit failed — ${String((e as Error)?.message ?? e)}`) }
  }
  const removeNode = async (nid: string) => {
    if (!activePid) return
    try { await bridge().request('DELETE', `/api/roadmap/projects/${encodeURIComponent(activePid)}/nodes/${encodeURIComponent(nid)}`); await loadTree(activePid); await loadProjects(activePid) }
    catch (e) { setStatus(`remove failed — ${String((e as Error)?.message ?? e)}`) }
  }

  return (
    <div className="roadmap-panel">
      {/* One way in, one way out. The per-project tab strip was removed once the Overview
          became the table of contents: a tab per project does not survive the project count
          growing, and two navigation paths to the same place is the clutter that hides the
          list you actually read. Inside a project the header becomes a breadcrumb, so there
          is always a visible way back — a strip removal without one strands you. */}
      <div className="roadmap-header">
        <MapIcon size={16} />
        {activePid === OVERVIEW ? (
          <span className="roadmap-title">Roadmap</span>
        ) : (
          <>
            <button className="rm-crumb" onClick={() => setActivePid(OVERVIEW)} title="Back to the table of contents">
              <ChevronLeft size={13} /> All projects
            </button>
            <span className="rm-crumb-sep">/</span>
            <span className="roadmap-title">{tree?.name ?? activeName}</span>
          </>
        )}
        <span className="roadmap-status">{status}</span>
        {activePid !== OVERVIEW && (
          <span className="rm-viewtoggle">
            <button className={`rm-vbtn${view === 'tree' ? ' active' : ''}`} onClick={() => setViewPersist('tree')}>Tree</button>
            <button className={`rm-vbtn${view === 'board' ? ' active' : ''}`} onClick={() => setViewPersist('board')} title="Kanban board of this project's items">Board</button>
          </span>
        )}
        <button className="roadmap-btn" onClick={() => void refresh()} title="Reload"><RefreshCw size={12} /> Reload</button>
      </div>

      <div className="rm-body">
        {state === 'loading' && <div className="rm-empty">Loading…</div>}
        {state === 'error' && <div className="rm-empty rm-err">Failed to load roadmap.</div>}
        {state === 'ready' && activePid === OVERVIEW && (
          <RoadmapOverview projects={projects} onOpen={setActivePid} onPatch={patchProject} onCreate={createProject} />
        )}
        {state === 'ready' && activePid !== OVERVIEW && !tree && <div className="rm-empty">No projects yet — create one above.</div>}
        {state === 'ready' && activePid !== OVERVIEW && tree && view === 'board' && (
          <RoadmapBoard nodes={tree.nodes} onMove={moveCard} />
        )}
        {state === 'ready' && activePid !== OVERVIEW && tree && view === 'tree' && (
          <div className="rm-tree">
            {tree.nodes.length === 0 && <div className="rm-empty">Empty — add a section or item below.</div>}
            {tree.nodes.slice().sort((a, b) => a.order - b.order).map(n => (
              <NodeRow key={n.id} node={n} depth={0} collapsed={collapsed} setCollapsed={setCollapsed}
                onToggle={toggleDone} onAddChild={addNode} onEdit={editTitle} onRemove={removeNode} />
            ))}
            <AddRow depth={0} defaultKind="section" onAdd={(title, kind) => void addNode(null, title, kind)} />
          </div>
        )}
        {state === 'ready' && activePid !== OVERVIEW && tree && projects.length > 0 && (
          <div className="rm-projfoot">
            <DeleteConfirm label={`Delete project "${tree.name}"`} onConfirm={() => void deleteProject(tree.id)} />
          </div>
        )}
      </div>
    </div>
  )
}

// ---- helpers ----
function mapTree(nodes: RNode[], fn: (n: RNode) => RNode): RNode[] {
  return nodes.map(n => { const m = fn(n); return { ...m, children: m.children ? mapTree(m.children, fn) : [] } })
}
const kindClass = (k: NodeKind) => `rm-node rm-${k}`

const NodeRow: React.FC<{
  node: RNode; depth: number; collapsed: Record<string, boolean>; setCollapsed: (u: (c: Record<string, boolean>) => Record<string, boolean>) => void
  onToggle: (id: string, done: boolean) => void; onAddChild: (parentId: string, title: string, kind: NodeKind) => void
  onEdit: (id: string, title: string) => void; onRemove: (id: string) => void
}> = ({ node, depth, collapsed, setCollapsed, onToggle, onAddChild, onEdit, onRemove }) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.title)
  const [adding, setAdding] = useState(false)
  const hasKids = (node.children?.length ?? 0) > 0
  const isOpen = !collapsed[node.id]
  const childKind: NodeKind = node.kind === 'section' ? 'phase' : node.kind === 'phase' ? 'group' : 'item'

  return (
    <div className={kindClass(node.kind)} style={{ marginLeft: depth ? 18 : 0 }}>
      <div className="rm-row">
        <button className="rm-twist" onClick={() => setCollapsed(c => ({ ...c, [node.id]: isOpen }))} style={{ visibility: hasKids ? 'visible' : 'hidden' }}>
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <input type="checkbox" className="rm-check" checked={!!node.done} onChange={e => onToggle(node.id, e.target.checked)} />
        {editing ? (
          <input autoFocus className="rm-input rm-titleinput" value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => { setEditing(false); if (draft.trim() && draft !== node.title) onEdit(node.id, draft) }}
            onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); if (draft.trim() && draft !== node.title) onEdit(node.id, draft) } if (e.key === 'Escape') { setEditing(false); setDraft(node.title) } }} />
        ) : (
          <span className={`rm-nodetitle${node.done ? ' done' : ''}`} onDoubleClick={() => { setDraft(node.title); setEditing(true) }} title="Double-click to edit">{node.title}</span>
        )}
        {node.kind !== 'item' && <span className="rm-kind">{node.kind}</span>}
        <span className="rm-actions">
          <button className="rm-mini" title="Add child" onClick={() => setAdding(a => !a)}><Plus size={12} /></button>
          <DeleteConfirm icon onConfirm={() => onRemove(node.id)} />
        </span>
      </div>
      {node.note && <div className="rm-note" style={{ marginLeft: 22 }}>{node.note}</div>}
      {adding && <AddRow depth={depth + 1} defaultKind={childKind} onAdd={(title, kind) => { onAddChild(node.id, title, kind); setAdding(false) }} />}
      {isOpen && hasKids && node.children.slice().sort((a, b) => a.order - b.order).map(c => (
        <NodeRow key={c.id} node={c} depth={depth + 1} collapsed={collapsed} setCollapsed={setCollapsed}
          onToggle={onToggle} onAddChild={onAddChild} onEdit={onEdit} onRemove={onRemove} />
      ))}
    </div>
  )
}

const AddRow: React.FC<{ depth: number; defaultKind: NodeKind; onAdd: (title: string, kind: NodeKind) => void }> = ({ depth, defaultKind, onAdd }) => {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<NodeKind>(defaultKind)
  const submit = () => { if (title.trim()) { onAdd(title, kind); setTitle('') } }
  return (
    <div className="rm-addrow" style={{ marginLeft: depth ? 18 + 22 : 22 }}>
      <select className="rm-kindsel" value={kind} onChange={e => setKind(e.target.value as NodeKind)}>
        {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
      </select>
      <input className="rm-input" placeholder="Add…" value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit() }} />
      <button className="rm-mini" onClick={submit}><Plus size={12} /></button>
    </div>
  )
}

const DeleteConfirm: React.FC<{ onConfirm: () => void; icon?: boolean; label?: string }> = ({ onConfirm, icon, label }) => {
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t) }, [armed])
  if (icon) return (
    <button className={`rm-mini${armed ? ' rm-danger' : ''}`} title={armed ? 'Click again to confirm' : 'Delete'} onClick={() => armed ? onConfirm() : setArmed(true)}>
      <Trash2 size={12} />
    </button>
  )
  return (
    <button className={`rm-btn-del${armed ? ' rm-danger' : ''}`} onClick={() => armed ? onConfirm() : setArmed(true)}>
      <Trash2 size={12} /> {armed ? 'Confirm delete?' : label}
    </button>
  )
}
