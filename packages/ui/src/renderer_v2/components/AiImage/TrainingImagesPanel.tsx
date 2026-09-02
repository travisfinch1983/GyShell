import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Layers, FolderOpen, Star, X, ChevronUp, ChevronDown } from 'lucide-react'
import { trainingImagesStore as store, igThumb, igImage, type IgImage } from '../../stores/TrainingImagesStore'
import { confirmStore } from '../../stores/confirmStore'
import { promptStore } from '../../stores/promptStore'
import { CropEditor } from './CropEditor'
import { AutoCaptionModal } from './AutoCaptionModal'
import { BlanketTagModal } from './BlanketTagModal'
import styles from './TrainingImages.module.scss'

const SORT_KEYS: { v: any; label: string }[] = [
  { v: 'name', label: 'Name' }, { v: 'created', label: 'Date created' }, { v: 'modified', label: 'Date modified' },
  { v: 'added', label: 'Date added' }, { v: 'size', label: 'Size' },
]

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
      const r = await store.batchAdd(batch, files, creating)
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
const Picker: React.FC<{ op: 'move' | 'copy'; files: string[]; onClose: () => void; onDone: () => void }> = ({ op, files, onClose, onDone }) => {
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
    if (dest === store.cwd) { setMsg("that's the source folder"); return }
    setMsg(`${verb}ing ${files.length}…`)
    try { const r = await store.transfer(op, dest, files); setMsg(`${verb}d ${r.done} → ${r.dest}`); setTimeout(() => { onClose(); onDone() }, 700) }
    catch (e: any) { setMsg('Failed: ' + (e?.message || e)) }
  }
  return (
    <div className={styles.modalBg}>{/* deliberately NOT click-to-close: a stray backdrop click was eating typed input */}
      <div className={styles.pkBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}><strong>{verb} {files.length} image{files.length > 1 ? 's' : ''} to…</strong><button className={styles.btn} onClick={onClose}>Cancel</button></div>
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
          <span className={styles.dim}>→ {pcwd || 'training_images'}</span>
          <button className={styles.btnPrimary} disabled={(pcwd || '') === (store.cwd || '')} onClick={() => void go()}>{verb} here</button>
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

const Tile: React.FC<{ im: IgImage; i: number; onOpen: () => void }> = observer(({ im, i, onOpen }) => {
  const sel = store.selected.has(im.name)
  const timer = useRef<any>(null); const longRef = useRef(false); const down = useRef({ x: 0, y: 0 })
  const label = im.w && im.h ? `${im.w}×${im.h}` : im.name
  return (
    <div className={`${styles.tile} ${sel ? styles.tileSel : ''}`}
      onMouseDown={(e) => { if (e.button !== 0) return; longRef.current = false; down.current = { x: e.clientX, y: e.clientY }; timer.current = setTimeout(() => { longRef.current = true; if (!store.selectionMode) store.enterSelection(); if (!store.selected.has(im.name)) store.toggleOne(i); store.lastIndex = i }, 400) }}
      onMouseMove={(e) => { if (timer.current && (Math.abs(e.clientX - down.current.x) > 6 || Math.abs(e.clientY - down.current.y) > 6)) { clearTimeout(timer.current); timer.current = null } }}
      onMouseLeave={() => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }}
      onMouseUp={(e) => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        if (longRef.current) { longRef.current = false; return }
        if (store.selectionMode) { if (e.shiftKey && store.lastIndex != null) store.selectRange(store.lastIndex, i); else { store.toggleOne(i); store.lastIndex = i } }
        else onOpen()
      }}>
      {/* mousedown/mouseup must not reach the tile: mouseup precedes click, and the
          tile's mouseup opens the editor — which made circle-clicks look broken (they
          entered selection mode AND opened the image on top of it). */}
      <span className={styles.pick}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); if (!store.selectionMode) store.enterSelection(); store.toggleOne(i); store.lastIndex = i }} />
      {im.cropped && <span className={`${styles.bdg} ${styles.bdgCrop}`} title="Cropped">✓</span>}
      {im.has_alt && <span className={styles.bdg} title="Upscaled — swap available in editor">⤴</span>}
      {im.has_caption && <span className={styles.bdg} title="Has tags (.txt)">✎</span>}
      {im.has_nl_caption && <span className={styles.bdg} title="Has caption (.caption)">❝</span>}
      {!!im.score && <span className={`${styles.bdg} ${styles.bdgScore}`} title={`Rating ${im.score}/10${im.comment ? ' — ' + im.comment : ''}`}>★{im.score}</span>}
      <img loading="lazy" src={igThumb(im.rel, im.mtime)} alt="" draggable={false} />
      <span className={styles.tileName} title={im.name}>{label}</span>
    </div>
  )
})

