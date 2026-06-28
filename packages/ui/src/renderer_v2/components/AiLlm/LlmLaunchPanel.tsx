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
        <span className={styles.spacer} />
        <button className={styles.refresh} onClick={() => void store.load()} disabled={store.loading}>
          <RefreshCw size={13} className={store.loading ? styles.spin : ''} /> {store.loading ? 'Loading…' : 'Rescan'}
        </button>
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
        </section>

        {/* 2 — Quant table (imported as-is; to be reworked) */}
        {store.model && (
          <section className={styles.card}>
            <div className={styles.cardHead}>2 · Quantization</div>
            <table className={styles.quantTable}>
              <thead><tr><th>Format</th><th>Quant</th><th>BPW</th><th>Size</th><th>On disk</th></tr></thead>
              <tbody>
                {store.quantRows.map((r: QuantRow, i) => {
                  const sel = r.format === store.selectedFormat && r.quant === store.selectedQuant
                  return (
                    <tr key={i} className={`${styles.qRow} ${sel ? styles.qSel : ''} ${!r.onDisk ? styles.qOff : ''}`} onClick={() => store.selectQuant(r)}>
                      <td>{r.format}</td><td>{r.quant}</td><td>{r.bpw ?? '—'}</td><td>{fmtMB(r.sizeMB)}</td>
                      <td>{r.onDisk ? <span className={styles.diskYes}>●</span> : <span className={styles.diskNo}>○</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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
            {placements.length === 0 && <div className={styles.muted}>No placements yet — pick a quant/provider.</div>}
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
