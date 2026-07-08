import { Position, type InternalNode, type Node } from '@xyflow/react'

function dims(n: InternalNode<Node>) {
  return { w: n.measured?.width ?? 120, h: n.measured?.height ?? 46 }
}

// Point where the line from node-center to target-center crosses node's border.
function intersection(node: InternalNode<Node>, target: InternalNode<Node>) {
  const { w, h } = dims(node)
  const nx = node.internals.positionAbsolute.x
  const ny = node.internals.positionAbsolute.y
  const cx = nx + w / 2
  const cy = ny + h / 2
  const td = dims(target)
  const tcx = target.internals.positionAbsolute.x + td.w / 2
  const tcy = target.internals.positionAbsolute.y + td.h / 2
  const dx = tcx - cx
  const dy = tcy - cy
  const scale = Math.min((w / 2) / (Math.abs(dx) || 1e-6), (h / 2) / (Math.abs(dy) || 1e-6))
  return { x: cx + dx * scale, y: cy + dy * scale }
}

function sideOf(node: InternalNode<Node>, p: { x: number; y: number }): Position {
  const { w, h } = dims(node)
  const nx = Math.round(node.internals.positionAbsolute.x)
  const ny = Math.round(node.internals.positionAbsolute.y)
  const px = Math.round(p.x)
  const py = Math.round(p.y)
  if (px <= nx + 1) return Position.Left
  if (px >= nx + w - 1) return Position.Right
  if (py <= ny + 1) return Position.Top
  return Position.Bottom
}

export function getEdgeParams(source: InternalNode<Node>, target: InternalNode<Node>) {
  const s = intersection(source, target)
  const t = intersection(target, source)
  return { sx: s.x, sy: s.y, tx: t.x, ty: t.y, sourcePos: sideOf(source, s), targetPos: sideOf(target, t) }
}
