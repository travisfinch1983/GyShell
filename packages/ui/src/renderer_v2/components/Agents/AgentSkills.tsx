/**
 * AgentSkills — the "Skills" sub-tab of the Hermes agent editor: assign
 * library skills to this agent (9b44da7). The library itself is curated in
 * Settings › Skills; this is per-agent membership.
 *
 * Source semantics matter here: `local` (custom) skills are the durably
 * toggleable ones — assign copies the skill into the agent, unassign removes
 * it. `builtin` skills are seeded into EVERY agent by Hermes and re-seed on
 * update, so unassigning one isn't durable — their checkboxes render at the
 * reported state but LOCKED (a toggle that silently reverts is a lie), with
 * the re-seed hint. Custom group first. Optimistic toggles, refetch on error.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { hermesApi } from '../../stores/hermesApi'
import styles from './Agents.module.scss'

interface SkillRow { ref: string; name: string; category: string; description: string; source: 'builtin' | 'local'; assigned: boolean }

export const AgentSkills: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [skills, setSkills] = useState<SkillRow[] | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('')
  const [busyRef, setBusyRef] = useState('')

  const load = () =>
    hermesApi.listAgentSkills(agentId).then((s) => {
      if (s === null) setErr('Failed to list skills — Hermes host unreachable?')
      else { setSkills(s); setErr('') }
    })
  useEffect(() => { void load() }, [agentId])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (s: SkillRow) =>
      !q || s.ref.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    const byCat = new Map<string, SkillRow[]>()
    for (const s of (skills ?? []).filter(match)) {
      const list = byCat.get(s.category) ?? []
      list.push(s)
      byCat.set(s.category, list)
    }
    return [...byCat.entries()]
      .sort(([a], [b]) => (a === 'custom' ? -1 : b === 'custom' ? 1 : a.localeCompare(b)))
      .map(([category, items]) => ({ category, items: items.sort((a, b) => a.ref.localeCompare(b.ref)) }))
  }, [skills, filter])

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
  }

  return (
    <div className={styles.card}>
      <div className={styles.summaryRow}>
        <div>
          <strong>Skill assignment</strong>
          <div className={styles.dim}>
            {assignedCustom} custom skill{assignedCustom === 1 ? '' : 's'} assigned · built-ins are seeded into every agent
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
      {!skills && !err && <div className={styles.dim}>Loading skills…</div>}
      {groups.map((g) => (
        <div key={g.category} style={{ marginTop: 8 }}>
          <div className={styles.dim} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            {g.category}{g.category === 'custom' ? ' — toggleable' : ''}
          </div>
          {g.items.map((s) => (
            <label
              key={s.ref}
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
          ))}
        </div>
      ))}
      {skills && groups.length === 0 && <div className={styles.dim}>No skills match “{filter}”.</div>}
      <div className={styles.dim} style={{ marginTop: 8, fontSize: 11 }}>
        Assigning copies the skill into the agent's profile; the shared library is curated in Settings › Skills.
      </div>
    </div>
  )
}
