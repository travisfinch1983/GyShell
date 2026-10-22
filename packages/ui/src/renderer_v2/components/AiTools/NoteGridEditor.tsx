import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, ClipboardCopy, Columns3, Redo2, Rows3, Undo2, X } from 'lucide-react'

/**
 * Grid note editor — a deliberately BASIC spreadsheet: a rectangle of text cells.
 *
 * Its one job is to hold information that is already a table without the formatting getting
 * mangled, so the important path is PASTE: copying a range out of Excel / Sheets / a web page
 * / a markdown table and dropping it on a cell lays it out cell-for-cell, growing the grid as
 * needed. No formulas, no types — every cell is a string, exactly what was pasted.
 *
 * Keyboard: Tab / Shift+Tab across, Enter / Shift+Enter down/up (Alt+Enter = newline inside a
 * cell), arrows move when the caret is at the edge of the cell, Ctrl+Z / Ctrl+Y undo/redo the
 * whole grid (cell-level native undo would not know about pastes or inserted rows).
 */

export interface GridData {
  rows: string[][]
  colWidths?: number[]
  header?: boolean
}

const DEFAULT_W = 150
const HISTORY_MAX = 100

const colName = (i: number): string => {
  let s = ''
  let n = i + 1
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}

const width = (g: GridData) => Math.max(1, ...g.rows.map((r) => r.length))

/** Pad every row to the same width — every operation below assumes a rectangle. */
const rect = (rows: string[][]): string[][] => {
  const w = Math.max(1, ...rows.map((r) => r.length))
  return rows.map((r) => (r.length === w ? r : [...r, ...Array(w - r.length).fill('')]))
}

/** Tab-separated text as Excel/Sheets put it on the clipboard (quoted cells may hold tabs/newlines). */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  const t = text.replace(/\r\n?/g, '\n')
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch
    } else if (ch === '"' && cell === '') q = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** `| a | b |` style markdown tables; the `|---|---|` separator row is dropped. */
function parseMarkdown(text: string): string[][] | null {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2 || !lines.every((l) => l.trim().startsWith('|'))) return null
  return lines
    .filter((l) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l))
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')))
}

/** An HTML <table> on the clipboard (copied from a web page) — the most faithful source when present. */
function parseHtmlTable(html: string): string[][] | null {
  if (!/<table[\s>]/i.test(html)) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return null
  const rows: string[][] = []
  table.querySelectorAll('tr').forEach((tr) => {
    const r: string[] = []
    tr.querySelectorAll('th,td').forEach((td) => {
      const text = ((td as HTMLElement).innerText ?? td.textContent ?? '').replace(/ /g, ' ').trim()
      r.push(text)
      // Expand colspan so later columns stay aligned with their headers.
      const span = Math.min(Number((td as HTMLTableCellElement).colSpan) || 1, 50)
      for (let k = 1; k < span; k++) r.push('')
    })
    if (r.length) rows.push(r)
  })
  return rows.length ? rows : null
}

/**
 * Decide whether a paste is a TABLE (lay out across cells) or plain text (normal paste into
 * one cell). Only clearly-tabular input is treated as a table: a sentence with a comma in it
 * must still paste as a sentence.
 */
export function parseClipboardTable(text: string, html?: string): string[][] | null {
  if (html) { const t = parseHtmlTable(html); if (t && (t.length > 1 || t[0].length > 1)) return t }
  if (!text) return null
  const md = parseMarkdown(text)
  if (md) return md
  const body = text.replace(/\r?\n$/, '')
  if (body.includes('\t')) return parseDelimited(body, '\t')
  const lines = body.split(/\r?\n/)
  if (lines.length >= 2) {
    const commas = lines.map((l) => parseDelimited(l, ',')[0]?.length ?? 1)
    if (commas[0] > 1 && commas.every((c) => c === commas[0])) return parseDelimited(body, ',')
    return lines.map((l) => [l]) // one value per line → one column
  }
  return null
}

const toTsv = (rows: string[][]) =>
  rows.map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t')).join('\n')

