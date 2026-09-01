import React, { useState } from 'react'
import { ArrowRight, FileText, Check, X, Plus } from 'lucide-react'
import { roadmapNavStore } from '../../stores/RoadmapNavStore'

export type ProjectStatus = 'idea' | 'active' | 'paused' | 'blocked' | 'done'
export const PROJECT_STATUSES: ProjectStatus[] = ['idea', 'active', 'paused', 'blocked', 'done']

export interface ProjMeta {
  id: string
  name: string
  order: number
  updatedAt: string
  nodeCount: number
  description?: string
  status?: ProjectStatus | null
  reportId?: string | null
  itemsDone?: number
  itemsOpen?: number
  itemsUntracked?: number
  itemsTotal?: number
}

/** Relative age, plus whether it has gone quiet. The point of this table is finding work that
 *  was started and forgotten, so "when did anyone last touch this" is a headline number, not a
 *  tooltip. */
function ageOf(iso: string): { label: string; days: number } {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return { label: 'unknown', days: -1 }
  const days = Math.floor((Date.now() - t) / 86_400_000)
  if (days <= 0) return { label: 'today', days: 0 }
  if (days === 1) return { label: 'yesterday', days }
  if (days < 30) return { label: `${days}d ago`, days }
  const m = Math.floor(days / 30)
  return { label: m === 1 ? '1 month ago' : `${m} months ago`, days }
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  idea: 'Idea', active: 'Active', paused: 'Paused', blocked: 'Blocked', done: 'Done',
}

/** A single row. Description and status are edited in place — the table is only useful if it is
 *  cheap enough to keep current, and a separate edit screen guarantees it goes stale. */
