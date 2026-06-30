import React, { useEffect, useMemo, useState } from 'react'
import { Plus, Settings, Trash2, Save, X, ChevronLeft, ChevronRight, Code2, RotateCcw } from 'lucide-react'
import { confirmStore } from '../../stores/confirmStore'
import { promptStore } from '../../stores/promptStore'
import { DYNACAT_WIDGETS, DYNACAT_COLUMN_OPTIONS, DYNACAT_PAGE_OPTIONS, findWidgetDef } from './dynacatCatalog'
import { DcFieldForm } from './DcFieldForm'

/**
 * Visual GUI builder for the Dynacat dashboard config (Home tab).
 * Edits the structured JSON (pages → columns → widgets) round-tripped via /api/dynacat/config-parsed
 * (YAML↔JSON on the backend, with `config:validate` before save). Widgets render as labelled squares
 * with a gear (config popup, fields generated from the widget catalog) — not 1:1 with the live dashboard.
 * Non-page top-level keys (server/theme/etc.) are preserved untouched on save (edit them via Raw YAML).
 */
type Widget = Record<string, unknown> & { type: string }
type Column = { size?: string; widgets?: Widget[] } & Record<string, unknown>
type Page = { name: string; slug?: string; columns?: Column[] } & Record<string, unknown>
type Config = { pages?: Page[] } & Record<string, unknown>

const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 9px',
  border: '1px solid var(--border)', borderRadius: 6, background: 'var(--control-bg)', color: 'var(--fg)', cursor: 'pointer',
}
const iconBtn: React.CSSProperties = { ...btn, padding: '3px 6px' }
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 600 }

