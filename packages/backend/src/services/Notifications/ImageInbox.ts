import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Image inbox — images an agent wants Travis to SEE.
 *
 * Why this exists: agents generate images all over the estate (imagegen jobs, collages,
 * renders) and Travis had to go hunting through folders for them. An agent now POSTs the
 * image here (MCP tool `image_inbox_post`, or plain curl) and the TopBar shows a count pip.
 * Deliberately NOT a popup: unlike the clipboard drawer, nothing opens by itself — Travis
 * opens the viewer when he wants to, and opening clears the pip.
 *
 * Live updates ride the existing gateway raw broadcast (same transport as clip:*):
 *   imginbox:posted  { item }           a new image — the UI bumps the pip, never opens
 *   imginbox:changed { items, unseen }  the full list after any change
 *
 * Images are COPIED into <dataDir>/notifications/image-inbox/ at post time, so the inbox
 * keeps working when the source file is later moved or deleted. Senders can pass a file
 * path (restricted to ALLOWED ROOTS — this tool must not be a read-anything primitive) or
 * upload raw bytes as base64.
 */

export interface InboxImage {
  id: string
  ts: string
  /** Short label shown on the entry. */
  title?: string
  /** Longer text under the image. */
  caption?: string
  /** Who posted it (agent / instance name). */
  from?: string
  mime: string
  bytes: number
  /** Where it came from, display-only (the served file is our own copy). */
  origPath?: string
  /** Travis has opened the viewer since this arrived. */
  seen: boolean
}

const CAP = 200
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024        // on-disk file posted by path
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024       // decoded base64 upload

/** Only real raster/animation formats a browser renders in <img>. No svg (scriptable). */
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
}

export class ImageInboxError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export class ImageInbox {
  private items: InboxImage[] = []
  private readonly dir: string
  private readonly index: string
  /** realpath'd allowed roots — a path post must land inside one of these. */
  private readonly roots: string[]

  constructor(
    dataDir: string,
    private readonly broadcast: (channel: string, data: unknown) => void,
    allowedRoots: string[] = ['/imagegen'],
  ) {
    this.dir = path.join(dataDir, 'notifications', 'image-inbox')
    this.index = path.join(this.dir, 'index.json')
    this.roots = allowedRoots.flatMap((r) => {
      try { return [realpathSync(r)] } catch (e) {
        console.warn(`[image-inbox] allowed root ${r} not resolvable:`, (e as Error)?.message || e)
        return []
      }
    })
    this.load()
  }

  list(): InboxImage[] { return this.items }

  unseen(): number { return this.items.filter((i) => !i.seen).length }

  /**
   * Validate a sender-supplied path. Realpath BEFORE the root check so a symlink inside an
   * allowed root cannot point the copy at /etc/shadow — the check runs on where the file
   * actually lives, not on how it was spelled.
   */
  private checkPath(p: string): { real: string; ext: string; size: number } {
    if (typeof p !== 'string' || !p.trim()) throw new ImageInboxError('path is empty')
    let real: string
    try { real = realpathSync(path.resolve(p)) } catch { throw new ImageInboxError(`file not found: ${p}`, 404) }
    if (!this.roots.some((r) => real === r || real.startsWith(r + path.sep))) {
      throw new ImageInboxError(`path is outside the allowed roots (${this.roots.join(', ')})`, 403)
    }
    const st = statSync(real)
    if (!st.isFile()) throw new ImageInboxError('path is not a regular file')
    if (st.size === 0) throw new ImageInboxError('file is empty')
    if (st.size > MAX_IMAGE_BYTES) throw new ImageInboxError(`file too large (${st.size} > ${MAX_IMAGE_BYTES} bytes)`)
    const ext = path.extname(real).slice(1).toLowerCase()
    if (!EXT_MIME[ext]) throw new ImageInboxError(`unsupported image type .${ext} (allowed: ${Object.keys(EXT_MIME).join(', ')})`)
    return { real, ext, size: st.size }
  }

