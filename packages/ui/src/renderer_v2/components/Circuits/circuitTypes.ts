// Mirrors packages/backend/src/services/Circuits/{circuitParts,circuitModel}.ts — keep in step.
export type PinType = 'power' | 'ground' | 'gpio' | 'input' | 'output' | 'analog' | 'passive' | 'nc' | 'other'
export type PinSide = 'L' | 'R' | 'T' | 'B'
export type SchSymbol = 'box' | 'resistor' | 'led' | 'diode' | 'cap' | 'cap-pol' | 'button' | 'npn' | 'nmos'
export type View = 'bb' | 'sch'

export interface PinDef {
  id: string; name: string; x: number; y: number; side: PinSide; type: PinType
  functions?: string[]; flags?: string[]; voltage?: number; notes?: string
}
export interface PartDef {
  id: string; name: string; category: string; refPrefix: string; description?: string; tags?: string[]
  source: 'builtin' | 'custom' | 'fritzing'; license?: string
  width: number; height: number; svg?: string; image?: string
  pins: PinDef[]; buses?: string[][]; schematic?: { symbol: SchSymbol }; props?: Record<string, unknown>; updatedAt?: string
}
export interface Placement { x: number; y: number; rot: number }
export interface PartInstance { ref: string; partId: string; label?: string; bb: Placement; sch: Placement; props?: Record<string, string> }
export interface PinRef { ref: string; pin: string }
export interface Wire {
  id: string; from: PinRef; to: PinRef; color?: string; label?: string
  bbPoints?: Array<[number, number]>; schPoints?: Array<[number, number]>
}
export interface Design {
  id: string; name: string; description?: string; notes?: string
  parts: PartInstance[]; wires: Wire[]; updatedAt?: string; createdAt?: string; updatedBy?: string
}
export interface Finding { level: 'error' | 'warning' | 'info'; message: string; refs: string[] }
export interface NetNode { ref: string; pin: string; pinName: string; partName: string; type: string }
export interface Net { name: string; nodes: NetNode[]; labels: string[] }
export interface DesignSummary { id: string; name: string; description?: string; updatedAt?: string; parts: number; wires: number }

export const PIN_TYPES: PinType[] = ['gpio', 'input', 'output', 'analog', 'power', 'ground', 'passive', 'nc', 'other']
export const PIN_FLAGS = ['strapping', 'input-only', 'adc2', 'flash', 'psram-octal', 'usb', 'uart0', 'jtag', 'boot-button', 'led', 'reset'] as const
export const PIN_COLORS: Record<PinType, string> = {
  power: '#e5484d', ground: '#9ca3af', gpio: '#22c55e', input: '#38bdf8', output: '#f59e0b',
  analog: '#a855f7', passive: '#e5e7eb', nc: '#6b7280', other: '#e5e7eb',
}
export const WIRE_SWATCHES = ['#e5484d', '#1f1f1f', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#f97316', '#e5e7eb', '#8b5a2b']
