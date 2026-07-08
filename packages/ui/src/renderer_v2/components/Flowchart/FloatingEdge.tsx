import { getBezierPath, useInternalNode, BaseEdge, type EdgeProps } from '@xyflow/react'
import { getEdgeParams } from './floatingUtils'

/**
 * Edge that attaches to the node BORDERS (computed from node positions), not to a specific
 * handle. So an edge only needs { source, target } — no handle bookkeeping — which is what
 * makes both hand-drawn and programmatically-generated diagrams "just connect".
 */
export function FloatingEdge({ id, source, target, markerEnd, markerStart, style }: EdgeProps) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(s, t)
  const [path] = getBezierPath({
    sourceX: sx, sourceY: sy, sourcePosition: sourcePos,
    targetX: tx, targetY: ty, targetPosition: targetPos,
  })
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} markerStart={markerStart} style={style} />
}
