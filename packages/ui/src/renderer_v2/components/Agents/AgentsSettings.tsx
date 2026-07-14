import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Bot, FileText, Plus, Save, Undo2, UserRound, X } from 'lucide-react'
import { hermesAgentsStore as store } from '../../stores/HermesAgentsStore'
import { hermesApi } from '../../stores/hermesApi'
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
/**
 * Canonical shared USER doc ("About Your Human") — /root/.hermes/global/USER.md
 * via GET/PUT /api/hermes/doc-templates/user, NOT a per-agent file. Saving
 * re-propagates the content into every agent's AGENTS.md user section (doc
 * consolidation 54a0c55), so the save readout surfaces agentsUpdated.
 * Wipe-guarded like every doc editor: only opens on a successful GET.
 */
const GlobalUserEditor: React.FC = () => {
  const [open, setOpen] = useState<{ content: string; base: string } | null>(null)
  const [opening, setOpening] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const openDoc = async () => {
    setOpening(true); setMsg('')
    const content = await hermesApi.getUserTemplate()
    setOpening(false)
    if (content === null) { setMsg("Couldn't read the canonical USER doc — not opening an empty editor over it."); return }
    setOpen({ content, base: content })
  }

  const save = async () => {
    if (!open || open.content === open.base) return
    setSaving(true); setMsg('')
    const r = await hermesApi.putUserTemplate(open.content)
    setSaving(false)
    if (!r.ok) { setMsg(`Save failed: ${r.error ?? 'unknown'}`); return }
    setOpen({ ...open, base: open.content })
    setMsg(`Saved ✓${typeof r.agentsUpdated === 'number' ? ` — re-propagated into ${r.agentsUpdated} agent${r.agentsUpdated === 1 ? '' : 's'}` : ''}`)
  }

  const dirty = !!open && open.content !== open.base
  return (
    <div className={styles.card}>
      <div className={styles.summaryRow}>
        <UserRound size={15} />
        <div>
          <strong className={styles.mono}>USER — About Your Human</strong>
          <div className={styles.dim}>
            The one shared file about Travis. Saving rewrites the canonical global USER doc and
            re-propagates it into every agent's AGENTS.md — not a per-agent copy.
          </div>
        </div>
        <span className={styles.spacer} />
        {!open ? (
          <button className={styles.btn} disabled={opening} onClick={() => void openDoc()}>
            {opening ? 'Opening…' : 'Open editor →'}
          </button>
        ) : (
          <>
            <button className={styles.btn} disabled={saving || !dirty} title="Discard changes" onClick={() => setOpen({ ...open, content: open.base })}>
              <Undo2 size={13} /> Revert
            </button>
            <button className={styles.btnPrimary} disabled={saving || !dirty} onClick={() => void save()}>
              <Save size={13} /> {saving ? 'Saving…' : 'Save & propagate'}
            </button>
            <button
              className={styles.btn}
              title="Close editor"
              onClick={() => { if (!dirty || window.confirm('Discard unsaved changes to the USER doc?')) { setOpen(null); setMsg('') } }}
            >
              <X size={13} />
            </button>
          </>
        )}
      </div>
      {msg && <div className={styles.dim} style={{ marginTop: 6 }}>{msg}</div>}
      {open && (
        <textarea
          className={`${styles.soul} ${styles.mono}`}
          value={open.content}
          onChange={(e) => setOpen({ ...open, content: e.target.value })}
          spellCheck={false}
        />
      )}
    </div>
  )
}

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
          The shared USER doc is global (propagated into every agent's AGENTS.md), edited below.
        </div>
        <GlobalUserEditor />
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
