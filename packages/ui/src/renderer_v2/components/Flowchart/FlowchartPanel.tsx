import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type EdgeMarker,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Save, FolderOpen, FilePlus2, Trash2, Maximize2 } from 'lucide-react'
import { NODE_SHAPES, type NodeShapeType, type FlowNodeData, type FlowEdgeKind } from './nodeTypes'
import { FlowNode } from './FlowNode'
import styles from './FlowchartPanel.module.css'

const nodeTypes = { flow: FlowNode }
const bridge = (): { request: (m: string, p: string, b?: unknown) => Promise<any> } | undefined =>
  (window as unknown as { gyshell?: { cluster?: any } }).gyshell?.cluster

interface Chart { id: string; name: string; nodes: Node[]; edges: Edge[]; updatedAt?: string }

const api = {
  async list(): Promise<Array<{ id: string; name: string; updatedAt?: string }>> {
    try { const r = await bridge()?.request('GET', '/api/flowcharts'); return Array.isArray(r?.charts) ? r.charts : [] } catch { return [] }
  },
  async load(id: string): Promise<Chart | null> {
    try { const r = await bridge()?.request('GET', `/api/flowcharts/${encodeURIComponent(id)}`); return r?.chart ?? null } catch { return null }
  },
  async save(chart: Chart): Promise<void> {
    try { await bridge()?.request('PUT', `/api/flowcharts/${encodeURIComponent(chart.id)}`, chart) } catch { /* ignore */ }
  },
  async remove(id: string): Promise<void> {
    try { await bridge()?.request('DELETE', `/api/flowcharts/${encodeURIComponent(id)}`) } catch { /* ignore */ }
  },
}

const DRAFT_KEY = 'ai-lab-flowchart-draft'
let _c = 0
const nid = () => `n${Date.now().toString(36)}${(_c++).toString(36)}`

function edgeStyleFor(kind: FlowEdgeKind): Partial<Edge> {
  if (kind === 'line') return {}
  const m: EdgeMarker = { type: MarkerType.ArrowClosed, width: 18, height: 18 }
  return kind === 'bidirectional' ? { markerStart: m, markerEnd: m } : { markerEnd: m }
}

const PALETTE: NodeShapeType[] = ['rectangle', 'rounded', 'ellipse', 'diamond', 'cylinder', 'hexagon', 'group']

