import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Plus } from 'lucide-react'
import { claudeInstancesStore as store } from '../../stores/ClaudeInstancesStore'
import styles from './Claude.module.scss'

/**
 * Spawn a new consolidated instance on CT161 (fleet-consolidation req 1):
 * name it → instance-manager creates the Unix user + session + ttyd →
 * the new sub-tab opens showing the /login flow.
 */
export const SpawnInstanceView: React.FC<{ onSpawned: (id: string) => void }> = observer(({ onSpawned }) => {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '')

  const spawn = async () => {
    if (!slug) {
      setErr('Name it first')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const instance = await store.create(name.trim())
      onSpawned(instance.id)
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.addForm}>
      <h4 className={styles.h4}>Spawn Claude Instance</h4>
      <p className={styles.dim}>
        Creates a fresh Claude Code instance on CT161: its own Unix user, config dir, dtach session, and
        ttyd terminal — preset with bypass-permissions. The new sub-tab drops straight into the{' '}
        <code>/login</code> flow to authenticate it.
      </p>
      <label className={styles.field}>
        <span>Instance name {slug && slug !== name ? <em>· will become “{slug}”</em> : ''}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. research-claude"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void spawn()
          }}
        />
      </label>
      {err && <div className={styles.error}>{err}</div>}
      <button className={styles.btnPrimary} disabled={busy || !slug} onClick={() => void spawn()}>
        <Plus size={13} /> {busy ? 'Spawning…' : 'Spawn instance'}
      </button>
      {store.mocked && (
        <p className={styles.dim}>
          ⚠ Instance-manager API not deployed yet — this creates a MOCK instance (UI demo only).
        </p>
      )}
    </div>
  )
})
