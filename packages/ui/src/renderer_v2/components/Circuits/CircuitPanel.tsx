import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FilePlus2, FolderOpen, Trash2, Undo2, Redo2, Maximize2, RotateCw, ShieldCheck, FileDown, Plus, Pencil, Copy, Search, X, Cpu, GitBranch, CornerDownRight, Slash,
} from 'lucide-react'
import { CircuitCanvas, type CanvasHandle, type Sel } from './CircuitCanvas'
import { PartEditor } from './PartEditor'
import { circuitApi, errText, isConflict } from './circuitApi'
import type { Design, DesignSummary, Finding, PartDef, View } from './circuitTypes'
import { WIRE_SWATCHES } from './circuitTypes'
import { partSize, pinLabel, type Pt } from './geometry'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Circuit.module.css'

const LAST_KEY = 'ai-lab-circuit-last'
const VIEW_KEY = 'ai-lab-circuit-view'
const clone = (d: Design): Design => JSON.parse(JSON.stringify(d))
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch (e) { console.warn('[circuits] localStorage', e) } }

/**
 * Circuit Designer (Diagrams → Circuit Designer). Breadboard-style editor over the shared
 * /api/circuits store. Agents edit the same designs through the ailab-circuits MCP server; the
 * open editor polls the design's version and reloads when someone else wrote it.
 */
