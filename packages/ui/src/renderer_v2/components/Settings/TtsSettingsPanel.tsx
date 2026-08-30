/**
 * TtsSettingsPanel — the "Support Models" tab in Settings.
 *
 * Configures the models that support the agents rather than being agents:
 * - Vision Description model (global Hermes role — describes images to
 *   text-only agents; vision-capable agents see images natively and ignore it)
 * - Compaction model (global Hermes role — summarizes long agent contexts;
 *   full catalog, no vision filter)
 * - STT provider and model selection
 * - TTS provider and model selection
 * - Single/dual pipeline toggle
 * - RVC voice conversion toggle
 *
 * TTS/STT settings stored in settings.ttsConfig / settings.sttConfig;
 * the Hermes roles live backend-side (GET/PUT /api/hermes/support-models,
 * merge semantics — each section PUTs only its own key).
 */

import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import {
  Volume2, Mic, RefreshCw, CircleDot, Eye, Archive, Pencil, Database, ListOrdered, Clock,
} from 'lucide-react'
import {
  getTtsProviders,
  getSttProviders,
  getRvcModels,
  discoverModels,
  type TtsProvider,
  type SttProvider,
  type RvcModel,
} from '../../services/ProxlabDiscovery'
import { hermesApi, type SupportModelRole, type CatalogModelWithCaps, type AuxTask } from '../../stores/hermesApi'

interface TtsConfig {
  enabled: boolean
  dualPipeline: boolean
  rvcEnabled: boolean
  defaultVoice: string
  defaultModel: string
  rvcModel: string
  preferredProviders: number[]
  rvcProviders: number[]
}

interface SttConfig {
  enabled: boolean
  provider: number
  model: string
}

const DEFAULT_TTS_CONFIG: TtsConfig = {
  enabled: true,
  dualPipeline: true,
  rvcEnabled: false,
  defaultVoice: 'default',
  defaultModel: 'f5-tts',
  rvcModel: '',
  preferredProviders: [],
  rvcProviders: [],
}

const DEFAULT_STT_CONFIG: SttConfig = {
  enabled: true,
  provider: 1,
  model: 'large-v3-turbo',
}

// ─── Support-Model Role Sections ──────────────────────────────────────────────
// Global Hermes roles (GET/PUT /api/hermes/support-models, merge semantics —
// each section PUTs only its own key). One reusable section per role.

interface SupportRoleSectionProps {
  roleKey: 'visionDescription' | 'compaction'
  title: string
  icon: React.ReactNode
  selectLabel: string
  /** Catalog filter for the options list (identity = full catalog). */
  filterModels: (m: CatalogModelWithCaps) => boolean
  clearOptionLabel: string
  clearedStatus: string
  helperCopy: string
}

