import React, { useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  Bot,
  CalendarClock,
  Database,
  FileText,
  Fingerprint,
  Hash,
  PenLine,
  Save,
  SendHorizonal,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { hermesAgentSpecSchema, type HermesAgentSpec } from '@gyshell/shared'
import type { CatalogModelWithCaps, ModelCapabilities } from '../../stores/hermesApi'
import { hermesAgentsStore as store } from '../../stores/HermesAgentsStore'
import { hermesApi } from '../../stores/hermesApi'
import { AgentDocs, InlineDocEditor } from './AgentDocs'
import { AgentNativeTools } from './AgentNativeTools'
import { AgentSkills } from './AgentSkills'
import { HermesToolPicker } from './HermesToolPicker'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Agents.module.scss'

/** Source-tag badge for a catalog model (local models are untagged on the wire —
 *  the catalog metadata carries tag 'AI-LAB'). */
export const TagBadge: React.FC<{ tag: string }> = ({ tag }) => (
  <span className={`${styles.tagBadge} ${tag === 'AI-LAB' ? styles.tagLocal : styles.tagExternal}`}>{tag}</span>
)

/** Compact option-label suffix: 👁 vision · 🔊 audio (text is the implied default). */
export const capGlyphs = (c?: ModelCapabilities): string => `${c?.vision ? ' 👁' : ''}${c?.audio ? ' 🔊' : ''}`

/** Proper badges (with tooltips) for real DOM contexts — next to pickers/rows. */
export const CapBadges: React.FC<{ caps?: ModelCapabilities }> = ({ caps }) => {
  if (!caps?.vision && !caps?.audio) return null
  return (
    <>
      {caps.vision && <span className={styles.capBadge} title="Vision — can see images/screenshots (enables page-aware screenshots in chat)">👁</span>}
      {caps.audio && <span className={styles.capBadge} title="Audio — can hear/process audio input">🔊</span>}
    </>
  )
}

type SectionKey = 'identity' | 'model' | 'persona' | 'docs' | 'memory' | 'skills' | 'tools' | 'channels' | 'schedules'

const SECTIONS: Array<{ key: SectionKey; label: string; Icon: LucideIcon }> = [
  { key: 'identity', label: 'Identity', Icon: Fingerprint },
  { key: 'model', label: 'Model & behavior', Icon: Bot },
  { key: 'persona', label: 'Persona · SOUL', Icon: PenLine },
  { key: 'docs', label: 'Docs', Icon: FileText },
  { key: 'memory', label: 'Memory', Icon: Database },
  { key: 'skills', label: 'Skills', Icon: Sparkles },
  { key: 'tools', label: 'Tools', Icon: Wrench },
  { key: 'channels', label: 'Channels', Icon: Hash },
  { key: 'schedules', label: 'Schedules', Icon: CalendarClock },
]

interface Props {
  /** Existing agent's stored spec (null = exists but never applied through AI-Lab). */
  initialSpec?: HermesAgentSpec | null
  /** Where the spec came from (d747af5): 'hermes-live' = reconstructed from
   *  the live host profile, not yet adopted as an AI-Lab spec. */
  specSource?: 'ailab-spec' | 'hermes-live'
  /** Locked id when editing; absent = create flow. */
  editId?: string
  onSaved: (agentId: string) => void
  /** Remove the agent (edit flow only). */
  onDeleted?: () => void
}

/**
 * Hermes agent editor — prototype-2a layout (header row · pill sub-tabs · grouped
 * cards), AI-Lab styling. Edits a HermesAgentSpec; Save = POST /api/hermes/agents
 * (idempotent apply → provisions the profile on CT158). Channels + Schedules have
 * no backend yet and render as planned stubs — nothing there is wired.
 */
export const AgentEditor: React.FC<Props> = observer(({ initialSpec, specSource, editId, onSaved, onDeleted }) => {
  const editing = Boolean(initialSpec || editId)
  const [section, setSection] = useState<SectionKey>('identity')
  const [agentId, setAgentId] = useState(initialSpec?.agentId ?? editId ?? '')
  const [displayName, setDisplayName] = useState(initialSpec?.displayName ?? '')
  const [description, setDescription] = useState(initialSpec?.description ?? '')
  const [model, setModel] = useState(initialSpec?.model ?? '')
  const [soul, setSoul] = useState(initialSpec?.persona?.soul ?? '')
  const [soulOpen, setSoulOpen] = useState(false)
  const [personality, setPersonality] = useState(initialSpec?.persona?.personality ?? '')
  const [toolsets, setToolsets] = useState<string[]>(initialSpec?.toolsets ?? [])
  const [toolDraft, setToolDraft] = useState('')
  const [mode, setMode] = useState<'default' | 'accept_edits'>(initialSpec?.mode ?? 'default')
  const [sub, setSub] = useState({
    model: initialSpec?.subAgents?.model ?? '',
    reasoningEffort: initialSpec?.subAgents?.reasoningEffort ?? '',
    maxConcurrent: initialSpec?.subAgents?.maxConcurrent ?? 0,
    maxSpawnDepth: initialSpec?.subAgents?.maxSpawnDepth ?? 0,
    autoApproveDangerous: initialSpec?.subAgents?.autoApproveDangerous ?? false,
  })
  const [tts, setTts] = useState({
    provider: initialSpec?.tts?.provider ?? '',
    voiceId: initialSpec?.tts?.voiceId ?? '',
    modelId: initialSpec?.tts?.modelId ?? '',
    rvcEnabled: initialSpec?.tts?.rvcEnabled ?? false,
    rvcModel: initialSpec?.tts?.rvcModel ?? '',
    preset: initialSpec?.tts?.preset ?? '',
  })
  // Options for the local pool. Loaded once, only when 'ailab' is actually selected —
  // these are live LAN calls and there is no reason to make them for an agent using an
  // external provider or no voice at all.
  const [pool, setPool] = useState<{ voices: string[]; models: string[]; rvc: string[]; presets: string[]; rvcAllowed: boolean; loaded: boolean; error: string }>(
    { voices: [], models: [], rvc: [], presets: [], rvcAllowed: false, loaded: false, error: '' },
  )
  useEffect(() => {
    if (tts.provider !== 'ailab' || pool.loaded) return
    let alive = true
    void (async () => {
      const get = async (p: string) => { const r = await fetch(p); if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`); return r.json() }
      try {
        const [v, m, rv, pr, ap] = await Promise.all([
          get('/api/proxy/multi-tts/voices'),
          get('/api/proxy/multi-tts/v1/models'),
          get('/api/proxy/multi-tts/rvc-models'),
          get('/api/proxy/multi-tts/voice-presets'),
          get('/api/proxy/audio-pipeline/settings'),
        ])
        if (!alive) return
        setPool({
          voices: (v?.voices ?? []).map((x: any) => x.id ?? x).filter(Boolean),
          // /v1/models ids are composite "<provider>/<model>"; the backends want the bare
          // model, so strip the provider the same way the speech route does.
          models: Array.from(new Set((m?.data ?? []).map((x: any) => x.model ?? String(x.id ?? '').split('/').pop()).filter(Boolean))) as string[],
          rvc: (rv?.models ?? []).map((x: any) => x.name ?? x).filter(Boolean),
          presets: Object.keys(pr ?? {}),
          rvcAllowed: Boolean(ap?.config?.post?.rvc?.allowed),
          loaded: true,
          error: '',
        })
      } catch (e: any) {
        // SAY SO. An empty dropdown that looks like "no voices exist" instead of "the
        // request failed" is the exact confusion this codebase keeps getting bitten by.
        if (alive) setPool((p) => ({ ...p, loaded: true, error: String(e?.message ?? e) }))
      }
    })()
    return () => { alive = false }
  }, [tts.provider])
  const [fallback, setFallback] = useState<string[]>(initialSpec?.fallback ?? [])
  // String state so blank ("use the model default") is distinct from any number.
  const [maxTokens, setMaxTokens] = useState<string>(initialSpec?.maxTokens ? String(initialSpec.maxTokens) : '')
  const [enabled, setEnabled] = useState(initialSpec?.enabled ?? true)
  const [dirty, setDirty] = useState(!editing)
  const [msg, setMsg] = useState<string | null>(null)

  // Interim quick-test (edit flow) — replaced by the streaming chat surface next task.
  const [testText, setTestText] = useState('')
  const [testLog, setTestLog] = useState<Array<{ who: 'you' | 'agent' | 'error'; text: string }>>([])
  const [testWaiting, setTestWaiting] = useState(false)

  useEffect(() => {
    if (!store.catalogLoaded) void store.loadCatalog()
  }, [])

  // Live SOUL.md truth (backend 3cfbca5): the stored spec's persona.soul is
  // empty for every agent — the real file lives on the Hermes host. Fetch it
  // for existing agents and override the seed, unless the user already edited.
  const liveSoulRef = useRef<string | null>(null)
  const dirtyRef = useRef(dirty)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => {
    const id = initialSpec?.agentId ?? editId
    if (!editing || !id) return
    void hermesApi.getSoul(id).then((live) => {
      if (live === null) return // fetch failed — keep the seed; save() won't blind-PUT either
      liveSoulRef.current = live
      if (!dirtyRef.current) setSoul(live)
    })
  }, [])

  const touch = () => { setDirty(true); setMsg(null) }

  // Keep a stale model selectable when the catalog no longer lists it (edit flow).
  const models = useMemo<CatalogModelWithCaps[]>(() => {
    if (model && !store.catalog.some((m) => m.id === model)) {
      return [{ id: model, tag: 'AI-LAB', sourceId: 'ai-lab', upstreamModel: model, displayName: `${model} (not in catalog)`, kind: 'local' }, ...store.catalog]
    }
    return store.catalog
  }, [model, store.catalog, store.catalogLoaded])

  const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '')
  const busy = store.busyIds.has(agentId)
  const glyph = (displayName || agentId || '?').charAt(0).toUpperCase()

  const resetToInitial = () => {
    setAgentId(initialSpec?.agentId ?? editId ?? '')
    setDisplayName(initialSpec?.displayName ?? '')
    setDescription(initialSpec?.description ?? '')
    setModel(initialSpec?.model ?? '')
    setSoul(liveSoulRef.current ?? initialSpec?.persona?.soul ?? '')
    setPersonality(initialSpec?.persona?.personality ?? '')
    setToolsets(initialSpec?.toolsets ?? [])
    setMode(initialSpec?.mode ?? 'default')
    setSub({
      model: initialSpec?.subAgents?.model ?? '',
      reasoningEffort: initialSpec?.subAgents?.reasoningEffort ?? '',
      maxConcurrent: initialSpec?.subAgents?.maxConcurrent ?? 0,
      maxSpawnDepth: initialSpec?.subAgents?.maxSpawnDepth ?? 0,
      autoApproveDangerous: initialSpec?.subAgents?.autoApproveDangerous ?? false,
    })
    setTts({ provider: initialSpec?.tts?.provider ?? '', voiceId: initialSpec?.tts?.voiceId ?? '', modelId: initialSpec?.tts?.modelId ?? '', rvcEnabled: initialSpec?.tts?.rvcEnabled ?? false, rvcModel: initialSpec?.tts?.rvcModel ?? '', preset: initialSpec?.tts?.preset ?? '' })
    setFallback(initialSpec?.fallback ?? [])
    setMaxTokens(initialSpec?.maxTokens ? String(initialSpec.maxTokens) : '')
    setEnabled(initialSpec?.enabled ?? true)
    setDirty(false)
    setMsg(null)
  }

  const save = async () => {
    const candidate = {
      agentId,
      displayName: displayName || agentId,
      description: description || undefined,
      model,
      persona: soul || personality ? { soul: soul || undefined, personality: personality || undefined } : undefined,
      toolsets,
      mode,
      fallback,
      maxTokens: /^[0-9]+$/.test(maxTokens) && Number(maxTokens) > 0 ? Number(maxTokens) : undefined,
      subAgents:
        sub.model || sub.reasoningEffort || sub.maxConcurrent > 0 || sub.maxSpawnDepth > 0 || sub.autoApproveDangerous
          ? {
              model: sub.model || undefined,
              reasoningEffort: (sub.reasoningEffort || undefined) as 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none' | undefined,
              maxConcurrent: sub.maxConcurrent > 0 ? sub.maxConcurrent : undefined,
              maxSpawnDepth: sub.maxSpawnDepth > 0 ? sub.maxSpawnDepth : undefined,
              autoApproveDangerous: sub.autoApproveDangerous || undefined,
            }
          : undefined,
      tts: tts.provider
        ? {
            provider: tts.provider,
            voiceId: tts.voiceId || undefined,
            modelId: tts.modelId || undefined,
            // ailab-only fields. Never persisted for an external provider, so switching
            // provider cannot leave orphaned RVC settings behind that nothing displays.
            ...(tts.provider === 'ailab'
              ? {
                  rvcEnabled: tts.rvcEnabled || undefined,
                  rvcModel: (tts.rvcEnabled && tts.rvcModel) || undefined,
                  preset: tts.preset || undefined,
                }
              : {}),
          }
        : undefined,
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
      // SOUL.md goes through its own endpoint (writes the real file on the
      // Hermes host — works even for spec-less agents). Only when it actually
      // changed vs the loaded truth: if the GET failed and the user didn't
      // touch the field, we must never blind-overwrite the live file with ''.
      let soulNote = ''
      const soulBase = liveSoulRef.current ?? initialSpec?.persona?.soul ?? ''
      if (soul !== soulBase) {
        const sr = await hermesApi.putSoul(parsed.data.agentId, soul)
        if (sr.ok) liveSoulRef.current = soul
        else soulNote = ` (SOUL.md write failed: ${sr.error ?? 'unknown'})`
      }
      setMsg(`Saved ✓${soulNote}`)
      setDirty(false)
      onSaved(parsed.data.agentId)
    } else {
      setMsg(r.error || 'apply failed')
    }
  }

  const remove = async () => {
    const ok = await confirmStore.confirm({
      title: 'Delete agent',
      message: `Delete the “${agentId}” Hermes profile on CT158? Its persona, config, memory and sessions are removed.`,
      confirmText: 'Delete',
    })
    if (!ok) return
    const r = await store.remove(agentId)
    if (r.ok) onDeleted?.()
    else setMsg(r.error || 'delete failed')
  }

  const addTool = () => {
    const t = toolDraft.trim()
    if (!t) return
    if (!toolsets.includes(t)) { setToolsets([...toolsets, t]); touch() }
    setToolDraft('')
  }

  const runTest = async () => {
    const t = testText.trim()
    if (!t || testWaiting) return
    setTestText('')
    setTestLog((l) => [...l, { who: 'you', text: t }])
    setTestWaiting(true)
    const r = await hermesApi.prompt(agentId, t)
    setTestWaiting(false)
    setTestLog((l) => [...l, r.ok ? { who: 'agent', text: r.reply || '(empty reply)' } : { who: 'error', text: r.error || 'prompt failed' }])
  }

  const card = (children: React.ReactNode) => <div className={styles.card}>{children}</div>

  // Contextual twins of the Docs-tab editors (Travis: place each operating doc
  // where it's topically relevant; the Docs tab remains the everything-view).
  const liveDocId = editing ? (initialSpec?.agentId ?? editId ?? agentId) : ''
  const inlineDoc = (path: string, hint: string) =>
    liveDocId
      ? <InlineDocEditor agentId={liveDocId} path={path} hint={hint} />
      : <div className={styles.dim}>Save the agent first — its docs live on the provisioned Hermes profile.</div>

  return (
    <div className={styles.editor}>
      {/* ── header row: avatar · name/breadcrumb · enabled · actions ── */}
      <div className={styles.editorHead}>
        <div className={styles.avatar}>{glyph}</div>
        <div className={styles.headTitle}>
          <strong>{displayName || agentId || 'New agent'}</strong>
          <span className={styles.breadcrumb}>
            agents / {agentId || '—'}
            {specSource === 'hermes-live' && (
              <span
                className={styles.liveBadge}
                title="This spec was reconstructed from the live Hermes host profile — it has no stored AI-Lab spec yet. Save to adopt it (clobber-safe: live toolsets/description untouched)."
              >
                synced from Hermes — Save to adopt
              </span>
            )}
          </span>
        </div>
        <button
          className={`${styles.enabledPill} ${enabled ? styles.enabledOn : ''}`}
          title="Toggle enabled (saved with the spec)"
          onClick={() => { setEnabled((e) => !e); touch() }}
        >
          <span className={styles.enabledDot} /> {enabled ? 'Enabled' : 'Disabled'}
        </button>
        <span className={styles.spacer} />
        {editing && (
          <button className={styles.btnDanger} disabled={busy} onClick={() => void remove()}>
            <Trash2 size={13} /> Delete
          </button>
        )}
        <button className={styles.btn} disabled={busy || !dirty} onClick={resetToInitial}>
          <Undo2 size={13} /> Discard
        </button>
        <button className={styles.btnPrimary} disabled={busy || !dirty || !agentId || !model} onClick={() => void save()}>
          <Save size={13} /> Save agent
        </button>
      </div>

      {/* ── pill sub-tabs ── */}
      <div className={styles.pills}>
        {SECTIONS.map(({ key, label, Icon }) => (
          <button key={key} className={`${styles.pill} ${section === key ? styles.pillActive : ''}`} onClick={() => setSection(key)}>
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>

      {msg && <div className={msg === 'Saved ✓' ? styles.okMsg : styles.formMsg}>{msg}</div>}

      {/* ── sections ── */}
      {section === 'identity' && (
        <section>
          <div className={styles.sectionTitle}>Identity</div>
          <div className={styles.sectionSub}>How the agent is named and presented.</div>
          {card(
            <div className={styles.identityGrid}>
              <div className={styles.avatarBig}>{glyph}</div>
              <div className={styles.identityFields}>
                <div className={styles.fieldCol}>
                  <label className={styles.label}>Agent id</label>
                  <input
                    className={`${styles.input} ${styles.mono}`}
                    value={agentId}
                    disabled={editing}
                    placeholder="scout"
                    onChange={(e) => { setAgentId(slugify(e.target.value)); touch() }}
                  />
                </div>
                <div className={styles.fieldCol}>
                  <label className={styles.label}>Display name</label>
                  <input className={styles.input} value={displayName} placeholder={agentId || 'Scout'} onChange={(e) => { setDisplayName(e.target.value); touch() }} />
                </div>
                <div className={`${styles.fieldCol} ${styles.fieldWide}`}>
                  <label className={styles.label}>Description</label>
                  <input
                    className={styles.input}
                    value={description}
                    placeholder="Recon & research agent — scouts sources and returns tight briefs."
                    onChange={(e) => { setDescription(e.target.value); touch() }}
                  />
                </div>
              </div>
            </div>,
          )}
        </section>
      )}

      {section === 'model' && (
        <section>
          <div className={styles.sectionTitle}>Model & behavior</div>
          <div className={styles.sectionSub}>The engine and how much latitude it gets.</div>
          {card(
            <div className={styles.twoCol}>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Model</label>
                <div className={styles.modelRow}>
                  <select className={`${styles.input} ${styles.mono}`} value={model} onChange={(e) => { setModel(e.target.value); touch() }}>
                    <option value="" disabled>
                      {store.catalogLoaded ? (models.length ? 'pick a model…' : 'catalog empty') : 'loading catalog…'}
                    </option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        [{m.tag}] {m.displayName}{capGlyphs(m.capabilities)}
                      </option>
                    ))}
                  </select>
                  {model && <TagBadge tag={models.find((m) => m.id === model)?.tag ?? 'AI-LAB'} />}
                  {model && <CapBadges caps={models.find((m) => m.id === model)?.capabilities} />}
                </div>
              </div>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Personality preset</label>
                <input
                  className={styles.input}
                  value={personality}
                  placeholder="preset id (helpful / technical / …) or an inline one-liner"
                  onChange={(e) => { setPersonality(e.target.value); touch() }}
                />
              </div>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Permission mode</label>
                <select className={styles.input} value={mode} onChange={(e) => { setMode(e.target.value as 'default' | 'accept_edits'); touch() }}>
                  <option value="default">default — ask before edits</option>
                  <option value="accept_edits">accept_edits — auto-allow workspace/tmp</option>
                </select>
              </div>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Max generation length</label>
                <input
                  className={`${styles.input} ${styles.mono}`}
                  inputMode="numeric"
                  value={maxTokens}
                  placeholder="blank = model default"
                  title="Caps how many tokens the agent can output in a single turn — prevents runaway generations. Leave blank for the model default; 4096–8192 is plenty for tool-driven agents."
                  onChange={(e) => { setMaxTokens(e.target.value.replace(/[^0-9]/g, '')); touch() }}
                />
              </div>
            </div>,
          )}

          <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Fallback chain</div>
          <div className={styles.sectionSub}>Ordered catalog models tried when the primary fails (rate-limit/overload/connection) — failover, not quality switching.</div>
          {card(
            <>
              {fallback.map((fid, i) => (
                <div key={fid} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 12 }}>
                  <span className={styles.mono} style={{ color: 'var(--fg-muted)', width: 16 }}>{i + 1}.</span>
                  <span className={styles.mono} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{fid}</span>
                  <CapBadges caps={models.find((m) => m.id === fid)?.capabilities} />
                  <button className={styles.btn} disabled={i === 0} title="Move up" onClick={() => { const f = [...fallback]; f.splice(i - 1, 0, f.splice(i, 1)[0]); setFallback(f); touch() }}>↑</button>
                  <button className={styles.btn} disabled={i === fallback.length - 1} title="Move down" onClick={() => { const f = [...fallback]; f.splice(i + 1, 0, f.splice(i, 1)[0]); setFallback(f); touch() }}>↓</button>
                  <button className={styles.btnDanger} title="Remove" onClick={() => { setFallback(fallback.filter((x) => x !== fid)); touch() }}>×</button>
                </div>
              ))}
              {fallback.length === 0 && <div className={styles.dim}>no fallback — primary only</div>}
              {/* Multi-ADD picker: selecting a model APPENDS to the chain and the
                  select snaps back to the placeholder for the next add. (The old
                  <datalist> input kept the picked value, so reopening it filtered
                  the popup to the already-selected model — single-select feel,
                  capped the chain at one.) Primary + already-chained excluded. */}
              <div className={styles.promptRow} style={{ marginTop: 8 }}>
                <select
                  className={`${styles.input} ${styles.mono}`}
                  value=""
                  onChange={(e) => {
                    const id = e.target.value
                    if (id && !fallback.includes(id) && id !== model) { setFallback([...fallback, id]); touch() }
                  }}
                >
                  <option value="" disabled>
                    {models.filter((m) => m.id !== model && !fallback.includes(m.id)).length
                      ? `add fallback #${fallback.length + 1}…`
                      : 'no more catalog models to add'}
                  </option>
                  {models.filter((m) => m.id !== model && !fallback.includes(m.id)).map((m) => (
                    <option key={m.id} value={m.id}>[{m.tag}] {m.displayName}{capGlyphs(m.capabilities)}</option>
                  ))}
                </select>
              </div>
            </>,
          )}

          <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Sub-agents</div>
          <div className={styles.sectionSub}>Delegation children (same profile). Key lever: a cheaper/faster model override; empty = inherit the parent&apos;s.</div>
          {card(
            <div className={styles.twoCol}>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Sub-agent model</label>
                <select className={`${styles.input} ${styles.mono}`} value={sub.model} onChange={(e) => { setSub({ ...sub, model: e.target.value }); touch() }}>
                  <option value="">inherit parent</option>
                  {models.map((m) => <option key={m.id} value={m.id}>[{m.tag}] {m.displayName}{capGlyphs(m.capabilities)}</option>)}
                </select>
              </div>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Reasoning effort</label>
                <select className={styles.input} value={sub.reasoningEffort} onChange={(e) => { setSub({ ...sub, reasoningEffort: e.target.value }); touch() }}>
                  <option value="">inherit parent</option>
                  {['xhigh', 'high', 'medium', 'low', 'minimal', 'none'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Max concurrent</label>
                <input className={`${styles.input} ${styles.mono}`} type="number" min={0} title="0 = Hermes default" value={sub.maxConcurrent} onChange={(e) => { setSub({ ...sub, maxConcurrent: Math.max(0, Number(e.target.value) || 0) }); touch() }} />
              </div>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Max spawn depth</label>
                <input className={`${styles.input} ${styles.mono}`} type="number" min={0} title="1 = flat, 2 = orchestrator→leaf; 0 = Hermes default" value={sub.maxSpawnDepth} onChange={(e) => { setSub({ ...sub, maxSpawnDepth: Math.max(0, Number(e.target.value) || 0) }); touch() }} />
              </div>
              <div className={`${styles.fieldCol} ${styles.fieldWide}`}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-muted)' }}>
                  <input type="checkbox" checked={sub.autoApproveDangerous} onChange={(e) => { setSub({ ...sub, autoApproveDangerous: e.target.checked }); touch() }} />
                  auto-approve dangerous commands in sub-agent threads (default deny)
                </label>
              </div>
            </div>,
          )}

          <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Voice (TTS)</div>
          <div className={styles.sectionSub}>Per-agent voice. The provider&apos;s API key lives ONCE in Settings › Cluster › External Services › Provider services.</div>
          {card(
            <div className={styles.twoCol}>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Provider</label>
                <select className={styles.input} value={tts.provider} onChange={(e) => { setTts({ ...tts, provider: e.target.value, modelId: '', voiceId: '', preset: '', rvcModel: '', rvcEnabled: false }); touch() }}>
                  <option value="">none</option>
                  <option value="ailab">ailab — local TTS pool (voices, RVC, presets)</option>
                  {['elevenlabs', 'edge', 'openai', 'minimax', 'gemini', 'mistral'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Voice id</label>
                {tts.provider === 'ailab' ? (
                  <select className={`${styles.input} ${styles.mono}`} value={tts.voiceId} disabled={!!tts.preset} onChange={(e) => { setTts({ ...tts, voiceId: e.target.value }); touch() }}>
                    <option value="">global default</option>
                    {pool.voices.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <input className={`${styles.input} ${styles.mono}`} placeholder={tts.provider === 'elevenlabs' ? 'pNInz6obpgDQGcFmaJgB (Adam)' : 'provider default'} value={tts.voiceId} disabled={!tts.provider} onChange={(e) => { setTts({ ...tts, voiceId: e.target.value }); touch() }} />
                )}
              </div>
              <div className={styles.fieldCol}>
                <label className={styles.label}>Model</label>
                {tts.provider === 'ailab' ? (
                  <select className={`${styles.input} ${styles.mono}`} value={tts.modelId} disabled={!!tts.preset} onChange={(e) => { setTts({ ...tts, modelId: e.target.value }); touch() }}>
                    <option value="">global default</option>
                    {pool.models.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : tts.provider === 'elevenlabs' ? (
                  <select className={`${styles.input} ${styles.mono}`} value={tts.modelId} onChange={(e) => { setTts({ ...tts, modelId: e.target.value }); touch() }}>
                    <option value="">provider default</option>
                    {['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <input className={`${styles.input} ${styles.mono}`} placeholder="provider default" value={tts.modelId} disabled={!tts.provider} onChange={(e) => { setTts({ ...tts, modelId: e.target.value }); touch() }} />
                )}
              </div>
            </div>,
          )}

          {tts.provider === 'ailab' && card(
            <div>
              {pool.error && <div className={styles.sectionSub} style={{ color: 'var(--danger, #f87171)' }}>Could not load the voice pool: {pool.error}</div>}
              <div className={styles.twoCol}>
                <div className={styles.fieldCol}>
                  <label className={styles.label}>Voice preset</label>
                  <select className={`${styles.input} ${styles.mono}`} value={tts.preset} onChange={(e) => { setTts({ ...tts, preset: e.target.value }); touch() }}>
                    <option value="">none — use voice + model above</option>
                    {pool.presets.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                  <div className={styles.sectionSub}>
                    A preset is a complete recipe (voice, model and sampling settings). Choosing
                    one <b>supersedes</b> the voice and model above, which is why they grey out.
                  </div>
                </div>
                <div className={styles.fieldCol}>
                  <label className={styles.label}>RVC voice conversion</label>
                  <label className={styles.sectionSub} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={tts.rvcEnabled && pool.rvcAllowed}
                      disabled={!pool.rvcAllowed}
                      onChange={(e) => { setTts({ ...tts, rvcEnabled: e.target.checked }); touch() }}
                    />
                    Run this agent&apos;s speech through RVC
                  </label>
                  {!pool.rvcAllowed && (
                    <div className={styles.sectionSub}>
                      Disabled globally. RVC must first be allowed in <b>Settings › Support Models</b>;
                      that gate always wins, so one switch can stop all voice conversion.
                    </div>
                  )}
                  {pool.rvcAllowed && tts.rvcEnabled && (
                    <select className={`${styles.input} ${styles.mono}`} value={tts.rvcModel} onChange={(e) => { setTts({ ...tts, rvcModel: e.target.value }); touch() }}>
                      <option value="">global default RVC model</option>
                      {pool.rvc.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  )}
                </div>
              </div>
            </div>,
          )}
        </section>
      )}

      {section === 'persona' && (
        <section>
          <div className={styles.sectionTitle}>Persona · SOUL.md</div>
          <div className={styles.sectionSub}>The deep persona / operating rules written into the profile.</div>
          {card(
            soulOpen ? (
              <>
                <textarea
                  className={`${styles.soul} ${styles.mono}`}
                  value={soul}
                  placeholder={'# Persona\nDeep persona / operating rules…'}
                  onChange={(e) => { setSoul(e.target.value); touch() }}
                />
                <div className={styles.cardActions}>
                  <button className={styles.btn} onClick={() => setSoulOpen(false)}>Close editor</button>
                </div>
              </>
            ) : (
              <div className={styles.summaryRow}>
                <PenLine size={15} />
                <div>
                  <strong>SOUL.md</strong>
                  <div className={styles.dim}>{soul ? `${soul.split('\n').length} lines · ${soul.length} chars` : 'empty — profile default persona'}</div>
                </div>
                <span className={styles.spacer} />
                <button className={styles.btn} onClick={() => setSoulOpen(true)}>Open editor →</button>
              </div>
            ),
          )}
        </section>
      )}

      {section === 'docs' && (
        <section>
          <div className={styles.sectionTitle}>Config docs</div>
          <div className={styles.sectionSub}>
            The agent's operating .md files on the Hermes host (AGENTS, MEMORY, HEARTBEAT, library guides…).
            SOUL.md is edited in the Persona section; AGENTS.md also has a dedicated editor on the Tools section.
          </div>
          {editing && (initialSpec?.agentId ?? editId) ? (
            <AgentDocs agentId={initialSpec?.agentId ?? editId ?? agentId} />
          ) : (
            <div className={styles.dim}>Save the agent first — docs live on its provisioned Hermes profile.</div>
          )}
        </section>
      )}

      {section === 'skills' && (
        <section>
          <div className={styles.sectionTitle}>Skills</div>
          <div className={styles.sectionSub}>
            Which library skills this agent carries. Custom skills toggle durably; built-ins are seeded by Hermes.
          </div>
          {liveDocId
            ? <AgentSkills agentId={liveDocId} />
            : <div className={styles.dim}>Save the agent first — skills are assigned to its provisioned Hermes profile.</div>}
        </section>
      )}

      {section === 'tools' && (
        <section>
          <div className={styles.sectionTitle}>Tools & integrations</div>
          <div className={styles.sectionSub}>
            Which MCP gateway tools the agent sees (scoping creates its own gateway group), plus Hermes toolsets.
          </div>
          {liveDocId
            ? <HermesToolPicker agentId={liveDocId} />
            : <div className={styles.dim}>Save the agent first — tool scoping targets its provisioned Hermes profile.</div>}
          {liveDocId && <AgentNativeTools agentId={liveDocId} />}
          {card(
            <>
              <div className={styles.chipRow}>
                {toolsets.map((t) => (
                  <span key={t} className={`${styles.chip} ${styles.mono}`}>
                    {t}
                    <button className={styles.chipX} title="Remove" onClick={() => { setToolsets(toolsets.filter((x) => x !== t)); touch() }}>×</button>
                  </span>
                ))}
                {toolsets.length === 0 && <span className={styles.dim}>profile defaults</span>}
              </div>
              <div className={styles.promptRow}>
                <input
                  className={`${styles.input} ${styles.mono}`}
                  value={toolDraft}
                  placeholder="add toolset id…"
                  onChange={(e) => setToolDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTool() }}
                />
                <button className={styles.btn} disabled={!toolDraft.trim()} onClick={addTool}>Add</button>
              </div>
            </>,
          )}
          {inlineDoc('workspace/AGENTS.md', 'How the agent operates — rules, tool & action discipline, environment notes, and the propagated "About Your Human" section (doc consolidation 54a0c55).')}
        </section>
      )}

      {section === 'channels' && (
        <section>
          <div className={styles.sectionTitle}>Channels</div>
          <div className={styles.sectionSub}>Where the agent listens and speaks.</div>
          {card(
            <div className={styles.plannedStub}>
              <Hash size={14} /> Planned — needs the fleet-bus channel model; no backend yet, nothing here is wired.
            </div>,
          )}
        </section>
      )}

      {section === 'schedules' && (
        <section>
          <div className={styles.sectionTitle}>Schedules</div>
          <div className={styles.sectionSub}>Cron-style autonomous runs.</div>
          {card(
            <div className={styles.plannedStub}>
              <CalendarClock size={14} /> Planned — no scheduler backend yet, nothing here is wired.
            </div>,
          )}
          {inlineDoc('workspace/HEARTBEAT.md', 'The prompt Hermes feeds the agent on each heartbeat tick — until the scheduler above is wired, this file IS the schedule behavior.')}
        </section>
      )}

      {section === 'memory' && (
        <section>
          <div className={styles.sectionTitle}>Memory</div>
          <div className={styles.sectionSub}>
            The durable memory Hermes auto-maintains and injects into the agent every turn: MEMORY.md
            (the agent's own long-lived notes) and USER.md (auto-extracted facts about you), plus any
            extra memory files (memories/*.md).
          </div>
          {inlineDoc('memories/MEMORY.md', "The agent's long-lived memory — Hermes auto-updates it and injects it every turn (memories/MEMORY.md).")}
          {inlineDoc('memories/USER.md', 'Auto-extracted facts about you that Hermes injects every turn — distinct from the shared \u201cAbout Your Human\u201d doc (memories/USER.md).')}
          {liveDocId && <AgentDocs agentId={liveDocId} mode="memory" />}
        </section>
      )}

      {/* ── interim quick test (edit flow only) — the streaming chat surface replaces this ── */}
      {editing && !dirty && (
        <section>
          <div className={styles.sectionTitle}>Quick test</div>
          <div className={styles.sectionSub}>One-shot prompt through POST /prompt — interim until the streaming chat surface lands.</div>
          {card(
            <>
              <div className={styles.promptLog}>
                {testLog.length === 0 && <div className={styles.dim}>No test turns yet.</div>}
                {testLog.map((e, i) => (
                  <div key={i} className={e.who === 'you' ? styles.msgYou : e.who === 'agent' ? styles.msgAgent : styles.msgError}>
                    {e.text}
                  </div>
                ))}
                {testWaiting && <div className={styles.dim}>thinking…</div>}
              </div>
              <div className={styles.promptRow}>
                <input
                  className={styles.input}
                  value={testText}
                  placeholder={`prompt ${agentId}…`}
                  onChange={(e) => setTestText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void runTest() }}
                />
                <button className={styles.btnPrimary} disabled={testWaiting || !testText.trim()} onClick={() => void runTest()}>
                  <SendHorizonal size={13} />
                </button>
              </div>
            </>,
          )}
        </section>
      )}
    </div>
  )
})
