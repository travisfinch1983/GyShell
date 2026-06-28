import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Plus, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { liveConsoleStore as store, serviceConsoleLabel, type ConsoleSession } from '../../stores/LiveConsoleStore'
import { aiServicesStore } from '../../stores/AiServicesStore'
import styles from './LiveConsole.module.scss'

/** One PTY session bound to an xterm. Stays mounted while its tab exists; refits when activated. */
const XtermConsole: React.FC<{ session: ConsoleSession; active: boolean }> = ({ session, active }) => {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const api = (window as any).gyshell?.catalogInstall
    if (!api || !mountRef.current) return
    const term = new Terminal({
      cursorBlink: true, fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      theme: { background: '#0f1117', foreground: '#e4e6ef', cursor: '#6c8cff' },
      scrollback: 8000, convertEol: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(mountRef.current)
    termRef.current = term
    fitRef.current = fit
    const doFit = () => { try { fit.fit() } catch { /* ignore */ } }
    doFit()
    const t = setTimeout(doFit, 120)
    let sid = ''
    let alive = true
    const offData = api.onData((m: { id: string; data: string }) => { if (m.id === sid) term.write(m.data) })
    const offExit = api.onExit((m: { id: string; code: number }) => { if (m.id === sid) term.write(`\r\n\x1b[90m[session ended — code ${m.code}]\x1b[0m\r\n`) })
    term.onData((d) => { if (sid) void api.input(sid, d) })
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => { if (sid) void api.resize(sid, cols, rows) })
    const onWin = () => doFit()
    window.addEventListener('resize', onWin)
    void api.start({ host: session.host, command: session.command, cols: term.cols, rows: term.rows })
      .then((r: { id: string }) => { if (!alive) { if (r?.id) void api.close(r.id); return } sid = r.id })
      .catch(() => { term.write('\x1b[31mfailed to start session\x1b[0m\r\n') })
    return () => { alive = false; clearTimeout(t); window.removeEventListener('resize', onWin); offData?.(); offExit?.(); if (sid) void api.close(sid); term.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.command])

  // refit + focus when this tab becomes active (xterm can't measure while display:none)
  useEffect(() => {
    if (active) { const t = setTimeout(() => { try { fitRef.current?.fit() } catch { /* ignore */ } termRef.current?.focus() }, 30); return () => clearTimeout(t) }
  }, [active])

  return <div className={styles.term} ref={mountRef} />
}

export const LiveConsoleMultiPanel: React.FC = observer(() => {
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!aiServicesStore.services.length) void aiServicesStore.load()
  }, [])

  const sessions = store.sessions
  const activeId = store.activeId

  const openPicker = () => { void aiServicesStore.load(); setPickerOpen((o) => !o) }

  return (
    <div className={styles.multiContainer}>
      <div className={styles.tabbar}>
        <div className={styles.tabScroll}>
          {sessions.map((s) => (
            <div key={s.id} className={`${styles.tab} ${activeId === s.id ? styles.tabActive : ''}`} onClick={() => store.setActive(s.id)} title={s.label}>
              <span className={`${styles.tabDot} ${s.kind === 'install' ? styles.dotInstall : styles.dotService}`} />
              <span className={styles.tabLabel}>{s.label}</span>
              <button className={styles.tabClose} title="Close" onClick={(e) => { e.stopPropagation(); store.close(s.id) }}><X size={11} /></button>
            </div>
          ))}
        </div>
        <div className={styles.addWrap}>
          <button className={styles.addBtn} title="Open a service console" onClick={openPicker}><Plus size={14} /> Console</button>
          {pickerOpen && (
            <>
              <div className={styles.pickerBackdrop} onClick={() => setPickerOpen(false)} />
              <div className={styles.picker}>
                <div className={styles.pickerHead}>Running services</div>
                {aiServicesStore.services.length === 0 && <div className={styles.pickerEmpty}>No running services.</div>}
                {aiServicesStore.services.map((svc) => (
                  <button key={svc.id} className={styles.pickerItem} onClick={() => { store.openService(svc); setPickerOpen(false) }}>{serviceConsoleLabel(svc)}</button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className={styles.multiBody}>
        {sessions.length === 0 && (
          <div className={styles.placeholder}>No consoles open. Click <Plus size={13} /> to attach to a running service's log, or launch an install/update from a provider card — it opens here.</div>
        )}
        {sessions.map((s) => (
          <div key={s.id} className={styles.termHost} style={{ display: activeId === s.id ? 'block' : 'none' }}>
            <XtermConsole session={s} active={activeId === s.id} />
          </div>
        ))}
      </div>
    </div>
  )
})
