/**
 * HermesSkillsPanel — Settings › Skills, two sub-tabs over the HERMES library
 * (Travis's split, 2597fb2):
 *
 * • "Skills Library" — skills-first: browse/edit/create SKILL.md files
 *   (2f264d2), each skill row badging its bonded library docs.
 * • "Reference Library" — docs-first, the PRIMARY place to manage bonds:
 *   every central doc with its bonded skills as removable chips + an
 *   add-bond picker (POST /library/bond — explicit many-to-many; bonding
 *   retro-points the doc onto agents that already carry the skill), plus a
 *   content editor (shared semantics: one edit hits all agents).
 *
 * Per-agent assignment lives on each agent's editor (AgentSkills), not here.
 * Wipe-guard discipline throughout: editors never open on a failed GET;
 * Save is change-only; creation is an explicit act.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { FileText, Link2, Plus, RefreshCw, Save, Search, Undo2, X } from 'lucide-react'
import { hermesApi } from '../../stores/hermesApi'

interface SkillEntry { ref: string; name: string; dir: string; category: string; description: string; source: 'builtin' | 'local'; tags?: string[] }
interface LibDoc { name: string; title: string; skills: string[] }
type OpenItem =
  | { kind: 'skill'; ref: string; content: string; base: string; isNew: boolean }
  | { kind: 'doc'; name: string; content: string; base: string }

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

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  padding: '1px 4px 1px 8px',
  borderRadius: 9,
  border: '1px solid var(--border)',
  background: 'var(--control-bg)',
}

const inputStyle: React.CSSProperties = {
  height: 28,
  padding: '0 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--control-bg)',
  color: 'var(--fg)',
  fontSize: 12,
}

/** Rows rendered per expanded category before "show more" — keeps the DOM
 *  small at 791-skill scale (claude-extended alone is 540) without a
 *  virtualization dependency. */
const PAGE = 60

