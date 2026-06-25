import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, FileCode, Play, Loader2 } from 'lucide-react'
import { scriptsStore, type ScriptDef } from '../../stores/ScriptsStore'
import styles from './Scripts.module.scss'

function fmtBytes(b?: number): string {
  if (!b || b <= 0) return ''
  const u = ['B', 'KB', 'MB']
  let i = 0
  let n = b
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

const ScriptCard: React.FC<{ script: ScriptDef }> = observer(({ script }) => {
  const [args, setArgs] = useState('')
  const out = scriptsStore.outputs[script.name]
  const running = !!out?.running
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <FileCode size={15} className={styles.fileIcon} />
        <span className={styles.name}>{script.name}</span>
        {script.size != null && <span className={styles.size}>{fmtBytes(script.size)}</span>}
      </div>
      {script.description && <div className={styles.desc}>{script.description}</div>}
      <div className={styles.runRow}>
        <input
          className={styles.args}
          placeholder="arguments (optional)"
          value={args}
          disabled={running}
          onChange={(e) => setArgs(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void scriptsStore.run(script.name, args)
          }}
        />
        <button className={styles.runBtn} disabled={running || !scriptsStore.selectedTarget} onClick={() => void scriptsStore.run(script.name, args)}>
          {running ? <Loader2 size={13} className={styles.spin} /> : <Play size={13} />} Run
        </button>
      </div>
      {out && !out.running && (
        <div className={styles.output}>
          {out.error ? (
            <div className={styles.outErr}>{out.error}</div>
          ) : (
            <>
              <div className={styles.outMeta}>exit {out.code}</div>
              {out.stdout ? <pre className={styles.outPre}>{out.stdout}</pre> : null}
              {out.stderr ? <pre className={`${styles.outPre} ${styles.outStderr}`}>{out.stderr}</pre> : null}
              {!out.stdout && !out.stderr ? <div className={styles.outMeta}>(no output)</div> : null}
            </>
          )}
        </div>
      )}
    </div>
  )
})

export const ScriptsPanel: React.FC = observer(() => {
  useEffect(() => {
    void scriptsStore.load()
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <FileCode size={16} className={styles.headerIcon} />
        <span className={styles.title}>Scripts</span>
        <span className={styles.counts}>{scriptsStore.scripts.length} scripts</span>
        <div className={styles.spacer} />
        <label className={styles.targetLabel}>Target</label>
        <select className={styles.targetSelect} value={scriptsStore.selectedTarget} onChange={(e) => scriptsStore.setTarget(e.target.value)}>
          <option value="">— select guest —</option>
          {scriptsStore.targets.map((t) => (
            <option key={t.vmid} value={t.vmid}>
              {t.vmid} · {t.name}
            </option>
          ))}
        </select>
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void scriptsStore.load()}>
          <RefreshCw size={14} className={scriptsStore.loading ? styles.spin : ''} />
        </button>
      </div>

      {scriptsStore.error && <div className={styles.errorBar}>Failed to load scripts — {scriptsStore.error}</div>}
      {!scriptsStore.error && scriptsStore.scripts.length === 0 && !scriptsStore.loading && (
        <div className={styles.empty}>No scripts found in the server /scripts directory.</div>
      )}

      <div className={styles.body}>
        <div className={styles.grid}>
          {scriptsStore.scripts.map((s) => (
            <ScriptCard key={s.name} script={s} />
          ))}
        </div>
      </div>
    </div>
  )
})
