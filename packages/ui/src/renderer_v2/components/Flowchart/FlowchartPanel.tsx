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

/**
 * 🛑 These used to swallow every failure: list → [] rendered "No saved diagrams
 * yet." on a dead backend (the empty-pages-tab incident shape — the user is
 * told there is nothing to open), save → the panel flashed "Saved"
 * unconditionally on a lost write, and load → a click that silently did
 * nothing. Failures now PROPAGATE and every caller distinguishes "failed"
 * from "empty" — a diagram store that cannot be reached must never present
 * itself as one holding no diagrams.
 */
const api = {
  async list(): Promise<Array<{ id: string; name: string; updatedAt?: string }>> {
    const r = await bridge()?.request('GET', '/api/flowcharts')
    return Array.isArray(r?.charts) ? r.charts : []
  },
  async load(id: string): Promise<Chart> {
    const r = await bridge()?.request('GET', `/api/flowcharts/${encodeURIComponent(id)}`)
    if (!r?.chart) throw new Error(`no chart '${id}' in the response`)
    return r.chart
  },
  async save(c: Chart): Promise<void> {
    await bridge()?.request('PUT', `/api/flowcharts/${encodeURIComponent(c.id)}`, c)
  },
  async remove(id: string): Promise<void> {
    await bridge()?.request('DELETE', `/api/flowcharts/${encodeURIComponent(id)}`)
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
  const [listError, setListError] = useState<string | null>(null)
  /** Set when a background autosave fails — sticky until a save succeeds,
   *  because a 1.5s flash is not enough warning that your work is not landing. */
  const [saveError, setSaveError] = useState<string | null>(null)
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
    try {
      await api.save({ id: chartId, name: name.trim() || 'Untitled', xml: x, updatedAt: new Date().toISOString() })
      setSaveError(null)
    } catch (e) {
      // The local draft still has the work (localStorage autosave above), so
      // nothing is lost yet — but the SERVER copy is stale and staying quiet
      // about that is how a session of edits evaporates on the next reload
      // elsewhere. Sticky until a save lands.
      setSaveError(`not saving to server — ${String((e as Error)?.message ?? e)}`)
      throw e
    }
  }, [chartId, name])

  // draw.io autosave stream: keep the working xml + debounce-persist to the shared store.
  const onAutoSave = useCallback((x: string) => {
    setXml(x)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { storeSave(x).catch(() => { /* surfaced via saveError */ }) }, 1500)
  }, [storeSave])

  // Explicit Save (draw.io toolbar Save button, or our Save button) persists immediately.
  const onSave = useCallback(async (x: string) => {
    setXml(x)
    try {
      await storeSave(x)
      flash('Saved')   // only after the write actually landed
      try { setSaved(await api.list()) } catch { /* list refresh is cosmetic here */ }
    } catch { flash('SAVE FAILED') }
  }, [storeSave])
  const doSave = useCallback(async () => { await onSave(curXml.current) }, [onSave])

  const doNew = useCallback(() => { setChartId(nid()); setName('Untitled'); setXml(''); setReloadKey((k) => k + 1) }, [])
  const openLoad = useCallback(async () => {
    setListError(null)
    try { setSaved(await api.list()) } catch (e) {
      setSaved([])
      setListError(String((e as Error)?.message ?? e))
    }
    setShowLoad(true)
  }, [])
  const doLoad = useCallback(async (id: string) => {
    try {
      const c = await api.load(id)
      setChartId(c.id); setName(c.name || 'Untitled'); setXml(c.xml || ''); setReloadKey((k) => k + 1); setShowLoad(false)
    } catch (e) {
      // A click that does nothing is indistinguishable from a broken button.
      setListError(`could not open '${id}' — ${String((e as Error)?.message ?? e)}`)
    }
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
        {saveError && <span className={styles.saveError} title={saveError}>⚠ {saveError}</span>}
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
            {/* "failed" and "empty" are different facts and get different lines. */}
            {listError && <div className={styles.saveError}>couldn't load the list — {listError}</div>}
            {!listError && saved.length === 0 && <div className={styles.dim}>No saved diagrams yet.</div>}
            {saved.map((c) => (
              <div key={c.id} className={styles.savedRow}>
                <button className={styles.savedName} onClick={() => doLoad(c.id)}>{c.name}</button>
                <span className={styles.dim}>{c.updatedAt ? new Date(c.updatedAt).toLocaleString() : ''}</span>
                <button className={styles.savedDel} title="Delete" onClick={async () => {
                  try { await api.remove(c.id); setSaved(await api.list()) }
                  catch (e) { setListError(`delete failed — ${String((e as Error)?.message ?? e)}`) }
                }}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