export const HermesSkillsPanel: React.FC = () => {
  const [tab, setTab] = useState<'skills' | 'reference'>('skills')
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [library, setLibrary] = useState<LibDoc[] | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<OpenItem | null>(null)
  const [busyKey, setBusyKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [newRef, setNewRef] = useState('')
  // Browse-at-scale state: multi-select category chips (null = all shown),
  // per-category expansion (custom open by default), per-category page depth.
  // Tag chips (backend coming) will slot into the same chip row.
  const [activeCats, setActiveCats] = useState<Set<string> | null>(null)
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set(['custom']))
  const [pages, setPages] = useState<Map<string, number>>(new Map())
  // Tag filtering (1a0f639): top chips by count + a find-a-tag input (1133
  // distinct tags can't all be chips). Selected tags AND-narrow the list.
  const [tagCounts, setTagCounts] = useState<Array<{ tag: string; count: number }>>([])
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [tagFind, setTagFind] = useState('')
  // Content search: backend grep across SKILL.md bodies; result = a ref set
  // that becomes the base list until cleared or the query text changes.
  const [deepHits, setDeepHits] = useState<{ q: string; refs: Set<string> } | null>(null)
  const [deepBusy, setDeepBusy] = useState(false)
  // Tag editing in the editor header
  const [tagDraft, setTagDraft] = useState('')

  const load = () =>
    Promise.all([hermesApi.listSkills(), hermesApi.listLibrary(), hermesApi.listSkillTags()]).then(([s, l, t]) => {
      if (s === null || l === null) setErr('Failed to list the Hermes library — host unreachable?')
      else { setSkills(s); setLibrary(l); setTagCounts(t ?? []); setErr('') }
    })
  useEffect(() => { void load() }, [])

  const docsBySkill = useMemo(() => {
    const m = new Map<string, LibDoc[]>()
    for (const d of library ?? []) {
      for (const s of d.skills) {
        const list = m.get(s) ?? []
        list.push(d)
        m.set(s, list)
      }
    }
    return m
  }, [library])

  /** Unfiltered per-category counts for the chip row. */
  const catCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of skills ?? []) m.set(s.category, (m.get(s.category) ?? 0) + 1)
    return [...m.entries()].sort(([a], [b]) => (a === 'custom' ? -1 : b === 'custom' ? 1 : a.localeCompare(b)))
  }, [skills])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (s: SkillEntry) =>
      (!deepHits || deepHits.refs.has(s.ref)) &&
      (!activeCats || activeCats.has(s.category)) &&
      [...selectedTags].every((t) => (s.tags ?? []).includes(t)) &&
      (!q || s.ref.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || (s.tags ?? []).some((t) => t.includes(q)))
    const byCat = new Map<string, SkillEntry[]>()
    for (const s of (skills ?? []).filter(match)) {
      const list = byCat.get(s.category) ?? []
      list.push(s)
      byCat.set(s.category, list)
    }
    return [...byCat.entries()]
      .sort(([a], [b]) => (a === 'custom' ? -1 : b === 'custom' ? 1 : a.localeCompare(b)))
      .map(([category, items]) => ({ category, items: items.sort((a, b) => a.ref.localeCompare(b.ref)) }))
  }, [skills, filter, activeCats, selectedTags, deepHits])

  const deepSearch = async () => {
    const q = filter.trim()
    if (!q) return
    setDeepBusy(true); setMsg('')
    const hits = await hermesApi.searchSkills(q)
    setDeepBusy(false)
    if (hits === null) { setMsg('Content search failed — host unreachable?'); return }
    setDeepHits({ q, refs: new Set(hits.map((h) => h.ref)) })
    setMsg(`Content search “${q}”: ${hits.length} skills (metadata + SKILL.md bodies)`)
  }

  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag); else next.add(tag)
      return next
    })

  const saveTags = async (ref: string, tags: string[]) => {
    // optimistic; the sidecar is authoritative on failure
    setSkills((prev) => prev?.map((s) => (s.ref === ref ? { ...s, tags } : s)) ?? prev)
    if (open?.kind === 'skill' && open.ref === ref) setMsg('')
    const r = await hermesApi.putSkillTags(ref, tags)
    if (!r.ok) { setMsg(`Tag save failed: ${r.error ?? 'unknown'}`); await load(); return }
    void hermesApi.listSkillTags().then((t) => setTagCounts(t ?? []))
  }

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

  const filteredDocs = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (library ?? []).filter((d) =>
      !q || d.name.toLowerCase().includes(q) || d.title.toLowerCase().includes(q) || d.skills.some((s) => s.toLowerCase().includes(q)))
  }, [library, filter])

  const openSkill = async (ref: string, isNew = false) => {
    setBusyKey(ref); setMsg('')
    const content = isNew ? '' : await hermesApi.getSkill(ref)
    setBusyKey('')
    if (content === null) { setMsg(`Couldn't read ${ref} — not opening an empty editor over a real skill.`); return }
    setOpen({ kind: 'skill', ref, content, base: content, isNew })
  }

  const openDoc = async (name: string) => {
    setBusyKey(name); setMsg('')
    const content = await hermesApi.getLibraryDoc(name)
    setBusyKey('')
    if (content === null) { setMsg(`Couldn't read ${name} — not opening an empty editor over the central doc.`); return }
    setOpen({ kind: 'doc', name, content, base: content })
  }

  const startNew = () => {
    const ref = newRef.trim().replace(/^\/+|\/+$/g, '')
    if (!ref) return
    if (skills?.some((s) => s.ref === ref)) { setMsg(`${ref} already exists — opening it instead.`); void openSkill(ref); return }
    setNewRef('')
    void openSkill(ref, true)
  }

  const save = async () => {
    if (!open) return
    const dirty = open.content !== open.base
    if (!dirty && !(open.kind === 'skill' && open.isNew)) return
    setSaving(true); setMsg('')
    const r = open.kind === 'skill'
      ? await hermesApi.putSkill(open.ref, open.content)
      : await hermesApi.putLibraryDoc(open.name, open.content)
    setSaving(false)
    if (!r.ok) { setMsg(`Save failed: ${r.error ?? 'unknown'}`); return }
    setOpen(open.kind === 'skill' ? { ...open, base: open.content, isNew: false } : { ...open, base: open.content })
    setMsg(open.kind === 'doc' ? 'Saved ✓ — central doc, all agents see the change' : 'Saved ✓')
    await load()
  }

  const setBond = async (doc: string, skill: string, bonded: boolean) => {
    setBusyKey(doc); setMsg('')
    // optimistic; reload restores bonds.json truth on failure
    setLibrary((prev) => prev?.map((d) => (d.name === doc
      ? { ...d, skills: bonded ? [...d.skills, skill] : d.skills.filter((s) => s !== skill) }
      : d)) ?? prev)
    const r = await hermesApi.bond(doc, skill, bonded)
    setBusyKey('')
    if (!r.ok) { setErr(`Bond update failed: ${r.error ?? 'unknown'}`); await load() }
    else if (bonded) setMsg(`Bonded ${doc} ↔ ${skill} ✓ — retro-pointed onto agents that carry the skill`)
  }

  // ── editor (either kind) ────────────────────────────────────────────────
  if (open) {
    const dirty = open.content !== open.base
    const label = open.kind === 'skill' ? `${open.ref}/SKILL.md` : `library/${open.name}`
    return (
      <>
        <div className="settings-section-header">
          <div className="settings-section-title">
            <FileText size={16} strokeWidth={2} />
            <span style={{ marginLeft: 8, fontFamily: 'var(--font-mono)' }}>{label}</span>
            {open.kind === 'skill' && open.isNew && <span style={badgeStyle('local')}>new — created on save</span>}
            {open.kind === 'doc' && <span style={badgeStyle('local')}>central — one edit hits all agents</span>}
          </div>
          <div className="settings-actions">
            <button className="btn-secondary" disabled={saving || !dirty} title="Discard changes" onClick={() => setOpen({ ...open, content: open.base } as OpenItem)}>
              <Undo2 size={14} /> Revert
            </button>
            <button className="btn-primary" disabled={saving || (!dirty && !(open.kind === 'skill' && open.isNew))} onClick={() => void save()}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              className="btn-secondary"
              title="Back to the library"
              onClick={() => { if (!dirty || window.confirm(`Discard unsaved changes to ${label}?`)) { setOpen(null); setMsg('') } }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {msg && <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>{msg}</div>}
        {open.kind === 'skill' && !open.isNew && (() => {
          const cur = skills?.find((s) => s.ref === open.ref)?.tags ?? []
          const addTag = () => {
            const t = tagDraft.trim().toLowerCase()
            if (!t || cur.includes(t)) { setTagDraft(''); return }
            setTagDraft('')
            void saveTags(open.ref, [...cur, t])
          }
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Tags:</span>
              {cur.map((t) => (
                <span key={t} style={chipStyle}>
                  {t}
                  <button
                    title={`Remove tag ${t}`}
                    onClick={() => void saveTags(open.ref, cur.filter((x) => x !== t))}
                    style={{ border: 'none', background: 'none', color: 'var(--fg-faint)', cursor: 'pointer', padding: '0 2px', fontSize: 12, lineHeight: 1 }}
                  >×</button>
                </span>
              ))}
              <input
                value={tagDraft}
                list="hermes-skill-tags"
                placeholder="add tag…"
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addTag() }}
                style={{ ...inputStyle, height: 22, fontSize: 11, width: 130 }}
              />
              {tagDraft.trim() && <button className="btn-secondary" style={{ height: 22, fontSize: 11, padding: '0 8px' }} onClick={addTag}>add</button>}
            </div>
          )
        })()}
        <textarea
          value={open.content}
          onChange={(e) => setOpen({ ...open, content: e.target.value } as OpenItem)}
          spellCheck={false}
          placeholder={open.kind === 'skill' && open.isNew ? '---\nname: my-skill\ndescription: what it does\n---\n\n# Instructions…' : undefined}
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

  // ── list views ──────────────────────────────────────────────────────────
  return (
    <>
      <div className="settings-section-header">
        <div className="settings-section-title">Skills — Hermes library</div>
        <div className="settings-actions">
          <div className="tools-subtabs">
            <button className={`tools-subtab ${tab === 'skills' ? 'tools-subtab-active' : ''}`} onClick={() => setTab('skills')}>Skills Library</button>
            <button className={`tools-subtab ${tab === 'reference' ? 'tools-subtab-active' : ''}`} onClick={() => setTab('reference')}>Reference Library</button>
          </div>
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <Search size={13} style={{ position: 'absolute', left: 8, color: 'var(--fg-faint)', pointerEvents: 'none' }} />
            <input
              value={filter}
              placeholder={tab === 'skills' ? 'filter skills…' : 'filter docs…'}
              onChange={(e) => { setFilter(e.target.value); setDeepHits(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && tab === 'skills') void deepSearch() }}
              style={{ ...inputStyle, paddingLeft: 26, width: 180 }}
            />
          </span>
          {tab === 'skills' && (
            <button
              className="btn-secondary"
              disabled={deepBusy || !filter.trim()}
              title="Search SKILL.md file contents too (backend grep) — Enter does the same"
              onClick={() => void deepSearch()}
            >
              {deepBusy ? 'Searching…' : 'Content search'}
            </button>
          )}
          <button className="btn-icon-reload" onClick={() => void load()} title="Reload the library">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      {err && <div className="settings-error" style={{ marginBottom: 8 }}>{err}</div>}
      {msg && <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>{msg}</div>}

      {tab === 'skills' ? (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
            The shared skills library ({skills?.length ?? '…'} skills) — every agent draws from here. Bonded
            reference docs show under each skill; manage the bonds in the Reference Library sub-tab. Per-agent
            assignment lives on each agent's editor.
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
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)', width: 240 }}
              />
              <button className="btn-secondary" disabled={!newRef.trim()} onClick={startNew}>
                <Plus size={14} /> Create
              </button>
            </span>
          </div>
          {!skills && !err && <div className="tool-empty">Loading the skills library…</div>}

          {/* Category filter chips — multi-select; tag chips join this row
              once the tag backend lands. */}
          {catCounts.length > 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '2px 0 10px' }}>
              {catCounts.map(([cat, n]) => {
                const on = !activeCats || activeCats.has(cat)
                return (
                  <button
                    key={cat}
                    onClick={() => toggleCat(cat)}
                    title={`${on ? 'Hide' : 'Show'} ${cat} (${n})`}
                    style={{
                      ...chipStyle,
                      cursor: 'pointer',
                      padding: '2px 9px',
                      opacity: on ? 1 : 0.45,
                      borderColor: on ? 'var(--accent)' : 'var(--border)',
                      color: on ? 'var(--fg)' : 'var(--fg-muted)',
                    }}
                  >
                    {cat} <span style={{ color: 'var(--fg-faint)' }}>{n}</span>
                  </button>
                )
              })}
              {activeCats && (
                <button onClick={() => setActiveCats(null)} style={{ ...chipStyle, cursor: 'pointer', padding: '2px 9px', color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                  show all
                </button>
              )}
            </div>
          )}

          {/* Tag chips — top by count + selected; 1133 distinct tags, so the
              rest are reachable via the find-a-tag input. AND-narrowing. */}
          {tagCounts.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 0 10px', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--fg-faint)' }}>tags:</span>
              {[
                ...tagCounts.slice(0, 18),
                ...tagCounts.slice(18).filter(({ tag }) => selectedTags.has(tag)),
              ].map(({ tag, count }) => {
                const on = selectedTags.has(tag)
                return (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    title={`${on ? 'Stop narrowing' : 'Narrow'} to skills tagged "${tag}" (${count})`}
                    style={{
                      ...chipStyle, cursor: 'pointer', padding: '2px 9px',
                      borderColor: on ? 'var(--accent)' : 'var(--border)',
                      background: on ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--control-bg)',
                      color: on ? 'var(--accent)' : 'var(--fg-muted)',
                    }}
                  >
                    {tag} <span style={{ color: 'var(--fg-faint)' }}>{count}</span>
                  </button>
                )
              })}
              <input
                value={tagFind}
                list="hermes-skill-tags"
                placeholder={`find tag… (${tagCounts.length})`}
                onChange={(e) => setTagFind(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const t = tagFind.trim().toLowerCase()
                  if (t && tagCounts.some((x) => x.tag === t)) { toggleTag(t); setTagFind('') }
                }}
                style={{ ...inputStyle, height: 22, fontSize: 11, width: 140 }}
              />
              {selectedTags.size > 0 && (
                <button onClick={() => setSelectedTags(new Set())} style={{ ...chipStyle, cursor: 'pointer', padding: '2px 9px', color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                  clear tags
                </button>
              )}
              <datalist id="hermes-skill-tags">
                {tagCounts.map(({ tag }) => <option key={tag} value={tag} />)}
              </datalist>
            </div>
          )}

          {groups.map((g) => {
            const openGroup = isOpen(g.category)
            const visible = openGroup ? g.items.slice(0, pageOf(g.category) * PAGE) : []
            return (
              <React.Fragment key={g.category}>
                <div
                  className="settings-divider settings-divider-spaced"
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => toggleExpand(g.category)}
                  title={openGroup ? 'Collapse' : 'Expand'}
                >
                  <span>{openGroup ? '▾' : '▸'} {g.category} ({g.items.length})</span>
                  <i />
                </div>
                {openGroup && (
                  <div className="tools-list">
                    {visible.map((s) => {
                      const bonded = docsBySkill.get(s.name) ?? []
                      return (
                        <div key={s.ref} className="tool-item">
                          <div className="tool-info">
                            <div className="tool-name" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              {s.name}
                              <span style={badgeStyle(s.source)}>{s.source}</span>
                              {bonded.map((d) => (
                                <span key={d.name} style={chipStyle} title={`Bonded library doc: ${d.title}`}>
                                  <Link2 size={10} /> {d.name}
                                </span>
                              ))}
                            </div>
                            <div className="tool-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                              {s.ref}
                              {(s.tags ?? []).slice(0, 5).map((t) => (
                                <span key={t} style={{ ...chipStyle, marginLeft: 6, padding: '0 6px', fontSize: 10, cursor: 'pointer' }} title={`Narrow to "${t}"`} onClick={() => toggleTag(t)}>{t}</span>
                              ))}
                              {(s.tags?.length ?? 0) > 5 && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--fg-faint)' }}>+{(s.tags?.length ?? 0) - 5}</span>}
                            </div>
                            {s.description && <div className="tool-meta">{s.description.replace(/^"|"$/g, '')}</div>}
                          </div>
                          <div className="tool-actions">
                            <button className="btn-secondary" disabled={busyKey === s.ref} onClick={() => void openSkill(s.ref)}>
                              {busyKey === s.ref ? 'Opening…' : 'Open →'}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    {g.items.length > visible.length && (
                      <button className="btn-secondary" style={{ margin: '6px 0' }} onClick={() => showMore(g.category)}>
                        show {Math.min(PAGE, g.items.length - visible.length)} more of {g.items.length - visible.length} remaining
                      </button>
                    )}
                  </div>
                )}
              </React.Fragment>
            )
          })}
          {skills && groups.length === 0 && <div className="tool-empty">No skills match the current filters.</div>}
        </>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
            The central reference docs ({library?.length ?? '…'}) — agents hold TOOLS.md pointers, never copies,
            so an edit here reaches every agent. Bond a doc to skills and assigning the skill carries the doc
            with it (retro-applies to agents that already have the skill); a doc can bond to many skills.
          </p>
          {!library && !err && <div className="tool-empty">Loading the reference library…</div>}
          <div className="tools-list">
            {filteredDocs.map((d) => (
              <div key={d.name} className="tool-item">
                <div className="tool-info">
                  <div className="tool-name">{d.title}</div>
                  <div className="tool-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{d.name}</div>
                  <div className="tool-meta" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {d.skills.length === 0 && <span style={{ fontSize: 11, color: 'var(--fg-faint)' }}>not bonded — general reference</span>}
                    {d.skills.map((sn) => (
                      <span key={sn} style={chipStyle}>
                        <Link2 size={10} /> {sn}
                        <button
                          title={`Unbond ${d.name} from ${sn}`}
                          disabled={busyKey === d.name}
                          onClick={() => void setBond(d.name, sn, false)}
                          style={{ border: 'none', background: 'none', color: 'var(--fg-faint)', cursor: 'pointer', padding: '0 2px', fontSize: 12, lineHeight: 1 }}
                        >×</button>
                      </span>
                    ))}
                    <select
                      value=""
                      disabled={busyKey === d.name}
                      onChange={(e) => { if (e.target.value) void setBond(d.name, e.target.value, true) }}
                      style={{ ...inputStyle, height: 22, fontSize: 11, padding: '0 4px' }}
                      title="Bond this doc to a skill"
                    >
                      <option value="">+ bond to skill…</option>
                      {(skills ?? [])
                        .filter((s) => !d.skills.includes(s.name))
                        .map((s) => <option key={s.ref} value={s.name}>{s.name}{s.source === 'local' ? '' : ' (builtin)'}</option>)}
                    </select>
                  </div>
                </div>
                <div className="tool-actions">
                  <button className="btn-secondary" disabled={busyKey === d.name} onClick={() => void openDoc(d.name)}>
                    {busyKey === d.name ? 'Opening…' : 'Edit →'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {library && filteredDocs.length === 0 && <div className="tool-empty">No docs match “{filter}”.</div>}
        </>
      )}
    </>
  )
}
