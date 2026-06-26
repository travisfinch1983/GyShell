import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, X, ExternalLink, Pause, Play, RotateCw, Square, Loader2, Cpu, Server, Pencil, Check } from 'lucide-react'
import { aiServicesStore as store, type AiService } from '../../stores/AiServicesStore'
import { ConfirmModal } from '../Cluster/ClusterModals'
import styles from './AiServices.module.scss'

const TYPE_COLORS: Record<string, string> = {
  llm: 'var(--accent)', tts: '#c879e0', stt: '#79b8e0', image: '#e0a832',
  tools: '#5fd38a', embed: '#8aa0ff', rerank: '#8aa0ff', training: '#e0794f',
}
const STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: 'Running', cls: 'stRun' },
  suspended: { label: 'Suspended', cls: 'stSusp' },
  down: { label: 'Down', cls: 'stDown' },
  unknown: { label: '…', cls: 'stUnknown' },
}
function uptime(ts?: number | string): string {
  if (!ts) return ''
  const t = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!t) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
function fmtCtx(n?: number): string {
  if (!n) return ''
  if (n >= 1024) return `${Math.round(n / 1024)}K`
  return String(n)
}
const gb = (mb?: number) => (mb ? (mb / 1024).toFixed(mb < 10240 ? 1 : 0) : '0')

/** Element-wise average / sum across several equal-ish-length series. */
function combine(series: number[][], mode: 'avg' | 'sum'): number[] {
  const arrs = series.filter((a) => a?.length)
  if (!arrs.length) return []
  const len = Math.min(...arrs.map((a) => a.length))
  const out: number[] = []
  for (let i = 0; i < len; i++) {
    const slice = arrs.map((a) => a[a.length - len + i])
    const s = slice.reduce((n, v) => n + v, 0)
    out.push(mode === 'avg' ? s / slice.length : s)
  }
  return out
}

