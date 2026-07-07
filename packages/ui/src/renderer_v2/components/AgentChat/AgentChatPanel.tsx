import React, { useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, Camera, ChevronDown, ChevronRight, ListChecks, MessageSquare, Plus, ScanEye, SendHorizonal, Settings2, Square, Trash2, Wrench } from 'lucide-react'
import type { HermesSlashCommand } from '@gyshell/shared'
import { hermesAgentsStore } from '../../stores/HermesAgentsStore'
import { hermesChatStore as chat, type ChatItem } from '../../stores/HermesChatStore'
import { hermesConversationsStore, type ConvMeta } from '../../stores/hermesConversationsStore'
import styles from './AgentChat.module.scss'
import { newUuid } from '../../lib/uuid'

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
    case 'user':
      return (
        <div className={styles.msgYou}>
          {item.text}
          {item.ctxAttached && (
            <span
              className={styles.ctxChip}
              title={item.ctxAttached === 'vision' ? 'view context + screenshot sent to the agent' : 'view context sent to the agent'}
            >
              {item.ctxAttached === 'vision' ? <Camera size={10} /> : <ScanEye size={10} />}
              {item.ctxAttached === 'vision' ? 'screen' : 'view'}
            </span>
          )}
        </div>
      )
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
    case 'capture_consent':
      return (
        <div className={styles.sysRow}>
          <button
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => void chat.grantScreenShareAndCapture(item.capConvId ?? '', item.requestId ?? '')}
          >
            <Camera size={12} /> The agent {item.text} — share it
          </button>
        </div>
      )
    default: return <div className={styles.sysRow}>{item.text}</div>
  }
}

/**
 * Live conversation with one Hermes agent. Pure OBSERVER of the backend-owned
 * session: mounting attaches the SSE stream, unmounting only detaches — the
 * session (and any in-flight turn) keeps running headless on the backend.
 */
