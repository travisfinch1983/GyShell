import React from 'react'
import { observer } from 'mobx-react-lite'
import { Rocket, Server, RefreshCw, Cpu, Pencil, Trash2, Check, Save, FilePlus, Upload } from 'lucide-react'
import { llmLaunchStore as store, type QuantRow } from '../../stores/LlmLaunchStore'
import { confirmStore } from '../../stores/confirmStore'
import { promptStore } from '../../stores/promptStore'
import { uiPrefsStore } from '../../stores/uiPrefsStore'
import styles from './LlmLaunch.module.scss'

const TPL_LIST_HEIGHT_KEY = 'llmTemplateListHeight'
const TPL_LIST_DEFAULT_H = 360 // ~10 rows

const fmtMB = (mb?: number | null) => (mb == null ? '' : mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.ceil(mb) + ' MB')

/** Small checkbox before a setting label — toggles whether the setting is saved with the preset.
 *  Only shown when a sampler preset is active. */
const PresetChk: React.FC<{ k: string }> = observer(({ k }) =>
  store.samplerPresetActive ? (
    <input
      type="checkbox"
      className={styles.presetChk}
      checked={store.isPresetKey(k)}
      title="Include this setting in the selected preset"
      onChange={() => store.togglePresetKey(k)}
    />
  ) : null,
)

/** VRAM headroom risk badge (ported from ProxLab riskBadgeHtml). */
const RiskBadge: React.FC<{ label?: string | null }> = ({ label }) => {
  if (label === 'tight') return <span className={styles.riskTight}>Tight</span>
  if (label === 'safe') return <span className={styles.riskSafe}>Safe</span>
  if (label === 'spacious') return <span className={styles.riskSpacious}>Spacious</span>
  return null
}