const Row: React.FC<{
  p: ProjMeta
  onOpen: (pid: string) => void
  onPatch: (pid: string, patch: Record<string, unknown>) => Promise<void>
}> = ({ p, onOpen, onPatch }) => {
  const [editingDesc, setEditingDesc] = useState(false)
  const [draft, setDraft] = useState(p.description ?? '')
  const [linking, setLinking] = useState(false)
  const [reportDraft, setReportDraft] = useState(p.reportId ?? '')

  const done = p.itemsDone ?? 0
  const open = p.itemsOpen ?? 0
  const untracked = p.itemsUntracked ?? 0
  const total = p.itemsTotal ?? 0
  const age = ageOf(p.updatedAt)
  // Only call something stale when there is unfinished work in it — a finished project sitting
  // untouched for months is not a problem, and flagging it would train the eye to ignore the flag.
  const stale = age.days >= 30 && (open + untracked) > 0

  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)

  const saveDesc = async () => {
    setEditingDesc(false)
    if (draft.trim() !== (p.description ?? '')) await onPatch(p.id, { description: draft.trim() })
  }
  const saveReport = async () => {
    setLinking(false)
    if (reportDraft.trim() !== (p.reportId ?? '')) await onPatch(p.id, { reportId: reportDraft.trim() })
  }

  return (
    <div className={`rmo-row${stale ? ' rmo-stale' : ''}`}>
      <div className="rmo-main">
        <div className="rmo-line1">
          <select
            className={`rmo-status rmo-st-${p.status ?? 'none'}`}
            value={p.status ?? ''}
            onChange={(e) => void onPatch(p.id, { status: e.target.value || null })}
            title="Project status — also what the Kanban view will group by"
          >
            <option value="">— set status —</option>
            {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>

          <button className="rmo-name" onClick={() => onOpen(p.id)} title="Open this project's roadmap">
            {p.name}
          </button>

          <span className={`rmo-age${stale ? ' rmo-age-stale' : ''}`} title={p.updatedAt}>
            {age.label}{stale ? ' · untouched' : ''}
          </span>
        </div>

        <div className="rmo-line2">
          {editingDesc ? (
            <span className="rmo-descedit">
              <input
                autoFocus className="rmo-input" placeholder="One line: what is this project?"
                value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveDesc()
                  if (e.key === 'Escape') { setEditingDesc(false); setDraft(p.description ?? '') }
                }}
              />
              <button className="rmo-mini" onClick={() => void saveDesc()} title="Save"><Check size={11} /></button>
              <button className="rmo-mini" onClick={() => { setEditingDesc(false); setDraft(p.description ?? '') }} title="Cancel"><X size={11} /></button>
            </span>
          ) : (
            <span
              className={`rmo-desc${p.description ? '' : ' rmo-desc-empty'}`}
              onClick={() => { setDraft(p.description ?? ''); setEditingDesc(true) }}
              title="Click to edit"
            >
              {p.description || 'no description — click to add one'}
            </span>
          )}
        </div>
      </div>

      <div className="rmo-progress" title={`${done} done · ${open} open · ${untracked} never given a checkbox`}>
        <div className="rmo-bar">
          <span className="rmo-seg rmo-seg-done" style={{ width: `${pct(done)}%` }} />
          <span className="rmo-seg rmo-seg-open" style={{ width: `${pct(open)}%` }} />
          <span className="rmo-seg rmo-seg-untracked" style={{ width: `${pct(untracked)}%` }} />
        </div>
        <div className="rmo-counts">
          {total === 0
            ? <span className="rmo-c-none">not broken down yet</span>
            : (
              <>
                <span className="rmo-c-done">{done} done</span>
                {open > 0 && <span className="rmo-c-open">{open} open</span>}
                {/* Called out rather than folded into "open": these are items nobody ever gave a
                    checkbox, which is why projects read 100% while carrying real work. */}
                {untracked > 0 && <span className="rmo-c-untracked">{untracked} untracked</span>}
              </>
            )}
        </div>
      </div>

      <div className="rmo-actions">
        <button className="rmo-btn rmo-btn-go" onClick={() => onOpen(p.id)} title="Open this project's roadmap">
          Roadmap <ArrowRight size={12} />
        </button>
        {linking ? (
          <span className="rmo-descedit">
            <input
              autoFocus className="rmo-input rmo-input-sm" placeholder="report id…"
              value={reportDraft} onChange={(e) => setReportDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveReport()
                if (e.key === 'Escape') { setLinking(false); setReportDraft(p.reportId ?? '') }
              }}
            />
            <button className="rmo-mini" onClick={() => void saveReport()}><Check size={11} /></button>
          </span>
        ) : p.reportId ? (
          <button
            className="rmo-btn"
            onClick={() => roadmapNavStore.openReport(p.reportId as string)}
            title={`Open the scoping document (${p.reportId}) in Reporting`}
          >
            <FileText size={12} /> Scoping doc
          </button>
        ) : (
          <button
            className="rmo-btn rmo-btn-ghost"
            onClick={() => { setReportDraft(''); setLinking(true) }}
            title="No scoping document linked yet — paste a report id from the Reporting tab"
          >
            <FileText size={12} /> Link doc…
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The table of contents for every roadmap project.
 *
 * Deliberately rendered from the SAME /api/roadmap/projects list the sub-tabs use, with progress
 * computed server-side per request — so this summary cannot drift from the trees it summarises.
 * A second store holding "project descriptions" would have been the obvious shape and the wrong
 * one; it would go stale the first time anyone edited a tree.
 */
export const RoadmapOverview: React.FC<{
  projects: ProjMeta[]
  onOpen: (pid: string) => void
  onPatch: (pid: string, patch: Record<string, unknown>) => Promise<void>
  onCreate: (name: string) => Promise<void>
}> = ({ projects, onOpen, onPatch, onCreate }) => {
  // "New project" lives here now rather than in the old tab strip — this list IS the set of
  // projects, so adding one belongs next to it.
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const create = async () => {
    const n = newName.trim()
    if (!n) { setAdding(false); return }
    setNewName(''); setAdding(false)
    await onCreate(n)
  }
  const totals = projects.reduce(
    (a, p) => ({
      done: a.done + (p.itemsDone ?? 0),
      open: a.open + (p.itemsOpen ?? 0),
      untracked: a.untracked + (p.itemsUntracked ?? 0),
    }),
    { done: 0, open: 0, untracked: 0 },
  )
  const stalled = projects.filter((p) => {
    const age = ageOf(p.updatedAt)
    return age.days >= 30 && ((p.itemsOpen ?? 0) + (p.itemsUntracked ?? 0)) > 0
  }).length

  return (
    <div className="rmo">
      <div className="rmo-summary">
        <span><strong>{projects.length}</strong> projects</span>
        <span className="rmo-c-done">{totals.done} done</span>
        <span className="rmo-c-open">{totals.open} open</span>
        <span className="rmo-c-untracked">{totals.untracked} untracked</span>
        {stalled > 0 && <span className="rmo-c-stale">{stalled} untouched 30d+ with work left</span>}
      </div>
      {totals.untracked > 0 && (
        <div className="rmo-note">
          <strong>{totals.untracked} items have no checkbox.</strong> They are real tasks that were
          written down and never marked open or done, so they count toward neither — which is how a
          project can show a full bar while work remains. Tick or check them in its roadmap to bring
          them into the count.
        </div>
      )}
      {projects.length === 0 && <div className="rm-empty">No projects yet.</div>}
      {projects.map((p) => <Row key={p.id} p={p} onOpen={onOpen} onPatch={onPatch} />)}

      <div className="rmo-newrow">
        {adding ? (
          <span className="rmo-descedit">
            <input
              autoFocus className="rmo-input" placeholder="Project name…"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
                if (e.key === 'Escape') { setAdding(false); setNewName('') }
              }}
            />
            <button className="rmo-mini" onClick={() => void create()} title="Create"><Check size={11} /></button>
            <button className="rmo-mini" onClick={() => { setAdding(false); setNewName('') }} title="Cancel"><X size={11} /></button>
          </span>
        ) : (
          <button className="rmo-btn rmo-btn-ghost" onClick={() => setAdding(true)}>
            <Plus size={12} /> New project
          </button>
        )}
      </div>
    </div>
  )
}