export const AgentConversation: React.FC<{ agentId: string; conversationId: string }> = observer(({ agentId, conversationId }) => {
  const s = chat.state(conversationId)
  const [text, setText] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    chat.attach(agentId, conversationId)
    // Observer-only detach — never stops the backend session (headless invariant);
    // END+WIPE happens only on explicit tab close (HermesChatStore.end).
    return () => chat.detach(conversationId)
  }, [agentId, conversationId])

  // Stick to the bottom on new content ONLY when the user is already there —
  // scrolling up to read must not get yanked back down by streaming chunks.
  const nearBottomRef = useRef(true)
  useEffect(() => {
    const el = logRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
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
    void chat.send(agentId, conversationId, t)
  }

  const spec = hermesAgentsStore.specs.get(agentId)
  const pct = s.usage ? Math.min(100, Math.round((s.usage.used / s.usage.size) * 100)) : null

  return (
    <div className={styles.conv}>
      <div className={styles.convHead}>
        <span className={`${styles.dot} ${s.connected ? styles.dotOn : ''}`} title={s.connected ? 'stream attached' : 'stream detached — reconnecting'} />
        <strong>{spec?.displayName ?? agentId}</strong>
        {s.currentModel && <span className={styles.dim}>{s.currentModel}</span>}
        {s.sessionId && (
          <span className={styles.dim} title={`backend session ${s.sessionId}`} style={{ fontSize: 10, opacity: 0.75 }}>
            #{s.sessionId.slice(0, 8)}
          </span>
        )}
        <span className={styles.spacer} />
        {pct !== null && s.usage && (
          <span className={styles.usage} title={`context: ${s.usage.used.toLocaleString()} / ${s.usage.size.toLocaleString()} tokens`}>
            <span className={styles.usageBar}><span className={styles.usageFill} style={{ width: `${pct}%` }} /></span>
            {pct}%
          </span>
        )}
      </div>

      <div
        ref={logRef}
        className={styles.log}
        onScroll={(e) => {
          const el = e.currentTarget
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
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
          {s.busy ? (
            <button className={styles.btnStop} title="Stop generating" onClick={() => chat.stop(agentId, conversationId)}>
              <Square size={11} fill="currentColor" /> Stop
            </button>
          ) : (
            <button className={styles.btnPrimary} disabled={!text.trim()} onClick={send}>
              <SendHorizonal size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

/** Full-page Hermes chat surface (ChatGPT-style), mounted as the "Chat" primary tab — the primary
 *  home for talking to agents. Left: a conversation sidebar (your conversations grouped by agent,
 *  from the shared hermesConversationsStore, so they follow you across devices AND stay in sync with
 *  the GlobalChat side panel — a delete here disappears there and vice-versa). Right: the selected
 *  AgentConversation. */
export const AgentChatPanel: React.FC = observer(() => {
  const [active, setActive] = useState<string>('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void hermesAgentsStore.refresh()
    void hermesConversationsStore.refresh().then(() => {
      setActive((a) => a || hermesConversationsStore.list[0]?.conversationId || '')
    })
  }, [])

  useEffect(() => {
    if (!pickerOpen) return
    const close = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [pickerOpen])

  const nameOf = (agentId: string) => hermesAgentsStore.specs.get(agentId)?.displayName ?? agentId

  const newChat = (agentId: string) => {
    setActive(hermesConversationsStore.newChat(agentId))
    setPickerOpen(false)
  }

  // Delete = shared store remove: drops it from THIS panel and the GlobalChat side panel (both
  // observe the store) and wipes the backend session (a conversation lives until you delete it).
  const deleteChat = (e: React.MouseEvent, c: ConvMeta) => {
    e.stopPropagation()
    void hermesConversationsStore.remove(c.conversationId, c.agentId)
    setActive((a) => (a === c.conversationId ? '' : a))
  }

  // Group the shared list by agent (inline, no memo — the observer re-renders on store changes).
  const groups = (() => {
    const m = new Map<string, ConvMeta[]>()
    for (const c of hermesConversationsStore.list) {
      if (!m.has(c.agentId)) m.set(c.agentId, [])
      m.get(c.agentId)!.push(c)
    }
    return [...m.entries()]
  })()

  const activeConv = hermesConversationsStore.list.find((c) => c.conversationId === active) ?? null

  return (
    <div className={styles.panel}>
      <div className={styles.list}>
        <div className={styles.listHead} ref={pickerRef} style={{ position: 'relative' }}>
          <button className={styles.btnPrimary} style={{ width: '100%', justifyContent: 'center' }} onClick={() => setPickerOpen((o) => !o)}>
            <Plus size={13} /> New chat
          </button>
          {pickerOpen && (
            <div className={styles.slashMenu} style={{ top: '100%', bottom: 'auto', left: 0, right: 0, maxHeight: 280, overflowY: 'auto' }}>
              {hermesAgentsStore.chattableAgents.length === 0 && <div className={styles.slashHint}>No agents — build one in Settings › Agents.</div>}
              {hermesAgentsStore.chattableAgents.map((id) => (
                <button key={id} className={styles.slashItem} onClick={() => newChat(id)}>
                  <Bot size={12} /> {nameOf(id)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {groups.map(([agentId, list]) => (
            <div key={agentId}>
              <div className={styles.dim} style={{ padding: '8px 10px 2px', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{nameOf(agentId)}</div>
              {list.map((c) => (
                <div
                  key={c.conversationId}
                  className={`${styles.listItem} ${active === c.conversationId ? styles.listItemActive : ''}`}
                  onClick={() => setActive(c.conversationId)}
                  role="button"
                  tabIndex={0}
                >
                  <MessageSquare size={12} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title || 'New conversation'}</span>
                  <span onClick={(e) => deleteChat(e, c)} title="Delete conversation" style={{ opacity: 0.55, cursor: 'pointer', display: 'inline-flex' }}><Trash2 size={12} /></span>
                </div>
              ))}
            </div>
          ))}
          {hermesConversationsStore.list.length === 0 && <div className={styles.dim} style={{ padding: 12 }}>No conversations yet — start a New chat.</div>}
        </div>
        <div className={styles.listFoot}>
          <Settings2 size={12} /> Manage agents in Settings › Agents
        </div>
      </div>
      {activeConv
        ? <AgentConversation key={activeConv.conversationId} agentId={activeConv.agentId} conversationId={activeConv.conversationId} />
        : <div className={styles.emptyConv}>Pick a conversation or start a New chat.</div>}
    </div>
  )
})
