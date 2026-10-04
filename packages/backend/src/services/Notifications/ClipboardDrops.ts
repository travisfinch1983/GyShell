import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Clipboard drops — text an agent wants Travis to be able to COPY.
 *
 * Why this exists: the AI-Lab terminal panes are ttyd/xterm iframes, and copying out of them
 * is unreliable-to-impossible (especially on a phone), so every URL, command or password an
 * agent printed had to be retyped by hand. An agent now POSTs the text here (MCP tool
 * `clipboard_post`, or plain curl), the drawer slides down from the top of the AI-Lab page,
 * and each entry has a Copy button.
 *
 * Live updates ride the existing gateway raw broadcast (same transport as notify:*):
 *   clip:posted  { item }    a new drop — the UI opens the drawer on this one
 *   clip:changed { items }   the full list after any change (post / delete / clear)
 *
 * Persisted to <dataDir>/notifications/clipboard.json so drops survive a backend restart —
 * except `sensitive` ones, which are kept in memory only.
 */

export interface ClipDrop {
  id: string
  ts: string
  text: string
  title?: string
  /** Who posted it (agent / instance name), shown on the entry. */
  from?: string
  /** Mask in the UI until revealed (passwords, tokens). Copy still copies the real text. */
  sensitive?: boolean
}

const CAP = 50
export const MAX_TEXT_BYTES = 64 * 1024

export class ClipboardDrops {
  private items: ClipDrop[] = []

  constructor(
    private readonly file: string,
    private readonly broadcast: (channel: string, data: unknown) => void,
  ) {
    this.load()
  }

  list(): ClipDrop[] {
    return this.items
  }

  post(input: { text: string; title?: string; from?: string; sensitive?: boolean }): ClipDrop {
    const item: ClipDrop = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      text: input.text,
      ...(input.title ? { title: input.title } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.sensitive ? { sensitive: true } : {}),
    }
    this.items = [item, ...this.items].slice(0, CAP)
    this.save()
    this.broadcast('clip:posted', { item })
    this.broadcast('clip:changed', { items: this.items })
    return item
  }

  remove(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((i) => i.id !== id)
    if (this.items.length === before) return false
    this.save()
    this.broadcast('clip:changed', { items: this.items })
    return true
  }

  clear(): number {
    const n = this.items.length
    this.items = []
    this.save()
    this.broadcast('clip:changed', { items: this.items })
    return n
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed?.items)) {
        this.items = parsed.items
          .filter((i: any) => i && typeof i.id === 'string' && typeof i.text === 'string')
          .slice(0, CAP)
      }
    } catch (e) {
      // A corrupt file must not take the backend down; start empty and say so.
      console.warn(`[clipboard] could not load ${this.file}, starting empty:`, (e as Error)?.message || e)
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      // Sensitive drops (passwords, tokens) live in memory only — never written to disk, so a
      // backend restart forgets them. That is the intended trade.
      const persisted = this.items.filter((i) => !i.sensitive)
      writeFileSync(tmp, JSON.stringify({ items: persisted }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn(`[clipboard] could not persist ${this.file}:`, (e as Error)?.message || e)
    }
  }
}
