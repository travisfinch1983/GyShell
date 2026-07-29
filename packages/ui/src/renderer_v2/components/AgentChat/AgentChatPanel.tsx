import React, { useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, Camera, ChevronDown, ChevronRight, ListChecks, MessageSquare, Mic, MicOff, Pencil, Plus, Radio, RefreshCw, ScanEye, SendHorizonal, Settings2, Square, Trash2, Volume2, VolumeX, Wrench } from 'lucide-react'
import { isTtsEnabled, setTtsEnabled, stopPlayback } from '../../services/TtsPlayback'
import {
  startPushToTalk, stopPushToTalk,
  startHandsFree, stopHandsFree,
  setOnTranscript, setOnAutoSend, setOnStateChange,
  type SttState,
} from '../../services/SttCapture'
import type { HermesSlashCommand } from '@gyshell/shared'
import { hermesAgentsStore } from '../../stores/HermesAgentsStore'
import { hermesApi } from '../../stores/hermesApi'
import { hermesChatStore as chat, type ChatItem } from '../../stores/HermesChatStore'
import { hermesConversationsStore, type ConvMeta } from '../../stores/hermesConversationsStore'
import styles from './AgentChat.module.scss'

/** Collapsible reasoning block. */
const ThoughtRow = observer(({ item }: { item: ChatItem }) => {
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
})

const ToolCard = observer(({ item }: { item: ChatItem }) => (
  <div className={styles.toolCard}>
    <Wrench size={12} />
    <span className={styles.toolTitle}>{item.title || 'tool'}</span>
    <span className={`${styles.toolStatus} ${item.status === 'completed' ? styles.toolDone : ''}`}>{item.status ?? '…'}</span>
  </div>
))

const PlanCard = observer(({ item }: { item: ChatItem }) => (
  <div className={styles.planCard}>
    <div className={styles.planHead}><ListChecks size={12} /> plan</div>
    {(item.plan ?? []).map((e, i) => (
      <div key={i} className={`${styles.planEntry} ${e.status === 'completed' ? styles.planDone : ''}`}>
        <span className={styles.planMark}>{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '›' : '·'}</span>
        {e.content}
      </div>
    ))}
  </div>
))

/**
 * Speak-replies toggle. Turning it OFF also stops whatever is currently playing —
 * otherwise the agent keeps talking after you have told it to be quiet, which is the
 * single most irritating way for this to behave.
 */
const TtsButton: React.FC<{ conversationId: string }> = observer(({ conversationId }) => {
  const mode = chat.chatTtsMode(conversationId)
  const [, bump] = React.useState(0)
  const effective = chat.ttsOnFor(conversationId)
  const overriding = mode !== undefined
  return (
    <button
      className={styles.btnStop}
      style={{
        background: 'transparent',
        borderColor: overriding ? 'var(--accent)' : 'var(--border)',
        color: effective ? 'var(--accent)' : 'var(--fg-muted)',
        position: 'relative',
        gap: 4,
      }}
      title={
        (effective ? 'Speaking replies aloud in THIS chat' : 'Muted in THIS chat')
        + (overriding
          ? ' (overriding the global setting — alt-click to follow global again)'
          : ' (following the global setting)')
      }
      onClick={(e) => {
        // Alt-click clears the override and returns to following global. Without an
        // escape hatch an override is permanent and there is no way to tell the button
        // "just do whatever global does".
        if (e.altKey) {
          chat.setChatTtsMode(conversationId, undefined)
          bump((n) => n + 1)
          return
        }
        const next = !effective
        chat.setChatTtsMode(conversationId, next ? 'on' : 'off')
        if (!next) stopPlayback()
        bump((n) => n + 1)
      }}
    >
      {effective ? <Volume2 size={13} /> : <VolumeX size={13} />}
      {/* LABEL IT. As a bare icon among two other icon buttons this control was invisible —
          it was looked for and reported missing. */}
      <span style={{ fontSize: 10 }}>{effective ? 'Speaking' : 'Muted'}</span>
      {overriding && (
        <span style={{ position: 'absolute', top: 1, right: 1, width: 4, height: 4, borderRadius: '50%', background: 'var(--accent)' }} />
      )}
    </button>
  )
})