const SupportRoleSection: React.FC<SupportRoleSectionProps> = ({
  roleKey, title, icon, selectLabel, filterModels, clearOptionLabel, clearedStatus, helperCopy,
}) => {
  const [models, setModels] = useState<CatalogModelWithCaps[]>([])
  const [role, setRole] = useState<SupportModelRole | null>(null)
  // Wipe guard: the selector only renders after a successful GET, so a failed
  // load can never turn into a blind PUT over live config.
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  const load = async () => {
    setState('loading')
    const [roles, catalog] = await Promise.all([hermesApi.getSupportModels(), hermesApi.listCatalog()])
    if (roles === null) { setState('error'); return }
    setRole(roles[roleKey])
    setModels(catalog.filter(filterModels))
    setState('ready')
  }

  useEffect(() => { load() }, [])

  const apply = async (model: string) => {
    const next: SupportModelRole | null = model ? { provider: role?.provider || 'ailab', model } : null
    const prev = role
    setRole(next)
    setSaving(true)
    setStatus('')
    const r = await hermesApi.setSupportModels({ [roleKey]: next })
    setSaving(false)
    if (!r.ok) {
      setRole(prev)
      setStatus(`save failed${r.error ? ` — ${r.error}` : ''}`)
      return
    }
    setStatus(
      next
        ? `saved${typeof r.agentsUpdated === 'number' ? ` — ${r.agentsUpdated} agent${r.agentsUpdated === 1 ? '' : 's'} updated` : ''}`
        : clearedStatus,
    )
  }

  // Current value may reference a model missing from the catalog (renamed,
  // unloaded) — keep it selectable rather than silently showing something else.
  const options = models.map((m) => m.id)
  if (role?.model && !options.includes(role.model)) options.unshift(role.model)

  return (
    <div className="tts-section">
      <div className="tts-section-header">
        {icon}
        <span>{title}</span>
      </div>
      <div className="tts-section-body">
        {state === 'loading' ? (
          <div className="tts-empty">Loading current assignment…</div>
        ) : state === 'error' ? (
          <div className="tts-empty">
            Could not load the current assignment — not editable until it loads.{' '}
            <button className="tts-retry" onClick={load} style={{ cursor: 'pointer' }}>Retry</button>
          </div>
        ) : (
          <>
            <div className="tts-field">
              <label>{selectLabel}{saving ? ' (saving…)' : ''}</label>
              <select
                value={role?.model || ''}
                onChange={(e) => apply(e.target.value)}
                className="tts-select"
                disabled={saving}
              >
                <option value="">{clearOptionLabel}</option>
                {options.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              {status && <span className="tts-hint">{status}</span>}
            </div>
            <span className="tts-hint">{helperCopy}</span>
          </>
        )}
      </div>
    </div>
  )
}

const VisionDescriptionSection: React.FC = () => (
  <SupportRoleSection
    roleKey="visionDescription"
    title="Vision Description"
    icon={<Eye size={13} />}
    selectLabel="Describer Model"
    filterModels={(m) => m.capabilities?.vision === true}
    clearOptionLabel="(None — text-only agents get no image descriptions)"
    clearedStatus="cleared — text-only agents get no image descriptions"
    helperCopy={
      "Only used for text-only agents: a non-vision model can't see pixels, so incoming "
      + 'images are described to it by this model. Vision-capable agents ignore it — they '
      + 'see images natively.'
    }
  />
)

const CompactionSection: React.FC = () => (
  <SupportRoleSection
    roleKey="compaction"
    title="Compaction"
    icon={<Archive size={13} />}
    selectLabel="Compaction Model"
    filterModels={() => true}
    clearOptionLabel="(None — agents compact with their own model)"
    clearedStatus="cleared — agents compact with their own model"
    helperCopy={
      'Model that summarizes long agent contexts when they fill up (trajectory compaction). '
      + 'A fast, always-warm local model (e.g. Qwen 9B) is ideal — keeps compaction off your '
      + 'main model and off cloud credits. Applies to all agents.'
    }
  />
)

// ─── Self-populating Support-Model roles (all Hermes auxiliary tasks) ─────────
// Role list + base descriptions come LIVE from Hermes (_all_aux_tasks() via
// GET /aux-tasks) so new/removed roles reflect automatically; recommendations +
// description enrichments are user-editable (stored AI-Lab-side). Each role is a
// model dropdown from the AI-Lab proxy catalog — assigning also clears any dead
// upstream URL. Shared roles (vision/compaction/tts tags) get no Hermes badge.

// ─── Embedding-space health ───────────────────────────────────────────────────
// Answers "is every memory collection encoded by the model we currently query
// with?". Drift there degrades recall silently — every build in use is dim 4096,
// so a mismatch can never raise an error. It lives here because this is the tab
// where the embedder gets chosen, so the consequence sits next to the cause.
const EmbeddingHealthSection: React.FC = () => {
  const [data, setData] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [deep, setDeep] = useState(false)

  const load = async (withVectors: boolean) => {
    setBusy(true)
    const d = await hermesApi.getEmbeddingHealth(withVectors)
    setData(d); setBusy(false); setDeep(withVectors)
  }
  useEffect(() => { void load(false) }, [])

  const cols: any[] = data?.collections || []
  const attention: string[] = data?.attention || []
  const info: string[] = data?.informational || []
  const badge = (v: string) =>
    v === 'ok' ? { t: 'OK', c: '#3fb950' }
      : v === 'drift' ? { t: 'DRIFT', c: '#f85149' }
      : v === 'unstamped' ? { t: 'UNVERIFIED', c: '#d29922' }
      : { t: (v || '?').toUpperCase(), c: '#8b949e' }

  return (
    <div className="tts-section">
      <div className="tts-section-header">
        <Database size={13} />
        <span>Embedding Space Health</span>
        <button
          className="tts-mini-btn"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => void load(false)}
          title="Re-check encoder consistency"
        >
          <RefreshCw size={12} /> {busy ? 'checking…' : 'refresh'}
        </button>
        <button
          className="tts-mini-btn"
          disabled={busy}
          onClick={() => void load(true)}
          title="Also sample vectors to detect degenerate (shared) vectors. Slower."
        >
          deep scan
        </button>
      </div>

      {!data && <div className="tts-hint">checking…</div>}

      {data && (
        <>
          <div className="tts-hint">
            Queries are encoded with <strong>{data.expected_model || '(unset)'}</strong>. A collection
            encoded by anything else still returns results — every build here is 4096-dim, so a
            mismatch can never error — it just returns worse ones. Fix by re-embedding.
          </div>

          {attention.length > 0 && (
            <div className="tts-hint" style={{ color: '#f85149' }}>
              <strong>Action required:</strong>
              {attention.map((a, i) => <div key={i}>• {a}</div>)}
            </div>
          )}
          {attention.length === 0 && (
            <div className="tts-hint" style={{ color: '#3fb950' }}>
              All audited collections match the selected embedder.
            </div>
          )}

          <table className="tts-table" style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Collection</th>
                <th style={{ textAlign: 'left' }}>Status</th>
                <th style={{ textAlign: 'right' }}>Points</th>
                <th style={{ textAlign: 'left' }}>Encoder(s)</th>
                {deep && <th style={{ textAlign: 'right' }}>Bad vectors</th>}
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => {
                const b = badge(c.verdict)
                return (
                  <tr key={c.collection} title={c.detail}>
                    <td style={{ fontFamily: 'monospace' }}>{c.collection}</td>
                    <td style={{ color: b.c, fontWeight: 600 }}>{b.t}</td>
                    <td style={{ textAlign: 'right' }}>{c.points ?? '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                      {Object.entries(c.encoders || {})
                        .map(([m, n]) => `${m} (${n})`).join(', ') || '—'}
                    </td>
                    {deep && (
                      <td style={{ textAlign: 'right', color: c.degenerate_vectors ? '#f85149' : undefined }}>
                        {c.degenerate_vectors ?? '—'}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>

          {info.length > 0 && (
            <div className="tts-hint" style={{ opacity: 0.75 }}>
              {info.map((s, i) => <div key={i}>· {s}</div>)}
            </div>
          )}
          <div className="tts-hint" style={{ opacity: 0.7 }}>
            Sampled per collection, not a full scan. “Deep scan” also reads vectors to find points
            that share one — an embedder failure path writing a constant.
          </div>
        </>
      )}
    </div>
  )
}

// ─── Embeddings + Reranker (RAG support models) — probe-classified service picker ─────────────
const RagModelSection: React.FC<{ kind: 'embed' | 'rerank' }> = ({ kind }) => {
  const [data, setData] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const load = async () => { const d = await hermesApi.getRagModels(); setData(d) }
  useEffect(() => { void load() }, [])

  const cur = data ? (kind === 'embed' ? data.embed : data.rerank) : null
  const services: Array<{ model: string; url: string }> = data ? (kind === 'embed' ? data.embedServices : data.rerankServices) || [] : []
  const inList = !!cur && services.some((s) => s.model === cur.model)

  const doSave = async (model: string, url: string) => {
    setSaving(true); setStatus('')
    const patch = kind === 'embed' ? { embedModel: model, embedUrl: url } : { rerankModel: model, rerankUrl: url }
    const r = await hermesApi.setRagModels(patch)
    setSaving(false)
    if (r.ok) { setStatus('saved'); await load() } else setStatus(`save failed${r.error ? ` — ${r.error}` : ''}`)
  }
  const onSelect = (model: string) => {
    const url = services.find((s) => s.model === model)?.url || ''
    if (kind === 'embed' && cur && model !== cur.model) setPending(model) // require confirm — invalidates collections
    else void doSave(model, url)
  }

  return (
    <div className="tts-section">
      <div className="tts-section-header">
        {kind === 'embed' ? <Database size={13} /> : <ListOrdered size={13} />}
        <span>{kind === 'embed' ? 'Embeddings' : 'Reranker'}</span>
      </div>
      <div className="tts-section-body">
        {!data ? (
          <div className="tts-empty">Loading…</div>
        ) : (
          <>
            <div className="tts-field">
              <label>Model{saving ? ' (saving…)' : ''}</label>
              <select value={cur?.model || ''} onChange={(e) => onSelect(e.target.value)} className="tts-select" disabled={saving || !!pending}>
                {!inList && cur?.model && <option value={cur.model}>{cur.model}{cur.isDefault ? ' (default)' : ''}</option>}
                {services.map((s) => <option key={s.model} value={s.model}>{s.model}</option>)}
              </select>
              {status && <span className="tts-hint">{status}</span>}
            </div>
            {pending && (
              <div style={{ margin: '4px 0 6px', padding: '8px 10px', borderRadius: 6, border: '1px solid #c96', background: 'rgba(200,150,60,.12)', fontSize: 12, lineHeight: 1.4 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠️ This invalidates existing collections</div>
                All RAG collections were vectorized with <b>{cur?.model}</b> and won’t be searchable with a different embeddings model until re-embedded. Each collection is stamped with the model that built it; an auto-re-embed pipeline is on the roadmap. Switch to <b>{pending}</b>?
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="tts-retry" style={{ cursor: 'pointer' }} onClick={() => { const url = services.find((s) => s.model === pending)?.url || ''; void doSave(pending, url); setPending(null) }}>Switch anyway</button>
                  <button className="tts-retry" style={{ cursor: 'pointer' }} onClick={() => setPending(null)}>Cancel</button>
                </div>
              </div>
            )}
            <span className="tts-hint">
              {kind === 'embed'
                ? 'Vectorizes + searches all RAG collections. Changing it requires re-embedding existing collections.'
                : 'Re-ranks RAG search results. Safe to change anytime — no re-embedding needed.'}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

const EditableLine: React.FC<{
  label: string
  value: string
  placeholder: string
  saving: boolean
  onSave: (v: string) => void
}> = ({ label, value, placeholder, saving, onSave }) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => { setEditing(false); if (draft !== value) onSave(draft) }
  return (
    <div style={{ marginBottom: 7 }}>
      <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}{saving ? ' · saving…' : ''}</span>
      {editing ? (
        <textarea
          autoFocus
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setDraft(value); setEditing(false) }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit()
          }}
          style={{ width: '100%', resize: 'vertical', fontSize: 12, lineHeight: 1.4, fontFamily: 'inherit', padding: '4px 7px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--control-bg)', color: 'var(--fg)', marginTop: 3 }}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 1 }}>
          <span style={{ fontSize: 12, lineHeight: 1.4, flex: 1, opacity: value ? 0.85 : 0.45, fontStyle: value ? 'normal' : 'italic' }}>
            {value || placeholder}
          </span>
          <button
            onClick={() => { setDraft(value); setEditing(true) }}
            title={`Edit ${label.toLowerCase()}`}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 2, lineHeight: 0, opacity: 0.5, flexShrink: 0 }}
          >
            <Pencil size={11} />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Who is actually using this role.
 *
 * The card could only ever show one value, so a role where 9 agents carry an override and 11 sit
 * on Auto rendered as a bare "Auto" — a statement that was true of nobody. This makes the split
 * visible without making it alarming: for a capability-managed role (vision) the difference is
 * CORRECT, because Auto there means the agent's own model can already see images.
 */
const AgentBreakdown: React.FC<{ task: AuxTask }> = ({ task }) => {
  const [open, setOpen] = useState(false)
  const b = task.breakdown
  if (!b || (!b.follows.length && !b.overrides.length && !b.autos.length && !b.templates.length)) return null

  const managed = !!task.capabilityManaged
  const autoMeans = managed
    ? 'uses its own model (already vision-capable, so no describer is needed)'
    : "no model set — falls back to the agent's own model"
  const parts: string[] = []
  if (b.follows.length) parts.push(`${b.follows.length} using this card's model`)
  if (b.autos.length) parts.push(`${b.autos.length} on Auto`)
  if (b.overrides.length) parts.push(`${b.overrides.length} with a different model`)
  const summary = parts.length ? parts.join(' · ') : 'no agents'

  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '2px 0' }
  return (
    <div style={{ marginBottom: 7 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', textAlign: 'left', fontSize: 11,
                 padding: '4px 7px', borderRadius: 6, cursor: 'pointer', color: 'var(--fg-muted)',
                 border: '1px solid var(--border)', background: 'var(--control-bg)' }}
        title="Show exactly which agents follow this card and which carry their own value"
      >
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>›</span>
        <span>{summary}</span>
      </button>
      {open && (
        <div style={{ fontSize: 11, lineHeight: 1.5, padding: '6px 9px', marginTop: 4, borderRadius: 6,
                      border: '1px solid var(--border)', background: 'var(--bg-elev, rgba(128,128,128,.06))' }}>
          {b.follows.length > 0 && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                {managed ? 'Using this card’s model (their own model cannot see images)' : 'Using this card’s model'}
              </div>
              <div style={{ opacity: .75 }}>{b.follows.join(', ')}</div>
            </>
          )}
          {b.overrides.length > 0 && (
            <>
              <div style={{ fontWeight: 600, margin: '6px 0 2px' }}>Set to something else (a real override)</div>
              {b.overrides.map(({ agent, model }) => (
                <div key={agent} style={row}><span>{agent}</span><span style={{ opacity: .75 }}>{model}</span></div>
              ))}
            </>
          )}
          {b.autos.length > 0 && (
            <>
              <div style={{ fontWeight: 600, margin: '6px 0 2px' }}>Auto — {autoMeans}</div>
              <div style={{ opacity: .75 }}>{b.autos.join(', ')}</div>
            </>
          )}
          {b.templates.length > 0 && (
            <>
              <div style={{ fontWeight: 600, margin: '6px 0 2px' }}>Templates (not real agents, never applied to)</div>
              <div style={{ opacity: .6 }}>{b.templates.map((t) => t.agent).join(', ')}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const SupportModelSection: React.FC<{
  task: AuxTask
  role?: SupportModelRole
  catalog: CatalogModelWithCaps[]
  onSave: (key: string, patch: { model?: string; description?: string; recommendation?: string; timeout?: number; noThink?: boolean }) => Promise<{ ok: boolean; agentsUpdated?: number; error?: string }>
}> = ({ task, role, catalog, onSave }) => {
  // Seed from the LIVE per-agent value. Seeding from the stored overlay (role?.model) is
  // what made roles with a stale config render as "Auto" — the drift was unshowable.
  // The SETTING, not a reading of agent state — the breakdown panel below reports reality.
  const [model, setModel] = useState(task.cardModel ?? role?.model ?? '')
  const [desc, setDesc] = useState(task.description)
  const [rec, setRec] = useState(task.recommendation)
  const [noThink, setNoThink] = useState(!!role?.noThink)
  const [saving, setSaving] = useState('')
  const [status, setStatus] = useState('')

  const models = task.key === 'vision' ? catalog.filter((m) => m.capabilities?.vision === true) : catalog
  const options = models.map((m) => m.id)
  if (model && !options.includes(model)) options.unshift(model)

  const saveModel = async (m: string) => {
    setModel(m); setSaving('model'); setStatus('')
    const r = await onSave(task.key, { model: m })
    setSaving('')
    setStatus(r.ok
      ? (m ? `saved${typeof r.agentsUpdated === 'number' ? ` — ${r.agentsUpdated} agent${r.agentsUpdated === 1 ? '' : 's'}` : ''}` : 'cleared → Auto (main model)')
      : `save failed${r.error ? ` — ${r.error}` : ''}`)
  }
  const saveMeta = async (field: 'description' | 'recommendation', val: string) => {
    setSaving(field); await onSave(task.key, { [field]: val }); setSaving('')
  }
  const toggleNoThink = async (v: boolean) => {
    setNoThink(v); setSaving('noThink'); setStatus('')
    const r = await onSave(task.key, { noThink: v })
    setSaving('')
    setStatus(r.ok ? 'saved' : `save failed${r.error ? ` — ${r.error}` : ''}`)
  }

  const taBox: React.CSSProperties = { width: '100%', resize: 'vertical', fontSize: 12, lineHeight: 1.4, fontFamily: 'inherit', padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--control-bg)', color: 'var(--fg)', marginBottom: 8 }

  return (
    <div className="tts-section">
      <div className="tts-section-header">
        <CircleDot size={13} />
        <span>{task.label}</span>
        {!task.shared && !task.external && (
          <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'rgba(120,130,255,.18)', color: '#9aa6ff', letterSpacing: '.04em' }}>HERMES</span>
        )}
        {task.proxyLevel && (
          <span title="Read by the AI-Lab proxy itself, not by Hermes and not by a container. Never written into an agent's config." style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'rgba(150,140,255,.18)', color: '#a99cff', letterSpacing: '.04em' }}>PROXY</span>
        )}
        {task.providerDefault && (
          <span title="Sets providers.ailab.default_model — the model used when a call selects the AI-Lab provider without naming one. An agent with its own model is unaffected." style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'rgba(90,200,160,.18)', color: '#5ac8a0', letterSpacing: '.04em' }}>FALLBACK</span>
        )}
        {task.external && (
          <span title="Consumed by an external service (HippocampAI / OpenViking), not by a Hermes agent. Auto is not valid here — pick a concrete model." style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'rgba(255,170,60,.18)', color: '#ffb347', letterSpacing: '.04em' }}>EXTERNAL</span>
        )}
      </div>
      <div className="tts-section-body">
        <AgentBreakdown task={task} />
        {task.drift && (
          <div style={{ fontSize: 11, lineHeight: 1.45, padding: '6px 8px', marginBottom: 7, borderRadius: 6, border: '1px solid rgba(255,170,60,.35)', background: 'rgba(255,170,60,.10)', color: '#ffb347' }}>
            <strong>Agents disagree on this role.</strong> Saving a value below applies it to every agent.
            <div style={{ marginTop: 4, opacity: .9 }}>
              {Object.entries(task.perAgent || {}).map(([a, mdl]) => (
                <div key={a}>{a}: {mdl || 'Auto'}</div>
              ))}
            </div>
          </div>
        )}
        <div className="tts-field">
          <label>Model{saving === 'model' ? ' (saving…)' : ''}</label>
          <select value={model} onChange={(e) => saveModel(e.target.value)} className="tts-select" disabled={saving === 'model'}>
            <option value="">{task.external ? 'Auto — NOT SUPPORTED by this consumer'
              : task.providerDefault ? 'None — leave the provider without a default'
              : task.proxyLevel ? 'None — an unreachable model returns 503 instead of falling back'
              : 'Auto — agent’s own main model'}</option>
            {options.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          {status && <span className="tts-hint">{status}</span>}
          <button
            type="button"
            className="tts-btn"
            style={{ marginTop: 6, alignSelf: "flex-start" }}
            disabled={saving === "model"}
            title="Push the selected model to every agent again. Use this when the value here is already correct but the agents have drifted — changing the dropdown is not required."
            onClick={() => void saveModel(model)}
          >
            {saving === "model" ? "Applying…" : "Re-apply to all agents"}
          </button>
        </div>
        <div className="tts-field-row" style={{ marginBottom: 7 }}>
          <label
            className="tts-toggle"
            title="Disables the model's thinking/reasoning for this support task (writes extra_body chat_template_kwargs.enable_thinking=false). Best for local Qwen support models — a fast title/summary shouldn't burn a full think."
          >
            <input
              type="checkbox"
              checked={noThink}
              onChange={(e) => toggleNoThink(e.target.checked)}
              disabled={saving === 'noThink'}
            />
            <span className="tts-toggle-label">Disable thinking{saving === 'noThink' ? ' (saving…)' : ''}</span>
          </label>
        </div>
        <EditableLine
          label="What it does"
          value={desc}
          placeholder="No description"
          saving={saving === 'description'}
          onSave={(v) => { setDesc(v); void saveMeta('description', v) }}
        />
        <EditableLine
          label="Recommended model"
          value={rec}
          placeholder="Add a recommendation…"
          saving={saving === 'recommendation'}
          onSave={(v) => { setRec(v); void saveMeta('recommendation', v) }}
        />
      </div>
    </div>
  )
}

// Module-level cache so switching to/from the Support Models tab doesn't re-fetch + flash
// "loading" each time. The backend already version-caches the aux list; this keeps it warm on the
// client for the page session (a full page reload re-fetches once).
type SmData = { tasks: AuxTask[]; roles: Record<string, SupportModelRole>; catalog: CatalogModelWithCaps[] }
const SM_LS_KEY = 'ai-lab-support-models-cache-v1'
function smLoadPersisted(): SmData | null {
  try { const s = localStorage.getItem(SM_LS_KEY); return s ? (JSON.parse(s) as SmData) : null } catch { return null }
}
function smPersist(d: SmData): void { try { localStorage.setItem(SM_LS_KEY, JSON.stringify(d)) } catch {} }
// Seeded SYNCHRONOUSLY from localStorage so the tab paints the (Hermes-version-stable) aux list
// instantly on first render — even across a full page reload — instead of the ssh+python cold pull.
let smCache: SmData | null = smLoadPersisted()
let smInflight: Promise<boolean> | null = null
let smRevalidated = false // one background revalidation per page session (stale-while-revalidate)

function useSupportModels() {
  const [, force] = useState(0)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    // Have data AND already revalidated this session -> nothing to do (no query on tab re-visit).
    if (smCache && smRevalidated) return
    const hadCache = !!smCache
    if (!smInflight) {
      smInflight = (async () => {
        const [t, r, c] = await Promise.all([hermesApi.getAuxTasks(), hermesApi.getSupportModels(), hermesApi.listCatalog()])
        if (t && r) {
          const next: SmData = { tasks: t, roles: r, catalog: c }
          const changed = JSON.stringify(next) !== JSON.stringify(smCache)
          smCache = next; smPersist(next); smRevalidated = true
          return changed
        }
        return false
      })().finally(() => { smInflight = null })
    }
    // Re-render only when the data actually changed (Hermes updated / edited elsewhere) or when we
    // had nothing cached to show — a matching revalidation leaves the rendered list untouched.
    void smInflight.then((changed) => { if (alive) { if (!smCache) setErr(true); else if (changed || !hadCache) force((n) => n + 1) } })
    return () => { alive = false }
  }, [])
  const onSave = async (key: string, patch: { model?: string; description?: string; recommendation?: string; timeout?: number; noThink?: boolean }) => {
    const res = await hermesApi.setSupportModels({ [key]: patch })
    if (res.ok && smCache) {
      smCache = { ...smCache, roles: { ...smCache.roles, [key]: { ...(smCache.roles[key] || { provider: 'ailab', model: '' }), ...patch } } }
      smPersist(smCache)
      force((n) => n + 1)
      // Re-pull LIVE task state. Only `roles` (the overlay) is updated above, so
      // current/drift/perAgent would stay frozen -- and because this cache is persisted to
      // localStorage, a stale "agents disagree" banner survived even a full page reload.
      void hermesApi.getAuxTasks().then((t) => {
        if (t && smCache) { smCache = { ...smCache, tasks: t }; smPersist(smCache); force((n) => n + 1) }
      })
    }
    return res
  }
  return { data: smCache, err, onSave }
}

