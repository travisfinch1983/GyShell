import React, { useState } from 'react'

export type BoardColumn = 'untracked' | 'todo' | 'doing' | 'blocked' | 'done'
export const BOARD_COLUMNS: BoardColumn[] = ['untracked', 'todo', 'doing', 'blocked', 'done']

interface RNode {
  id: string
  title: string
  kind: 'section' | 'phase' | 'group' | 'item'
  done?: boolean
  status?: 'todo' | 'doing' | 'blocked'
  addedBy?: string
  updatedBy?: string
  updatedByAt?: string
  note?: string
  order: number
  children: RNode[]
}

/** Mirrors the server's boardColumn() exactly. The server owns the WRITE side (POST
 *  /column returns the authoritative column), so this only decides where to paint a card —
 *  but it must agree, or a card would jump columns on refresh. */
function columnOf(n: RNode): BoardColumn {
  if (n.done === true) return 'done'
  if (typeof n.done !== 'boolean') return 'untracked'
  return n.status ?? 'todo'
}

const COLUMN_META: Record<BoardColumn, { label: string; blurb: string }> = {
  untracked: { label: 'Untracked', blurb: 'written down, never triaged' },
  todo: { label: 'To do', blurb: '' },
  doing: { label: 'Doing', blurb: '' },
  blocked: { label: 'Blocked', blurb: '' },
  done: { label: 'Done', blurb: '' },
}

interface Card { node: RNode; path: string }

/** Flatten to leaf tasks, carrying the ancestor titles so a card keeps its context — a board of
 *  bare titles like "Phase 2" or "Wire it up" is unreadable once it leaves the tree. Containers
 *  (section/phase/group) are structure, not work, and only appear if they carry a checkbox. */
function collectCards(nodes: RNode[], trail: string[] = [], out: Card[] = []): Card[] {
  for (const n of nodes.slice().sort((a, b) => a.order - b.order)) {
    const isTask = n.kind === 'item' || typeof n.done === 'boolean'
    if (isTask) out.push({ node: n, path: trail.join(' › ') })
    collectCards(n.children ?? [], [...trail, n.title], out)
  }
  return out
}

export const RoadmapBoard: React.FC<{
  nodes: RNode[]
  onMove: (nodeId: string, column: BoardColumn) => Promise<void>
}> = ({ nodes, onMove }) => {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<BoardColumn | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const cards = collectCards(nodes)
  const byCol = BOARD_COLUMNS.reduce((acc, c) => {
    acc[c] = cards.filter((x) => columnOf(x.node) === c)
    return acc
  }, {} as Record<BoardColumn, Card[]>)

  const drop = async (col: BoardColumn) => {
    const id = dragId
    setDragId(null); setOverCol(null)
    if (!id) return
    const card = cards.find((c) => c.node.id === id)
    if (!card || columnOf(card.node) === col) return
    setBusy(id)
    try { await onMove(id, col) } finally { setBusy(null) }
  }

  return (
    <div className="rmb">
      {BOARD_COLUMNS.map((col) => (
        <div
          key={col}
          className={`rmb-col rmb-col-${col}${overCol === col ? ' rmb-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOverCol(col) }}
          onDragLeave={() => setOverCol((c) => (c === col ? null : c))}
          onDrop={(e) => { e.preventDefault(); void drop(col) }}
        >
          <div className="rmb-head">
            <span className="rmb-title">{COLUMN_META[col].label}</span>
            <span className="rmb-count">{byCol[col].length}</span>
          </div>
          {COLUMN_META[col].blurb && <div className="rmb-blurb">{COLUMN_META[col].blurb}</div>}

          <div className="rmb-cards">
            {byCol[col].length === 0 && <div className="rmb-empty">—</div>}
            {byCol[col].map(({ node, path }) => (
              <div
                key={node.id}
                className={`rmb-card${busy === node.id ? ' rmb-busy' : ''}${dragId === node.id ? ' rmb-dragging' : ''}`}
                draggable
                onDragStart={() => setDragId(node.id)}
                onDragEnd={() => { setDragId(null); setOverCol(null) }}
                title={node.note || node.title}
              >
                {path && <div className="rmb-path">{path}</div>}
                <div className="rmb-cardtitle">{node.title}</div>
                {/* Only present when someone OTHER than the owner touched it — the owner's own
                    work is unmarked, or the badge would be on everything and mean nothing. */}
                {(node.addedBy || node.updatedBy) && (
                  <div className="rmb-attrib">
                    {node.addedBy && <span className="rmb-by" title={`Added by ${node.addedBy}`}>+{node.addedBy}</span>}
                    {node.updatedBy && (
                      <span className="rmb-by" title={`Last changed by ${node.updatedBy}${node.updatedByAt ? ' on ' + node.updatedByAt.slice(0, 10) : ''}`}>
                        ✎{node.updatedBy}
                      </span>
                    )}
                  </div>
                )}
                {/* Dragging is the primary gesture, but a select is the accessible one and the
                    only one that works on touch — a board you can only operate with a mouse
                    excludes the tablet this gets read on. */}
                <select
                  className="rmb-move"
                  value={col}
                  disabled={busy === node.id}
                  onChange={(e) => { setBusy(node.id); void onMove(node.id, e.target.value as BoardColumn).finally(() => setBusy(null)) }}
                  onClick={(e) => e.stopPropagation()}
                  title="Move this card"
                >
                  {BOARD_COLUMNS.map((c) => <option key={c} value={c}>{COLUMN_META[c].label}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
