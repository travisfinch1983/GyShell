import React, { useState } from 'react'
import { Settings, RefreshCw, Save, RotateCcw, X, LayoutGrid } from 'lucide-react'
import { confirmStore } from '../../stores/confirmStore'
import { DynacatBuilder } from './DynacatBuilder'

/**
 * Home tab — embeds the Dynacat dashboard (lab status + news), served same-origin via the Vite /dash proxy.
 * A thin toolbar adds a YAML config editor (GET/PUT/regenerate on /api/dynacat): Dynacat's config is normally
 * auto-generated every 10 min from cluster inventory, so saving a manual edit pins a manual-override that
 * pauses the generator; "Reset to auto-generated" hands control back. v1 is a raw YAML editor — a GUI comes later.
 */
export const HomePanel: React.FC = () => {
  const [editing, setEditing] = useState(false)
  const [yaml, setYaml] = useState('')
  const [orig, setOrig] = useState('')
  const [manual, setManual] = useState(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [iframeKey, setIframeKey] = useState(0)
  const [building, setBuilding] = useState(false)

  const open = async () => {
    setEditing(true); setStatus('Loading…')
    try {
      const r = await fetch('/api/dynacat/config').then((x) => x.json())
      setYaml(r.yaml || ''); setOrig(r.yaml || ''); setManual(!!r.manualOverride); setStatus('')
    } catch (e: any) { setStatus('Load failed: ' + (e?.message || e)) }
  }

  const save = async () => {
    setBusy(true); setStatus('Validating + saving…')
    try {
      const res = await fetch('/api/dynacat/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml }),
      })
      const r = await res.json()
      if (!res.ok || r.ok === false) { setStatus('✗ ' + (r.error || `HTTP ${res.status}`)); return }
      setOrig(yaml); setManual(true); setStatus('✓ Saved — dashboard reloaded (manual mode on)'); setIframeKey((k) => k + 1)
    } catch (e: any) { setStatus('Save failed: ' + (e?.message || e)) } finally { setBusy(false) }
  }

  const resetAuto = async () => {
    if (!(await confirmStore.confirm({
      title: 'Reset to auto-generated?',
      message: 'Discard your manual edits and rebuild the dashboard from the live cluster inventory? Auto-refresh (every 10 min) resumes.',
      confirmText: 'Reset to auto', danger: true,
    }))) return
    setBusy(true); setStatus('Regenerating from inventory…')
    try {
      const res = await fetch('/api/dynacat/regenerate', { method: 'POST' })
      const r = await res.json()
      if (!res.ok || r.ok === false) { setStatus('✗ ' + (r.error || `HTTP ${res.status}`)); return }
      setYaml(r.yaml || ''); setOrig(r.yaml || ''); setManual(false); setStatus('✓ Reset — auto-generation resumed'); setIframeKey((k) => k + 1)
    } catch (e: any) { setStatus('Reset failed: ' + (e?.message || e)) } finally { setBusy(false) }
  }

  const bar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: '1px solid var(--border)', flex: '0 0 auto', fontSize: 12 }
  const btn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--control-bg)', color: 'var(--fg)', cursor: 'pointer' }

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--app-bg)', display: 'flex', flexDirection: 'column' }}>
      <div style={bar}>
        <strong style={{ fontSize: 12 }}>Home Dashboard</strong>
        <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--border)', color: manual ? 'var(--accent)' : 'var(--fg-faint)' }}>
          {manual ? 'manual config' : 'auto-generated'}
        </span>
        <span style={{ flex: 1 }} />
        <button style={btn} onClick={() => setIframeKey((k) => k + 1)} title="Reload dashboard"><RefreshCw size={12} /> Reload</button>
        <button style={btn} onClick={() => setBuilding(true)}><LayoutGrid size={12} /> Build dashboard</button>
        <button style={btn} onClick={() => void open()}><Settings size={12} /> Edit config</button>
      </div>
      {building && (
        <DynacatBuilder
          onClose={() => setBuilding(false)}
          onSaved={() => { setManual(true); setIframeKey((k) => k + 1) }}
          openRaw={() => { setBuilding(false); void open() }}
        />
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <iframe key={iframeKey} src="/dash/" title="Dashboard" style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} />
      </div>

      {editing && (
        <div onClick={() => setEditing(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(900px, 94%)', height: '88%', background: 'var(--app-bg)', border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <strong>Dynacat config — dynacat.yml</strong>
              <span style={{ fontSize: 11, color: manual ? 'var(--accent)' : 'var(--fg-faint)' }}>{manual ? 'manual mode (auto-regen paused)' : 'auto-generated (saving switches to manual mode)'}</span>
              <span style={{ flex: 1 }} />
              <button style={btn} onClick={() => setEditing(false)}><X size={13} /></button>
            </div>
            <textarea spellCheck={false} value={yaml} onChange={(e) => setYaml(e.target.value)} style={{ flex: 1, minHeight: 0, resize: 'none', border: 'none', padding: 12, background: 'var(--app-bg)', color: 'var(--fg)', fontFamily: 'var(--font-mono, monospace)', fontSize: 12.5, lineHeight: 1.5, outline: 'none' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', flex: 1, whiteSpace: 'pre-wrap' }}>{status}</span>
              <button style={btn} disabled={busy} onClick={() => void resetAuto()}><RotateCcw size={13} /> Reset to auto-generated</button>
              <button style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 600 }} disabled={busy || yaml === orig} onClick={() => void save()}><Save size={13} /> Validate & Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
