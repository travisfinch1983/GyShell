import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Bot, FileText, Plus } from 'lucide-react'
import { hermesAgentsStore as store } from '../../stores/HermesAgentsStore'
import { AgentEditor } from './AgentEditor'
import { AgentDocs, InlineDocEditor } from './AgentDocs'
import styles from './Agents.module.scss'

const NEW = '__new__'
const TEMPLATES = '__templates__'

/** The Hermes `default` profile IS the template store: its docs are what
 *  copy-on-create seeds into every new agent's workspace. It gets the
 *  dedicated Doc Templates tab, so it's filtered out of the agent badges. */
const TEMPLATE_AGENT = 'default'

/**
 * Doc Templates panel — Travis's sketch: pseudo-tab left of the agent badges.
 * The template store is the Hermes `default` profile's docs, so this is the
 * same AgentDocs component pointed at agentId "default" (SOUL.md included —
 * no Persona tab owns it here). New templates: name a file and PUT it via the
 * missing-file-creates-on-save path.
 */
const DocTemplatesView: React.FC = () => {
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState<string | null>(null)

  const startNew = () => {
    const slug = newName.trim().replace(/\.md$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+/, '')
    if (!slug) return
    setCreating(`workspace/${slug}.md`)
    setNewName('')
  }

  return (
    <div className={styles.agentView}>
      <section>
        <div className={styles.sectionTitle}>Doc Templates</div>
        <div className={styles.sectionSub}>
          The default operating docs every NEW agent is created from (the Hermes “default” profile).
          Edits here change the templates only — existing agents keep their own copies.
          bootstrap.md and USER.md live here as the shared baseline.
        </div>
        <div className={styles.card}>
          <div className={styles.summaryRow}>
            <FileText size={15} />
            <div>
              <strong>New template</strong>
              <div className={styles.dim}>Creates workspace/&lt;name&gt;.md in the template store; agents can adopt it via “add from template”.</div>
            </div>
            <span className={styles.spacer} />
            <input
              className={`${styles.input} ${styles.mono}`}
              style={{ maxWidth: 260 }}
              value={newName}
              placeholder="e.g. STYLE-GUIDE"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') startNew() }}
            />
            <button className={styles.btn} disabled={!newName.trim()} onClick={startNew}>Create →</button>
          </div>
        </div>
        {creating && (
          <InlineDocEditor
            key={creating}
            agentId={TEMPLATE_AGENT}
            path={creating}
            hint="New template — Save creates it in the template store."
          />
        )}
        <AgentDocs agentId={TEMPLATE_AGENT} includeSoul />
      </section>
    </div>
  )
}

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
      if (store.agents.length) setActive((a) => (a === NEW ? store.agents.filter((x) => x !== TEMPLATE_AGENT)[0] ?? NEW : a))
    })
    void store.loadCatalog()
  }, [])

  const visibleAgents = store.agents.filter((a) => a !== TEMPLATE_AGENT)
  if (active !== NEW && active !== TEMPLATES && store.loaded && !visibleAgents.includes(active)) {
    setActive(visibleAgents[0] ?? NEW)
  }

  return (
    <div className={styles.settingsBody}>
      <div className={styles.tabs}>
        <button className={`${styles.tab} ${active === TEMPLATES ? styles.tabActive : ''}`} onClick={() => setActive(TEMPLATES)}>
          <FileText size={13} /> Doc Templates
        </button>
        <span className={styles.tabDivider} />
        {visibleAgents.map((id) => (
          <button key={id} className={`${styles.tab} ${active === id ? styles.tabActive : ''}`} onClick={() => setActive(id)}>
            <Bot size={13} /> {store.specs.get(id)?.displayName ?? id}
          </button>
        ))}
        <button className={`${styles.tab} ${active === NEW ? styles.tabActive : ''}`} onClick={() => setActive(NEW)}>
          <Plus size={13} /> New agent
        </button>
      </div>
      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {active === TEMPLATES ? (
        <DocTemplatesView />
      ) : active === NEW ? (
        <AgentEditor key={NEW} onSaved={(id) => setActive(id)} />
      ) : (
        <AgentEditor
          key={active}
          editId={active}
          initialSpec={store.specs.get(active) ?? undefined}
          specSource={store.specSources.get(active)}
          onSaved={() => undefined}
          onDeleted={() => setActive(visibleAgents[0] ?? NEW)}
        />
      )}
    </div>
  )
})