/** Universally-usable support roles (shared: vision/compression/tts tags) — rendered as fragment
 *  cards so they sit in the MANUAL grid at the top alongside TTS/STT. */
const SharedAuxCards: React.FC = () => {
  const { data, onSave } = useSupportModels()
  if (!data) return null
  return <>{data.tasks.filter((t) => t.shared).map((t) => (
    <SupportModelSection key={t.key} task={t} role={data.roles[t.key]} catalog={data.catalog} onSave={onSave} />
  ))}</>
}

/** Hermes-specific helper roles (badged) — fragment cards for the auto-generated grid. */
const HermesAuxCards: React.FC = () => {
  const { data, err, onSave } = useSupportModels()
  if (err) return <div className="tts-section"><div className="tts-empty">Could not load helper models.</div></div>
  if (!data) return <div className="tts-section"><div className="tts-empty">Loading helper models…</div></div>
  return <>{data.tasks.filter((t) => !t.shared).map((t) => (
    <SupportModelSection key={t.key} task={t} role={data.roles[t.key]} catalog={data.catalog} onSave={onSave} />
  ))}</>
}

/** Single GLOBAL auxiliary-task request timeout (seconds). Applies to EVERY aux role
 *  by PUTing { timeout } for every catalog key — one value fans out to all roles. */
