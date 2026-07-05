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
      // Match the Proxmox console exactly: it passes fontFamily:'monospace' so the browser
      // picks its default monospace (DejaVu Sans Mono on Linux). We must pass a CONCRETE
      // string here — xterm.js measures glyphs on a canvas and CANNOT resolve a CSS var(),
      // so the old `var(--font-mono)` silently fell back to xterm's Courier default, which
      // is why the font looked wildly different and cell spacing was off.
      fontSize: 14,
      fontFamily: 'monospace',
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

    // Heartbeat / half-open detection. A dropped TCP connection often leaves the
    // browser WebSocket stuck in OPEN with no onclose ever firing (wifi blip,
    // laptop sleep, an idle intermediary reaping the socket) — the terminal just
    // freezes. Claude is idle-heavy, so "no output" ≠ dead; instead we send an
    // app-level ping and expect a pong. Any frame (output OR pong) refreshes
    // lastActivity; if nothing arrives for STALE_MS we force-close, which fires
    // onclose → the existing reconnect path (a fresh dtach redraw, no replay).
    let lastActivity = Date.now()
    let lastPingAt = 0
    let hbTimer: ReturnType<typeof setInterval> | null = null
    const HB_SEND_MS = 10000 // app-ping cadence
    const STALE_MS = 30000 // no traffic (incl. pong) this long ⇒ connection is dead

    const sendResize = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
    }

    // Force the remote TUI to repaint. Coming back to an already-attached tab shows a
    // blank screen (the -r winch only fires on a FRESH attach, and dtach keeps no screen
    // buffer), so we nudge a real size change — rows-1 then back — which sends a genuine
    // SIGWINCH through ssh→dtach→claude and makes the full-screen TUI redraw. Same effect
    // as the old manual Proxmox attach, without a second dtach client.
    const forceRepaint = () => {
      if (ws?.readyState !== WebSocket.OPEN) return
      try { fit.fit() } catch { /* host hidden */ }
      const { cols, rows } = term
      try {
        ws.send(JSON.stringify({ t: 'resize', cols, rows: Math.max(2, rows - 1) }))
        setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols, rows })) }, 60)
      } catch { /* racing close */ }
    }
    const onVisible = () => { if (!document.hidden) forceRepaint() }
    document.addEventListener('visibilitychange', onVisible)

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/claude/console/${encodeURIComponent(instanceId)}`)
      ws.binaryType = 'arraybuffer'
      lastActivity = Date.now()
      setState((s) => (s === 'connecting' ? 'connecting' : 'reconnecting'))

      ws.onopen = () => {
        retryMs = 500
        lastActivity = Date.now()
        sendResize()
      }
      ws.onmessage = (ev) => {
        lastActivity = Date.now()
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as { t?: string; state?: string; detail?: string }
            if (msg.t !== 'status') return
            if (msg.state === 'attached') {
              setState('attached'); setDetail(null)
              // FORCE a repaint on attach (not just visibilitychange): sendResize alone sends the
              // CURRENT size, and dtach/the TUI only redraw on a size CHANGE — so a same-size attach
              // paints nothing (blank until a tab-switch). forceRepaint's rows-1→rows nudge guarantees
              // a redraw. Doubled to cover the fresh-attach timing race slower drops (runuser/su) hit.
              forceRepaint(); setTimeout(forceRepaint, 300)
            }
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

    hbTimer = setInterval(() => {
      const now = Date.now()
      if (!ws) return
      if (ws.readyState === WebSocket.OPEN && now - lastPingAt >= HB_SEND_MS) {
        lastPingAt = now
        try { ws.send(JSON.stringify({ t: 'ping' })) } catch { /* racing close */ }
      }
      // Half-open: an OPEN/CONNECTING socket silent past STALE_MS is dead. Force a
      // close (unless we were deliberately displaced) to trigger the reconnect.
      if (
        !displaced &&
        (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) &&
        now - lastActivity > STALE_MS
      ) {
        try { ws.close() } catch { /* already closing */ }
      }
    }, 5000)

    return () => {
      // Observer-only teardown: closing the WS detaches (backend kills its pty;
      // the dtach session itself lives on).
      closedByUs = true
      if (retryTimer) clearTimeout(retryTimer)
      if (hbTimer) clearInterval(hbTimer)
      document.removeEventListener('visibilitychange', onVisible)
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
