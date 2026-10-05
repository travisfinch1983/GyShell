import React, { useEffect, useState } from 'react'
import { trainingImagesStore as store, type FindReplaceResult, type CaptionTrigger } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

type Ext = 'txt' | 'caption'

// Result shape is imported, not redeclared: a local copy of a cross-module contract drifts
// silently the moment either side changes. (This one already had: ok: true vs boolean, and
// no dry_run/errors.) The store owns it; tsc holds both halves to it.

/** Literal find & replace across caption sidecars in a folder (or the current selection).
 *  Deterministic sibling of the model-based caption corrector: use this for simple, exact
 *  swaps like "large bulge" -> "cute bulge" where a model round-trip is overkill.
 *
 *  Preview (dry-run) first: it never writes, and returns up to five before/after pairs so a
 *  substring swap can be SEEN to match what was intended before anything on disk changes.
 *  Leaving Replace empty deletes the matched term (drops the .txt token with "whole tag",
 *  removes the substring otherwise). */
export const FindReplaceModal: React.FC<{ files: string[]; onClose: () => void; onDone: () => void }> =
  ({ files, onClose, onDone }) => {
    const [find, setFind] = useState('')
    const [replace, setReplace] = useState('')
    const [exts, setExts] = useState<Ext[]>(['txt', 'caption'])
    const [wholeTag, setWholeTag] = useState(false)
    const [triggerMode, setTriggerMode] = useState(false)
    const [caseSensitive, setCaseSensitive] = useState(false)
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState('')
    const [preview, setPreview] = useState<FindReplaceResult | null>(null)
    // Folder scope only. Default ON: captions usually live in the training_set_* subfolders, and a
    // replace started from the parent folder used to touch nothing at all.
    const [recursive, setRecursive] = useState(true)
    const [triggers, setTriggers] = useState<CaptionTrigger[] | null>(null)

    const scoped = files.length > 0
    const folderName = store.cwd.split('/').pop() || 'this folder'
    const scopeLabel = scoped
      ? `${files.length} selected image${files.length > 1 ? 's' : ''}`
      : recursive ? `every image in ${folderName} and all its subfolders` : `images directly in ${folderName} (not subfolders)`

    // Trigger mode: show the triggers actually in use, so the wrong one can be clicked, not guessed.
    useEffect(() => {
      if (!triggerMode) return
      let live = true
      setTriggers(null)
      store.captionTriggers(scoped ? { keys: files } : { recursive })
        .then((t) => { if (live) setTriggers(t) })
        .catch((e) => { if (live) { setTriggers([]); setMsg('Could not list triggers: ' + (e?.message || e)) } })
      return () => { live = false }
    }, [triggerMode, recursive, scoped, files.join('|')])

    const toggleExt = (e: Ext) =>
      setExts((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]))

    const body = (dry: boolean) => ({
      find,
      replace,
      exts,
      whole_tag: wholeTag,
      ...(triggerMode ? { mode: 'trigger' as const } : {}),
      ...(!scoped ? { recursive } : {}),
      case_sensitive: caseSensitive,
      dry_run: dry,
    })

    const run = async (dry: boolean) => {
      if (!find && !triggerMode) { setMsg('Enter a term to find.'); return }
      if (triggerMode && !replace && !find) {
        setMsg('In trigger mode, enter the new trigger (or a Find value to delete a specific one).'); return
      }
      if (!exts.length) { setMsg('Pick at least one of .txt / .caption.'); return }
      // Editing the form invalidates a prior preview — never let a stale preview sit next to
      // changed criteria, so re-preview after any edit (the fields reset it via onChange below).
      setBusy(true); setMsg(dry ? 'Scanning…' : 'Applying…')
      try {
        const r: FindReplaceResult = scoped
          ? await store.findReplaceKeys(body(dry), files)
          : await store.findReplace(body(dry))
        if (dry) {
          setPreview(r)
          setMsg(r.occurrences
            ? `${r.occurrences} occurrence${r.occurrences === 1 ? '' : 's'} in ${r.files_changed} of ${r.files_scanned} file${r.files_scanned === 1 ? '' : 's'}.`
            : `No matches in ${r.files_scanned} file${r.files_scanned === 1 ? '' : 's'}.`)
        } else {
          setPreview(null)
          setMsg(`Done — ${r.occurrences} replaced across ${r.files_changed} file${r.files_changed === 1 ? '' : 's'}.`)
          onDone()
        }
      } catch (e: any) {
        setMsg('Failed: ' + (e?.message || e))
      } finally { setBusy(false) }
    }

    // Trigger mode may run with an empty Find ("replace whatever trigger is there") - the buttons
    // used to require Find regardless, so that documented path could never be clicked.
    const canRun = !!find || (triggerMode && !!replace)

    // Any criteria edit drops the preview so the shown before/after can't disagree with the form.
    const edit = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPreview(null) }

    return (
      <div className={styles.modalBg}>{/* not click-to-close: a stray backdrop click eats typed input */}
        <div className={styles.pkBox} style={{ width: 'min(560px,94%)' }} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalHead}>
            <strong>Find &amp; replace in captions</strong>
            <button className={styles.btn} onClick={onClose}>Close</button>
          </div>

          <div className={styles.acHint}>
            Applies to <strong>{scopeLabel}</strong>. Literal text swap — for deeper fixes a model
            can catch, use the caption corrector instead.
          </div>

          <div className={styles.acSection}>Find</div>
          <input
            className={styles.input} style={{ width: '100%' }} disabled={busy}
            placeholder={triggerMode ? "current trigger (pick one below), or leave EMPTY to match whatever is there; several words: a, b" : "large bulge"} value={find}
            onChange={(e) => edit(setFind)(e.target.value)}
          />

          {triggerMode && (
            <div style={{ marginTop: 6 }}>
              {triggers === null ? <span className={styles.acHint}>Reading the triggers in use…</span>
                : triggers.length === 0 ? <span className={styles.acHint}>No trigger-like first tokens found in this scope.</span>
                : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <span className={styles.acHint} style={{ alignSelf: 'center' }}>In use:</span>
                    {triggers.slice(0, 16).map((t) => (
                      <button key={t.trigger} className={styles.btn} disabled={busy} onClick={() => edit(setFind)(t.trigger)}
                              title={`${t.txt} .txt + ${t.caption} .caption\n${t.folders.join('\n')}`}
                              style={{ padding: '2px 8px', fontSize: 12, outline: find === t.trigger ? '1px solid var(--accent, #58a6ff)' : undefined }}>
                        {t.trigger} <span style={{ opacity: 0.6 }}>×{t.count}</span>
                      </button>
                    ))}
                  </div>
                )}
            </div>
          )}

          <div className={styles.acSection}>Replace with</div>
          <input
            className={styles.input} style={{ width: '100%' }} disabled={busy}
            placeholder={triggerMode ? "new trigger word (empty removes the trigger entirely)" : "cute bulge  (leave empty to delete the term)"} value={replace}
            onChange={(e) => edit(setReplace)(e.target.value)}
          />

          <div className={styles.acSection}>Apply to</div>
          {!scoped && (
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 6 }}
                   title="Also every subfolder - e.g. all the training sets under this folder">
              <input type="checkbox" disabled={busy} checked={recursive} onChange={(e) => edit(setRecursive)(e.target.checked)} />
              <span>Include subfolders</span>
            </label>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" disabled={busy} checked={exts.includes('txt')} onChange={() => edit(toggleExt)('txt')} />
              <span><code>.txt</code> tags</span>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" disabled={busy} checked={exts.includes('caption')} onChange={() => edit(toggleExt)('caption')} />
              <span><code>.caption</code> text</span>
            </label>
            <span className={styles.spacer} />
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} title="Match only exact comma-separated .txt tokens (never inside .caption prose)">
              <input type="checkbox" disabled={busy || !exts.includes('txt') || triggerMode} checked={wholeTag} onChange={(e) => edit(setWholeTag)(e.target.checked)} />
              <span>Whole tag only</span>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
                   title="Rewrite ONLY the leading token of each sidecar — the trigger word. Leave Find empty to replace whatever trigger is there now.">
              <input type="checkbox" disabled={busy} checked={triggerMode} onChange={(e) => { edit(setTriggerMode)(e.target.checked); if (e.target.checked) setWholeTag(false) }} />
              <span>Trigger word only</span>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" disabled={busy} checked={caseSensitive} onChange={(e) => edit(setCaseSensitive)(e.target.checked)} />
              <span>Case-sensitive</span>
            </label>
          </div>
          <div className={styles.acHint}>
            {wholeTag
              ? <>Matches only exact <code>.txt</code> tokens equal to the Find term; <code>.caption</code> prose is left alone.</>
              : <>Substring match — also hits the term inside <code>.caption</code> sentences and inside longer tags.</>}
          </div>

          {preview && (
            <>
              <div className={styles.acSection}>Preview</div>
              {preview.samples && preview.samples.length > 0 ? (
                <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 12, lineHeight: 1.4 }}>
                  {preview.samples.map((s, i) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <div style={{ opacity: 0.55, fontSize: 11, marginBottom: 2 }}>{s.file}</div>
                      <div style={{ opacity: 0.7, textDecoration: 'line-through' }}>{s.before}</div>
                      <div style={{ color: 'var(--ok, #3fb950)' }}>{s.after || <em style={{ opacity: 0.6 }}>(emptied)</em>}</div>
                    </div>
                  ))}
                  {preview.files_changed > preview.samples.length && (
                    <div className={styles.acHint}>…and {preview.files_changed - preview.samples.length} more file{preview.files_changed - preview.samples.length === 1 ? '' : 's'}.</div>
                  )}
                </div>
              ) : (
                <div className={styles.acHint}>Nothing matches — adjust the term or toggles.</div>
              )}
            </>
          )}

          <div className={styles.msg}>{msg}</div>
          <div className={styles.pkFoot}>
            <button className={styles.btn} disabled={busy || !canRun || !exts.length} onClick={() => void run(true)}>Preview</button>
            <span className={styles.spacer} />
            <button
              className={styles.btnPrimary}
              disabled={busy || !canRun || !exts.length || (!!preview && preview.occurrences === 0)}
              onClick={() => void run(false)}
            >
              {busy ? '…' : 'Replace'}
            </button>
          </div>
        </div>
      </div>
    )
  }
