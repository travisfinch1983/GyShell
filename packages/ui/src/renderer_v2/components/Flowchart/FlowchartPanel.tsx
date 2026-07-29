import { useCallback, useEffect, useRef, useState } from 'react'
import { Save, FolderOpen, FilePlus2, Trash2, Download, Image as ImageIcon } from 'lucide-react'
import { DrawioEmbed, type DrawioHandle } from './DrawioEmbed'
import styles from './FlowchartPanel.module.css'

// The Flowchart tab is now a self-hosted draw.io editor (served static at /drawio, same origin).
// Diagrams persist as draw.io XML in the shared server store (/api/flowcharts/<id>) — the same
// "you draw it / an agent generates it, both read it" surface, now with full draw.io features.
const bridge = (): { request: (m: string, p: string, b?: unknown) => Promise<any> } | undefined =>
  (window as unknown as { gyshell?: { cluster?: any } }).gyshell?.cluster

interface Chart { id: string; name: string; xml: string; updatedAt?: string }

const api = {
  async list(): Promise<Array<{ id: string; name: string; updatedAt?: string }>> {
    try { const r = await bridge()?.request('GET', '/api/flowcharts'); return Array.isArray(r?.charts) ? r.charts : [] } catch { return [] }
  },
  async load(id: string): Promise<Chart | null> {
    try { const r = await bridge()?.request('GET', `/api/flowcharts/${encodeURIComponent(id)}`); return r?.chart ?? null } catch { return null }
  },
  async save(c: Chart): Promise<void> {
    try { await bridge()?.request('PUT', `/api/flowcharts/${encodeURIComponent(c.id)}`, c) } catch { /* ignore */ }
  },
  async remove(id: string): Promise<void> {
    try { await bridge()?.request('DELETE', `/api/flowcharts/${encodeURIComponent(id)}`) } catch { /* ignore */ }
  },
}

const DRAFT_KEY = 'ai-lab-flowchart-draft'
let _c = 0
const nid = () => `n${Date.now().toString(36)}${(_c++).toString(36)}`

export function FlowchartPanel() {
  const draft = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') } catch { return null } })()
  const [chartId, setChartId] = useState<string>(draft?.id || nid())
  const [name, setName] = useState<string>(draft?.name || 'Untitled')
  const [xml, setXml] = useState<string>(draft?.xml || '')
  const [reloadKey, setReloadKey] = useState(0)
  const [saved, setSaved] = useState<Array<{ id: string; name: string; updatedAt?: string }>>([])
  const [showLoad, setShowLoad] = useState(false)
  const [status, setStatus] = useState('')
  const handleRef = useRef<DrawioHandle | null>(null)
  const curXml = useRef(xml); curXml.current = xml
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Local draft autosave so a browser refresh never loses in-progress work.
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: chartId, name, xml })) } catch { /* ignore */ } }, 500)
    return () => clearTimeout(t)
  }, [chartId, name, xml])

  const flash = (m: string) => { setStatus(m); setTimeout(() => setStatus(''), 1600) }

  const storeSave = useCallback(async (x: string) => {
    await api.save({ id: chartId, name: name.trim() || 'Untitled', xml: x, updatedAt: new Date().toISOString() })
  }, [chartId, name])

  // draw.io autosave stream: keep the working xml + debounce-persist to the shared store.
  const onAutoSave = useCallback((x: string) => {
    setXml(x)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { storeSave(x) }, 1500)
  }, [storeSave])

  // Explicit Save (draw.io toolbar Save button, or our Save button) persists immediately.
  const onSave = useCallback(async (x: string) => { setXml(x); await storeSave(x); setSaved(await api.list()); flash('Saved') }, [storeSave])
  const doSave = useCallback(async () => { await onSave(curXml.current) }, [onSave])

  const doNew = useCallback(() => { setChartId(nid()); setName('Untitled'); setXml(''); setReloadKey((k) => k + 1) }, [])
  const openLoad = useCallback(async () => { setSaved(await api.list()); setShowLoad(true) }, [])
  const doLoad = useCallback(async (id: string) => {
    const c = await api.load(id); if (!c) return
    setChartId(c.id); setName(c.name || 'Untitled'); setXml(c.xml || ''); setReloadKey((k) => k + 1); setShowLoad(false)
  }, [])

  const exportAs = useCallback((format: 'xmlpng' | 'xmlsvg') => handleRef.current?.export(format), [])
  const onExport = useCallback((data: string, format: string) => {
    const a = document.createElement('a')
    a.href = data
    a.download = `${(name || 'diagram').replace(/[^\w.-]+/g, '_')}.${format.includes('svg') ? 'svg' : 'png'}`
    document.body.appendChild(a); a.click(); a.remove()
  }, [name])

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <input className={styles.nameInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Diagram name" />
        <button className={styles.btn} onClick={doSave} title="Save to the shared server store"><Save size={13} /> Save</button>
        <button className={styles.btn} onClick={openLoad} title="Open a saved diagram"><FolderOpen size={13} /> Open</button>
        <button className={styles.btn} onClick={doNew} title="New blank diagram"><FilePlus2 size={13} /> New</button>
        <span className={styles.sep} />
        <button className={styles.btn} onClick={() => exportAs('xmlpng')} title="Export PNG"><ImageIcon size={13} /> PNG</button>
        <button className={styles.btn} onClick={() => exportAs('xmlsvg')} title="Export SVG"><Download size={13} /> SVG</button>
        <span className={styles.spacer} />
        {status && <span className={styles.dim}>{status}</span>}
      </div>

      <div className={styles.canvas}>
        <DrawioEmbed
          xml={xml}
          reloadKey={reloadKey}
          onSave={onSave}
          onAutoSave={onAutoSave}
          onExport={onExport}
          handleRef={(h) => { handleRef.current = h }}
        />
      </div>

      {showLoad && (
        <div className={styles.modalBg} onClick={() => setShowLoad(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>Saved diagrams</div>
            {saved.length === 0 && <div className={styles.dim}>No saved diagrams yet.</div>}
            {saved.map((c) => (
              <div key={c.id} className={styles.savedRow}>
                <button className={styles.savedName} onClick={() => doLoad(c.id)}>{c.name}</button>
                <span className={styles.dim}>{c.updatedAt ? new Date(c.updatedAt).toLocaleString() : ''}</span>
                <button className={styles.savedDel} title="Delete" onClick={async () => { await api.remove(c.id); setSaved(await api.list()) }}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
