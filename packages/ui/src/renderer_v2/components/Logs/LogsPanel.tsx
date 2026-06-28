import React, { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { ScrollText, RefreshCw, Loader2, ArrowDownToLine } from 'lucide-react'
import { logsStore as store, type LogService } from '../../stores/LogsStore'
import styles from './Logs.module.scss'

// Strip ANSI escape sequences (tmux capture includes color codes) for clean text display.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
function clean(s: string): string {
  return (s || '').replace(ANSI, '')
}
function when(ts?: string | null): string {
  if (!ts) return ''
  const d = Date.parse(ts)
  return d ? new Date(d).toLocaleString() : ''
}

const ServiceRow: React.FC<{ svc: LogService }> = observer(({ svc }) => {
  const sel = store.selectedId === svc.id
  return (
    <button className={`${styles.svcRow} ${sel ? styles.svcSel : ''}`} onClick={() => store.select(svc.id)}>
      <span className={`${styles.dot} ${svc.status === 'running' ? styles.dotRun : styles.dotStop}`} />
      <span className={styles.svcMain}>
        <span className={styles.svcName} title={svc.providerName || svc.id}>{svc.providerName || svc.providerId || svc.id}</span>
        {svc.model && <span className={styles.svcModel} title={svc.model}>{svc.model}</span>}
      </span>
      <span className={styles.svcMeta}>
        {svc.port ? `:${svc.port}` : ''}{svc.node ? ` · ${svc.node}` : ''}
        {svc.status !== 'running' && svc.exitReason ? ` · ${svc.exitReason}` : ''}
      </span>
    </button>
  )
})

export const LogsPanel: React.FC = observer(() => {
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    store.startListPoll(8000)
    return () => store.dispose()
  }, [])

  // auto-scroll to bottom on new content when following
  useEffect(() => {
    if (store.follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [store.logText, store.follow])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <ScrollText size={16} className={styles.headerIcon} />
        <span className={styles.title}>Logs</span>
        <div className={styles.spacer} />
        {store.selected && (
          <>
            <span className={`${styles.srcBadge} ${store.source === 'logfile' ? styles.srcLog : store.source === 'tmux' ? styles.srcTmux : styles.srcNone}`}>
              {store.source === 'logfile' ? 'log file' : store.source === 'tmux' ? 'tmux capture' : 'no log'}
            </span>
            <select className={styles.select} value={store.lines} onChange={(e) => store.setLines(Number(e.target.value))} title="Lines to tail">
              {[200, 500, 1000, 2000, 5000].map((n) => <option key={n} value={n}>{n} lines</option>)}
            </select>
            <button className={`${styles.iconBtn} ${store.follow ? styles.iconBtnOn : ''}`} title="Follow (auto-scroll + live refresh)" onClick={() => store.toggleFollow()}><ArrowDownToLine size={14} /></button>
            <button className={styles.iconBtn} title="Refresh" onClick={() => void store.fetchLog()}>
              {store.loadingLog ? <Loader2 size={14} className={styles.spin} /> : <RefreshCw size={14} />}
            </button>
          </>
        )}
      </div>

      <div className={styles.body}>
        {/* LEFT — service listbox */}
        <div className={styles.list}>
          <div className={styles.listHead}>
            Services ({store.services.length})
            <button className={styles.refreshSm} title="Refresh list" onClick={() => void store.loadServices()}><RefreshCw size={12} /></button>
          </div>
          <div className={styles.listScroll}>
            {store.running.length > 0 && <div className={styles.groupLabel}>Running ({store.running.length})</div>}
            {store.running.map((s) => <ServiceRow key={s.id} svc={s} />)}
            {store.stopped.length > 0 && <div className={styles.groupLabel}>Stopped / Failed ({store.stopped.length})</div>}
            {store.stopped.map((s) => <ServiceRow key={s.id} svc={s} />)}
            {store.services.length === 0 && <div className={styles.empty}>{store.loadingList ? 'Loading…' : 'No services.'}</div>}
          </div>
        </div>

        {/* RIGHT — log viewer */}
        <div className={styles.viewer}>
          {!store.selected && <div className={styles.placeholder}>Select a service to view its log.</div>}
          {store.selected && (
            <>
              <div className={styles.viewerHead}>
                <span className={styles.vName}>{store.selected.providerName || store.selected.id}</span>
                {store.selected.model && <span className={styles.vModel}>{store.selected.model}</span>}
                <div className={styles.spacer} />
                <span className={styles.vTime}>{store.capturedAt ? `captured ${when(store.capturedAt)}` : ''}</span>
              </div>
              {store.error && <div className={styles.errorBar}>{store.error}</div>}
              <pre ref={preRef} className={styles.pre}>{clean(store.logText) || (store.loadingLog ? '' : '(empty)')}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  )
})
