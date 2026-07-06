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
import { FileText, Save, Trash2, Undo2, X } from 'lucide-react'
import { hermesApi } from '../../stores/hermesApi'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Agents.module.scss'

interface DocEntry { path: string; bytes: number; protected?: boolean }
interface OpenDoc { path: string; content: string; base: string }

const fmtBytes = (b: number): string => (b >= 10240 ? `${Math.round(b / 1024)} KB` : b >= 1024 ? `${Math.round((b / 1024) * 10) / 10} KB` : `${b} B`)
const baseName = (p: string): string => p.split('/').pop() ?? p
const isSoul = (p: string): boolean => baseName(p).toUpperCase() === 'SOUL.MD'

/**
 * InlineDocEditor — one specific doc embedded in a contextual tab (Identity →
 * IDENTITY.md, Tools → TOOLS.md/EXECUTION.md, …). Collapsed row until opened;
 * fetch-on-open with the same guard as the Docs list: a thrown GET (host down)
 * refuses to open, while 200+'' means the file genuinely doesn't exist yet —
 * that opens an empty editor and Save creates it (the backend PUT writes the
 * file). The Docs tab still edits everything in one place; these are the
 * contextually-placed twins.
 */
export const InlineDocEditor: React.FC<{ agentId: string; path: string; hint?: string }> = ({ agentId, path, hint }) => {
  const [open, setOpen] = useState<OpenDoc | null>(null)
  const [opening, setOpening] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [missing, setMissing] = useState(false)

  const openDoc = async () => {
    setOpening(true); setMsg('')
    const content = await hermesApi.getDoc(agentId, path)
    setOpening(false)
    if (content === null) { setMsg(`Couldn't read ${path} — not opening an empty editor over a real file.`); return }
    setMissing(content === '')
    setOpen({ path, content, base: content })
  }

  const save = async () => {
    if (!open || open.content === open.base) return
    setSaving(true); setMsg('')
    const r = await hermesApi.putDoc(agentId, open.path, open.content)
    setSaving(false)
    if (!r.ok) { setMsg(`Save failed: ${r.error ?? 'unknown'}`); return }
    setMissing(false)
    setOpen({ ...open, base: open.content })
    setMsg('Saved ✓')
  }

  if (!open) {
    return (
      <div className={styles.card}>
        <div className={styles.summaryRow}>
          <FileText size={15} />
          <div>
            <strong className={styles.mono}>{baseName(path)}</strong>
            {hint && <div className={styles.dim}>{hint}</div>}
          </div>
          <span className={styles.spacer} />
          <button className={styles.btn} disabled={opening} onClick={() => void openDoc()}>
            {opening ? 'Opening…' : 'Open editor →'}
          </button>
        </div>
        {msg && <div className={styles.dim} style={{ marginTop: 6 }}>{msg}</div>}
      </div>
    )
  }

  const dirty = open.content !== open.base
  return (
    <div className={styles.card}>
      <div className={styles.summaryRow}>
        <FileText size={15} />
        <div>
          <strong className={styles.mono}>{open.path}</strong>
          <div className={styles.dim}>
            {missing && !dirty ? 'new file — created on save' : `${open.content.split('\n').length} lines · ${open.content.length} chars`}
            {dirty ? ' · unsaved changes' : ''}
          </div>
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
          title="Close editor"
          onClick={() => { if (!dirty || window.confirm(`Discard unsaved changes to ${open.path}?`)) { setOpen(null); setMsg('') } }}
        >
          <X size={13} />
        </button>
      </div>
      {msg && <div className={styles.dim} style={{ marginTop: 6 }}>{msg}</div>}
      <textarea
        className={`${styles.soul} ${styles.mono}`}
        value={open.content}
        placeholder={missing ? `# ${baseName(path)}\n(new file — Save will create it on the Hermes host)` : undefined}
        onChange={(e) => setOpen({ ...open, content: e.target.value })}
        spellCheck={false}
      />
    </div>
  )
}

/** The Hermes `default` profile is the template store — its own Docs view
 *  must not offer "add from template" to itself. */
const TEMPLATE_AGENT = 'default'

