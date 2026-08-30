import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, HardDrive } from 'lucide-react'
import { optaneCacheStore as store, type OptanePool } from '../../stores/OptaneCacheStore'
import styles from './AiServices.module.scss'

const n = (v?: number | null) => (v == null ? '—' : Math.round(v).toLocaleString())
const gb = (b?: number | null) => (b == null ? '—' : `${(b / 2 ** 30).toFixed(1)} GB`)
const pct = (a?: number | null, b?: number | null) =>
  a == null || !b ? '—' : `${((a / b) * 100).toFixed(0)}%`

/** epoch SECONDS (collector) or MILLIS (sqlite rows) → short local date-time. */
const when = (t?: number | null, unit: 's' | 'ms' = 's') => {
  if (!t) return '—'
  const d = new Date(unit === 's' ? t * 1000 : t)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const ago = (t?: number | null, unit: 's' | 'ms' = 's') => {
  if (!t) return ''
  const ms = unit === 's' ? t * 1000 : t
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const HEALTH_COLOR: Record<string, string> = {
  ok: 'var(--success, #4caf50)',
  dead: 'var(--danger, #e66)',
  off: 'var(--danger, #e66)',
  idle: 'var(--warning, #d9a441)',
  unknown: 'var(--muted, #888)',
}
const HEALTH_LABEL: Record<string, string> = {
  ok: 'WORKING', dead: 'NOT RESTORING', off: 'NOT ATTACHED', idle: 'IDLE', unknown: 'UNKNOWN',
}

/** Thin used/total bar — capacity is easier to read as a bar than as two numbers. */
const Bar: React.FC<{ used: number; total: number }> = ({ used, total }) => {
  const f = total > 0 ? Math.min(1, used / total) : 0
  const col = f > 0.9 ? 'var(--danger, #e66)' : f > 0.8 ? 'var(--warning, #d9a441)' : 'var(--accent, #5a9)'
  return (
    <div style={{ background: 'var(--bg-elev, #2a2a2a)', borderRadius: 3, height: 6, width: 90, overflow: 'hidden' }}>
      <div style={{ width: `${f * 100}%`, height: '100%', background: col }} />
    </div>
  )
}

export const OptaneCacheDashboard: React.FC = observer(() => {
  useEffect(() => {
    store.startPolling()
    return () => store.stopPolling()
  }, [])

  const h = store.health
  const pools = store.pools
  const fsAll = store.nodes.flatMap((nd) => (nd.filesystems ?? []).map((f) => ({ ...f, host: nd.host })))

  return (
    <div className={styles.metricsWrap}>
      <div className={styles.metricsBar}>
        <HardDrive size={14} className={styles.headerIcon} />
        <span className={styles.metricsTitle}>Optane Cache Health</span>
        <span className={styles.metricsSub} style={{ color: HEALTH_COLOR[h.state], fontWeight: 600 }}>
          {HEALTH_LABEL[h.state]}
        </span>
        <span className={styles.metricsSub}>{h.detail}</span>
        <div className={styles.spacer} />
        {store.generatedAt > 0 && <span className={styles.metricsSub}>{ago(store.generatedAt, 'ms')}</span>}
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.load()}>
          <RefreshCw size={13} className={store.loading ? styles.spin : ''} />
        </button>
      </div>

      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {store.nodes.filter((nd) => nd.error).map((nd) => (
        <div key={nd.host} className={styles.errorBar}>{nd.host}: {nd.error}</div>
      ))}
      {!store.loaded && <div className={styles.loading}>Loading Optane cache state…</div>}

      {/* 1 — every running LLM service, and whether the cache is ACTUALLY attached to it */}
      {store.engines.length > 0 && (
        <div className={styles.metricsScroll}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>service</th>
                <th>engine</th>
                <th>port</th>
                <th title="Read from the running process cmdline, not from config">KV</th>
                <th title="Bytes written INTO the cache. Climbs whenever the connector is attached at all.">stored</th>
                <th title="Bytes read BACK from the cache. Climbs only on a real hit — this is the number that proves the cache is working.">restored</th>
                <th title="Connector hit rate (RAM tier + Optane tier together — not Optane alone)">hit%</th>
                <th title="RAM tier size (cpu_bytes_to_use)">RAM tier</th>
                <th>pool</th>
              </tr>
            </thead>
            <tbody>
              {store.engines.map((e) => {
                const m = e.metrics || {}
                const restoredZero = e.kvEnabled && (m.storedBytes || 0) > 0 && !(m.restoredBytes || 0)
                return (
                  <tr key={`${e.pid}`} className={e.kvEnabled ? '' : styles.stoppedRow}>
                    <td className={styles.stickyCol} title={e.model || ''}>
                      <span className={`${styles.dot} ${e.kvEnabled ? styles.dotOn : styles.dotOff}`} />
                      {e.name || e.model?.split('/').slice(-2).join('/') || `pid ${e.pid}`}
                    </td>
                    <td>{e.engine}</td>
                    <td>{e.port || '—'}</td>
                    <td style={{ color: e.kvEnabled ? HEALTH_COLOR.ok : HEALTH_COLOR.off, fontWeight: 600 }}>
                      {e.kvEnabled ? 'on' : 'off'}
                    </td>
                    <td>{e.engine === 'vllm' ? gb(m.storedBytes) : '—'}</td>
                    <td
                      style={restoredZero ? { color: HEALTH_COLOR.dead, fontWeight: 600 } : undefined}
                      title={restoredZero ? 'Storing but never restoring — the cache is attached but dead' : undefined}
                    >
                      {e.engine === 'vllm' ? gb(m.restoredBytes) : '—'}
                    </td>
                    <td>{e.engine === 'vllm' ? pct(m.extHits, m.extQueries) : '—'}</td>
                    <td>{gb(e.cpuBytes)}</td>
                    <td title={e.kvDir || ''}>{e.kvDir ? e.kvDir.split('/').pop() : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 2 — buckets: how much space each pool holds, and how much of the device it occupies */}
      {pools.length > 0 && (
        <div className={styles.metricsScroll} style={{ marginTop: 8 }}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>bucket (pool)</th>
                <th>blocks</th>
                <th>size</th>
                <th title="Share of the Optane device this bucket occupies">of device</th>
                <th title="Blocks the hotness sidecar is tracking">tracked</th>
                <th title="Blocks looked up more than once — the shared prefix the pruner protects">reused</th>
                <th title="Most recent lookup that found a block in this pool">last hit</th>
                <th title="Oldest → newest block file in this bucket">written</th>
                <th>in use by</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p: OptanePool) => {
                const dev = fsAll.find((f) => p.path.startsWith(f.mount)) || fsAll[0]
                return (
                  <tr key={p.path}>
                    <td className={styles.stickyCol} title={p.path}>{p.name}</td>
                    <td>{n(p.files)}</td>
                    <td>{gb(p.bytes)}</td>
                    <td>{dev ? pct(p.bytes, dev.sizeBytes) : '—'}</td>
                    <td>{p.hotness ? n(p.hotness.tracked) : '—'}</td>
                    <td>{p.hotness ? n(p.hotness.reusedBlocks) : '—'}</td>
                    <td title={when(p.hotness?.lastHit)}>{p.hotness?.lastHit ? ago(p.hotness.lastHit) : '—'}</td>
                    <td>{when(p.oldest)} → {when(p.newest)}</td>
                    <td>{p.usedBy?.length ? p.usedBy.map((u) => `:${u.port}`).join(' ') : <span style={{ opacity: 0.5 }}>idle</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 3 — device capacity */}
      {fsAll.length > 0 && (
        <div className={styles.metricsScroll} style={{ marginTop: 8 }}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>device</th><th>host</th><th>used</th><th>total</th><th>free</th><th></th>
              </tr>
            </thead>
            <tbody>
              {fsAll.map((f) => (
                <tr key={`${f.host}${f.mount}`}>
                  <td className={styles.stickyCol}>{f.mount}</td>
                  <td>{f.host}</td>
                  <td>{gb(f.usedBytes)}</td>
                  <td>{gb(f.sizeBytes)}</td>
                  <td>{gb(f.availBytes)}</td>
                  <td><Bar used={f.usedBytes} total={f.sizeBytes} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 4 — llama.cpp snapshots, ranked by how often each has actually been restored */}
      {store.snapshots.length > 0 && (
        <div className={styles.metricsScroll} style={{ marginTop: 8 }}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>snapshot (llama.cpp)</th>
                <th title="How many times this snapshot has been restored">restores</th>
                <th>tokens</th>
                <th>size</th>
                <th>kind</th>
                <th>created</th>
                <th>last restored</th>
              </tr>
            </thead>
            <tbody>
              {store.snapshots.filter((s) => !s.error).map((s) => (
                <tr key={s.hash}>
                  <td className={styles.stickyCol} title={`${s.hash} · ${s.modelFp}`}>{s.hash.slice(0, 16)}</td>
                  <td style={s.restoreCount > 0 ? { fontWeight: 600 } : { opacity: 0.5 }}>{n(s.restoreCount)}</td>
                  <td>{n(s.tokens)}</td>
                  <td>{gb(s.bytes)}</td>
                  <td>{s.kind}</td>
                  <td>{when(s.createdAt, 'ms')}</td>
                  <td title={when(s.lastRestoredAt, 'ms')}>{ago(s.lastRestoredAt, 'ms') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 5 — vLLM has no per-snapshot record to rank: its tier is content-addressed blocks shared
              across conversations. Block reuse counts are the honest equivalent. */}
      {pools.some((p) => p.hotness?.top?.length) && (
        <div className={styles.metricsScroll} style={{ marginTop: 8 }}>
          <table className={styles.metricsTable}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>most-reused blocks (vLLM)</th>
                <th>bucket</th>
                <th title="Lookups that found this block">lookups</th>
                <th>last used</th>
              </tr>
            </thead>
            <tbody>
              {pools.flatMap((p) => (p.hotness?.top ?? []).map((bkt) => ({ ...bkt, pool: p.name })))
                .sort((a, b) => b.hits - a.hits)
                .slice(0, 12)
                .map((bkt) => (
                  <tr key={`${bkt.pool}-${bkt.block}`}>
                    <td className={styles.stickyCol}>{bkt.block}</td>
                    <td title={bkt.pool}>{bkt.pool.length > 28 ? `${bkt.pool.slice(0, 28)}…` : bkt.pool}</td>
                    <td style={{ fontWeight: 600 }}>{n(bkt.hits)}</td>
                    <td title={when(bkt.lastHit)}>{ago(bkt.lastHit)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {store.loaded && store.engines.length === 0 && !store.nodes.some((nd) => nd.error) && (
        <div className={styles.loading}>No LLM services running, so there is nothing to attach the cache to.</div>
      )}
    </div>
  )
})
