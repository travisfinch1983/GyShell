import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Layers, FolderOpen, Star, X, ChevronUp, ChevronDown } from 'lucide-react'
import { trainingImagesStore as store, igThumb, igImage, igVideo, igVthumb, igDownload, imKey, cropDone, type IgImage, type BatchSection, type AutoCropJob } from '../../stores/TrainingImagesStore'
import { confirmStore } from '../../stores/confirmStore'
import { promptStore } from '../../stores/promptStore'
import { CropEditor } from './CropEditor'
import { AutoCaptionModal } from './AutoCaptionModal'
import { BlanketTagModal } from './BlanketTagModal'
import { FindReplaceModal } from './FindReplaceModal'
import { AddToPoseLibraryModal } from './AddToPoseLibraryModal'
import { CorrectCaptionsModal } from './CorrectCaptionsModal'
import { WatermarkModal } from './WatermarkModal'
import styles from './TrainingImages.module.scss'

const SORT_KEYS: { v: any; label: string }[] = [
  { v: 'name', label: 'Name' }, { v: 'created', label: 'Date created' }, { v: 'modified', label: 'Date modified' },
  { v: 'added', label: 'Date added' }, { v: 'size', label: 'Size' },
]

// ── Caption-variable manager: add / rename / delete, batch-wide ──────────────────────
// A dialog rather than a prompt chain because renaming a KEY is consequential — it is the
// token every {$KEY} in the captioner refers to — and the user should see the old name, the
// new name and the blast radius at once, not one blind box at a time.
const VariablesModal: React.FC<{ onClose: () => void }> = observer(({ onClose }) => {
  type Row = { key: string; label: string; origKey: string }
  const [rows, setRows] = useState<Row[]>(
    () => store.captionVars.fields.map((f) => ({ key: f.key, label: f.label, origKey: f.key })))
  const [addLabel, setAddLabel] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const keyify = (s: string) =>
    s.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
  const subsWith = (k: string) =>
    Object.values(store.captionVars.values).filter((v) => (v?.[k] ?? '') !== '').length

  const save = async (next: Row[]) => {
    for (const r of next) {
      if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(r.key)) { setMsg(`"${r.key}" is not a valid name — A-Z, 0-9 and _, starting with a letter.`); return }
    }
    if (new Set(next.map((r) => r.key)).size !== next.length) { setMsg('Two variables cannot share a name.'); return }
    // Values are stored under the KEY, so a rename has to carry them across or the values are
    // silently orphaned — they would vanish from the UI while still sitting in the file.
    const values: Record<string, Record<string, string>> = {}
    for (const [sub, vals] of Object.entries(store.captionVars.values)) {
      const moved: Record<string, string> = {}
      for (const r of next) {
        const v = vals?.[r.origKey]
        if (typeof v === 'string' && v !== '') moved[r.key] = v
      }
      if (Object.keys(moved).length) values[sub] = moved
    }
    setBusy(true); setMsg('Saving…')
    try {
      await store.saveCaptionVars({ fields: next.map((r) => ({ key: r.key, label: r.label })), values })
      const renamed = next.filter((r) => r.key !== r.origKey)
      store.msg = renamed.length
        ? `Saved. Renamed ${renamed.map((r) => `{$${r.origKey}} → {$${r.key}}`).join(', ')} — update any captioner field that still references the old name.`
        : 'Caption variables saved.'
      onClose()
    } catch (e: any) { setBusy(false); setMsg('Failed: ' + (e?.message || e)) }
  }

  const del = async (r: Row) => {
    const n = subsWith(r.origKey)
    const ok = await confirmStore.confirm({
      title: `Delete {$${r.key}}?`,
      message: n
        ? `${n} subsection${n > 1 ? 's have' : ' has'} a value for this variable; those values are deleted too. Any captioner field still containing {$${r.key}} will show it literally instead of substituting.`
        : `No subsection has a value for it yet. Any captioner field containing {$${r.key}} will show it literally instead of substituting.`,
      confirmText: 'Delete',
      danger: true,
    })
    if (!ok) return
    void save(rows.filter((x) => x.origKey !== r.origKey))
  }

  return (
    <div className={styles.modalBg}>
      <div className={styles.pkBox} style={{ width: 'min(620px,94%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Caption variables — {store.batchContext?.root.split('/').pop()}</strong>
          <button className={styles.btn} onClick={onClose}>Cancel</button>
        </div>
        <div className={styles.acHint}>
          Batch-wide: every subsection gets a box for each variable. Reference them in the
          captioner as {'{$NAME}'} and each resolves to THAT subsection's value during a run.
        </div>
        {rows.length === 0 && <div className={styles.dim} style={{ padding: '6px 2px' }}>No variables yet.</div>}
        {rows.map((r, i) => (
          <div key={r.origKey} className={styles.acl} style={{ justifyContent: 'flex-start', gap: 8 }}>
            <input className={styles.input} style={{ width: 170 }} disabled={busy}
                   value={r.label} placeholder="Label"
                   onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
            <span className={styles.dim}>{'{$'}</span>
            <input className={styles.input} style={{ width: 150 }} disabled={busy}
                   value={r.key} placeholder="KEY"
                   onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, key: keyify(e.target.value) } : x))} />
            <span className={styles.dim}>{'}'}</span>
            <span className={styles.dim} style={{ minWidth: 92 }}>
              {subsWith(r.origKey)} filled in
            </span>
            <button className={styles.btn} disabled={busy} title="Delete this variable everywhere"
                    onClick={() => void del(r)}>Delete</button>
          </div>
        ))}
        <div className={styles.acSection}>Add</div>
        <div className={styles.acl} style={{ justifyContent: 'flex-start', gap: 8 }}>
          <input className={styles.input} style={{ width: 220 }} disabled={busy}
                 placeholder="what it is, e.g. Colour" value={addLabel}
                 onChange={(e) => setAddLabel(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && addLabel.trim()) { setRows((rs) => [...rs, { key: keyify(addLabel), label: addLabel.trim(), origKey: keyify(addLabel) }]); setAddLabel('') } }} />
          <span className={styles.dim}>{addLabel.trim() ? `→ {$${keyify(addLabel)}}` : ''}</span>
          <button className={styles.btn} disabled={busy || !addLabel.trim() || !/^[A-Z]/.test(keyify(addLabel))}
                  onClick={() => { setRows((rs) => [...rs, { key: keyify(addLabel), label: addLabel.trim(), origKey: keyify(addLabel) }]); setAddLabel('') }}>
            Add
          </button>
        </div>
        {msg && <div className={styles.acHint}>{msg}</div>}
        <div className={styles.pkFoot}>
          <button className={styles.btnPrimary} disabled={busy} onClick={() => void save(rows)}>Save</button>
        </div>
      </div>
    </div>
  )
})

// ── Per-subsection caption variables ─────────────────────────────────────────────────
// One row of boxes per subsection, one box per batch-wide field. The captioner references
// them as {$KEY} and resolves them PER SUBSECTION at run time, so a whole batch captions in
// one pass instead of editing the naming box and re-running for every colour.
// Saved on BLUR, not per keystroke: this writes a file on the NAS and a save per character
// would be a write storm for no benefit.
const SubVars: React.FC<{ sub: string }> = observer(({ sub }) => {
  const fields = store.captionVars.fields
  const [draft, setDraft] = useState<Record<string, string>>({})
  // The store is the source of truth; `draft` only holds keystrokes for the box being typed
  // in. Seeding from the store on every render would fight the user mid-word.
  const valueOf = (k: string) => (k in draft ? draft[k] : (store.captionVars.values[sub]?.[k] ?? ''))
  if (!fields.length) return null
  const commit = async () => {
    if (!Object.keys(draft).length) return
    const next = {
      fields,
      values: { ...store.captionVars.values, [sub]: { ...(store.captionVars.values[sub] || {}), ...draft } },
    }
    setDraft({})
    try { await store.saveCaptionVars(next) } catch (e: any) { store.msg = `Variable save failed: ${e?.message || e}` }
  }
  return (
    <div className={styles.secVars}>
      {fields.map((f) => (
        <label key={f.key} title={`Referenced in the captioner as {$${f.key}}`}>
          <span className={styles.dim}>{f.label}</span>
          <input
            className={styles.input} style={{ width: 180 }}
            placeholder={`{$${f.key}}`}
            value={valueOf(f.key)}
            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            onBlur={() => void commit()}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        </label>
      ))}
    </div>
  )
})