const toMarkdown = (rows: string[][]) => {
  if (!rows.length) return ''
  const esc = (c: string) => c.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
  const line = (r: string[]) => `| ${r.map(esc).join(' | ')} |`
  return [line(rows[0]), `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

interface Props {
  grid: GridData
  disabled?: boolean
  onChange: (g: GridData) => void
  onBlur?: () => void
  onStatus?: (msg: string) => void
}

export const NoteGridEditor: React.FC<Props> = ({ grid, disabled, onChange, onBlur, onStatus }) => {
  const [active, setActive] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  const cellRefs = useRef(new Map<string, HTMLTextAreaElement>())
  const past = useRef<GridData[]>([])
  const future = useRef<GridData[]>([])
  const editingCell = useRef<string>('') // the cell whose edit already has an undo snapshot
  const gridRef = useRef(grid)
  gridRef.current = grid

  const rows = grid.rows
  const nCols = width(grid)
  const header = grid.header !== false
  const widths = Array.from({ length: nCols }, (_, i) => grid.colWidths?.[i] ?? DEFAULT_W)

  // Undo history is per note: the parent remounts this editor (key=note id) on note switch.

  const commit = useCallback((next: GridData, snapshot = true) => {
    if (snapshot) {
      past.current.push(gridRef.current)
      if (past.current.length > HISTORY_MAX) past.current.shift()
      future.current = []
      editingCell.current = ''
    }
    onChange({ ...next, rows: rect(next.rows) })
  }, [onChange])

  const focusCell = useCallback((r: number, c: number, select = false) => {
    setActive({ r, c })
    requestAnimationFrame(() => {
      const el = cellRefs.current.get(`${r}:${c}`)
      if (el) { el.focus(); if (select) el.select() }
    })
  }, [])

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) { onStatus?.('nothing to undo'); return }
    future.current.push(gridRef.current)
    editingCell.current = ''
    onChange(prev)
  }, [onChange, onStatus])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) { onStatus?.('nothing to redo'); return }
    past.current.push(gridRef.current)
    editingCell.current = ''
    onChange(next)
  }, [onChange, onStatus])

  const setCell = (r: number, c: number, v: string) => {
    const key = `${r}:${c}`
    // One undo step per cell edit session, not per keystroke.
    const snapshot = editingCell.current !== key
    const next = rows.map((row) => row.slice())
    next[r][c] = v
    commit({ ...grid, rows: next }, snapshot)
    editingCell.current = key
  }

  const insertRow = (at: number) => {
    const next = rows.map((row) => row.slice())
    next.splice(at, 0, Array(nCols).fill(''))
    commit({ ...grid, rows: next })
    focusCell(at, active.c)
  }
  const deleteRow = (at: number) => {
    if (rows.length <= 1) { commit({ ...grid, rows: [Array(nCols).fill('')] }); return }
    commit({ ...grid, rows: rows.filter((_, i) => i !== at) })
    focusCell(Math.min(at, rows.length - 2), active.c)
  }
  const insertCol = (at: number) => {
    const w = widths.slice(); w.splice(at, 0, DEFAULT_W)
    commit({ ...grid, rows: rows.map((row) => { const n = row.slice(); n.splice(at, 0, ''); return n }), colWidths: w })
    focusCell(active.r, at)
  }
  const deleteCol = (at: number) => {
    if (nCols <= 1) { commit({ ...grid, rows: rows.map(() => ['']) }); return }
    commit({
      ...grid,
      rows: rows.map((row) => row.filter((_, i) => i !== at)),
      colWidths: widths.filter((_, i) => i !== at),
    })
    focusCell(active.r, Math.min(at, nCols - 2))
  }

  /** Lay a pasted table out from (r, c), growing the grid to fit. */
  const pasteTable = (r0: number, c0: number, table: string[][]) => {
    const next = rows.map((row) => row.slice())
    const needCols = Math.max(nCols, c0 + Math.max(...table.map((t) => t.length)))
    while (next.length < r0 + table.length) next.push([])
    for (const row of next) while (row.length < needCols) row.push('')
    table.forEach((tr, i) => tr.forEach((v, j) => { next[r0 + i][c0 + j] = v }))
    const w = widths.slice(); while (w.length < needCols) w.push(DEFAULT_W)
    commit({ ...grid, rows: next, colWidths: w })
    onStatus?.(`pasted ${table.length} × ${Math.max(...table.map((t) => t.length))}`)
  }

  const onPaste = (e: React.ClipboardEvent, r: number, c: number) => {
    const table = parseClipboardTable(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html'))
    if (!table) return // ordinary text: let the textarea paste it into this cell
    e.preventDefault()
    pasteTable(r, c, table)
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, r: number, c: number) => {
    const el = e.currentTarget
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) { if (c > 0) focusCell(r, c - 1, true); else if (r > 0) focusCell(r - 1, nCols - 1, true) }
      else if (c < nCols - 1) focusCell(r, c + 1, true)
      else if (r < rows.length - 1) focusCell(r + 1, 0, true)
      else { insertRow(rows.length); focusCell(rows.length, 0) }
      return
    }
    if (e.key === 'Enter' && e.altKey) {
      // Newline inside the cell.
      e.preventDefault()
      const { selectionStart: s, selectionEnd: t, value } = el
      setCell(r, c, value.slice(0, s) + '\n' + value.slice(t))
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 1 })
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) { if (r > 0) focusCell(r - 1, c, true) }
      else if (r < rows.length - 1) focusCell(r + 1, c, true)
      else { insertRow(rows.length); focusCell(rows.length, c) }
      return
    }
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
    const firstLine = !el.value.slice(0, el.selectionStart).includes('\n')
    const lastLine = !el.value.slice(el.selectionEnd).includes('\n')
    if (e.key === 'ArrowUp' && firstLine && r > 0) { e.preventDefault(); focusCell(r - 1, c) }
    else if (e.key === 'ArrowDown' && lastLine && r < rows.length - 1) { e.preventDefault(); focusCell(r + 1, c) }
    else if (e.key === 'ArrowLeft' && atStart && c > 0) { e.preventDefault(); focusCell(r, c - 1) }
    else if (e.key === 'ArrowRight' && atEnd && c < nCols - 1) { e.preventDefault(); focusCell(r, c + 1) }
  }

  // ── column resize ─────────────────────────────────────────────────────
  const drag = useRef<{ col: number; x: number; w: number } | null>(null)
  const [dragW, setDragW] = useState<{ col: number; w: number } | null>(null)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current
      if (!d) return
      setDragW({ col: d.col, w: Math.min(Math.max(d.w + e.clientX - d.x, 40), 1200) })
    }
    const up = () => {
      const d = drag.current
      drag.current = null
      setDragW((cur) => {
        if (d && cur) {
          const w = Array.from({ length: width(gridRef.current) }, (_, i) => gridRef.current.colWidths?.[i] ?? DEFAULT_W)
          w[cur.col] = cur.w
          commit({ ...gridRef.current, colWidths: w })
        }
        return null
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [commit])
  const colW = (i: number) => (dragW?.col === i ? dragW.w : widths[i])

  const copy = async (what: 'tsv' | 'md') => {
    try {
      await navigator.clipboard.writeText(what === 'tsv' ? toTsv(rows) : toMarkdown(rows))
      onStatus?.(what === 'tsv' ? 'copied — paste into Excel / Sheets' : 'copied as a markdown table')
    } catch (e: any) {
      onStatus?.(`copy failed: ${e?.message ?? e}`)
    }
  }

  const tb: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px',
    border: '1px solid var(--border)', borderRadius: 6, background: 'var(--control-bg)',
    color: 'var(--fg-muted)', fontSize: 11.5, cursor: disabled ? 'default' : 'pointer',
  }
  const sep = <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', margin: '0 2px' }} />
  const gutter: React.CSSProperties = {
    position: 'sticky', background: 'var(--control-bg)', color: 'var(--fg-faint)',
    fontSize: 10.5, fontWeight: 500, userSelect: 'none', border: '1px solid var(--border)',
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }} onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onBlur?.()
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--fg-faint)', marginRight: 2 }}><Rows3 size={12} style={{ verticalAlign: -2 }} /> Row {active.r + 1}</span>
        <button style={tb} disabled={disabled} onClick={() => insertRow(active.r)} title="Insert a row above"><ArrowUpToLine size={12} /></button>
        <button style={tb} disabled={disabled} onClick={() => insertRow(active.r + 1)} title="Insert a row below"><ArrowDownToLine size={12} /></button>
        <button style={tb} disabled={disabled} onClick={() => deleteRow(active.r)} title={`Delete row ${active.r + 1}`}><X size={12} /></button>
        {sep}
        <span style={{ fontSize: 11, color: 'var(--fg-faint)', marginRight: 2 }}><Columns3 size={12} style={{ verticalAlign: -2 }} /> Col {colName(active.c)}</span>
        <button style={tb} disabled={disabled} onClick={() => insertCol(active.c)} title="Insert a column to the left"><ArrowLeftToLine size={12} /></button>
        <button style={tb} disabled={disabled} onClick={() => insertCol(active.c + 1)} title="Insert a column to the right"><ArrowRightToLine size={12} /></button>
        <button style={tb} disabled={disabled} onClick={() => deleteCol(active.c)} title={`Delete column ${colName(active.c)}`}><X size={12} /></button>
        {sep}
        <label style={{ ...tb, gap: 5 }} title="Show the first row as a bold header">
          <input type="checkbox" checked={header} disabled={disabled} onChange={(e) => commit({ ...grid, header: e.target.checked })} style={{ margin: 0 }} />
          Header row
        </label>
        {sep}
        <button style={tb} disabled={disabled} onClick={undo} title="Undo (Ctrl+Z)"><Undo2 size={12} /></button>
        <button style={tb} disabled={disabled} onClick={redo} title="Redo (Ctrl+Y)"><Redo2 size={12} /></button>
        {sep}
        <button style={tb} onClick={() => void copy('tsv')} title="Copy the whole table — pastes cell-for-cell into Excel / Sheets"><ClipboardCopy size={12} /> Copy</button>
        <button style={tb} onClick={() => void copy('md')} title="Copy the whole table as a markdown table">MD</button>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-faint)' }}>
          {rows.length} × {nCols} · paste a table from Excel, Sheets, a web page, markdown or CSV onto any cell
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--app-bg)' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 13 }}>
          <colgroup>
            <col style={{ width: 44 }} />
            {widths.map((_, i) => <col key={i} style={{ width: colW(i) }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...gutter, top: 0, left: 0, zIndex: 3 }} />
              {widths.map((_, i) => (
                <th key={i} style={{ ...gutter, top: 0, zIndex: 2, position: 'sticky', padding: '3px 0', color: i === active.c ? 'var(--accent)' : gutter.color }}>
                  {colName(i)}
                  <span
                    onMouseDown={(e) => { if (disabled) return; e.preventDefault(); drag.current = { col: i, x: e.clientX, w: widths[i] }; setDragW({ col: i, w: widths[i] }) }}
                    style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 4 }}
                    title="Drag to resize"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <td style={{ ...gutter, left: 0, zIndex: 1, textAlign: 'center', color: r === active.r ? 'var(--accent)' : gutter.color }}>{r + 1}</td>
                {row.map((v, c) => {
                  const isHead = header && r === 0
                  const isActive = active.r === r && active.c === c
                  const lines = Math.min(v.split('\n').length, 8)
                  return (
                    <td key={c} style={{
                      border: '1px solid var(--border)', padding: 0, verticalAlign: 'top',
                      outline: isActive ? '2px solid var(--accent)' : 'none', outlineOffset: -2,
                      background: isHead ? 'color-mix(in srgb, var(--accent) 9%, var(--control-bg))' : 'transparent',
                    }}>
                      <textarea
                        ref={(el) => { const k = `${r}:${c}`; if (el) cellRefs.current.set(k, el); else cellRefs.current.delete(k) }}
                        value={v}
                        rows={lines}
                        disabled={disabled}
                        spellCheck={false}
                        onFocus={() => setActive({ r, c })}
                        onChange={(e) => setCell(r, c, e.target.value)}
                        onKeyDown={(e) => onKey(e, r, c)}
                        onPaste={(e) => onPaste(e, r, c)}
                        style={{
                          display: 'block', width: '100%', boxSizing: 'border-box', resize: 'none',
                          border: 0, outline: 'none', background: 'transparent', color: 'var(--fg)',
                          padding: '4px 6px', font: 'inherit', fontWeight: isHead ? 650 : 400,
                          lineHeight: 1.4, whiteSpace: 'pre-wrap', overflow: 'hidden',
                        }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
          <button style={tb} disabled={disabled} onClick={() => insertRow(rows.length)}>+ Row</button>
          <button style={tb} disabled={disabled} onClick={() => insertCol(nCols)}>+ Column</button>
        </div>
      </div>
    </div>
  )
}
