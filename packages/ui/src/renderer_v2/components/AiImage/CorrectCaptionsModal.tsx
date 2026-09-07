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
 *  Dry-run and apply are both JOBS (one LLM round-trip per file): Preview streams the proposed
 *  rewrites into the modal before anything is written; Apply streams the same list as it writes.
 *  An error here means the model DECLINED to return a usable correction and the caption was kept
 *  as-is rather than blanked — the one unrecoverable outcome — so errors are shown loudly, not as
 *  a footnote. Vision mode is intentionally absent (text-first); the layout leaves room for it. */
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

    // Preview and Apply are the same job with dry_run flipped; both stream status so declined
    // captions surface either way. Apply refreshes the folder on completion.
    const launch = async (dry: boolean) => {
      if (!instruction.trim()) { setMsg('Enter a correction instruction.'); return }
      if (!model) { setMsg('Pick a model.'); return }
      if (!exts.length) { setMsg('Pick at least one of .caption / .txt.'); return }
      setBusy(true); setStatus(null); stopPoll()
      setMsg(dry ? 'Previewing…' : 'Correcting…')
      try {
        const { jobId } = await store.correctCaptions(buildBody(dry))
        const label = `Correct captions${dry ? ' (preview)' : ''} · ${(model.split('/').pop() || model)}`
        store.trackCaptionJob(jobId, label)   // same progress card as any caption run
        pollRef.current = setInterval(async () => {
          try {
            const s: CorrectStatus = await store.autoCaptionStatus(jobId)
            setStatus(s)
            if (s.state !== 'running') {
              stopPoll(); setBusy(false)
              if (s.state === 'error') {
                setMsg(`${dry ? 'Preview' : 'Correction'} failed: ${s.error || s.lastError || 'unknown'}`)
              } else if (dry) {
                setMsg(`Preview ready — ${s.wrote ?? s.samples?.length ?? 0} proposed of ${s.total} file${s.total === 1 ? '' : 's'}${s.errors ? `, ${s.errors} declined` : ''}.`)
              } else {
                setMsg(`Done — ${s.wrote ?? 0} corrected, ${s.skipped ?? 0} unchanged${s.errors ? `, ${s.errors} declined` : ''}.`)
                onDone()
              }
            }
          } catch { /* transient — keep polling */ }
        }, 1200)
      } catch (e: any) {
        stopPoll(); setBusy(false); setMsg('Failed: ' + (e?.message || e))
      }
    }

    const proposals = status?.samples || []
    const errCount = status?.errors ?? 0

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
                {status.dry_run ? 'Proposed changes' : 'Changes'}
                <span className={styles.acHint} style={{ margin: 0, marginLeft: 8 }}>
                  {status.done}/{status.total} scanned{status.state === 'running' ? ' …' : ''}
                  {status.wrote != null ? ` · ${status.wrote} ${status.dry_run ? 'proposed' : 'written'}` : ''}
                </span>
              </div>

              {errCount > 0 && (
                <div style={{ margin: '2px 0 8px', padding: '7px 10px', borderRadius: 6, background: 'var(--danger-bg, rgba(248,81,73,0.13))', color: 'var(--danger, #f85149)', fontSize: 12, lineHeight: 1.45 }}>
                  ⚠ {errCount} caption{errCount === 1 ? '' : 's'} left unchanged — the model didn’t return a usable correction, so {errCount === 1 ? 'it was' : 'they were'} kept as-is (never blanked).
                  {status.lastError ? <> Last: <span style={{ opacity: 0.85 }}>{status.lastError}</span></> : null}
                </div>
              )}

              {proposals.length > 0 ? (
                <div style={{ maxHeight: 240, overflowY: 'auto', fontSize: 12, lineHeight: 1.4 }}>
                  {proposals.map((p, i) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <div style={{ opacity: 0.55, fontSize: 11, marginBottom: 2 }}>{p.file}<span style={{ marginLeft: 6 }}>.{p.ext}</span></div>
                      <div style={{ opacity: 0.7, textDecoration: 'line-through' }}>{p.before}</div>
                      <div style={{ color: 'var(--ok, #3fb950)' }}>{p.after || <em style={{ opacity: 0.6 }}>(emptied)</em>}</div>
                    </div>
                  ))}
                  {status.state === 'running' && <div className={styles.acHint}>streams in as the model works — capped at 10 shown…</div>}
                </div>
              ) : (
                <div className={styles.acHint}>{status.state === 'running' ? 'working…' : (errCount > 0 ? 'No changes written.' : 'No changes — the captions already match the instruction.')}</div>
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
