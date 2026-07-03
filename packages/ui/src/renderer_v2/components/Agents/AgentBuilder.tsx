import React, { useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Save, Bot } from 'lucide-react'
import { hermesAgentSpecSchema, type CatalogModel, type HermesAgentSpec } from '@gyshell/shared'
import { hermesAgentsStore as store } from '../../stores/HermesAgentsStore'
import styles from './Agents.module.scss'

/** Source-tag badge for a catalog model (local models are untagged on the wire —
 *  the catalog metadata carries tag 'AI-LAB'). */
export const TagBadge: React.FC<{ tag: string }> = ({ tag }) => (
  <span className={`${styles.tagBadge} ${tag === 'AI-LAB' ? styles.tagLocal : styles.tagExternal}`}>{tag}</span>
)

interface Props {
  /** When set, the form edits an existing agent (id locked). */
  initialSpec?: HermesAgentSpec | null
  /** Locked agent id when editing an agent whose spec read-back isn't available. */
  editId?: string
  onSaved: (agentId: string) => void
}

/**
 * Create/edit a Hermes agent (workstream: agent-builder). Edits a HermesAgentSpec;
 * Save = POST /api/hermes/agents (idempotent apply — the backend provisions the
 * Hermes profile on CT158 over SSH).
 */
export const AgentBuilder: React.FC<Props> = observer(({ initialSpec, editId, onSaved }) => {
  const editing = Boolean(initialSpec || editId)
  const [agentId, setAgentId] = useState(initialSpec?.agentId ?? editId ?? '')
  const [displayName, setDisplayName] = useState(initialSpec?.displayName ?? '')
  const [model, setModel] = useState(initialSpec?.model ?? '')
  const [soul, setSoul] = useState(initialSpec?.persona?.soul ?? '')
  const [personality, setPersonality] = useState(initialSpec?.persona?.personality ?? '')
  const [toolsets, setToolsets] = useState((initialSpec?.toolsets ?? []).join(', '))
  const [mode, setMode] = useState<'default' | 'accept_edits'>(initialSpec?.mode ?? 'default')
  const [maxSubAgents, setMaxSubAgents] = useState(initialSpec?.subAgents?.maxConcurrent ?? 0)
  const [enabled, setEnabled] = useState(initialSpec?.enabled ?? true)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!store.catalogLoaded) void store.loadCatalog()
  }, [])

  // Keep a stale model selectable when the catalog no longer lists it (edit flow).
  const models = useMemo<CatalogModel[]>(() => {
    if (model && !store.catalog.some((m) => m.id === model)) {
      return [{ id: model, tag: 'AI-LAB', sourceId: 'ai-lab', upstreamModel: model, displayName: `${model} (not in catalog)`, kind: 'local' }, ...store.catalog]
    }
    return store.catalog
  }, [model, store.catalog, store.catalogLoaded])

  const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '')
  const busy = store.busyIds.has(agentId)

  const save = async () => {
    const candidate = {
      agentId,
      displayName: displayName || agentId,
      model,
      persona: soul || personality ? { soul: soul || undefined, personality: personality || undefined } : undefined,
      toolsets: toolsets.split(',').map((t) => t.trim()).filter(Boolean),
      mode,
      subAgents: maxSubAgents > 0 ? { maxConcurrent: maxSubAgents, allowedKinds: [] } : undefined,
      enabled,
    }
    const parsed = hermesAgentSpecSchema.safeParse(candidate)
    if (!parsed.success) {
      setMsg(parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join(' · '))
      return
    }
    setMsg('Provisioning profile on CT158…')
    const r = await store.apply(parsed.data)
    if (r.ok) {
      setMsg(null)
      onSaved(parsed.data.agentId)
    } else {
      setMsg(r.error || 'apply failed')
    }
  }

  return (
    <div className={styles.builder}>
      <div className={styles.builderHead}>
        <Bot size={16} />
        <strong>{editing ? `Edit agent — ${agentId}` : 'New Hermes agent'}</strong>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.label}>Agent id</label>
        <input
          className={styles.input}
          value={agentId}
          disabled={editing}
          placeholder="scout"
          onChange={(e) => setAgentId(slugify(e.target.value))}
        />

        <label className={styles.label}>Display name</label>
        <input className={styles.input} value={displayName} placeholder={agentId || 'Scout'} onChange={(e) => setDisplayName(e.target.value)} />

        <label className={styles.label}>Model</label>
        <div className={styles.modelRow}>
          <select className={styles.input} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="" disabled>
              {store.catalogLoaded ? (models.length ? 'pick a model…' : 'catalog empty') : 'loading catalog…'}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                [{m.tag}] {m.displayName}
              </option>
            ))}
          </select>
          {model && <TagBadge tag={models.find((m) => m.id === model)?.tag ?? 'AI-LAB'} />}
        </div>

        <label className={styles.label}>Personality</label>
        <input
          className={styles.input}
          value={personality}
          placeholder="preset id (helpful / technical / …) or an inline one-liner"
          onChange={(e) => setPersonality(e.target.value)}
        />

        <label className={styles.label}>SOUL.md</label>
        <textarea
          className={styles.soul}
          value={soul}
          placeholder={'# Persona\nDeep persona / operating rules written into the profile as SOUL.md…'}
          onChange={(e) => setSoul(e.target.value)}
        />

        <label className={styles.label}>Toolsets</label>
        <input
          className={styles.input}
          value={toolsets}
          placeholder="comma-separated Hermes toolset ids (empty = profile defaults)"
          onChange={(e) => setToolsets(e.target.value)}
        />

        <label className={styles.label}>Permission mode</label>
        <select className={styles.input} value={mode} onChange={(e) => setMode(e.target.value as 'default' | 'accept_edits')}>
          <option value="default">default — ask before edits</option>
          <option value="accept_edits">accept_edits — auto-allow workspace/tmp</option>
        </select>

        <label className={styles.label}>Max sub-agents</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          value={maxSubAgents}
          onChange={(e) => setMaxSubAgents(Math.max(0, Number(e.target.value) || 0))}
        />

        <label className={styles.label}>Enabled</label>
        <input type="checkbox" className={styles.check} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      </div>

      {msg && <div className={styles.formMsg}>{msg}</div>}

      <div className={styles.builderActions}>
        <button className={styles.btnPrimary} disabled={busy || !agentId || !model} onClick={() => void save()}>
          <Save size={13} /> {editing ? 'Apply changes' : 'Create agent'}
        </button>
      </div>
    </div>
  )
})