export const AgentDocs: React.FC<{
  agentId: string
  /** Include SOUL.md in the list — for the Doc Templates panel (agentId
   *  "default"), where no Persona tab owns it. Per-agent Docs tabs keep it
   *  filtered (one editor per file). */
  includeSoul?: boolean
}> = ({ agentId, includeSoul = false }) => {
  const [docs, setDocs] = useState<DocEntry[] | null>(null)
  const [listErr, setListErr] = useState('')
  const [open, setOpen] = useState<OpenDoc | null>(null)
  const [busyPath, setBusyPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [templates, setTemplates] = useState<DocEntry[]>([])
  const [templatePick, setTemplatePick] = useState('')
  const [addingTemplate, setAddingTemplate] = useState(false)

  const loadDocs = () =>
    hermesApi.listDocs(agentId).then((d) => {
      if (d === null) setListErr('Failed to list this agent’s docs — Hermes host unreachable?')
      else setDocs(includeSoul ? d : d.filter((x) => !isSoul(x.path)))
    })

  useEffect(() => {
    void loadDocs()
    if (agentId !== TEMPLATE_AGENT) {
      void hermesApi.listDocs(TEMPLATE_AGENT).then((t) => setTemplates(t ?? []))
    }
  }, [agentId, includeSoul])

  // Offer only templates the agent doesn't already have (by basename).
  const have = new Set((docs ?? []).map((d) => baseName(d.path).toLowerCase()))
  const addable = agentId === TEMPLATE_AGENT
    ? []
    : templates.filter((t) => !isSoul(t.path) && !have.has(baseName(t.path).toLowerCase()))

  const addFromTemplate = async () => {
    if (!templatePick) return
    setAddingTemplate(true); setMsg('')
    const r = await hermesApi.addDoc(agentId, templatePick)
    setAddingTemplate(false)
    if (!r.ok) { setMsg(`Add from template failed: ${r.error ?? 'unknown'}`); return }
    setTemplatePick('')
    setMsg(`Added ${r.path ?? baseName(templatePick)} ✓`)
    await loadDocs()
  }

  const groups = useMemo(() => {
    const workspace: DocEntry[] = []
    const library: DocEntry[] = []
    const memory: DocEntry[] = []
    const other: DocEntry[] = []
    for (const d of docs ?? []) {
      if (d.path.startsWith('workspace/library/')) library.push(d)
      else if (d.path.startsWith('workspace/memory/')) memory.push(d)
      else if (d.path.startsWith('workspace/')) workspace.push(d)
      else other.push(d)
    }
    const byName = (a: DocEntry, b: DocEntry) => a.path.localeCompare(b.path)
    return [
      { label: 'Workspace docs', items: workspace.sort(byName) },
      { label: 'Library', items: library.sort(byName) },
      { label: 'Memory logs', items: memory.sort(byName) },
      { label: 'Other', items: other.sort(byName) },
    ].filter((g) => g.items.length > 0)
  }, [docs])

  const deleteDoc = async (d: DocEntry) => {
    const isMemoryLog = d.path.startsWith('workspace/memory/')
    const sure = await confirmStore.confirm({
      title: 'Delete doc',
      message: isMemoryLog
        ? `Delete ${d.path}? This is part of the agent's daily-log MEMORY — not just a session summary. Deleting it loses that memory permanently.`
        : `Delete ${d.path} from the agent's workspace? This can't be undone.`,
      confirmText: 'Delete',
    })
    if (!sure) return
    setMsg('')
    const r = await hermesApi.deleteDoc(agentId, d.path)
    if (!r.ok) { setMsg(`Delete failed: ${r.error ?? 'unknown'}`); return }
    setMsg(`Deleted ${baseName(d.path)} ✓`)
    await loadDocs()
  }

  // Templates are never deletable from the panel, whatever the flag says.
  const canDelete = (d: DocEntry) => agentId !== TEMPLATE_AGENT && d.protected === false

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
              {canDelete(d) && (
                <button className={styles.btnDanger} title={`Delete ${baseName(d.path)}`} onClick={() => void deleteDoc(d)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
      {addable.length > 0 && (
        <div className={styles.summaryRow} style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <FileText size={13} />
          <span className={styles.dim} style={{ fontSize: 12 }}>Add from template</span>
          <span className={styles.spacer} />
          <select
            className={`${styles.input} ${styles.mono}`}
            style={{ maxWidth: 280 }}
            value={templatePick}
            onChange={(e) => setTemplatePick(e.target.value)}
            disabled={addingTemplate}
          >
            <option value="">pick a template…</option>
            {addable.map((t) => (
              <option key={t.path} value={t.path}>{baseName(t.path)} ({fmtBytes(t.bytes)})</option>
            ))}
          </select>
          <button className={styles.btn} disabled={!templatePick || addingTemplate} onClick={() => void addFromTemplate()}>
            {addingTemplate ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}
      {msg && <div className={styles.dim}>{msg}</div>}
    </div>
  )
}
