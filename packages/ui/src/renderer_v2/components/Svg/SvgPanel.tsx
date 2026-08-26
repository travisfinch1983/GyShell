import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FilePlus2, RefreshCw, Save, Shapes, Trash2 } from 'lucide-react'
import { SvgEditEmbed, type SvgEditHandle } from './SvgEditEmbed'

/**
 * SVG tab — self-hosted svgedit over AI-Lab's shared SVG store (/api/svgs).
 *
 * The same store is written by the svg_* MCP tools and by LAN consumers over plain REST
 * (Marinara's world builder), so a drawing made by an agent opens here and vice versa.
 */

interface Item { id: string; bytes: number; updatedAt: string }

const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  // Throw with the SERVER'S reason. The store answers 400s that name the problem
  // ("wrapped in a markdown code fence", "does not end with </svg>"); discarding that and
  // showing "save failed" would throw away the only useful part.
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data
}

/** Poll cadence for follow mode. Only runs while the tab is visible AND follow is on. */
const FOLLOW_MS = 2000

export const SvgPanel: React.FC = () => {
  const handleRef = useRef<SvgEditHandle | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [current, setCurrent] = useState<string>('')
  const [loaded, setLoaded] = useState<string>('')      // svg text pushed into the editor
  const [reloadKey, setReloadKey] = useState(0)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [follow, setFollow] = useState(false)
  const [remoteChanged, setRemoteChanged] = useState(false)
  const seenAt = useRef<string>('')                      // updatedAt we have already shown

  const refreshList = useCallback(async () => {
    try {
      const d = await api('GET', '/api/svgs')
      setItems(Array.isArray(d?.svgs) ? d.svgs : [])
      setError('')
    } catch (e: any) { setError(`Could not list drawings: ${e?.message ?? e}`) }
  }, [])

  useEffect(() => { void refreshList() }, [refreshList])

  const open = useCallback(async (id: string) => {
    try {
      const d = await api('GET', `/api/svgs/${encodeURIComponent(id)}`)
      setCurrent(id)
      setLoaded(d?.svg ?? '')
      setReloadKey((k) => k + 1)      // force the iframe to remount with the new document
      setDirty(false)
      setRemoteChanged(false)
      seenAt.current = items.find((i) => i.id === id)?.updatedAt ?? ''
      setStatus(`opened ${id}`)
      setError('')
    } catch (e: any) { setError(`Could not open "${id}": ${e?.message ?? e}`) }
  }, [items])

  const save = useCallback(async (id?: string) => {
    const target = (id ?? current ?? '').trim()
    if (!target) { setError('Name the drawing before saving'); return }
    const svg = handleRef.current?.getSvg()
    if (!svg) { setError('Editor is not ready yet'); return }
    try {
      setStatus('saving…')
      await api('PUT', `/api/svgs/${encodeURIComponent(target)}`, { svg })
      setCurrent(target)
      setDirty(false)
      setStatus(`saved ${target}`)
      setError('')
      await refreshList()
      seenAt.current = new Date().toISOString()   // our own write must not read back as remote
    } catch (e: any) { setStatus(''); setError(`Save failed: ${e?.message ?? e}`) }
  }, [current, refreshList])

  // ── follow mode ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!follow || !current) return
    const tick = async () => {
      if (document.hidden) return                 // nothing to watch while hidden
      try {
        const d = await api('GET', '/api/svgs')
        const it = (d?.svgs ?? []).find((x: Item) => x.id === current)
        if (!it || !seenAt.current || it.updatedAt === seenAt.current) return
        if (dirty) {
          // CONFLICT. Do not resolve it silently in either direction: reloading would
          // destroy unsaved work, ignoring would leave the view stale and lying.
          setRemoteChanged(true)
          return
        }
        const doc = await api('GET', `/api/svgs/${encodeURIComponent(current)}`)
        setLoaded(doc?.svg ?? '')
        setReloadKey((k) => k + 1)
        seenAt.current = it.updatedAt
        setStatus(`reloaded — changed by another writer at ${new Date(it.updatedAt).toLocaleTimeString()}`)
      } catch (e: any) { setError(`Follow failed: ${e?.message ?? e}`) }
    }
    const t = setInterval(() => void tick(), FOLLOW_MS)
    return () => clearInterval(t)
  }, [follow, current, dirty])

  const download = () => {
    const svg = handleRef.current?.getSvg()
    if (!svg) return
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${current || 'drawing'}.svg`
    a.click()
    URL.revokeObjectURL(url)
  }

  const remove = async (id: string) => {
    try { await api('DELETE', `/api/svgs/${encodeURIComponent(id)}`); if (id === current) setCurrent(''); await refreshList() }
    catch (e: any) { setError(`Delete failed: ${e?.message ?? e}`) }
  }

  const btn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px',
    border: '1px solid var(--border)', borderRadius: 8, background: 'var(--control-bg)',
    color: 'var(--fg-muted)', fontSize: 11, cursor: 'pointer',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <Shapes size={16} />
        <strong style={{ fontSize: 13 }}>SVG</strong>

        <select
          value={current}
          onChange={(e) => { const v = e.target.value; if (v) void open(v) }}
          style={{ ...btn, minWidth: 190 }}
        >
          <option value="">— open a drawing —</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.id}</option>)}
        </select>

        <button style={btn} onClick={() => void refreshList()} title="Refresh the list"><RefreshCw size={12} /></button>
        <button style={btn} onClick={() => { setCurrent(''); setLoaded(''); setReloadKey((k) => k + 1); setDirty(false) }} title="Start a blank drawing"><FilePlus2 size={12} /> New</button>

        <button
          style={{ ...btn, borderColor: 'var(--accent)', background: 'var(--accent)', color: 'var(--app-bg)', fontWeight: 600 }}
          disabled={!ready}
          onClick={() => {
            const name = current || window.prompt('Save as (letters, digits, dot, underscore, hyphen):')?.trim() || ''
            if (name) void save(name)
          }}
        ><Save size={12} /> Save</button>

        <button style={btn} onClick={download} disabled={!ready} title="Download a copy"><Download size={12} /></button>
        {current && <button style={btn} onClick={() => void remove(current)} title={`Delete ${current}`}><Trash2 size={12} /></button>}

        <label style={{ ...btn, cursor: 'pointer', borderColor: follow ? 'var(--accent)' : 'var(--border)', color: follow ? 'var(--accent)' : 'var(--fg-muted)' }}
          title="Reload automatically when another writer (an agent, Marinara) changes this drawing. Polls only while this tab is visible.">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} style={{ margin: 0 }} />
          Follow changes
        </label>

        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: dirty ? 'var(--accent)' : 'var(--fg-faint)' }}>
          {!ready ? 'loading editor…' : dirty ? 'unsaved changes' : status || 'ready'}
        </span>
      </div>

      {remoteChanged && (
        // Stated, not resolved. Silently reloading destroys local edits; silently ignoring
        // leaves the view stale — the user is the only one who can say which matters.
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', background: 'color-mix(in srgb, var(--accent) 14%, transparent)', borderBottom: '1px solid var(--accent)', fontSize: 11.5 }}>
          <strong>Another writer changed “{current}” while you have unsaved edits.</strong>
          <button style={btn} onClick={() => { setDirty(false); setRemoteChanged(false); void open(current) }}>Discard mine &amp; reload</button>
          <button style={btn} onClick={() => { setRemoteChanged(false); void save(current) }}>Keep mine &amp; overwrite</button>
        </div>
      )}
      {error && (
        <div style={{ padding: '7px 12px', background: 'color-mix(in srgb, var(--danger, #e5484d) 14%, transparent)', borderBottom: '1px solid var(--danger, #e5484d)', fontSize: 11.5 }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <SvgEditEmbed
          svg={loaded}
          reloadKey={reloadKey}
          onReady={() => setReady(true)}
          onDirty={() => setDirty(true)}
          handleRef={(h) => { handleRef.current = h }}
        />
      </div>
    </div>
  )
}
