import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNodeData } from './nodeTypes'
import styles from './FlowNode.module.css'

// One handle per side, each usable as BOTH source and target, so an edge can be dragged
// from any side to any side (the natural "draw a connector" gesture).
const SIDES: Array<[string, Position]> = [
  ['t', Position.Top],
  ['r', Position.Right],
  ['b', Position.Bottom],
  ['l', Position.Left],
]

export const FlowNode = memo(({ data, selected }: NodeProps & { data: FlowNodeData }) => {
  const shapeClass = styles[data.shape] || styles.rectangle
  return (
    <div
      className={`${styles.node} ${shapeClass} ${selected ? styles.selected : ''}`}
      style={{ '--node-color': data.color } as React.CSSProperties}
      title={data.description || undefined}
    >
      {SIDES.map(([id, pos]) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={pos}
          isConnectableStart
          isConnectableEnd
          className={styles.handle}
        />
      ))}
      <span className={styles.label}>{data.label}</span>
    </div>
  )
})
FlowNode.displayName = 'FlowNode'
