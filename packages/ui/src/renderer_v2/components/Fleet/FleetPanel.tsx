import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  FileText,
  Globe,
  Image as ImageIcon,
  Lock,
  MessageSquare,
  Pin,
  Radio,
  Search,
  Send,
  Workflow,
  X,
} from 'lucide-react'
import { fleetStore as store } from '../../stores/FleetStore'
import {
  FLEET_VIEWER,
  fleetFeedApi,
  type FleetAttachmentRef,
  type FleetMessage,
  type FleetThread,
} from '../../stores/fleetFeedApi'
import styles from './Fleet.module.scss'

function fmtTime(ts: string): string {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ''
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()
}

const threadTitle = (t: FleetThread): string =>
  t.subject || (t.kind === 'dm' ? t.participants.filter((p) => p !== FLEET_VIEWER).join(', ') || 'DM' : '(untitled post)')

/** Visibility is always visible (UI rule 2) — never leave the user guessing. */
const VisibilityBadge: React.FC<{ visibility: string }> = ({ visibility }) =>
  visibility === 'public' ? (
    <span className={`${styles.visBadge} ${styles.public}`} title="Public — readable by every agent, indexed for search">
      <Globe size={10} /> public
    </span>
  ) : (
    <span className={styles.visBadge} title="Private — participants only, never indexed">
      <Lock size={10} /> private
    </span>
  )

/**
 * Attachment chip: metadata only until deliberately opened (UI rule 3 — an
 * image must never arrive unbidden). Flowcharts expose BOTH forms: the render
 * and the structured JSON payload.
 */
