import express from 'express'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import path from 'path'

type Req = express.Request
type Res = express.Response

/**
 * Notes store — plain dictated notes, written from the AI-Lab "Notes" tool.
 *
 * Built for one job: talking at it hands-free (in the car, away from a keyboard) and having
 * the words land somewhere durable. That shapes every decision here — a note being SAFE
 * matters more than a note being clever.
 *
 * THE FILENAME IS THE ID, same rule as the SVG and flowchart stores. The title lives inside
 * the document and is free text; renaming a title never moves a file, so an open editor can
 * never lose track of what it is editing.
 */

interface Note {
  id: string
  title: string
  body: string
  createdAt: string
  updatedAt: string
}

export function createNotesRouter(dataDir: string): express.Router {
  const router = express.Router()
  // 8MB: dictation accumulates, and a note that silently stops accepting text mid-sentence
  // would be a miserable way to discover a limit.
  const json = express.json({ limit: '8mb' })

  const dir = path.join(dataDir, 'notes')
  const ensure = () => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

  // Ids become filenames, so anything that could escape the directory is rejected rather
  // than sanitised — silently renaming a caller's id makes a later get() miss invisibly.
  const badId = (id: string): string | null => {
    if (!id || typeof id !== 'string') return 'id is required'
    if (id.length > 120) return 'id too long (max 120)'
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return 'id may contain only letters, digits, dot, underscore and hyphen'
    if (id.startsWith('.')) return 'id may not start with a dot'
    return null
  }
  const fileFor = (id: string) => path.join(dir, `${id}.json`)

  /**
   * Serialize writes PER NOTE. Autosave fires on a debounce while dictation appends
   * segments, so two saves for the same note genuinely can overlap; without a chain the
   * later-started-but-earlier-finishing write wins and a sentence vanishes with no error.
   */
  const writeChains = new Map<string, Promise<unknown>>()
  const serialize = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = writeChains.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    writeChains.set(id, next.catch(() => undefined))
    return next
  }

  /** Read one note, or null if it is missing/corrupt. Corruption is LOGGED, never silent. */
  const readNote = (id: string): Note | null => {
    const f = fileFor(id)
    if (!existsSync(f)) return null
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8'))
      return {
        id,
        title: typeof raw.title === 'string' ? raw.title : id,
        body: typeof raw.body === 'string' ? raw.body : '',
        createdAt: raw.createdAt ?? new Date(statSync(f).birthtimeMs || Date.now()).toISOString(),
        updatedAt: raw.updatedAt ?? statSync(f).mtime.toISOString(),
      }
    } catch (e) {
      // Do not pretend an unreadable note is an empty note — that is how a corrupt file gets
      // overwritten with nothing by the next autosave.
      console.warn(`[notes] "${id}" could not be parsed and is being skipped: ${(e as Error).message}`)
      return null
    }
  }

  /** List. Cheap enough to poll; returns a preview so the sidebar needs no second request. */
  router.get('/api/notes', (_req: Req, res: Res) => {
    ensure()
    const notes = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const id = f.slice(0, -5)
        const n = readNote(id)
        if (!n) return null
        return {
          id,
          title: n.title,
          updatedAt: n.updatedAt,
          chars: n.body.length,
          preview: n.body.replace(/\s+/g, ' ').trim().slice(0, 140),
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (a.updatedAt < b.updatedAt ? 1 : -1))
    res.json({ notes })
  })

  router.get('/api/notes/:id', (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const n = readNote(req.params.id)
    if (!n) return res.status(404).json({ error: `no note named "${req.params.id}"` })
    res.json(n)
  })

  /** Whole-note save (the editor's autosave). Creates on first write. */
  router.put('/api/notes/:id', json, async (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const body = (req.body ?? {}).body
    const title = (req.body ?? {}).title
    if (typeof body !== 'string') return res.status(400).json({ error: 'body must be a string' })
    try {
      const saved = await serialize(req.params.id, async () => {
        ensure()
        const existing = readNote(req.params.id)
        const note: Note = {
          id: req.params.id,
          title: typeof title === 'string' && title.trim() ? title.trim() : existing?.title ?? req.params.id,
          body,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        writeFileSync(fileFor(req.params.id), JSON.stringify(note, null, 2), 'utf8')
        return note
      })
      res.json({ ok: true, ...saved, chars: saved.body.length })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  /**
   * Append text — the DICTATION primitive, and deliberately not just sugar over PUT.
   *
   * A whole-note PUT sends the client's idea of the entire note. If the browser is stale
   * (another tab, a reconnect, a note opened twice) that overwrites everything it did not
   * know about. Append only ever adds, so a dictated sentence cannot destroy earlier text no
   * matter how confused the client is — which is the failure mode that actually matters when
   * you are talking at this from a car and not watching the screen.
   */
  router.post('/api/notes/:id/append', json, async (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const text = (req.body ?? {}).text
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' })
    try {
      const saved = await serialize(req.params.id, async () => {
        ensure()
        const existing = readNote(req.params.id)
        const prev = existing?.body ?? ''
        // Join with a space mid-paragraph; respect a trailing newline the author left.
        const sep = !prev ? '' : /\s$/.test(prev) ? '' : ' '
        const note: Note = {
          id: req.params.id,
          title: existing?.title ?? req.params.id,
          body: prev + sep + text.trim(),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        writeFileSync(fileFor(req.params.id), JSON.stringify(note, null, 2), 'utf8')
        return note
      })
      res.json({ ok: true, id: saved.id, body: saved.body, updatedAt: saved.updatedAt, chars: saved.body.length })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  /** Plain-text download. A note you cannot get out of the box is a trap. */
  router.get('/api/notes/:id/file.txt', (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const n = readNote(req.params.id)
    if (!n) return res.status(404).json({ error: `no note named "${req.params.id}"` })
    const safe = n.title.replace(/[^A-Za-z0-9._ -]/g, '_').trim() || n.id
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.txt"`)
    res.setHeader('Cache-Control', 'no-store')
    res.end(`${n.title}\n\n${n.body}\n`)
  })

  router.delete('/api/notes/:id', (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const f = fileFor(req.params.id)
    if (!existsSync(f)) return res.status(404).json({ error: `no note named "${req.params.id}"` })
    unlinkSync(f)
    res.json({ ok: true, id: req.params.id })
  })

  return router
}
