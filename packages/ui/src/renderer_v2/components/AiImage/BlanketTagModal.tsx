import React, { useState } from 'react'
import { trainingImagesStore as store } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

/** Add or remove the same booru tags across every image in a folder (or just the selected
 *  ones) in a single request. Editing a trigger word into 650 sidecars by hand was the
 *  alternative, and per-image POST /tags would have been 650 round-trips.
 *
 *  Only touches `.txt` (booru tags). Natural-language `.caption` files are never read or
 *  written here — the two stay separate so a set can carry both and each trainer reads its own. */
export const BlanketTagModal: React.FC<{ files: string[]; onClose: () => void; onDone: () => void }> =
  ({ files, onClose, onDone }) => {
    const [add, setAdd] = useState('')
    const [remove, setRemove] = useState('')
    const [position, setPosition] = useState<'start' | 'end'>('start')
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState('')

    const parse = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean)
    const addList = parse(add), remList = parse(remove)
    const scoped = files.length > 0
    const scopeLabel = scoped
      ? `${files.length} selected image${files.length > 1 ? 's' : ''}`
      : `every image in ${store.cwd.split('/').pop() || 'this folder'}`

    const go = async () => {
      if (!addList.length && !remList.length) { setMsg('Nothing to add or remove.'); return }
      setBusy(true); setMsg('Applying…')
      try {
        const r = await store.tagsBatch({
          add: addList, remove: remList, position,
          ...(scoped ? { files } : {}),
        })
        setMsg(`Done — ${r.changed} changed, ${r.unchanged} already matched`
          + `${r.cleared ? `, ${r.cleared} emptied` : ''}`
          + `${r.errors?.length ? `, ${r.errors.length} failed` : ''}.`)
        onDone()
      } catch (e: any) {
        setMsg('Failed: ' + (e?.message || e))
      } finally { setBusy(false) }
    }

    return (
      <div className={styles.modalBg} onClick={onClose}>
        <div className={styles.pkBox} style={{ width: 'min(520px,94%)' }} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalHead}>
            <strong>Blanket tags</strong>
            <button className={styles.btn} onClick={onClose}>Close</button>
          </div>

          <div className={styles.acHint}>
            Applies to <strong>{scopeLabel}</strong>. Booru tags only — <code>.caption</code> files
            are untouched.
          </div>

          <div className={styles.acSection}>Add</div>
          <input
            className={styles.input} style={{ width: '100%' }} disabled={busy}
            placeholder="evegladden, 1girl" value={add} onChange={(e) => setAdd(e.target.value)}
          />
          <div className={styles.acSeg} style={{ marginTop: 6 }}>
            {(['start', 'end'] as const).map((p) => (
              <button
                key={p} disabled={busy}
                className={`${styles.acSegBtn} ${position === p ? styles.acSegOn : ''}`}
                onClick={() => setPosition(p)}
              >
                {p === 'start' ? 'At the start' : 'At the end'}
                <span className={styles.acSegExt}>{p === 'start' ? 'trigger words go here' : 'appended'}</span>
              </button>
            ))}
          </div>
          <div className={styles.acHint}>
            kohya treats the leading token as the trigger, so a trigger word belongs at the start.
            A tag that is already present gets moved to the chosen position rather than duplicated.
          </div>

          <div className={styles.acSection}>Remove</div>
          <input
            className={styles.input} style={{ width: '100%' }} disabled={busy}
            placeholder="watermark, text" value={remove} onChange={(e) => setRemove(e.target.value)}
          />
          <div className={styles.acHint}>
            Exact matches only. An image whose tags all get removed loses its <code>.txt</code>
            rather than keeping an empty one.
          </div>

          {(addList.length > 0 || remList.length > 0) && (
            <>
              <div className={styles.acSection}>Preview</div>
              <div className={styles.acHint}>
                {addList.length > 0 && <>add <strong>{addList.join(', ')}</strong> at the {position}. </>}
                {remList.length > 0 && <>remove <strong>{remList.join(', ')}</strong>.</>}
              </div>
            </>
          )}

          <div className={styles.msg}>{msg}</div>
          <div className={styles.pkFoot}>
            <span className={styles.spacer} />
            <button
              className={styles.btnPrimary} disabled={busy || (!addList.length && !remList.length)}
              onClick={() => void go()}
            >
              {busy ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      </div>
    )
  }