// ── Subsection picker: EXISTING subsections listed first so a typo can't mint 20_bleu
// beside 20_blue (Travis, 2026-09-02); a new concept takes a name + repeats. ──
const SubsectionModal: React.FC<{ onClose: () => void }> = observer(({ onClose }) => {
  const [sel, setSel] = useState('')
  const [newName, setNewName] = useState('')
  const [repeats, setRepeats] = useState('10')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    const existing = store.sections.find((s) => s.folder === sel)
    const concept = existing ? existing.concept : newName.trim().replace(/[^a-zA-Z0-9_-]/g, '')
    const reps = existing ? existing.repeats : parseInt(repeats, 10)
    if (!concept) { setMsg('Pick a subsection or name a new one.'); return }
    if (!Number.isInteger(reps) || reps < 1) { setMsg('Repeats must be a positive number.'); return }
    setBusy(true); setMsg('Moving…')
    try {
      const r = await store.subsectionKeys([...store.selected], concept, reps)
      store.msg = `Moved ${r.moved} → ${r.subsection}.`
      store.exitSelection(); void store.browse(store.cwd); onClose()
    } catch (e: any) { setBusy(false); setMsg('Failed: ' + (e?.message || e)) }
  }
  return (
    <div className={styles.modalBg}>
      <div className={styles.pkBox} style={{ width: 'min(520px,94%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Move {store.selected.size} image{store.selected.size > 1 ? 's' : ''} to subsection</strong>
          <button className={styles.btn} onClick={onClose}>Cancel</button>
        </div>
        {store.sections.length > 0 && (
          <>
            <div className={styles.acSection}>Existing subsections</div>
            <div className={styles.pkFolders}>
              {store.sections.map((s) => (
                <button key={s.folder} className={styles.pkFolder}
                        style={sel === s.folder ? { outline: '2px solid var(--accent)' } : undefined}
                        onClick={() => { setSel(sel === s.folder ? '' : s.folder); setNewName('') }}>
                  📂 {s.concept} <span className={styles.dim}>×{s.repeats} · {s.count} img</span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className={styles.acSection}>New subsection</div>
        <label className={styles.acl}>Concept
          <input className={styles.input} placeholder="e.g. blue — becomes <repeats>_blue" value={newName}
                 disabled={busy} onChange={(e) => { setNewName(e.target.value); setSel('') }} />
        </label>
        <label className={styles.acl}>Repeats
          <input className={styles.input} type="number" min={1} max={999} value={repeats}
                 disabled={busy || !!sel} onChange={(e) => setRepeats(e.target.value)} />
        </label>
        <div className={styles.msg}>{msg}</div>
        <div className={styles.pkFoot}>
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} disabled={busy || (!sel && !newName.trim())} onClick={() => void go()}>
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </div>
  )
})

// ── Add the selection to a detector-training dataset (dataset-forge) ──
// The images are NOT copied: forge tiles them and records the SOURCE path, so the dataset
// stays a view over the corpus rather than a second copy of it.
const AddToDataset: React.FC<{ onClose: () => void }> = observer(({ onClose }) => {
  const [sets, setSets] = useState<{ name: string; tiles: number }[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState('')
  const [job, setJob] = useState<any>(null)
  const files = [...store.selected]

  useEffect(() => {
    fetch('/api/dataset/sets').then((r) => r.json())
      .then((d) => { setSets(d.sets || []); if (d.sets?.[0] && !name) setName(d.sets[0].name) })
      .catch((e) => setMsg(String(e.message)))
  }, [])

  // Poll the job: tiling + SAM on a few dozen images takes minutes, so this cannot be a
  // request that simply waits.
  useEffect(() => {
    if (!job?.job || job.state === 'done' || job.state === 'error') return
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/dataset/job/${job.job}`)
        const d = await r.json()
        setJob((j: any) => ({ ...j, ...d }))
        if (d.state === 'done' || d.state === 'error') clearInterval(t)
      } catch { /* keep polling; a blip is not a failure */ }
    }, 2000)
    return () => clearInterval(t)
  }, [job?.job, job?.state])

  const go = async () => {
    const ds = name.trim()
    if (!ds || !files.length) return
    setMsg('')
    try {
      // cwd-relative selection -> imagegen-root-relative, which is what the API expects
      const paths = files.map((f) => (store.cwd ? `${store.cwd}/${f}` : f))
      const r = await fetch(`/api/dataset/${encodeURIComponent(ds)}/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, unseeded: 'unlabelled' }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'ingest failed')
      setJob({ ...d, state: 'queued', done: 0, total: paths.length })
    } catch (e: any) { setMsg(String(e.message || e)) }
  }

  const done = job?.state === 'done'
  return (
    // NOT click-to-close (see the batch modal): a stray backdrop click ate typed input.
    <div className={styles.modalBg}>
      <div className={styles.pkBox} style={{ width: 'min(560px,94%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Add {files.length} image{files.length === 1 ? '' : 's'} to a detector dataset</strong>
          <button className={styles.btn} onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
        </div>
        {!job && (
          <>
            <div className={styles.pkFolders} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 8 }}>
              <select className={styles.input} value={creating ? '' : name} style={{ flex: 1 }}
                onChange={(e) => { setCreating(false); setName(e.target.value) }} disabled={creating}>
                {!sets.length && <option value="">no datasets yet</option>}
                {sets.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.tiles} tiles</option>)}
              </select>
              <label className={styles.dim} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                <input type="checkbox" checked={creating} onChange={(e) => { setCreating(e.target.checked); setName('') }} />
                new
              </label>
            </div>
            {creating && (
              <div style={{ padding: '0 8px 8px' }}>
                <input className={styles.input} autoFocus placeholder="new dataset name (a-z 0-9 _ - .)"
                  style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div className={styles.dim} style={{ padding: '0 10px 8px', lineHeight: 1.6 }}>
              Images are tiled into 768×768 and seeded with the current detector. Tiles it finds
              nothing in are held as <b>unlabelled</b> — never exported as background — so label
              them by clicking in <b>Dataset Review</b>. Originals are not copied or modified.
            </div>
          </>
        )}
        {job && (
          <div className={styles.dim} style={{ padding: '4px 10px 10px', lineHeight: 1.7 }}>
            {job.state === 'error' ? <span className={styles.error}>{job.error}</span> : (
              <>
                <b>{job.state}</b> — {job.done ?? 0}/{job.total ?? 0} images
                {job.skipped ? ` · ${job.skipped} skipped (already in the set)` : ''}
                {done && <> · <b>{job.added ?? 0} tiles added</b></>}
                {done && <div>Open <b>AI · Image Gen → Dataset Review</b> to label them.</div>}
              </>
            )}
          </div>
        )}
        <div className={styles.pkFoot}>
          {msg && <span className={styles.msg}>{msg}</span>}
          <span className={styles.spacer} />
          {!job && <button className={styles.btnPrimary} disabled={!name.trim() || !files.length}
            onClick={() => void go()}>Add</button>}
        </div>
      </div>
    </div>
  )
})

// ── Add to training batch/set: pick (or create) the folder the selection is COPIED into ──
// One modal, two kinds. Batches and sets differ only in what is listed and where a NEW one
// is created: batches under _batches/, sets inside the folder being curated (the old
// send-to-training-set convention, kept so has_training_set badges stay meaningful).
const AddToBatchModal: React.FC<{ kind: 'batch' | 'set'; files: string[]; onClose: () => void }> = ({ kind, files, onClose }) => {
  const noun = kind === 'batch' ? 'batch' : 'set'
  const [batches, setBatches] = useState<any[] | null>(null)
  const [sel, setSel] = useState('')
  const [newName, setNewName] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    (kind === 'batch' ? store.listTrainingBatches() : store.listTrainingSets())
      .then((d) => setBatches((kind === 'batch' ? d.training_batches : d.training_sets) || []))
      .catch((e) => { setBatches([]); setMsg(`Could not list ${noun}s: ` + (e?.message || e)) })
  }, [])
  const go = async () => {
    const clean = newName.trim().replace(/[^a-zA-Z0-9_-]/g, '')
    const creating = !sel && !!clean
    // A new set is created BESIDE the folder being curated, never nested inside a
    // set/batch: picking the best few out of an already-curated set into a new sibling
    // set is the whole workflow (Travis, 2026-09-02).
    const parts = store.cwd.split('/').filter(Boolean)
    while (parts.length && /^training_(set|batch)(_|$)/.test(parts[parts.length - 1])) parts.pop()
    const setBase = parts.join('/')
    const newRel = kind === 'batch'
      ? `_batches/training_batch_${clean}`
      : `${setBase ? setBase + '/' : ''}training_set_${clean}`
    const batch = sel || (creating ? newRel : '')
    if (!batch) { setMsg(`Pick a ${noun} or name a new one.`); return }
    setBusy(true); setMsg('Copying…')
    try {
      const r = await store.batchAddKeys(batch, files, creating)
      if (kind === 'set') void store.browse(store.cwd)   // a new set under cwd changes badges
      // The tag warning is the load-bearing part: an image without .txt trains UNLABELED.
      setMsg(`Copied ${r.copied}${r.replaced ? `, replaced ${r.replaced}` : ''} → ${r.batch}`
        + `${r.missing_tags?.length ? ` · ⚠ ${r.missing_tags.length} without .txt tags` : ''}`
        + `${r.not_found?.length ? ` · ${r.not_found.length} not found` : ''}`)
      setTimeout(onClose, r.missing_tags?.length ? 2600 : 1200)
    } catch (e: any) { setBusy(false); setMsg('Failed: ' + (e?.message || e)) }
  }
  return (
    <div className={styles.modalBg}>{/* deliberately NOT click-to-close: a stray backdrop click was eating typed input */}
      <div className={styles.pkBox} style={{ width: 'min(560px,94%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Add {files.length} image{files.length > 1 ? 's' : ''} to training {noun}</strong>
          <button className={styles.btn} onClick={onClose}>Cancel</button>
        </div>
        <div className={styles.acHint}>
          Copies the images and their .txt / .caption sidecars — originals stay where they are.
          Adding accumulates; nothing already in the {noun} is removed.
        </div>
        {batches === null ? <div className={styles.acHint}>Loading batches…</div> : (
          <>
            {batches.length === 0 && <div className={styles.acHint}>No training {noun}s yet — name one below to create it.</div>}
            <div className={styles.pkFolders}>
              {batches.map((b) => (
                <button key={b.path} className={styles.pkFolder}
                        style={sel === b.path ? { outline: '2px solid var(--accent)' } : undefined}
                        onClick={() => { setSel(sel === b.path ? '' : b.path); setNewName('') }}>
                  {kind === 'batch' ? '📦' : '🗂'} {b.name} <span className={styles.dim}>{b.parent || '/'} · {b.count} img</span>
                </button>
              ))}
            </div>
            <label className={styles.acl}>New {noun}
              <input className={styles.input}
                     placeholder={kind === 'batch' ? 'name — creates _batches/training_batch_<name>' : 'name — creates training_set_<name> beside this folder'}
                     value={newName}
                     disabled={busy} onChange={(e) => { setNewName(e.target.value); setSel('') }} />
            </label>
          </>
        )}
        <div className={styles.msg}>{msg}</div>
        <div className={styles.pkFoot}>
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} disabled={busy || (!sel && !newName.trim())} onClick={() => void go()}>
            {busy ? 'Copying…' : `Copy into ${noun}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Lightbox (zoom + pan) ──
// ── Video player + frame grabber ─────────────────────────────────────────────────────
// The frame is captured HERE, in the browser, from the <video> element itself — not
// re-extracted server-side at a timestamp. What lands on disk is then exactly the frame that
// was on screen when the button was pressed; seeking to "the same" time server-side picks a
// neighbouring frame often enough to be maddening when you are after one specific moment.
// Same-origin (/api/imagegen/video) so the canvas is not tainted and toDataURL works.
/** Progress of the background poster pre-warm.
 *
 *  Renders NOTHING unless a sweep is in flight — this is a status line, not a permanent widget,
 *  and on a warm tree there is nothing to say. Polls slowly: the sweep runs for ~30 minutes on
 *  a cold tree and a second of latency on the number costs nobody anything.
 */
const PosterSweepBadge: React.FC = () => {
  const [s, setS] = useState<any>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch('/api/imagegen/poster-sweep')
        const d = await r.json()
        if (alive) setS(d)
      } catch { /* the badge is never worth surfacing an error for */ }
    }
    void tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  if (!s || s.state !== 'running') return null
  const pct = s.total ? Math.floor((s.done / s.total) * 100) : 0
  return (
    <span className={styles.msg} title={`Generating video poster frames in the background so folders open instantly.\nNow: ${s.current || ''}`}>
      {`🎞 posters ${s.done}/${s.total} (${pct}%)`}
      {s.failed ? ` · ${s.failed} failed` : ''}
      <button className={styles.btn} style={{ marginLeft: 6 }} title="Stop the background sweep until the next restart"
        onClick={() => { void fetch('/api/imagegen/poster-sweep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }) }}>stop</button>
    </span>
  )
}

const VideoModal: React.FC<{ rel: string; name: string; onClose: () => void }> = ({ rel, name, onClose }) => {
  const vref = useRef<HTMLVideoElement | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [shots, setShots] = useState(0)

  const snap = async () => {
    const v = vref.current
    if (!v || !v.videoWidth) { setMsg('Video not ready yet.'); return }
    setBusy(true)
    try {
      const c = document.createElement('canvas')
      c.width = v.videoWidth; c.height = v.videoHeight
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      ctx.drawImage(v, 0, 0, c.width, c.height)
      const r = await store.saveScreenshot(rel, c.toDataURL('image/png'), v.currentTime)
      setShots((n) => n + 1)
      setMsg(`Saved ${r.name} → ${r.dir}  (${c.width}×${c.height})`)
      // The screenshots folder is new the first time; refresh so it shows up in the browser.
      if (shots === 0) void store.browse(store.cwd)
    } catch (e: any) { setMsg('Failed: ' + (e?.message || e)) }
    finally { setBusy(false) }
  }

  // Space would otherwise scroll the page behind the modal; here it is play/pause.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    const v = vref.current
    if (!v) return
    if (e.key === ' ') { e.preventDefault(); v.paused ? void v.play() : v.pause() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 1 : 1 / 30)) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); v.currentTime = v.currentTime + (e.shiftKey ? 1 : 1 / 30) }
    else if (e.key.toLowerCase() === 's') { e.preventDefault(); void snap() }
  }

  return (
    <div className={styles.modalBg} onClick={onClose} onKeyDown={onKey} tabIndex={-1} ref={(el) => el?.focus()}>
      <div className={styles.pkBox} style={{ width: 'min(1100px,96%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>{name}</strong>
          <span>
            <a className={styles.btn} href={igDownload(rel, true)} download={name} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
               title="Download the original video file">⬇ Download</a>{' '}
            <button className={styles.btn} onClick={onClose}>Close</button>
          </span>
        </div>
        <video
          ref={vref} src={igVideo(rel)} controls autoPlay={false} preload="metadata"
          style={{ width: '100%', maxHeight: '68vh', background: '#000', borderRadius: 6 }}
        />
        <div className={styles.acl} style={{ justifyContent: 'flex-start', gap: 10, marginTop: 8 }}>
          <button className={styles.btnPrimary} disabled={busy} onClick={() => void snap()}>
            📸 Snap frame
          </button>
          <span className={styles.dim}>
            saves a full-resolution PNG into <code>screenshots/</code> beside this clip
          </span>
          <span className={styles.spacer} />
          {shots > 0 && <span className={styles.dim}>{shots} grabbed</span>}
        </div>
        <div className={styles.acHint}>
          <strong>S</strong> snap · <strong>Space</strong> play/pause · <strong>←/→</strong> step one frame
          (hold <strong>Shift</strong> for a second). Pause first for the cleanest grab.
        </div>
        {msg && <div className={styles.acHint}>{msg}</div>}
      </div>
    </div>
  )
}

const Lightbox: React.FC<{ rel: string; name: string; bust?: number; onClose: () => void }> = ({ rel, name, bust, onClose }) => {
  const [z, setZ] = useState(1); const [t, setT] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const onWheel = (e: React.WheelEvent) => { const nz = Math.min(12, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 0.87))); setZ(nz); if (nz === 1) setT({ x: 0, y: 0 }) }
  return (
    <div className={styles.lbBg} onClick={onClose}>
      <div className={styles.lbBar} onClick={(e) => e.stopPropagation()}>
        <span className={styles.lbName}>{name}</span>
        <span className={styles.dim}>{Math.round(z * 100)}%</span>
        <span className={styles.spacer} />
        <span className={styles.dim}>scroll = zoom · drag = pan · dbl-click resets</span>
        <a className={styles.btn} href={igDownload(rel)} download={name} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
           title="Download the original file (full resolution, original format)">⬇ Download</a>
        <button className={styles.btn} onClick={onClose}><X size={14} /> Close</button>
      </div>
      <div className={styles.lbStage} onClick={(e) => e.stopPropagation()} onWheel={onWheel}
        onDoubleClick={() => { setZ(1); setT({ x: 0, y: 0 }) }}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y } }}
        onMouseMove={(e) => { if (drag.current && z > 1) setT({ x: drag.current.tx + (e.clientX - drag.current.x), y: drag.current.ty + (e.clientY - drag.current.y) }) }}
        onMouseUp={() => { drag.current = null }} onMouseLeave={() => { drag.current = null }}
        style={{ cursor: z > 1 ? 'grab' : 'default' }}>
        <img src={igImage(rel, bust)} alt={name} draggable={false} style={{ transform: `translate(${t.x}px,${t.y}px) scale(${z})` }} />
      </div>
    </div>
  )
}

// ── destination picker (move/copy) ──
const Picker: React.FC<{ op: 'move' | 'copy'; files: string[]; folders?: string[]; onClose: () => void; onDone: () => void }> = ({ op, files, folders = [], onClose, onDone }) => {
  // Open where the user already IS — starting at the imagegen root meant re-walking the
  // whole tree on every move/copy. The crumbs still navigate anywhere from here.
  const [pcwd, setPcwd] = useState(store.cwd)
  const [data, setData] = useState<any>(null)
  const [sub, setSub] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => { store.browseRaw(pcwd).then(setData).catch((e) => setMsg(e.message)) }, [pcwd])
  const verb = op === 'move' ? 'Move' : 'Copy'
  const go = async () => {
    let dest = pcwd || ''
    const s = sub.trim().replace(/^\/+|\/+$/g, '')
    if (s) { if (s.includes('..')) { setMsg('bad folder name'); return } dest = dest ? `${dest}/${s}` : s }
    if (dest === store.cwd && !s) { setMsg("that's the source folder"); return }
    setMsg(`${verb}ing ${files.length + folders.length}…`)
    try {
      let done = 0; let where = dest; const problems: string[] = []
      // Folders first: if a folder move fails (name collision, into-itself) the images
      // have not been scattered yet and the whole thing can be retried as one.
      if (folders.length) {
        const rf = await store.transferFolders(op, dest, folders)
        done += rf.done || 0; where = rf.dest || where
        for (const e of rf.errors || []) problems.push(`${e.name}: ${e.why}`)
      }
      if (files.length) {
        const r = await store.transferKeys(op, dest, files)
        done += r.done || 0; where = r.dest || where
      }
      setMsg(problems.length
        ? `${verb}d ${done} → ${where}. Skipped: ${problems.join('; ')}`
        : `${verb}d ${done} → ${where}`)
      // Leave a failure on screen to be read; only auto-close on a clean run.
      if (!problems.length) setTimeout(() => { onClose(); onDone() }, 700)
      else onDone()
    }
    catch (e: any) { setMsg('Failed: ' + (e?.message || e)) }
  }
  return (
    <div className={styles.modalBg}>{/* deliberately NOT click-to-close: a stray backdrop click was eating typed input */}
      <div className={styles.pkBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}><strong>{verb} {[files.length && `${files.length} image${files.length > 1 ? 's' : ''}`, folders.length && `${folders.length} folder${folders.length > 1 ? 's' : ''}`].filter(Boolean).join(' + ')} to…</strong><button className={styles.btn} onClick={onClose}>Cancel</button></div>
        <div className={styles.crumbs}>
          <a onClick={() => setPcwd('')}>training_images</a>
          {(data?.crumbs || []).map((c: any) => <span key={c.path}> / <a onClick={() => setPcwd(c.path)}>{c.name}</a></span>)}
        </div>
        <div className={styles.pkFolders}>
          {(data?.folders || []).map((f: any) => {
            const fp = (data.path ? data.path + '/' : '') + f.name
            return <button key={fp} className={styles.pkFolder} onClick={() => setPcwd(fp)}>📁 {f.name} <span className={styles.dim}>{f.n_images} img</span></button>
          })}
          {!(data?.folders || []).length && <div className={styles.dim}>No subfolders here.</div>}
        </div>
        <div className={styles.pkFoot}>
          <input className={styles.input} placeholder="new subfolder (optional)…" value={sub} onChange={(e) => setSub(e.target.value)} />
          <span className={styles.spacer} />
          {/* The destination is pcwd PLUS any new subfolder — showing only pcwd made a
              typed folder name look like it had been ignored. */}
          <span className={styles.dim}>→ {[pcwd || 'training_images', sub.trim().replace(/^\/+|\/+$/g, '')].filter(Boolean).join('/')}</span>
          {/* Was disabled whenever the picker sat on the SOURCE folder, which also blocked
              creating a NEW SUBFOLDER inside it — you had to navigate out and back in to
              make one. A new subfolder is a different destination, so only the bare
              same-folder case is a no-op. */}
          <button className={styles.btnPrimary} disabled={!sub.trim() && (pcwd || '') === (store.cwd || '')} onClick={() => void go()}>{verb} here</button>
        </div>
        {msg && <div className={styles.dim}>{msg}</div>}
      </div>
    </div>
  )
}

// ── merge modal ──
const MergeModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [sets, setSets] = useState<any[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [name, setName] = useState(''); const [msg, setMsg] = useState('')
  useEffect(() => { store.listTrainingSets().then((d) => setSets(d.training_sets || [])).catch((e) => setMsg(e.message)) }, [])
  const go = async () => {
    if (!name.trim()) { setMsg('name required'); return }
    if (!chosen.size) { setMsg('pick at least one set'); return }
    setMsg(`Merging ${chosen.size}…`)
    try { const r = await store.merge(name.trim(), [...chosen]); setMsg(`Created ${r.dest} (${r.copied} images).`); setTimeout(() => { onClose(); void store.browse(r.dest) }, 700) }
    catch (e: any) { setMsg('Failed: ' + (e?.message || e)) }
  }
  return (
    <div className={styles.modalBg}>{/* deliberately NOT click-to-close: a stray backdrop click was eating typed input */}
      <div className={styles.pkBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}><strong>Merge training sets</strong><button className={styles.btn} onClick={onClose}>Close</button></div>
        <div className={styles.dim}>Images are copied into a new independent set under <code>_merged/</code> — editing there won't touch the originals.</div>
        <div className={styles.mgList}>
          {sets.map((s) => (
            <label key={s.path} className={styles.mgRow}>
              <input type="checkbox" checked={chosen.has(s.path)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(s.path) : n.delete(s.path); setChosen(n) }} />
              <span className={styles.mgPath}>{s.path}</span><span className={styles.dim}>{s.count} img{s.merged ? ' · merged' : ''}</span>
            </label>
          ))}
          {!sets.length && <div className={styles.dim}>No training sets yet.</div>}
        </div>
        <div className={styles.pkFoot}>
          <input className={styles.input} placeholder="new merged set name (e.g. yellows_all)" value={name} onChange={(e) => setName(e.target.value)} />
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} onClick={() => void go()}>Create merged set</button>
        </div>
        {msg && <div className={styles.dim}>{msg}</div>}
      </div>
    </div>
  )
}

// ── Auto-crop ──
// A detector finds the subject in each image and a 1024x1024 crop is centred on it. Images it
// finds nothing in get a yellow border and the "Needs review" filter. Every crop snapshots the
// original first, so a bad one is undone with the editor's restore, exactly like a manual crop.
const AutoCropModal: React.FC<{ onClose: () => void }> = observer(({ onClose }) => {
  const [dets, setDets] = useState<Array<{ rel: string; name: string; kind: string }>>([])
  const [det, setDet] = useState('')
  const [conf, setConf] = useState('0.25')
  const [overwrite, setOverwrite] = useState(false)
  const [job, setJob] = useState<AutoCropJob | null>(null)
  const [err, setErr] = useState('')
  const useSel = store.selectionMode && store.selected.size > 0
  const pool = store.images.filter((im) => !im.is_video && (useSel ? store.selected.has(imKey(im)) : true))
  const files = pool.filter((im) => overwrite || !cropDone(im)).map((im) => im.rel)
  useEffect(() => {
    store.autoCropDetectors()
      .then((d) => { setDets(d.detectors); setDet(d.default || d.detectors[0]?.rel || '') })
      .catch((e) => setErr(String(e?.message || e)))
    // Re-attach to a run that is still going (the dialog was closed and reopened).
    store.autoCropStatus().then((j) => { if (j && j.state === 'running') setJob(j) }).catch(() => { /* none */ })
  }, [])
  useEffect(() => {
    if (!job || job.state !== 'running') return
    const t = setInterval(async () => {
      try {
        const j = await store.autoCropStatus()
        if (j) setJob(j)
        if (j && j.state !== 'running') void store.browse(store.cwd)   // show the new crops + flags
      } catch (e: any) { setErr(String(e?.message || e)) }
    }, 1500)
    return () => clearInterval(t)
  }, [job?.state])
  const start = async () => {
    setErr('')
    const c = parseFloat(conf)
    if (!(c > 0 && c < 1)) { setErr('Confidence must be between 0 and 1.'); return }
    try { setJob(await store.startAutoCrop(files, det, c, overwrite)) } catch (e: any) { setErr(String(e?.message || e)) }
  }
  const running = job?.state === 'running'
  return (
    <div className={styles.modalBg}>
      <div className={styles.pkBox} style={{ width: 'min(560px,94%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>✂ Auto-crop</strong><span className={styles.spacer} />
          <button className={styles.btn} onClick={onClose} title={running ? 'Close — the run keeps going; reopen to watch it' : 'Close'}><X size={14} /></button>
        </div>
        {!job || !running ? (
          <>
            <label className={styles.sortLbl}>Detector
              <select className={styles.input} value={det} onChange={(e) => setDet(e.target.value)} style={{ maxWidth: 380 }}>
                {dets.map((d) => <option key={d.rel} value={d.rel}>{d.name}{d.kind === 'bbox' ? ' (bbox)' : ''}</option>)}
              </select>
            </label>
            <label className={styles.sortLbl}>Min confidence
              <input className={styles.input} style={{ width: 70 }} value={conf} onChange={(e) => setConf(e.target.value)} />
            </label>
            <label className={styles.sortLbl}>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              Re-crop images that are already cropped / at 1024 (always crops from the original)
            </label>
            <div className={styles.dim}>
              {useSel ? `Scope: the ${store.selected.size} selected image(s)` : 'Scope: every image in this view'} — {files.length} to process.
              A 1024×1024 crop is centred on the best detection (larger if the detection is bigger, never past the image edge).
              No detection → yellow border + "Needs review". Undo any crop with the editor's restore.
            </div>
          </>
        ) : null}
        {job && (
          <div className={styles.dim} style={{ marginTop: 8 }}>
            {job.state === 'running' ? 'Running' : job.state === 'done' ? 'Done' : job.state === 'cancelled' ? 'Cancelled' : 'Failed'}:
            {' '}{job.done}/{job.total} · cropped {job.cropped} · needs review {job.review} · skipped {job.skipped}
            {job.errors.length ? ` · errors ${job.errors.length}` : ''}
            {job.error && <div style={{ color: '#f87171' }}>{job.error}</div>}
            {job.errors.length > 0 && <div style={{ maxHeight: 90, overflow: 'auto' }}>{job.errors.slice(0, 20).map((e) => <div key={e}>{e}</div>)}</div>}
          </div>
        )}
        {err && <div style={{ color: '#f87171' }}>{err}</div>}
        <div className={styles.pkFoot}>
          <span className={styles.spacer} />
          {running
            ? <button className={styles.btn} onClick={() => void store.cancelAutoCrop()}>Cancel run</button>
            : <button className={styles.btnPrimary} disabled={!det || !files.length} onClick={() => void start()}>
                {job ? 'Run again' : 'Start'} ({files.length})
              </button>}
        </div>
      </div>
    </div>
  )
})

// ── Drag images into subsections ──
// Dragging a SELECTED image carries the whole selection; an unselected one carries just itself.
const AIG_DRAG = 'application/x-aig-keys'
const dragHasKeys = (e: React.DragEvent) => Array.from(e.dataTransfer.types || []).includes(AIG_DRAG)

/** Drop target for one subsection: an expanded panel or a collapsed tile. The enter/leave counter
 *  keeps the highlight steady while the pointer crosses child elements. */
const SecDrop: React.FC<{ folder: string; className?: string; title?: string; onClick?: () => void; children: React.ReactNode }> =
  observer(({ folder, className, title, onClick, children }) => {
    const [over, setOver] = useState(0)
    return (
      <div className={`${className || ''} ${over ? styles.dropOver : ''}`} title={title} onClick={onClick}
        onDragEnter={(e) => { if (!dragHasKeys(e)) return; e.preventDefault(); setOver((n) => n + 1) }}
        onDragOver={(e) => { if (!dragHasKeys(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
        onDragLeave={(e) => { if (!dragHasKeys(e)) return; setOver((n) => Math.max(0, n - 1)) }}
        onDrop={(e) => {
          if (!dragHasKeys(e)) return
          e.preventDefault(); e.stopPropagation(); setOver(0)
          let keys: string[] = []
          try { keys = JSON.parse(e.dataTransfer.getData(AIG_DRAG)) } catch { /* not ours */ }
          if (keys.length) void store.dropIntoSection(keys, folder)
        }}>
        {children}
      </div>
    )
  })

/** A collapsed subsection: one tile, covered by one of its own images. Click to expand. */
const CollapsedSecTile: React.FC<{ meta: BatchSection }> = observer(({ meta }) => {
  const imgs = store.imagesInSub(meta.folder)
  const cover = imgs.find((im) => !im.is_video) || imgs[0]
  return (
    <SecDrop folder={meta.folder} className={`${styles.tile} ${styles.secCollapsed}`}
      title={`${meta.concept}: ${meta.count} image(s), ×${meta.repeats}. Click to expand. Drop images here to move them in.`}
      onClick={() => store.toggleCollapsed(meta.folder)}>
      {cover
        ? <img src={cover.is_video ? igVthumb(cover.rel, cover.mtime) : igThumb(cover.rel, cover.mtime)} alt="" loading="lazy" draggable={false} />
        : <span className={styles.folderThumbEmpty}><Layers size={30} /></span>}
      <span className={styles.secCount}>{meta.count}</span>
      <span className={styles.folderFoot}>
        <span className={styles.folderName}>{meta.concept}</span>
        <span className={styles.folderMeta}>×{meta.repeats} · collapsed</span>
      </span>
    </SecDrop>
  )
})

const Tile: React.FC<{ im: IgImage; i: number; onOpen: () => void }> = observer(({ im, i, onOpen }) => {
  const sel = store.selected.has(imKey(im))
  const timer = useRef<any>(null); const longRef = useRef(false); const down = useRef({ x: 0, y: 0 })
  const label = im.w && im.h ? `${im.w}×${im.h}` : im.name
  return (
    <div className={`${styles.tile} ${cropDone(im) ? (im.auto_cropped ? styles.tileAuto : styles.tileDone) : im.is_video ? '' : im.needs_review ? styles.tileReview : styles.tileTodo} ${sel ? styles.tileSel : ''}`}
      draggable
      onDragStart={(e) => {
        // A drag is not a long-press: cancel the pending select-on-hold.
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        const keys = store.selected.has(imKey(im)) ? [...store.selected] : [imKey(im)]
        e.dataTransfer.setData(AIG_DRAG, JSON.stringify(keys))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onMouseDown={(e) => { if (e.button !== 0) return; longRef.current = false; down.current = { x: e.clientX, y: e.clientY }; timer.current = setTimeout(() => { longRef.current = true; if (!store.selectionMode) store.enterSelection(); if (!store.selected.has(imKey(im))) store.toggleOne(i); store.lastIndex = i }, 400) }}
      onMouseMove={(e) => { if (timer.current && (Math.abs(e.clientX - down.current.x) > 6 || Math.abs(e.clientY - down.current.y) > 6)) { clearTimeout(timer.current); timer.current = null } }}
      onMouseLeave={() => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }}
      onMouseUp={() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        if (longRef.current) { longRef.current = false; return }
        // ALWAYS open. Selection used to hijack this click whenever selectionMode was on,
        // which made the crop editor unreachable for as long as anything was ticked --
        // viewing an image and choosing images to act on are not modes of each other.
        // Ticking lives on the .pick circle below (shift+click there for a range).
        onOpen()
      }}>
      {/* mousedown/mouseup must not reach the tile: mouseup precedes click, and the
          tile's mouseup opens the editor — which made circle-clicks look broken (they
          entered selection mode AND opened the image on top of it). */}
      <span className={styles.pick}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        title="Select — shift-click to select a range"
        onClick={(e) => {
          e.stopPropagation()
          if (!store.selectionMode) store.enterSelection()
          // Range-select moved here with the rest of selection. lastIndex can be stale after
          // a filter change (it indexes visibleImages), so bound it rather than trusting it.
          if (e.shiftKey && store.lastIndex != null && store.lastIndex < store.visibleImages.length) {
            store.selectRange(store.lastIndex, i)
          } else {
            store.toggleOne(i); store.lastIndex = i
          }
        }} />
      {cropDone(im) && (
        <span className={`${styles.bdg} ${styles.bdgCrop}`}
              title={im.cropped ? 'Cropped here' : `Already ${im.w}×${im.h} — no crop needed`}>✓</span>
      )}
      {im.auto_cropped && <span className={`${styles.bdg} ${styles.bdgAuto}`} title={`Auto-cropped${im.auto_score != null ? ` (detection ${Math.round(im.auto_score * 100)}%)` : ''} — check it; restore in the editor to undo`}>AI</span>}
      {im.needs_review && <span className={`${styles.bdg} ${styles.bdgReview}`} title="Auto-crop found nothing here — crop by hand">?</span>}
      {im.has_alt && <span className={styles.bdg} title="Upscaled — swap available in editor">⤴</span>}
      {im.wm && <span className={styles.bdg} title={im.wm === 'cleaned' ? 'Watermark removed — the original is kept; ⇄ in the editor switches back' : 'Showing the ORIGINAL — a watermark-removed version is parked; ⇄ in the editor brings it back'}>{im.wm === 'cleaned' ? '🧽' : '🧽↩'}</span>}
      {im.has_caption && <span className={styles.bdg} title="Has tags (.txt)">✎</span>}
      {im.has_nl_caption && <span className={styles.bdg} title="Has caption (.caption)">❝</span>}
      {!!im.score && <span className={`${styles.bdg} ${styles.bdgScore}`} title={`Rating ${im.score}/10${im.comment ? ' — ' + im.comment : ''}`}>★{im.score}</span>}
      {im.is_video && <span className={styles.bdg} title="Video — open to play and grab frames">▶</span>}
      {/* Videos use the ffmpeg poster endpoint; /thumb is sharp and cannot read a container. */}
      <img loading="lazy" src={im.is_video ? igVthumb(im.rel, im.mtime) : igThumb(im.rel, im.mtime)} alt="" draggable={false} />
      <span className={styles.tileName} title={im.name}>{label}</span>
    </div>
  )
})

export const TrainingImagesPanel: React.FC = observer(() => {
  const [lb, setLb] = useState<{ rel: string; name: string; bust?: number } | null>(null)
  const [vid, setVid] = useState<{ rel: string; name: string } | null>(null)
  const [picker, setPicker] = useState<'move' | 'copy' | null>(null)
  const [merge, setMerge] = useState(false)
  const [crop, setCrop] = useState<{ rel: string; name: string } | null>(null)
  const cropIdxRef = useRef(0)
  // undefined = whole folder; a list = caption only these (selection, or one from the editor)
  const [capFiles, setCapFiles] = useState<string[] | undefined>(undefined)
  const [varsModal, setVarsModal] = useState(false)
  const [autoCap, setAutoCap] = useState(false)
  const [autoCrop, setAutoCrop] = useState(false)
  const [blanket, setBlanket] = useState(false)
  const [findRep, setFindRep] = useState(false)
  const [poseAdd, setPoseAdd] = useState(false)
  const [correct, setCorrect] = useState(false)
  const [dsAdd, setDsAdd] = useState(false)
  const [batchAdd, setBatchAdd] = useState(false)
  const [setAdd, setSetAdd] = useState(false)
  const [subMove, setSubMove] = useState(false)
  // rels to clean: the selection (selection bar) or the open image (editor's button)
  const [wmFiles, setWmFiles] = useState<string[] | null>(null)
  useEffect(() => { void store.browse(''); void store.resumeWatermarkJobs() }, [])
  // In a training_set, click = crop/resize editor; elsewhere, click = zoom preview.
  // The crop editor is really the image DETAIL view — it carries the crop box, the .txt tag
  // box, the .caption box and the rating together. It used to open only inside a training_set,
  // which meant tags could not be read or edited anywhere else, even though the tagger writes
  // sidecars into any folder. Collages still open in the lightbox.
  // A video has nothing to crop — it opens the player, which is also where frames are grabbed.
  // The ONE router for "open this item". The grid click and the editor's arrow-paging both
  // come through here. Paging used to re-derive the decision inline and call setCrop()
  // unconditionally, so stepping off an image walked the next VIDEO into the still-frame
  // crop editor — 235 of the 670 files in aniaspoison are video, so it fired immediately.
  // Download the selection as ORIGINAL files. One anchor click per file, spaced out: browsers
  // drop rapid-fire programmatic downloads, and the spacing lets the "allow multiple downloads"
  // prompt appear once instead of eating files.
  const doDownload = async () => {
    const byKey = new Map(store.visibleImages.map((im) => [imKey(im), im]))
    const items = [...store.selected].map((k) => byKey.get(k)).filter((im): im is IgImage => !!im)
    if (!items.length) { store.msg = 'Nothing selected to download.'; return }
    for (const [i, im] of items.entries()) {
      const a = document.createElement('a')
      a.href = igDownload(im.rel, !!im.is_video)
      a.download = im.name
      document.body.appendChild(a); a.click(); a.remove()
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, 350))
    }
    store.msg = `Downloading ${items.length} file${items.length > 1 ? 's' : ''}…`
  }
  const openImage = (im: IgImage) => {
    if (im.is_video) { setCrop(null); setVid({ rel: im.rel, name: im.name }) }
    else { setVid(null); setCrop({ rel: im.rel, name: im.name }) }
  }

  const doDelete = async () => {
    // Folders are selectable now, so a Delete that only ever removed images would
    // silently ignore half the selection — the exact shape of bug this panel keeps
    // producing. Count the folder subtrees first (the server reports without deleting)
    // so ONE dialog can state the whole blast radius.
    const folderNames = [...store.selectedFolders]
    let folderImgs = 0, folderSubs = 0
    for (const fn of folderNames) {
      const rel = store.cwd ? `${store.cwd}/${fn}` : fn
      try {
        const info = await store.deleteFolder(rel, false)
        if (info?.error) { store.msg = `${fn}: ${info.error}`; return }
        folderImgs += info.n_images || 0; folderSubs += info.n_subfolders || 0
      } catch (e: any) { store.msg = 'Failed: ' + (e?.message || e); return }
    }
    const n = store.selected.size
    if (!n && !folderNames.length) return
    const inSet = store.inTrainingSet
    const parts: string[] = []
    if (n) {
      parts.push(inSet
        ? `${n} image${n > 1 ? 's' : ''} from this set (originals are not affected)`
        : `${n} image${n > 1 ? 's' : ''} and their .txt/.caption sidecars — these ARE the originals`)
    }
    if (folderNames.length) {
      parts.push(`${folderNames.length} folder${folderNames.length > 1 ? 's' : ''} `
        + `(${folderNames.join(', ')}) and everything inside them — ${folderImgs} image${folderImgs === 1 ? '' : 's'}`
        + `${folderSubs ? `, ${folderSubs} subfolder${folderSubs > 1 ? 's' : ''}` : ''}`)
    }
    if (!(await confirmStore.confirm({
      title: folderNames.length ? 'Delete selection' : (inSet ? 'Delete from training set' : 'Delete images'),
      message: `Permanently delete:\n\n• ${parts.join('\n• ')}\n\nThis cannot be undone.`,
      confirmText: 'Delete' }))) return
    store.msg = `Deleting ${n + folderNames.length}…`
    try {
      let imgs = 0
      if (n) imgs = (await store.deleteSelected()).deleted || 0
      let folds = 0
      for (const fn of folderNames) {
        const rel = store.cwd ? `${store.cwd}/${fn}` : fn
        const r = await store.deleteFolder(rel, true)
        if (r?.error) { store.msg = `${fn}: ${r.error}`; break }
        folds++
      }
      store.msg = `Deleted ${imgs} image(s)${folds ? ` and ${folds} folder(s)` : ''}.`
      void store.browse(store.cwd)
    }
    catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }
  // Rename any folder. Sets and batches keep the suffix flow (the server rebuilds the
  // name from the kind prefix, so a rename cannot turn a set into a batch); everything
  // else renames freely.
  const doRenameAnyFolder = async (rel: string, name: string) => {
    if (name.startsWith('training_set') || name.startsWith('training_batch')) return doRename(rel, name)
    const next = await promptStore.prompt({ title: 'Rename folder', placeholder: 'folder name', defaultValue: name, confirmText: 'Rename' })
    if (next === null) return
    const want = next.trim()
    if (!want || want === name) return
    try {
      const r = await store.renameFolder(rel, want)
      if (r?.error) { store.msg = r.error; return }
      store.msg = `Renamed to ${want}.`
      void store.browse(store.cwd)
    } catch (e: any) { store.msg = 'Rename failed: ' + (e?.message || e) }
  }

  // Delete a folder and everything under it. The server counts the subtree first and
  // deletes nothing until we send the count back, so the dialog can name the real blast
  // radius — "delete this folder?" on something holding four training sets is how you
  // lose work you meant to rename.
  const doDeleteFolder = async (rel: string, name: string) => {
    let info: any
    try { info = await store.deleteFolder(rel, false) }
    catch (e: any) { store.msg = 'Failed: ' + (e?.message || e); return }
    if (info?.error) { store.msg = info.error; return }
    const bits = [
      info.n_images ? `${info.n_images} image${info.n_images > 1 ? 's' : ''}` : '',
      info.n_subfolders ? `${info.n_subfolders} subfolder${info.n_subfolders > 1 ? 's' : ''}` : '',
      info.n_other_files ? `${info.n_other_files} other file${info.n_other_files > 1 ? 's' : ''}` : '',
    ].filter(Boolean)
    const what = bits.length ? bits.join(', ') : 'nothing — it is empty'
    if (!(await confirmStore.confirm({
      title: `Delete folder "${name}"`,
      message: `Permanently delete ${name} and everything inside it?\n\nIt contains: ${what}.\n\nThis cannot be undone.`,
      confirmText: 'Delete folder',
    }))) return
    store.msg = `Deleting ${name}…`
    try {
      const r = await store.deleteFolder(rel, true)
      if (r?.error) { store.msg = r.error; return }
      store.msg = `Deleted ${name} (${r.n_images} image(s)).`
      void store.browse(store.cwd)
    } catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }

  // Pin one image as the tile picture for the folder we are looking at, so the parent
  // listing shows a representative frame rather than whichever file sorts first.
  const doPinPreview = async (name: string) => {
    try {
      const r = await store.setFolderPreview(store.cwd, name)
      store.msg = r?.error ? r.error : `Folder preview set to ${name}.`
    } catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }

  const doStrip = async (files?: string[]) => {
    const scope = files?.length ? `${files.length} image(s)` : 'EVERY image in this set'
    if (!(await confirmStore.confirm({ title: 'Strip booru tags (.txt)', message: `Delete the .txt tag sidecars for ${scope}? Images and .caption files are untouched. Cannot be undone.`, confirmText: 'Strip' }))) return
    store.msg = 'Stripping tags…'
    try { const r = files?.length ? await store.stripKeys(files) : await store.stripTags(); store.msg = `Stripped ${r.removed} tag file(s).`; void store.browse(store.cwd) }
    catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }
  const doWipe = async (files?: string[]) => {
    const scope = files?.length ? `${files.length} selected image(s)` : `all ${store.ratedCount} rated image(s) in this ${store.inTrainingSet ? 'training set' : 'folder'}`
    if (!(await confirmStore.confirm({ title: 'Wipe ratings & comments', message: `Clear ratings and comments for ${scope}? This removes scores + notes only — images, tags, and captions are untouched. Cannot be undone.`, confirmText: 'Wipe' }))) return
    store.msg = 'Wiping ratings…'
    try { const r = files?.length ? await store.wipeKeys(files) : await store.wipeRatings(); store.msg = `Wiped ${r.cleared} rating(s).`; void store.browse(store.cwd) }
    catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }
  const doSectionCollage = async (sub: string) => {
    store.msg = `Generating ${sub} collage…`
    try {
      const r = await store.genCollage(sub)
      store.msg = `Collage: ${r.total} images, ${r.page_count} page(s).`
      if (r.pages?.[0]) setLb({ rel: r.pages[0].path, name: `${sub} collage`, bust: Date.now() })
      void store.browse(store.cwd)
    } catch (e: any) { store.msg = 'Collage failed: ' + (e?.message || e) }
  }
  const doRepeats = async (folderPath: string, f: any) => {
    const repStr = await promptStore.prompt({ title: `Repeats for "${f.concept}"`, placeholder: 'kohya per-epoch repeats', defaultValue: String(f.repeats), confirmText: 'Set' })
    if (repStr === null) return
    const repeats = parseInt(repStr, 10)
    if (!Number.isInteger(repeats) || repeats < 1) { store.msg = 'Repeats must be a positive number.'; return }
    try { await store.setSubsectionRepeats(folderPath, repeats); void store.browse(store.cwd) }
    catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }
  const doRenameFiles = async () => {
    const base = await promptStore.prompt({ title: `Rename ${store.selected.size} images`, placeholder: 'base name, e.g. white → white-1..N (lowercased)', confirmText: 'Rename' })
    if (base === null || !base.trim()) return
    // Number in DISPLAY order, not click order — white-1 is the first tile on screen.
    const ordered = store.visibleImages.filter((im) => store.selected.has(imKey(im))).map((im) => imKey(im))
    store.msg = `Renaming ${ordered.length}…`
    try {
      const r = await store.renameKeys(ordered, base.trim())
      store.msg = `Renamed ${r.renamed} → ${base.trim().toLowerCase()}-1..N${r.groups > 1 ? ` (numbering restarts per subsection, ${r.groups} groups)` : ''}${r.ratings_moved ? ` · ${r.ratings_moved} ratings followed` : ''}.`
      store.exitSelection(); void store.browse(store.cwd)
    } catch (e: any) { store.msg = 'Rename failed: ' + (e?.message || e) }
  }
  const doRename = async (path: string, name: string) => {
    // Sets and batches share the flow; the server keeps the prefix that matches what the
    // folder IS, so a rename can never turn one kind into the other.
    const isBatch = name.startsWith('training_batch')
    const cur = name.replace(/^training_(set|batch)_?/, '')
    const suffix = await promptStore.prompt({ title: isBatch ? 'Rename training batch' : 'Rename training set', placeholder: `suffix (blank = plain training_${isBatch ? 'batch' : 'set'})`, defaultValue: cur, confirmText: 'Rename' })
    if (suffix === null) return
    try { await store.renameSet(path, suffix); void store.browse(store.cwd) } catch (e: any) { store.msg = 'Rename failed: ' + (e?.message || e) }
  }
  const doCollage = async () => { store.msg = 'Generating collage…'; try { const r = await store.genCollage(); store.msg = `Collage: ${r.total} images, ${r.page_count} page(s).`; if (r.pages?.[0]) setLb({ rel: r.pages[0].path, name: 'collage', bust: Date.now() }); void store.browse(store.cwd) } catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) } }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <button className={styles.btn} onClick={() => setMerge(true)}><Layers size={14} /> Merge sets…</button>
        <label className={styles.sortLbl}>Sort
          <select className={styles.input} value={store.sortKey} onChange={(e) => store.setSort(e.target.value as any)}>
            {SORT_KEYS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
        </label>
        <button className={styles.btn} title="Toggle asc/desc" onClick={() => store.toggleDir()}>{store.sortDir === 'desc' ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
        {store.images.length > 0 && (
          <label className={styles.sortLbl}>Show
            <select className={styles.input} value={store.cropFilter} onChange={(e) => store.setCropFilter(e.target.value as any)}>
              <option value="all">All ({store.images.length})</option>
              <option value="uncropped">Needs crop ({store.images.filter((im) => !cropDone(im)).length})</option>
              <option value="cropped">At 1024 / cropped ({store.images.filter((im) => cropDone(im)).length})</option>
              <option value="review">Needs review ({store.images.filter((im) => !!im.needs_review).length})</option>
            </select>
          </label>
        )}
        {store.ratedCount > 0 && (
          <button className={styles.btn} title="Clear all ratings + comments in this folder/set (images, tags & captions untouched)" onClick={() => void doWipe()}>
            <Star size={14} /> Wipe ratings ({store.ratedCount})
          </button>
        )}
        {!store.selectionMode && store.visibleImages.length > 0 && (
          <button className={styles.btn} title="Select every image shown (respects the crop filter)"
                  onClick={() => { store.enterSelection(); store.selectAll() }}>
            Select all ({store.visibleImages.length})
          </button>
        )}
        <span className={styles.spacer} />
        <button
          className={styles.btn}
          title={store.showAllRoots
            ? 'Showing every folder under /ai-assets/imagegen — click to show only training folders'
            : 'Showing training folders only — click to browse the whole imagegen tree'}
          onClick={() => store.toggleShowAllRoots()}
        >
          {store.showAllRoots ? 'All folders' : 'Training only'}
        </button>
        <button className={styles.btn} onClick={() => void store.browse(store.cwd)}><RefreshCw size={14} className={store.loading ? styles.spin : ''} /></button>
      </div>

      {/* Caption progress renders in the notifications panel's Task Progress section
          (bell, any page) — the store keeps polling so the grid still refreshes on completion. */}

      <div className={styles.crumbs}>
        <a onClick={() => void store.browse('')}>training_images</a>
        {store.crumbs.map((c) => <span key={c.path}> / <a onClick={() => void store.browse(c.path)}>{c.name}</a></span>)}
      </div>

      {store.images.length > 0 && (
        <div className={styles.setbar}>
          <button className={styles.btn}
            title={store.selectionMode && store.selected.size ? 'Caption ONLY the selected images' : 'Caption every image in this folder'}
            onClick={() => {
              setCapFiles(store.selectionMode && store.selected.size
                ? store.visibleImages.filter((im) => store.selected.has(imKey(im))).map((im) => imKey(im))
                : undefined)
              setAutoCap(true)
            }}>
            {store.selectionMode && store.selected.size ? `🏷 Auto-caption (${store.selected.size})…` : '🏷 Auto-caption…'}
          </button>
          {(store.inTrainingSet || store.batchContext) && (
            <button className={styles.btn}
              title="Detect the subject in each image and centre a 1024×1024 crop on it; images with no detection are flagged for review"
              onClick={() => setAutoCrop(true)}>
              {store.selectionMode && store.selected.size ? `✂ Auto-crop (${store.selected.size})…` : '✂ Auto-crop…'}
            </button>
          )}
          {/* 🛑 NOT in the selection bar. Adding a variable is a property of the BATCH, not of
              whatever happens to be selected — putting it there meant the only way to create
              the first variable was to select images first, and with zero fields the
              per-subsection boxes render nothing, so there was no other way in at all. */}
          {store.batchContext && (
            <button
              className={styles.btn}
              title="Add a caption variable to EVERY subsection of this batch. Fill it in per subsection, then reference it in the captioner as {$KEY} — it resolves to that subsection's value during a bulk run."
              onClick={() => setVarsModal(true)}
            >{'{$}'} Variables{store.captionVars.fields.length ? ` (${store.captionVars.fields.length})` : ''}…</button>
          )}
          <button className={styles.btn} title="Add or remove the same booru tags across this folder" onClick={() => setBlanket(true)}>🏷 Blanket tags…</button>
          <button className={styles.btn} title="Replace text across the .txt and .caption sidecars in this folder — preview before applying" onClick={() => setFindRep(true)}>🔎 Find &amp; replace…</button>
          <button className={styles.btn} title="Have a text model correct the captions in this folder against an instruction — for what a literal find &amp; replace cannot catch. Preview before applying." onClick={() => setCorrect(true)}>✏️ Correct captions…</button>
          <button className={styles.btn} onClick={() => void doCollage()}>🖼 Generate collage</button>
          {store.hasCollage && <button className={styles.btn} onClick={() => setLb({ rel: `${store.cwd}/${store.collageFirst}`, name: 'collage', bust: Date.now() })}>View collage</button>}
          <button className={styles.btn} onClick={() => void doStrip()}>🧹 Strip tags</button>
          <span className={styles.msg}>{store.msg}</span>
          <PosterSweepBadge />
        </div>
      )}

      {store.selectionMode && (
        <div className={styles.selbar}>
          <button className={styles.iconBtn} title="Clear" onClick={() => store.exitSelection()}><X size={14} /></button>
          <span>{[store.selected.size && `${store.selected.size} image${store.selected.size > 1 ? 's' : ''}`, store.selectedFolders.size && `${store.selectedFolders.size} folder${store.selectedFolders.size > 1 ? 's' : ''}`].filter(Boolean).join(' + ') || '0'} selected</span>
          <button className={styles.btn} onClick={() => store.selectAll()}>Select all ({store.visibleImages.length})</button>
          <button className={styles.btn} disabled={!store.pickedCount} onClick={() => store.deselectAll()}>Deselect all</button>
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} title="Copy the selection + caption sidecars into an existing training set, or create a new one beside this folder — works from inside a set too, for cherry-picking an already-curated selection" onClick={() => setSetAdd(true)}>Add to Training Set</button>
          <button className={styles.btn} onClick={() => setPicker('move')}>Move…</button>
          <button className={styles.btn} onClick={() => setPicker('copy')}>Copy…</button>
          <button className={styles.btn} title="Copy the selection + caption sidecars into a training batch assembled from many sets" onClick={() => setBatchAdd(true)}>Add to batch…</button>
          <button className={styles.btn}
                  title="Add the selected images to the ComfyUI pose library, using each image's caption as the pose prompt"
                  onClick={() => setPoseAdd(true)}>Add to poses…</button>
          <button className={styles.btn} title="Rename the selection to <name>-1..N in display order — sidecars and ratings follow" onClick={() => void doRenameFiles()}>Rename…</button>
          {/* Exactly one image selected: pin it as the picture the PARENT listing shows for
              this folder. Auto-pick otherwise takes whichever file sorts first, which is
              rarely the one that says what the folder is. */}
          {store.selected.size === 1 && !!store.cwd && (
            <button className={styles.btn}
                    title={`Use this image as the folder tile picture for "${store.cwd.split('/').pop()}"`}
                    onClick={() => void doPinPreview([...store.selected][0])}>Set folder preview</button>
          )}
          {store.batchContext && <button className={styles.btn} title="Move the selection into a <repeats>_<concept> subsection of this batch (kohya's folder convention; AI Toolkit ignores the names)" onClick={() => setSubMove(true)}>Subsection…</button>}
          {/* Was gated on inTrainingSet, so a wrong image in a root tag folder could not be
              removed at all. The server enforces the real boundary (model roots refuse by
              name), so the UI no longer second-guesses it. */}
          <button className={styles.btn}
                  title="Download the selected images as their original files (full resolution, original format). With several selected, the browser may ask once to allow multiple downloads."
                  onClick={() => void doDownload()}>⬇ Download</button>
          <button className={styles.btnDanger} onClick={() => void doDelete()}>Delete</button>
          <button className={styles.btn}
                  title="Remove watermarks / signatures / logos from the selected images (Qwen Image 2.1 edit on the Image Model Service). Only the changed regions are pasted back; originals are kept - ⇄ in the editor switches back."
                  onClick={() => setWmFiles(store.images.filter((im) => store.selected.has(imKey(im)) && !im.is_video).map((im) => im.rel))}>🧽 Remove watermark…</button>
          <button className={styles.btn} title="Add or remove the same booru tags across the selected images" onClick={() => setBlanket(true)}>Blanket tags…</button>
          <button className={styles.btn} title="Replace text across the selected images' .txt and .caption sidecars — preview before applying" onClick={() => setFindRep(true)}>Find &amp; replace…</button>
          <button className={styles.btn} title="Have a text model correct the selected captions against an instruction — preview before applying" onClick={() => setCorrect(true)}>Correct captions…</button>
          <button className={styles.btn} title="Strip .txt tag sidecars for the selected images" onClick={() => void doStrip([...store.selected])}>Strip tags</button>
          <button className={styles.btn} title="Tile these images and add them to a detector-training dataset (dataset-forge). Originals are not copied." onClick={() => setDsAdd(true)}>Add to dataset…</button>
          <button className={styles.btn} title="Clear ratings + comments for the selected images" onClick={() => void doWipe([...store.selected])}>Wipe ratings</button>
          <span className={styles.msg}>{store.msg}</span>
        </div>
      )}

      {store.wmJobs.length > 0 && (
        <div className={styles.acHint} style={{ padding: '0 12px 6px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {store.wmJobs.map((j) => (
            <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🧽 {j.label}: {j.state === 'queued' ? 'queued behind another job'
                : j.state === 'running' ? `${j.done}/${j.total}${j.current ? ` — ${j.current.split('/').pop()}` : ''}`
                : j.state === 'lost' ? j.error
                : `${j.state} — ${j.cleaned} cleaned${j.failed ? `, ${j.failed} failed` : ''}`}</span>
              {j.errors.length > 0 && <span className={styles.dim} title={j.errors.join('\n')}>({j.errors[j.errors.length - 1]})</span>}
              {(j.state === 'queued' || j.state === 'running')
                ? <button className={styles.btn} onClick={() => void store.cancelWatermark(j.id)} title="Stops after the image in progress">Cancel</button>
                : <button className={styles.btn} onClick={() => store.dismissWatermarkJob(j.id)}>Dismiss</button>}
            </div>
          ))}
        </div>
      )}
      {store.error && <div className={styles.error}>{store.error}</div>}

      {store.atNarrowedRoot && (
        <div className={styles.acHint} style={{ padding: '0 12px 6px' }}>
          Showing training folders only. The rest of <code>/ai-assets/imagegen</code> (checkpoints,
          loras, vae…) is still reachable — switch to <strong>All folders</strong> above.
        </div>
      )}

      {/* ONE scrolling workspace. Folders used to sit in their own non-scrolling block
          above the grid, so a folder-heavy directory pushed the images off-screen with no
          way to scroll to them (Travis, 2026-09-08). They are now leading cells in the
          SAME grid: same 150px cell, one scrollbar, folders first. */}
      <div className={styles.gridScroll}>
        {/* Folders, plus every image when this folder has no subsections, in one grid. */}
        <div className={styles.grid}>
        {store.folders.map((f) => {
          const fpath = store.cwd ? `${store.cwd}/${f.name}` : f.name
          const fsel = store.selectedFolders.has(f.name)
          return (
            <div key={`fold-${f.name}`}
                 className={`${styles.tile} ${styles.folder} ${fsel ? styles.tileSel : ''}`}
                 title={f.name}
                 onClick={() => { if (store.selectionMode) store.toggleFolder(f.name); else void store.browse(fpath) }}>
              {f.preview
                ? <img src={igThumb(f.preview)} alt="" loading="lazy" draggable={false} />
                : <span className={styles.folderThumbEmpty}>{f.is_training_set ? <Star size={30} /> : <FolderOpen size={30} />}</span>}
              <span className={styles.pick} title="Select this folder"
                    onClick={(e) => { e.stopPropagation(); store.enterSelection(); store.toggleFolder(f.name) }} />
              {/* Persistent corner badge. With preview pictures on, a folder tile and an
                  image tile otherwise look identical at a glance. It hides on hover, where
                  the rename/delete actions take the same corner. */}
              <span className={styles.folderKind} title="Folder"><FolderOpen size={13} /></span>
              <span className={styles.folderActs}>
                <span className={styles.fact} title={f.is_training_set || f.is_training_batch ? 'Rename suffix' : `Rename "${f.name}"`} onClick={(e) => { e.stopPropagation(); void doRenameAnyFolder(fpath, f.name) }}>✎</span>
                <span className={`${styles.fact} ${styles.factDel}`} title={`Delete "${f.name}" and everything inside it`} onClick={(e) => { e.stopPropagation(); void doDeleteFolder(fpath, f.name) }}>🗑</span>
              </span>
              <span className={styles.folderFoot}>
                <span className={styles.folderName}>{f.name}</span>
                <span className={styles.folderMeta}>
                  {f.n_images} img{f.n_subfolders ? ` · ${f.n_subfolders} sub` : ''}
                  {f.is_training_set ? ' · set' : f.has_training_set ? ' · has set' : ''}
                  {f.is_batch_subsection ? ` · ×${f.repeats}` : ''}
                </span>
              </span>
            </div>
          )
        })}
        {store.sections.length === 0
          && store.visibleImages.map((im, i) => <Tile key={im.rel} im={im} i={i} onOpen={() => openImage(im)} />)}
        </div>
        {store.images.length === 0 && store.folders.length === 0 && !store.loading && <div className={styles.dim}>Nothing here.</div>}
        {store.sections.length > 0
          && (() => {
              // One BLOCK per section: header + that section's own grid. The tile index `i`
              // still comes from the flat visibleImages list, so shift-range selection spans
              // subsections exactly as before — only the layout is grouped.
              const bySub = new Map<string, Array<{ im: IgImage; i: number }>>()
              store.visibleImages.forEach((im, i) => {
                const g = bySub.get(im.dir || '') || []
                g.push({ im, i }); bySub.set(im.dir || '', g)
              })
              const out: React.ReactNode[] = []
              const renderGroup = (sub: string, meta?: (typeof store.sections)[number]) => {
                const items = bySub.get(sub) || []
                if (!meta && !items.length) return
                // Subsection panels are drop targets; the unsectioned group is not.
                const wrap = (node: React.ReactElement) => meta
                  ? <SecDrop key={`drop-${sub}`} folder={sub} className={styles.secBlock}>{node}</SecDrop>
                  : node
                out.push(wrap(
                  <React.Fragment key={`sec-${sub || 'root'}`}>
                  <div className={styles.secDivider}>
                    {meta ? (
                      <>
                        <span className={styles.secName}>{meta.concept}</span>
                        <span className={styles.secRepeats} title="kohya per-epoch repeats — click to change"
                              onClick={() => void doRepeats(`${store.cwd}/${meta.folder}`, meta)}>×{meta.repeats}</span>
                        <span className={styles.dim}>{items.length} shown / {meta.count}</span>
                        <button className={styles.btn} title="Collapse into a single tile (drop images onto the tile to move them in)"
                                onClick={() => store.toggleCollapsed(meta.folder)}><ChevronUp size={13} /> Collapse</button>
                        <span className={styles.spacer} />
                        {/* Per-subsection actions. Everything here acts on THIS subsection only
                            and leaves selections in other subsections untouched — the point is
                            to work one concept at a time without losing the rest. */}
                        {(() => {
                          const subImgs = store.imagesInSub(meta.folder)
                          const selHere = subImgs.filter((im) => store.selected.has(imKey(im))).length
                          return (
                            <>
                              <button className={styles.btn}
                                      title={`Select all ${subImgs.length} image(s) in "${meta.concept}" — other subsections keep their selection`}
                                      onClick={() => store.selectSubsection(meta.folder)}>Select all</button>
                              <button className={styles.btn} disabled={!selHere}
                                      title={selHere ? `Deselect the ${selHere} selected in "${meta.concept}" only` : 'Nothing selected in this subsection'}
                                      onClick={() => store.deselectSubsection(meta.folder)}>Deselect{selHere ? ` (${selHere})` : ''}</button>
                              <button className={styles.btn}
                                      title={`Auto-caption every image in "${meta.concept}" (${subImgs.length}). Ignores the view filter — existing captions are still skipped unless you tick overwrite.`}
                                      onClick={() => {
                                        setCapFiles(subImgs.map((im) => imKey(im)))
                                        setAutoCap(true)
                                      }}>🏷 Caption</button>
                            </>
                          )
                        })()}
                        <button className={styles.btn} title="Generate a collage of THIS subsection (agents view it with view_image)"
                                onClick={() => void doSectionCollage(meta.folder)}>🧩 Collage</button>
                        {meta.hasCollage && (
                          <button className={styles.btn}
                                  onClick={() => setLb({ rel: `${store.cwd}/${meta.folder}/${meta.collageFirst}`, name: `${meta.concept} collage`, bust: Date.now() })}>
                            View
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className={styles.secName}>unsectioned</span>
                        <span className={styles.dim}>{items.length} — kohya IGNORES images outside a subsection; AI Toolkit reads them</span>
                        <span className={styles.spacer} />
                        {/* The unsectioned group gets the same two actions as a subsection: the
                            whole point of this group is to empty it INTO a subsection, and doing
                            that by hand meant clicking every loose image. Keyed on '' because
                            imagesInSub() groups by (im.dir || ''), so '' IS this group. */}
                        {(() => {
                          const rootImgs = store.imagesInSub('')
                          const selHere = rootImgs.filter((im) => store.selected.has(imKey(im))).length
                          return (
                            <>
                              <button className={styles.btn} disabled={!rootImgs.length}
                                      title={`Select all ${rootImgs.length} unsectioned image(s) — subsections keep their selection, so you can send these straight to a subsection`}
                                      onClick={() => store.selectSubsection('')}>Select all</button>
                              <button className={styles.btn} disabled={!selHere}
                                      title={selHere ? `Deselect the ${selHere} selected unsectioned image(s) only` : 'Nothing selected here'}
                                      onClick={() => store.deselectSubsection('')}>Deselect{selHere ? ` (${selHere})` : ''}</button>
                            </>
                          )
                        })()}
                      </>
                    )}
                    {/* Inside the header, wrapping onto its own line via .secVars. Subsections
                        only — the unsectioned group has no variables to carry. */}
                    {meta && <SubVars sub={meta.folder} />}
                  </div>
                  <div className={styles.grid}>
                    {items.map(({ im, i }) => <Tile key={im.rel} im={im} i={i} onOpen={() => openImage(im)} />)}
                  </div>
                  </React.Fragment>,
                ))
              }
              renderGroup('')
              // Collapsed subsections sit as tiles between the unsectioned images and the first
              // expanded subsection. They keep their position in the batch's order among themselves.
              const collapsed = store.sections.filter((s) => store.isCollapsed(s.folder))
              if (collapsed.length) {
                out.push(
                  <React.Fragment key="collapsed-secs">
                    <div className={styles.secDivider}>
                      <span className={styles.secName}>collapsed subsections</span>
                      <span className={styles.dim}>{collapsed.length} — click a tile to expand · drop images on one to move them in</span>
                    </div>
                    <div className={styles.grid}>{collapsed.map((s) => <CollapsedSecTile key={s.folder} meta={s} />)}</div>
                  </React.Fragment>,
                )
              }
              for (const s of store.sections) if (!store.isCollapsed(s.folder)) renderGroup(s.folder, s)
              return out
            })()}
      </div>

      {vid && <VideoModal rel={vid.rel} name={vid.name} onClose={() => setVid(null)} />}
      {lb && <Lightbox rel={lb.rel} name={lb.name} bust={lb.bust} onClose={() => setLb(null)} />}
      {crop && (() => {
        // key=rel: every image gets a freshly mounted editor — box, tags, rating and
        // message state must never leak from the previous image while paging through.
        // Nav runs over the FILTERED list: under "Needs crop", cropping an image drops
        // it from the list and the next uncropped one slides into its slot — so when
        // the current rel is gone, "next" is whatever now sits at the remembered index.
        const list = store.visibleImages
        const i = list.findIndex((x) => x.rel === crop.rel)
        if (i >= 0) cropIdxRef.current = i
        const held = cropIdxRef.current
        return <CropEditor key={crop.rel} rel={crop.rel} name={crop.name}
          onClose={() => setCrop(null)} onChanged={() => void store.browse(store.cwd)}
          navPos={i >= 0 ? { i, n: list.length } : { i: held, n: list.length + 1 }}
          onNav={(dir) => {
            const l = store.visibleImages
            const at = l.findIndex((x) => x.rel === crop.rel)
            const next = at >= 0 ? l[at + dir] : (dir > 0 ? l[cropIdxRef.current] : l[cropIdxRef.current - 1])
            if (next) openImage(next)
            else if (at < 0) setCrop(null)   // list emptied under us — nothing left to page to
          }}
          onCaption={() => {
            // The section-qualified KEY, not the bare name — a subsection image captioned
            // with path=batch-root 404s ('not found: green-12.png', caught live).
            const key = crop.rel.startsWith(store.cwd + '/') ? crop.rel.slice(store.cwd.length + 1) : crop.name
            setCapFiles([key]); setAutoCap(true)
          }}
          onWatermark={() => setWmFiles([crop.rel])} />
      })()}
      {autoCap && <AutoCaptionModal files={capFiles} onClose={() => setAutoCap(false)} />}
      {autoCrop && <AutoCropModal onClose={() => setAutoCrop(false)} />}
      {wmFiles && <WatermarkModal files={wmFiles} onClose={() => setWmFiles(null)} />}
      {varsModal && <VariablesModal onClose={() => setVarsModal(false)} />}

      {dsAdd && <AddToDataset onClose={() => setDsAdd(false)} />}
      {blanket && <BlanketTagModal files={[...store.selected]} onClose={() => setBlanket(false)} onDone={() => void store.browse(store.cwd)} />}
      {/* files=[] means folder scope, which is exactly what an empty selection should mean. */}
      {findRep && <FindReplaceModal files={[...store.selected]} onClose={() => setFindRep(false)} onDone={() => void store.browse(store.cwd)} />}
      {poseAdd && <AddToPoseLibraryModal files={[...store.selected]} onClose={() => setPoseAdd(false)} onDone={() => { /* library changed; nothing in THIS panel to refresh */ }} />}
      {correct && <CorrectCaptionsModal files={[...store.selected]} onClose={() => setCorrect(false)} onDone={() => void store.browse(store.cwd)} />}
      {batchAdd && <AddToBatchModal kind="batch" files={[...store.selected]} onClose={() => setBatchAdd(false)} />}
      {subMove && <SubsectionModal onClose={() => setSubMove(false)} />}
      {setAdd && <AddToBatchModal kind="set" files={[...store.selected]} onClose={() => setSetAdd(false)} />}
      {picker && <Picker op={picker} files={[...store.selected]} folders={[...store.selectedFolders]} onClose={() => setPicker(null)} onDone={() => void store.browse(store.cwd)} />}
      {merge && <MergeModal onClose={() => setMerge(false)} />}
    </div>
  )
})