const AuxTimeoutField: React.FC = () => {
  const { data } = useSupportModels()
  const initial = React.useMemo(() => {
    if (data) {
      for (const t of data.tasks) {
        const to = data.roles[t.key]?.timeout
        if (typeof to === 'number') return to
      }
    }
    return 300
  }, [data])
  const [value, setValue] = useState<number>(initial)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  useEffect(() => { setValue(initial) }, [initial])

  const save = async () => {
    if (!data || !Number.isFinite(value)) return
    setSaving(true); setStatus('')
    const patch: Record<string, { timeout: number }> = {}
    for (const t of data.tasks) patch[t.key] = { timeout: value }
    const r = await hermesApi.setSupportModels(patch)
    setSaving(false)
    setStatus(r.ok
      ? `saved${typeof r.agentsUpdated === 'number' ? ` — ${r.agentsUpdated} agent${r.agentsUpdated === 1 ? '' : 's'}` : ''}`
      : `save failed${r.error ? ` — ${r.error}` : ''}`)
  }

  return (
    <div className="tts-section" style={{ marginBottom: 12 }}>
      <div className="tts-section-header">
        <Clock size={13} />
        <span>Auxiliary Task Timeout</span>
      </div>
      <div className="tts-section-body">
        <div className="tts-field">
          <label>Auxiliary task timeout (seconds){saving ? ' (saving…)' : ''}</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              min={1}
              className="tts-input"
              style={{ maxWidth: 120 }}
              value={Number.isFinite(value) ? value : ''}
              onChange={(e) => setValue(Number(e.target.value))}
              onBlur={save}
              disabled={!data || saving}
            />
            <button
              className="tts-retry"
              style={{ cursor: 'pointer' }}
              onClick={save}
              disabled={!data || saving}
            >
              Save
            </button>
            {status && <span className="tts-hint">{status}</span>}
          </div>
          <span
            className="tts-hint"
            title="Per-auxiliary-task request timeout. Too short causes retry storms on slow local models (each timed-out retry re-fires a fresh generation). 300s is a safe default for the local V100 models."
          >
            Per-auxiliary-task request timeout. Too short causes retry storms on slow local models (each timed-out retry re-fires a fresh generation). 300s is a safe default for the local V100 models.
          </span>
        </div>
      </div>
    </div>
  )
}

