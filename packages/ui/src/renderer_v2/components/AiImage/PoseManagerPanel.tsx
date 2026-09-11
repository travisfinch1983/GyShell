import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Plus, Trash2, Undo2, Save } from 'lucide-react'
import { poseManagerStore as store, type Pose } from '../../stores/PoseManagerStore'
import { igThumb, igImage } from '../../stores/TrainingImagesStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './PoseManager.module.scss'

/** Add a pose. The source is a path inside /imagegen — Travis already browses his
 *  references in the Training Images tab, so a path is the shortest route from
 *  "I have a reference image" to "it is selectable in the node". */
const AddPoseModal: React.FC<{ onClose: () => void }> = observer(({ onClose }) => {
  const [prompt, setPrompt] = useState('')
  const [category, setCategory] = useState('')
  const [view, setView] = useState('')
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const go = async () => {
    if (!prompt.trim()) { setMsg('Prompt is required — it is what the node emits.'); return }
    if (!source.trim()) { setMsg('Give the path to a reference image.'); return }
    setBusy(true); setMsg('Adding…')
    try {
      const pose = await store.add({
        prompt: prompt.trim(), category: category.trim(), view: view.trim(),
        name: name.trim() || undefined, source_path: source.trim(),
      })
      setMsg(`Added ${pose.name}.`)
      setTimeout(onClose, 700)
    } catch (e: any) { setMsg('Failed: ' + String(e?.message || e)) }
    finally { setBusy(false) }
  }

  return (
    <div className={styles.modalBg}>
      {/* deliberately NOT click-to-close: a stray backdrop click eating a typed prompt is
          the same annoyance the other imagegen modals already avoid */}
      <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Add a pose</strong>
          <button className={styles.btn} onClick={onClose} disabled={busy}>Cancel</button>
        </div>

        <div className={styles.section}>Reference image</div>
        <input className={styles.input} style={{ width: '100%' }} disabled={busy}
               placeholder="path under /imagegen, e.g. training_images/examples/kneeling.jpg"
               value={source} onChange={(e) => setSource(e.target.value)} />
        <div className={styles.hint}>
          Any image already under <code>/imagegen</code>. It is resized to 224&times;284 webp to
          match the rest of the library, so the gallery stays a uniform grid.
        </div>

        <div className={styles.section}>Prompt <span className={styles.req}>required</span></div>
        <input className={styles.input} style={{ width: '100%' }} disabled={busy}
               placeholder="low angle, front view, kneeling, legs wide, forward on hands"
               value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className={styles.hint}>The text the node emits. Everything else is organisation.</div>

        <div className={styles.row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={styles.section}>View</div>
            <input className={styles.input} list="pm-views" disabled={busy} style={{ width: '100%' }}
                   placeholder="front view" value={view} onChange={(e) => setView(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={styles.section}>Category</div>
            <input className={styles.input} list="pm-cats" disabled={busy} style={{ width: '100%' }}
                   placeholder="kneeling" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
        </div>

        <div className={styles.section}>Name <span className={styles.dim}>(optional)</span></div>
        <input className={styles.input} style={{ width: '100%' }} disabled={busy}
               placeholder="blank = generated, e.g. 121 | Front View | Kneeling"
               value={name} onChange={(e) => setName(e.target.value)} />
        <div className={styles.hint}>
          The name is the node's <strong>stable id</strong> — what its dropdown lists and what a
          saved workflow stores. It cannot be changed afterwards, so choose it now or take the
          generated one.
        </div>

        <div className={styles.modalFoot}>
          {msg && <span className={styles.dim}>{msg}</span>}
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} disabled={busy} onClick={() => void go()}>Add pose</button>
        </div>
      </div>
    </div>
  )
})

const PoseCard: React.FC<{ pose: Pose }> = observer(({ pose }) => {
  const dirty = store.drafts.has(pose.id)
  const [big, setBig] = useState(false)

  const doDelete = async () => {
    if (!(await confirmStore.confirm({
      title: `Delete ${pose.name}`,
      message: `Remove this pose and its image from the library?\n\nAny workflow that selected it by name will fall back to the first pose. This cannot be undone.`,
      confirmText: 'Delete pose',
    }))) return
    try { await store.remove(pose.id) } catch (e: any) { store.msg = 'Failed: ' + String(e?.message || e) }
  }

  return (
    <div className={`${styles.card} ${dirty ? styles.cardDirty : ''}`}>
      <img className={styles.thumb} src={igThumb(pose.rel)} alt={pose.name} loading="lazy"
           onClick={() => setBig(true)} title="Click to see it full size" />
      <div className={styles.cardBody}>
        <div className={styles.cardName} title={`${pose.name}\n(id ${pose.id} — the name is the node's stable id and is not editable)`}>
          {pose.name}
        </div>

        <textarea className={styles.prompt} rows={2} value={store.draftValue(pose, 'prompt')}
                  onChange={(e) => store.edit(pose.id, 'prompt', e.target.value)}
                  placeholder="prompt text the node emits" />

        <div className={styles.row}>
          <input className={styles.inputSm} list="pm-views" value={store.draftValue(pose, 'view')}
                 onChange={(e) => store.edit(pose.id, 'view', e.target.value)} placeholder="view" />
          <input className={styles.inputSm} list="pm-cats" value={store.draftValue(pose, 'category')}
                 onChange={(e) => store.edit(pose.id, 'category', e.target.value)} placeholder="category" />
        </div>

        <div className={styles.cardFoot}>
          {dirty ? (
            <>
              <button className={styles.btnPrimarySm} onClick={() => void store.save(pose.id)}>
                <Save size={12} /> Save
              </button>
              <button className={styles.btnSm} title="Discard changes to this pose"
                      onClick={() => store.revert(pose.id)}><Undo2 size={12} /></button>
            </>
          ) : <span className={styles.dim}>saved</span>}
          <span className={styles.spacer} />
          <button className={styles.btnDangerSm} title="Delete this pose" onClick={() => void doDelete()}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {big && (
        <div className={styles.modalBg} onClick={() => setBig(false)}>
          <img className={styles.full} src={igImage(pose.rel)} alt={pose.name} />
        </div>
      )}
    </div>
  )
})

export const PoseManagerPanel: React.FC = observer(() => {
  const [adding, setAdding] = useState(false)
  useEffect(() => { void store.load() }, [])

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <button className={styles.btn} onClick={() => void store.load()} disabled={store.loading}>
          <RefreshCw size={14} /> {store.loading ? 'Loading…' : 'Reload'}
        </button>
        <button className={styles.btnPrimary} onClick={() => setAdding(true)}><Plus size={14} /> Add pose</button>
        <span className={styles.dim}>{store.poses.length} poses</span>
        <span className={styles.spacer} />
        <input className={styles.input} placeholder="filter by name, prompt, category…"
               value={store.filterText} onChange={(e) => { store.filterText = e.target.value }} />
        <select className={styles.input} value={store.filterView}
                onChange={(e) => { store.filterView = e.target.value }}>
          <option value="">all views</option>
          {store.views.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className={styles.input} value={store.filterCategory}
                onChange={(e) => { store.filterCategory = e.target.value }}>
          <option value="">all categories</option>
          {store.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {store.dirtyCount > 0 && (
        <div className={styles.dirtyBar}>
          <strong>{store.dirtyCount}</strong> pose{store.dirtyCount === 1 ? '' : 's'} edited, not saved.
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} onClick={() => void store.saveAll()}>Save all</button>
          <button className={styles.btn} onClick={() => store.revertAll()}>Discard all</button>
        </div>
      )}

      {store.restartRequired && (
        <div className={styles.noteBar}>
          Poses were added or removed. Text edits reach the <strong>gallery</strong> on a browser
          refresh, but the node builds its pose list once at registration — so ComfyUI needs a
          restart before added or removed poses appear in it.
        </div>
      )}

      {store.error && <div className={styles.err}>{store.error}</div>}
      {store.msg && <div className={styles.msg}>{store.msg}</div>}

      <div className={styles.grid}>
        {store.visible.map((p) => <PoseCard key={p.id} pose={p} />)}
        {!store.loading && !store.visible.length && !store.error && (
          <div className={styles.dim}>No poses match that filter.</div>
        )}
      </div>

      {/* Shared suggestion lists: the existing vocabulary, so edits converge on the same
          words instead of sprouting near-duplicate categories. */}
      <datalist id="pm-views">{store.views.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="pm-cats">{store.categories.map((c) => <option key={c} value={c} />)}</datalist>

      {adding && <AddPoseModal onClose={() => setAdding(false)} />}
    </div>
  )
})
