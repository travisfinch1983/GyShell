import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, Sparkles } from 'lucide-react'
import { claudeMaxMetricsStore as store, type ClaudeMaxRow } from '../../stores/ClaudeMaxMetricsStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './AiServices.module.scss'

const n = (v?: number | null) => (v == null ? '—' : Math.round(v).toLocaleString())
const n1 = (v?: number | null) => (v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString())
const ms = (v?: number | null) => (v == null ? '—' : `${Math.round(v).toLocaleString()} ms`)
const pctV = (v?: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

export const ClaudeMaxMetricsDashboard: React.FC = observer(() => {
  useEffect(() => { store.startPolling(20000); return () => store.stopPolling() }, [])

  const del = async (r: ClaudeMaxRow) => {
    if (await confirmStore.confirm({ title: 'Reset metrics', message: `Clear recorded metrics for “${r.model}”? This only clears history; new requests repopulate it.`, confirmText: 'Reset' }))
      void store.resetModel(r.model)
  }

  const t = store.totals
  const totalCacheHitPct = (t.input ? t.cacheRead / t.input : 0)

  return (
    <div className={styles.metricsWrap}>
      <div className={styles.metricsBar}>
        <Sparkles size={14} className={styles.headerIcon} />
        <span className={styles.metricsTitle}>Claude Max — Usage &amp; Cache</span>
        <span className={styles.metricsSub}>
          {n(t.requests)} reqs · {n(t.input)} in / {n(t.output)} out · cache hit {pctV(totalCacheHitPct)}
        </span>
        <div className={styles.spacer} />
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.load()}><RefreshCw size={13} /></button>
      </div>
      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {store.loaded && store.rows.length === 0 && <div className={styles.loading}>No Claude Max traffic recorded yet — make a request through /api/proxy/claude-max and it'll appear here.</div>}

      {store.rows.length > 0 && (
        <div className={styles.metricsScroll}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>Model</th>
                <th>Requests</th><th>Errors</th><th>Retries</th>
                <th>Input tok</th><th>Output tok</th>
                <th>Cache Read (hit)</th><th>Cache Create</th><th>Cache Hit %</th>
                <th>Avg Latency</th><th>Avg TTFT</th><th>Decode t/s</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {store.rows.map((r) => (
                <tr key={r.model}>
                  <td className={styles.stickyCol}>{r.model}</td>
                  <td>{n(r.requests)}</td>
                  <td>{n(r.errors)}</td>
                  <td>{n(r.cum_retries)}</td>
                  <td>{n(r.totalInputTokens)}</td>
                  <td>{n(r.cum_genTokens)}</td>
                  <td title="cache_read_input_tokens — prompt prefix served from cache">{n(r.cum_cacheRead)}</td>
                  <td title="cache_creation_input_tokens (1h tier)">{n(r.cum_cacheCreate)}</td>
                  <td>{pctV(r.cacheReadPct)}</td>
                  <td>{ms(r.avgLatencyMs)}</td>
                  <td title="streaming requests only — observed end-to-end">{ms(r.avgTtftMs)}</td>
                  <td title="streaming requests only — observed decode rate">{n1(r.avgDecodeTps)}</td>
                  <td className={styles.actionCell}>
                    <button className={styles.iconBtn} title="Reset row" onClick={() => void del(r)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {store.recent.length > 0 && (
        <details className={styles.recentWrap}>
          <summary className={styles.recentSummary}>Recent requests ({store.recent.length})</summary>
          <div className={styles.metricsScroll}>
            <table className={styles.metricsTable}>
              <thead>
                <tr><th>Time</th><th>Model</th><th>Endpoint</th><th>In</th><th>Out</th><th>Cache Read</th><th>Latency</th><th>TTFT</th><th>t/s</th><th>Status</th></tr>
              </thead>
              <tbody>
                {store.recent.map((e, i) => (
                  <tr key={i} className={e.ok ? '' : styles.stoppedRow}>
                    <td>{new Date(e.t).toLocaleTimeString()}</td>
                    <td>{e.model}</td>
                    <td>{e.endpoint}{e.stream ? ' (stream)' : ''}</td>
                    <td>{n(e.in)}</td>
                    <td>{n(e.out)}</td>
                    <td>{n(e.cacheRead)}</td>
                    <td>{ms(e.latencyMs)}</td>
                    <td>{ms(e.ttftMs)}</td>
                    <td>{n1(e.decodeTps)}</td>
                    <td>{e.ok ? 'ok' : (e.status ?? 'err')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
})