/**
 * The two microphone controls, per Travis's spec.
 *
 *   MANUAL (Mic)   — press to record, press again to stop. The transcript is dropped
 *                    INTO THE COMPOSER; he presses Enter himself. Never auto-sends.
 *   CONSTANT (Radio) — toggle on and the mic stays open. SttCapture's VAD decides the
 *                    utterance ended on a pause, transcribes, and the text is sent
 *                    IMMEDIATELY without a manual step.
 *
 * Both are disabled with a reason when no STT provider is healthy — the only one lives
 * on px-epyc, which is down, and a mic button that silently records into nothing is
 * worse than one that is visibly unavailable.
 */
const SttButtons: React.FC<{ onTranscript: (t: string) => void; onAutoSend: (t: string) => void }> = ({ onTranscript, onAutoSend }) => {
  const [state, setState] = React.useState<SttState>('idle')
  const [stt, setStt] = React.useState<{ ok: boolean; why: string }>({ ok: false, why: 'checking for an STT provider…' })

  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/proxy/stt/v1/providers')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        const healthy = (d?.providers ?? []).filter((p: any) => p.status === 'healthy')
        if (!alive) return
        setStt(healthy.length
          ? { ok: true, why: '' }
          : { ok: false, why: (d?.providers?.length
              ? `STT provider is unhealthy (${d.providers.map((p: any) => `${p.providerId} on ${p.host}`).join(', ')}) — the host is likely down`
              : 'no STT provider is registered') })
      } catch (e: any) {
        if (alive) setStt({ ok: false, why: `could not reach the STT provider list: ${e?.message ?? e}` })
      }
    })()
    return () => { alive = false }
  }, [])

  React.useEffect(() => {
    setOnTranscript(onTranscript)
    setOnAutoSend(onAutoSend)
    setOnStateChange((s: SttState) => setState(s))
  }, [onTranscript, onAutoSend])

  const recording = state === 'recording'
  const transcribing = state === 'transcribing'
  const handsFree = state === 'handsfree' || state === 'handsfree-recording'
  const speaking = state === 'handsfree-recording'

  return (
    <>
      <button
        className={styles.btnStop}
        style={{ background: recording ? 'var(--danger, #b91c1c)' : 'transparent', borderColor: 'var(--border)' }}
        disabled={!stt.ok || transcribing || handsFree}
        title={!stt.ok ? `Speech-to-text unavailable — ${stt.why}`
          : transcribing ? 'Transcribing…'
          : recording ? 'Recording — click to stop and drop the text into the box'
          : 'Record; the transcript goes into the message box for you to send'}
        onClick={() => { if (recording) void stopPushToTalk(); else if (state === 'idle') void startPushToTalk() }}
      >
        {transcribing ? <Radio size={13} /> : recording ? <MicOff size={13} /> : <Mic size={13} />}
      </button>
      <button
        className={styles.btnStop}
        style={{ background: speaking ? 'var(--accent)' : 'transparent', borderColor: handsFree ? 'var(--accent)' : 'var(--border)' }}
        disabled={!stt.ok || recording || transcribing}
        title={!stt.ok ? `Speech-to-text unavailable — ${stt.why}`
          : handsFree ? 'Always-listening ON — transcripts send themselves. Click to stop.'
          : 'Always listen: sends each utterance automatically after a pause'}
        onClick={() => { if (handsFree) stopHandsFree(); else void startHandsFree() }}
      >
        <Radio size={13} />
      </button>
    </>
  )
}

/**
 * Replay one agent message through TTS on demand, in that agent's configured voice.
 * Independent of the Auto-TTS toggle by design.
 */
