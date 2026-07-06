/**
 * AgentSkills — the "Skills" sub-tab of the Hermes agent editor: assign
 * library skills to this agent (9b44da7) + the library-doc↔skill bonding view
 * (fbd9cc3). The library itself is curated in Settings › Skills; this is
 * per-agent membership.
 *
 * Source semantics matter here: `local` (custom) skills are the durably
 * toggleable ones — assign copies the skill into the agent, unassign removes
 * it. `builtin` skills are seeded into EVERY agent by Hermes and re-seed on
 * update, so unassigning one isn't durable — their checkboxes render at the
 * reported state but LOCKED (a toggle that silently reverts is a lie), with
 * the re-seed hint. Custom group first. Optimistic toggles, refetch on error.
 *
 * Library docs are CENTRAL (agents hold TOOLS.md pointers, never copies).
 * Bonded docs (doc.skill === skill.name) nest under their skill — assigning
 * the skill auto-injects the pointer. Each doc row: Edit (the central doc —
 * one edit, every agent sees it) and a STATEFUL pointer toggle bound to the
 * per-agent `pointed` read-back (5a8da3d) — on/off drives POST library-doc
 * {name, assigned}, optimistic, refetch on error. General docs (skill:null)
 * sit in their own "library reference" group.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { FileText, Save, Search, Undo2, X } from 'lucide-react'
import { hermesApi } from '../../stores/hermesApi'
import styles from './Agents.module.scss'

interface SkillRow { ref: string; name: string; category: string; description: string; source: 'builtin' | 'local'; assigned: boolean }

/** Rows per expanded category before "show more" — the library is ~791 skills
 *  (claude-extended alone is 540), so groups collapse and paginate. */
const PAGE = 60
interface LibDoc { name: string; title: string; skills: string[]; pointed: boolean }
interface OpenLibDoc { name: string; content: string; base: string }

