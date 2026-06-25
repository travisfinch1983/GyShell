import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import styles from './ScriptCatalog.module.scss'

export interface InstallSession {
  scriptName: string
  nodeName: string
  hostIp: string
  command: string
}

/** Live installer terminal — streams via the catalogInstall relay (backend → ProxLab node PTY). */
export const InstallTerminal: React.FC<{ session: InstallSession; onClose: () => void }> = ({ session, onClose }) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState('Connecting…')

  useEffect(() => {
    const api = (window as any).gyshell?.catalogInstall
    if (!api || !containerRef.current) {
      setStatus('Install relay unavailable')
      return
    }
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      theme: { background: '#0f1117', foreground: '#e4e6ef', cursor: '#6c8cff' },
      scrollback: 5000,
      convertEol: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    const doFit = () => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    }
    doFit()
    const fitTimers = [setTimeout(doFit, 100), setTimeout(doFit, 350)]

    let sessionId = ''
    let alive = true
    const offData = api.onData((m: { id: string; data: string }) => {
      if (m.id === sessionId) term.write(m.data)
    })
    const offExit = api.onExit((m: { id: string; code: number }) => {
      if (m.id !== sessionId) return
      setStatus(m.code === 0 ? 'Completed' : `Exited (code ${m.code})`)
    })

    term.onData((d) => {
      if (sessionId) void api.input(sessionId, d)
    })
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (sessionId) void api.resize(sessionId, cols, rows)
    })
    const onWinResize = () => doFit()
    window.addEventListener('resize', onWinResize)

    void api
      .start({ host: session.hostIp, command: session.command, cols: term.cols, rows: term.rows })
      .then((res: { id: string }) => {
        if (!alive) {
          if (res?.id) void api.close(res.id)
          return
        }
        sessionId = res.id
        setStatus('Running…')
      })
      .catch((e: unknown) => setStatus('Error: ' + (e instanceof Error ? e.message : String(e))))

    return () => {
      alive = false
      fitTimers.forEach(clearTimeout)
      window.removeEventListener('resize', onWinResize)
      offData?.()
      offExit?.()
      if (sessionId) void api.close(sessionId)
      term.dispose()
    }
  }, [session])

  return (
    <div className={styles.installPanel}>
      <div className={styles.installHead}>
        <span className={styles.installTitle}>
          Running: {session.scriptName} on {session.nodeName} ({session.hostIp})
        </span>
        <span className={styles.installStatus}>{status}</span>
        <button className={styles.iconBtn} title="Close" onClick={onClose}><X size={15} /></button>
      </div>
      <div className={styles.installTerm} ref={containerRef} />
    </div>
  )
}
