import React, { useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, ChevronDown, ChevronRight, ListChecks, SendHorizonal, Settings2, Wrench } from 'lucide-react'
import type { HermesSlashCommand } from '@gyshell/shared'
import { hermesAgentsStore } from '../../stores/HermesAgentsStore'
import { hermesChatStore as chat, type ChatItem } from '../../stores/HermesChatStore'
import styles from './AgentChat.module.scss'

/** Collapsible reasoning block. */
const ThoughtRow: React.FC<{ item: ChatItem }> = ({ item }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className={styles.thought}>
      <button className={styles.thoughtHead} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} reasoning
        {item.streaming ? '…' : ` · ${item.text.length} chars`}
      </button>
      {open && <div className={styles.thoughtBody}>{item.text}</div>}
    </div>
  )
}

const ToolCard: React.FC<{ item: ChatItem }> = ({ item }) => (
  <div className={styles.toolCard}>
    <Wrench size={12} />
    <span className={styles.toolTitle}>{item.title || 'tool'}</span>
    <span className={`${styles.toolStatus} ${item.status === 'completed' ? styles.toolDone : ''}`}>{item.status ?? '…'}</span>
  </div>
)

const PlanCard: React.FC<{ item: ChatItem }> = ({ item }) => (
  <div className={styles.planCard}>
    <div className={styles.planHead}><ListChecks size={12} /> plan</div>
    {(item.plan ?? []).map((e, i) => (
      <div key={i} className={`${styles.planEntry} ${e.status === 'completed' ? styles.planDone : ''}`}>
        <span className={styles.planMark}>{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '›' : '·'}</span>
        {e.content}
      </div>
    ))}
  </div>
)

const Row: React.FC<{ item: ChatItem }> = ({ item }) => {
  switch (item.kind) {
    case 'user': return <div className={styles.msgYou}>{item.text}</div>
    case 'assistant':
      return (
        <div className={`${styles.msgAgent} markdown-body`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          {item.streaming ? <span className={styles.cursor}>▍</span> : null}
        </div>
      )
    case 'thought': return <ThoughtRow item={item} />
    case 'tool': return <ToolCard item={item} />
    case 'plan': return <PlanCard item={item} />
    case 'error': return <div className={styles.msgError}>{item.text}</div>
    default: return <div className={styles.sysRow}>{item.text}</div>
  }
}

/**
 * Live conversation with one Hermes agent. Pure OBSERVER of the backend-owned
 * session: mounting attaches the SSE stream, unmounting only detaches — the
 * session (and any in-flight turn) keeps running headless on the backend.
 */
const AgentConversation: React.FC<{ agentId: string }> = observer(({ agentId }) => {
  const s = chat.state(agentId)
  const [text, setText] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    chat.attach(agentId)
    // Observer-only detach — never stops the backend session (headless invariant).
    return () => chat.detach(agentId)
  }, [agentId])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [s.items.length, s.items[s.items.length - 1]?.text.length])

  const slashMatches = useMemo<HermesSlashCommand[]>(() => {
    if (!text.startsWith('/')) return []
    const q = text.slice(1).toLowerCase()
    return s.commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8)
  }, [text, s.commands])

  useEffect(() => setSlashOpen(slashMatches.length > 0 && text.startsWith('/') && !text.includes(' ')), [slashMatches, text])

  const send = () => {
    setSlashOpen(false)
    const t = text
    setText('')
    void chat.send(agentId, t)
  }

  const spec = hermesAgentsStore.specs.get(agentId)
  const pct = s.usage ? Math.min(100, Math.round((s.usage.used / s.usage.size) * 100)) : null

  return (
    <div className={styles.conv}>
      <div className={styles.convHead}>
        <span className={`${styles.dot} ${s.connected ? styles.dotOn : ''}`} title={s.connected ? 'stream attached' : 'stream detached — reconnecting'} />
        <strong>{spec?.displayName ?? agentId}</strong>
        {s.currentModel && <span className={styles.dim}>{s.currentModel}</span>}
        <span className={styles.spacer} />
        {pct !== null && s.usage && (
          <span className={styles.usage} title={`context: ${s.usage.used.toLocaleString()} / ${s.usage.size.toLocaleString()} tokens`}>
            <span className={styles.usageBar}><span className={styles.usageFill} style={{ width: `${pct}%` }} /></span>
            {pct}%
          </span>
        )}
      </div>

      <div ref={logRef} className={styles.log}>
        {s.items.length === 0 && (
          <div className={styles.dim}>
            Attached to the live session. The transcript shows events from attach onward — the session itself
            runs headless on the backend and survives closing this view.
          </div>
        )}
        {s.items.map((i) => <Row key={i.id} item={i} />)}
        {s.busy && <div className={styles.sysRow}>thinking…</div>}
      </div>

      <div className={styles.composerWrap}>
        {slashOpen && (
          <div className={styles.slashMenu}>
            {slashMatches.map((c) => (
              <button
                key={c.name}
                className={styles.slashItem}
                onClick={() => { setText(`/${c.name} `); setSlashOpen(false) }}
              >
                <code>/{c.name}</code>
                {c.input?.hint && <span className={styles.slashHint}>{c.input.hint}</span>}
                <span className={styles.dim}>{c.description}</span>
              </button>
            ))}
          </div>
        )}
        <div className={styles.composer}>
          <input
            className={styles.input}
            value={text}
            placeholder={s.commands.length ? `message ${agentId} — / for commands` : `message ${agentId}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !slashOpen) send()
              if (e.key === 'Escape') setSlashOpen(false)
              if (e.key === 'Tab' && slashOpen && slashMatches[0]) { e.preventDefault(); setText(`/${slashMatches[0].name} `); setSlashOpen(false) }
            }}
          />
          <button className={styles.btnPrimary} disabled={s.busy || !text.trim()} onClick={send}>
            <SendHorizonal size={13} />
          </button>
        </div>
      </div>
    </div>
  )
})

/** Agents primary tab — agent list left, live conversation right. Building/config
 *  lives in Settings › Agents; this surface is for talking to the fleet. */
export const AgentChatPanel: React.FC = observer(() => {
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    void hermesAgentsStore.refresh().then(() => {
      setActive((a) => a ?? hermesAgentsStore.agents[0] ?? null)
    })
  }, [])

  return (
    <div className={styles.panel}>
      <div className={styles.list}>
        <div className={styles.listHead}>Hermes agents</div>
        {hermesAgentsStore.agents.map((id) => (
          <button key={id} className={`${styles.listItem} ${active === id ? styles.listItemActive : ''}`} onClick={() => setActive(id)}>
            <Bot size={13} /> {hermesAgentsStore.specs.get(id)?.displayName ?? id}
          </button>
        ))}
        {hermesAgentsStore.loaded && hermesAgentsStore.agents.length === 0 && (
          <div className={styles.dim}>No agents yet.</div>
        )}
        <div className={styles.listFoot}>
          <Settings2 size={12} /> Build &amp; configure in Settings › Agents
        </div>
      </div>
      {active ? <AgentConversation key={active} agentId={active} /> : <div className={styles.emptyConv}>Pick an agent.</div>}
    </div>
  )
})
