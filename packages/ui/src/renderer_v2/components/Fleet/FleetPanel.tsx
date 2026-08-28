import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Image as ImageIcon,
  Lock,
  MessageSquare,
  Paperclip,
  Pin,
  Radio,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Workflow,
  X,
} from 'lucide-react'
import { fleetStore as store, type FeedThreadGroup } from '../../stores/FleetStore'
import {
  feedSecondsToDate,
  fileToAttachment,
  fleetFeedApi,
  FLEET_VIEWER,
  type FeedAttachmentInput,
  type FeedAttachmentRef,
  type FeedMessage,
  type FeedThread,
} from '../../stores/fleetFeedApi'
import styles from './Fleet.module.scss'

function fmtTime(ts: number): string {
  const d = feedSecondsToDate(ts)
  if (!Number.isFinite(d.getTime())) return ''
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()
}

const threadTitle = (t: FeedThread): string =>
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
 * image must never arrive unbidden). Flowcharts expose BOTH forms: the
 * rendered bytes and the structured graph JSON (`/structured`).
 */
const AttachmentChip: React.FC<{ att: FeedAttachmentRef }> = ({ att }) => {
  const [open, setOpen] = useState<'none' | 'bytes' | 'data'>('none')
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [data, setData] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])

  const loadBytes = async () => {
    if (loading) return
    if (url || text) {
      setOpen((o) => (o === 'bytes' ? 'none' : 'bytes'))
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const r = await fleetFeedApi.fetchAttachment(att)
      setUrl(r.url ?? null)
      setText(r.text ?? null)
      setOpen('bytes')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const loadData = async () => {
    if (loading) return
    if (data) {
      setOpen((o) => (o === 'data' ? 'none' : 'data'))
      return
    }
    setLoading(true)
    setErr(null)
    try {
      setData(await fleetFeedApi.fetchStructured(att))
      setOpen('data')
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
      <span className={styles.attachmentActions}>
        <button type="button" className={styles.attachmentChip} onClick={() => void loadBytes()} title={att.media_type}>
          <Icon size={12} />
          {att.filename ?? att.attachment_id} · {kb} KB
          {loading ? ' …' : open === 'bytes' ? ' ▾' : ''}
        </button>
        {att.kind === 'flowchart' && (
          <button type="button" className={styles.attachmentChip} onClick={() => void loadData()} title="Structured graph JSON — the machine-readable payload">
            data{open === 'data' ? ' ▾' : ''}
          </button>
        )}
      </span>
      {err && <span className={styles.attachmentError}>{err}</span>}
      {open === 'bytes' && url && (
        <a href={url} target="_blank" rel="noreferrer">
          <img className={styles.attachmentImage} src={url} alt={att.filename ?? ''} />
        </a>
      )}
      {open === 'bytes' && text && <pre className={styles.attachmentJson}>{text}</pre>}
      {open === 'data' && data && <pre className={styles.attachmentJson}>{data}</pre>}
    </div>
  )
}

const RECEIPT_TITLES: Record<string, string> = {
  queued: 'accepted; recipient not yet reached',
  delivered: 'handed to the recipient transport',
  woke: 'recipient ran inference after delivery — the message reached a model',
  acked: 'recipient explicitly acknowledged',
}

/** failed is not one fault: "wedged mid-turn" ≠ "never landed" — name the stage. */
function receiptTitle(r: { state: string; failure_stage: string | null; failure_detail: string | null }): string {
  if (r.state !== 'failed') return RECEIPT_TITLES[r.state] ?? r.state
  if (r.failure_stage === 'wake_stalled')
    return `recipient woke but is wedged mid-turn (${r.failure_detail ?? 'no detail'}) — delivery happened; the turn never finished`
  return `${r.failure_stage ?? 'unknown stage'}: ${r.failure_detail ?? ''}`
}

const MessageRow: React.FC<{ msg: FeedMessage; onReply: (msg: FeedMessage) => void }> = ({ msg, onReply }) => {
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
          {msg.receipts.map((r) => (
            <span
              key={r.recipient}
              className={`${styles.deliveryChip} ${styles[r.state] ?? ''} ${r.failure_stage === 'wake_stalled' ? styles.stalled : ''}`}
              title={receiptTitle(r)}
            >
              {r.recipient}: {r.failure_stage === 'wake_stalled' ? 'stalled' : r.state}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const ThreadRow: React.FC<{ t: FeedThread; active: boolean; nested?: boolean; onOpen: () => void }> = observer(
  ({ t, active, nested, onOpen }) => {
    const unread = store.unreadOf(t)
    return (
      <button
        type="button"
        className={`${styles.threadRow} ${active ? styles.active : ''} ${nested ? styles.nested : ''}`}
        onClick={onOpen}
      >
        <div className={styles.threadRowHead}>
          {!nested &&
            (t.kind === 'post' ? (
              <span className={`${styles.kindBadge} ${styles.post}`}>
                <Pin size={9} /> {t.category ?? 'post'}
              </span>
            ) : (
              <span className={styles.kindBadge}>
                <MessageSquare size={9} /> dm
              </span>
            ))}
          <VisibilityBadge visibility={t.visibility} />
          {unread > 0 && (
            <span className={styles.unreadDot} title={`${unread} unread`}>
              {unread > 9 ? '9+' : unread}
            </span>
          )}
          <span className={styles.time}>{fmtTime(t.updated_at)}</span>
        </div>
        <div className={styles.threadTitle}>
          {nested ? t.subject || t.last_snippet || '(conversation)' : threadTitle(t)}
        </div>
        <div className={styles.threadMeta}>
          {t.message_count} msg{t.message_count === 1 ? '' : 's'}
          {t.last_sender ? ` · @${t.last_sender}` : ''}
          {!nested && t.last_snippet ? ` — ${t.last_snippet}` : ''}
        </div>
      </button>
    )
  },
)

/**
 * One sidebar entry per participant set (Travis's grouping ask). EVERY group
 * renders its pair card — even with one conversation — because the pair
 * identity is the primary information in a fleet feed; a bare thread row
 * forces opening the conversation just to learn who it's between. All groups
 * default collapsed and the user's expand/collapse choices persist (store) —
 * a stable sidebar that never re-opens what he closed beats saving a click.
 */
const GroupRow: React.FC<{
  group: FeedThreadGroup
  expanded: boolean
  onToggle: () => void
}> = observer(({ group, expanded, onToggle }) => {
  const names = group.participants.map((p) => (p === FLEET_VIEWER ? 'you' : store.displayName(p)))
  const label = names.join(names.length > 2 ? ' + ' : ' ↔ ')
  return (
    <>
      <button type="button" className={`${styles.threadRow} ${styles.groupHead}`} onClick={onToggle}>
        <div className={styles.threadRowHead}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className={styles.kindBadge}>
            {group.threads.length} thread{group.threads.length === 1 ? '' : 's'}
          </span>
          {group.unread > 0 && (
            <span className={styles.unreadDot} title={`${group.unread} unread`}>
              {group.unread > 9 ? '9+' : group.unread}
            </span>
          )}
          <span className={styles.time}>{fmtTime(group.latest.updated_at)}</span>
        </div>
        <div className={styles.threadTitle}>{label}</div>
        <div className={styles.threadMeta}>
          {group.latest.last_sender ? `@${group.latest.last_sender}` : ''}
          {group.latest.last_snippet ? ` — ${group.latest.last_snippet}` : ''}
        </div>
      </button>
      {expanded && (
        <div className={styles.nestedRows}>
          {group.threads.map((t) => (
            <ThreadRow
              key={t.thread_id}
              t={t}
              nested
              active={t.thread_id === store.selectedThreadId}
              onOpen={() => void store.openThread(t.thread_id)}
            />
          ))}
        </div>
      )}
    </>
  )
})

/** Attach-file picker shared by the composers (base64 inline — rides WITH the send). */
const AttachPicker: React.FC<{
  attachments: FeedAttachmentInput[]
  onChange: (a: FeedAttachmentInput[]) => void
  onError: (msg: string) => void
}> = ({ attachments, onChange, onError }) => {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <span className={styles.attachPicker}>
      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          try {
            const converted = await Promise.all(files.map(fileToAttachment))
            onChange([...attachments, ...converted])
          } catch (err) {
            onError(err instanceof Error ? err.message : String(err))
          }
        }}
      />
      <button type="button" className={styles.iconBtn} title="Attach files" onClick={() => fileRef.current?.click()}>
        <Paperclip size={14} />
      </button>
      {attachments.map((a, i) => (
        <span key={`${a.filename}-${i}`} className={styles.attachmentChip}>
          {a.filename}
          <button type="button" className={styles.iconBtn} onClick={() => onChange(attachments.filter((_, j) => j !== i))}>
            <X size={10} />
          </button>
        </span>
      ))}
    </span>
  )
}

/** In-page composer overlay (standard #2 — no native dialogs). */
const ComposeOverlay: React.FC<{ mode: 'post' | 'dm'; onClose: () => void }> = observer(({ mode, onClose }) => {
  const [category, setCategory] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [to, setTo] = useState<string[]>([])
  const [publicNow, setPublicNow] = useState(false)
  const [attachments, setAttachments] = useState<FeedAttachmentInput[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const canSubmit = body.trim() && (mode === 'post' ? subject.trim() : to.length > 0) && !busy
  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setErr(null)
    try {
      if (mode === 'post') {
        await store.createPost({
          category: category.trim() || undefined,
          subject: subject.trim(),
          body,
          visibility: publicNow ? 'public' : 'private',
          attachments,
        })
      } else {
        await store.createDm(to, body, attachments)
      }
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
              placeholder="Subject (required)"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </>
        ) : (
          <div className={styles.recipients}>
            {store.agents
              .filter((a) => a.agent_id && a.agent_id !== FLEET_VIEWER && a.enabled)
              .map((a) => (
                <label key={a.agent_id} className={styles.recipient}>
                  <input
                    type="checkbox"
                    checked={to.includes(a.agent_id)}
                    onChange={(e) =>
                      setTo(e.target.checked ? [...to, a.agent_id] : to.filter((id) => id !== a.agent_id))
                    }
                  />
                  {a.display_name || a.agent_id}
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
        <div className={styles.overlayFootRow}>
          <AttachPicker attachments={attachments} onChange={setAttachments} onError={setErr} />
          {mode === 'post' && (
            <label className={styles.recipient} title="Posts are PRIVATE by default; publishing makes this readable by every agent and indexes it for search.">
              <input type="checkbox" checked={publicNow} onChange={(e) => setPublicNow(e.target.checked)} />
              publish publicly now
            </label>
          )}
        </div>
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
  const [replyTo, setReplyTo] = useState<FeedMessage | null>(null)
  const [attachments, setAttachments] = useState<FeedAttachmentInput[]>([])
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
      await store.sendReply(draft, replyTo?.message_id, attachments)
      setDraft('')
      setReplyTo(null)
      setAttachments([])
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
        {store.threadHasMore && (
          <button type="button" className={styles.loadMoreBtn} disabled={store.loadingOlder} onClick={() => void store.loadOlderMessages()}>
            {store.loadingOlder ? 'Loading…' : '↑ load older messages'}
          </button>
        )}
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
          <AttachPicker attachments={attachments} onChange={setAttachments} onError={setErr} />
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
 * shown, attachment-only images, public-only search, per-recipient
 * delivery receipts, and the fleetd delivery kill switch.
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

  const guard = store.guard

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          <Radio size={16} /> Fleet Feed
        </span>
        <span className={styles.agents}>
          {store.agents
            .filter((a) => a.agent_id !== FLEET_VIEWER)
            .map((a) => (
              <span
                key={a.agent_id}
                className={styles.agentChip}
                title={`${a.kind} · ${a.status ?? (store.isOnline(a) ? 'online' : 'offline')}${a.turn_count !== null ? ` · ${a.turn_count} turns` : ''}`}
              >
                <span className={`${styles.dot} ${store.isOnline(a) ? styles.idle : styles.offline}`} />
                {a.display_name || a.agent_id}
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
        {/* Loud styling belongs on the ABNORMAL state: a fleet that silently stopped
            delivering is the condition that must shout; delivery ON is just normal. */}
        <button
          type="button"
          className={`${styles.killSwitch} ${guard ? (guard.enabled ? styles.healthy : styles.armed) : ''}`}
          disabled={!guard}
          title={
            !guard
              ? 'Delivery guard state unknown (backend unreachable?)'
              : guard.enabled
                ? 'Fleet delivery is ON (normal). Click to stop all delivery (DB-backed; survives restarts).'
                : `Fleet delivery is STOPPED${guard.reason ? ` — ${guard.reason}` : ''}${guard.updated_by ? ` (by ${guard.updated_by})` : ''}. Click to resume.`
          }
          onClick={() => guard && void store.setGuard(!guard.enabled, 'via Fleet Feed UI')}
        >
          {guard?.enabled === false ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
          {guard ? (guard.enabled ? 'delivery ON' : 'delivery STOPPED') : 'guard …'}
        </button>
      </div>

      {store.error && <div className={styles.errorBanner}>fleet feed: {store.error}</div>}
      {store.notice && (
        <div className={styles.noticeBanner}>
          {store.notice}
          <button type="button" className={styles.iconBtn} onClick={() => store.clearNotice()}>
            <X size={11} />
          </button>
        </div>
      )}

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
                  title={c.description ?? undefined}
                  onClick={() => store.setCategoryFilter(store.categoryFilter === c.name ? null : c.name)}
                >
                  {c.name}
                  {c.thread_count > 0 ? ` (${c.thread_count})` : ''}
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
                {store.searchResults.map((r) => (
                  <button
                    key={r.message_id}
                    type="button"
                    className={styles.threadRow}
                    onClick={() => void store.openThread(r.thread_id)}
                  >
                    <div className={styles.threadTitle}>{r.subject ?? r.thread_id}</div>
                    <div className={styles.threadMeta}>
                      @{r.sender} #{r.seq}: {r.body}
                    </div>
                  </button>
                ))}
              </>
            ) : store.visibleThreads.length === 0 ? (
              <div className={styles.listNote}>{store.loaded ? 'No threads yet.' : 'Loading…'}</div>
            ) : (
              <>
                {store.groupedThreads.map((g) => (
                  <GroupRow
                    key={g.key}
                    group={g}
                    expanded={store.isExpanded(g.key)}
                    onToggle={() => store.toggleGroup(g.key)}
                  />
                ))}
                {store.feedHasMore && (
                  <button type="button" className={styles.loadMoreBtn} onClick={() => void store.loadMoreThreads()}>
                    ↓ load more threads
                  </button>
                )}
              </>
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