export const AgentSkills: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [skills, setSkills] = useState<SkillRow[] | null>(null)
  const [library, setLibrary] = useState<LibDoc[]>([])
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('')
  const [busyRef, setBusyRef] = useState('')
  const [openDoc, setOpenDoc] = useState<OpenLibDoc | null>(null)
  const [docBusy, setDocBusy] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [activeCats, setActiveCats] = useState<Set<string> | null>(null)
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set(['custom']))
  const [pages, setPages] = useState<Map<string, number>>(new Map())

  const load = () =>
    hermesApi.listAgentSkills(agentId).then((s) => {
      if (s === null) setErr('Failed to list skills — Hermes host unreachable?')
      else { setSkills(s); setErr('') }
    })
  const loadLibrary = () => hermesApi.listAgentLibraryDocs(agentId).then((d) => setLibrary(d ?? []))
  useEffect(() => {
    void load()
    void loadLibrary()
  }, [agentId])

  // Many-to-many since 2597fb2: a doc can nest under several skills.
  const docsBySkill = useMemo(() => {
    const m = new Map<string, LibDoc[]>()
    for (const d of library) {
      for (const s of d.skills) {
        const list = m.get(s) ?? []
        list.push(d)
        m.set(s, list)
      }
    }
    return m
  }, [library])
  const referenceDocs = useMemo(() => library.filter((d) => d.skills.length === 0), [library])

  const catCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of skills ?? []) m.set(s.category, (m.get(s.category) ?? 0) + 1)
    return [...m.entries()].sort(([a], [b]) => (a === 'custom' ? -1 : b === 'custom' ? 1 : a.localeCompare(b)))
  }, [skills])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (s: SkillRow) =>
      (!activeCats || activeCats.has(s.category)) &&
      (!q || s.ref.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    const byCat = new Map<string, SkillRow[]>()
    for (const s of (skills ?? []).filter(match)) {
      const list = byCat.get(s.category) ?? []
      list.push(s)
      byCat.set(s.category, list)
    }
    return [...byCat.entries()]
      .sort(([a], [b]) => (a === 'custom' ? -1 : b === 'custom' ? 1 : a.localeCompare(b)))
      .map(([category, items]) => ({ category, items: items.sort((a, b) => a.ref.localeCompare(b.ref)) }))
  }, [skills, filter, activeCats])

  const toggleCat = (cat: string) => {
    setActiveCats((prev) => {
      const all = new Set(catCounts.map(([c]) => c))
      const cur = prev ?? all
      const next = new Set(cur)
      if (next.has(cat)) next.delete(cat); else next.add(cat)
      return next.size === all.size ? null : next
    })
  }
  const searching = filter.trim().length > 0
  const isOpen = (cat: string) => searching || expandedCats.has(cat)
  const toggleExpand = (cat: string) =>
    setExpandedCats((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat); else next.add(cat)
      return next
    })
  const pageOf = (cat: string) => pages.get(cat) ?? 1
  const showMore = (cat: string) => setPages((prev) => new Map(prev).set(cat, pageOf(cat) + 1))

  const assignedCustom = (skills ?? []).filter((s) => s.source === 'local' && s.assigned).length

  const toggle = async (s: SkillRow) => {
    if (s.source === 'builtin') return
    // optimistic flip; refetch restores server truth on failure
    setBusyRef(s.ref)
    setSkills((prev) => prev?.map((x) => (x.ref === s.ref ? { ...x, assigned: !s.assigned } : x)) ?? prev)
    const r = s.assigned ? await hermesApi.unassignSkill(agentId, s.ref) : await hermesApi.assignSkill(agentId, s.ref)
    setBusyRef('')
    if (!r.ok) {
      setErr(`${s.assigned ? 'Unassign' : 'Assign'} failed: ${r.error ?? 'unknown'}`)
      await load()
    }
    // assignment auto-injects/removes the bonded doc's pointer — refresh the
    // doc checkboxes so they track the TOOLS.md side effect
    void loadLibrary()
  }

  const openLibDoc = async (name: string) => {
    setDocBusy(name); setMsg('')
    const content = await hermesApi.getLibraryDoc(name)
    setDocBusy('')
    if (content === null) { setMsg(`Couldn't read ${name} — not opening an empty editor over the central doc.`); return }
    setOpenDoc({ name, content, base: content })
  }

  const saveLibDoc = async () => {
    if (!openDoc || openDoc.content === openDoc.base) return
    setSaving(true); setMsg('')
    const r = await hermesApi.putLibraryDoc(openDoc.name, openDoc.content)
    setSaving(false)
    if (!r.ok) { setMsg(`Save failed: ${r.error ?? 'unknown'}`); return }
    setOpenDoc({ ...openDoc, base: openDoc.content })
    setMsg('Saved ✓ — central doc, all agents see the change')
  }

  const togglePointer = async (d: LibDoc) => {
    const next = !d.pointed
    setDocBusy(d.name); setMsg('')
    // optimistic; refetch restores TOOLS.md truth on failure
    setLibrary((prev) => prev.map((x) => (x.name === d.name ? { ...x, pointed: next } : x)))
    const r = await hermesApi.setAgentLibraryDoc(agentId, d.name, next)
    setDocBusy('')
    if (!r.ok) {
      setMsg(`Pointer update failed: ${r.error ?? 'unknown'}`)
      await loadLibrary()
    }
  }

  const docRow = (d: LibDoc, indent: boolean) => (
    <div key={d.name} className={styles.summaryRow} style={{ padding: '2px 0', marginLeft: indent ? 26 : 0 }}>
      <label
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', minWidth: 0 }}
        title={`${d.pointed ? 'Remove' : 'Add'} the ${d.name} pointer ${d.pointed ? 'from' : 'to'} this agent's TOOLS.md (manual override — skill assignment manages bonded docs automatically)`}
      >
        <input type="checkbox" checked={d.pointed} disabled={docBusy === d.name} onChange={() => void togglePointer(d)} />
        <FileText size={12} />
        <span className={styles.dim} style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
      </label>
      <span className={styles.spacer} />
      <button className={styles.btn} style={{ fontSize: 11 }} disabled={docBusy === d.name} onClick={() => void openLibDoc(d.name)}>
        {docBusy === d.name ? '…' : 'Edit'}
      </button>
    </div>
  )

  if (openDoc) {
    const dirty = openDoc.content !== openDoc.base
    return (
      <div className={styles.card}>
        <div className={styles.summaryRow}>
          <FileText size={15} />
          <div>
            <strong className={styles.mono}>library/{openDoc.name}</strong>
            <div className={styles.dim}>CENTRAL doc — one edit, every agent sees it{dirty ? ' · unsaved changes' : ''}</div>
          </div>
          <span className={styles.spacer} />
          <button className={styles.btn} disabled={saving || !dirty} title="Discard changes" onClick={() => setOpenDoc({ ...openDoc, content: openDoc.base })}>
            <Undo2 size={13} /> Revert
          </button>
          <button className={styles.btnPrimary} disabled={saving || !dirty} onClick={() => void saveLibDoc()}>
            <Save size={13} /> {saving ? 'Saving…' : 'Save'}
          </button>
          <button className={styles.btn} title="Close" onClick={() => { if (!dirty || window.confirm(`Discard unsaved changes to ${openDoc.name}?`)) { setOpenDoc(null); setMsg('') } }}>
            <X size={13} />
          </button>
        </div>
        {msg && <div className={styles.dim} style={{ marginTop: 6 }}>{msg}</div>}
        <textarea
          className={`${styles.soul} ${styles.mono}`}
          value={openDoc.content}
          onChange={(e) => setOpenDoc({ ...openDoc, content: e.target.value })}
          spellCheck={false}
        />
      </div>
    )
  }

  return (
    <div className={styles.card}>
      <div className={styles.summaryRow}>
        <div>
          <strong>Skill assignment</strong>
          <div className={styles.dim}>
            {assignedCustom} custom skill{assignedCustom === 1 ? '' : 's'} assigned · built-ins are seeded into every agent ·
            assigning a skill auto-links its library doc
          </div>
        </div>
        <span className={styles.spacer} />
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Search size={13} style={{ position: 'absolute', left: 8, color: 'var(--fg-faint)', pointerEvents: 'none' }} />
          <input
            className={styles.input}
            style={{ paddingLeft: 26, maxWidth: 220 }}
            value={filter}
            placeholder="filter skills…"
            onChange={(e) => setFilter(e.target.value)}
          />
        </span>
      </div>
      {err && <div className={styles.formMsg} style={{ color: 'var(--danger, #f87171)' }}>{err}</div>}
      {msg && <div className={styles.dim} style={{ fontSize: 12 }}>{msg}</div>}
      {!skills && !err && <div className={styles.dim}>Loading skills…</div>}

      {/* Category chips — multi-select filter; tag chips slot in here later. */}
      {catCounts.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 2px' }}>
          {catCounts.map(([cat, n]) => {
            const on = !activeCats || activeCats.has(cat)
            return (
              <button
                key={cat}
                onClick={() => toggleCat(cat)}
                title={`${on ? 'Hide' : 'Show'} ${cat} (${n})`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
                  fontFamily: 'var(--font-mono)', padding: '2px 9px', borderRadius: 9,
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  background: 'var(--control-bg)', cursor: 'pointer',
                  opacity: on ? 1 : 0.45, color: on ? 'var(--fg)' : 'var(--fg-muted)',
                }}
              >
                {cat} <span style={{ color: 'var(--fg-faint)' }}>{n}</span>
              </button>
            )
          })}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.category} style={{ marginTop: 8 }}>
          <div
            className={styles.dim}
            style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, cursor: 'pointer', userSelect: 'none' }}
            onClick={() => toggleExpand(g.category)}
            title={isOpen(g.category) ? 'Collapse' : 'Expand'}
          >
            {isOpen(g.category) ? '▾' : '▸'} {g.category} ({g.items.length}){g.category === 'custom' ? ' — toggleable' : ''}
          </div>
          {isOpen(g.category) && g.items.slice(0, pageOf(g.category) * PAGE).map((s) => (
            <React.Fragment key={s.ref}>
              <label
                className={styles.summaryRow}
                style={{ padding: '3px 0', cursor: s.source === 'local' ? 'pointer' : 'default', opacity: s.source === 'builtin' ? 0.75 : 1 }}
                title={
                  s.source === 'builtin'
                    ? 'Built-in — Hermes seeds it into every agent and re-seeds it on update; not durably toggleable'
                    : s.description.replace(/^"|"$/g, '')
                }
              >
                <input
                  type="checkbox"
                  checked={s.assigned}
                  disabled={s.source === 'builtin' || busyRef === s.ref}
                  onChange={() => void toggle(s)}
                />
                <span className={styles.mono} style={{ fontSize: 12 }}>{s.name}</span>
                {s.source === 'local'
                  ? <span className={styles.dim} style={{ fontSize: 11 }}>{s.ref}</span>
                  : <span className={styles.dim} style={{ fontSize: 10 }}>built-in · always seeded</span>}
              </label>
              {(docsBySkill.get(s.name) ?? []).map((d) => docRow(d, true))}
            </React.Fragment>
          ))}
          {isOpen(g.category) && g.items.length > pageOf(g.category) * PAGE && (
            <button className={styles.btn} style={{ margin: '4px 0', fontSize: 11 }} onClick={() => showMore(g.category)}>
              show {Math.min(PAGE, g.items.length - pageOf(g.category) * PAGE)} more of {g.items.length - pageOf(g.category) * PAGE} remaining
            </button>
          )}
          {g.category === 'custom' && referenceDocs.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className={styles.dim} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                library reference — not bonded to a skill
              </div>
              {referenceDocs.map((d) => docRow(d, false))}
            </div>
          )}
        </div>
      ))}
      {skills && groups.length === 0 && <div className={styles.dim}>No skills match “{filter}”.</div>}
      <div className={styles.dim} style={{ marginTop: 8, fontSize: 11 }}>
        Library docs are central — agents carry TOOLS.md pointers, never copies. Assigning a skill injects its
        bonded doc's pointer automatically; the doc checkboxes show this agent's actual TOOLS.md state and
        toggle it as a manual override.
      </div>
    </div>
  )
}