export const DynacatBuilder: React.FC<{ onClose: () => void; onSaved: () => void; openRaw: () => void }> = ({ onClose, onSaved, openRaw }) => {
  const [config, setConfig] = useState<Config>({ pages: [] })
  const [manual, setManual] = useState(false)
  const [pageIdx, setPageIdx] = useState(0)
  const [gear, setGear] = useState<{ col: number; w: number } | null>(null)
  const [picker, setPicker] = useState<{ col: number } | null>(null)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pageSettings, setPageSettings] = useState(false)
  const [drag, setDrag] = useState<{ col: number; w: number } | null>(null)
  const [status, setStatus] = useState('Loading…')
  const [busy, setBusy] = useState(false)

  const pages = config.pages || []
  const page = pages[pageIdx]
  const cols = page?.columns || []

  useEffect(() => { void load() }, [])

  const load = async () => {
    setStatus('Loading…')
    try {
      const r = await fetch('/api/dynacat/config-parsed').then((x) => x.json())
      const cfg: Config = r.config && typeof r.config === 'object' ? r.config : { pages: [] }
      if (!Array.isArray(cfg.pages)) cfg.pages = []
      setConfig(cfg); setManual(!!r.manualOverride); setPageIdx(0); setStatus('')
    } catch (e: any) { setStatus('Load failed: ' + (e?.message || e)) }
  }

  // ---- immutable mutators ----
  const commit = (mut: (c: Config) => void) => {
    setConfig((prev) => { const next = JSON.parse(JSON.stringify(prev)) as Config; if (!next.pages) next.pages = []; mut(next); return next })
  }
  const addPage = async () => {
    const name = await promptStore.prompt({ title: 'New page', label: 'Page name', placeholder: 'e.g. Media' })
    if (!name) return
    commit((c) => { c.pages!.push({ name, columns: [{ size: 'full', widgets: [] }] }) })
    setPageIdx(pages.length)
  }
  const renamePage = async (i: number) => {
    const name = await promptStore.prompt({ title: 'Rename page', label: 'Page name', defaultValue: pages[i]?.name || '' })
    if (!name) return
    commit((c) => { c.pages![i].name = name })
  }
  const deletePage = async (i: number) => {
    if (!(await confirmStore.confirm({ title: 'Delete page?', message: `Delete page "${pages[i]?.name}" and all its widgets?`, confirmText: 'Delete', danger: true }))) return
    commit((c) => { c.pages!.splice(i, 1) })
    setPageIdx((p) => Math.max(0, Math.min(p, pages.length - 2)))
  }
  const movePage = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= pages.length) return
    commit((c) => { const a = c.pages!; [a[i], a[j]] = [a[j], a[i]] }); setPageIdx(j)
  }
  const updatePage = (next: Record<string, unknown>) => commit((c) => { c.pages![pageIdx] = { ...(next as Page) } })
  const addColumn = () => commit((c) => { (c.pages![pageIdx].columns ||= []).push({ size: 'full', widgets: [] }) })
  const deleteColumn = async (col: number) => {
    if (!(await confirmStore.confirm({ title: 'Delete column?', message: 'Delete this column and its widgets?', confirmText: 'Delete', danger: true }))) return
    commit((c) => { c.pages![pageIdx].columns!.splice(col, 1) })
  }
  const setColSize = (col: number, size: string) => commit((c) => { c.pages![pageIdx].columns![col].size = size })
  const moveColumn = (col: number, d: -1 | 1) => {
    const j = col + d; if (j < 0 || j >= cols.length) return
    commit((c) => { const a = c.pages![pageIdx].columns!; [a[col], a[j]] = [a[j], a[col]] })
  }
  const addWidget = (col: number, type: string) => {
    commit((c) => { (c.pages![pageIdx].columns![col].widgets ||= []).push({ type }) })
    setPicker(null); setPickerQuery('')
  }
  const deleteWidget = (col: number, w: number) => commit((c) => { c.pages![pageIdx].columns![col].widgets!.splice(w, 1) })
  const updateWidget = (col: number, w: number, next: Record<string, unknown>) =>
    commit((c) => { c.pages![pageIdx].columns![col].widgets![w] = { ...(next as Widget) } })

  const dropOnColumn = (toCol: number, toIdx: number | null) => {
    if (!drag) return
    commit((c) => {
      const colsArr = c.pages![pageIdx].columns!
      const fromArr = colsArr[drag.col].widgets || (colsArr[drag.col].widgets = [])
      const [moved] = fromArr.splice(drag.w, 1)
      if (!moved) return
      const toArr = colsArr[toCol].widgets || (colsArr[toCol].widgets = [])
      let idx = toIdx == null ? toArr.length : toIdx
      if (drag.col === toCol && drag.w < idx) idx -= 1
      toArr.splice(idx, 0, moved)
    })
    setDrag(null)
  }

  const save = async () => {
    setBusy(true); setStatus('Validating + saving…')
    try {
      const res = await fetch('/api/dynacat/config-parsed', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
      })
      const r = await res.json()
      if (!res.ok || r.ok === false) { setStatus('✗ ' + (r.error || `HTTP ${res.status}`)); return }
      setManual(true); setStatus('✓ Saved — dashboard reloaded (manual mode on)'); onSaved()
    } catch (e: any) { setStatus('Save failed: ' + (e?.message || e)) } finally { setBusy(false) }
  }

  const gearWidget = gear ? cols[gear.col]?.widgets?.[gear.w] : null
  const gearDef = gearWidget ? findWidgetDef(gearWidget.type) : undefined
  const filteredWidgets = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    return q ? DYNACAT_WIDGETS.filter((w) => w.type.includes(q) || w.label.toLowerCase().includes(q)) : DYNACAT_WIDGETS
  }, [pickerQuery])

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--app-bg)', display: 'flex', flexDirection: 'column', zIndex: 5 }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
        <strong style={{ fontSize: 12.5 }}>Dashboard Builder</strong>
        <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--border)', color: manual ? 'var(--accent)' : 'var(--fg-faint)' }}>
          {manual ? 'manual config' : 'auto-generated'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', maxWidth: 360, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</span>
        <button style={btn} onClick={openRaw} title="Edit raw YAML (incl. server/theme)"><Code2 size={13} /> Raw YAML</button>
        <button style={primaryBtn} disabled={busy} onClick={() => void save()}><Save size={13} /> Validate &amp; Save</button>
        <button style={iconBtn} onClick={onClose} title="Close builder"><X size={14} /></button>
      </div>

      {/* page tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {pages.map((p, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px 3px 10px', borderRadius: 7, cursor: 'pointer',
            border: '1px solid var(--border)', background: i === pageIdx ? 'var(--accent)' : 'var(--control-bg)', color: i === pageIdx ? '#fff' : 'var(--fg)',
          }} onClick={() => setPageIdx(i)} onDoubleClick={() => void renamePage(i)} title="Double-click to rename">
            <span style={{ fontSize: 12 }}>{p.name || '(unnamed)'}</span>
            {i === pageIdx && (
              <>
                <button style={{ ...iconBtn, padding: 1, background: 'transparent', border: 'none', color: '#fff' }} title="Move left" onClick={(e) => { e.stopPropagation(); movePage(i, -1) }}><ChevronLeft size={13} /></button>
                <button style={{ ...iconBtn, padding: 1, background: 'transparent', border: 'none', color: '#fff' }} title="Move right" onClick={(e) => { e.stopPropagation(); movePage(i, 1) }}><ChevronRight size={13} /></button>
                <button style={{ ...iconBtn, padding: 1, background: 'transparent', border: 'none', color: '#fff' }} title="Delete page" onClick={(e) => { e.stopPropagation(); void deletePage(i) }}><Trash2 size={12} /></button>
              </>
            )}
          </div>
        ))}
        <button style={{ ...btn, marginLeft: 2 }} onClick={() => void addPage()}><Plus size={13} /> Page</button>
        <span style={{ flex: 1 }} />
        {page && <button style={btn} onClick={() => setPageSettings(true)} title="Page-level settings (width, slug, navigation…)"><Settings size={13} /> Page settings</button>}
      </div>

      {/* columns canvas */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
        {!page ? (
          <div style={{ color: 'var(--fg-faint)', fontSize: 13, textAlign: 'center', marginTop: 40 }}>No pages yet — add one above.</div>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {cols.map((c, ci) => (
              <div key={ci}
                onDragOver={(e) => { e.preventDefault() }}
                onDrop={(e) => { e.preventDefault(); dropOnColumn(ci, null) }}
                style={{ flex: c.size === 'small' ? '0 0 230px' : '1 1 320px', minWidth: 220, border: '1px dashed var(--border)', borderRadius: 10, padding: 10, background: 'var(--app-bg-subtle, rgba(127,127,127,0.04))' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 10.5, color: 'var(--fg-faint)' }}>Column {ci + 1}</span>
                  <select style={{ fontSize: 11, padding: '2px 5px', border: '1px solid var(--border)', borderRadius: 5, background: 'var(--control-bg)', color: 'var(--fg)' }}
                    value={c.size || 'full'} onChange={(e) => setColSize(ci, e.target.value)}>
                    {(DYNACAT_COLUMN_OPTIONS[0]?.enum || ['small', 'full']).map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span style={{ flex: 1 }} />
                  <button style={{ ...iconBtn, padding: 2 }} title="Move column left" onClick={() => moveColumn(ci, -1)}><ChevronLeft size={13} /></button>
                  <button style={{ ...iconBtn, padding: 2 }} title="Move column right" onClick={() => moveColumn(ci, 1)}><ChevronRight size={13} /></button>
                  <button style={{ ...iconBtn, padding: 2 }} title="Delete column" onClick={() => void deleteColumn(ci)}><Trash2 size={13} /></button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(c.widgets || []).map((w, wi) => {
                    const def = findWidgetDef(w.type)
                    return (
                      <div key={wi} draggable
                        onDragStart={() => setDrag({ col: ci, w: wi })}
                        onDragOver={(e) => { e.preventDefault() }}
                        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnColumn(ci, wi) }}
                        style={{
                          border: '1px solid var(--border)', borderRadius: 9, padding: '10px 10px', background: 'var(--control-bg)',
                          display: 'flex', alignItems: 'center', gap: 8, cursor: 'grab', minHeight: 52,
                          boxShadow: def ? 'none' : 'inset 0 0 0 1px var(--danger, #e66)',
                        }} title={def ? def.description : `Unknown widget type "${w.type}"`}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {def?.label || w.type}
                          </div>
                          <div style={{ fontSize: 10.5, color: 'var(--fg-faint)' }}>
                            {w.type}{typeof w.title === 'string' && w.title ? ` · "${w.title}"` : ''}
                          </div>
                        </div>
                        <button style={iconBtn} title="Configure" onClick={() => setGear({ col: ci, w: wi })}><Settings size={14} /></button>
                        <button style={iconBtn} title="Delete widget" onClick={() => deleteWidget(ci, wi)}><Trash2 size={14} /></button>
                      </div>
                    )
                  })}
                  <button style={{ ...btn, justifyContent: 'center' }} onClick={() => setPicker({ col: ci })}><Plus size={13} /> Add widget</button>
                </div>
              </div>
            ))}
            <button style={{ ...btn, flex: '0 0 auto', height: 40 }} onClick={addColumn}><Plus size={13} /> Column</button>
          </div>
        )}
      </div>

      {/* widget picker */}
      {picker && (
        <Modal title="Add a widget" onClose={() => { setPicker(null); setPickerQuery('') }}>
          <input autoFocus placeholder="Search widgets…" value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--control-bg)', color: 'var(--fg)', marginBottom: 10 }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, overflow: 'auto' }}>
            {filteredWidgets.map((wd) => (
              <button key={wd.type} onClick={() => addWidget(picker.col, wd.type)} title={wd.description}
                style={{ textAlign: 'left', padding: 10, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--control-bg)', color: 'var(--fg)', cursor: 'pointer' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{wd.label}</div>
                <div style={{ fontSize: 10.5, color: 'var(--fg-faint)' }}>{wd.type}</div>
              </button>
            ))}
            {filteredWidgets.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>No widgets match “{pickerQuery}”.</div>}
          </div>
        </Modal>
      )}

      {/* gear config popup */}
      {gear && gearWidget && (
        <Modal title={`Configure: ${gearDef?.label || gearWidget.type}`} subtitle={gearDef?.description} onClose={() => setGear(null)}>
          {!gearDef && <div style={{ fontSize: 12, color: 'var(--danger, #e66)', marginBottom: 8 }}>Unknown widget type “{gearWidget.type}” — not in the catalog. Edit via Raw YAML.</div>}
          <DcFieldForm schema={(gearDef?.options || []).filter((o) => o.key !== 'type')} value={gearWidget} onChange={(v) => updateWidget(gear.col, gear.w, { ...v, type: gearWidget.type })} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <button style={primaryBtn} onClick={() => setGear(null)}>Done</button>
          </div>
        </Modal>
      )}

      {/* page settings popup */}
      {pageSettings && page && (
        <Modal title={`Page settings: ${page.name || '(unnamed)'}`} subtitle="Columns and widgets are edited on the canvas; these are the page-level options." onClose={() => setPageSettings(false)}>
          <DcFieldForm schema={DYNACAT_PAGE_OPTIONS} value={page} onChange={(v) => updatePage(v)} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <button style={primaryBtn} onClick={() => setPageSettings(false)}>Done</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

const Modal: React.FC<{ title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }> = ({ title, subtitle, onClose, children }) => (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ width: 'min(680px, 94%)', maxHeight: '88%', background: 'var(--app-bg)', border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ flex: 1 }}>
          <strong>{title}</strong>
          {subtitle && <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{subtitle}</div>}
        </div>
        <button style={iconBtn} onClick={onClose}><X size={14} /></button>
      </div>
      <div style={{ padding: 14, overflow: 'auto' }}>{children}</div>
    </div>
  </div>
)

export default DynacatBuilder
