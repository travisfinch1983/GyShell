import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, BrainCircuit, Cpu, PanelRightOpen } from 'lucide-react'
import { aiServicesStore as store } from '../../stores/AiServicesStore'
import styles from './AiServices.module.scss'

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

/**
 * AI Services tab. Running-services cards now live in the global right-side drawer
 * (ServicesDrawer); this tab is GPU Pool + (future phases) the launch UI.
 */
export const AiServicesPanel: React.FC<{ onOpenServices?: () => void }> = observer(({ onOpenServices }) => {
  useEffect(() => {
    void store.load()
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <BrainCircuit size={16} className={styles.headerIcon} />
        <span className={styles.title}>AI Services</span>
        <span className={styles.subTitle}>GPU Pool</span>
        <div className={styles.spacer} />
        {onOpenServices && (
          <button className={styles.openSvcBtn} title="Open running services" onClick={onOpenServices}>
            <PanelRightOpen size={13} /> Services <span className={styles.count}>{store.services.length}</span>
          </button>
        )}
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.load()}>
          <RefreshCw size={14} className={store.loading ? styles.spin : ''} />
        </button>
      </div>

      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {!store.loaded && !store.error && <div className={styles.loading}>Loading GPU pool…</div>}

      <div className={styles.body}>
        <PoolView />
      </div>
    </div>
  )
})
