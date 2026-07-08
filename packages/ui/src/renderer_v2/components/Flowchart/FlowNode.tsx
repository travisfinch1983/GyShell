import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNodeData } from './nodeTypes'
import styles from './FlowNode.module.css'

export const FlowNode = memo(({ data, selected }: NodeProps & { data: FlowNodeData }) => {
  const shapeClass = styles[data.shape] || styles.rectangle
  return (
    <div
      className={`${styles.node} ${shapeClass} ${selected ? styles.selected : ''}`}
      style={{ '--node-color': data.color } as React.CSSProperties}
      title={data.description || undefined}
    >
      {/* A DEFAULT (no-id) target + source handle so an edge that names no handle still resolves
          — otherwise React Flow drops the edge before rendering. Two more id'd side handles +
          ConnectionMode.Loose let a drag start/end from any side. The FloatingEdge ignores handle
          POSITION and routes border-to-border, so the exact handle used doesn't affect the look. */}
      <Handle type="target" position={Position.Top} className={styles.handle} />
      <Handle type="source" position={Position.Bottom} className={styles.handle} />
      <Handle type="target" position={Position.Left} id="l" className={styles.handle} />
      <Handle type="source" position={Position.Right} id="r" className={styles.handle} />
      <span className={styles.label}>{data.label}</span>
    </div>
  )
})
FlowNode.displayName = 'FlowNode'