export const TtsSettingsPanel: React.FC<{ store: any }> = observer(({ store }) => {
  const [ttsProviders, setTtsProviders] = useState<TtsProvider[]>([])
  const [sttProviders, setSttProviders] = useState<SttProvider[]>([])
  const [rvcModelList, setRvcModelList] = useState<RvcModel[]>([])

  // The RVC gate is SERVER state, not a local preference — the old toggle only
  // wrote localStorage, so it never actually gated anything. Read it from the
  // backend and write it back, so what the box shows is what the proxy enforces.
  const [rvcAllowed, setRvcAllowedState] = useState(false)
  const [rvcGateBusy, setRvcGateBusy] = useState(false)
  const [rvcGateError, setRvcGateError] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/proxy/audio-pipeline/settings')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        setRvcAllowedState(!!d?.config?.post?.rvc?.allowed)
        setRvcGateError('')
      } catch (e: any) {
        setRvcGateError(e?.message || String(e))
      }
    })()
  }, [])

  const setRvcAllowed = async (next: boolean) => {
    setRvcGateBusy(true)
    try {
      const r = await fetch('/api/proxy/audio-pipeline/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post: { rvc: { allowed: next } } }),
      })
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as any))
        throw new Error(b?.error || `HTTP ${r.status}`)
      }
      const d = await r.json()
      // Trust the server's answer, not the local optimistic value.
      setRvcAllowedState(!!d?.config?.post?.rvc?.allowed)
      setRvcGateError('')
    } catch (e: any) {
      setRvcGateError(e?.message || String(e))
    } finally {
      setRvcGateBusy(false)
    }
  }
  const [refreshing, setRefreshing] = useState(false)

  // Hydrate from store settings, falling back to localStorage, then defaults
  const storedTts = store.settings?.ttsConfig
    || (() => { try { return JSON.parse(localStorage.getItem('gyshell-tts-config') || 'null') } catch { return null } })()
  const storedStt = store.settings?.sttConfig
    || (() => { try { return JSON.parse(localStorage.getItem('gyshell-stt-config') || 'null') } catch { return null } })()
  const ttsConfig: TtsConfig = { ...DEFAULT_TTS_CONFIG, ...storedTts }
  const sttConfig: SttConfig = { ...DEFAULT_STT_CONFIG, ...storedStt }

  const loadProviders = () => {
    setTtsProviders(getTtsProviders())
    setSttProviders(getSttProviders())
    setRvcModelList(getRvcModels())
  }

  useEffect(() => { loadProviders() }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    await discoverModels()
    loadProviders()
    setRefreshing(false)
  }

  const updateTts = (patch: Partial<TtsConfig>) => {
    const updated = { ...ttsConfig, ...patch }
    if (store.settings) store.settings.ttsConfig = updated
    localStorage.setItem('gyshell-tts-config', JSON.stringify(updated))
  }

  const updateStt = (patch: Partial<SttConfig>) => {
    const updated = { ...sttConfig, ...patch }
    if (store.settings) store.settings.sttConfig = updated
    localStorage.setItem('gyshell-stt-config', JSON.stringify(updated))
  }

  // Collect all voices and RVC models
  const allVoices = ttsProviders.flatMap(p => p.voices)
  const uniqueVoices = [...new Set(allVoices)]
  const allTtsModels = ttsProviders.flatMap(p => p.models)
  const uniqueTtsModels = [...new Set(allTtsModels)]

  return (
    <div className="tts-settings-panel">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Volume2 size={16} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>Support Models</span>
        <button
          className={`proxlab-refresh ${refreshing ? 'spinning' : ''}`}
          onClick={handleRefresh}
          title="Refresh providers"
          style={{ marginLeft: 'auto' }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Global auxiliary-task request timeout — one value fans out to every aux role */}
      <AuxTimeoutField />

      {/* ─── Manual entries (TTS/STT + RAG + universal support models) — masonry (varied panel heights) ─── */}
      <div className="support-masonry">
      <RagModelSection kind="embed" />
      <RagModelSection kind="rerank" />
      <EmbeddingHealthSection />
      {/* ─── STT Section ──────────────────────────────────────────── */}
      <div className="tts-section">
        <div className="tts-section-header">
          <Mic size={13} />
          <span>Speech-to-Text</span>
          <label className="tts-toggle" style={{ marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={sttConfig.enabled}
              onChange={(e) => updateStt({ enabled: e.target.checked })}
            />
            <span className="tts-toggle-label">{sttConfig.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        {sttConfig.enabled && (
          <div className="tts-section-body">
            {sttProviders.length === 0 ? (
              <div className="tts-empty">No STT providers detected</div>
            ) : (
              <>
                <div className="tts-field">
                  <label>Provider</label>
                  <select
                    value={sttConfig.provider}
                    onChange={(e) => updateStt({ provider: Number(e.target.value) })}
                    className="tts-select"
                  >
                    {sttProviders.map(p => (
                      <option key={p.slot} value={p.slot}>
                        {p.providerName} (slot {p.slot}, {p.node})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="tts-field">
                  <label>Model</label>
                  <select
                    value={sttConfig.model}
                    onChange={(e) => updateStt({ model: e.target.value })}
                    className="tts-select"
                  >
                    {sttProviders
                      .find(p => p.slot === sttConfig.provider)
                      ?.models.map(m => (
                        <option key={m} value={m}>{m}</option>
                      )) || <option value="">No models available</option>}
                  </select>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ─── TTS Section ──────────────────────────────────────────── */}
      <div className="tts-section">
        <div className="tts-section-header">
          <Volume2 size={13} />
          <span>Text-to-Speech</span>
          <label className="tts-toggle" style={{ marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={ttsConfig.enabled}
              onChange={(e) => updateTts({ enabled: e.target.checked })}
            />
            <span className="tts-toggle-label">{ttsConfig.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        {ttsConfig.enabled && (
          <div className="tts-section-body">
            {ttsProviders.length === 0 ? (
              <div className="tts-empty">No TTS providers detected</div>
            ) : (
              <>
                {/* TTS Model */}
                <div className="tts-field">
                  <label>TTS Model</label>
                  <select
                    value={ttsConfig.defaultModel}
                    onChange={(e) => updateTts({ defaultModel: e.target.value })}
                    className="tts-select"
                  >
                    {uniqueTtsModels.length > 0
                      ? uniqueTtsModels.map(m => <option key={m} value={m}>{m}</option>)
                      : <option value="f5-tts">f5-tts</option>}
                  </select>
                </div>

                {/* Default Voice */}
                <div className="tts-field">
                  <label>Default Voice</label>
                  <select
                    value={ttsConfig.defaultVoice}
                    onChange={(e) => updateTts({ defaultVoice: e.target.value })}
                    className="tts-select"
                  >
                    <option value="default">default</option>
                    {uniqueVoices.filter(v => v !== 'default').map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>

                {/* RVC allow gate — SERVER-SIDE permission, not a local preference */}
                <div className="tts-field-row">
                  <label className="tts-toggle">
                    <input
                      type="checkbox"
                      checked={rvcAllowed}
                      disabled={rvcGateBusy}
                      onChange={(e) => void setRvcAllowed(e.target.checked)}
                    />
                    <span className="tts-toggle-label">Allow RVC Voice Conversion</span>
                  </label>
                  <span className="tts-hint">
                    {rvcGateError
                      ? `Error: ${rvcGateError}`
                      : rvcAllowed
                        ? 'RVC MAY be used. Each caller (agent, SillyTavern, Home Assistant) chooses whether to use it and which speaker.'
                        : 'RVC is blocked for every caller. A request naming a speaker gets it stripped and is told so.'}
                  </span>
                </div>

                {/* RVC Model (only shown when RVC enabled) */}
                {rvcAllowed && (
                  <div className="tts-field">
                    <label>RVC Voice Model</label>
                    {rvcModelList.length > 0 ? (
                      <select
                        value={ttsConfig.rvcModel}
                        onChange={(e) => updateTts({ rvcModel: e.target.value })}
                        className="tts-select"
                      >
                        <option value="">(None — select a voice)</option>
                        {rvcModelList.map(m => (
                          <option key={m.name} value={m.name}>
                            {m.name}{m.loaded ? ' (loaded)' : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={ttsConfig.rvcModel}
                        onChange={(e) => updateTts({ rvcModel: e.target.value })}
                        placeholder="Enter RVC model name (no models discovered)"
                        className="tts-input"
                      />
                    )}
                    <span className="tts-hint">
                      {rvcModelList.length > 0
                        ? `${rvcModelList.length} voice models available`
                        : 'Could not discover RVC models — enter name manually'}
                    </span>
                  </div>
                )}

                {/* Provider status */}
                <div className="tts-providers-summary">
                  <span className="tts-providers-label">Available providers:</span>
                  {ttsProviders.map(p => (
                    <span key={p.slot} className="tts-provider-badge">
                      <CircleDot size={6} className={p.status === 'healthy' ? 'active' : ''} />
                      {p.providerName} (slot {p.slot})
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <SharedAuxCards />
      </div>

      {/* ─── divider: manual entries (above) vs auto-generated Hermes roles (below) ─── */}
      <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 12px', paddingTop: 12 }}>
        <div className="tts-hint" style={{ fontWeight: 700, opacity: 0.75, marginBottom: 10 }}>
          Auto-generated helper models (from Hermes)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, alignItems: 'start' }}>
          <HermesAuxCards />
        </div>
      </div>
    </div>
  )
})

// ─── Voice Selector Popup ─────────────────────────────────────────────────────

export interface VoiceSelectorProps {
  onClose: () => void
  onSave: (voice: string, rvcVoice?: string) => void
  currentVoice?: string
  currentRvcVoice?: string
  ttsConfig: TtsConfig
  voices: string[]
  rvcModels: RvcModel[]
}

export const VoiceSelector: React.FC<VoiceSelectorProps> = ({
  onClose, onSave, currentVoice, currentRvcVoice, ttsConfig, voices, rvcModels,
}) => {
  const [voice, setVoice] = useState(currentVoice || ttsConfig.defaultVoice || 'default')
  // "__none__" means explicitly no RVC — distinguish from empty/undefined which means "use default"
  const [rvcVoice, setRvcVoice] = useState(currentRvcVoice || '__none__')

  return createPortal(
    <div className="voice-selector-overlay" onClick={onClose}>
      <div className="voice-selector-popup" onClick={(e) => e.stopPropagation()}>
        <div className="voice-selector-header">
          <Volume2 size={14} />
          <span>Voice Settings</span>
          <button className="voice-selector-close" onClick={onClose}>x</button>
        </div>

        <div className="voice-selector-body">
          <div className="tts-field">
            <label>TTS Voice ({voices.length} available)</label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="tts-select"
              style={{ minHeight: 28 }}
            >
              <option value="default">default</option>
              {voices.filter(v => v !== 'default').map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>

          {ttsConfig.rvcEnabled && (
            <div className="tts-field">
              <label>RVC Voice Model</label>
              {rvcModels.length > 0 ? (
                <select
                  value={rvcVoice}
                  onChange={(e) => setRvcVoice(e.target.value)}
                  className="tts-select"
                >
                  <option value="__none__">(None — skip RVC)</option>
                  {rvcModels.map(m => (
                    <option key={m.name} value={m.name}>
                      {m.name}{m.loaded ? ' (loaded)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={rvcVoice}
                  onChange={(e) => setRvcVoice(e.target.value)}
                  placeholder="RVC model name"
                  className="tts-input"
                />
              )}
            </div>
          )}
        </div>

        <div className="voice-selector-footer">
          <button
            className="voice-selector-save"
            onClick={() => onSave(voice, ttsConfig.rvcEnabled ? rvcVoice : undefined)}
          >
            Save
          </button>
          <button className="voice-selector-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
