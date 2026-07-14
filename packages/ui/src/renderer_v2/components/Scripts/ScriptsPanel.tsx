import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, FileCode, Play, Loader2, FolderOpen, Folder, CornerLeftUp, X } from 'lucide-react'
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
  const args = scriptsStore.argsByScript[script.name] ?? ''
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
          onChange={(e) => scriptsStore.setArgs(script.name, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void scriptsStore.run(script.name, args)
          }}
        />
        <button
          className={styles.browseBtn}
          title="Browse for a folder"
          disabled={running}
          onClick={() => scriptsStore.openPicker(script.name)}
        >
          <FolderOpen size={13} />
        </button>
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

const FolderPicker: React.FC = observer(() => {
  const p = scriptsStore.picker
  if (!p.open) return null
  return (
    <div className={styles.modalOverlay} onClick={() => scriptsStore.closePicker()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <FolderOpen size={15} />
          <span className={styles.modalTitle}>Select a folder</span>
          <span className={styles.modalScript}>{p.scriptName}</span>
          <div className={styles.spacer} />
          <button className={styles.iconBtn} title="Close" onClick={() => scriptsStore.closePicker()}>
            <X size={15} />
          </button>
        </div>

        <div className={styles.pathBar}>
          <code className={styles.pathText}>{p.path}</code>
          {p.ebookCount > 0 && <span className={styles.ebookBadge}>{p.ebookCount} ebook{p.ebookCount === 1 ? '' : 's'} here</span>}
        </div>

        {p.error && <div className={styles.pickerErr}>{p.error}</div>}

        <div className={styles.dirList}>
          {p.parent && (
            <button className={styles.dirRow} onClick={() => void scriptsStore.browseTo(p.parent!)}>
              <CornerLeftUp size={14} className={styles.dirIcon} />
              <span>..</span>
            </button>
          )}
          {p.loading ? (
            <div className={styles.dirMuted}><Loader2 size={14} className={styles.spin} /> loading…</div>
          ) : p.dirs.length === 0 ? (
            <div className={styles.dirMuted}>(no subfolders)</div>
          ) : (
            p.dirs.map((d) => (
              <button key={d.path} className={styles.dirRow} onClick={() => void scriptsStore.browseTo(d.path)} title={d.path}>
                <Folder size={14} className={styles.dirIcon} />
                <span className={styles.dirName}>{d.name}</span>
              </button>
            ))
          )}
        </div>

        <div className={styles.modalFoot}>
          <span className={styles.footHint}>Runs against this folder (recursively) in guest {scriptsStore.selectedTarget || '—'}.</span>
          <div className={styles.spacer} />
          <button className={styles.cancelBtn} onClick={() => scriptsStore.closePicker()}>Cancel</button>
          <button className={styles.useBtn} onClick={() => scriptsStore.chooseCurrentFolder()}>Use this folder</button>
        </div>
      </div>
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

      <FolderPicker />
    </div>
  )
})