const SpeakMessageButton: React.FC<{ agentId: string; text: string }> = ({ agentId, text }) => {
  const [state, setState] = React.useState<'idle' | 'busy' | 'error'>('idle')
  if (!text.trim()) return null
  return (
    <button
      title={state === 'error' ? 'Speech failed — click to retry' : 'Read this message aloud'}
      onClick={async () => {
        setState('busy')
        try {
          await chat.speakMessage(agentId, text)
          setState('idle')
        } catch (e) {
          // Surface it. A silent no-op here is indistinguishable from a dead TTS pool.
          console.warn('[chat] speakMessage failed:', e)
          setState('error')
        }
      }}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 2,
        cursor: 'pointer',
        color: state === 'error' ? 'var(--danger, #f87171)' : 'var(--fg-faint)',
        opacity: state === 'busy' ? 1 : 0.6,
      }}
    >
      <Volume2 size={12} />
    </button>
  )
}

const Row = observer(({ item, agentId }: { item: ChatItem; agentId: string }) => {
  switch (item.kind) {
    case 'user':
      return (
        <div className={styles.msgYou} style={item.queued || item.steering ? { opacity: 0.55 } : undefined}>
          {item.text}
          {item.steering && (
            <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.85 }} title="Steering — delivered to the agent at its next tool call, without waiting for the turn to end">
              ⏩ steering
            </span>
          )}
          {item.queued && (
            <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.85 }} title="Queued — sends automatically when the current turn finishes">
              ⏳ queued
            </span>
          )}
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
          {/* Only once the bubble is complete — replaying a half-arrived reply would speak
              a truncated sentence. */}
          {!item.streaming && <SpeakMessageButton agentId={agentId} text={item.text} />}
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
})

/** Null-rendering auto-scroll anchor. Reads the last item's text length REACTIVELY here (inside its
 *  own observer) so streaming keeps the log pinned to the bottom WITHOUT forcing the whole
 *  conversation to re-render on every token — the killer of chat performance on long transcripts. */