/** Full-width labeled sparkline row. data scaled to [0,max]; stretches to container width. */
const SparkRow: React.FC<{ label: string; data: number[]; max: number; color: string; value: string }> = ({ label, data, max, color, value }) => {
  const h = 24
  const pts =
    data.length > 0
      ? data
          .map((v, i) => {
            const x = data.length === 1 ? 100 : (i / (data.length - 1)) * 100
            const y = h - (Math.max(0, Math.min(max || 1, v)) / (max || 1)) * h
            return `${x.toFixed(2)},${y.toFixed(2)}`
          })
          .join(' ')
      : ''
  return (
    <div className={styles.sparkRow}>
      <span className={styles.sparkLabel}>{label}</span>
      <svg className={styles.sparkSvg} height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none">
        {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className={styles.sparkVal}>{value}</span>
    </div>
  )
}

const ServiceCard: React.FC<{ s: AiService; onKill: (s: AiService) => void }> = observer(({ s, onKill }) => {
  const busy = store.busyId === s.id
  const color = TYPE_COLORS[s.serviceType || ''] || 'var(--fg-muted)'
  const model = [s.modelFamily, s.modelVariant, s.quantFormat, s.quantSize].filter(Boolean).join(' · ')
  const sd = !!s.isSystemService
  const status = store.statusOf(s.id)
  const stat = store.statsById[s.id]
  const st = STATUS[status]
  const gpus = (s.gpuPciIds ?? []).map((pci) => ({ pci, info: store.gpuIndex[pci] })).filter((g) => g.info)
  const vramUsed = gpus.reduce((n, g) => n + (g.info?.memUsed ?? 0), 0)
  const vramTotal = gpus.reduce((n, g) => n + (g.info?.memTotal ?? 0), 0)
  const pcis = gpus.map((g) => g.pci)
  const utilSeries = combine(pcis.map((p) => store.utilHistory[p] ?? []), 'avg')
  const vramSeries = combine(pcis.map((p) => store.vramHistory[p] ?? []), 'sum')
  const curUtil = utilSeries.length ? Math.round(utilSeries[utilSeries.length - 1]) : 0
  const alias = stat?.modelIdentifier || s.aliasOverride

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  return (
    <div className={styles.card} style={{ borderColor: `color-mix(in srgb, ${color} 55%, var(--border))`, borderLeft: `3px solid ${color}` }}>
      <div className={styles.cardHead}>
        <span className={styles.typeBadge} style={{ background: `color-mix(in srgb, ${color} 22%, transparent)`, color }}>{s.serviceType || 'svc'}</span>
        <span className={styles.svcName} title={s.providerName}>{s.providerName || s.providerId}</span>
        <span className={`${styles.statusPill} ${styles[st.cls]}`}>{st.label}</span>
        {busy && <Loader2 size={13} className={styles.spin} />}
      </div>

      {model && <div className={styles.model}>{model}</div>}

      {/* model alias / served-name override */}
      <div className={styles.aliasRow}>
        {editing ? (
          <>
            <input
              className={styles.aliasInput}
              autoFocus
              value={draft}
              placeholder="served model name"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { void store.setAlias(s.id, draft); setEditing(false) }
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <button className={styles.act} title="Save alias" onClick={() => { void store.setAlias(s.id, draft); setEditing(false) }}><Check size={12} /></button>
          </>
        ) : (
          <>
            <span className={styles.alias} title={alias || ''}>{alias || <span className={styles.aliasNone}>no alias</span>}</span>
            <button className={styles.iconMini} title="Override served model name" onClick={() => { setDraft(alias || ''); setEditing(true) }}><Pencil size={11} /></button>
          </>
        )}
      </div>

      <div className={styles.meta}>
        <span>{s.node}</span><span>:{s.port}</span>
        {s.contextSize ? <span title="context size">ctx {fmtCtx(s.contextSize)}</span> : null}
        {s.proxySlot != null ? <span title="proxy slot">slot {String(s.proxySlot)}</span> : null}
        {typeof stat?.tps === 'number' ? <span className={styles.tps}>{stat.tps.toFixed(0)} tps</span> : null}
        {s.startedAt ? <span className={styles.up}>up {uptime(s.startedAt)}</span> : null}
        <span className={sd ? styles.sd : styles.tmux}>{sd ? 'systemd' : 'tmux'}</span>
      </div>

      {/* GPU badges (wrap to as many rows as needed) */}
      {gpus.length > 0 && (
        <div className={styles.gpuRow}>
          {gpus.map((g) => (
            <span key={g.pci} className={styles.gpuBadge} title={`${g.pci} · ${g.info!.util}% · ${gb(g.info!.memUsed)}/${gb(g.info!.memTotal)} GB`}>
              <Cpu size={10} /> GPU{g.info!.index} {g.info!.name}
            </span>
          ))}
        </div>
      )}

      {/* Full-width labeled GPU + VRAM usage sparklines */}
      {gpus.length > 0 && (
        <div className={styles.metrics}>
          <SparkRow label="GPU" data={utilSeries} max={100} color={color} value={`${curUtil}%`} />
          <SparkRow label="VRAM" data={vramSeries} max={vramTotal} color="#8aa0ff" value={`${gb(vramUsed)}/${gb(vramTotal)} GB`} />
        </div>
      )}

      <div className={styles.cardFoot}>
        {s.endpoint && (
          <a className={styles.endpoint} href={s.endpoint} target="_blank" rel="noreferrer" title={s.endpoint}>
            {s.endpoint.replace(/^https?:\/\//, '')} <ExternalLink size={10} />
          </a>
        )}
        <div className={styles.spacer} />
        {sd && (
          <>
            <button className={styles.act} title="Suspend" disabled={busy} onClick={() => void store.lifecycle(s.id, 'suspend')}><Pause size={13} /></button>
            <button className={styles.act} title="Start" disabled={busy} onClick={() => void store.lifecycle(s.id, 'start')}><Play size={13} /></button>
            <button className={styles.act} title="Restart" disabled={busy} onClick={() => void store.lifecycle(s.id, 'restart')}><RotateCw size={13} /></button>
          </>
        )}
        <button className={`${styles.act} ${styles.danger}`} title="Stop + remove" disabled={busy} onClick={() => onKill(s)}><Square size={13} /></button>
      </div>
    </div>
  )
})

const SUFFIX: Record<string, string> = {
  llm: '/v1/chat/completions',
  embed: '/v1/embeddings',
  rerank: '/v1/rerank',
  tts: '/v1/audio/speech',
  stt: '/v1/audio/transcriptions',
  image: '/v1',
}
const CopyRow: React.FC<{ url: string; label?: string }> = ({ url, label }) => {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={styles.copyRow}
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {label && <span className={styles.copyLabel}>{label}</span>}
      <code className={styles.copyUrl}>{url}</code>
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  )
}

/** AI-Lab Universal API Proxy card — base + per-type/slot endpoints, click-to-copy. */
const ProxyCard: React.FC = observer(() => {
  const ps = store.proxyState
  if (!ps?.port) return null
  const base = `http://${window.location.hostname}:${ps.port}`
  const types = ps.types || {}
  const present = Object.keys(types).filter((t) => (types[t] || []).length && SUFFIX[t])
  return (
    <div className={styles.proxyCard}>
      <div className={styles.proxyHead}>
        <Server size={13} className={styles.headerIcon} />
        <span className={styles.proxyTitle}>Universal API Proxy</span>
      </div>
      {present.map((t) => {
        const list = types[t]
        return (
          <div key={t} className={styles.proxyType}>
            <div className={styles.proxyTypeLabel}>{t}</div>
            <CopyRow url={`${base}/${t}${SUFFIX[t]}`} label="universal" />
            {list.map((svc: any) => (
              <CopyRow key={svc.slot} url={`${base}/${t}/${svc.slot}${SUFFIX[t]}`} label={`slot ${svc.slot}${svc.aliasOverride || svc.model ? ` · ${svc.aliasOverride || svc.model}` : ''}`} />
            ))}
          </div>
        )
      })}
      {present.length === 0 && <div className={styles.proxyEmpty}>No routable services yet.</div>}
    </div>
  )
})

/** Global right-side running-services drawer — visible on any tab while open. */
export const ServicesDrawer: React.FC<{ visible: boolean; onClose: () => void }> = observer(({ visible, onClose }) => {
  const [killing, setKilling] = useState<AiService | null>(null)
  useEffect(() => {
    if (visible) store.startPolling(15000)
    else store.stopPolling()
    return () => store.stopPolling()
  }, [visible])

  return (
    <div className={`${styles.drawer} ${visible ? styles.drawerOpen : ''}`} aria-hidden={!visible}>
      <div className={styles.drawerHead}>
        <Server size={15} className={styles.headerIcon} />
        <span className={styles.title}>Services</span>
        <span className={styles.count}>{store.services.length}</span>
        <div className={styles.spacer} />
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.load()}>
          <RefreshCw size={13} className={store.loading ? styles.spin : ''} />
        </button>
        <button className={styles.refreshBtn} title="Close" onClick={onClose}><X size={15} /></button>
      </div>
      <div className={styles.filterChips}>
        <button
          className={`${styles.fChip} ${store.typeFilter === 'all' ? styles.fChipActive : ''}`}
          onClick={() => store.setTypeFilter('all')}
        >
          All <span className={styles.fCount}>{store.services.length}</span>
        </button>
        {store.serviceTypes.map((t) => {
          const c = TYPE_COLORS[t] || 'var(--fg-muted)'
          const active = store.typeFilter === t
          const n = store.services.filter((s) => (s.serviceType || 'other') === t).length
          return (
            <button
              key={t}
              className={`${styles.fChip} ${active ? styles.fChipActive : ''}`}
              style={active ? { background: c, borderColor: c, color: '#06121f' } : { borderColor: `color-mix(in srgb, ${c} 50%, var(--border))`, color: c }}
              onClick={() => store.setTypeFilter(t)}
            >
              {t} <span className={styles.fCount}>{n}</span>
            </button>
          )
        })}
      </div>
      <div className={styles.drawerBody}>
        {store.error && <div className={styles.errorBar}>{store.error}</div>}
        {!store.loaded && !store.error && <div className={styles.loading}>Loading…</div>}
        <ProxyCard />
        {store.filteredServices.map((s) => <ServiceCard key={s.id} s={s} onKill={setKilling} />)}
        {store.loaded && store.filteredServices.length === 0 && <div className={styles.empty}>No running services.</div>}
      </div>
      {killing && (
        <ConfirmModal
          title={`Stop ${killing.providerName || killing.providerId}?`}
          message={`Stops and removes the service on ${killing.node}:${killing.port}.`}
          confirmLabel="Stop + remove" danger
          onConfirm={() => void store.lifecycle(killing.id, 'kill')}
          onClose={() => setKilling(null)}
        />
      )}
    </div>
  )
})
