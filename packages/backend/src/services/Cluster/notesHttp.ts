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

/**
 * Two kinds of note share one store. A TEXT note is free text (dictation lands here). A GRID
 * note is a plain table — rows of string cells — for information that is already tabular and
 * gets mangled when flattened into prose. Files written before grids existed have no `kind`
 * and are text notes; that default is what keeps every old note readable.
 */
type NoteKind = 'text' | 'grid'

interface Grid {
  /** rows[r][c]; every row is padded to the same width on save. */
  rows: string[][]
  /** Optional per-column pixel widths, set by dragging a column edge in the editor. */
  colWidths?: number[]
  /** Treat row 0 as a header (bold, kept out of sorting). */
  header?: boolean
}

interface Note {
  id: string
  kind: NoteKind
  title: string
  body: string
  grid?: Grid
  createdAt: string
  updatedAt: string
}

const MAX_ROWS = 5000
const MAX_COLS = 200

/** Validate a client grid and normalise it to a rectangle. Returns an error string on bad input. */
function normaliseGrid(g: any): Grid | string {
  if (!g || typeof g !== 'object' || !Array.isArray(g.rows)) return 'grid.rows must be an array of rows'
  if (g.rows.length > MAX_ROWS) return `grid has ${g.rows.length} rows (max ${MAX_ROWS})`
  let width = 0
  for (const [i, r] of g.rows.entries()) {
    if (!Array.isArray(r)) return `grid.rows[${i}] is not an array`
    if (r.length > MAX_COLS) return `grid.rows[${i}] has ${r.length} cells (max ${MAX_COLS})`
    width = Math.max(width, r.length)
  }
  width = Math.max(width, 1)
  const rows = (g.rows.length ? g.rows : [[]]).map((r: any[]) => {
    const out = r.map((c) => (c == null ? '' : String(c)))
    while (out.length < width) out.push('')
    return out
  })
  const grid: Grid = { rows, header: g.header !== false }
  if (Array.isArray(g.colWidths)) {
    grid.colWidths = g.colWidths.slice(0, width).map((w: any) => {
      const n = Number(w)
      return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 40), 1200) : 140
    })
  }
  return grid
}

/** Flatten a grid to text for the list preview and the char count. */
const gridText = (g: Grid | undefined): string =>
  (g?.rows ?? []).map((r) => r.join('\t')).join('\n')

/** RFC 4180 CSV — quote any cell holding a comma, quote or newline. */
const toCsv = (g: Grid): string =>
  g.rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n'

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
      const kind: NoteKind = raw.kind === 'grid' ? 'grid' : 'text'
      let grid: Grid | undefined
      if (kind === 'grid') {
        const g = normaliseGrid(raw.grid ?? { rows: [[]] })
        if (typeof g === 'string') throw new Error(`stored grid is invalid: ${g}`)
        grid = g
      }
      return {
        id,
        kind,
        title: typeof raw.title === 'string' ? raw.title : id,
        body: typeof raw.body === 'string' ? raw.body : '',
        ...(grid ? { grid } : {}),
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
        const text = n.kind === 'grid' ? gridText(n.grid) : n.body
        return {
          id,
          kind: n.kind,
          title: n.title,
          updatedAt: n.updatedAt,
          chars: text.length,
          ...(n.kind === 'grid' && n.grid ? { rows: n.grid.rows.length, cols: n.grid.rows[0]?.length ?? 0 } : {}),
          preview: (n.kind === 'grid' ? (n.grid?.rows ?? []).slice(0, 3).map((r) => r.filter(Boolean).join(' | ')).join(' · ') : text)
            .replace(/\s+/g, ' ').trim().slice(0, 140),
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

  /**
   * Whole-note save (the editor's autosave). Creates on first write.
   * Text notes send `body`; grid notes send `grid`. A note never changes kind once created —
   * a stale text editor PUTting `body` onto a grid would otherwise silently erase the table.
   */
  router.put('/api/notes/:id', json, async (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const { body, title, grid: rawGrid, kind: rawKind } = req.body ?? {}
    const wantKind: NoteKind = rawKind === 'grid' || rawGrid !== undefined ? 'grid' : 'text'
    let grid: Grid | undefined
    if (wantKind === 'grid') {
      const g = normaliseGrid(rawGrid ?? { rows: [['', '', ''], ['', '', ''], ['', '', '']] })
      if (typeof g === 'string') return res.status(400).json({ error: g })
      grid = g
    } else if (typeof body !== 'string') {
      return res.status(400).json({ error: 'body must be a string' })
    }
    try {
      const saved = await serialize(req.params.id, async () => {
        ensure()
        const existing = readNote(req.params.id)
        if (existing && existing.kind !== wantKind) {
          throw Object.assign(new Error(`"${req.params.id}" is a ${existing.kind} note; refusing to overwrite it as ${wantKind}`), { status: 409 })
        }
        const note: Note = {
          id: req.params.id,
          kind: wantKind,
          title: typeof title === 'string' && title.trim() ? title.trim() : existing?.title ?? req.params.id,
          body: wantKind === 'text' ? body : '',
          ...(grid ? { grid } : {}),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        writeFileSync(fileFor(req.params.id), JSON.stringify(note, null, 2), 'utf8')
        return note
      })
      res.json({ ok: true, ...saved, chars: saved.kind === 'grid' ? gridText(saved.grid).length : saved.body.length })
    } catch (e) {
      res.status((e as any)?.status ?? 500).json({ error: String((e as Error).message) })
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
        if (existing?.kind === 'grid') {
          throw Object.assign(new Error(`"${req.params.id}" is a grid note; dictation can only append to text notes`), { status: 409 })
        }
        const prev = existing?.body ?? ''
        // Join with a space mid-paragraph; respect a trailing newline the author left.
        const sep = !prev ? '' : /\s$/.test(prev) ? '' : ' '
        const note: Note = {
          id: req.params.id,
          kind: 'text',
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
      res.status((e as any)?.status ?? 500).json({ error: String((e as Error).message) })
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
    res.end(`${n.title}\n\n${n.kind === 'grid' ? gridText(n.grid) : n.body}\n`)
  })

  /** CSV download of a grid note — opens straight into Excel / LibreOffice / Sheets. */
  router.get('/api/notes/:id/file.csv', (req: Req, res: Res) => {
    const bad = badId(req.params.id)
    if (bad) return res.status(400).json({ error: bad })
    const n = readNote(req.params.id)
    if (!n) return res.status(404).json({ error: `no note named "${req.params.id}"` })
    if (n.kind !== 'grid' || !n.grid) return res.status(400).json({ error: `"${n.id}" is a text note; use file.txt` })
    const safe = n.title.replace(/[^A-Za-z0-9._ -]/g, '_').trim() || n.id
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`)
    res.setHeader('Cache-Control', 'no-store')
    // BOM so Excel reads UTF-8 instead of guessing a codepage.
    res.end('\ufeff' + toCsv(n.grid))
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
