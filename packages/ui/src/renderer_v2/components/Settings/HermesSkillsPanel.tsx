/**
 * HermesSkillsPanel — Settings › Skills, repointed at the HERMES skills
 * LIBRARY (2f264d2; Travis's option a — the old AI-Lab SkillService view is
 * retired wholesale). Library curation only: browse all skills grouped by
 * category with builtin/local source badges, view/edit each SKILL.md, and
 * create new ones (PUT to a fresh ref like "custom/my-skill" creates the
 * dir). Per-agent skill ASSIGNMENT is a separate coming lane on the agent
 * editor — not here.
 *
 * Same wipe-guard discipline as the doc editors: the editor only opens when
 * the GET actually returned content; creation is an explicit act via the New
 * skill flow; Save is change-only.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { FileText, Plus, RefreshCw, Save, Search, Undo2, X } from 'lucide-react'
import { hermesApi } from '../../stores/hermesApi'

interface SkillEntry { ref: string; name: string; dir: string; category: string; description: string; source: 'builtin' | 'local' }
interface OpenSkill { ref: string; content: string; base: string; isNew: boolean }

const badgeStyle = (source: string): React.CSSProperties => ({
  fontSize: 10,
  fontWeight: 600,
  padding: '1px 7px',
  borderRadius: 9,
  flexShrink: 0,
  background: source === 'local'
    ? 'color-mix(in srgb, var(--accent) 18%, transparent)'
    : 'color-mix(in srgb, var(--fg-muted) 14%, transparent)',
  color: source === 'local' ? 'var(--accent)' : 'var(--fg-muted)',
})

export const HermesSkillsPanel: React.FC = () => {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<OpenSkill | null>(null)
  const [busyRef, setBusyRef] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [newRef, setNewRef] = useState('')

  const load = () =>
    hermesApi.listSkills().then((s) => {
      if (s === null) setErr('Failed to list the Hermes skills library — host unreachable?')
      else { setSkills(s); setErr('') }
    })
  useEffect(() => { void load() }, [])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (s: SkillEntry) =>
      !q || s.ref.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    const byCat = new Map<string, SkillEntry[]>()
    for (const s of (skills ?? []).filter(match)) {
      const list = byCat.get(s.category) ?? []
      list.push(s)
      byCat.set(s.category, list)
    }
    return [...byCat.entries()]
      .sort(([a], [b]) => (a === 'custom' ? -1 : b === 'custom' ? 1 : a.localeCompare(b)))
      .map(([category, items]) => ({ category, items: items.sort((a, b) => a.ref.localeCompare(b.ref)) }))
  }, [skills, filter])

  const openSkill = async (ref: string, isNew = false) => {
    setBusyRef(ref); setMsg('')
    const content = isNew ? '' : await hermesApi.getSkill(ref)
    setBusyRef('')
    if (content === null) { setMsg(`Couldn't read ${ref} — not opening an empty editor over a real skill.`); return }
    setOpen({ ref, content, base: content, isNew })
  }

  const startNew = () => {
    const ref = newRef.trim().replace(/^\/+|\/+$/g, '')
    if (!ref) return
    if (skills?.some((s) => s.ref === ref)) { setMsg(`${ref} already exists — opening it instead.`); void openSkill(ref); return }
    setNewRef('')
    void openSkill(ref, true)
  }

  const save = async () => {
    if (!open || (open.content === open.base && !open.isNew)) return
    setSaving(true); setMsg('')
    const r = await hermesApi.putSkill(open.ref, open.content)
    setSaving(false)
    if (!r.ok) { setMsg(`Save failed: ${r.error ?? 'unknown'}`); return }
    setOpen({ ...open, base: open.content, isNew: false })
    setMsg('Saved ✓')
    await load()
  }

  if (open) {
    const dirty = open.content !== open.base
    return (
      <>
        <div className="settings-section-header">
          <div className="settings-section-title">
            <FileText size={16} strokeWidth={2} />
            <span style={{ marginLeft: 8, fontFamily: 'var(--font-mono)' }}>{open.ref}/SKILL.md</span>
            {open.isNew && <span style={badgeStyle('local')}>new — created on save</span>}
          </div>
          <div className="settings-actions">
            <button className="btn-secondary" disabled={saving || !dirty} title="Discard changes" onClick={() => setOpen({ ...open, content: open.base })}>
              <Undo2 size={14} /> Revert
            </button>
            <button className="btn-primary" disabled={saving || (!dirty && !open.isNew)} onClick={() => void save()}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              className="btn-secondary"
              title="Back to the library"
              onClick={() => { if (!dirty || window.confirm(`Discard unsaved changes to ${open.ref}?`)) { setOpen(null); setMsg('') } }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {msg && <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>{msg}</div>}
        <textarea
          value={open.content}
          onChange={(e) => setOpen({ ...open, content: e.target.value })}
          spellCheck={false}
          placeholder={open.isNew ? '---\nname: my-skill\ndescription: what it does\n---\n\n# Instructions…' : undefined}
          style={{
            width: '100%',
            minHeight: 480,
            resize: 'vertical',
            padding: 10,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--control-bg)',
            color: 'var(--fg)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12.5,
            lineHeight: 1.5,
            boxSizing: 'border-box',
          }}
        />
      </>
    )
  }

  return (
    <>
      <div className="settings-section-header">
        <div className="settings-section-title">Skills — Hermes library</div>
        <div className="settings-actions">
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <Search size={13} style={{ position: 'absolute', left: 8, color: 'var(--fg-faint)', pointerEvents: 'none' }} />
            <input
              value={filter}
              placeholder="filter skills…"
              onChange={(e) => setFilter(e.target.value)}
              style={{ height: 28, padding: '0 8px 0 26px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--control-bg)', color: 'var(--fg)', fontSize: 12, width: 200 }}
            />
          </span>
          <button className="btn-icon-reload" onClick={() => void load()} title="Reload the library">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
        The shared Hermes skills library ({skills?.length ?? '…'} skills) — every agent draws from here.
        Edit a skill's SKILL.md or create new ones under <code>custom/</code>. Per-agent assignment lives on
        each agent's editor (coming).
      </p>

      <div className="settings-row" style={{ marginBottom: 8 }}>
        <div className="settings-row-label-with-info">
          <label>New skill</label>
        </div>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <input
            value={newRef}
            placeholder="custom/my-skill"
            onChange={(e) => setNewRef(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') startNew() }}
            style={{ height: 28, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--control-bg)', color: 'var(--fg)', fontSize: 12, fontFamily: 'var(--font-mono)', width: 240 }}
          />
          <button className="btn-secondary" disabled={!newRef.trim()} onClick={startNew}>
            <Plus size={14} /> Create
          </button>
        </span>
      </div>

      {err && <div className="settings-error" style={{ marginBottom: 8 }}>{err}</div>}
      {!skills && !err && <div className="tool-empty">Loading the skills library…</div>}
      {msg && <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>{msg}</div>}

      {groups.map((g) => (
        <React.Fragment key={g.category}>
          <div className="settings-divider settings-divider-spaced">
            <span>{g.category}</span>
            <i />
          </div>
          <div className="tools-list">
            {g.items.map((s) => (
              <div key={s.ref} className="tool-item">
                <div className="tool-info">
                  <div className="tool-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {s.name}
                    <span style={badgeStyle(s.source)}>{s.source}</span>
                  </div>
                  <div className="tool-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.ref}</div>
                  {s.description && <div className="tool-meta">{s.description.replace(/^"|"$/g, '')}</div>}
                </div>
                <div className="tool-actions">
                  <button className="btn-secondary" disabled={busyRef === s.ref} onClick={() => void openSkill(s.ref)}>
                    {busyRef === s.ref ? 'Opening…' : 'Open →'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </React.Fragment>
      ))}
      {skills && groups.length === 0 && <div className="tool-empty">No skills match “{filter}”.</div>}
    </>
  )
}
