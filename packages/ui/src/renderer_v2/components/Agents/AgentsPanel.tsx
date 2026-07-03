import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Bot, Plus, Trash2, Pencil, SendHorizonal } from 'lucide-react'
import { hermesAgentsStore as store } from '../../stores/HermesAgentsStore'
import { hermesApi } from '../../stores/hermesApi'
import { confirmStore } from '../../stores/confirmStore'
import { AgentBuilder, TagBadge } from './AgentBuilder'
import styles from './Agents.module.scss'

const NEW_TAB = '__new__'

/**
 * One Hermes agent: spec summary + interim one-shot prompt box (POST /prompt).
 * The SSE chat surface (workstream 2) replaces the prompt box next increment.
 */
const AgentView: React.FC<{ id: string }> = observer(({ id }) => {
  const spec = store.specs.get(id)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [log, setLog] = useState<Array<{ who: 'you' | 'agent' | 'error'; text: string }>>([])
  const [waiting, setWaiting] = useState(false)
  const busy = store.busyIds.has(id)

  const remove = async () => {
    const ok = await confirmStore.confirm({
      title: 'Delete agent',
      message: `Delete the “${id}” Hermes profile on CT158? Its persona, config, memory and sessions are removed.`,
      confirmText: 'Delete',
    })
    if (ok) void store.remove(id)
  }

  const send = async () => {
    const t = text.trim()
    if (!t || waiting) return
    setText('')
    setLog((l) => [...l, { who: 'you', text: t }])
    setWaiting(true)
    const r = await hermesApi.prompt(id, t)
    setWaiting(false)
    setLog((l) => [...l, r.ok ? { who: 'agent', text: r.reply || '(empty reply)' } : { who: 'error', text: r.error || 'prompt failed' }])
  }

  if (editing) {
    return (
      <div className={styles.agentView}>
        <AgentBuilder initialSpec={spec ?? undefined} editId={id} onSaved={() => setEditing(false)} />
        <button className={styles.btn} onClick={() => setEditing(false)}>Cancel</button>
      </div>
    )
  }

  return (
    <div className={styles.agentView}>
      <div className={styles.agentHead}>
        <Bot size={15} />
        <strong>{spec?.displayName ?? id}</strong>
        {spec?.model && (
          <span className={styles.dim}>
            <TagBadge tag={store.catalog.find((m) => m.id === spec.model)?.tag ?? 'AI-LAB'} /> {spec.model}
          </span>
        )}
        {spec === null && <span className={styles.dim}>spec read-back pending backend route</span>}
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy} onClick={() => setEditing(true)}>
          <Pencil size={13} /> Edit
        </button>
        <button className={styles.btnDanger} disabled={busy} onClick={() => void remove()}>
          <Trash2 size={13} /> Delete
        </button>
      </div>
      {spec?.persona?.soul && <div className={styles.soulPreview}>{spec.persona.soul}</div>}

      <div className={styles.promptLog}>
        {log.length === 0 && <div className={styles.dim}>Interim one-shot prompt (full streaming chat surface is the next increment).</div>}
        {log.map((e, i) => (
          <div key={i} className={e.who === 'you' ? styles.msgYou : e.who === 'agent' ? styles.msgAgent : styles.msgError}>
            {e.text}
          </div>
        ))}
        {waiting && <div className={styles.dim}>thinking…</div>}
      </div>
      <div className={styles.promptRow}>
        <input
          className={styles.input}
          value={text}
          placeholder={`prompt ${id}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
        />
        <button className={styles.btnPrimary} disabled={waiting || !text.trim()} onClick={() => void send()}>
          <SendHorizonal size={13} />
        </button>
      </div>
    </div>
  )
})

/** Agents primary tab — Hermes agents as sub-tabs + the builder under “+ New”. */
export const AgentsPanel: React.FC = observer(() => {
  const [active, setActive] = useState<string>(NEW_TAB)

  useEffect(() => {
    void store.refresh().then(() => {
      // Land on the first real agent when one exists.
      if (store.agents.length) setActive((a) => (a === NEW_TAB ? store.agents[0] : a))
    })
    void store.loadCatalog()
  }, [])

  const tabs = [...store.agents]
  if (active !== NEW_TAB && !tabs.includes(active) && store.loaded) setActive(tabs[0] ?? NEW_TAB)

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {tabs.map((id) => (
          <button key={id} className={`${styles.tab} ${active === id ? styles.tabActive : ''}`} onClick={() => setActive(id)}>
            <Bot size={13} /> {store.specs.get(id)?.displayName ?? id}
          </button>
        ))}
        <button className={`${styles.tab} ${active === NEW_TAB ? styles.tabActive : ''}`} onClick={() => setActive(NEW_TAB)}>
          <Plus size={13} /> New agent
        </button>
      </div>
      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      <div className={styles.body}>
        {active === NEW_TAB ? <AgentBuilder onSaved={(id) => setActive(id)} /> : <AgentView id={active} />}
      </div>
    </div>
  )
})
