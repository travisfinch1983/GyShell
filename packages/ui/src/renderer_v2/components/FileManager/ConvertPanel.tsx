import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Upload, ArrowRight, Download, X, RotateCcw, Trash2, Loader2 } from 'lucide-react'
import { transmuteStore as store, type TJob } from '../../stores/TransmuteStore'
import styles from './Files.module.scss'

/**
 * Files → Convert — native page over the Transmute service (see TransmuteStore).
 * Upload → the server answers with each file's real compatible output formats →
 * pick targets → convert → download. No iframe, no auth in the browser.
 */

const fmtSize = (b: number): string =>
  b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`

/** Combo text/dropdown for the output format: type to filter, arrows + Enter or click to pick. */
const FormatCombo: React.FC<{ value: string; options: string[]; onPick: (v: string) => void }> = ({ value, options, onPick }) => {
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const [edited, setEdited] = useState(false)
  const [hi, setHi] = useState(0)
  const inRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setText(value); setEdited(false) }, [value])
  const q = text.trim().toLowerCase()
  // Until the user types, the full list shows — filtering by the current value would hide everything else.
  const list = edited ? options.filter((o) => o.includes(q)) : options
  const commit = (v: string): void => {
    if (v && options.includes(v)) { onPick(v); setText(v) } else setText(value)
    setEdited(false); setOpen(false)
  }
  return (
    <div className={styles.cvCombo}>
      <input
        ref={inRef}
        className={styles.input}
        value={text}
        placeholder="format"
        spellCheck={false}
        onFocus={() => { setOpen(true); setHi(Math.max(0, options.indexOf(value))) }}
        onBlur={() => commit(options.find((o) => o === q) || '')}
        onChange={(e) => { setText(e.target.value); setEdited(true); setOpen(true); setHi(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, list.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); commit(list[hi] || options.find((o) => o === q) || ''); inRef.current?.blur() }
          else if (e.key === 'Escape') { setText(value); setEdited(false); setOpen(false) }
        }}
      />
      {open && list.length > 0 && (
        <div className={styles.cvComboList}>
          {list.map((o, i) => (
            <div
              key={o}
              className={`${styles.cvComboOpt} ${i === hi ? styles.cvComboHi : ''} ${o === value ? styles.cvComboCur : ''}`}
              onMouseDown={(e) => { e.preventDefault(); commit(o) }}
              onMouseEnter={() => setHi(i)}
            >{o}</div>
          ))}
        </div>
      )}
    </div>
  )
}

const JobRow: React.FC<{ job: TJob }> = observer(({ job }) => {
  const active = job.status === 'queued' || job.status === 'running'
  const cls = job.status === 'completed' ? styles.cvOk : job.status === 'failed' ? styles.cvFail : active ? styles.cvRun : styles.cvMuted
  const outName = (() => {
    const base = (job.source_filename || 'file').replace(/\.[^.]+$/, '')
    return `${base}.${job.output_format}`
  })()
  return (
    <div className={styles.cvRow}>
      <span className={styles.cvName} title={job.source_filename || ''}>{job.source_filename}</span>
      <span className={styles.cvArrow}>{(job.source_extension || '?').replace(/^\./, '')} <ArrowRight size={11} /> {job.output_format}{job.quality ? ` (${job.quality})` : ''}</span>
      <span className={`${styles.cvStatus} ${cls}`}>
        {active && <Loader2 size={11} className={styles.cvSpin} />}
        {job.status}{job.status === 'running' && job.progress != null ? ` ${job.progress}%` : ''}
      </span>
      <span className={styles.cvActions}>
        {job.status === 'completed' && job.output_file_id && (
          <a className={styles.cvBtn} href={store.downloadUrl(job.output_file_id)} download={outName} title="Download result">
            <Download size={12} /> Download
          </a>
        )}
        {active && <button className={styles.cvBtn} onClick={() => void store.cancelJob(job.id)}>Cancel</button>}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <button className={styles.cvBtn} title={job.error_message || ''} onClick={() => void store.retryJob(job.id)}><RotateCcw size={12} /> Retry</button>
        )}
        {!active && <button className={styles.cvIconBtn} title="Remove from history" onClick={() => void store.deleteJob(job.id)}><Trash2 size={12} /></button>}
      </span>
      {job.status === 'failed' && job.error_message && <div className={styles.cvErr} title={job.error_message}>{job.error_message}</div>}
    </div>
  )
})

export const ConvertPanel: React.FC = observer(() => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)

  useEffect(() => { void store.ensureLoaded() }, [])

  if (store.service === 'unconfigured' || store.service === 'down') {
    return (
      <div className={styles.cvWrap}>
        <div className={styles.cvNotice}>
          {store.service === 'unconfigured'
            ? 'Transmute is not configured — the proxy is missing its credentials file (.gybackend-data/transmute.json).'
            : 'The Transmute service is not responding (systemd unit "transmute" on this container). Its status is honest: this page will work as soon as the service does.'}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.cvWrap}>
      <div
        className={`${styles.cvDrop} ${drag ? styles.cvDropActive : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void store.addFiles(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={18} />
        <span>Drop files here, or click to choose. Formats are detected per file — images, video, audio, documents, spreadsheets, archives, 3D and more.</span>
        {store.uploading > 0 && <span className={styles.cvUploading}><Loader2 size={12} className={styles.cvSpin} /> uploading {store.uploading}…</span>}
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) { void store.addFiles(e.target.files); e.target.value = '' } }} />
      </div>

      {store.pending.length > 0 && (
        <div className={styles.cvSection}>
          <div className={styles.cvSectionHead}>
            Ready to convert ({store.pending.length})
            <span className={styles.spacer} />
            <button className={styles.cvPrimary} onClick={() => void store.convertAll()}>Convert all</button>
          </div>
          {store.pending.map((p) => (
            <div key={p.id} className={styles.cvRow}>
              <span className={styles.cvName} title={p.name}>{p.name}</span>
              <span className={styles.cvMuted}>{p.ext} · {fmtSize(p.size)}</span>
              <span className={styles.cvArrow}><ArrowRight size={11} /></span>
              <FormatCombo value={p.format} options={Object.keys(p.formats).sort()} onPick={(f) => store.setChoice(p.id, { format: f })} />
              {(p.formats[p.format] || []).length > 0 && (
                <select className={styles.input} value={p.quality} onChange={(e) => store.setChoice(p.id, { quality: e.target.value })}>
                  <option value="">default</option>
                  {(p.formats[p.format] || []).map((q) => <option key={q} value={q}>{q}</option>)}
                </select>
              )}
              {store.pending.filter((x) => x.ext === p.ext).length > 1 && (
                <button className={styles.cvBtn} title={`Use ${p.format} for every .${p.ext} in the list`} onClick={() => store.applyToSameType(p.id)}>apply to .{p.ext}</button>
              )}
              <button className={styles.cvIconBtn} title="Remove" onClick={() => void store.removePending(p.id)}><X size={13} /></button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.cvSection}>
        <div className={styles.cvSectionHead}>Conversions</div>
        {store.jobs.length === 0
          ? <div className={styles.cvMuted} style={{ padding: '8px 2px' }}>No conversions yet.</div>
          : store.jobs.map((jb) => <JobRow key={jb.id} job={jb} />)}
      </div>

      {store.msg && <div className={styles.cvErr}>{store.msg}</div>}
    </div>
  )
})
