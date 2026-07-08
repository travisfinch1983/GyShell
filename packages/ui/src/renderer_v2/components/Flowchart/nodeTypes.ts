// Generic flowchart node shapes for the AI-Lab Flowchart tab.
export const NODE_SHAPES = {
  rectangle: { label: 'Rectangle', color: '#4f8cff' },
  rounded:   { label: 'Rounded',   color: '#4f8cff' },
  ellipse:   { label: 'Ellipse',   color: '#22c55e' },
  diamond:   { label: 'Decision',  color: '#f59e0b' },
  cylinder:  { label: 'Store',     color: '#a855f7' },
  hexagon:   { label: 'Process',   color: '#ec4899' },
  group:     { label: 'Group',     color: '#64748b' },
} as const

export type NodeShapeType = keyof typeof NODE_SHAPES

/** Node data — kept small + generic so claude1 can generate/read diagrams as plain JSON. */
export interface FlowNodeData {
  label: string
  shape: NodeShapeType
  color: string
  description?: string
  [k: string]: unknown
}

export type FlowEdgeKind = 'directed' | 'bidirectional' | 'line'
