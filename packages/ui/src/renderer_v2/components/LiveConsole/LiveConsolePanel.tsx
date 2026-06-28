import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TerminalSquare, RotateCw, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { liveConsoleStore as store, serviceConsoleLabel } from '../../stores/LiveConsoleStore'
import { aiServicesStore } from '../../stores/AiServicesStore'
import styles from './LiveConsole.module.scss'

export const LiveConsolePanel: React.FC = observer(() => {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string>('')
  const [status, setStatus] = useState('')
  const [reconnectSeq, setReconnectSeq] = useState(0)

  // load + light poll of the running-services list for the dropdown
  useEffect(() => {
    if (!aiServicesStore.services.length) void aiServicesStore.load()
  }, [])

  // create the xterm instance once
  useEffect(() => {
    if (!mountRef.current) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      theme: { background: '#0f1117', foreground: '#e4e6ef', cursor: '#6c8cff' },
      scrollback: 8000,
      convertEol: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(mountRef.current)
    termRef.current = term
    fitRef.current = fit
    const doFit = () => { try { fit.fit() } catch { /* ignore */ } }
    doFit()
    const t = setTimeout(doFit, 120)
    const api = (window as any).gyshell?.catalogInstall
    term.onData((d) => { if (sessionRef.current && api) void api.input(sessionRef.current, d) })
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => { if (sessionRef.current && api) void api.resize(sessionRef.current, cols, rows) })
    const onWin = () => doFit()
    window.addEventListener('resize', onWin)
    return () => { clearTimeout(t); window.removeEventListener('resize', onWin); term.dispose(); termRef.current = null }
  }, [])

  // route streamed data/exit by current session id (listeners registered once)
  useEffect(() => {
    const api = (window as any).gyshell?.catalogInstall
    if (!api) return
    const offData = api.onData((m: { id: string; data: string }) => { if (m.id === sessionRef.current) termRef.current?.write(m.data) })
    const offExit = api.onExit((m: { id: string; code: number }) => { if (m.id === sessionRef.current) setStatus(`Exited (code ${m.code})`) })
    return () => { offData?.(); offExit?.() }
  }, [])

  const target = store.target
  const targetId = target?.id

  // (re)attach whenever the target (or a manual reconnect) changes
  useEffect(() => {
    const api = (window as any).gyshell?.catalogInstall
    const term = termRef.current
    if (!api || !term) return
    if (sessionRef.current) { void api.close(sessionRef.current); sessionRef.current = '' }
    term.reset()
    if (!target || !target.command) {
      setStatus(target ? 'No live tmux session for this service.' : '')
      return
    }
    setStatus('Connecting…')
    let alive = true
    try { fitRef.current?.fit() } catch { /* ignore */ }
    void api
      .start({ host: target.host, command: target.command, cols: term.cols, rows: term.rows })
      .then((res: { id: string }) => {
        if (!alive) { if (res?.id) void api.close(res.id); return }
        sessionRef.current = res.id
        setStatus(target.kind === 'install' ? 'Running…' : 'Attached')
        term.focus()
      })
      .catch((e: unknown) => setStatus('Error: ' + (e instanceof Error ? e.message : String(e))))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, reconnectSeq])

  const services = aiServicesStore.services

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <TerminalSquare size={16} className={styles.headerIcon} />
        <span className={styles.title}>Live Console</span>
        <select
          className={styles.select}
          value={target?.kind === 'service' ? target.id : ''}
          onChange={(e) => { const s = services.find((x) => x.id === e.target.value); if (s) store.openService(s) }}
        >
          <option value="">{target?.kind === 'install' ? `▶ ${target.label} (install)` : 'Select a running service…'}</option>
          {services.map((s) => <option key={s.id} value={s.id}>{serviceConsoleLabel(s)}</option>)}
        </select>
        {target && <span className={`${styles.status} ${status.startsWith('Error') ? styles.stErr : ''}`}>{status}</span>}
        <div className={styles.spacer} />
        {target && <button className={styles.iconBtn} title="Reconnect" onClick={() => setReconnectSeq((n) => n + 1)}><RotateCw size={14} /></button>}
        {target && <button className={styles.iconBtn} title="Detach / clear" onClick={() => store.clear()}><X size={14} /></button>}
      </div>
      <div className={styles.body}>
        {!target && <div className={styles.placeholder}>Pick a running service above to attach to its live tmux session, or launch an install/update from a provider card — it'll run here.</div>}
        <div className={styles.term} ref={mountRef} style={{ display: target ? 'block' : 'none' }} />
      </div>
    </div>
  )
})
