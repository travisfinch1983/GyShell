import fs from 'node:fs'
import { TransitionLatch } from '../notifyLocal'
import path from 'node:path'
import type { TerminalConfig } from '../../types'
import { normalizePersistedTerminalConfig } from './terminalConnectionSupport'

const stateLatch = new TransitionLatch(1, 'terminal-state')

export interface PersistedTerminalRecord {
  id: string
  config: TerminalConfig
}

interface PersistedTerminalStatePayload {
  schemaVersion: 1
  updatedAt: number
  terminals: PersistedTerminalRecord[]
}

const CURRENT_SCHEMA_VERSION = 1 as const

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const normalizeRecord = (raw: unknown): PersistedTerminalRecord | null => {
  if (!isObject(raw)) return null
  const config = normalizePersistedTerminalConfig(raw.config)
  if (!config) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : config.id
  if (!id) return null
  return {
    id,
    config: {
      ...config,
      id
    }
  }
}

const normalizePayload = (raw: unknown): PersistedTerminalStatePayload => {
  if (!isObject(raw)) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      terminals: []
    }
  }

  const seen = new Set<string>()
  const terminals: PersistedTerminalRecord[] = []
  const input = Array.isArray(raw.terminals) ? raw.terminals : []
  let dropped = 0
  input.forEach((item) => {
    const normalized = normalizeRecord(item)
    if (!normalized) { dropped += 1; return }
    if (seen.has(normalized.id)) return
    terminals.push(normalized)
    seen.add(normalized.id)
  })
  if (dropped > 0) {
    // The next persist writes the REDUCED set over the file, so a schema drift
    // that rejects records erases saved tabs permanently — and this count is
    // the only witness before that write happens. Announce BEFORE the prune.
    console.warn(`[terminal-state] dropped ${dropped} of ${input.length} persisted terminal record(s) on load — the next save makes this permanent`)
    stateLatch.once('records-dropped', 'warning',
      'Saved terminal tabs were dropped while loading',
      `${dropped} of ${input.length} persisted record(s) failed validation and will be pruned on the next save (schema drift is the usual cause). If tabs are missing, recover them from the state file backup NOW — the prune overwrites it.`)
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: Date.now(),
    terminals
  }
}

export class TerminalStateStore {
  constructor(private readonly stateFilePath: string) {}

  load(): PersistedTerminalRecord[] {
    try {
      if (!fs.existsSync(this.stateFilePath)) return []
      const raw = fs.readFileSync(this.stateFilePath, 'utf8')
      const parsed = JSON.parse(raw)
      const payload = normalizePayload(parsed)
      return payload.terminals
    } catch (error) {
      console.warn('[TerminalStateStore] Failed to read terminal state file:', error)
      return []
    }
  }

  save(terminals: PersistedTerminalRecord[]): void {
    const payload = normalizePayload({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      terminals
    })

    const dirPath = path.dirname(this.stateFilePath)
    const tempFilePath = `${this.stateFilePath}.tmp-${process.pid}-${Date.now()}`

    try {
      fs.mkdirSync(dirPath, { recursive: true })
      fs.writeFileSync(tempFilePath, JSON.stringify(payload, null, 2), 'utf8')
      fs.renameSync(tempFilePath, this.stateFilePath)
    } catch (error) {
      console.warn('[TerminalStateStore] Failed to persist terminal state file:', error)
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.rmSync(tempFilePath, { force: true })
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
