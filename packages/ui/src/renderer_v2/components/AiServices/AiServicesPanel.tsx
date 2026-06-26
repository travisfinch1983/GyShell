import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, BrainCircuit, ExternalLink, Pause, Play, RotateCw, Square, Loader2, Cpu } from 'lucide-react'
import { aiServicesStore as store, type AiService } from '../../stores/AiServicesStore'
import { ConfirmModal } from '../Cluster/ClusterModals'
import styles from './AiServices.module.scss'

const TYPE_COLORS: Record<string, string> = {
  llm: 'var(--accent)',
  tts: '#c879e0',
  stt: '#79b8e0',
  image: '#e0a832',
  tools: '#5fd38a',
  embed: '#8aa0ff',
  rerank: '#8aa0ff',
  training: '#e0794f',
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
        <span className={styles.typeBadge} style={{ background: `color-mix(in srgb, ${color} 22%, transparent)`, color }}>
          {s.serviceType || 'svc'}
        </span>
        <span className={styles.svcName} title={s.providerName}>{s.providerName || s.providerId}</span>
        {busy && <Loader2 size={13} className={styles.spin} />}
      </div>
      {model && <div className={styles.model}>{model}</div>}
      <div className={styles.meta}>
        <span>{s.node}</span>
        <span>:{s.port}</span>
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
            <button className={styles.act} title="Suspend (stop, keep)" disabled={busy} onClick={() => void store.lifecycle(s.id, 'suspend')}><Pause size={13} /></button>
            <button className={styles.act} title="Start" disabled={busy} onClick={() => void store.lifecycle(s.id, 'start')}><Play size={13} /></button>
            <button className={styles.act} title="Restart" disabled={busy} onClick={() => void store.lifecycle(s.id, 'restart')}><RotateCw size={13} /></button>
          </>
        )}
        <button className={`${styles.act} ${styles.danger}`} title="Stop + remove" disabled={busy} onClick={() => onKill(s)}><Square size={13} /></button>
      </div>
    </div>
  )
})

const PoolView: React.FC = observer(() => (
  <div className={styles.poolWrap}>
    {Object.entries(store.config.agents).map(([node, agent]) => {
      const pool = store.poolByNode(node)
      const providers = Object.entries(agent.providers ?? {}).filter(([, p]) => p?.installed)
      return (
        <div key={node} className={styles.agentCard}>
          <div className={styles.agentHead}>
            <Cpu size={15} className={styles.agentIcon} />
            <span className={styles.agentName}>{node}</span>
            <span className={styles.agentMeta}>agent CT {agent.vmid} · {providers.length} providers</span>
          </div>
          <div className={styles.poolGrid}>
            {pool.length === 0 && <div className={styles.poolEmpty}>no GPUs configured</div>}
            {pool.map((g) => (
              <div key={g.pci} className={`${styles.poolGpu} ${g.mode === 'ai-pool' ? styles.aiPool : styles.reserved}`} title={g.pci}>
                <span className={styles.poolPci}>{g.pci}</span>
                <span className={styles.poolMode}>{g.mode}</span>
              </div>
            ))}
          </div>
          {providers.length > 0 && (
            <div className={styles.provRow}>
              {providers.map(([id]) => <span key={id} className={styles.provChip}>{id}</span>)}
            </div>
          )}
        </div>
      )
    })}
  </div>
))

export const AiServicesPanel: React.FC = observer(() => {
  const [killing, setKilling] = useState<AiService | null>(null)
  useEffect(() => {
    store.startPolling(15000)
    return () => store.stopPolling()
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <BrainCircuit size={16} className={styles.headerIcon} />
        <span className={styles.title}>AI Services</span>
        <div className={styles.tabs}>
          <button className={`${styles.tab} ${store.view === 'services' ? styles.tabActive : ''}`} onClick={() => store.setView('services')}>
            Services <span className={styles.count}>{store.services.length}</span>
          </button>
          <button className={`${styles.tab} ${store.view === 'pool' ? styles.tabActive : ''}`} onClick={() => store.setView('pool')}>
            GPU Pool
          </button>
        </div>
        {store.view === 'services' && (
          <select className={styles.filter} value={store.typeFilter} onChange={(e) => store.setTypeFilter(e.target.value)}>
            <option value="all">all types</option>
            {store.serviceTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <div className={styles.spacer} />
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.load()}>
          <RefreshCw size={14} className={store.loading ? styles.spin : ''} />
        </button>
      </div>

      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {!store.loaded && !store.error && <div className={styles.loading}>Loading AI services…</div>}

      <div className={styles.body}>
        {store.view === 'services' ? (
          <div className={styles.grid}>
            {store.filteredServices.map((s) => <ServiceCard key={s.id} s={s} onKill={setKilling} />)}
            {store.loaded && store.filteredServices.length === 0 && <div className={styles.empty}>No running services.</div>}
          </div>
        ) : (
          <PoolView />
        )}
      </div>

      {killing && (
        <ConfirmModal
          title={`Stop ${killing.providerName || killing.providerId}?`}
          message={`This stops and removes the service on ${killing.node}:${killing.port}.`}
          confirmLabel="Stop + remove"
          danger
          onConfirm={() => void store.lifecycle(killing.id, 'kill')}
          onClose={() => setKilling(null)}
        />
      )}
    </div>
  )
})
