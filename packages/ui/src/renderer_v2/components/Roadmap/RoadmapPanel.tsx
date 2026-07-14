/**
 * RoadmapPanel — the Roadmap primary tab (Travis request, 2026-07-14).
 *
 * One living buildout-plan document: markdown with GFM task-list checklists,
 * served whole by the backend (GET /api/roadmap → { markdown }, PUT { markdown }
 * → { ok, bytes } — full-document overwrite). Read-only rendered view by
 * default; Edit toggles a textarea over the raw markdown, Save PUTs it back.
 *
 * Transport is the cluster bridge (same call path as the Support Models tab's
 * /api/hermes routes) — /api/roadmap is in ClusterService's ALLOWED_PREFIXES +
 * LOCAL_PREFIXES as of f1626a2.
 *
 * Wipe guard (house rule): the editor can only be opened from a successfully
 * loaded document, so a failed GET can never become a blind full-document PUT.
 */

import React, { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Map as MapIcon, Pencil, RefreshCw, Save, X } from 'lucide-react'
import './roadmap.scss'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

export const RoadmapPanel: React.FC = () => {
  const [markdown, setMarkdown] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  const load = async () => {
    setState('loading')
    setStatus('')
    try {
      const data = await bridge().request('GET', '/api/roadmap')
      if (typeof data?.markdown !== 'string') throw new Error('bad shape')
      setMarkdown(data.markdown)
      setState('ready')
    } catch {
      setState('error')
    }
  }

  useEffect(() => { void load() }, [])

  const startEdit = () => {
    setDraft(markdown)
    setStatus('')
    setEditing(true)
  }

  const save = async () => {
    if (draft === markdown) { setEditing(false); return } // change-only save
    setSaving(true)
    setStatus('')
    try {
      const data = await bridge().request('PUT', '/api/roadmap', { markdown: draft })
      if (data?.ok === false || data?.error) throw new Error(String(data?.error ?? 'save rejected'))
      setMarkdown(draft)
      setEditing(false)
      setStatus(`saved${typeof data?.bytes === 'number' ? ` — ${data.bytes.toLocaleString()} bytes` : ''}`)
    } catch (e) {
      setStatus(`save failed — ${String((e as Error)?.message ?? e)}; your edits are still in the editor`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="roadmap-panel">
      <div className="roadmap-header">
        <MapIcon size={16} />
        <span className="roadmap-title">Roadmap</span>
        <span className="roadmap-status">{status}</span>
        {state === 'ready' && !editing && (
          <>
            <button className="roadmap-btn" onClick={() => void load()} title="Reload from server">
              <RefreshCw size={12} /> Reload
            </button>
            <button className="roadmap-btn" onClick={startEdit} title="Edit the roadmap markdown">
              <Pencil size={12} /> Edit
            </button>
          </>
        )}
        {editing && (
          <>
            <button className="roadmap-btn" onClick={() => { setEditing(false); setStatus('') }} disabled={saving}>
              <X size={12} /> Cancel
            </button>
            <button className="roadmap-btn is-primary" onClick={() => void save()} disabled={saving}>
              <Save size={12} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>

      <div className="roadmap-body">
        {state === 'loading' ? (
          <div className="roadmap-empty">Loading roadmap…</div>
        ) : state === 'error' ? (
          <div className="roadmap-empty">
            Could not load the roadmap.{' '}
            <button className="roadmap-btn" onClick={() => void load()}>Retry</button>
          </div>
        ) : editing ? (
          <textarea
            className="roadmap-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            disabled={saving}
          />
        ) : (
          <div className="roadmap-doc markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
