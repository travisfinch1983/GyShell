import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import styles from './Claude.module.scss'

/**
 * Native console for a consolidated Claude instance — replaces the ttyd iframe.
 * Thin custom WS binding to /api/claude/console/:id (NOT the stock attach addon,
 * so reconnect behavior stays ours):
 *  - binary frames = terminal bytes both ways; text frames = JSON control
 *    ({t:'resize'} out, {t:'status'} in).
 *  - RECONNECT: on drop, backoff-retry with a visible status. Every attach is a
 *    fresh dtach redraw server-side — nothing is buffered or replayed here.
 *  - TAKEOVER: the backend enforces one writer per instance; if another client
 *    attaches, we show "displaced" and do NOT auto-reconnect (reconnecting would
 *    ping-pong the takeover). A click re-takes the console deliberately.
 */

type ConsoleState = 'connecting' | 'attached' | 'reconnecting' | 'displaced' | 'closed'

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export const NativeConsole: React.FC<{ instanceId: string; height: number }> = ({ instanceId, height }) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<ConsoleState>('connecting')
  const [detail, setDetail] = useState<string | null>(null)
  const retakeRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      // Terminal content carries its own ANSI palette; base colors track the app theme.
      theme: {
        background: cssVar('--app-bg', '#0d1117'),
        foreground: cssVar('--fg', '#d0d7de'),
        cursor: cssVar('--accent', '#58a6ff'),
        selectionBackground: cssVar('--accent', '#58a6ff') + '55',
      },
      fontSize: 13,
      fontFamily: 'var(--font-mono, monospace)',
      scrollback: 8000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    let ws: WebSocket | null = null
    let closedByUs = false
    let displaced = false
    let retryMs = 500
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const sendResize = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
    }

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/claude/console/${encodeURIComponent(instanceId)}`)
      ws.binaryType = 'arraybuffer'
      setState((s) => (s === 'connecting' ? 'connecting' : 'reconnecting'))

      ws.onopen = () => {
        retryMs = 500
        sendResize()
      }
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as { t?: string; state?: string; detail?: string }
            if (msg.t !== 'status') return
            if (msg.state === 'attached') { setState('attached'); setDetail(null); sendResize() }
            else if (msg.state === 'takeover') { displaced = true; setState('displaced'); setDetail('another client attached and took the console') }
            else if (msg.state === 'error' || msg.state === 'exit') setDetail(msg.detail ?? msg.state ?? null)
          } catch { /* not a control frame */ }
          return
        }
        term.write(new Uint8Array(ev.data as ArrayBuffer))
      }
      ws.onclose = () => {
        if (closedByUs || displaced) return
        // CLEAN RECONNECT: fresh attach on the server side; we replay nothing.
        setState('reconnecting')
        retryTimer = setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, 8000)
      }
      ws.onerror = () => { /* surfaced via onclose */ }
    }

    retakeRef.current = () => {
      displaced = false
      setDetail(null)
      setState('reconnecting')
      connect()
    }

    const onInput = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data))
    })
    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch { /* host hidden */ }
      sendResize()
    })
    ro.observe(host)

    connect()
    term.focus()

    return () => {
      // Observer-only teardown: closing the WS detaches (backend kills its pty;
      // the dtach session itself lives on).
      closedByUs = true
      if (retryTimer) clearTimeout(retryTimer)
      onInput.dispose()
      ro.disconnect()
      try { ws?.close() } catch { /* already closed */ }
      term.dispose()
    }
  }, [instanceId])

  return (
    <div className={styles.nativeConsoleWrap} style={{ height }}>
      {state !== 'attached' && (
        <div className={styles.consoleStatus}>
          {state === 'connecting' && 'connecting…'}
          {state === 'reconnecting' && 'reconnecting…'}
          {state === 'closed' && 'closed'}
          {state === 'displaced' && (
            <>
              displaced — {detail ?? 'another client took the console'}{' '}
              <button className={styles.btn} onClick={() => retakeRef.current()}>Re-take console</button>
            </>
          )}
          {detail && state !== 'displaced' && <span className={styles.dim}> {detail}</span>}
        </div>
      )}
      <div ref={hostRef} className={styles.nativeConsoleHost} />
    </div>
  )
}
