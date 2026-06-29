import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Settings2, Trash2, X } from 'lucide-react'
import { llmMetricsStore as store, type LlmMetricRow } from '../../stores/LlmMetricsStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './AiServices.module.scss'

const n = (v?: number | null) => (v == null ? '—' : Math.round(v).toLocaleString())
const n1 = (v?: number | null) => (v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString())
const pct = (hits?: number, q?: number) => (q == null || q === 0 ? (hits == null ? '—' : '0%') : `${((hits! / q) * 100).toFixed(1)}%`)
const hitMiss = (hits?: number, q?: number) => (q == null ? '—' : `${n(hits)} / ${n((q || 0) - (hits || 0))}`)
const errPct = (errs?: number, total?: number) => (total == null || total === 0 ? '—' : `${(((errs || 0) / total) * 100).toFixed(1)}%`)

const SettingsModal: React.FC<{ row: LlmMetricRow; onClose: () => void }> = ({ row, onClose }) => {
  const s = row.settings || {}
  const entries: [string, any][] = [
    ['Model', s.model], ['Alias', s.aliasOverride], ['Family', s.family], ['Variant', s.variant],
    ['Provider / backend', s.provider], ['Quantization', s.quant], ['Context size', s.contextSize?.toLocaleString?.()],
    ['Slot count', s.slots], ['Reasoning mode', s.reasoningMode], ['GPUs', (s.gpus || []).join(', ')],
    ['Node', s.node], ['Reserved VRAM', s.reservedVramMB != null ? `${s.reservedVramMB.toLocaleString()} MB` : null],
    ['Endpoint', s.endpoint], ['Port', s.port], ['Launch script', s.scriptPath],
    ['Started', s.startedAt ? new Date(s.startedAt).toLocaleString() : null],
  ]
  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <span>Launch settings — {row.displayName || row.model}</span>
          <button className={styles.iconBtn} onClick={onClose}><X size={15} /></button>
        </div>
        <table className={styles.settingsTable}><tbody>
          {entries.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
            <tr key={k}><th>{k}</th><td>{String(v)}</td></tr>
          ))}
        </tbody></table>
      </div>
    </div>
  )
}

export const LlmMetricsDashboard: React.FC = observer(() => {
  const [settingsRow, setSettingsRow] = useState<LlmMetricRow | null>(null)
  useEffect(() => { store.startPolling(20000); return () => store.stopPolling() }, [])

  const del = async (r: LlmMetricRow) => {
    if (await confirmStore.confirm({ title: 'Remove metrics row', message: `Delete the recorded metrics for “${r.displayName || r.model}” (${r.provider}, ${r.quant})? This only clears history; a running service will repopulate.`, confirmText: 'Delete' }))
      void store.deleteRow(r.fingerprint)
  }

  return (
    <div className={styles.metricsWrap}>
      <div className={styles.metricsBar}>
        <span className={styles.metricsTitle}>LLM Performance Metrics</span>
        <span className={styles.metricsSub}>{store.rows.length} configs · {store.rows.filter((r) => r.running).length} running</span>
        <div className={styles.spacer} />
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.load()}><RefreshCw size={13} /></button>
      </div>
      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {store.loaded && store.rows.length === 0 && <div className={styles.loading}>No LLM metrics yet — launch a model and they'll appear here.</div>}

      {store.rows.length > 0 && (
        <div className={styles.metricsScroll}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>Model / Config</th>
                <th>Provider</th><th>Quant</th><th>Ctx</th><th>VRAM</th><th>GPU#</th><th>GPUs</th>
                <th>Reasoning</th><th>Slots</th>
                <th>Decode t/s</th><th>Prefill t/s</th><th>Cumulative Tokens</th>
                <th>KVCache Hit</th><th>KV Hit / Miss</th>
                <th>Optane Hit</th><th>Optane Hit / Miss</th><th>Avg Optane Restore</th>
                <th>Tool Calls</th><th>Struct Err</th><th>Struct %</th><th>Halluc Err</th><th>Halluc %</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {store.grouped.map((g) => (
                <React.Fragment key={g.model}>
                  <tr className={styles.groupRow}><td className={styles.groupCell} colSpan={23}>{g.model} <span className={styles.groupCount}>{g.rows.length}</span></td></tr>
                  {g.rows.map((r) => (
                    <tr key={r.fingerprint} className={r.running ? '' : styles.stoppedRow}>
                      <td className={styles.stickyCol}>
                        <span className={`${styles.dot} ${r.running ? styles.dotOn : styles.dotOff}`} title={r.running ? 'running' : 'stopped'} />
                        {r.displayName || r.model}
                      </td>
                      <td>{r.provider || '—'}</td>
                      <td>{r.quant || '—'}</td>
                      <td>{r.contextSize ? `${Math.round(r.contextSize / 1024)}k` : '—'}</td>
                      <td>{r.vramMB != null ? `${r.vramMB.toLocaleString()} MB` : '—'}</td>
                      <td>{r.gpuCount ?? '—'}</td>
                      <td className={styles.gpuCell} title={(r.gpus || []).join(', ')}>{(r.gpus || []).join(', ') || '—'}</td>
                      <td>{r.reasoningMode || '—'}</td>
                      <td>{r.slotCount ?? '—'}</td>
                      <td>{n1(r.decodeTps)}</td>
                      <td>{n1(r.prefillTps)}</td>
                      <td>{n(r.cum_genTokens)}</td>
                      <td>{pct(r.cum_cacheHits, r.cum_cacheQueries)}</td>
                      <td>{hitMiss(r.cum_cacheHits, r.cum_cacheQueries)}</td>
                      <td>{pct(r.cum_optaneHits, r.cum_optaneQueries)}</td>
                      <td>{hitMiss(r.cum_optaneHits, r.cum_optaneQueries)}</td>
                      <td>{r.optaneRestoreMs != null ? `${n1(r.optaneRestoreMs)} ms` : '—'}</td>
                      <td>{r.toolCalls != null ? n(r.toolCalls) : '—'}</td>
                      <td>{r.toolErrStructure != null ? n(r.toolErrStructure) : '—'}</td>
                      <td>{errPct(r.toolErrStructure, r.toolCalls)}</td>
                      <td>{r.toolErrHallucination != null ? n(r.toolErrHallucination) : '—'}</td>
                      <td>{errPct(r.toolErrHallucination, r.toolCalls)}</td>
                      <td className={styles.actionCell}>
                        <button className={styles.iconBtn} title="Launch settings" onClick={() => setSettingsRow(r)}><Settings2 size={14} /></button>
                        <button className={styles.iconBtn} title="Delete row" onClick={() => void del(r)}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {settingsRow && <SettingsModal row={settingsRow} onClose={() => setSettingsRow(null)} />}
    </div>
  )
})