const ScrollAnchor = observer(({ items, logRef, nearBottomRef }: {
  items: ChatItem[]
  logRef: React.RefObject<HTMLDivElement | null>
  nearBottomRef: React.MutableRefObject<boolean>
}) => {
  const n = items.length
  const tailLen = items[items.length - 1]?.text.length ?? 0
  useEffect(() => {
    const el = logRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [n, tailLen, logRef, nearBottomRef])
  return null
})

/**
 * Live conversation with one Hermes agent. Pure OBSERVER of the backend-owned
 * session: mounting attaches the SSE stream, unmounting only detaches — the
 * session (and any in-flight turn) keeps running headless on the backend.
 */
export const AgentConversation: React.FC<{ agentId: string; conversationId: string }> = observer(({ agentId, conversationId }) => {
  const s = chat.state(conversationId)
  // Unsent draft is saved PER CONVERSATION (keyed by conversationId) so a page reload never wipes
  // what you were typing, and each chat keeps its own in-progress message.
  const draftKey = `ai-lab-draft-${conversationId}`
  const [text, setText] = useState<string>(() => { try { return localStorage.getItem(draftKey) ?? '' } catch { return '' } })
  const [slashOpen, setSlashOpen] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)
  // Per-conversation model swap (backend 2ce0aa1): raw catalog ids verbatim.
  const [modelIds, setModelIds] = useState<string[]>([])
  const [swapping, setSwapping] = useState(false)
  const [swapMsg, setSwapMsg] = useState('')
  useEffect(() => { void hermesApi.listRawModelIds().then(setModelIds) }, [])

  const swapModel = async (modelId: string) => {
    if (!modelId || modelId === s.currentModel) return
    setSwapping(true)
    setSwapMsg('')
    const r = await hermesApi.setConversationModel(agentId, conversationId, modelId)
    setSwapping(false)
    if (r.ok) {
      chat.setCurrentModel(conversationId, modelId)
      setSwapMsg('model swapped ✓')
      setTimeout(() => setSwapMsg(''), 4000)
    } else {
      setSwapMsg(/no live acp session/i.test(r.error ?? '')
        ? 'session not live yet — send a message first, then swap'
        : `swap failed — ${r.error ?? 'unknown'}`)
    }
  }

  useEffect(() => {
    chat.attach(agentId, conversationId)
    // Observer-only detach — never stops the backend session (headless invariant);
    // END+WIPE happens only on explicit tab close (HermesChatStore.end).
    return () => chat.detach(conversationId)
  }, [agentId, conversationId])

  // Stick to the bottom on new content ONLY when the user is already there —
  // scrolling up to read must not get yanked back down by streaming chunks.
  const nearBottomRef = useRef(true)
  // (auto-scroll moved into <ScrollAnchor/> so a streamed token no longer re-renders the parent)

  const slashMatches = useMemo<HermesSlashCommand[]>(() => {
    if (!text.startsWith('/')) return []
    const q = text.slice(1).toLowerCase()
    return s.commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8)
  }, [text, s.commands])

  useEffect(() => setSlashOpen(slashMatches.length > 0 && text.startsWith('/') && !text.includes(' ')), [slashMatches, text])

  // Tail edit/regenerate/delete (native Hermes rewind). Acts on the last turn; deleting exposes
  // the one before it. Edit reuses the composer — Send replaces the last user message + re-runs.
  const [editing, setEditing] = useState(false)
  const [rwPending, setRwPending] = useState<string | null>(null)
  const [rwMsg, setRwMsg] = useState('')
  const lastUserText = useMemo(() => {
    for (let i = s.items.length - 1; i >= 0; i--) if (s.items[i].kind === 'user') return s.items[i].text
    return ''
  }, [s.items])
  // Scope: only offer rewind on a CLEAN tail — a plain question->answer turn (no tool calls after
  // the last user message). Tool-heavy turns span many messages and don't map to 'the last message'.
  const tailClean = useMemo(() => {
    let lastUser = -1
    for (let i = s.items.length - 1; i >= 0; i--) if (s.items[i].kind === 'user') { lastUser = i; break }
    if (lastUser === -1) return false
    const after = s.items.slice(lastUser + 1)
    return !after.some((i) => i.kind === 'tool' || i.kind === 'plan')
  }, [s.items])
  const canAct = !s.busy && !rwPending && tailClean
  const doRewind = async (mode: 'edit' | 'regenerate' | 'delete') => {
    if (rwPending) return
    setRwPending(mode); setRwMsg('')
    try {
      await chat.rewindTail(agentId, conversationId, mode, mode === 'edit' ? text : undefined)
      if (mode === 'edit') { setEditing(false); setText('') }
    } catch (e) { setRwMsg(e instanceof Error ? e.message : String(e)) }
    finally { setRwPending(null) }
  }
  const startEdit = () => { setRwMsg(''); setEditing(true); setText(lastUserText); setTimeout(() => taRef.current?.focus(), 0) }
  const cancelEdit = () => { setEditing(false); setText('') }
  // Auto-grow the composer textarea with its content (up to a cap, then it scrolls).
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])
  // Save/clear the per-conversation draft as it changes.
  useEffect(() => {
    try { if (text) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey) } catch { /* private mode */ }
  }, [text, draftKey])

  const send = () => {
    setSlashOpen(false)
    if (editing) { void doRewind('edit'); return }
    const t = text
    setText('')
    void chat.send(agentId, conversationId, t)
  }

  const spec = hermesAgentsStore.specs.get(agentId)
  // size can be 0 before the backend knows the model's window — treat as "no meter"
  const pct = s.usage && s.usage.size > 0 ? Math.min(100, Math.round((s.usage.used / s.usage.size) * 100)) : null
  const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n))

  return (
    <div className={styles.conv}>
      <div className={styles.convHead}>
        <span className={`${styles.dot} ${s.connected ? styles.dotOn : ''}`} title={s.connected ? 'stream attached' : 'stream detached — reconnecting'} />
        <strong>{spec?.displayName ?? agentId}</strong>
        <select
          className={styles.modelSwap}
          value={s.currentModel ?? ''}
          disabled={swapping || modelIds.length === 0}
          title="Swap this conversation's model (live session only — takes effect next turn)"
          onChange={(e) => void swapModel(e.target.value)}
        >
          {!s.currentModel && <option value="">{modelIds.length ? 'model…' : 'loading models…'}</option>}
          {/* keep an off-catalog current model selectable rather than snapping elsewhere */}
          {s.currentModel && !modelIds.includes(s.currentModel) && <option value={s.currentModel}>{s.currentModel}</option>}
          {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        {swapMsg && <span className={styles.dim} style={{ fontSize: 10 }}>{swapMsg}</span>}
        {s.sessionId && (
          <span className={styles.dim} title={`backend session ${s.sessionId}`} style={{ fontSize: 10, opacity: 0.75 }}>
            #{s.sessionId.slice(0, 8)}
          </span>
        )}
        <span className={styles.spacer} />
        {pct !== null && s.usage && (
          <span className={styles.usage} title={`context: ${s.usage.used.toLocaleString()} / ${s.usage.size.toLocaleString()} tokens`}>
            <span className={styles.usageBar}><span className={styles.usageFill} style={{ width: `${pct}%` }} /></span>
            {fmtK(s.usage.used)} / {fmtK(s.usage.size)} · {pct}%
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
        {s.items.map((i) => <Row key={i.id} item={i} agentId={agentId} />)}
        <ScrollAnchor items={s.items} logRef={logRef} nearBottomRef={nearBottomRef} />
        {s.busy && <div className={styles.sysRow}>thinking…</div>}
      </div>

      {(canAct || editing) && (
        <div className={styles.msgActions}>
          {editing ? (
            <>
              <span className={styles.dim} style={{ fontSize: 11 }}>Editing your last message — Send to replace &amp; re-run.</span>
              <button className={styles.msgActBtn} onClick={cancelEdit} disabled={!!rwPending}>Cancel</button>
            </>
          ) : (
            <>
              <button className={styles.msgActBtn} onClick={startEdit} disabled={!!rwPending} title="Edit your last message and re-run"><Pencil size={12} /> Edit</button>
              <button className={styles.msgActBtn} onClick={() => void doRewind('regenerate')} disabled={!!rwPending} title="Discard the last reply and generate a new one"><RefreshCw size={12} /> {rwPending === 'regenerate' ? 'working…' : 'Regenerate'}</button>
              <button className={styles.msgActBtn} onClick={() => void doRewind('delete')} disabled={!!rwPending} title="Delete the last turn — the one before it becomes editable"><Trash2 size={12} /> {rwPending === 'delete' ? 'working…' : 'Delete'}</button>
            </>
          )}
          {rwMsg && <span className={styles.msgActErr}>{rwMsg}</span>}
        </div>
      )}
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
          <textarea
            ref={taRef}
            className={styles.input}
            rows={1}
            value={text}
            placeholder={s.commands.length ? `message ${agentId} — / for commands (Shift+Enter = newline)` : `message ${agentId}… (Shift+Enter = newline)`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (slashOpen && slashMatches[0]) { e.preventDefault(); setText(`/${slashMatches[0].name} `); setSlashOpen(false); return }
                e.preventDefault(); send(); return
              }
              if (e.key === 'Escape') setSlashOpen(false)
              if (e.key === 'Tab' && slashOpen && slashMatches[0]) { e.preventDefault(); setText(`/${slashMatches[0].name} `); setSlashOpen(false) }
            }}
          />
          <TtsButton conversationId={conversationId} />
          <SttButtons
            onTranscript={(t) => setText((cur) => (cur ? `${cur} ${t}` : t))}
            onAutoSend={(t) => { const v = t.trim(); if (v) void chat.send(agentId, conversationId, v) }}
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