  /** Post by path (copied in) or by base64 upload. Exactly one of path/dataBase64. */
  post(input: {
    path?: string
    dataBase64?: string
    filename?: string
    title?: string
    caption?: string
    from?: string
  }): InboxImage {
    const id = randomUUID()
    let ext: string
    let size: number
    let origPath: string | undefined
    mkdirSync(this.dir, { recursive: true })

    if (input.path && input.dataBase64) throw new ImageInboxError('pass path OR dataBase64, not both')
    if (input.path) {
      const ok = this.checkPath(input.path)
      ext = ok.ext
      size = ok.size
      origPath = ok.real
      copyFileSync(ok.real, this.file(id, ext))
    } else if (input.dataBase64) {
      const name = String(input.filename || '')
      ext = path.extname(name).slice(1).toLowerCase()
      if (!EXT_MIME[ext]) throw new ImageInboxError(`filename must carry an allowed image extension (${Object.keys(EXT_MIME).join(', ')})`)
      let buf: Buffer
      try { buf = Buffer.from(input.dataBase64, 'base64') } catch { throw new ImageInboxError('dataBase64 is not valid base64') }
      if (buf.length === 0) throw new ImageInboxError('decoded upload is empty')
      if (buf.length > MAX_UPLOAD_BYTES) throw new ImageInboxError(`upload too large (${buf.length} > ${MAX_UPLOAD_BYTES} bytes)`)
      size = buf.length
      writeFileSync(this.file(id, ext), buf, { mode: 0o600 })
    } else {
      throw new ImageInboxError('pass a file path or dataBase64')
    }

    const item: InboxImage = {
      id,
      ts: new Date().toISOString(),
      mime: EXT_MIME[ext],
      bytes: size,
      seen: false,
      ...(input.title ? { title: String(input.title).slice(0, 200) } : {}),
      ...(input.caption ? { caption: String(input.caption).slice(0, 2000) } : {}),
      ...(input.from ? { from: String(input.from).slice(0, 60) } : {}),
      ...(origPath ? { origPath } : {}),
    }
    const evicted = [this.items[CAP - 1]].filter((e) => e && this.items.length >= CAP) as InboxImage[]
    this.items = [item, ...this.items].slice(0, CAP)
    for (const e of evicted) this.deleteFile(e)
    this.save()
    this.broadcast('imginbox:posted', { item })
    this.changed()
    return item
  }

  /** Absolute path of the stored copy, for the HTTP route to stream. */
  storedFile(id: string): { file: string; mime: string } | null {
    const item = this.items.find((i) => i.id === id)
    if (!item) return null
    const ext = Object.entries(EXT_MIME).find(([, m]) => m === item.mime)?.[0] ?? 'png'
    const file = this.file(id, ext)
    return existsSync(file) ? { file, mime: item.mime } : null
  }

  /** Viewer opened: everything currently in the list counts as seen; the pip clears. */
  markAllSeen(): number {
    const n = this.unseen()
    if (n === 0) return 0
    this.items = this.items.map((i) => (i.seen ? i : { ...i, seen: true }))
    this.save()
    this.changed()
    return n
  }

  remove(id: string): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    this.items = this.items.filter((i) => i.id !== id)
    this.deleteFile(item)
    this.save()
    this.changed()
    return true
  }

  clear(): number {
    const n = this.items.length
    for (const i of this.items) this.deleteFile(i)
    this.items = []
    this.save()
    this.changed()
    return n
  }

  private changed(): void {
    this.broadcast('imginbox:changed', { items: this.items, unseen: this.unseen() })
  }

  private file(id: string, ext: string): string {
    return path.join(this.dir, `${id}.${ext}`)
  }

  private deleteFile(item: InboxImage): void {
    const ext = Object.entries(EXT_MIME).find(([, m]) => m === item.mime)?.[0] ?? 'png'
    try { rmSync(this.file(item.id, ext), { force: true }) } catch (e) {
      console.warn(`[image-inbox] could not delete stored file for ${item.id}:`, (e as Error)?.message || e)
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.index)) return
      const parsed = JSON.parse(readFileSync(this.index, 'utf8'))
      const valid = (i: any) => i && typeof i.id === 'string' && typeof i.mime === 'string'
      if (Array.isArray(parsed?.items)) this.items = parsed.items.filter(valid).slice(0, CAP)
    } catch (e) {
      // A corrupt index must not take the backend down; start empty and say so.
      console.warn(`[image-inbox] could not load ${this.index}, starting empty:`, (e as Error)?.message || e)
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.index}.tmp`
      writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.index)
    } catch (e) {
      console.warn(`[image-inbox] could not persist ${this.index}:`, (e as Error)?.message || e)
    }
  }
}