function Inner() {
  const draft = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') } catch { return null } })()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(draft?.nodes || [])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(draft?.edges || [])
  const [rf, setRf] = useState<ReactFlowInstance | null>(null)
  const [edgeKind, setEdgeKind] = useState<FlowEdgeKind>('directed')
  const [name, setName] = useState<string>(draft?.name || 'Untitled')
  const [chartId, setChartId] = useState<string>(draft?.id || nid())
  const [saved, setSaved] = useState<Array<{ id: string; name: string; updatedAt?: string }>>([])
  const [showLoad, setShowLoad] = useState(false)
  const [selId, setSelId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const selNode = nodes.find((n) => n.id === selId) || null

  // Autosave the working draft locally so a refresh doesn't lose in-progress work.
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: chartId, name, nodes, edges })) } catch { /* ignore */ } }, 500)
    return () => clearTimeout(t)
  }, [nodes, edges, name, chartId])

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, ...edgeStyleFor(edgeKind) }, es)), [edgeKind, setEdges])

  const addNode = useCallback((shape: NodeShapeType) => {
    const meta = NODE_SHAPES[shape]
    const w = wrapRef.current?.clientWidth || 800
    const h = wrapRef.current?.clientHeight || 500
    const pos = rf ? rf.screenToFlowPosition({ x: w / 2 + (Math.random() * 80 - 40), y: h / 2 + (Math.random() * 80 - 40) }) : { x: 120, y: 120 }
    const node: Node = { id: nid(), type: 'flow', position: pos, data: { label: meta.label, shape, color: meta.color } as FlowNodeData, ...(shape === 'group' ? { zIndex: -1 } : {}) }
    setNodes((ns) => [...ns, node]); setSelId(node.id)
  }, [rf, setNodes])

  const patchSel = useCallback((patch: Partial<FlowNodeData>) => {
    setNodes((ns) => ns.map((n) => (n.id === selId ? { ...n, data: { ...n.data, ...patch } } : n)))
  }, [selId, setNodes])

  const deleteSel = useCallback(() => {
    if (!selId) return
    setEdges((es) => es.filter((e) => e.source !== selId && e.target !== selId))
    setNodes((ns) => ns.filter((n) => n.id !== selId))
    setSelId(null)
  }, [selId, setNodes, setEdges])

  const doSave = useCallback(async () => {
    await api.save({ id: chartId, name: name.trim() || 'Untitled', nodes, edges, updatedAt: new Date().toISOString() })
    setSaved(await api.list())
  }, [chartId, name, nodes, edges])

  const doLoad = useCallback(async (id: string) => {
    const c = await api.load(id)
    if (!c) return
    setChartId(c.id); setName(c.name || 'Untitled'); setNodes(c.nodes || []); setEdges(c.edges || []); setSelId(null); setShowLoad(false)
    setTimeout(() => rf?.fitView({ padding: 0.2 }), 60)
  }, [rf, setNodes, setEdges])

  const doNew = useCallback(() => { setChartId(nid()); setName('Untitled'); setNodes([]); setEdges([]); setSelId(null) }, [setNodes, setEdges])
  const openLoad = useCallback(async () => { setSaved(await api.list()); setShowLoad(true) }, [])

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <input className={styles.nameInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Diagram name" />
        <button className={styles.btn} onClick={doSave} title="Save to the shared server store"><Save size={13} /> Save</button>
        <button className={styles.btn} onClick={openLoad} title="Open a saved diagram"><FolderOpen size={13} /> Open</button>
        <button className={styles.btn} onClick={doNew} title="New blank diagram"><FilePlus2 size={13} /> New</button>
        <span className={styles.sep} />
        <label className={styles.edgeSel}>Edge:
          <select value={edgeKind} onChange={(e) => setEdgeKind(e.target.value as FlowEdgeKind)}>
            <option value="directed">arrow →</option>
            <option value="bidirectional">both ↔</option>
            <option value="line">line —</option>
          </select>
        </label>
        <span className={styles.spacer} />
        <button className={styles.btn} onClick={() => rf?.fitView({ padding: 0.2 })} title="Fit to view"><Maximize2 size={13} /></button>
        <button className={styles.btn} disabled={!selId} onClick={deleteSel} title="Delete selected (or press Delete)"><Trash2 size={13} /></button>
      </div>

      <div className={styles.body}>
        <div className={styles.palette}>
          <div className={styles.paletteHead}>Shapes</div>
          {PALETTE.map((s) => (
            <button key={s} className={styles.shapeBtn} onClick={() => addNode(s)} style={{ borderColor: NODE_SHAPES[s].color }}>
              <span className={styles.swatch} style={{ background: NODE_SHAPES[s].color }} />
              {NODE_SHAPES[s].label}
            </button>
          ))}
          <div className={styles.paletteHint}>Click to add · drag between node edges to connect · Delete removes selected</div>
        </div>

        <div className={styles.canvas} ref={wrapRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setRf}
            nodeTypes={nodeTypes}
            onSelectionChange={({ nodes: sel }) => setSelId(sel[0]?.id ?? null)}
            deleteKeyCode={['Delete', 'Backspace']}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls />
            <MiniMap pannable zoomable nodeColor={(n) => (n.data as FlowNodeData)?.color || '#888'} />
          </ReactFlow>
        </div>

        {selNode && (
          <div className={styles.props}>
            <div className={styles.propsHead}>Node</div>
            <label className={styles.field}>Label
              <input value={(selNode.data as FlowNodeData).label} onChange={(e) => patchSel({ label: e.target.value })} />
            </label>
            <label className={styles.field}>Shape
              <select value={(selNode.data as FlowNodeData).shape} onChange={(e) => patchSel({ shape: e.target.value as NodeShapeType })}>
                {PALETTE.map((s) => <option key={s} value={s}>{NODE_SHAPES[s].label}</option>)}
              </select>
            </label>
            <label className={styles.field}>Color
              <input type="color" value={(selNode.data as FlowNodeData).color} onChange={(e) => patchSel({ color: e.target.value })} />
            </label>
            <label className={styles.field}>Notes
              <textarea rows={4} value={(selNode.data as FlowNodeData).description || ''} onChange={(e) => patchSel({ description: e.target.value })} />
            </label>
            <button className={styles.btnDanger} onClick={deleteSel}><Trash2 size={12} /> Delete node</button>
          </div>
        )}
      </div>

      {showLoad && (
        <div className={styles.modalBg} onClick={() => setShowLoad(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>Saved diagrams</div>
            {saved.length === 0 && <div className={styles.dim}>No saved diagrams yet.</div>}
            {saved.map((c) => (
              <div key={c.id} className={styles.savedRow}>
                <button className={styles.savedName} onClick={() => doLoad(c.id)}>{c.name}</button>
                <span className={styles.dim}>{c.updatedAt ? new Date(c.updatedAt).toLocaleString() : ''}</span>
                <button className={styles.savedDel} title="Delete" onClick={async () => { await api.remove(c.id); setSaved(await api.list()) }}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function FlowchartPanel() {
  return <ReactFlowProvider><Inner /></ReactFlowProvider>
}
