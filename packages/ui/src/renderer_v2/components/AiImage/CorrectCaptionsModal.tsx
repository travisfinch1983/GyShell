import React, { useEffect, useRef, useState } from 'react'
import { trainingImagesStore as store, type CorrectCaptionsBody } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

type Ext = 'txt' | 'caption'
interface CatalogModel { id: string; displayName?: string; tag?: string; kind?: string }
interface Proposal { file: string; ext: string; before: string; after: string }
interface CorrectStatus {
  state: 'running' | 'done' | 'error'
  total: number; done: number; wrote?: number; skipped?: number; errors?: number
  dry_run?: boolean; samples?: Proposal[]; model?: string; error?: string; lastError?: string
}

/** Model-based caption correction — the semantic sibling of Find & Replace. Give it an
 *  instruction ("every image here is a CUTE bulge; fix any that say large or huge") and a text
 *  model, and it rewrites the sidecars a model at a time.
 *
 *  A dry run is a JOB, not a synchronous call (one LLM round-trip per file), so Preview launches
 *  it and streams proposals back into the modal as they land — the same job the global progress
 *  card shows. Apply runs the identical job with dry_run off and hands progress to that card.
 *  Vision mode is intentionally absent (text-first); the layout leaves room for it later. */
export const CorrectCaptionsModal: React.FC<{ files: string[]; onClose: () => void; onDone: () => void }> =
  ({ files, onClose, onDone }) => {
    const [instruction, setInstruction] = useState('')
    const [model, setModel] = useState('')
    const [models, setModels] = useState<CatalogModel[]>([])
    const [exts, setExts] = useState<Ext[]>(['caption'])
    const [maxFiles, setMaxFiles] = useState('')
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState('')
    const [status, setStatus] = useState<CorrectStatus | null>(null)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const scoped = files.length > 0
    const scopeLabel = scoped
      ? `${files.length} selected image${files.length > 1 ? 's' : ''}`
      : `every image in ${store.cwd.split('/').pop() || 'this folder'}`

    const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }

    // Text-proxy catalog (NOT the tagger list) — pick the correction model from here.
    useEffect(() => {
      let alive = true
      store.llmCatalog()
        .then((list: CatalogModel[]) => { if (!alive) return; setModels(list || []); if (list?.length) setModel((m) => m || list[0].id) })
        .catch(() => setMsg('Could not load the model list.'))
      return () => { alive = false; stopPoll() }
    }, [])

    const invalidate = () => setStatus(null)   // any criteria edit drops a stale preview
    const toggleExt = (e: Ext) => { invalidate(); setExts((p) => (p.includes(e) ? p.filter((x) => x !== e) : [...p, e])) }

    const buildBody = (dry: boolean): CorrectCaptionsBody => {
      const b: CorrectCaptionsBody = { instruction: instruction.trim(), model, exts, dry_run: dry }
      const mf = parseInt(maxFiles, 10)
      if (Number.isFinite(mf) && mf > 0) b.max_files = mf
      if (scoped) b.files = files
      return b
    }

    const launch = async (dry: boolean) => {
      if (!instruction.trim()) { setMsg('Enter a correction instruction.'); return }
      if (!model) { setMsg('Pick a model.'); return }
      if (!exts.length) { setMsg('Pick at least one of .caption / .txt.'); return }
      setBusy(true); setStatus(null); stopPoll()
      setMsg(dry ? 'Previewing…' : 'Starting…')
      try {
        const { jobId } = await store.correctCaptions(buildBody(dry))
        const label = `Correct captions${dry ? ' (preview)' : ''} · ${(model.split('/').pop() || model)}`
        store.trackCaptionJob(jobId, label)   // same progress card as any caption run
        if (dry) {
          // Stream proposals into the modal so the rewrite can be reviewed before it's applied.
          pollRef.current = setInterval(async () => {
            try {
              const s: CorrectStatus = await store.autoCaptionStatus(jobId)
              setStatus(s)
              if (s.state !== 'running') {
                stopPoll(); setBusy(false)
                setMsg(s.state === 'error'
                  ? `Preview failed: ${s.error || s.lastError || 'unknown'}`
                  : `Preview ready — ${s.samples?.length || 0} shown of ${s.total} file${s.total === 1 ? '' : 's'}.`)
              }
            } catch { /* transient — keep polling */ }
          }, 1200)
        } else {
          stopPoll(); setBusy(false)
          setMsg(`Correcting ${scoped ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'this folder'} — progress in the panel.`)
          onDone()
          onClose()
        }
      } catch (e: any) {
        stopPoll(); setBusy(false); setMsg('Failed: ' + (e?.message || e))
      }
    }

    const proposals = status?.samples || []

    return (
      <div className={styles.modalBg}>{/* not click-to-close: a stray backdrop click eats typed input */}
        <div className={styles.pkBox} style={{ width: 'min(620px,95%)' }} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalHead}>
            <strong>Correct captions with a model</strong>
            <button className={styles.btn} onClick={() => { stopPoll(); onClose() }}>Close</button>
          </div>

          <div className={styles.acHint}>
            Applies to <strong>{scopeLabel}</strong>. A model rewrites the sidecars per your
            instruction — for exact term swaps, Find &amp; replace is faster and deterministic.
          </div>

          <div className={styles.acSection}>Instruction</div>
          <textarea
            className={styles.input} style={{ width: '100%', minHeight: 72, resize: 'vertical' }} disabled={busy}
            placeholder="Every image in this folder is a CUTE (small) bulge. Fix any caption that calls it large, huge, or big. Change only the size wording; keep everything else identical."
            value={instruction} onChange={(e) => { invalidate(); setInstruction(e.target.value) }}
          />

          <div className={styles.acSection}>Model</div>
          <select
            className={styles.input} style={{ width: '100%' }} disabled={busy || !models.length}
            value={model} onChange={(e) => { invalidate(); setModel(e.target.value) }}
          >
            {!models.length && <option value="">loading models…</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{(m.displayName || m.id)}{m.tag ? ` · ${m.tag}` : ''}</option>
            ))}
          </select>

          <div className={styles.acSection}>Correct which sidecars</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" disabled={busy} checked={exts.includes('caption')} onChange={() => toggleExt('caption')} />
              <span><code>.caption</code> text</span>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" disabled={busy} checked={exts.includes('txt')} onChange={() => toggleExt('txt')} />
              <span><code>.txt</code> tags</span>
            </label>
            <span className={styles.spacer} />
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} title="Cap how many files this run touches (blank = no cap). Handy to sample a model's behaviour before a full pass.">
              <span className={styles.acHint} style={{ margin: 0 }}>limit</span>
              <input className={styles.input} style={{ width: 72 }} type="number" min={0} disabled={busy}
                placeholder="all" value={maxFiles} onChange={(e) => { invalidate(); setMaxFiles(e.target.value) }} />
            </label>
          </div>

          {status && (
            <>
              <div className={styles.acSection}>
                Proposed changes
                <span className={styles.acHint} style={{ margin: 0, marginLeft: 8 }}>
                  {status.done}/{status.total}{status.state === 'running' ? ' …' : ''}
                  {status.errors ? ` · ${status.errors} error${status.errors === 1 ? '' : 's'}` : ''}
                </span>
              </div>
              {proposals.length > 0 ? (
                <div style={{ maxHeight: 240, overflowY: 'auto', fontSize: 12, lineHeight: 1.4 }}>
                  {proposals.map((p, i) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <div style={{ opacity: 0.55, fontSize: 11, marginBottom: 2 }}>{p.file}<span style={{ marginLeft: 6 }}>.{p.ext}</span></div>
                      <div style={{ opacity: 0.7, textDecoration: 'line-through' }}>{p.before}</div>
                      <div style={{ color: 'var(--ok, #3fb950)' }}>{p.after || <em style={{ opacity: 0.6 }}>(emptied)</em>}</div>
                    </div>
                  ))}
                  {status.state === 'running' && <div className={styles.acHint}>proposals stream in as the model works…</div>}
                </div>
              ) : (
                <div className={styles.acHint}>{status.state === 'running' ? 'working…' : 'No changes proposed — the captions already match the instruction.'}</div>
              )}
            </>
          )}

          <div className={styles.msg}>{msg}</div>
          <div className={styles.pkFoot}>
            <button className={styles.btn} disabled={busy || !instruction.trim() || !model || !exts.length} onClick={() => void launch(true)}>Preview</button>
            <span className={styles.spacer} />
            <button
              className={styles.btnPrimary}
              disabled={busy || !instruction.trim() || !model || !exts.length}
              onClick={() => void launch(false)}
            >
              {busy ? '…' : (scoped ? `Correct ${files.length}` : 'Correct folder')}
            </button>
          </div>
        </div>
      </div>
    )
  }
