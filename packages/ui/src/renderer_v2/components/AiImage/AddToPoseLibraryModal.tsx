import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { trainingImagesStore as store } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

type Ext = 'caption' | 'txt'
interface Preview {
  added: number
  skipped: number
  added_poses: Array<{ file: string; id: string; name: string; prompt: string }>
  skipped_files: Array<{ file: string; why: string }>
}

/** Import the selected images into the ComfyUI pose library, using each image's caption
 *  sidecar as the pose prompt.
 *
 *  The pose-only captioner already emits exactly the text a pose entry wants, so a
 *  captioned reference folder is a pose library that has not been imported yet. Previewed
 *  before it writes, because the interesting cases are the ones that will NOT import —
 *  an uncaptioned image would otherwise become a blank pose that looks fine in the grid
 *  and silently contributes nothing to a render. */
export const AddToPoseLibraryModal: React.FC<{ files: string[]; onClose: () => void; onDone: () => void }> =
  observer(({ files, onClose, onDone }) => {
    const [category, setCategory] = useState('')
    const [view, setView] = useState('')
    const [ext, setExt] = useState<Ext>('caption')
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState('')
    const [preview, setPreview] = useState<Preview | null>(null)

    const body = (dry: boolean) => ({
      path: store.cwd,
      files,
      caption_ext: ext,
      category: category.trim(),
      view: view.trim(),
      dry_run: dry,
    })

    const run = async (dry: boolean) => {
      setBusy(true); setMsg(dry ? 'Checking…' : 'Importing…')
      try {
        const res = await fetch('/api/imagegen/poses/add-from-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body(dry)),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`)
        if (dry) {
          setPreview(data)
          setMsg(`${data.added} will import, ${data.skipped} will be skipped.`)
        } else {
          setMsg(`Imported ${data.added} pose${data.added === 1 ? '' : 's'}.`)
          setPreview(null)
          onDone()
          setTimeout(onClose, 900)
        }
      } catch (e: any) {
        setMsg('Failed: ' + String(e?.message || e))
      } finally { setBusy(false) }
    }

    // Any change invalidates a prior preview — never leave a stale preview sitting next to
    // changed criteria, which would show one set of results and import another.
    const edit = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPreview(null); setMsg('') }

    return (
      <div className={styles.modalBg}>
        <div className={styles.pkBox} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalHead}>
            <strong>Add {files.length} image{files.length === 1 ? '' : 's'} to the pose library</strong>
            <button className={styles.btn} onClick={onClose} disabled={busy}>Cancel</button>
          </div>

          <div className={styles.acHint}>
            Each image&rsquo;s caption becomes the pose prompt &mdash; the text the ComfyUI node
            emits. Images without a caption are skipped rather than imported blank.
          </div>

          <div className={styles.acSection}>Caption source</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" checked={ext === 'caption'} disabled={busy}
                     onChange={() => edit(setExt)('caption')} />
              <span><code>.caption</code> (natural language)</span>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" checked={ext === 'txt'} disabled={busy}
                     onChange={() => edit(setExt)('txt')} />
              <span><code>.txt</code> (booru tags)</span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={styles.acSection}>View</div>
              <input className={styles.input} style={{ width: '100%' }} disabled={busy}
                     placeholder="e.g. rear view (optional)" value={view}
                     onChange={(e) => edit(setView)(e.target.value)} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={styles.acSection}>Category</div>
              <input className={styles.input} style={{ width: '100%' }} disabled={busy}
                     placeholder="e.g. bent over (optional)" value={category}
                     onChange={(e) => edit(setCategory)(e.target.value)} />
            </div>
          </div>
          <div className={styles.acHint}>
            Both are used to build each pose&rsquo;s name, which is its permanent id in the node.
            They can be edited later in the Pose Library tab; the name cannot.
          </div>

          {preview && (
            <>
              <div className={styles.acSection}>
                Preview &mdash; {preview.added} importing, {preview.skipped} skipped
              </div>
              <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 11, lineHeight: 1.5 }}>
                {preview.added_poses.map((a) => (
                  <div key={a.id} style={{ marginBottom: 4 }}>
                    <strong>{a.name}</strong>
                    <div className={styles.dim}>{a.file}</div>
                    <div>{a.prompt}</div>
                  </div>
                ))}
                {preview.skipped_files.map((s) => (
                  <div key={s.file} className={styles.dim} style={{ marginBottom: 2 }}>
                    skipped &mdash; {s.file}: {s.why}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className={styles.pkFoot}>
            {msg && <span className={styles.dim}>{msg}</span>}
            <span className={styles.spacer} />
            <button className={styles.btn} disabled={busy} onClick={() => void run(true)}>Preview</button>
            <button className={styles.btnPrimary} disabled={busy || !preview || !preview.added}
                    onClick={() => void run(false)}>
              Import{preview ? ` ${preview.added}` : ''}
            </button>
          </div>
        </div>
      </div>
    )
  })
