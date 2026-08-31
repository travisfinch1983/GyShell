import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Check, CheckCheck, Pause, Play } from 'lucide-react'
import {
  notificationsStore as store,
  type HealthState,
  type NotifyEvent,
} from '../../stores/NotificationsStore'
import styles from './Notifications.module.scss'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

const HealthDot: React.FC<{ h: HealthState }> = ({ h }) => (
  <div className={styles.healthRow} title={`checked ${fmtTime(h.checkedAt)}`}>
    <span
      className={`${styles.dot} ${
        h.status === 'ok' ? styles.dotOk : h.status === 'down' ? styles[`dot_${h.downSeverity}`] : styles.dotUnknown
      }`}
    />
    <span className={styles.healthLabel}>{h.label}</span>
    {h.status !== 'ok' && (
      <span className={styles.healthReason}>
        {h.status === 'unknown' ? `cannot check: ${h.reason ?? 'unknown'}` : h.reason ?? 'down'}
      </span>
    )}
  </div>
)

const EventRow: React.FC<{ e: NotifyEvent }> = observer(({ e }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className={`${styles.eventRow} ${e.acked ? styles.acked : ''}`}>
      <span className={`${styles.sevBadge} ${styles[`sev_${e.severity}`]}`}>{e.severity}</span>
      <div className={styles.eventBody}>
        <button
          type="button"
          className={styles.eventMsg}
          title={e.detail ? 'Show detail' : undefined}
          onClick={() => e.detail && setOpen((o) => !o)}
        >
          <span className={styles.eventSource}>{e.source}</span> {e.message}
          {/* A standing condition is one row that counts, not a stack of rows —
              ten copies of one fact bury everything else in the panel. */}
          {(e.occurrences ?? 1) > 1 && <span className={styles.occurBadge}>×{e.occurrences}</span>}
        </button>
        {open && e.detail && <pre className={styles.eventDetail}>{e.detail}</pre>}
      </div>
      <span className={styles.eventTime} title={e.lastTs ? `first ${fmtTime(e.ts)} · latest ${fmtTime(e.lastTs)}` : undefined}>
        {fmtTime(e.lastTs ?? e.ts)}
      </span>
      {!e.acked && e.severity !== 'info' && (
        <button type="button" className={styles.ackBtn} title="Acknowledge" onClick={() => void store.ack([e.id])}>
          <Check size={12} />
        </button>
      )}
    </div>
  )
})

/**
 * Notifications panel — expands from the header. Three sections (Travis's
 * spec): health board (grey = CANNOT CHECK, never conflated with red),
 * running warnings/errors, live debug console.
 */
export const NotificationsPanel: React.FC<{ onClose: () => void }> = observer(({ onClose }) => {
  const debugRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    void store.ensureLoaded()
  }, [])

  const debugCount = store.debug.length
  useEffect(() => {
    if (paused) return
    const el = debugRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [debugCount, paused])

  const events = [...store.events].reverse().filter((e) => e.severity !== 'info' || !e.acked)
  const unackedTotal = store.unacked.warning + store.unacked.error + store.unacked.critical

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.panel}>
        {/* The stream heartbeat: without this a dead live channel froze the
            badge and board for up to 5 minutes while looking current. */}
        {store.streamStale && (
          <div className={styles.errBanner ?? ''} style={{ padding: '5px 10px', fontSize: 11.5, color: 'var(--danger, #e05555)', borderBottom: '1px solid var(--border)' }}>
            ⚠ live stream detached — this view may LAG; refreshing on a slow poll until it returns
          </div>
        )}
        {/*
          Forwarding state, first thing in the panel and deliberately loud when off.
          While emitters are being built they raise premature and wrong alerts, so
          forwarding gets suspended — but an off switch nobody can see turns a quiet panel
          into a false all-clear, so the panel states it and counts what was withheld.
        */}
        {store.routing && (store.routing.suspended || store.routing.envDisabled) && (
          <div className={styles.routingBanner}>
            <div>
              <strong>Forwarding to {store.routing.recipient} is SUSPENDED.</strong>{' '}
              Events are still recorded and badged here — nobody is being woken for them.
              {store.routing.suppressed > 0 && ` ${store.routing.suppressed} withheld so far.`}
              {store.routing.reason && <div className={styles.routingReason}>{store.routing.reason}</div>}
              {store.routing.envDisabled && (
                <div className={styles.routingReason}>
                  Disabled by AILAB_MAINTAINER_AGENT — the button cannot re-enable it.
                </div>
              )}
            </div>
            {!store.routing.envDisabled && (
              <button className={styles.routingBtn} onClick={() => void store.setRouting(false)}>
                Resume forwarding
              </button>
            )}
          </div>
        )}
        {store.routing && !store.routing.suspended && !store.routing.envDisabled && (
          <div className={styles.routingQuiet}>
            <span>Forwarding to {store.routing.recipient} is active.</span>
            <button
              className={styles.routingBtnQuiet}
              onClick={() => void store.setRouting(true, 'Suspended from the notifications panel')}
            >
              Suspend
            </button>
          </div>
        )}

        <div className={styles.section}>
          <div className={styles.sectionHead}>Health</div>
          {store.error && <div className={styles.storeError}>notifications: {store.error}</div>}
          <div className={styles.healthGrid}>
            {store.health.length === 0 ? (
              <div className={styles.emptyNote}>{store.loaded ? 'No health checks configured.' : 'Loading…'}</div>
            ) : (
              store.health.map((h) => <HealthDot key={h.id} h={h} />)
            )}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHead}>
            Warnings & errors
            {unackedTotal > 0 && (
              <button type="button" className={styles.ackAllBtn} onClick={() => void store.ack('all')}>
                <CheckCheck size={12} /> ack all
              </button>
            )}
          </div>
          <div className={styles.eventList}>
            {events.length === 0 ? (
              <div className={styles.emptyNote}>Nothing to report — and that's a verified nothing, not a silent one.</div>
            ) : (
              events.map((e) => <EventRow key={e.id} e={e} />)
            )}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHead}>
            Debug console
            <button
              type="button"
              className={styles.ackAllBtn}
              title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? <Play size={12} /> : <Pause size={12} />} {paused ? 'resume' : 'pause'}
            </button>
          </div>
          <div ref={debugRef} className={styles.debugConsole}>
            {store.debug.length === 0 ? (
              <div className={styles.emptyNote}>No debug messages yet.</div>
            ) : (
              store.debug.map((d, i) => (
                <div key={`${d.ts}-${i}`} className={styles.debugLine}>
                  <span className={styles.debugTime}>{fmtTime(d.ts)}</span>
                  <span className={styles.debugSource}>{d.source}</span> {d.message}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  )
})
