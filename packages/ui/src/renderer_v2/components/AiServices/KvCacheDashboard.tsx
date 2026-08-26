import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, Database } from 'lucide-react'
import { kvCacheStore as store, type KvEligibleSvc } from '../../stores/KvCacheStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './AiServices.module.scss'

const n = (v?: number | null) => (v == null ? '—' : Math.round(v).toLocaleString())
const gb = (b?: number | null) => (b == null ? '—' : `${(b / 2 ** 30).toFixed(1)} GB`)
const pctHit = (hit?: number, miss?: number) => {
  const h = hit || 0, m = miss || 0, t = h + m
  return t === 0 ? '—' : `${((h / t) * 100).toFixed(0)}%`
}

// Committed-on-blur numeric override. Empty clears the override (falls back to the default).
const NumCell: React.FC<{ value?: number; scale?: number; onSet: (v: number | null) => void; width?: number }> =
  ({ value, scale = 1, onSet, width = 62 }) => (
    <input
      className={styles.liveWindowInput}
      style={{ width }}
      type="number"
      key={String(value)}
      defaultValue={value == null ? '' : value / scale}
      placeholder="def"
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim()
        onSet(raw === '' ? null : Math.round(Number(raw) * scale))
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur() }}
    />
  )

// Committed-on-blur FRACTION override (0.05–0.5, no rounding — NumCell would floor 0.2 to 0).
// Empty clears the override (falls back to the backend default, 0.2).
const FracCell: React.FC<{ value?: number; onSet: (v: number | null) => void }> = ({ value, onSet }) => (
  <input
    className={styles.liveWindowInput}
    style={{ width: 52 }}
    type="number"
    key={String(value)}
    defaultValue={value == null ? '' : value}
    placeholder="def"
    min={0.05}
    max={0.5}
    step={0.05}
    onBlur={(e) => {
      const raw = e.currentTarget.value.trim()
      if (raw === '') { onSet(null); return }
      const v = Number(raw)
      onSet(Number.isFinite(v) ? Math.min(0.5, Math.max(0.05, v)) : null)
    }}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur() }}
  />
)