/** One settings field rendered from a LAUNCH_TEMPLATES arg definition. */
const SettingField: React.FC<{ k: string; arg: any }> = observer(({ k, arg }) => {
  const val = store.settings[k] ?? arg.default
  const label = arg.label || k
  const common = { title: arg.tooltip || '' }
  const inPreset = store.samplerPresetActive && store.isPresetKey(k)
  if (arg.type === 'flag') {
    return (
      <div className={`${styles.fieldFlag} ${inPreset ? styles.inPreset : ''}`}>
        <PresetChk k={k} />
        <label className={styles.flagInner} {...common}>
          <input type="checkbox" checked={!!val} onChange={(e) => store.setSetting(k, e.target.checked)} />
          <span>{label}</span>
        </label>
      </div>
    )
  }
  return (
    <div className={`${styles.field} ${inPreset ? styles.inPreset : ''}`} {...common}>
      <span className={styles.fieldLabel}><PresetChk k={k} />{label}</span>
      {k === 'mmproj' ? (
        // Vision projector: dropdown of the .gguf files in the model's shared mmproj/ folder (+ text-only).
        <select className={styles.input} value={String(val ?? '')} onChange={(e) => store.setSetting(k, e.target.value)}>
          <option value="">— none (text-only) —</option>
          {store.mmprojOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : arg.type === 'select' ? (
        <select className={styles.input} value={String(val ?? '')} onChange={(e) => store.setSetting(k, e.target.value)}>
          {(arg.options || []).map((o: string) => (
            <option key={o} value={o}>{arg.labels?.[o] ?? (o === '' ? '(default)' : o)}</option>
          ))}
        </select>
      ) : (
        <input
          className={styles.input}
          type={arg.type === 'number' ? 'number' : 'text'}
          step={arg.step}
          min={arg.min}
          max={arg.max}
          value={val ?? ''}
          onChange={(e) => store.setSetting(k, e.target.value)}
        />
      )}
    </div>
  )
})

/** Distinct badge colour per backend; unknown providers fall back to a stable hashed hue. */
const PROVIDER_COLORS: Record<string, string> = {
  'koboldcpp': '#d8a657', 'llama-server': '#4ea1ff', 'llama-server-mtp': '#22d3ee',
  'vllm': '#a78bfa', '1cat-vllm': '#f472b6', 'ollama': '#fb923c', 'sglang': '#f87171',
  'tabbyapi': '#818cf8', 'aphrodite': '#fb7185', 'lmdeploy': '#2dd4bf', 'exllama': '#c084fc',
}
const providerColor = (p: string): string => {
  if (PROVIDER_COLORS[p]) return PROVIDER_COLORS[p]
  let h = 0; for (let i = 0; i < (p || '').length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 60%, 65%)`
}
const badgeStyle = (color: string): React.CSSProperties => ({ background: `${color}26`, color, border: `1px solid ${color}66` })
/** ProxLab stores context in contextSize (llama/kobold) or maxModelLen (vLLM). */
const contextOf = (t: any): number | null => {
  const s = t?.settings || {}
  const v = s.contextSize ?? s.maxModelLen ?? s.ctxSize ?? s.maxSeqLen ?? null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
const fmtCtx = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(n % 1048576 ? 1 : 0)}M` : n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))

/** Saved launch-templates list box — inline rename + load + backend filter badges. */
const TemplateList: React.FC = observer(() => {
  const [editId, setEditId] = React.useState<string | null>(null)
  const [editName, setEditName] = React.useState('')
  const [hidden, setHidden] = React.useState<Set<string>>(new Set())
  const listRef = React.useRef<HTMLDivElement>(null)
  const begin = (t: any) => { setEditId(t.id); setEditName(t.name) }
  const commit = async () => { if (editId && editName.trim()) await store.renameTemplate(editId, editName); setEditId(null) }
  // Persist the user's resized height to the backend (debounced inside the store).
  React.useEffect(() => {
    const el = listRef.current
    if (!el || !uiPrefsStore.loaded) return
    const ro = new ResizeObserver(() => {
      const h = Math.round(el.offsetHeight)
      if (h && h !== uiPrefsStore.get(TPL_LIST_HEIGHT_KEY, TPL_LIST_DEFAULT_H)) uiPrefsStore.set(TPL_LIST_HEIGHT_KEY, h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [uiPrefsStore.loaded])
  const height = uiPrefsStore.get(TPL_LIST_HEIGHT_KEY, TPL_LIST_DEFAULT_H)
  const providers = [...new Set(store.savedTemplates.map((t) => t.providerId).filter(Boolean))].sort()
  const toggle = (p: string) => setHidden((prev) => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n })
  const visible = store.savedTemplates.filter((t) => !hidden.has(t.providerId))
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        Saved Templates <span className={styles.muted}>({visible.length}{hidden.size ? ` / ${store.savedTemplates.length}` : ''})</span>
        <span className={styles.spacer} />
        <span className={styles.filterBadges}>
          {providers.map((p) => {
            const off = hidden.has(p)
            return (
              <button key={p} className={`${styles.fBadge} ${off ? styles.fBadgeOff : ''}`} style={off ? undefined : badgeStyle(providerColor(p))} title={off ? `Show ${p} templates` : `Hide ${p} templates`} onClick={() => toggle(p)}>{p}</button>
            )
          })}
        </span>
      </div>
      <div ref={listRef} className={styles.tplList} style={{ height }}>
        {store.savedTemplates.length === 0 && <div className={styles.muted}>No saved templates yet — configure a launch and use “Save As New Template”.</div>}
        {store.savedTemplates.length > 0 && visible.length === 0 && <div className={styles.muted}>All templates hidden by the backend filters above.</div>}
        {visible.map((t) => {
          const loaded = store.loadedTemplateId === t.id
          const ctx = contextOf(t)
          const fam = [t.family, t.variant].filter(Boolean).join(' ')
          return (
            <div key={t.id} className={`${styles.tplRow} ${loaded ? styles.tplRowActive : ''}`}>
              {editId === t.id ? (
                <input
                  className={styles.tplNameInput} autoFocus value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditId(null) }}
                  onBlur={() => void commit()}
                />
              ) : (
                <span className={styles.tplName} title={t.name}>{t.name}</span>
              )}
              {fam && <span className={styles.badgeFamily} title={`${t.family} ${t.variant} · ${t.format || ''} ${t.quant || ''}`.trim()}>{fam}</span>}
              {ctx != null && <span className={styles.badgeCtx} title="Context window saved with this template">{fmtCtx(ctx)} ctx</span>}
              <span className={styles.badgeProvider} style={badgeStyle(providerColor(t.providerId))}>{t.providerId}</span>
              {editId === t.id ? (
                <button className={styles.tplIcon} title="Save name" onMouseDown={(e) => { e.preventDefault(); void commit() }}><Check size={13} /></button>
              ) : (
                <button className={styles.tplIcon} title="Rename" onClick={() => begin(t)}><Pencil size={13} /></button>
              )}
              <button className={styles.tplLoad} title="Load this template into the launcher" onClick={() => store.loadTemplate(t.id)}><Upload size={13} /> Load</button>
              <button className={styles.tplIconDanger} title="Delete template" onClick={async () => {
                if (await confirmStore.confirm({ title: 'Delete template', message: `Delete launch template “${t.name}”?`, confirmText: 'Delete' })) void store.deleteTemplate(t.id)
              }}><Trash2 size={13} /></button>
            </div>
          )
        })}
      </div>
    </section>
  )
})

export const LlmLaunchPanel: React.FC = observer(() => {
  const [advOpen, setAdvOpen] = React.useState(false)
  React.useEffect(() => {
    if (!store.models) void store.load()
    void uiPrefsStore.ensureLoaded()
  }, [])

  const t = store.template
  const est = store.lastEstimate
  const placements: any[] = est?.placements || []

  // Auto-expand Advanced when the active preset owns any advanced-arg keys (so its highlighted fields show).
  const advKeys = t?.advancedArgs ? Object.entries<any>(t.advancedArgs).filter(([, a]) => !a?.hidden).map(([k]) => k) : []
  const advFromPreset = store.samplerPresetActive ? advKeys.filter((k) => store.isPresetKey(k)).length : 0
  React.useEffect(() => {
    if (advFromPreset > 0) setAdvOpen(true)
  }, [advFromPreset, store.selectedSamplerPresetId])

  // Auto-scroll: as each choice reveals the next step, bring that step into focus.
  const quantRef = React.useRef<HTMLElement | null>(null)
  const engineRef = React.useRef<HTMLElement | null>(null)
  const settingsRef = React.useRef<HTMLElement | null>(null)
  const scrollTo = (el: HTMLElement | null) => { if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' })) }
  React.useEffect(() => { if (store.model) scrollTo(quantRef.current) }, [store.model])
  React.useEffect(() => { if (store.selectedQuant) scrollTo(engineRef.current) }, [store.selectedFormat, store.selectedQuant])
  React.useEffect(() => { if (store.selectedProvider) scrollTo(settingsRef.current) }, [store.selectedProvider])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <Rocket size={16} className={styles.hIcon} />
        <span className={styles.title}>LLM Launch</span>
        {store.loading && <span className={styles.muted}> · loading…</span>}
      </div>
      {store.error && <div className={styles.error}>{store.error}</div>}

      <div className={styles.body}>
        {/* Saved templates — kept at the top, above model selection */}
        <TemplateList />

        {/* 1 — Model */}
        <section className={styles.card}>
          <div className={styles.cardHead}>1 · Model</div>
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Family</span>
              <select className={styles.input} value={store.selectedFamily} onChange={(e) => store.selectModel(e.target.value, store.variantsFor(e.target.value)[0] || '')}>
                <option value="">Select family…</option>
                {store.families.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Variant</span>
              <select className={styles.input} value={store.selectedVariant} disabled={!store.selectedFamily} onChange={(e) => store.selectModel(store.selectedFamily, e.target.value)}>
                {store.variantsFor(store.selectedFamily).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <div className={styles.scanRow}>
            <button className={styles.scanBtn} onClick={() => void store.rescanAll()} disabled={store.rescanning} title="Full rescan of all model folders (SSH walk)">
              <RefreshCw size={13} className={store.rescanning ? styles.spin : ''} /> {store.rescanning ? 'Scanning…' : 'Rescan'}
            </button>
            <button className={styles.scanBtn} onClick={() => void store.rescanFamily(store.selectedFamily)} disabled={store.rescanning || !store.selectedFamily} title="Rescan only the selected family folder">
              <RefreshCw size={13} /> Rescan Selected
            </button>
          </div>
        </section>

        {/* 2 — Quant table (imported as-is; to be reworked) */}
        {store.model && (
          <section className={styles.card} ref={quantRef as any}>
            <div className={styles.cardHead}>2 · Quantization</div>
            {store.quantRows.length === 0 ? (
              <div className={styles.muted}>No quants on disk for this model.</div>
            ) : (
              <table className={styles.quantTable}>
                <thead><tr><th>Format</th><th>Quant</th><th>BPW</th><th>Size</th></tr></thead>
                <tbody>
                  {store.quantRows.map((r: QuantRow, i) => {
                    const sel = r.format === store.selectedFormat && r.quant === store.selectedQuant
                    return (
                      <tr key={i} className={`${styles.qRow} ${sel ? styles.qSel : ''}`} onClick={() => store.selectQuant(r)}>
                        <td>{r.format}</td><td>{r.quant}</td><td>{r.bpw ?? '—'}</td><td>{fmtMB(r.sizeMB)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>
        )}

        {/* 3 — Provider */}
        {store.selectedQuant && (
          <section className={styles.card} ref={engineRef as any}>
            <div className={styles.cardHead}>3 · Engine</div>
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Provider</span>
                <select className={styles.input} value={store.selectedProvider} onChange={(e) => store.selectProvider(e.target.value)}>
                  <option value="">Select engine…</option>
                  {store.compatibleProviders.map((p) => {
                    const installed = Object.values(p.agents || {}).some((s: any) => s.installed)
                    return <option key={p.id} value={p.id}>{p.name}{installed ? '' : ' (not installed)'}</option>
                  })}
                </select>
              </label>
            </div>
          </section>
        )}

        {/* 4 — Settings */}
        {t && (
          <section className={styles.card} ref={settingsRef as any}>
            <div className={styles.cardHead}>4 · Settings</div>
            {store.supportsSamplerPresets && (
              <div className={styles.samplerRow}>
                <span className={styles.fieldLabel}>Sampler preset</span>
                <select
                  className={`${styles.input} ${styles.samplerSelect}`}
                  value={store.selectedSamplerPresetId}
                  onChange={(e) => store.selectSamplerPreset(e.target.value)}
                >
                  <option value="">— select a preset —</option>
                  <optgroup label="Built-in">
                    {store.allSamplerPresets.filter((p) => String(p.id).startsWith('builtin-')).map((p) => <option key={p.id} value={p.id}>{p.name}{p.readOnly ? '  🔒' : ''}</option>)}
                  </optgroup>
                  {store.userSamplerPresets.length > 0 && (
                    <optgroup label="Custom">
                      {store.userSamplerPresets.map((p) => <option key={p.id} value={p.id}>{p.name}{p.readOnly ? '  🔒' : ''}</option>)}
                    </optgroup>
                  )}
                </select>
                <button className={styles.scanBtn} disabled={!store.selectedSamplerPresetId} onClick={() => store.applySamplerPreset(store.selectedSamplerPresetId)}>Apply</button>
                <button
                  className={styles.scanBtn}
                  disabled={!store.selectedSamplerPresetId}
                  title="Overwrite the selected preset with the current settings (only the checked settings). Built-in presets are read-only — they fork into a (custom) copy."
                  onClick={async () => { const id = await store.updateSamplerPreset(store.selectedSamplerPresetId, store.samplerReadOnly); if (id) store.selectSamplerPreset(id) }}
                >Update</button>
                <button
                  className={styles.scanBtn}
                  title="Save the checked settings as a new preset"
                  onClick={async () => { const n = await promptStore.prompt({ title: 'New sampler preset', label: 'Name for this preset', placeholder: 'My preset' }); if (n) { const id = await store.saveSamplerPreset(n, store.samplerReadOnly); if (id) store.selectSamplerPreset(id) } }}
                >Save As…</button>
                <label className={styles.roChk} title="When checked, the preset is protected — it can't be overwritten in place, only copied.">
                  <input type="checkbox" checked={store.samplerReadOnly} onChange={(e) => store.setSamplerReadOnly(e.target.checked)} /> Read Only
                </label>
                {store.selectedSamplerPresetId && !store.selectedSamplerPresetId.startsWith('builtin-') && (
                  <button className={styles.scanBtn} onClick={async () => { const id = store.selectedSamplerPresetId; await store.deleteSamplerPreset(id); store.selectSamplerPreset('') }}>Delete</button>
                )}
              </div>
            )}
            <div className={styles.fieldGrid}>
              {Object.entries<any>(t.args || {}).filter(([k, a]) => k !== 'model' && !a?.hidden).map(([k, a]) => <SettingField key={k} k={k} arg={a} />)}
            </div>
            {t.advancedArgs && (
              <details className={styles.advanced} open={advOpen} onToggle={(e) => setAdvOpen((e.currentTarget as HTMLDetailsElement).open)}>
                <summary>Advanced ({advKeys.length}){advFromPreset > 0 ? ` · ${advFromPreset} from preset` : ''}</summary>
                <div className={styles.fieldGrid}>
                  {Object.entries<any>(t.advancedArgs).filter(([, a]) => !a?.hidden).map(([k, a]) => <SettingField key={k} k={k} arg={a} />)}
                </div>
              </details>
            )}
          </section>
        )}

        {/* 5 — GPU placement + (rough) estimate */}
        {t && (
          <section className={styles.card}>
            <div className={styles.cardHead}><Cpu size={13} /> 5 · GPU placement <span className={styles.rough}>· VRAM estimate is rough</span></div>
            {store.estimating && <div className={styles.muted}>Estimating…</div>}
            {est?.estimate && (
              <div className={styles.estLine}>
                ~{fmtMB(est.estimate.totalMB)} total · weights {fmtMB(est.estimate.weightsMB)} · KV {fmtMB(est.estimate.kvCacheMB)} · {est.availableGpuCount} GPUs available
              </div>
            )}
            {placements.length > 0 && <div className={styles.suggestLabel}>Suggested placements</div>}
            {placements.length === 0 && store.availableNvidiaGpus.length > 0 && est?.estimate && (
              <div className={styles.warn}>No GPU combination has enough estimated VRAM — use custom selection below to launch anyway.</div>
            )}
            <div className={styles.placements}>
              {placements.slice(0, 6).map((p: any, i: number) => {
                const sel = !store.isCustomSelected && store.selectedPlacement === p
                const names = (p.gpus || []).map((g: any) => g.friendlyName || g.model || g.name || g.pciId).join(' + ')
                const node = p.node || (p.gpus || []).map((g: any) => g.node).join(', ')
                const showAvail = p.availableVramMB != null && p.totalVramMB != null && p.availableVramMB < p.totalVramMB
                return (
                  <button key={i} className={`${styles.placement} ${sel ? styles.placeSel : ''}`} onClick={() => store.setPlacement(p)}>
                    {p.gpuCount > 1 && <span className={styles.countLabel}>{p.gpuCount}-GPU</span>}
                    <span className={styles.placeNode}>{node}:</span>
                    <span className={styles.placeGpus}>{names}</span>
                    {p.headroomMB != null && <span className={styles.headroom}>{fmtMB(p.headroomMB)} headroom</span>}
                    {showAvail && <span className={styles.headroomAvail}>({(p.availableVramMB / 1024).toFixed(1)}/{(p.totalVramMB / 1024).toFixed(1)} GB avail)</span>}
                    {p.mixedPlacement && <span className={styles.mixedBadge}>Mixed</span>}
                    <RiskBadge label={p.riskLabel} />
                  </button>
                )
              })}

              {/* Custom GPU selection — pick specific GPUs to build your own placement (ProxLab parity) */}
              {store.availableNvidiaGpus.length > 0 && (
                <div className={`${styles.placement} ${styles.customPlacement} ${store.isCustomSelected ? styles.placeSel : ''}`}>
                  <span className={styles.countLabel}>Custom</span>
                  <div className={styles.customSelectors}>
                    {store.customGpus.map((g: any) => (
                      <span key={`${g.node}:${g.pciId}`} className={styles.customGpuPill}>
                        {g.node}: {g.friendlyName || g.model || 'GPU'}
                        <button className={styles.customGpuRemove} title="Remove GPU" onClick={() => store.removeCustomGpu(g.node, g.pciId)}>×</button>
                      </span>
                    ))}
                    {store.customAddableGpus.length > 0 && (
                      <select
                        className={`${styles.input} ${styles.customGpuSelect}`}
                        value=""
                        onChange={(e) => { if (e.target.value) store.addCustomGpu(e.target.value) }}
                      >
                        <option value="">+ Add GPU…</option>
                        {store.customAddableGpus.map((g: any) => (
                          <option key={`${g.node}:${g.pciId}`} value={`${g.node}:${g.pciId}`}>
                            {g.node}: {g.friendlyName || g.model || 'GPU'} ({(((g.availableVramMB ?? g.vramMB)) / 1024).toFixed(1)}/{(g.vramMB / 1024).toFixed(0)} GB)
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {store.customGpus.length > 0 && store.customEval && (
                    <>
                      <span className={styles.headroom}>{fmtMB(store.customEval.headroomMB)} headroom</span>
                      {store.customEval.fits === false ? <span className={styles.riskTight}>Impossible</span> : <RiskBadge label={store.customEval.riskLabel} />}
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* 6 — Command + launch */}
        {t && (
          <section className={styles.card}>
            <div className={styles.cardHead}>6 · Command</div>
            <textarea className={styles.command} readOnly value={store.command} rows={8} />
            <div className={styles.launchRow}>
              <button className={styles.launchBtn} disabled={!store.command || !store.selectedNode || store.launching} onClick={() => void store.launch()}>
                <Rocket size={14} /> Launch
              </button>
              <button className={styles.serviceBtn} disabled={!store.command || !store.selectedNode || store.launching} onClick={() => void store.launchAsService()}>
                <Server size={14} /> Launch as Service
              </button>
              {!store.isOnDisk && store.selectedQuant && <span className={styles.warn}>Selected quant not on disk</span>}
            </div>
            <div className={styles.launchRow}>
              <button className={styles.scanBtn} disabled={!store.canSaveChanges} title={store.canSaveChanges ? `Overwrite "${store.loadedTemplateName}" with the current settings` : 'Load a template first to enable saving changes'} onClick={() => void store.saveTemplateChanges()}>
                <Save size={13} /> Save Changes{store.loadedTemplateName ? ` to "${store.loadedTemplateName}"` : ''}
              </button>
              <button className={styles.scanBtn} disabled={!store.canSaveAsNew} title="Save the current model + engine + settings as a new template" onClick={async () => {
                const n = await promptStore.prompt({ title: 'Save As New Template', label: 'Template name', placeholder: 'e.g. Qwen3 235B — fast', defaultValue: store.loadedTemplateName ? `${store.loadedTemplateName} (copy)` : '' })
                if (n) void store.saveAsNewTemplate(n)
              }}>
                <FilePlus size={13} /> Save As New Template
              </button>
            </div>
            {store.launchMsg && <div className={styles.ok}>{store.launchMsg}</div>}
            {store.launchErr && <div className={styles.error}>{store.launchErr}</div>}
          </section>
        )}
      </div>
    </div>
  )
})
