/**
 * AgentDocs — the "Docs" section of the Hermes agent editor: list + edit the
 * agent's config .md operating docs (IDENTITY/USER/MEMORY/TOOLS/… plus the
 * workspace/library/* guides) via GET/PUT /api/hermes/agents/:id/doc
 * (backend 14e5fd8; path-validated server-side).
 *
 * SOUL.md is EXCLUDED — the Persona section owns it (one editor per file).
 * Safety mirrors the soul flow: the editor only opens when the GET actually
 * returned content (never on ''), and Save is change-only — so a read failure
 * can never turn into a blank PUT that wipes a real doc.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { FileText, Save, Undo2, X } from 'lucide-react'
import { hermesApi } from '../../stores/hermesApi'
import styles from './Agents.module.scss'

interface DocEntry { path: string; bytes: number }
interface OpenDoc { path: string; content: string; base: string }

const fmtBytes = (b: number): string => (b >= 10240 ? `${Math.round(b / 1024)} KB` : b >= 1024 ? `${Math.round((b / 1024) * 10) / 10} KB` : `${b} B`)
const baseName = (p: string): string => p.split('/').pop() ?? p
const isSoul = (p: string): boolean => baseName(p).toUpperCase() === 'SOUL.MD'

export const AgentDocs: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [docs, setDocs] = useState<DocEntry[] | null>(null)
  const [listErr, setListErr] = useState('')
  const [open, setOpen] = useState<OpenDoc | null>(null)
  const [busyPath, setBusyPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void hermesApi.listDocs(agentId).then((d) => {
      if (d === null) setListErr('Failed to list this agent’s docs — Hermes host unreachable?')
      else setDocs(d.filter((x) => !isSoul(x.path)))
    })
  }, [agentId])

  const groups = useMemo(() => {
    const workspace: DocEntry[] = []
    const library: DocEntry[] = []
    const other: DocEntry[] = []
    for (const d of docs ?? []) {
      if (d.path.startsWith('workspace/library/')) library.push(d)
      else if (d.path.startsWith('workspace/')) workspace.push(d)
      else other.push(d)
    }
    const byName = (a: DocEntry, b: DocEntry) => a.path.localeCompare(b.path)
    return [
      { label: 'Workspace docs', items: workspace.sort(byName) },
      { label: 'Library', items: library.sort(byName) },
      { label: 'Other', items: other.sort(byName) },
    ].filter((g) => g.items.length > 0)
  }, [docs])

  const openDoc = async (path: string) => {
    setBusyPath(path); setMsg('')
    const content = await hermesApi.getDoc(agentId, path)
    setBusyPath('')
    if (content === null) { setMsg(`Couldn't read ${path} — not opening an empty editor over a real file.`); return }
    setOpen({ path, content, base: content })
  }

  const save = async () => {
    if (!open || open.content === open.base) return
    setSaving(true); setMsg('')
    const r = await hermesApi.putDoc(agentId, open.path, open.content)
    setSaving(false)
    if (!r.ok) { setMsg(`Save failed: ${r.error ?? 'unknown'}`); return }
    const bytes = new TextEncoder().encode(open.content).length
    setDocs((prev) => prev?.map((d) => (d.path === open.path ? { ...d, bytes } : d)) ?? prev)
    setOpen({ ...open, base: open.content })
    setMsg('Saved ✓')
  }

  if (open) {
    const dirty = open.content !== open.base
    return (
      <div className={styles.card}>
        <div className={styles.summaryRow}>
          <FileText size={15} />
          <div>
            <strong className={styles.mono}>{open.path}</strong>
            <div className={styles.dim}>{open.content.split('\n').length} lines · {open.content.length} chars{dirty ? ' · unsaved changes' : ''}</div>
          </div>
          <span className={styles.spacer} />
          <button className={styles.btn} disabled={saving || !dirty} title="Discard changes" onClick={() => setOpen({ ...open, content: open.base })}>
            <Undo2 size={13} /> Revert
          </button>
          <button className={styles.btnPrimary} disabled={saving || !dirty} onClick={() => void save()}>
            <Save size={13} /> {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            className={styles.btn}
            title="Close"
            onClick={() => { if (!dirty || window.confirm(`Discard unsaved changes to ${open.path}?`)) { setOpen(null); setMsg('') } }}
          >
            <X size={13} />
          </button>
        </div>
        {msg && <div className={styles.dim} style={{ marginTop: 6 }}>{msg}</div>}
        <textarea
          className={`${styles.soul} ${styles.mono}`}
          value={open.content}
          onChange={(e) => setOpen({ ...open, content: e.target.value })}
          spellCheck={false}
        />
      </div>
    )
  }

  return (
    <div className={styles.card}>
      {listErr && <div className={styles.dim}>{listErr}</div>}
      {!docs && !listErr && <div className={styles.dim}>Loading docs…</div>}
      {docs?.length === 0 && <div className={styles.dim}>No config docs found for this agent.</div>}
      {groups.map((g) => (
        <div key={g.label} style={{ marginBottom: 10 }}>
          <div className={styles.dim} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>{g.label}</div>
          {g.items.map((d) => (
            <div key={d.path} className={styles.summaryRow} style={{ padding: '3px 0' }}>
              <FileText size={13} />
              <span className={styles.mono} style={{ fontSize: 12 }}>{baseName(d.path)}</span>
              <span className={styles.dim} style={{ fontSize: 11 }}>{fmtBytes(d.bytes)}</span>
              <span className={styles.spacer} />
              <button className={styles.btn} disabled={busyPath === d.path} onClick={() => void openDoc(d.path)}>
                {busyPath === d.path ? 'Opening…' : 'Open →'}
              </button>
            </div>
          ))}
        </div>
      ))}
      {msg && <div className={styles.dim}>{msg}</div>}
    </div>
  )
}