export const KvCacheDashboard: React.FC = observer(() => {
  useEffect(() => { store.startPolling(15000); return () => store.stopPolling() }, [])

  const svcRow = (svc: KvEligibleSvc) => {
    const enabled = store.isEnabled(svc.id)
    const cfg = store.configOf(svc.id)
    const st = store.services[svc.id] || {}
    return (
      <tr key={svc.id} className={enabled ? '' : styles.stoppedRow}>
        <td className={styles.stickyCol} title={`${svc.containerIp}:${svc.port} · ${svc.node || ''}`}>
          <span className={`${styles.dot} ${enabled ? styles.dotOn : styles.dotOff}`} />
          {svc.name || svc.model || svc.id}
        </td>
        <td>
          <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => void store.setEnabled(svc.id, e.currentTarget.checked)} />
          </label>
        </td>
        <td><NumCell value={cfg.minMatchTokens} onSet={(v) => void store.setConfigValue(svc.id, 'minMatchTokens', v)} /></td>
        <td><NumCell value={cfg.minSaveDeltaTokens} onSet={(v) => void store.setConfigValue(svc.id, 'minSaveDeltaTokens', v)} /></td>
        <td><NumCell value={cfg.chunkSize} width={50} onSet={(v) => void store.setConfigValue(svc.id, 'chunkSize', v)} /></td>
        <td><NumCell value={cfg.costBenefitRatio} width={46} onSet={(v) => void store.setConfigValue(svc.id, 'costBenefitRatio', v)} /></td>
        <td><NumCell value={cfg.optaneBudgetBytes} scale={2 ** 30} width={54} onSet={(v) => void store.setConfigValue(svc.id, 'optaneBudgetBytes', v)} /></td>
        <td><FracCell value={cfg.initialBudgetFraction} onSet={(v) => void store.setConfigValue(svc.id, 'initialBudgetFraction', v)} /></td>
        <td title="VRAM warm-slot reuse">{n(st.vramHits)}</td>
        <td title="Optane restore hits">{n(st.optaneHits)}</td>
        <td>{n(st.misses)}</td>
        <td title={`Optane hit-rate`}>{pctHit((st.vramHits || 0) + (st.optaneHits || 0), st.misses)}</td>
        <td title="snapshots saved (live path)">{n(st.saves)}</td>
        <td title="boundaries materialized (clone worker)">{n(st.clones)}</td>
        <td title="clone queue">{st.clone ? `${st.clone.queued}/${st.clone.pending}` : '—'}</td>
      </tr>
    )
  }

  const reap = async (fp: string) => {
    if (await confirmStore.confirm({
      title: 'Reap Optane pool',
      message: `Run the reaper now for fingerprint ${fp}? Deletes stale-version snapshots and evicts LRU snapshots over the byte budget.`,
      confirmText: 'Reap',
    })) {
      const r = await store.reap(fp)
      if (r && !r.error) await confirmStore.confirm({ title: 'Reaper done', message: `Purged ${r.deleted ?? 0} snapshots (${r.versionStale ?? 0} stale-version, ${r.overBudget ?? 0} over-budget), freed ${gb(r.freedBytes)}.`, confirmText: 'OK' })
    }
  }

  const poolFps = Object.keys(store.pools)

  return (
    <div className={styles.metricsWrap}>
      <div className={styles.metricsBar}>
        <Database size={14} className={styles.headerIcon} />
        <span className={styles.metricsTitle}>Optane KV Cache</span>
        <span className={styles.metricsSub}>
          {store.eligible.length} llama service{store.eligible.length === 1 ? '' : 's'} ·{' '}
          {store.eligible.filter((s) => store.isEnabled(s.id)).length} enabled
        </span>
        <div className={styles.spacer} />
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.load()}><RefreshCw size={13} /></button>
      </div>

      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {store.loaded && store.eligible.length === 0 && (
        <div className={styles.loading}>No llama.cpp services running — the native KV cache only applies to llama-server backends.</div>
      )}

      {store.eligible.length > 0 && (
        <div className={styles.metricsScroll}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>llama service</th>
                <th title="Enable native Optane KV cache for this service">KV On</th>
                <th title="Min matched tokens to restore/affinity">minMatch</th>
                <th title="Min prefix growth before a live-path save">minSaveΔ</th>
                <th title="Boundary granularity (tokens)">chunk</th>
                <th title="match_n / file_total_n restore gate">ratio</th>
                <th title="Per-fingerprint Optane budget (GB)">budget</th>
                <th title="Fraction of the Optane budget reserved for initial prefixes (agent system+tools — protected from running-conversation eviction). 0.05–0.5, default 0.2">init frac</th>
                <th title="VRAM warm-slot reuse">WARM</th>
                <th title="Optane restore hits">HIT</th>
                <th>MISS</th>
                <th>hit%</th>
                <th title="live-path saves">save</th>
                <th title="clone-worker materializations">clone</th>
                <th title="clone queued/pending">q</th>
              </tr>
            </thead>
            <tbody>{store.eligible.map(svcRow)}</tbody>
          </table>
        </div>
      )}

      {poolFps.length > 0 && (
        <div className={styles.metricsScroll} style={{ marginTop: 8 }}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>Optane pool (fingerprint)</th>
                <th>snapshots</th><th>size</th><th>budget</th>
                <th title="initial-kind (protected agent system+tools prefixes): used / quota · snapshots">initial</th>
                <th title="running-kind (conversation prefixes): used / quota · snapshots">running</th>
                <th>host</th><th></th>
              </tr>
            </thead>
            <tbody>
              {poolFps.map((fp) => {
                const p = store.pools[fp]
                const over = p.budgetBytes != null && (p.bytes || 0) > p.budgetBytes
                const frac = p.initialBudgetFraction
                const initQuota = p.budgetBytes != null && frac != null ? p.budgetBytes * frac : null
                const runQuota = p.budgetBytes != null && frac != null ? p.budgetBytes * (1 - frac) : null
                const initOver = initQuota != null && (p.byKind?.initial?.b || 0) > initQuota
                const runOver = runQuota != null && (p.byKind?.running?.b || 0) > runQuota
                return (
                  <tr key={fp}>
                    <td className={styles.stickyCol} title={p.savePath || ''}>{fp}</td>
                    <td>{n(p.count)}</td>
                    <td style={over ? { color: 'var(--danger, #e66)' } : undefined}>{gb(p.bytes)}</td>
                    <td>{gb(p.budgetBytes)}</td>
                    <td style={initOver ? { color: 'var(--danger, #e66)' } : undefined}>
                      {gb(p.byKind?.initial?.b)} / {gb(initQuota)} · {n(p.byKind?.initial?.n)}
                    </td>
                    <td style={runOver ? { color: 'var(--danger, #e66)' } : undefined}>
                      {gb(p.byKind?.running?.b)} / {gb(runQuota)} · {n(p.byKind?.running?.n)}
                    </td>
                    <td>{p.host || '—'}</td>
                    <td className={styles.actionCell}>
                      <button className={styles.iconBtn} title="Reap now (LRU + stale-version)" onClick={() => void reap(fp)}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
})