export const TrainingImagesPanel: React.FC = observer(() => {
  const [lb, setLb] = useState<{ rel: string; name: string; bust?: number } | null>(null)
  const [picker, setPicker] = useState<'move' | 'copy' | null>(null)
  const [merge, setMerge] = useState(false)
  const [crop, setCrop] = useState<{ rel: string; name: string } | null>(null)
  const cropIdxRef = useRef(0)
  // undefined = whole folder; a list = caption only these (selection, or one from the editor)
  const [capFiles, setCapFiles] = useState<string[] | undefined>(undefined)
  const [autoCap, setAutoCap] = useState(false)
  const [blanket, setBlanket] = useState(false)
  const [batchAdd, setBatchAdd] = useState(false)
  const [setAdd, setSetAdd] = useState(false)
  useEffect(() => { void store.browse('') }, [])
  // In a training_set, click = crop/resize editor; elsewhere, click = zoom preview.
  // The crop editor is really the image DETAIL view — it carries the crop box, the .txt tag
  // box, the .caption box and the rating together. It used to open only inside a training_set,
  // which meant tags could not be read or edited anywhere else, even though the tagger writes
  // sidecars into any folder. Collages still open in the lightbox.
  const openImage = (im: IgImage) => setCrop({ rel: im.rel, name: im.name })

  const doDelete = async () => {
    const n = store.selected.size
    if (!(await confirmStore.confirm({ title: 'Delete from training set', message: `Delete ${n} image${n > 1 ? 's' : ''} from this set? Originals are not affected.`, confirmText: 'Delete' }))) return
    store.msg = `Deleting ${n}…`
    try { const r = await store.deleteSelected(); store.msg = `Deleted ${r.deleted}.`; void store.browse(store.cwd) }
    catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }
  const doStrip = async (files?: string[]) => {
    const scope = files?.length ? `${files.length} image(s)` : 'EVERY image in this set'
    if (!(await confirmStore.confirm({ title: 'Strip booru tags (.txt)', message: `Delete the .txt tag sidecars for ${scope}? Images and .caption files are untouched. Cannot be undone.`, confirmText: 'Strip' }))) return
    store.msg = 'Stripping tags…'
    try { const r = await store.stripTags(files); store.msg = `Stripped ${r.removed} tag file(s).`; void store.browse(store.cwd) }
    catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }
  const doWipe = async (files?: string[]) => {
    const scope = files?.length ? `${files.length} selected image(s)` : `all ${store.ratedCount} rated image(s) in this ${store.inTrainingSet ? 'training set' : 'folder'}`
    if (!(await confirmStore.confirm({ title: 'Wipe ratings & comments', message: `Clear ratings and comments for ${scope}? This removes scores + notes only — images, tags, and captions are untouched. Cannot be undone.`, confirmText: 'Wipe' }))) return
    store.msg = 'Wiping ratings…'
    try { const r = await store.wipeRatings(files); store.msg = `Wiped ${r.cleared} rating(s).`; void store.browse(store.cwd) }
    catch (e: any) { store.msg = 'Failed: ' + (e?.message || e) }
  }
  const doRenameFiles = async () => {
    const base = await promptStore.prompt({ title: `Rename ${store.selected.size} images`, placeholder: 'base name, e.g. white → white-1..N (lowercased)', confirmText: 'Rename' })
    if (base === null || !base.trim()) return
    // Number in DISPLAY order, not click order — white-1 is the first tile on screen.
    const ordered = store.visibleImages.filter((im) => store.selected.has(im.name)).map((im) => im.name)
    store.msg = `Renaming ${ordered.length}…`
    try {
      const r = await store.renameFiles(ordered, base.trim())
      store.msg = `Renamed ${r.renamed.length} → ${base.trim().toLowerCase()}-1..${r.renamed.length}${r.ratings_moved ? ` (${r.ratings_moved} ratings followed)` : ''}.`
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
              <option value="uncropped">Needs crop ({store.images.filter((im) => !im.cropped).length})</option>
              <option value="cropped">Cropped ({store.images.filter((im) => im.cropped).length})</option>
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
                ? store.visibleImages.filter((im) => store.selected.has(im.name)).map((im) => im.name)
                : undefined)
              setAutoCap(true)
            }}>
            {store.selectionMode && store.selected.size ? `🏷 Auto-caption (${store.selected.size})…` : '🏷 Auto-caption…'}
          </button>
          <button className={styles.btn} title="Add or remove the same booru tags across this folder" onClick={() => setBlanket(true)}>🏷 Blanket tags…</button>
          <button className={styles.btn} onClick={() => void doCollage()}>🖼 Generate collage</button>
          {store.hasCollage && <button className={styles.btn} onClick={() => setLb({ rel: `${store.cwd}/${store.collageFirst}`, name: 'collage', bust: Date.now() })}>View collage</button>}
          <button className={styles.btn} onClick={() => void doStrip()}>🧹 Strip tags</button>
          <span className={styles.msg}>{store.msg}</span>
        </div>
      )}

      {store.selectionMode && (
        <div className={styles.selbar}>
          <button className={styles.iconBtn} title="Clear" onClick={() => store.exitSelection()}><X size={14} /></button>
          <span>{store.selected.size} selected</span>
          <button className={styles.btn} onClick={() => store.selectAll()}>Select all ({store.visibleImages.length})</button>
          <button className={styles.btn} disabled={!store.selected.size} onClick={() => store.deselectAll()}>Deselect all</button>
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} title="Copy the selection + caption sidecars into an existing training set, or create a new one beside this folder — works from inside a set too, for cherry-picking an already-curated selection" onClick={() => setSetAdd(true)}>Add to Training Set</button>
          <button className={styles.btn} onClick={() => setPicker('move')}>Move…</button>
          <button className={styles.btn} onClick={() => setPicker('copy')}>Copy…</button>
          <button className={styles.btn} title="Copy the selection + caption sidecars into a training batch assembled from many sets" onClick={() => setBatchAdd(true)}>Add to batch…</button>
          <button className={styles.btn} title="Rename the selection to <name>-1..N in display order — sidecars and ratings follow" onClick={() => void doRenameFiles()}>Rename…</button>
          {store.inTrainingSet && <button className={styles.btnDanger} onClick={() => void doDelete()}>Delete</button>}
          <button className={styles.btn} title="Add or remove the same booru tags across the selected images" onClick={() => setBlanket(true)}>Blanket tags…</button>
          <button className={styles.btn} title="Strip .txt tag sidecars for the selected images" onClick={() => void doStrip([...store.selected])}>Strip tags</button>
          <button className={styles.btn} title="Clear ratings + comments for the selected images" onClick={() => void doWipe([...store.selected])}>Wipe ratings</button>
          <span className={styles.msg}>{store.msg}</span>
        </div>
      )}

      {store.error && <div className={styles.error}>{store.error}</div>}

      {store.atNarrowedRoot && (
        <div className={styles.acHint} style={{ padding: '0 12px 6px' }}>
          Showing training folders only. The rest of <code>/ai-assets/imagegen</code> (checkpoints,
          loras, vae…) is still reachable — switch to <strong>All folders</strong> above.
        </div>
      )}

      {store.folders.length > 0 && (
        <div className={styles.folders}>
          {store.folders.map((f) => {
            const path = store.cwd ? `${store.cwd}/${f.name}` : f.name
            return (
              <button key={f.name} className={styles.folder} onClick={() => void store.browse(path)}>
                <span className={styles.folderIc}>{f.is_training_set ? <Star size={15} /> : <FolderOpen size={15} />}</span>
                <span className={styles.folderName}>{f.name}</span>
                {f.is_training_set ? <span className={`${styles.fbadge} ${styles.fbadgeTs}`}>training_set</span> : f.has_training_set ? <span className={styles.fbadge}>has set</span> : null}
                {(f.is_training_set || f.is_training_batch) && <span className={styles.ren} title="Rename suffix" onClick={(e) => { e.stopPropagation(); void doRename(path, f.name) }}>✎</span>}
                <span className={styles.folderMeta}>{f.n_images} img{f.n_subfolders ? ` · ${f.n_subfolders} sub` : ''}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className={styles.grid}>
        {store.images.length === 0 && !store.loading && <div className={styles.dim}>No images here.</div>}
        {store.visibleImages.map((im, i) => <Tile key={im.rel} im={im} i={i} onOpen={() => openImage(im)} />)}
      </div>

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
            if (next) setCrop({ rel: next.rel, name: next.name })
            else if (at < 0) setCrop(null)   // list emptied under us — nothing left to page to
          }}
          onCaption={() => { setCapFiles([crop.name]); setAutoCap(true) }} />
      })()}
      {autoCap && <AutoCaptionModal files={capFiles} onClose={() => setAutoCap(false)} />}

      {blanket && <BlanketTagModal files={[...store.selected]} onClose={() => setBlanket(false)} onDone={() => void store.browse(store.cwd)} />}
      {batchAdd && <AddToBatchModal kind="batch" files={[...store.selected]} onClose={() => setBatchAdd(false)} />}
      {setAdd && <AddToBatchModal kind="set" files={[...store.selected]} onClose={() => setSetAdd(false)} />}
      {picker && <Picker op={picker} files={[...store.selected]} onClose={() => setPicker(null)} onDone={() => void store.browse(store.cwd)} />}
      {merge && <MergeModal onClose={() => setMerge(false)} />}
    </div>
  )
})
