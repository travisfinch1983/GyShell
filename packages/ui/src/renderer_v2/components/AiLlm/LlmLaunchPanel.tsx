import React from 'react'
import { observer } from 'mobx-react-lite'
import { Rocket, Server, RefreshCw, Cpu } from 'lucide-react'
import { llmLaunchStore as store, type QuantRow } from '../../stores/LlmLaunchStore'
import styles from './LlmLaunch.module.scss'

const fmtMB = (mb?: number | null) => (mb == null ? '' : mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.ceil(mb) + ' MB')

/** One settings field rendered from a LAUNCH_TEMPLATES arg definition. */
const SettingField: React.FC<{ k: string; arg: any }> = observer(({ k, arg }) => {
  const val = store.settings[k] ?? arg.default
  const label = arg.label || k
  const common = { title: arg.tooltip || '' }
  if (arg.type === 'flag') {
    return (
      <label className={styles.fieldFlag} {...common}>
        <input type="checkbox" checked={!!val} onChange={(e) => store.setSetting(k, e.target.checked)} />
        <span>{label}</span>
      </label>
    )
  }
  return (
    <label className={styles.field} {...common}>
      <span className={styles.fieldLabel}>{label}</span>
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
          onChange={(e) => store.setSetting(k, arg.type === 'number' ? e.target.value : e.target.value)}
        />
      )}
    </label>
  )
})

export const LlmLaunchPanel: React.FC = observer(() => {
  const [samplerSel, setSamplerSel] = React.useState('')
  React.useEffect(() => {
    if (!store.models) void store.load()
  }, [])

  const t = store.template
  const est = store.lastEstimate
  const placements: any[] = est?.placements || []

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
                <select className={`${styles.input} ${styles.samplerSelect}`} value={samplerSel} onChange={(e) => setSamplerSel(e.target.value)}>
                  <option value="">Select preset…</option>
                  <optgroup label="Built-in">
                    {store.allSamplerPresets.filter((p) => String(p.id).startsWith('builtin-')).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                  {store.userSamplerPresets.length > 0 && (
                    <optgroup label="Custom">
                      {store.userSamplerPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                  )}
                </select>
                <button className={styles.scanBtn} disabled={!samplerSel} onClick={() => store.applySamplerPreset(samplerSel)}>Apply</button>
                <button className={styles.scanBtn} onClick={async () => { const n = window.prompt('Save current sampler settings as a preset — name:'); if (n) await store.saveSamplerPreset(n) }}>Save current…</button>
                {samplerSel && !samplerSel.startsWith('builtin-') && (
                  <button className={styles.scanBtn} onClick={async () => { await store.deleteSamplerPreset(samplerSel); setSamplerSel('') }}>Delete</button>
                )}
              </div>
            )}
            <div className={styles.fieldGrid}>
              {Object.entries<any>(t.args || {}).filter(([k]) => k !== 'model').map(([k, a]) => <SettingField key={k} k={k} arg={a} />)}
            </div>
            {t.advancedArgs && (
              <details className={styles.advanced}>
                <summary>Advanced ({Object.keys(t.advancedArgs).length})</summary>
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
            {/* Manual GPU selection bar — pick specific GPUs (overrides the suggestions below) */}
            <div className={styles.manualBar}>
              <div className={styles.manualLabel}>Manual GPU selection</div>
              {store.agents.length === 0 && <div className={styles.muted}>No GPU agents found.</div>}
              {store.agents.map((a) => (
                <div key={a.vmid} className={styles.agentRow}>
                  <span className={styles.agentName}>{a.name}</span>
                  <div className={styles.gpuChips}>
                    {a.gpus.map((g) => (
                      <button
                        key={g.pci_id}
                        className={`${styles.gpuChip} ${store.manualGpus.includes(g.pci_id) ? styles.gpuChipSel : ''}`}
                        title={`${g.pci_id}${g.arch ? ' · ' + g.arch : ''}`}
                        onClick={() => store.toggleGpu(a, g)}
                      >
                        {g.name} <span className={styles.gpuVram}>{fmtMB(g.vram_mb)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {placements.length > 0 && <div className={styles.suggestLabel}>Suggested placements</div>}
            <div className={styles.placements}>
              {placements.slice(0, 8).map((p: any, i: number) => {
                const sel = store.selectedPlacement === p || (store.selectedPlacement?.node === p.node && JSON.stringify(store.selectedPlacement?.gpus) === JSON.stringify(p.gpus))
                return (
                  <button key={i} className={`${styles.placement} ${sel ? styles.placeSel : ''}`} onClick={() => store.setPlacement(p)}>
                    <span className={styles.placeNode}>{p.node || p.gpus?.[0]?.node}</span>
                    <span className={styles.placeGpus}>{(p.gpus || []).length} GPU{(p.gpus || []).length === 1 ? '' : 's'}: {(p.gpus || []).map((g: any) => g.name || g.pciId).join(', ')}</span>
                  </button>
                )
              })}
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
