import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { LogOut, Play, ListRestart, RotateCcw, Terminal as TermIcon, Trash2 } from 'lucide-react'
import { claudeInstancesStore as store } from '../../stores/ClaudeInstancesStore'
import { confirmStore } from '../../stores/confirmStore'
import { uiPrefsStore } from '../../stores/uiPrefsStore'
import type { ClaudeInstance, ControlAction } from '../../stores/instanceManager'
import { PermissionsPicker } from './PermissionsPicker'
import styles from './Claude.module.scss'

function usePersistedHeight(key: string, def: number) {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !uiPrefsStore.loaded) return
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return }
      const h = Math.round(el.offsetHeight)
      if (h && h !== uiPrefsStore.get(key, def)) uiPrefsStore.set(key, h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [key, uiPrefsStore.loaded])
  return { ref, height: uiPrefsStore.get(key, def) as number }
}

const STATUS_LABEL: Record<string, string> = {
  running: 'running',
  stopped: 'stopped',
  'needs-login': 'needs /login',
  starting: 'starting…',
}

/**
 * One consolidated CT161 instance: status, control buttons (exit / claude -c /
 * claude -r / restart), the ttyd terminal, and the soft-permissions editor.
 */
export const InstanceView: React.FC<{ instance: ClaudeInstance }> = observer(({ instance }) => {
  const { ref: termRef, height: termHeight } = usePersistedHeight(`claudeInstTerm:${instance.id}`, 960)
  const [msg, setMsg] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const busy = store.busyIds.has(instance.id)

  const run = async (action: ControlAction, label: string, confirm?: { title: string; message: string }) => {
    if (confirm) {
      const ok = await confirmStore.confirm({ ...confirm, confirmText: label })
      if (!ok) return
    }
    setMsg(`${label}…`)
    const r = await store.control(instance.id, action)
    setMsg(r.ok ? `${label} ✓` : `${label} failed: ${r.error || 'unknown error'}`)
    setReloadKey((k) => k + 1) // the session under ttyd changed — refresh the iframe
  }

  const remove = async () => {
    const ok = await confirmStore.confirm({
      title: 'Delete instance',
      message: `Delete the “${instance.name}” instance from CT161? This removes its Unix user, session, and config — its auth token and history are gone. This does NOT touch any other container.`,
      confirmText: 'Delete',
    })
    if (ok) void store.remove(instance.id)
  }

  return (
    <div className={styles.connView}>
      <div className={styles.connHead}>
        <strong>{instance.name}</strong>
        <span className={`${styles.instStatus} ${styles[`inst_${instance.status.replace(/-/g, '_')}`] ?? ''}`}>
          {STATUS_LABEL[instance.status] ?? instance.status}
        </span>
        <span className={styles.dim}>CT161 · user {instance.id}</span>
        <span className={styles.spacer} />
        <button
          className={styles.btn}
          disabled={busy}
          title="Send /exit to the session — Claude Code quits, the shell stays"
          onClick={() =>
            void run('exit', 'Exit', {
              title: 'Exit Claude Code',
              message: `Send /exit to “${instance.name}”? Any in-flight turn is interrupted; resume afterwards with -c.`,
            })
          }
        >
          <LogOut size={13} /> Exit
        </button>
        <button className={styles.btn} disabled={busy} title="claude -c — resume the most recent conversation" onClick={() => void run('resume-continue', 'Resume -c')}>
          <Play size={13} /> Resume -c
        </button>
        <button className={styles.btn} disabled={busy} title="claude -r — open the conversation picker" onClick={() => void run('resume-pick', 'Resume -r')}>
          <ListRestart size={13} /> Resume -r
        </button>
        <button
          className={styles.btn}
          disabled={busy}
          title="Kill and restart the whole session (dtach + claude)"
          onClick={() =>
            void run('restart', 'Restart', {
              title: 'Restart session',
              message: `Restart “${instance.name}”'s whole session (dtach + Claude Code)? In-flight work is interrupted.`,
            })
          }
        >
          <RotateCcw size={13} /> Restart
        </button>
        <button className={styles.btnDanger} disabled={busy} onClick={() => void remove()}>
          <Trash2 size={13} /> Delete
        </button>
      </div>
      {msg && <div className={styles.dim}>{msg}</div>}
      {instance.status === 'needs-login' && (
        <div className={styles.loginHint}>
          Fresh instance — complete the <code>/login</code> flow in the terminal below to authenticate it.
        </div>
      )}

      {store.mocked ? (
        <div className={styles.termPlaceholder}>
          <TermIcon size={16} /> Mock mode — no live terminal until the instance-manager (Phase 1) is deployed.
        </div>
      ) : (
        <div ref={termRef as any} className={styles.termWrap} style={{ height: termHeight }}>
          <iframe
            key={reloadKey}
            className={styles.term}
            src={`${instance.termPath}?cb=${reloadKey}`}
            title={`${instance.name} terminal`}
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      )}

      <PermissionsPicker instance={instance} />
    </div>
  )
})
