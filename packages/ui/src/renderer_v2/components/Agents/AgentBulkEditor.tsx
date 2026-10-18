import React, { useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Bot, Save, Undo2, X } from 'lucide-react'
import { hermesAgentSpecSchema, type HermesAgentSpec } from '@gyshell/shared'
import { hermesAgentsStore as store } from '../../stores/HermesAgentsStore'
import { hermesApi } from '../../stores/hermesApi'
import { confirmStore } from '../../stores/confirmStore'
import { capGlyphs } from './AgentEditor'
import { applyBulkEdits, specValues, type Val } from './bulkEdit'
import styles from './Agents.module.scss'

/**
 * Bulk editor for the "Model & behavior" tab (Travis, 2026-10-18): select several agent
 * badges and edit them together.
 *
 *  - A field shows its value when every selected agent has the same one, and shows as
 *    MIXED (blank) when they differ.
 *  - Only fields you actually change are written. Every untouched field keeps each agent's
 *    own value — the patch is applied per agent on top of THAT agent's stored spec.
 *  - Two independent stores, same as the single editor: the agent spec (model, fallback,
 *    sub-agents, AI-Lab chat voice → POST /api/hermes/agents) and the Hermes-native TTS in
 *    the profile's config.yaml (PUT /api/hermes/agents/:id/hermes-tts, change-only patch).
 */

const MIXED = '__mixed__'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

type HermesTts = { provider: string; voice: string; model: string; baseUrl: string; speed: number; autoTts: boolean; voices: string[]; voicesError?: string }
const httsValues = (h: HermesTts): Record<string, Val> => ({
  'htts.autoTts': h.autoTts, 'htts.voice': h.voice, 'htts.model': h.model, 'htts.baseUrl': h.baseUrl, 'htts.speed': h.speed,
})

const LABELS: Record<string, string> = {
  model: 'Model', personality: 'Personality preset', mode: 'Permission mode', maxTokens: 'Max generation length',
  fallback: 'Fallback chain', 'sub.model': 'Sub-agent model', 'sub.reasoningEffort': 'Sub-agent reasoning effort',
  'sub.maxConcurrent': 'Sub-agent max concurrent', 'sub.maxSpawnDepth': 'Sub-agent max spawn depth',
  'sub.autoApproveDangerous': 'Sub-agent auto-approve dangerous', 'tts.provider': 'Chat voice provider',
  'tts.voiceId': 'Chat voice id', 'tts.modelId': 'Chat voice model', 'tts.preset': 'Chat voice preset',
  'tts.rvcEnabled': 'Chat voice RVC', 'tts.rvcModel': 'Chat voice RVC model', 'htts.autoTts': 'Hermes TTS enabled',
  'htts.voice': 'Hermes TTS voice', 'htts.model': 'Hermes TTS model', 'htts.baseUrl': 'Hermes TTS endpoint', 'htts.speed': 'Hermes TTS speed',
}
const showVal = (v: Val) => (Array.isArray(v) ? (v.length ? v.join(' → ') : 'none') : v === '' ? '(blank)' : String(v))

/** Checkbox with a real "mixed" (indeterminate) state. Top-level so it keeps its identity. */
const TriCheck: React.FC<{ value: boolean | 'mixed'; disabled?: boolean; onChange: (c: boolean) => void; children: React.ReactNode }> = ({ value, disabled, onChange, children }) => {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = value === 'mixed' }, [value])
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-muted)' }}>
      <input ref={ref} type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

interface Props {
  agentIds: string[]
  onClearSelection: () => void
}

