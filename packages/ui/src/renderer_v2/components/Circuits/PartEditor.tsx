import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Trash2, Upload, Square, Rows3, X } from 'lucide-react'
import type { PartDef, PinDef, PinSide, PinType } from './circuitTypes'
import { PIN_COLORS, PIN_FLAGS, PIN_TYPES } from './circuitTypes'
import { artUrl, snap } from './geometry'
import { circuitApi, errText } from './circuitApi'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Circuit.module.css'

const MM = 0.254 // 1 unit = 0.01" = 0.254 mm
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface Props {
  initial: Partial<PartDef> | null
  isNew: boolean
  onClose: () => void
  onSaved: (p: PartDef) => void
  onDeleted: (id: string, stillUsedBy: string[]) => void
}

type Art = { kind: 'svg'; svg: string } | { kind: 'image'; image: string } | { kind: 'box'; color: string; label: string }

function boxSvg(w: number, h: number, color: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="3" fill="${color}" stroke="#0b0b0b" stroke-width="0.8"/>` +
    `<text x="${w / 2}" y="${h / 2 + 2}" font-size="${Math.max(4, Math.min(8, w / Math.max(label.length, 1) * 1.4))}" font-weight="bold" font-family="sans-serif" fill="#ffffffcc" text-anchor="middle">${esc(label)}</text></svg>`
}

/** Read a physical size from an uploaded SVG (CAD exports usually carry mm). */
function svgSize(svg: string): { wUnits?: number; hUnits?: number; aspect?: number } {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const el = doc.documentElement
  if (!el || el.nodeName.toLowerCase() !== 'svg') return {}
  const unit = (v: string | null): number | undefined => {
    if (!v) return undefined
    const m = /^\s*([\d.]+)\s*(mm|cm|in|pt|px)?\s*$/.exec(v)
    if (!m) return undefined
    const n = Number(m[1])
    switch (m[2]) {
      case 'mm': return n / MM
      case 'cm': return (n * 10) / MM
      case 'in': return n * 100
      case 'pt': return (n / 72) * 100
      default: return undefined // px / unitless: no physical size
    }
  }
  const vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
  const aspect = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[3] / vb[2] : undefined
  return { wUnits: unit(el.getAttribute('width')), hUnits: unit(el.getAttribute('height')), aspect }
}

const nextPinName = (pins: PinDef[]) => {
  let i = pins.length + 1
  const ids = new Set(pins.map((p) => p.id))
  while (ids.has(String(i))) i++
  return String(i)
}

export function PartEditor({ initial, isNew, onClose, onSaved, onDeleted }: Props) {
  const [name, setName] = useState(initial?.name ?? 'New part')
  const [category, setCategory] = useState(initial?.category && initial.source === 'custom' ? initial.category : initial?.category ?? 'Custom')
  const [refPrefix, setRefPrefix] = useState(initial?.refPrefix ?? 'U')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '))
  const [width, setWidth] = useState(initial?.width ?? 60)
  const [height, setHeight] = useState(initial?.height ?? 40)
  const [art, setArt] = useState<Art>(initial?.image ? { kind: 'image', image: initial.image } : initial?.svg ? { kind: 'svg', svg: initial.svg } : { kind: 'box', color: '#1d4ed8', label: 'PART' })
  const [pins, setPins] = useState<PinDef[]>(() => JSON.parse(JSON.stringify(initial?.pins ?? [])))
  const [selPin, setSelPin] = useState<number | null>(null)
  const [snapOn, setSnapOn] = useState(true)
  const [rowTool, setRowTool] = useState<{ count: number; pitch: number; dir: 'R' | 'D' | 'L' | 'U'; prefix: string; start: number; type: PinType } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragIdx = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const previewPart: PartDef = useMemo(() => ({
    id: 'preview', name, category, refPrefix, source: 'custom', width, height, pins,
    ...(art.kind === 'image' ? { image: art.image } : { svg: art.kind === 'svg' ? art.svg : boxSvg(width, height, art.color, art.label) }),
  }), [name, category, refPrefix, width, height, pins, art])
  const url = artUrl(previewPart)

  // scale the part to fit the editing area
  const AREA_W = 620, AREA_H = 440, PAD = 30
  const scale = Math.min((AREA_W - PAD * 2) / width, (AREA_H - PAD * 2) / height, 8)
  const ox = (AREA_W - width * scale) / 2, oy = (AREA_H - height * scale) / 2

  const toLocal = (e: React.PointerEvent | React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    const x = (e.clientX - r.left - ox) / scale, y = (e.clientY - r.top - oy) / scale
    const g = snapOn ? 5 : 1
    return { x: snap(x, g), y: snap(y, g) }
  }
  const sideFor = (x: number, y: number): PinSide => {
    const d: Record<PinSide, number> = { L: x, R: width - x, T: y, B: height - y }
    return (Object.entries(d).sort((a, b) => a[1] - b[1])[0][0]) as PinSide
  }

  const onCanvasDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const { x, y } = toLocal(e)
    if (rowTool) {
      const step = { R: [1, 0], D: [0, 1], L: [-1, 0], U: [0, -1] }[rowTool.dir]
      const added: PinDef[] = []
      const ids = new Set(pins.map((p) => p.id))
      for (let i = 0; i < rowTool.count; i++) {
        const px = x + step[0] * rowTool.pitch * i, py = y + step[1] * rowTool.pitch * i
        let id = `${rowTool.prefix}${rowTool.start + i}`
        while (ids.has(id)) id = `${id}_`
        ids.add(id)
        added.push({ id, name: id, x: px, y: py, side: sideFor(px, py), type: rowTool.type })
      }
      setPins([...pins, ...added])
      setSelPin(pins.length)
      setRowTool(null)
      return
    }
    const id = nextPinName(pins)
    setPins([...pins, { id, name: id, x, y, side: sideFor(x, y), type: 'gpio' }])
    setSelPin(pins.length)
  }
  const onPinDown = (e: React.PointerEvent, i: number) => {
    e.stopPropagation()
    setSelPin(i)
    dragIdx.current = i
    svgRef.current?.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const i = dragIdx.current
    if (i === null) return
    const { x, y } = toLocal(e)
    setPins((ps) => ps.map((p, j) => (j === i && (p.x !== x || p.y !== y) ? { ...p, x, y, side: sideFor(x, y) } : p)))
  }
  const onUp = (e: React.PointerEvent) => { dragIdx.current = null; try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { /* not captured */ } }

  const updatePin = (i: number, patch: Partial<PinDef>) => setPins((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const removePin = (i: number) => { setPins((ps) => ps.filter((_, j) => j !== i)); setSelPin(null) }

  const onFile = async (f: File) => {
    setError(null)
    if (f.size > 10 * 1024 * 1024) { setError('That file is over 10 MB.'); return }
    const isSvg = f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)
    if (isSvg) {
      const text = await f.text()
      if (!/<svg[\s>]/i.test(text)) { setError('That does not look like an SVG file.'); return }
      const s = svgSize(text)
      if (s.wUnits && s.hUnits) { setWidth(Math.round(s.wUnits)); setHeight(Math.round(s.hUnits)) }
      else if (s.aspect) setHeight(Math.round(width * s.aspect))
      setArt({ kind: 'svg', svg: text })
      return
    }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { setError('Use an SVG, PNG, JPG, WebP or GIF image.'); return }
    const dataUrl: string = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f) })
    const img = new Image()
    img.onload = () => { if (img.naturalWidth) setHeight(Math.round(width * (img.naturalHeight / img.naturalWidth))) }
    img.src = dataUrl
    setArt({ kind: 'image', image: dataUrl })
  }

  // keep pins inside the body when the size shrinks
  useEffect(() => { setPins((ps) => ps.map((p) => ({ ...p, x: Math.min(p.x, width), y: Math.min(p.y, height) }))) }, [width, height])

  const save = async () => {
    setError(null)
    if (!name.trim()) { setError('Give the part a name.'); return }
    if (!pins.length) { setError('Add at least one pin — click on the part to place one.'); return }
    const dup = pins.map((p) => p.id).find((id, i, a) => a.indexOf(id) !== i)
    if (dup) { setError(`Pin id "${dup}" is used twice.`); return }
    setSaving(true)
    try {
      const body: Partial<PartDef> = {
        ...(isNew ? {} : { id: initial?.id }),
        name: name.trim(), category: category.trim() || 'Custom', refPrefix: refPrefix.trim().toUpperCase() || 'U',
        description: description.trim() || undefined, tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        width, height, pins, buses: initial?.buses, schematic: initial?.schematic, props: initial?.props,
        ...(art.kind === 'image' ? { image: art.image } : { svg: art.kind === 'svg' ? art.svg : boxSvg(width, height, art.color, art.label) }),
      }
      const saved = await circuitApi.savePart(body, isNew)
      onSaved(saved)
    } catch (e) { setError(errText(e)) } finally { setSaving(false) }
  }
  const del = async () => {
    if (!initial?.id) return
    const ok = await confirmStore.confirm({ title: 'Delete part?', message: `"${name}" moves to the circuits trash folder. Circuits that use it will show a placeholder.`, confirmText: 'Delete', danger: true })
    if (!ok) return
    try { const r = await circuitApi.removePart(initial.id); onDeleted(initial.id, r.stillUsedBy) } catch (e) { setError(errText(e)) }
  }

  const sp = selPin !== null ? pins[selPin] : null

  return (
    <div className={styles.modalBg} onClick={onClose}>
      <div className={`${styles.modal} ${styles.editorModal}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.editorHead}>
          <span className={styles.modalHead}>{isNew ? 'New part' : `Edit part — ${initial?.id}`}</span>
          <span className={styles.spacer} />
          <button className={styles.iconBtnSm} onClick={onClose} title="Close"><X size={14} /></button>
        </div>
        <div className={styles.editorBody}>
          <div className={styles.editorLeft}>
            <label className={styles.field}>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <div className={styles.row}>
              <label className={styles.field} style={{ flex: 1 }}>Category<input value={category} onChange={(e) => setCategory(e.target.value)} /></label>
              <label className={styles.field} style={{ width: 64 }}>Prefix<input value={refPrefix} onChange={(e) => setRefPrefix(e.target.value)} title="Reference prefix: U (module), R, C, D, SW, J, K, Q" /></label>
            </div>
            <label className={styles.field}>Description<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
            <label className={styles.field}>Tags (comma separated)<input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
            <div className={styles.propsHead}>Artwork</div>
            <div className={styles.row}>
              <button className={styles.btn} onClick={() => fileRef.current?.click()}><Upload size={13} /> Upload SVG/PNG</button>
              <button className={styles.btn} onClick={() => setArt({ kind: 'box', color: art.kind === 'box' ? art.color : '#1d4ed8', label: art.kind === 'box' ? art.label : name.slice(0, 12) })}><Square size={13} /> Plain box</button>
              <input ref={fileRef} type="file" accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
            </div>
            {art.kind === 'box' && (
              <div className={styles.row}>
                <input type="color" value={art.color} onChange={(e) => setArt({ ...art, color: e.target.value })} />
                <input className={styles.grow} value={art.label} onChange={(e) => setArt({ ...art, label: e.target.value })} placeholder="Label" />
              </div>
            )}
            <div className={styles.row}>
              <label className={styles.field}>Width (mm)<input type="number" step="0.1" value={+(width * MM).toFixed(2)} onChange={(e) => setWidth(Math.max(5, Math.round(Number(e.target.value) / MM)))} /></label>
              <label className={styles.field}>Height (mm)<input type="number" step="0.1" value={+(height * MM).toFixed(2)} onChange={(e) => setHeight(Math.max(5, Math.round(Number(e.target.value) / MM)))} /></label>
            </div>
            <div className={styles.dim}>{width} × {height} units · 2.54 mm (0.1") = 10 units</div>
            <label className={styles.check}><input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> Snap pins to 1.27 mm (0.05")</label>

            <div className={styles.propsHead}>Pins ({pins.length})</div>
            <button className={styles.btn} onClick={() => setRowTool(rowTool ? null : { count: 8, pitch: 10, dir: 'D', prefix: '', start: 1, type: 'gpio' })}>
              <Rows3 size={13} /> {rowTool ? 'Cancel header row' : 'Add a header row…'}
            </button>
            {rowTool && (
              <div className={styles.rowTool}>
                <label className={styles.field}>Pins<input type="number" min={1} max={80} value={rowTool.count} onChange={(e) => setRowTool({ ...rowTool, count: Math.max(1, Math.min(80, Number(e.target.value))) })} /></label>
                <label className={styles.field}>Pitch (mm)<input type="number" step="0.01" value={+(rowTool.pitch * MM).toFixed(2)} onChange={(e) => setRowTool({ ...rowTool, pitch: Math.max(1, Number(e.target.value) / MM) })} /></label>
                <label className={styles.field}>Direction<select value={rowTool.dir} onChange={(e) => setRowTool({ ...rowTool, dir: e.target.value as any })}><option value="D">down</option><option value="R">right</option><option value="U">up</option><option value="L">left</option></select></label>
                <label className={styles.field}>Name prefix<input value={rowTool.prefix} onChange={(e) => setRowTool({ ...rowTool, prefix: e.target.value })} placeholder="(none)" /></label>
                <label className={styles.field}>Start #<input type="number" value={rowTool.start} onChange={(e) => setRowTool({ ...rowTool, start: Number(e.target.value) })} /></label>
                <div className={styles.dim}>Now click where the FIRST pin goes.</div>
              </div>
            )}
            <div className={styles.pinList}>
              {pins.map((p, i) => (
                <button key={i} className={`${styles.pinRowBtn} ${selPin === i ? styles.pinRowOn : ''}`} onClick={() => setSelPin(i)}>
                  <span style={{ color: PIN_COLORS[p.type] }}>●</span> <span className={styles.pinName}>{p.name}</span> <span className={styles.dim}>{p.type}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.editorCenter}>
            <div className={styles.dim}>{rowTool ? 'Click to place the first pin of the row.' : 'Click on the part to add a pin. Drag pins to move them.'}</div>
            <svg ref={svgRef} width={AREA_W} height={AREA_H} className={styles.editorSvg} onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp}>
              <g transform={`translate(${ox} ${oy}) scale(${scale})`}>
                {url && <image href={url} x={0} y={0} width={width} height={height} preserveAspectRatio="none" />}
                <rect x={0} y={0} width={width} height={height} fill="none" stroke="#ffffff33" strokeDasharray="2 2" strokeWidth={0.5} />
                {pins.map((p, i) => (
                  <g key={i} onPointerDown={(e) => onPinDown(e, i)} style={{ cursor: 'grab' }}>
                    <circle cx={p.x} cy={p.y} r={selPin === i ? 3.4 : 2.6} fill={PIN_COLORS[p.type]} fillOpacity={0.85} stroke={selPin === i ? '#fff' : '#000'} strokeWidth={0.6} />
                    <text x={p.x} y={p.y - 4} fontSize={3.4} fill="#fff" textAnchor="middle" style={{ pointerEvents: 'none', paintOrder: 'stroke', stroke: '#000', strokeWidth: 0.8 }}>{p.name}</text>
                  </g>
                ))}
              </g>
            </svg>
          </div>

          <div className={styles.editorRight}>
            {sp ? (
              <>
                <div className={styles.propsHead}>Pin</div>
                <label className={styles.field}>Name (printed on the board)<input value={sp.name} onChange={(e) => updatePin(selPin!, { name: e.target.value })} /></label>
                <label className={styles.field}>Id (unique; GPIO pins: GPIO4)<input value={sp.id} onChange={(e) => updatePin(selPin!, { id: e.target.value.trim() })} /></label>
                <label className={styles.field}>Type
                  <select value={sp.type} onChange={(e) => updatePin(selPin!, { type: e.target.value as PinType })}>
                    {PIN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                {(sp.type === 'power') && (
                  <label className={styles.field}>Voltage<input type="number" step="0.1" value={sp.voltage ?? ''} onChange={(e) => updatePin(selPin!, { voltage: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                )}
                <label className={styles.field}>Functions (comma separated)<input value={(sp.functions ?? []).join(', ')} onChange={(e) => updatePin(selPin!, { functions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="ADC1_CH3, TOUCH3" /></label>
                <div className={styles.field}>Warnings
                  <div className={styles.flagGrid}>
                    {PIN_FLAGS.map((f) => (
                      <label key={f} className={styles.check}><input type="checkbox" checked={!!sp.flags?.includes(f)} onChange={(e) => updatePin(selPin!, { flags: e.target.checked ? [...(sp.flags ?? []), f] : (sp.flags ?? []).filter((x) => x !== f) })} /> {f}</label>
                    ))}
                  </div>
                </div>
                <label className={styles.field}>Notes<textarea rows={3} value={sp.notes ?? ''} onChange={(e) => updatePin(selPin!, { notes: e.target.value || undefined })} /></label>
                <div className={styles.dim}>Position {+(sp.x * MM).toFixed(2)} × {+(sp.y * MM).toFixed(2)} mm · side {sp.side}</div>
                <button className={styles.btnDanger} onClick={() => removePin(selPin!)}><Trash2 size={13} /> Remove pin</button>
              </>
            ) : <div className={styles.dim}>Select a pin to edit it.</div>}
          </div>
        </div>
        <div className={styles.editorFoot}>
          {error && <span className={styles.saveError}>⚠ {error}</span>}
          <span className={styles.spacer} />
          {!isNew && initial?.id && <button className={styles.btnDanger} onClick={del}><Trash2 size={13} /> Delete part</button>}
          <button className={styles.btn} onClick={onClose}>Cancel</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save part'}</button>
        </div>
      </div>
    </div>
  )
}
