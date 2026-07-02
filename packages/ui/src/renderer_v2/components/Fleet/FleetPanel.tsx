import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Radio, Send, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { BusEnvelope } from '@gyshell/shared'
import { fleetStore as store } from '../../stores/FleetStore'
import styles from './Fleet.module.scss'

function hhmmss(ts: string): string {
  const d = new Date(ts)
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : ''
}

const EnvelopeRow: React.FC<{ envelope: BusEnvelope }> = observer(({ envelope }) => {
  const name = (id: string) => store.agents.find((a) => a.agentId === id)?.displayName ?? id
  const deliveries = store.latestDelivery(envelope.busSeq)
  if (envelope.kind === 'system') {
    return (
      <div className={`${styles.row} ${styles.system}`}>
        <div className={styles.rowHead}>
          <span className={styles.kindBadge}>system</span>
          <span className={styles.time}>{hhmmss(envelope.ts)}</span>
        </div>
        <div className={styles.body}>{envelope.body}</div>
      </div>
    )
  }
  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.who}>@{name(envelope.from)}</span>
        <span>→</span>
        <span className={styles.who}>{envelope.to === 'broadcast' ? 'everyone' : `@${name(envelope.to)}`}</span>
        <span className={`${styles.kindBadge} ${envelope.kind === 'broadcast' ? styles.broadcast : ''}`}>
          {envelope.kind}
        </span>
        {envelope.replyToSeq !== undefined && <span className={styles.thread}>↩ #{envelope.replyToSeq}</span>}
        {envelope.autonomous && <span className={styles.thread}>auto·ttl {envelope.hopCount}</span>}
        <span className={styles.time}>#{envelope.busSeq} · {hhmmss(envelope.ts)}</span>
      </div>
      <div className={styles.body}>{envelope.body}</div>
      {deliveries.length > 0 && (
        <div className={styles.deliveries}>
          {deliveries.map((d) => (
            <span key={`${d.seq}`} className={`${styles.deliveryChip} ${styles[d.state] ?? ''}`}>
              {d.targetAgentId ? `${d.targetAgentId}: ` : ''}
              {d.state}
              {d.reason ? ` (${d.reason})` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
})

/**
 * Fleet Feed (req 2): the permanent message board over the ConversationBus —
 * all user↔agent + agent↔agent traffic with per-recipient delivery status,
 * presence, the autonomy budget meter, and the F1 kill switch.
 */
export const FleetPanel: React.FC = observer(() => {
  const feedRef = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState('broadcast')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    void store.ensureLoaded()
  }, [])

  // Stick to the bottom when already there (don't yank during scrollback reading).
  const count = store.visibleEnvelopes.length
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [count])

  if (!store.available) {
    return (
      <div className={styles.panel}>
        <div className={styles.unavailable}>Fleet bus unavailable — backend too old or fleet bridge disabled.</div>
      </div>
    )
  }

  const routing = store.guardConfig?.autonomousRoutingEnabled ?? false
  const used = store.budget?.usedThisHour ?? 0
  const cap = store.budget?.budgetPerHour ?? 0
  const ratio = cap > 0 ? Math.min(1, used / cap) : 0
  const statusOf = (agentId: string) => store.statuses.find((s) => s.agentId === agentId)

  const submit = async () => {
    if (!draft.trim() || sending) return
    setSending(true)
    try {
      await store.send(target, draft)
      setDraft('')
    } catch (err) {
      console.warn('[FleetPanel] send failed:', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          <Radio size={16} /> Fleet Feed
        </span>
        <span className={styles.agents}>
          {store.agents
            .filter((a) => a.kind !== 'user')
            .map((a) => {
              const s = statusOf(a.agentId)
              return (
                <span key={a.agentId} className={styles.agentChip} title={`${a.kind} · ${s?.status ?? 'unknown'}`}>
                  <span className={`${styles.dot} ${styles[s?.status ?? 'offline'] ?? ''}`} />
                  {a.displayName}
                  {s && s.queueDepth > 0 ? ` (${s.queueDepth})` : ''}
                </span>
              )
            })}
        </span>
        <span className={styles.spacer} />
        <span className={styles.filters}>
          {(['all', 'agents', 'system'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`${styles.filterBtn} ${store.filter === f ? styles.active : ''}`}
              onClick={() => store.setFilter(f)}
            >
              {f}
            </button>
          ))}
        </span>
        <span className={styles.budget} title="Autonomous inferences this rolling hour">
          <span className={styles.budgetBar}>
            <span
              className={`${styles.budgetFill} ${ratio >= 1 ? styles.full : ratio >= 0.7 ? styles.warn : ''}`}
              style={{ width: `${Math.round(ratio * 100)}%`, display: 'block' }}
            />
          </span>
          {used}/{cap}
        </span>
        <button
          type="button"
          className={`${styles.killSwitch} ${routing ? styles.armed : ''}`}
          title={
            routing
              ? 'Autonomous routing is ON — agents run on delivery. Click to pause all autonomous inference.'
              : 'Autonomous routing is OFF — deliveries queue, no agent runs on delivery. Click to enable.'
          }
          onClick={() => void store.setAutonomousRouting(!routing)}
        >
          {routing ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
          {routing ? 'routing ON' : 'routing off'}
        </button>
      </div>

      <div ref={feedRef} className={styles.feed}>
        {store.visibleEnvelopes.length === 0 ? (
          <div className={styles.empty}>
            No fleet traffic yet. Message an agent below, or point external instances at{' '}
            <code>POST /api/fleet/relay-inbound</code> on the universal proxy to see their chatter here.
          </div>
        ) : (
          store.visibleEnvelopes.map((e) => <EnvelopeRow key={e.busSeq} envelope={e} />)
        )}
      </div>

      <div className={styles.composer}>
        <select className={styles.target} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="broadcast">everyone (broadcast)</option>
          {store.agents
            .filter((a) => a.kind !== 'user' && a.enabled)
            .map((a) => (
              <option key={a.agentId} value={a.agentId}>
                @{a.displayName}
              </option>
            ))}
        </select>
        <textarea
          className={styles.input}
          rows={1}
          placeholder="Message the fleet… (Enter to send, Shift+Enter for newline)"
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
  )
})
