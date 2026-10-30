import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MonitorPlay, RefreshCw, ExternalLink, Power, PowerOff, RotateCcw, Loader2, Keyboard, Activity } from 'lucide-react'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Consoles.module.scss'

// Remote KVM consoles (Intel AMT + BMC HTML5 iKVM), served by the backend at /api/consoles.
// The backend logs into each BMC/AMT itself — no credentials pass through this page.

interface ConsoleTarget { id: string; name: string; kind: string; host: string }

const KIND_LABEL: Record<string, string> = {
  amt: 'Intel AMT',
  supermicro: 'Supermicro BMC',
  'supermicro-redfish': 'Supermicro BMC',
  megarac: 'AMI MegaRAC BMC',
}

type PowerAction = 'status' | 'on' | 'soft' | 'off' | 'reset' | 'cycle'
const POWER_CONFIRM: Partial<Record<PowerAction, { title: string; message: string; confirmText: string }>> = {
  soft: { title: 'Graceful shutdown', message: 'Ask the operating system on {name} to shut down?', confirmText: 'Shut down' },
  off: { title: 'Hard power off', message: 'Cut power to {name} immediately? Anything running is killed without a clean shutdown.', confirmText: 'Power off' },
  reset: { title: 'Hard reset', message: 'Reset {name} immediately, like pressing the reset button? Running work is lost.', confirmText: 'Reset' },
  cycle: { title: 'Power cycle', message: 'Power {name} off and back on? Running work is lost.', confirmText: 'Power cycle' },
}

export const ConsolesPanel: React.FC = () => {
  const [targets, setTargets] = useState<ConsoleTarget[]>([])
  const [selected, setSelected] = useState<string | null>(() => {
    try { return localStorage.getItem('ai-lab-console-selected') } catch { return null }
  })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [power, setPower] = useState<Record<string, { busy?: boolean; text?: string; error?: boolean }>>({})
  const frameRef = useRef<HTMLIFrameElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/consoles')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setTargets(j.consoles || [])
      setLoadError(null)
    } catch (e) {
      setLoadError(`Could not load the console list: ${(e as Error).message}`)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const select = (id: string) => {
    if (id === selected) return // re-clicking (or Enter on the still-focused list button) must not reload the console
    setSelected(id)
    setFrameKey((k) => k + 1)
    try { localStorage.setItem('ai-lab-console-selected', id) } catch { /* storage unavailable */ }
  }

  const target = targets.find((t) => t.id === selected) || null

  const runPower = async (t: ConsoleTarget, action: PowerAction) => {
    const c = POWER_CONFIRM[action]
    if (c && !(await confirmStore.confirm({ title: c.title, message: c.message.replace('{name}', t.name), confirmText: c.confirmText }))) return
    setPower((p) => ({ ...p, [t.id]: { busy: true, text: action === 'status' ? 'checking…' : `${action}…` } }))
    try {
      const r = await fetch(`/api/consoles/${encodeURIComponent(t.id)}/power`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setPower((p) => ({ ...p, [t.id]: { text: j.result } }))
    } catch (e) {
      setPower((p) => ({ ...p, [t.id]: { text: (e as Error).message, error: true } }))
    }
  }

  // The viewers preventDefault() their mousedown, which stops a click from moving keyboard focus into
  // the iframe — keys then land on this page (Enter re-"clicked" the list button and reloaded px-gpu).
  // Hand focus to the console whenever the pointer is over it or it finishes loading.
  const focusFrame = () => {
    try { frameRef.current?.focus(); frameRef.current?.contentWindow?.focus() } catch { /* frame not ready */ }
  }
  const sendCad = () => frameRef.current?.contentWindow?.postMessage('ctrl-alt-del', window.location.origin)
  const pw = target ? power[target.id] : undefined

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <MonitorPlay size={16} className={styles.headerIcon} />
        <span className={styles.title}>Consoles</span>
        <span className={styles.spacer} />
        <button className={styles.iconBtn} title="Reload the machine list" onClick={() => void load()}><RefreshCw size={14} /></button>
      </div>
      {loadError && <div className={styles.errorBar}>{loadError}</div>}
      <div className={styles.body}>
        <div className={styles.list}>
          {targets.map((t) => (
            <button key={t.id} className={`${styles.row} ${t.id === selected ? styles.rowSel : ''}`} onClick={(e) => { e.currentTarget.blur(); select(t.id) }}>
              <span className={styles.rowName}>{t.name}</span>
              <span className={styles.rowMeta}>{KIND_LABEL[t.kind] || t.kind} · {t.host}</span>
            </button>
          ))}
          {!targets.length && !loadError && <div className={styles.empty}>Loading…</div>}
        </div>
        <div className={styles.viewer}>
          {!target ? (
            <div className={styles.placeholder}>Pick a machine to open its console.</div>
          ) : (
            <>
              <div className={styles.viewerHead}>
                <span className={styles.vName}>{target.name}</span>
                <span className={styles.vMeta}>{KIND_LABEL[target.kind] || target.kind}</span>
                {pw?.text && <span className={pw.error ? styles.pwErr : styles.pwText}>{pw.busy && <Loader2 size={12} className={styles.spin} />} {pw.text}</span>}
                <span className={styles.spacer} />
                {target.kind === 'amt' && <button className={styles.btn} title="Send Ctrl+Alt+Del" onClick={sendCad}><Keyboard size={13} /> Ctrl+Alt+Del</button>}
                <button className={styles.btn} title="Read power state" disabled={pw?.busy} onClick={() => void runPower(target, 'status')}><Activity size={13} /> Status</button>
                <button className={styles.btn} title="Power on" disabled={pw?.busy} onClick={() => void runPower(target, 'on')}><Power size={13} /> On</button>
                <button className={styles.btn} title="Ask the OS to shut down" disabled={pw?.busy} onClick={() => void runPower(target, 'soft')}><PowerOff size={13} /> Shutdown</button>
                <button className={`${styles.btn} ${styles.btnDanger}`} title="Hard power off" disabled={pw?.busy} onClick={() => void runPower(target, 'off')}><PowerOff size={13} /> Off</button>
                <button className={`${styles.btn} ${styles.btnDanger}`} title="Hard reset" disabled={pw?.busy} onClick={() => void runPower(target, 'reset')}><RotateCcw size={13} /> Reset</button>
                <button className={styles.iconBtn} title="Reconnect" onClick={() => setFrameKey((k) => k + 1)}><RefreshCw size={14} /></button>
                <a className={styles.iconBtn} title="Open in a new tab" href={`/api/consoles/${encodeURIComponent(target.id)}/view`} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
              </div>
              <iframe
                key={`${target.id}-${frameKey}`}
                ref={frameRef}
                className={styles.frame}
                title={`${target.name} console`}
                src={`/api/consoles/${encodeURIComponent(target.id)}/view`}
                // No allow-top-navigation: BMC viewers do top.location = logout on timeouts.
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"
                allow="clipboard-read; clipboard-write; fullscreen"
                onLoad={focusFrame}
                onMouseEnter={focusFrame}
                onMouseDown={focusFrame}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
