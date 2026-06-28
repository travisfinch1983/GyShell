import React from 'react'
import { observer } from 'mobx-react-lite'
import { Rocket, Server, RefreshCw, Cpu } from 'lucide-react'
import { llmLaunchStore as store, type QuantRow } from '../../stores/LlmLaunchStore'
import styles from './LlmLaunch.module.scss'

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
      {arg.type === 'select' ? (
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

export const LlmLaunchPanel: React.FC = observer(() => {
  const [advOpen, setAdvOpen] = React.useState(false)
  React.useEffect(() => {
    if (!store.models) void store.load()
  }, [])

  const t = store.template
  const est = store.lastEstimate
  const placements: any[] = est?.placements || []

  // Auto-expand Advanced when the active preset owns any advanced-arg keys (so its highlighted fields show).
  const advKeys = t?.advancedArgs ? Object.keys(t.advancedArgs) : []
  const advFromPreset = store.samplerPresetActive ? advKeys.filter((k) => store.isPresetKey(k)).length : 0
  React.useEffect(() => {
    if (advFromPreset > 0) setAdvOpen(true)
  }, [advFromPreset, store.selectedSamplerPresetId])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <Rocket size={16} className={styles.hIcon} />
        <span className={styles.title}>LLM Launch</span>
        {store.loading && <span className={styles.muted}> · loading…</span>}
      </div>
      {store.error && <div className={styles.error}>{store.error}</div>}

      <div className={styles.body}>
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
          <section className={styles.card}>
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
          <section className={styles.card}>
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
          <section className={styles.card}>
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
                  onClick={async () => { const n = window.prompt('Name for this preset:'); if (n) { const id = await store.saveSamplerPreset(n, store.samplerReadOnly); if (id) store.selectSamplerPreset(id) } }}
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
              {Object.entries<any>(t.args || {}).filter(([k]) => k !== 'model').map(([k, a]) => <SettingField key={k} k={k} arg={a} />)}
            </div>
            {t.advancedArgs && (
              <details className={styles.advanced} open={advOpen} onToggle={(e) => setAdvOpen((e.currentTarget as HTMLDetailsElement).open)}>
                <summary>Advanced ({advKeys.length}){advFromPreset > 0 ? ` · ${advFromPreset} from preset` : ''}</summary>
                <div className={styles.fieldGrid}>
                  {Object.entries<any>(t.advancedArgs).map(([k, a]) => <SettingField key={k} k={k} arg={a} />)}
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
            {store.launchMsg && <div className={styles.ok}>{store.launchMsg}</div>}
            {store.launchErr && <div className={styles.error}>{store.launchErr}</div>}
          </section>
        )}
      </div>
    </div>
  )
})