export function CircuitPanel() {
  const [library, setLibrary] = useState<PartDef[]>([])
  const [libError, setLibError] = useState<string | null>(null)
  const parts = useMemo(() => new Map(library.map((p) => [p.id, p])), [library])
  const [design, setDesign] = useState<Design | null>(null)
  const [view, setView] = useState<View>(() => (lsGet(VIEW_KEY) === 'sch' ? 'sch' : 'bb'))
  const [sel, setSel] = useState<Sel>(null)
  const [findings, setFindings] = useState<Finding[] | null>(null)
  const [highlight, setHighlight] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [showOpen, setShowOpen] = useState(false)
  const [designs, setDesigns] = useState<DesignSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [exportText, setExportText] = useState<{ format: string; text: string } | null>(null)
  const [editor, setEditor] = useState<{ part: Partial<PartDef> | null; isNew: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const designRef = useRef<Design | null>(null); designRef.current = design
  const baseRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undoRef = useRef<Design[]>([])
  const redoRef = useRef<Design[]>([])
  const [, bump] = useState(0)
  const canvas = useRef<CanvasHandle | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const flash = (m: string) => { setStatus(m); setTimeout(() => setStatus((s) => (s === m ? '' : s)), 1800) }

  // ── library ──
  const loadLibrary = useCallback(async () => {
    try { setLibrary(await circuitApi.parts()); setLibError(null) } catch (e) { setLibError(errText(e)) }
  }, [])
  useEffect(() => { loadLibrary() }, [loadLibrary])

  // ── open / save ──
  const openDesign = useCallback(async (id: string) => {
    try {
      const d = await circuitApi.load(id)
      baseRef.current = d.updatedAt ?? null
      dirtyRef.current = false
      undoRef.current = []; redoRef.current = []
      setDesign(d); setSel(null); setFindings(null); setHighlight(new Set()); setConflict(null); setSaveError(null)
      lsSet(LAST_KEY, d.id)
      setShowOpen(false)
    } catch (e) {
      setListError(`could not open '${id}' — ${errText(e)}`)
      throw e
    }
  }, [])

  useEffect(() => {
    const last = lsGet(LAST_KEY)
    if (last) openDesign(last).catch(() => { setShowOpen(true); refreshList() })
    else { setShowOpen(true); refreshList() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doSave = useCallback(async () => {
    const d = designRef.current
    if (!d || !dirtyRef.current || savingRef.current) return
    savingRef.current = true
    dirtyRef.current = false
    try {
      const r = await circuitApi.save(d, baseRef.current)
      baseRef.current = r.design.updatedAt ?? null
      setSaveError(null)
      if (r.warnings.length) setStatus(`Saved — ${r.warnings.length} warning(s): ${r.warnings[0]}`)
      else flash('Saved')
    } catch (e) {
      dirtyRef.current = true
      if (isConflict(e)) setConflict('Someone else (an agent, or another tab) changed this circuit while you were editing. Your edits are still here and NOT saved.')
      else setSaveError(`not saving — ${errText(e)}`)
    } finally {
      savingRef.current = false
    }
  }, [])
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { saveTimer.current = null; doSave() }, 700)
  }, [doSave])
  const flushSave = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    await doSave()
  }, [doSave])

  /** Every edit goes through here. push = record an undo step. */
  const change = useCallback((next: Design, push = true) => {
    const cur = designRef.current
    if (push && cur) { undoRef.current.push(clone(cur)); if (undoRef.current.length > 200) undoRef.current.shift(); redoRef.current = [] }
    designRef.current = next
    setDesign(next)
    dirtyRef.current = true
    scheduleSave()
    bump((n) => n + 1)
  }, [scheduleSave])
  const beginEdit = useCallback(() => {
    const cur = designRef.current
    if (cur) { undoRef.current.push(clone(cur)); redoRef.current = []; bump((n) => n + 1) }
  }, [])
  const undo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (!prev || !designRef.current) return
    redoRef.current.push(clone(designRef.current))
    change(prev, false)
  }, [change])
  const redo = useCallback(() => {
    const nxt = redoRef.current.pop()
    if (!nxt || !designRef.current) return
    undoRef.current.push(clone(designRef.current))
    change(nxt, false)
  }, [change])

  // ── live refresh: agents write through the API; pick their edits up ──
  useEffect(() => {
    if (!design?.id) return
    const id = design.id
    let stop = false
    const t = setInterval(async () => {
      if (stop || savingRef.current) return
      try {
        const v = await circuitApi.version(id)
        if (stop || designRef.current?.id !== id || !v.updatedAt || v.updatedAt === baseRef.current) return
        if (dirtyRef.current || saveTimer.current) {
          setConflict(`This circuit was changed by ${v.by ?? 'someone else'} while you have unsaved edits.`)
          return
        }
        const d = await circuitApi.load(id)
        if (stop || designRef.current?.id !== id || dirtyRef.current) return
        baseRef.current = d.updatedAt ?? null
        undoRef.current.push(clone(designRef.current!))
        setDesign(d)
        flash(`Updated by ${v.by ?? 'another editor'}`)
      } catch (e) {
        // a missing design (deleted elsewhere) or a backend restart: say so, keep the canvas
        setSaveError(`live refresh failed — ${errText(e)}`)
      }
    }, 2000)
    return () => { stop = true; clearInterval(t) }
  }, [design?.id])

  // ── designs list ──
  const refreshList = useCallback(async () => {
    setListError(null)
    try { setDesigns(await circuitApi.list()) } catch (e) { setDesigns(null); setListError(errText(e)) }
  }, [])
  const newDesign = useCallback(async () => {
    try {
      await flushSave()
      const d = await circuitApi.create('Untitled circuit')
      await openDesign(d.id)
    } catch (e) { setListError(`could not create — ${errText(e)}`); setShowOpen(true) }
  }, [flushSave, openDesign])
  const deleteDesign = useCallback(async (s: DesignSummary) => {
    const ok = await confirmStore.confirm({ title: 'Delete circuit?', message: `"${s.name}" moves to the circuits trash folder on the server.`, confirmText: 'Delete', danger: true })
    if (!ok) return
    try {
      await circuitApi.remove(s.id)
      if (designRef.current?.id === s.id) { setDesign(null); lsSet(LAST_KEY, '') }
      refreshList()
    } catch (e) { setListError(`delete failed — ${errText(e)}`) }
  }, [refreshList])

  // ── conflict resolution ──
  const takeTheirs = useCallback(async () => {
    if (!designRef.current) return
    dirtyRef.current = false
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    await openDesign(designRef.current.id).catch(() => undefined)
  }, [openDesign])
  const keepMine = useCallback(async () => {
    if (!designRef.current) return
    try {
      const v = await circuitApi.version(designRef.current.id)
      baseRef.current = v.updatedAt
      dirtyRef.current = true
      setConflict(null)
      await doSave()
    } catch (e) { setSaveError(errText(e)) }
  }, [doSave])

  // ── editing helpers ──
  const addPart = useCallback((partId: string, at?: Pt) => {
    const d = designRef.current
    const def = parts.get(partId)
    if (!d || !def) return
    const used = new Set(d.parts.map((p) => p.ref))
    let i = 1; while (used.has(`${def.refPrefix}${i}`)) i++
    const ref = `${def.refPrefix}${i}`
    const c = at ?? canvas.current?.center() ?? { x: 40, y: 40 }
    const sz = partSize(def, view)
    const pos = at ? c : { x: Math.round((c.x - sz.w / 2) / 10) * 10, y: Math.round((c.y - sz.h / 2) / 10) * 10 }
    const other = view === 'bb' ? 'sch' : 'bb'
    // the other view gets a spot to the right of everything there
    let maxX = 0
    for (const p of d.parts) maxX = Math.max(maxX, p[other].x + partSize(parts.get(p.partId), other).w)
    const otherPos = { x: d.parts.length ? Math.ceil((maxX + 40) / 10) * 10 : 40, y: 40, rot: 0 }
    const next = clone(d)
    next.parts.push({ ref, partId, [view]: { x: pos.x, y: pos.y, rot: 0 }, [other]: otherPos } as any)
    change(next)
    setSel({ kind: 'part', ref })
  }, [parts, view, change])

  const deleteSelection = useCallback(() => {
    const d = designRef.current
    if (!d || !sel) return
    const next = clone(d)
    if (sel.kind === 'part') {
      next.parts = next.parts.filter((p) => p.ref !== sel.ref)
      next.wires = next.wires.filter((w) => w.from.ref !== sel.ref && w.to.ref !== sel.ref)
    } else next.wires = next.wires.filter((w) => w.id !== sel.id)
    change(next)
    setSel(null)
  }, [sel, change])

  const rotateSel = useCallback((dir = 1) => {
    const d = designRef.current
    if (!d || sel?.kind !== 'part') return
    const next = clone(d)
    const p = next.parts.find((q) => q.ref === sel.ref)
    if (!p) return
    p[view].rot = (((p[view].rot + 90 * dir) % 360) + 360) % 360
    change(next)
  }, [sel, view, change])

  const updatePart = useCallback((ref: string, fn: (p: Design['parts'][number], d: Design) => void) => {
    const d = designRef.current
    if (!d) return
    const next = clone(d)
    const p = next.parts.find((q) => q.ref === ref)
    if (!p) return
    fn(p, next)
    change(next)
  }, [change])
  const updateWire = useCallback((id: string, fn: (w: Design['wires'][number]) => void) => {
    const d = designRef.current
    if (!d) return
    const next = clone(d)
    const w = next.wires.find((q) => q.id === id)
    if (!w) return
    fn(w)
    change(next)
  }, [change])

  const runCheck = useCallback(async () => {
    const d = designRef.current
    if (!d) return
    try {
      const r = await circuitApi.check(d)
      setFindings(r.findings)
      setSel(null)
      setHighlight(new Set(r.findings.filter((f) => f.level === 'error').flatMap((f) => f.refs)))
    } catch (e) { setSaveError(`check failed — ${errText(e)}`) }
  }, [])

  const doExport = useCallback(async (format: string) => {
    const d = designRef.current
    if (!d) return
    try {
      await flushSave()
      setExportText({ format, text: await circuitApi.exportText(d.id, format) })
    } catch (e) { setSaveError(`export failed — ${errText(e)}`) }
  }, [flushSave])

  // ── keyboard (only while the editor has focus, so text fields keep their keys) ──
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
    if (e.key === 'Escape') { canvas.current?.cancelWiring(); setSel(null); setHighlight(new Set()); return }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return }
    if (e.key.toLowerCase() === 'r' && !mod) { rotateSel(e.shiftKey ? -1 : 1); return }
    if (e.key.toLowerCase() === 'f' && !mod) { canvas.current?.fit(); return }
  }

  const setViewPersist = (v: View) => { setView(v); lsSet(VIEW_KEY, v) }

  // ── palette ──
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? library.filter((p) => [p.name, p.id, p.category, ...(p.tags ?? []), p.description ?? ''].join(' ').toLowerCase().includes(q))
      : library
    const cats = new Map<string, PartDef[]>()
    for (const p of list) cats.set(p.category, [...(cats.get(p.category) ?? []), p])
    return [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [library, query])

  const selPart = sel?.kind === 'part' ? design?.parts.find((p) => p.ref === sel.ref) : undefined
  const selPartDef = selPart ? parts.get(selPart.partId) : undefined
  const selWire = sel?.kind === 'wire' ? design?.wires.find((w) => w.id === sel.id) : undefined

  return (
    <div className={styles.panel} ref={wrapRef} tabIndex={-1} onKeyDown={onKey}>
      <div className={styles.toolbar}>
        <input
          className={styles.nameInput} value={design?.name ?? ''} disabled={!design} placeholder="Circuit name"
          onChange={(e) => design && change({ ...clone(design), name: e.target.value }, false)}
        />
        <button className={styles.btn} onClick={newDesign} title="New circuit"><FilePlus2 size={13} /> New</button>
        <button className={styles.btn} onClick={() => { setShowOpen(true); refreshList() }} title="Open a saved circuit"><FolderOpen size={13} /> Open</button>
        <span className={styles.sep} />
        <div className={styles.seg}>
          <button className={`${styles.segBtn} ${view === 'bb' ? styles.segOn : ''}`} onClick={() => setViewPersist('bb')} title="Breadboard view"><Cpu size={13} /> Breadboard</button>
          <button className={`${styles.segBtn} ${view === 'sch' ? styles.segOn : ''}`} onClick={() => setViewPersist('sch')} title="Schematic view"><GitBranch size={13} /> Schematic</button>
        </div>
        <span className={styles.sep} />
        <button className={styles.iconBtn} onClick={undo} disabled={!undoRef.current.length} title="Undo (Ctrl+Z)"><Undo2 size={14} /></button>
        <button className={styles.iconBtn} onClick={redo} disabled={!redoRef.current.length} title="Redo (Ctrl+Shift+Z)"><Redo2 size={14} /></button>
        <button className={styles.iconBtn} onClick={() => canvas.current?.fit()} disabled={!design} title="Fit to view (F)"><Maximize2 size={14} /></button>
        {view === 'bb' && design && (
          <button
            className={styles.btn}
            onClick={() => change({ ...clone(design), wireStyle: design.wireStyle === 'straight' ? 'orthogonal' : 'straight' })}
            title="How breadboard wires are drawn: square corners (tidy) or straight lines between bends"
          >
            {design.wireStyle === 'straight' ? <><Slash size={13} /> Straight wires</> : <><CornerDownRight size={13} /> Square wires</>}
          </button>
        )}
        <span className={styles.sep} />
        <button className={styles.btn} onClick={runCheck} disabled={!design} title="Check the design for wiring mistakes">
          <ShieldCheck size={13} /> Check{findings ? ` (${findings.filter((f) => f.level !== 'info').length})` : ''}
        </button>
        <select className={styles.select} value="" disabled={!design} onChange={(e) => { if (e.target.value) doExport(e.target.value) }} title="Export">
          <option value="">Export…</option>
          <option value="netlist">Netlist</option>
          <option value="bom">Parts list (BOM)</option>
          <option value="esphome">ESPHome pins</option>
          <option value="arduino">Arduino #defines</option>
        </select>
        <span className={styles.spacer} />
        {saveError && <span className={styles.saveError} title={saveError}>⚠ {saveError}</span>}
        {status && <span className={styles.dim}>{status}</span>}
      </div>

      {conflict && (
        <div className={styles.conflict}>
          <span>⚠ {conflict}</span>
          <button className={styles.btn} onClick={takeTheirs}>Load their version (drop my edits)</button>
          <button className={styles.btn} onClick={keepMine}>Keep mine (overwrite theirs)</button>
        </div>
      )}

      <div className={styles.body}>
        {/* ── parts palette ── */}
        <div className={styles.palette}>
          <div className={styles.searchRow}>
            <Search size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search parts, pins…" />
            {query && <button className={styles.iconBtnSm} onClick={() => setQuery('')}><X size={12} /></button>}
          </div>
          <button className={styles.btn} onClick={() => setEditor({ part: null, isNew: true })}><Plus size={13} /> New part</button>
          {libError && <div className={styles.saveError}>parts library failed to load — {libError} <button className={styles.linkBtn} onClick={loadLibrary}>retry</button></div>}
          {!libError && !library.length && <div className={styles.dim}>Loading parts…</div>}
          {filtered.map(([cat, list]) => (
            <div key={cat} className={styles.cat}>
              <button className={styles.catHead} onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(cat) ? n.delete(cat) : n.add(cat); return n })}>
                {collapsed.has(cat) && !query ? '▸' : '▾'} {cat} <span className={styles.dim}>{list.length}</span>
              </button>
              {(!collapsed.has(cat) || query) && list.map((p) => (
                <div
                  key={p.id} className={styles.partItem} draggable
                  onDragStart={(e) => { e.dataTransfer.setData('application/x-circuit-part', p.id); e.dataTransfer.effectAllowed = 'copy' }}
                  onClick={() => design && addPart(p.id)}
                  title={`${p.description ?? p.name}\n\nClick to add at the centre, or drag onto the canvas.`}
                >
                  <span className={styles.partName}>{p.name}</span>
                  {p.source === 'custom' && <span className={styles.badge}>custom</span>}
                  <button className={styles.iconBtnSm} title={p.source === 'custom' ? 'Edit part' : 'Copy as a new custom part'}
                    onClick={(e) => { e.stopPropagation(); setEditor(p.source === 'custom' ? { part: p, isNew: false } : { part: { ...p, id: undefined, name: `${p.name} (copy)`, source: 'custom' }, isNew: true }) }}>
                    {p.source === 'custom' ? <Pencil size={11} /> : <Copy size={11} />}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* ── canvas ── */}
        <div className={styles.canvas}>
          {design ? (
            <CircuitCanvas
              design={design} parts={parts} view={view} selection={sel} highlight={highlight}
              onSelect={(s) => { setSel(s); if (s) setHighlight(new Set()) }}
              onChange={change} onBeginEdit={beginEdit}
              onDropPart={(id, at) => addPart(id, at)}
              handleRef={(h) => { canvas.current = h }}
              onStatus={flash}
            />
          ) : (
            <div className={styles.empty}>
              <div>No circuit open.</div>
              <button className={styles.btn} onClick={newDesign}><FilePlus2 size={13} /> New circuit</button>
              <button className={styles.btn} onClick={() => { setShowOpen(true); refreshList() }}><FolderOpen size={13} /> Open…</button>
            </div>
          )}
          {design && !design.parts.length && (
            <div className={styles.hint}>Click or drag parts from the left to place them. Click a pin, then another pin, to wire them. Click empty space while wiring to add a bend.</div>
          )}
        </div>

        {/* ── inspector ── */}
        <div className={styles.props}>
          {selPart && (
            <>
              <div className={styles.propsHead}>Part {selPart.ref}</div>
              <div className={styles.partTitle}>{selPartDef?.name ?? `missing part: ${selPart.partId}`}</div>
              {selPartDef?.description && <div className={styles.dim}>{selPartDef.description}</div>}
              <label className={styles.field}>Reference
                <input defaultValue={selPart.ref} key={`ref-${selPart.ref}`} onBlur={(e) => {
                  const nr = e.target.value.trim()
                  if (!nr || nr === selPart.ref) return
                  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(nr) || design!.parts.some((p) => p.ref === nr)) { e.target.value = selPart.ref; flash('Reference must be unique, letters/numbers'); return }
                  const old = selPart.ref
                  updatePart(old, (p, d) => { p.ref = nr; for (const w of d.wires) { if (w.from.ref === old) w.from.ref = nr; if (w.to.ref === old) w.to.ref = nr } })
                  setSel({ kind: 'part', ref: nr })
                }} />
              </label>
              <label className={styles.field}>Label
                <input value={selPart.label ?? ''} placeholder="e.g. Bedroom sensor" onChange={(e) => updatePart(selPart.ref, (p) => { p.label = e.target.value || undefined })} />
              </label>
              <label className={styles.field}>Value
                <input value={selPart.props?.value ?? ''} placeholder={String(selPartDef?.props?.value ?? 'e.g. 10k, 100nF')} onChange={(e) => updatePart(selPart.ref, (p) => { p.props = { ...(p.props ?? {}) }; if (e.target.value) p.props.value = e.target.value; else delete p.props.value })} />
              </label>
              {Array.isArray(selPartDef?.props?.i2cAddress) && (
                <label className={styles.field}>I²C address
                  <select value={selPart.props?.i2cAddress ?? ''} onChange={(e) => updatePart(selPart.ref, (p) => { p.props = { ...(p.props ?? {}) }; if (e.target.value) p.props.i2cAddress = e.target.value; else delete p.props.i2cAddress })}>
                    <option value="">any of {(selPartDef!.props!.i2cAddress as string[]).join(' / ')}</option>
                    {(selPartDef!.props!.i2cAddress as string[]).map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
              )}
              <div className={styles.row}>
                <button className={styles.btn} onClick={() => rotateSel(1)}><RotateCw size={13} /> Rotate (R)</button>
                <button className={styles.btnDanger} onClick={deleteSelection}><Trash2 size={13} /> Delete</button>
              </div>
              {selPartDef && (
                <>
                  <div className={styles.propsHead}>Pins</div>
                  <div className={styles.pinList}>
                    {selPartDef.pins.map((pin) => {
                      const links = design!.wires.filter((w) => (w.from.ref === selPart.ref && w.from.pin === pin.id) || (w.to.ref === selPart.ref && w.to.pin === pin.id))
                        .map((w) => (w.from.ref === selPart.ref && w.from.pin === pin.id ? w.to : w.from))
                      return (
                        <div key={pin.id} className={styles.pinRow} title={[pin.functions?.join(', '), pin.notes].filter(Boolean).join('\n')}>
                          <span className={styles.pinName}>{pinLabel(pin)}</span>
                          {pin.flags?.length ? <span className={styles.flag}>⚠</span> : null}
                          <span className={styles.dim}>{links.map((l) => `${l.ref}.${l.pin}`).join(', ')}</span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </>
          )}

          {selWire && (
            <>
              <div className={styles.propsHead}>Wire</div>
              <div className={styles.partTitle}>{selWire.from.ref}.{selWire.from.pin} → {selWire.to.ref}.{selWire.to.pin}</div>
              <div className={styles.field}>Colour
                <div className={styles.swatches}>
                  {WIRE_SWATCHES.map((c) => (
                    <button key={c} className={`${styles.swatch} ${selWire.color === c ? styles.swatchOn : ''}`} style={{ background: c }} onClick={() => updateWire(selWire.id, (w) => { w.color = c })} />
                  ))}
                </div>
              </div>
              <label className={styles.field}>Net name
                <input value={selWire.label ?? ''} placeholder="e.g. I2C_SDA" onChange={(e) => updateWire(selWire.id, (w) => { w.label = e.target.value || undefined })} />
              </label>
              <div className={styles.row}>
                <button className={styles.btn} onClick={() => updateWire(selWire.id, (w) => { if (view === 'bb') delete w.bbPoints; else delete w.schPoints })} title="Go back to the automatic route">Reset route</button>
                <button className={styles.btnDanger} onClick={deleteSelection}><Trash2 size={13} /> Delete</button>
              </div>
              <div className={styles.dim}>{design?.wireStyle === 'straight' && view === 'bb'
                ? <>Reroute: drag the wire (or a <b>+</b> handle) to pull out a bend, drag a bend to move it, right-click or double-click a bend to remove it.</>
                : <>Reroute: drag any straight run of the wire to slide it sideways. New corners appear where it meets a pin; runs that line up merge back together.</>}</div>
            </>
          )}

          {!sel && design && (
            <>
              <div className={styles.propsHead}>Circuit</div>
              <label className={styles.field}>Description
                <textarea rows={3} value={design.description ?? ''} onChange={(e) => change({ ...clone(design), description: e.target.value || undefined }, false)} />
              </label>
              <label className={styles.field}>Notes
                <textarea rows={5} value={design.notes ?? ''} onChange={(e) => change({ ...clone(design), notes: e.target.value || undefined }, false)} />
              </label>
              <div className={styles.dim}>{design.parts.length} parts · {design.wires.length} wires{design.updatedBy ? ` · last saved by ${design.updatedBy}` : ''}</div>
              {findings && (
                <>
                  <div className={styles.propsHead}>Check results</div>
                  {!findings.length && <div className={styles.ok}>No problems found.</div>}
                  {findings.map((f, i) => (
                    <button key={i} className={`${styles.finding} ${styles[`f_${f.level}`]}`} onClick={() => setHighlight(new Set(f.refs))}>
                      <b>{f.level}</b> {f.message}
                    </button>
                  ))}
                </>
              )}
              <div className={styles.keys}>
                <div><b>Click pin → pin</b> wire · <b>drag a wire</b> to reroute it</div>
                <div><b>R</b> rotate · <b>Del</b> delete · <b>F</b> fit</div>
                <div><b>Ctrl+Z / Ctrl+Shift+Z</b> undo / redo</div>
                <div><b>Drag empty space</b> pan · <b>wheel</b> zoom</div>
              </div>
            </>
          )}
        </div>
      </div>

      {showOpen && (
        <div className={styles.modalBg} onClick={() => design && setShowOpen(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>Circuits</div>
            {listError && <div className={styles.saveError}>{listError}</div>}
            {!listError && designs === null && <div className={styles.dim}>Loading…</div>}
            {designs && designs.length === 0 && <div className={styles.dim}>No circuits yet.</div>}
            {designs?.map((s) => (
              <div key={s.id} className={styles.savedRow}>
                <button className={styles.savedName} onClick={() => { flushSave().finally(() => openDesign(s.id).catch(() => undefined)) }}>
                  {s.name} <span className={styles.dim}>· {s.parts} parts · {s.wires} wires</span>
                </button>
                <span className={styles.dim}>{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}</span>
                <button className={styles.savedDel} title="Delete" onClick={() => deleteDesign(s)}><Trash2 size={12} /></button>
              </div>
            ))}
            <div className={styles.row} style={{ marginTop: 10 }}>
              <button className={styles.btn} onClick={newDesign}><FilePlus2 size={13} /> New circuit</button>
              {design && <button className={styles.btn} onClick={() => setShowOpen(false)}>Close</button>}
            </div>
          </div>
        </div>
      )}

      {exportText && (
        <div className={styles.modalBg} onClick={() => setExportText(null)}>
          <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>Export — {exportText.format}</div>
            <textarea className={styles.exportBox} readOnly value={exportText.text} onFocus={(e) => e.target.select()} />
            <div className={styles.row} style={{ marginTop: 8 }}>
              <button className={styles.btn} onClick={async () => {
                try { await navigator.clipboard.writeText(exportText.text); flash('Copied') } catch { flash('Copy blocked by the browser — select the text and Ctrl+C') }
              }}><FileDown size={13} /> Copy</button>
              <button className={styles.btn} onClick={() => setExportText(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <PartEditor
          initial={editor.part}
          isNew={editor.isNew}
          onClose={() => setEditor(null)}
          onSaved={async (p) => { setEditor(null); await loadLibrary(); flash(`Saved part ${p.name}`) }}
          onDeleted={async (id, usedBy) => {
            setEditor(null); await loadLibrary()
            flash(usedBy.length ? `Deleted ${id} — still used in: ${usedBy.join(', ')}` : `Deleted ${id}`)
          }}
        />
      )}
    </div>
  )
}
