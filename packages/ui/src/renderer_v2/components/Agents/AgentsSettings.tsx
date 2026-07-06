import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Bot, Plus } from 'lucide-react'
import { hermesAgentsStore as store } from '../../stores/HermesAgentsStore'
import { AgentEditor } from './AgentEditor'
import styles from './Agents.module.scss'

const NEW = '__new__'

/**
 * Settings › Agents body — Hermes fleet agents (prototype-2a editor). Mounted in
 * SettingsView under settingsSection === "agents", replacing the standalone
 * Agents primary tab. The legacy AgentDefinition roster (delegate_agent
 * sub-agents for the primary chat) renders as a sibling section below.
 */
export const AgentsSettings: React.FC = observer(() => {
  const [active, setActive] = useState<string>(NEW)

  useEffect(() => {
    void store.refresh().then(() => {
      if (store.agents.length) setActive((a) => (a === NEW ? store.agents[0] : a))
    })
    void store.loadCatalog()
  }, [])

  if (active !== NEW && store.loaded && !store.agents.includes(active)) setActive(store.agents[0] ?? NEW)

  return (
    <div className={styles.settingsBody}>
      <div className={styles.tabs}>
        {store.agents.map((id) => (
          <button key={id} className={`${styles.tab} ${active === id ? styles.tabActive : ''}`} onClick={() => setActive(id)}>
            <Bot size={13} /> {store.specs.get(id)?.displayName ?? id}
          </button>
        ))}
        <button className={`${styles.tab} ${active === NEW ? styles.tabActive : ''}`} onClick={() => setActive(NEW)}>
          <Plus size={13} /> New agent
        </button>
      </div>
      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {active === NEW ? (
        <AgentEditor key={NEW} onSaved={(id) => setActive(id)} />
      ) : (
        <AgentEditor
          key={active}
          editId={active}
          initialSpec={store.specs.get(active) ?? undefined}
          specSource={store.specSources.get(active)}
          onSaved={() => undefined}
          onDeleted={() => setActive(store.agents[0] ?? NEW)}
        />
      )}
    </div>
  )
})
