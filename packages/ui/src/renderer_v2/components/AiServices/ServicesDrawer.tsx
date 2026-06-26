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

/** Tiny inline util sparkline (0–100). */
const Sparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  if (!data.length) return null
  const w = 64, h = 18, max = 100
  const pts = data.map((v, i) => {
    const x = data.length === 1 ? w : (i / (data.length - 1)) * w
    const y = h - (Math.max(0, Math.min(max, v)) / max) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg width={w} height={h} className={styles.spark}>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
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
  const sparkPci = s.gpuPciIds?.[0]
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

      {/* GPU badges + VRAM + usage sparkline */}
      {gpus.length > 0 && (
        <div className={styles.gpuRow}>
          {gpus.map((g) => (
            <span key={g.pci} className={styles.gpuBadge} title={`${g.pci} · ${g.info!.util}% · ${gb(g.info!.memUsed)}/${gb(g.info!.memTotal)} GB`}>
              <Cpu size={10} /> GPU{g.info!.index} {g.info!.name} · {g.info!.util}%
            </span>
          ))}
          <span className={styles.vram}>{gb(vramUsed)}/{gb(vramTotal)} GB</span>
          {sparkPci && store.utilHistory[sparkPci]?.length ? <Sparkline data={store.utilHistory[sparkPci]} color={color} /> : null}
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
      <div className={styles.drawerFilter}>
        <select className={styles.filter} value={store.typeFilter} onChange={(e) => store.setTypeFilter(e.target.value)}>
          <option value="all">all types</option>
          {store.serviceTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className={styles.drawerBody}>
        {store.error && <div className={styles.errorBar}>{store.error}</div>}
        {!store.loaded && !store.error && <div className={styles.loading}>Loading…</div>}
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
