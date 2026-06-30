import React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { DcOption } from './dynacatCatalog'

/**
 * Renders a Dynacat widget/page/column option schema (DcOption[]) as editable fields.
 * Recursive: 'object' nests a sub-form, 'object[]' is a repeatable list of sub-forms.
 * `value` is a plain object keyed by option.key; onChange returns the next object.
 */
type Obj = Record<string, unknown>

const lbl: React.CSSProperties = { fontSize: 11.5, color: 'var(--fg-muted)', display: 'block', marginBottom: 3 }
const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '5px 8px',
  border: '1px solid var(--border)', borderRadius: 6, background: 'var(--control-bg)', color: 'var(--fg)',
}
const hint: React.CSSProperties = { fontSize: 10.5, color: 'var(--fg-faint)', marginTop: 2 }
const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, padding: '3px 8px',
  border: '1px solid var(--border)', borderRadius: 6, background: 'var(--control-bg)', color: 'var(--fg)', cursor: 'pointer',
}

const Field: React.FC<{ opt: DcOption; value: unknown; onChange: (v: unknown) => void }> = ({ opt, value, onChange }) => {
  const labelEl = (
    <span style={lbl}>
      {opt.label}{opt.required ? <span style={{ color: 'var(--danger, #e66)' }}> *</span> : null}
      {opt.type !== 'boolean' && <span style={{ color: 'var(--fg-faint)', fontWeight: 400 }}> · {opt.key}</span>}
    </span>
  )
  const desc = opt.description ? <div style={hint}>{opt.description}</div> : null

  switch (opt.type) {
    case 'boolean':
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span>{opt.label} <span style={{ color: 'var(--fg-faint)' }}>· {opt.key}</span></span>
          {desc}
        </label>
      )
    case 'number':
      return (
        <div>
          {labelEl}
          <input style={inp} type="number" value={value == null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
          {desc}
        </div>
      )
    case 'enum':
      return (
        <div>
          {labelEl}
          <select style={inp} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">{opt.default != null ? `(default: ${String(opt.default)})` : '(unset)'}</option>
            {(opt.enum || []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {desc}
        </div>
      )
    case 'color':
      return (
        <div>
          {labelEl}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="color" value={typeof value === 'string' && /^#/.test(value) ? value : '#000000'}
              onChange={(e) => onChange(e.target.value)} style={{ width: 34, height: 28, padding: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'none' }} />
            <input style={inp} value={value == null ? '' : String(value)} placeholder="e.g. #5b9 or HSL h s l"
              onChange={(e) => onChange(e.target.value || undefined)} />
          </div>
          {desc}
        </div>
      )
    case 'duration':
      return (
        <div>
          {labelEl}
          <input style={inp} value={value == null ? '' : String(value)} placeholder="e.g. 30m, 1h, 24h"
            onChange={(e) => onChange(e.target.value || undefined)} />
          {desc}
        </div>
      )
    case 'string[]': {
      const arr = Array.isArray(value) ? (value as unknown[]).map(String) : []
      return (
        <div>
          {labelEl}
          <textarea style={{ ...inp, minHeight: 56, resize: 'vertical', fontFamily: 'var(--font-mono, monospace)' }}
            value={arr.join('\n')} placeholder="one value per line"
            onChange={(e) => {
              const lines = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
              onChange(lines.length ? lines : undefined)
            }} />
          <div style={hint}>One per line.{opt.description ? ' ' + opt.description : ''}</div>
        </div>
      )
    }
    case 'object': {
      const obj = (value && typeof value === 'object' ? value : {}) as Obj
      return (
        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, margin: 0 }}>
          <legend style={{ fontSize: 11.5, color: 'var(--fg-muted)', padding: '0 5px' }}>{opt.label}</legend>
          <DcFieldForm schema={opt.itemSchema || []} value={obj} onChange={(v) => onChange(v)} />
          {desc}
        </fieldset>
      )
    }
    case 'object[]': {
      const arr = Array.isArray(value) ? (value as Obj[]) : []
      const update = (i: number, v: Obj) => { const next = arr.slice(); next[i] = v; onChange(next) }
      const add = () => onChange([...arr, {}])
      const remove = (i: number) => { const next = arr.slice(); next.splice(i, 1); onChange(next.length ? next : undefined) }
      return (
        <div>
          {labelEl}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {arr.map((item, i) => (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, position: 'relative', background: 'var(--app-bg)' }}>
                <button type="button" style={{ ...btn, position: 'absolute', top: 6, right: 6, padding: '2px 6px' }}
                  title="Remove item" onClick={() => remove(i)}><Trash2 size={12} /></button>
                <div style={{ fontSize: 10.5, color: 'var(--fg-faint)', marginBottom: 6 }}>#{i + 1}</div>
                <DcFieldForm schema={opt.itemSchema || []} value={item} onChange={(v) => update(i, v as Obj)} />
              </div>
            ))}
            <button type="button" style={{ ...btn, alignSelf: 'flex-start' }} onClick={add}><Plus size={12} /> Add {opt.label.replace(/s$/, '') || 'item'}</button>
          </div>
          {desc}
        </div>
      )
    }
    case 'string':
    default:
      return (
        <div>
          {labelEl}
          <input style={inp} value={value == null ? '' : String(value)}
            placeholder={opt.default != null ? `default: ${String(opt.default)}` : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
          {desc}
        </div>
      )
  }
}

export const DcFieldForm: React.FC<{ schema: DcOption[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }>
  = ({ schema, value, onChange }) => {
    const set = (key: string, v: unknown) => {
      const next = { ...value }
      if (v === undefined) delete next[key]
      else next[key] = v
      onChange(next)
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {schema.map((opt) => (
          <Field key={opt.key} opt={opt} value={value[opt.key]} onChange={(v) => set(opt.key, v)} />
        ))}
        {schema.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>This widget has no configurable options.</div>}
      </div>
    )
  }

export default DcFieldForm