export const AgentBulkEditor: React.FC<Props> = observer(({ agentIds, onClearSelection }) => {
  const [edits, setEdits] = useState<Record<string, Val>>({})
  const [hermesTts, setHermesTts] = useState<Map<string, HermesTts | null>>(new Map())
  const [httsLoading, setHttsLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState<Array<{ id: string; ok: boolean; note: string }>>([])

  useEffect(() => { if (!store.catalogLoaded) void store.loadCatalog() }, [])

  const loadHermesTts = async () => {
    setHttsLoading(true)
    const rows = await Promise.all(agentIds.map(async (id) => [id, await hermesApi.getHermesTts(id)] as const))
    setHermesTts(new Map(rows))
    setHttsLoading(false)
  }
  useEffect(() => { void loadHermesTts() }, [agentIds.join(',')])

  // Agents whose spec AI-Lab can't see (null) can't take spec edits — say so instead of
  // pretending they were updated.
  const withSpec = agentIds.filter((id) => store.specs.get(id))
  const noSpec = agentIds.filter((id) => !store.specs.get(id))
  const specVals = useMemo(() => withSpec.map((id) => specValues(store.specs.get(id) as HermesAgentSpec)), [withSpec.join(','), store.specs])
  const httsRows = agentIds.map((id) => hermesTts.get(id)).filter(Boolean) as HermesTts[]
  const httsFailed = agentIds.filter((id) => hermesTts.has(id) && !hermesTts.get(id))
  const httsVals = httsRows.map(httsValues)

  /** Common value across the selection, or MIXED. */
  const common = (key: string): Val | typeof MIXED => {
    const rows = key.startsWith('htts.') ? httsVals : specVals
    if (!rows.length) return MIXED
    const first = rows[0][key]
    return rows.every((r) => same(r[key], first)) ? first : MIXED
  }
  const touched = (key: string) => key in edits
  const shown = (key: string): Val | typeof MIXED => (touched(key) ? edits[key] : common(key))
  const set = (key: string, val: Val) => { setEdits((e) => ({ ...e, [key]: val })); setResults([]) }
  const revert = (key: string) => setEdits((e) => { const n = { ...e }; delete n[key]; return n })

  // Voice pool for the ailab chat-voice pickers, only when the effective provider is ailab.
  const effProvider = shown('tts.provider')
  const [pool, setPool] = useState<{ voices: string[]; models: string[]; rvc: string[]; presets: string[]; rvcAllowed: boolean; loaded: boolean; error: string }>(
    { voices: [], models: [], rvc: [], presets: [], rvcAllowed: false, loaded: false, error: '' },
  )
  useEffect(() => {
    if (effProvider !== 'ailab' || pool.loaded) return
    let alive = true
    void (async () => {
      const get = async (p: string) => { const r = await fetch(p); if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`); return r.json() }
      try {
        const [v, m, rv, pr, ap] = await Promise.all([
          get('/api/proxy/multi-tts/voices'), get('/api/proxy/multi-tts/v1/models'), get('/api/proxy/multi-tts/rvc-models'),
          get('/api/proxy/multi-tts/voice-presets'), get('/api/proxy/audio-pipeline/settings'),
        ])
        if (!alive) return
        setPool({
          voices: (v?.voices ?? []).map((x: any) => x.id ?? x).filter(Boolean),
          models: Array.from(new Set((m?.data ?? []).map((x: any) => x.model ?? String(x.id ?? '').split('/').pop()).filter(Boolean))) as string[],
          rvc: (rv?.models ?? []).map((x: any) => x.name ?? x).filter(Boolean),
          presets: Object.keys(pr ?? {}),
          rvcAllowed: Boolean(ap?.config?.post?.rvc?.allowed),
          loaded: true, error: '',
        })
      } catch (e: any) {
        if (alive) setPool((p) => ({ ...p, loaded: true, error: String(e?.message ?? e) }))
      }
    })()
    return () => { alive = false }
  }, [effProvider])

  // Catalog models plus any value currently in use that the catalog no longer lists.
  const inUse = new Set<string>()
  for (const r of specVals) { for (const k of ['model', 'sub.model']) if (r[k]) inUse.add(r[k] as string); for (const f of r.fallback as string[]) inUse.add(f) }
  const models = [
    ...Array.from(inUse).filter((id) => !store.catalog.some((m) => m.id === id)).map((id) => ({ id, tag: 'AI-LAB', displayName: `${id} (not in catalog)`, capabilities: undefined as any })),
    ...store.catalog,
  ]

  // ── field renderers ────────────────────────────────────────────────────────
  // Plain render helpers, NOT components declared in this render: a component type
  // re-created every render remounts its <input> and steals focus on each keystroke.
  const tag = (k: string) => (
    <>
      {touched(k) && <span className={styles.dim} style={{ color: 'var(--accent)', marginLeft: 6 }}>● changed</span>}
      {!touched(k) && common(k) === MIXED && <span className={styles.dim} style={{ marginLeft: 6 }}>mixed</span>}
      {touched(k) && (
        <button className={styles.btn} style={{ marginLeft: 6, padding: '0 6px' }} title="Undo this change — each agent keeps its own value" onClick={() => revert(k)}>↺</button>
      )}
    </>
  )
  const label = (k: string) => <label className={styles.label}>{LABELS[k]}{tag(k)}</label>

  /** <select>: when mixed and untouched, a "keep each agent's own" sentinel is selected. */
  const select = (k: string, options: Array<{ value: string; label: string }>, opts: { disabled?: boolean; mono?: boolean } = {}) => {
    const v = shown(k)
    const known = v === MIXED || options.some((o) => o.value === String(v))
    return (
      <select
        className={`${styles.input} ${opts.mono ? styles.mono : ''}`}
        value={v === MIXED ? MIXED : String(v)}
        disabled={opts.disabled}
        onChange={(e) => (e.target.value === MIXED ? revert(k) : set(k, e.target.value))}
      >
        {v === MIXED && <option value={MIXED}>— mixed: keep each agent&apos;s own —</option>}
        {!known && <option value={String(v)}>{v === '' ? '— none set —' : `${String(v)} (not in list)`}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  /** Text/number input: mixed shows blank with a "mixed" placeholder; typing marks it changed.
   *  Numbers are kept as the typed string and converted on save, so "1." can be typed. */
  const text = (k: string, placeholder: string, opts: { int?: boolean; decimal?: boolean; disabled?: boolean } = {}) => {
    const v = shown(k)
    const display = v === MIXED ? '' : opts.int && v === 0 && !touched(k) ? '' : String(v)
    return (
      <input
        className={`${styles.input} ${styles.mono}`}
        inputMode={opts.int ? 'numeric' : opts.decimal ? 'decimal' : undefined}
        value={display}
        placeholder={v === MIXED ? 'mixed — type to set ALL selected' : placeholder}
        disabled={opts.disabled}
        onChange={(e) => {
          const raw = e.target.value
          set(k, opts.int ? raw.replace(/[^0-9]/g, '') : opts.decimal ? raw.replace(/[^0-9.]/g, '') : raw)
        }}
      />
    )
  }
  const check = (k: string, txt: string, disabled?: boolean) => (
    <TriCheck value={shown(k) === MIXED ? 'mixed' : shown(k) === true} disabled={disabled} onChange={(c) => set(k, c)}>
      {txt}{tag(k)}
    </TriCheck>
  )

  const modelOptions = models.map((m: any) => ({ value: m.id, label: `[${m.tag}] ${m.displayName}${capGlyphs(m.capabilities)}` }))
  const fb = shown('fallback')
  const primary = shown('model')
  const card = (children: React.ReactNode) => <div className={styles.card}>{children}</div>

  // ── save ───────────────────────────────────────────────────────────────────
  const changedKeys = Object.keys(edits)
  const specKeys = changedKeys.filter((k) => !k.startsWith('htts.'))
  const httsKeys = changedKeys.filter((k) => k.startsWith('htts.'))

  const apply = async () => {
    const lines = changedKeys.map((k) => `• ${LABELS[k]} → ${showVal(edits[k])}`).join('\n')
    const skipNote = specKeys.length && noSpec.length ? `\n\nSkipped for spec fields (no AI-Lab spec): ${noSpec.join(', ')}` : ''
    const ok = await confirmStore.confirm({
      title: `Apply to ${agentIds.length} agents`,
      message: `${lines}\n\nAgents: ${agentIds.join(', ')}\nEverything else stays as each agent has it.${skipNote}`,
      confirmText: 'Apply',
      danger: false,
    })
    if (!ok) return
    setBusy(true); setResults([])
    const out: Array<{ id: string; ok: boolean; note: string }> = []
    for (const id of agentIds) {
      const notes: string[] = []
      let good = true
      if (specKeys.length) {
        const spec = store.specs.get(id)
        if (!spec) { good = false; notes.push('no AI-Lab spec — spec fields skipped') }
        else {
          setProgress(`Provisioning ${id}…`)
          const parsed = hermesAgentSpecSchema.safeParse(applyBulkEdits(spec, edits))
          if (!parsed.success) { good = false; notes.push(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ')) }
          else {
            const r = await store.apply(parsed.data)
            if (r.ok) notes.push('spec saved')
            else { good = false; notes.push(`spec: ${r.error ?? 'apply failed'}`) }
          }
        }
      }
      if (httsKeys.length) {
        setProgress(`Hermes TTS for ${id}…`)
        const patch: Record<string, unknown> = {}
        for (const k of httsKeys) patch[k.slice(5)] = k === 'htts.speed' ? Number(edits[k]) || 1.0 : edits[k]
        const r = await hermesApi.putHermesTts(id, patch)
        if (r.ok) notes.push(r.gatewayRestarted ? 'Hermes TTS saved (gateway restarted)' : 'Hermes TTS saved')
        else { good = false; notes.push(`Hermes TTS: ${r.error ?? 'failed'}`) }
      }
      out.push({ id, ok: good, note: notes.join(' · ') })
      setResults([...out])
    }
    setProgress('')
    setBusy(false)
    if (out.every((r) => r.ok)) setEdits({})
    void loadHermesTts()
  }

  const nameOf = (id: string) => store.specs.get(id)?.displayName ?? id

  return (
    <div className={styles.agentView}>
      <div className={styles.summaryRow} style={{ marginBottom: 8 }}>
        <Bot size={15} />
        <div>
          <strong>Bulk edit — {agentIds.length} agents</strong>
          <div className={styles.dim}>
            {agentIds.map(nameOf).join(' · ')}. Fields marked <b>mixed</b> differ between these agents. Only the
            fields you change are written; everything you leave alone keeps each agent&apos;s own value.
          </div>
        </div>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy} onClick={onClearSelection}><X size={13} /> Clear selection</button>
        <button className={styles.btn} disabled={busy || !changedKeys.length} onClick={() => { setEdits({}); setResults([]) }}><Undo2 size={13} /> Discard</button>
        <button className={styles.btnPrimary} disabled={busy || !changedKeys.length} onClick={() => void apply()}>
          <Save size={13} /> {busy ? 'Applying…' : `Apply ${changedKeys.length || ''} change${changedKeys.length === 1 ? '' : 's'} to ${agentIds.length}`}
        </button>
      </div>
      {progress && <div className={styles.dim}>{progress}</div>}
      {results.length > 0 && card(
        <div>
          {results.map((r) => (
            <div key={r.id} style={{ fontSize: 12, color: r.ok ? 'var(--fg)' : 'var(--danger, #f87171)' }}>
              {r.ok ? '✓' : '✗'} <span className={styles.mono}>{r.id}</span> — {r.note}
            </div>
          ))}
        </div>,
      )}
      {noSpec.length > 0 && (
        <div className={styles.dim} style={{ color: 'var(--warning, #fbbf24)', marginBottom: 6 }}>
          No AI-Lab spec for {noSpec.join(', ')} — model/fallback/sub-agent/chat-voice changes can&apos;t be applied to
          {noSpec.length === 1 ? ' it' : ' them'} (open {noSpec.length === 1 ? 'it' : 'each'} once and Save to adopt).
        </div>
      )}

      <section>
        <div className={styles.sectionTitle}>Model & behavior</div>
        {card(
          <div className={styles.twoCol}>
            <div className={styles.fieldCol}>
              {label('model')}
              {select('model', modelOptions, { mono: true })}
            </div>
            <div className={styles.fieldCol}>
              {label('personality')}
              {text('personality', 'preset id (helpful / technical / …) or an inline one-liner')}
            </div>
            <div className={styles.fieldCol}>
              {label('mode')}
              {select('mode', [
                { value: 'default', label: 'default — ask before edits' },
                { value: 'accept_edits', label: 'accept_edits — auto-allow workspace/tmp' },
              ])}
            </div>
            <div className={styles.fieldCol}>
              {label('maxTokens')}
              {text('maxTokens', 'blank = model default', { int: true })}
            </div>
          </div>,
        )}

        <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Fallback chain{tag('fallback')}</div>
        <div className={styles.sectionSub}>Setting a chain here REPLACES each selected agent&apos;s whole chain with this one.</div>
        {card(
          fb === MIXED ? (
            <div className={styles.summaryRow}>
              <div className={styles.dim}>
                Mixed — each agent keeps its own chain:
                {withSpec.map((id) => (
                  <div key={id} className={styles.mono}>{id}: {showVal((store.specs.get(id) as HermesAgentSpec).fallback ?? [])}</div>
                ))}
              </div>
              <span className={styles.spacer} />
              <button className={styles.btn} onClick={() => set('fallback', [])}>Set one chain for all →</button>
            </div>
          ) : (
            <>
              {(fb as string[]).map((fid, i, arr) => (
                <div key={fid} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 12 }}>
                  <span className={styles.mono} style={{ color: 'var(--fg-muted)', width: 16 }}>{i + 1}.</span>
                  <span className={styles.mono} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{fid}</span>
                  <button className={styles.btn} disabled={i === 0} title="Move up" onClick={() => { const f = [...arr]; f.splice(i - 1, 0, f.splice(i, 1)[0]); set('fallback', f) }}>↑</button>
                  <button className={styles.btn} disabled={i === arr.length - 1} title="Move down" onClick={() => { const f = [...arr]; f.splice(i + 1, 0, f.splice(i, 1)[0]); set('fallback', f) }}>↓</button>
                  <button className={styles.btnDanger} title="Remove" onClick={() => set('fallback', arr.filter((x) => x !== fid))}>×</button>
                </div>
              ))}
              {(fb as string[]).length === 0 && <div className={styles.dim}>no fallback — primary only</div>}
              <div className={styles.promptRow} style={{ marginTop: 8 }}>
                <select
                  className={`${styles.input} ${styles.mono}`}
                  value=""
                  onChange={(e) => { const id = e.target.value; const arr = fb as string[]; if (id && !arr.includes(id)) set('fallback', [...arr, id]) }}
                >
                  <option value="" disabled>add fallback #{(fb as string[]).length + 1}…</option>
                  {models.filter((m: any) => m.id !== primary && !(fb as string[]).includes(m.id)).map((m: any) => (
                    <option key={m.id} value={m.id}>[{m.tag}] {m.displayName}{capGlyphs(m.capabilities)}</option>
                  ))}
                </select>
              </div>
            </>
          ),
        )}

        <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Sub-agents</div>
        {card(
          <div className={styles.twoCol}>
            <div className={styles.fieldCol}>
              {label('sub.model')}
              {select('sub.model', [{ value: '', label: 'inherit parent' }, ...modelOptions], { mono: true })}
            </div>
            <div className={styles.fieldCol}>
              {label('sub.reasoningEffort')}
              {select('sub.reasoningEffort', [{ value: '', label: 'inherit parent' }, ...['xhigh', 'high', 'medium', 'low', 'minimal', 'none'].map((v) => ({ value: v, label: v }))])}
            </div>
            <div className={styles.fieldCol}>
              {label('sub.maxConcurrent')}
              {text('sub.maxConcurrent', '0 / blank = Hermes default', { int: true })}
            </div>
            <div className={styles.fieldCol}>
              {label('sub.maxSpawnDepth')}
              {text('sub.maxSpawnDepth', '0 / blank = Hermes default', { int: true })}
            </div>
            <div className={`${styles.fieldCol} ${styles.fieldWide}`}>
              {check('sub.autoApproveDangerous', 'auto-approve dangerous commands in sub-agent threads (default deny)')}
            </div>
          </div>,
        )}

        <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Voice (TTS) — AI-Lab chat</div>
        {card(
          <div className={styles.twoCol}>
            <div className={styles.fieldCol}>
              {label('tts.provider')}
              {select('tts.provider', [
                { value: '', label: 'none' },
                { value: 'ailab', label: 'ailab — local TTS pool (voices, RVC, presets)' },
                // keep any Hermes-pipeline provider an agent already has selectable (see AgentEditor)
                ...Array.from(new Set(specVals.map((r) => r['tts.provider'] as string).filter((p) => p && p !== 'ailab'))).map((p) => ({ value: p, label: `${p} — Hermes pipeline (not used by chat playback)` })),
              ])}
            </div>
            {effProvider === MIXED ? (
              <div className={`${styles.fieldCol} ${styles.fieldWide}`}>
                <div className={styles.dim}>These agents use different voice providers — pick one provider above to edit voice, model, preset and RVC for all of them.</div>
              </div>
            ) : effProvider === 'ailab' ? (
              <>
                {pool.error && <div className={`${styles.fieldCol} ${styles.fieldWide} ${styles.dim}`} style={{ color: 'var(--danger, #f87171)' }}>Could not load the voice pool: {pool.error}</div>}
                <div className={styles.fieldCol}>
                  {label('tts.voiceId')}
                  {select('tts.voiceId', [{ value: '', label: 'global default' }, ...pool.voices.map((v) => ({ value: v, label: v }))], { mono: true, disabled: shown('tts.preset') !== '' && shown('tts.preset') !== MIXED })}
                </div>
                <div className={styles.fieldCol}>
                  {label('tts.modelId')}
                  {select('tts.modelId', [{ value: '', label: 'global default' }, ...pool.models.map((v) => ({ value: v, label: v }))], { mono: true, disabled: shown('tts.preset') !== '' && shown('tts.preset') !== MIXED })}
                </div>
                <div className={styles.fieldCol}>
                  {label('tts.preset')}
                  {select('tts.preset', [{ value: '', label: 'none — use voice + model' }, ...pool.presets.map((v) => ({ value: v, label: v }))], { mono: true })}
                </div>
                <div className={styles.fieldCol}>
                  {check('tts.rvcEnabled', 'Run speech through RVC', !pool.rvcAllowed)}
                  {!pool.rvcAllowed && <div className={styles.sectionSub}>RVC is disabled globally (Settings › Support Models).</div>}
                  {pool.rvcAllowed && shown('tts.rvcEnabled') === true && (
                    <>
                      {label('tts.rvcModel')}
                      {select('tts.rvcModel', [{ value: '', label: 'global default RVC model' }, ...pool.rvc.map((v) => ({ value: v, label: v }))], { mono: true })}
                    </>
                  )}
                </div>
              </>
            ) : effProvider ? (
              <>
                <div className={styles.fieldCol}>{label('tts.voiceId')}{text('tts.voiceId', 'provider default')}</div>
                <div className={styles.fieldCol}>{label('tts.modelId')}{text('tts.modelId', 'provider default')}</div>
              </>
            ) : null}
          </div>,
        )}

        <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Hermes TTS — native channels (Telegram, etc.)</div>
        {card(
          httsLoading ? (
            <div className={styles.dim}>Loading each agent&apos;s Hermes TTS config…</div>
          ) : httsFailed.length ? (
            // Wipe-guard, same as the single editor: never offer to write over config we couldn't read.
            <div className={styles.dim} style={{ color: 'var(--danger, #f87171)' }}>
              Couldn&apos;t read the Hermes TTS config for {httsFailed.join(', ')} — Hermes TTS bulk edit is disabled until it loads.
              <button className={styles.btn} style={{ marginLeft: 8 }} onClick={() => void loadHermesTts()}>Retry</button>
            </div>
          ) : (
            <div className={styles.twoCol}>
              <div className={`${styles.fieldCol} ${styles.fieldWide}`}>
                {check('htts.autoTts', 'Hermes TTS enabled — speak replies on Telegram & other gateway channels')}
              </div>
              <div className={styles.fieldCol}>
                {label('htts.voice')}
                {select('htts.voice', (httsRows[0]?.voices ?? []).map((v) => ({ value: v, label: v })), { mono: true })}
              </div>
              <div className={styles.fieldCol}>
                {label('htts.speed')}
                {text('htts.speed', '1.0', { decimal: true })}
              </div>
              <div className={styles.fieldCol}>
                {label('htts.model')}
                {text('htts.model', 'model')}
              </div>
              <div className={styles.fieldCol}>
                {label('htts.baseUrl')}
                {text('htts.baseUrl', 'http://10.0.0.219:17890/api/proxy/tts/v1')}
              </div>
            </div>
          ),
        )}
      </section>
    </div>
  )
})
