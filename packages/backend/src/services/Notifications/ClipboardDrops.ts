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
 * Two lists: `items` is what the drawer shows; `history` is every drop ever posted (cap
 * HISTORY_CAP). Deleting or clearing only touches `items`, so something Travis dismissed can be
 * found again in the History view and restored.
 *
 * Persisted to <dataDir>/notifications/clipboard.json so both survive a backend restart —
 * except `sensitive` drops, which are kept in memory only (in both lists).
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
const HISTORY_CAP = 500
export const MAX_TEXT_BYTES = 64 * 1024

export class ClipboardDrops {
  private items: ClipDrop[] = []
  private history: ClipDrop[] = []

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
    this.history = [item, ...this.history].slice(0, HISTORY_CAP)
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

  /** Every drop ever posted, newest first. `inClipboard` marks the ones still in the drawer. */
  listHistory(): Array<ClipDrop & { inClipboard: boolean }> {
    const active = new Set(this.items.map((i) => i.id))
    return this.history.map((h) => ({ ...h, inClipboard: active.has(h.id) }))
  }

  /** Put a history entry back in the drawer (as a fresh post, so it opens the drawer again). */
  restore(id: string): ClipDrop | null {
    const h = this.history.find((i) => i.id === id)
    if (!h) return null
    if (this.items.some((i) => i.id === id)) return h   // already in the drawer
    this.items = [h, ...this.items].slice(0, CAP)
    this.save()
    this.broadcast('clip:posted', { item: h })
    this.broadcast('clip:changed', { items: this.items })
    return h
  }

  removeFromHistory(id: string): boolean {
    const before = this.history.length
    this.history = this.history.filter((i) => i.id !== id)
    if (this.history.length === before) return false
    this.save()
    return true
  }

  clearHistory(): number {
    const n = this.history.length
    this.history = []
    this.save()
    return n
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
      const valid = (i: any) => i && typeof i.id === 'string' && typeof i.text === 'string'
      if (Array.isArray(parsed?.items)) this.items = parsed.items.filter(valid).slice(0, CAP)
      // Files written before history existed: seed history from the drawer contents.
      this.history = Array.isArray(parsed?.history)
        ? parsed.history.filter(valid).slice(0, HISTORY_CAP)
        : [...this.items]
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
      const keep = (i: ClipDrop) => !i.sensitive
      writeFileSync(tmp, JSON.stringify({ items: this.items.filter(keep), history: this.history.filter(keep) }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn(`[clipboard] could not persist ${this.file}:`, (e as Error)?.message || e)
    }
  }
}