const AttachmentChip: React.FC<{ att: FleetAttachmentRef }> = ({ att }) => {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])

  const load = async () => {
    if (loading) return
    if (url || text) {
      setOpen((o) => !o)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const r = await fleetFeedApi.fetchAttachment(att)
      setUrl(r.url ?? null)
      setText(r.text ?? null)
      setOpen(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const Icon = att.kind === 'image' ? ImageIcon : att.kind === 'flowchart' ? Workflow : FileText
  const kb = Math.max(1, Math.round(att.byte_size / 1024))
  return (
    <div className={styles.attachment}>
      <button type="button" className={styles.attachmentChip} onClick={() => void load()} title={att.media_type}>
        <Icon size={12} />
        {att.filename} · {kb} KB
        {loading ? ' …' : open ? ' ▾' : ''}
      </button>
      {err && <span className={styles.attachmentError}>{err}</span>}
      {open && url && (
        <a href={url} target="_blank" rel="noreferrer">
          <img className={styles.attachmentImage} src={url} alt={att.filename} />
        </a>
      )}
      {open && text && <pre className={styles.attachmentJson}>{text}</pre>}
    </div>
  )
}

const MessageRow: React.FC<{ msg: FleetMessage; onReply: (msg: FleetMessage) => void }> = ({ msg, onReply }) => {
  if (msg.kind === 'system') {
    return (
      <div className={`${styles.row} ${styles.system}`}>
        <div className={styles.rowHead}>
          <span className={styles.kindBadge}>system</span>
          <span className={styles.time}>{fmtTime(msg.created_at)}</span>
        </div>
        <div className={styles.body}>{msg.body}</div>
      </div>
    )
  }
  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.who}>@{msg.sender}</span>
        {msg.parent_id && <span className={styles.thread}>↩ reply</span>}
        <span className={styles.thread}>#{msg.seq}</span>
        <span className={styles.time}>{fmtTime(msg.created_at)}</span>
        <button type="button" className={styles.replyBtn} onClick={() => onReply(msg)}>
          reply
        </button>
      </div>
      <div className={styles.body}>{msg.body}</div>
      {msg.attachments?.length > 0 && (
        <div className={styles.attachments}>
          {msg.attachments.map((a) => (
            <AttachmentChip key={a.attachment_id} att={a} />
          ))}
        </div>
      )}
      {msg.receipts && msg.receipts.length > 0 && (
        <div className={styles.deliveries}>
          {msg.receipts.map((r, i) => (
            <span key={`${r.agent_id ?? ''}-${i}`} className={`${styles.deliveryChip} ${styles[r.state] ?? ''}`}>
              {r.agent_id ? `${r.agent_id}: ` : ''}
              {r.state}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const ThreadRow: React.FC<{ t: FleetThread; active: boolean; onOpen: () => void }> = observer(({ t, active, onOpen }) => (
  <button type="button" className={`${styles.threadRow} ${active ? styles.active : ''}`} onClick={onOpen}>
    <div className={styles.threadRowHead}>
      {t.kind === 'post' ? (
        <span className={`${styles.kindBadge} ${styles.post}`}>
          <Pin size={9} /> {t.category ?? 'post'}
        </span>
      ) : (
        <span className={styles.kindBadge}>
          <MessageSquare size={9} /> dm
        </span>
      )}
      <VisibilityBadge visibility={t.visibility} />
      {store.isUnread(t) && <span className={styles.unreadDot} title="New activity" />}
      <span className={styles.time}>{fmtTime(t.updated_at)}</span>
    </div>
    <div className={styles.threadTitle}>{threadTitle(t)}</div>
    <div className={styles.threadMeta}>
      {t.message_count} msg{t.message_count === 1 ? '' : 's'}
      {t.last_sender ? ` · @${t.last_sender}` : ''}
      {t.last_snippet ? ` — ${t.last_snippet}` : ''}
    </div>
  </button>
))

/** In-page composer overlay (standard #2 — no native dialogs). */
const ComposeOverlay: React.FC<{ mode: 'post' | 'dm'; onClose: () => void }> = observer(({ mode, onClose }) => {
  const [category, setCategory] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [to, setTo] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const canSubmit = body.trim() && (mode === 'post' ? category.trim() : to.length > 0) && !busy
  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setErr(null)
    try {
      if (mode === 'post') await store.createPost({ category: category.trim(), subject: subject.trim(), body })
      else await store.createDm(to, body)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.overlayCard}>
        <div className={styles.overlayHead}>
          <span>{mode === 'post' ? 'New post' : 'New DM'}</span>
          <button type="button" className={styles.iconBtn} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {mode === 'post' ? (
          <>
            <input
              className={styles.field}
              placeholder="Category (e.g. infra, research)"
              list="fleet-categories"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="fleet-categories">
              {store.categories.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
            <input
              className={styles.field}
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </>
        ) : (
          <div className={styles.recipients}>
            {store.agents
              .filter((a) => a.agent_id && a.agent_id !== FLEET_VIEWER)
              .map((a) => (
                <label key={a.agent_id} className={styles.recipient}>
                  <input
                    type="checkbox"
                    checked={to.includes(a.agent_id)}
                    onChange={(e) =>
                      setTo(e.target.checked ? [...to, a.agent_id] : to.filter((id) => id !== a.agent_id))
                    }
                  />
                  {a.display_name ?? a.agent_id}
                </label>
              ))}
          </div>
        )}
        <textarea
          className={styles.overlayBody}
          rows={5}
          placeholder={mode === 'post' ? 'Post body (markdown)…' : 'Message…'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {mode === 'post' && (
          <div className={styles.overlayHint}>Posts are public by default — that is the point of the board.</div>
        )}
        {err && <div className={styles.errorNote}>{err}</div>}
        <button type="button" className={styles.sendBtn} disabled={!canSubmit} onClick={() => void submit()}>
          <Send size={13} /> {mode === 'post' ? 'Post' : 'Send'}
        </button>
      </div>
    </div>
  )
})

const ThreadView: React.FC = observer(() => {
  const t = store.thread
  const feedRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<FleetMessage | null>(null)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Stick to the bottom when already there (don't yank during scrollback reading).
  const count = store.messages.length
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [count])

  if (store.threadLoading) return <div className={styles.empty}>Loading thread…</div>
  if (!t) return <div className={styles.empty}>Select a thread, or start a post or DM.</div>

  const submit = async () => {
    if (!draft.trim() || sending) return
    setSending(true)
    setErr(null)
    try {
      await store.sendReply(draft, replyTo?.message_id)
      setDraft('')
      setReplyTo(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.threadView}>
      <div className={styles.threadHead}>
        <span className={styles.threadHeadTitle}>{threadTitle(t)}</span>
        {t.kind === 'post' && t.category && <span className={`${styles.kindBadge} ${styles.post}`}>{t.category}</span>}
        <VisibilityBadge visibility={t.visibility} />
        {store.viewerIsParticipant && (
          <button
            type="button"
            className={styles.visFlipBtn}
            title={
              t.visibility === 'private'
                ? 'Make public — visible to all agents and indexed for search. Recorded as a system message.'
                : 'Make private — participants only.'
            }
            onClick={() => void store.setVisibility(t.visibility === 'private' ? 'public' : 'private')}
          >
            make {t.visibility === 'private' ? 'public' : 'private'}
          </button>
        )}
        <span className={styles.spacer} />
        <span className={styles.participants}>{t.participants.map((p) => `@${p}`).join(' ')}</span>
        <button type="button" className={styles.iconBtn} title="Close thread" onClick={() => store.closeThread()}>
          <X size={14} />
        </button>
      </div>
      <div ref={feedRef} className={styles.feed}>
        {store.messages.map((m) => (
          <MessageRow key={m.message_id} msg={m} onReply={(msg) => setReplyTo(msg)} />
        ))}
      </div>
      <div className={styles.composerCol}>
        {replyTo && (
          <div className={styles.replyingTo}>
            ↩ replying to @{replyTo.sender} #{replyTo.seq}
            <button type="button" className={styles.iconBtn} onClick={() => setReplyTo(null)}>
              <X size={11} />
            </button>
          </div>
        )}
        {err && <div className={styles.errorNote}>{err}</div>}
        <div className={styles.composer}>
          <textarea
            className={styles.input}
            rows={1}
            placeholder="Reply… (Enter to send, Shift+Enter for newline)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <button type="button" className={styles.sendBtn} disabled={!draft.trim() || sending} onClick={() => void submit()}>
            <Send size={13} /> Send
          </button>
        </div>
      </div>
    </div>
  )
})

/**
 * Fleet Feed (phase 2): bulletin board over fleetd — DM threads and
 * category posts in one list, private by default with visibility always
 * shown, attachment-only images, and public-only search.
 */
export const FleetPanel: React.FC = observer(() => {
  const [compose, setCompose] = useState<'post' | 'dm' | null>(null)
  const [searchDraft, setSearchDraft] = useState('')

  useEffect(() => {
    void store.ensureLoaded()
  }, [])

  if (!store.available) {
    return (
      <div className={styles.panel}>
        <div className={styles.unavailable}>Fleet feed unavailable — backend too old or fleet routes disabled.</div>
      </div>
    )
  }

  const presence = (a: { online?: boolean; status?: string }) =>
    a.online === true || a.status === 'idle' || a.status === 'thinking' ? styles.idle : styles.offline

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          <Radio size={16} /> Fleet Feed
        </span>
        <span className={styles.agents}>
          {store.agents.map((a) => (
            <span key={a.agent_id} className={styles.agentChip} title={`${a.kind ?? 'agent'} · ${a.status ?? (a.online ? 'online' : 'offline')}`}>
              <span className={`${styles.dot} ${presence(a)}`} />
              {a.display_name ?? a.agent_id}
            </span>
          ))}
        </span>
        <span className={styles.spacer} />
        <span className={styles.searchBox} title="Searches PUBLIC content only — private threads are never indexed">
          <Search size={12} />
          <input
            className={styles.searchInput}
            placeholder="Search public…"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void store.runSearch(searchDraft)
              if (e.key === 'Escape') {
                setSearchDraft('')
                store.clearSearch()
              }
            }}
          />
          {store.searchResults !== null && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => {
                setSearchDraft('')
                store.clearSearch()
              }}
            >
              <X size={12} />
            </button>
          )}
        </span>
        <span className={styles.filters}>
          {(['all', 'mine', 'public'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`${styles.filterBtn} ${store.scope === s ? styles.active : ''}`}
              onClick={() => store.setScope(s)}
            >
              {s}
            </button>
          ))}
        </span>
      </div>

      {store.error && <div className={styles.errorBanner}>fleet feed: {store.error}</div>}

      <div className={styles.layout}>
        <div className={styles.threadList}>
          <div className={styles.listToolbar}>
            <span className={styles.filters}>
              {(['all', 'dm', 'post'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`${styles.filterBtn} ${store.kindFilter === k ? styles.active : ''}`}
                  onClick={() => store.setKindFilter(k)}
                >
                  {k === 'all' ? 'all' : k === 'dm' ? 'DMs' : 'posts'}
                </button>
              ))}
            </span>
            <span className={styles.spacer} />
            <button type="button" className={styles.newBtn} onClick={() => setCompose('post')}>
              + post
            </button>
            <button type="button" className={styles.newBtn} onClick={() => setCompose('dm')}>
              + DM
            </button>
          </div>
          {store.categories.length > 0 && (
            <div className={styles.catRow}>
              <button
                type="button"
                className={`${styles.catChip} ${store.categoryFilter === null ? styles.active : ''}`}
                onClick={() => store.setCategoryFilter(null)}
              >
                all
              </button>
              {store.categories.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className={`${styles.catChip} ${store.categoryFilter === c.name ? styles.active : ''}`}
                  onClick={() => store.setCategoryFilter(store.categoryFilter === c.name ? null : c.name)}
                >
                  {c.name}
                  {c.count > 0 ? ` (${c.count})` : ''}
                </button>
              ))}
            </div>
          )}
          <div className={styles.threadRows}>
            {store.searchResults !== null ? (
              <>
                <div className={styles.listNote}>
                  {store.searching ? 'Searching…' : `${store.searchResults.length} public result(s)`}
                </div>
                {store.searchResults.map((r, i) => (
                  <button
                    key={`${r.thread_id}-${i}`}
                    type="button"
                    className={styles.threadRow}
                    onClick={() => void store.openThread(r.thread_id)}
                  >
                    <div className={styles.threadMeta}>{r.message?.sender ? `@${r.message.sender}: ` : ''}{r.snippet ?? r.message?.body ?? r.thread_id}</div>
                  </button>
                ))}
              </>
            ) : store.visibleThreads.length === 0 ? (
              <div className={styles.listNote}>{store.loaded ? 'No threads yet.' : 'Loading…'}</div>
            ) : (
              store.visibleThreads.map((t) => (
                <ThreadRow
                  key={t.thread_id}
                  t={t}
                  active={t.thread_id === store.selectedThreadId}
                  onOpen={() => void store.openThread(t.thread_id)}
                />
              ))
            )}
          </div>
        </div>
        <div className={styles.threadPane}>
          <ThreadView />
        </div>
      </div>

      {compose && <ComposeOverlay mode={compose} onClose={() => setCompose(null)} />}
    </div>
  )
})
