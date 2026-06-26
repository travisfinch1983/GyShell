import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, X, ExternalLink, Pause, Play, RotateCw, Square, Loader2, Cpu, Server } from 'lucide-react'
import { aiServicesStore as store, type AiService } from '../../stores/AiServicesStore'
import { ConfirmModal } from '../Cluster/ClusterModals'
import styles from './AiServices.module.scss'

const TYPE_COLORS: Record<string, string> = {
  llm: 'var(--accent)', tts: '#c879e0', stt: '#79b8e0', image: '#e0a832',
  tools: '#5fd38a', embed: '#8aa0ff', rerank: '#8aa0ff', training: '#e0794f',
}
function uptime(ts?: number): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const ServiceCard: React.FC<{ s: AiService; onKill: (s: AiService) => void }> = observer(({ s, onKill }) => {
  const busy = store.busyId === s.id
  const color = TYPE_COLORS[s.serviceType || ''] || 'var(--fg-muted)'
  const model = [s.modelFamily, s.modelVariant, s.quantFormat].filter(Boolean).join(' · ')
  const sd = !!s.isSystemService
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.typeBadge} style={{ background: `color-mix(in srgb, ${color} 22%, transparent)`, color }}>{s.serviceType || 'svc'}</span>
        <span className={styles.svcName} title={s.providerName}>{s.providerName || s.providerId}</span>
        {busy && <Loader2 size={13} className={styles.spin} />}
      </div>
      {model && <div className={styles.model}>{model}</div>}
      <div className={styles.meta}>
        <span>{s.node}</span><span>:{s.port}</span>
        {s.gpuPciIds?.length ? <span className={styles.gpu}><Cpu size={11} /> {s.gpuPciIds.length}×GPU</span> : null}
        {s.startedAt ? <span className={styles.up}>up {uptime(s.startedAt)}</span> : null}
        <span className={sd ? styles.sd : styles.tmux}>{sd ? 'systemd' : 'tmux'}</span>
      </div>
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
