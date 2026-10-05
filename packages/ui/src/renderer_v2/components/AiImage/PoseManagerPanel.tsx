import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Plus, Trash2, Undo2, Save, PersonStanding, Settings2, RotateCcw, X, Bone } from 'lucide-react'
import { poseManagerStore as store, type Pose, type MqStartOpts } from '../../stores/PoseManagerStore'
import { igThumb, igImage } from '../../stores/TrainingImagesStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './PoseManager.module.scss'
import { PoseSkeletonEditor } from './PoseSkeletonEditor'

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

/** GPU / model picker shared by the Convert dialog and the auto-convert settings. Free VRAM is live
 *  (Prometheus); a GPU is pickable only with enough of it free, and every warning is shown on its row. */
const MqOptions: React.FC<{ value: MqStartOpts; onChange: (v: MqStartOpts) => void; disabled?: boolean }> = observer(({ value, onChange, disabled }) => {
  useEffect(() => { void store.loadMqGpus(); const t = setInterval(() => void store.loadMqGpus(), 5000); return () => clearInterval(t) }, [])
  const host = store.mqHosts[value.host]
  const busy = new Set(store.runningMqJobs.filter((j) => j.host === value.host).flatMap((j) => j.gpus))
  const toggleGpu = (g: number) => onChange({ ...value, gpus: value.gpus.includes(g) ? value.gpus.filter((x) => x !== g) : [...value.gpus, g].sort((a, b) => a - b) })
  return (
    <>
      <div className={styles.section}>Host</div>
      <select className={styles.input} style={{ width: '100%' }} disabled={disabled} value={value.host}
              onChange={(e) => onChange({ ...value, host: e.target.value, gpus: [] })}>
        {Object.entries(store.mqHosts).map(([k, h]) => <option key={k} value={k} disabled={!!h.disabled}>{h.label}{h.disabled ? ` — ${h.disabled}` : ''}</option>)}
        {!Object.keys(store.mqHosts).length && <option value={value.host}>{value.host}</option>}
      </select>

      <div className={styles.section}>GPU(s) <span className={styles.dim}>— one worker per GPU; the batch is split between them</span></div>
      {store.mqGpuError && <div className={styles.err}>{store.mqGpuError}</div>}
      {host && !host.disabled && (
        <div className={styles.gpuList}>
          {host.gpus.map((g) => {
            const low = g.freeMB < store.mqMinFreeMB
            const off = g.avoid || busy.has(g.index)
            const checked = value.gpus.includes(g.index)
            return (
              <label key={g.index} className={`${styles.gpuRow} ${checked ? styles.gpuOn : ''} ${off ? styles.gpuOff : ''}`}>
                <input type="checkbox" disabled={disabled || off} checked={checked} onChange={() => toggleGpu(g.index)} />
                <span className={styles.gpuName}>#{g.index} {g.name}</span>
                <span className={low ? styles.gpuLow : styles.gpuFree}>{(g.freeMB / 1024).toFixed(1)} / {(g.totalMB / 1024).toFixed(0)} GB free</span>
                {busy.has(g.index) && <span className={styles.gpuWarn}>already converting</span>}
                {g.warn.map((w) => <span key={w} className={styles.gpuWarn}>⚠ {w}</span>)}
              </label>
            )
          })}
        </div>
      )}

      <div className={styles.row}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={styles.section}>Model</div>
          <select className={styles.input} style={{ width: '100%' }} disabled={disabled} value={value.quant} onChange={(e) => onChange({ ...value, quant: e.target.value as 'int8' | 'bf16' })}>
            <option value="int8">int8 (7 GB)</option><option value="bf16">bf16 (14 GB)</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={styles.section}>Text encoder</div>
          <select className={styles.input} style={{ width: '100%' }} disabled={disabled} value={value.te} onChange={(e) => onChange({ ...value, te: e.target.value as 'int8' | 'bf16' })}>
            <option value="int8">int8 (9 GB)</option><option value="bf16">bf16 (17 GB)</option>
          </select>
        </div>
        <div style={{ width: 70 }}>
          <div className={styles.section}>Steps</div>
          <input className={styles.input} style={{ width: '100%' }} type="number" min={4} max={60} disabled={disabled}
                 value={value.steps} onChange={(e) => onChange({ ...value, steps: parseInt(e.target.value, 10) || 25 })} />
        </div>
      </div>
      <div className={styles.section}>Outpaint cropped bodies</div>
      <select className={styles.input} style={{ width: '100%' }} disabled={disabled} value={value.outpaint}
              onChange={(e) => onChange({ ...value, outpaint: e.target.value as MqStartOpts['outpaint'] })}>
        <option value="auto">Auto — extend only the sides the body runs off</option>
        <option value="always">Always — pad every side</option>
        <option value="off">Off — keep the original framing</option>
      </select>
    </>
  )
})

const ConvertModal: React.FC<{ ids: string[]; onClose: () => void }> = observer(({ ids, onClose }) => {
  const s = store.mqSettings
  const [opts, setOpts] = useState<MqStartOpts>({ host: s.host, gpus: s.gpus, quant: s.quant, te: s.te, steps: s.steps, outpaint: s.outpaint, extra_prompt: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const replacing = ids.filter((id) => store.poses.find((p) => p.id === id)?.mannequin).length
  const go = async () => {
    if (!opts.gpus.length) { setMsg('Pick at least one GPU.'); return }
    setBusy(true); setMsg('Starting…')
    try { await store.startMannequin(ids, opts); store.clearSelection(); onClose() }
    catch (e: any) { setMsg('Failed: ' + String(e?.message || e)); setBusy(false) }
  }
  return (
    <div className={styles.modalBg}>
      <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>{ids.length > 0 && replacing === ids.length ? 'Regenerate' : 'Convert'} {ids.length} pose{ids.length === 1 ? '' : 's'} {replacing === ids.length ? 'mannequin' + (ids.length === 1 ? '' : 's') : 'to mannequin'}</strong>
          <button className={styles.btn} onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        <div className={styles.hint}>
          Qwen-Image 2.1 redraws each pose as a featureless grey mannequin in the same pose, on white, and finishes bodies that run off
          the edge. The original pose image is kept; the mannequin is saved alongside it.
          {replacing > 0 && <> <strong>{replacing}</strong> already {replacing === 1 ? 'has a mannequin — it' : 'have mannequins — they'} will be replaced.</>}
        </div>
        <MqOptions value={opts} onChange={setOpts} disabled={busy} />
        <div className={styles.section}>Extra instructions <span className={styles.dim}>(optional, added to the prompt)</span></div>
        <input className={styles.input} style={{ width: '100%' }} disabled={busy} value={opts.extra_prompt || ''}
               placeholder="e.g. keep the right hand resting on the hip" onChange={(e) => setOpts({ ...opts, extra_prompt: e.target.value })} />
        <div className={styles.modalFoot}>
          {msg && <span className={styles.dim}>{msg}</span>}
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} disabled={busy || !opts.gpus.length} onClick={() => void go()}>{replacing === ids.length ? 'Regenerate' : 'Convert'}</button>
        </div>
      </div>
    </div>
  )
})

const MqSettingsModal: React.FC<{ onClose: () => void }> = observer(({ onClose }) => {
  const s = store.mqSettings
  const [auto, setAuto] = useState(s.auto)
  const [opts, setOpts] = useState<MqStartOpts>({ host: s.host, gpus: s.gpus, quant: s.quant, te: s.te, steps: s.steps, outpaint: s.outpaint })
  const [msg, setMsg] = useState('')
  const save = async () => {
    try { await store.saveMqSettings({ ...opts, auto }); onClose() }
    catch (e: any) { setMsg('Failed: ' + String(e?.message || e)) }
  }
  return (
    <div className={styles.modalBg}>
      <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Mannequin conversion settings</strong>
          <button className={styles.btn} onClick={onClose}>Cancel</button>
        </div>
        <label className={styles.autoRow}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span><strong>Auto-convert new poses</strong> — every pose added to the library is converted right away on the GPU(s) below.</span>
        </label>
        <div className={styles.hint}>These are also the defaults the Convert dialog starts with.</div>
        <MqOptions value={opts} onChange={setOpts} />
        <div className={styles.modalFoot}>
          {msg && <span className={styles.err}>{msg}</span>}
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  )
})

const MqJobBar: React.FC = observer(() => {
  const recent = store.mqJobs.filter((j) => j.state === 'running' || (j.finishedAt && Date.now() - j.finishedAt < 10 * 60_000))
  if (!recent.length) return null
  return (
    <>
      {recent.map((j) => (
        <div key={j.id} className={j.state === 'running' ? styles.jobBar : j.state === 'done' ? styles.jobDone : styles.jobFail}>
          <strong>{j.state === 'running' ? 'Converting' : j.state === 'done' ? 'Converted' : j.state === 'cancelled' ? 'Cancelled' : 'Failed'}</strong>
          <span>{j.ok}/{j.total}{j.errors ? ` · ${j.errors} failed` : ''} · {j.host} GPU {j.gpus.join(', ')}{j.auto ? ' · auto' : ''}</span>
          {j.state === 'running' && <span className={styles.dim}>{j.workers.map((w) => `#${w.gpu} ${w.state} ${w.done}/${w.total}`).join(' · ')}</span>}
          {(j.error || j.lastError) && <span className={styles.jobErr} title={j.error || j.lastError || ''}>{j.error || j.lastError}</span>}
          <span className={styles.spacer} />
          {j.state === 'running' && <button className={styles.btnDangerSm} onClick={() => void store.cancelMannequin(j.id)}>Cancel</button>}
        </div>
      ))}
    </>
  )
})

const SkJobBar: React.FC = observer(() => {
  const recent = store.skJobs.filter((j) => j.state === 'running' || (j.finishedAt && Date.now() - j.finishedAt < 10 * 60_000))
  if (!recent.length) return null
  return (
    <>
      {recent.map((j) => (
        <div key={j.id} className={j.state === 'running' ? styles.jobBar : j.state === 'done' ? styles.jobDone : styles.jobFail}>
          <strong>{j.state === 'running' ? 'Detecting skeletons' : j.state === 'done' ? 'Skeletons detected' : j.state === 'cancelled' ? 'Cancelled' : 'Skeletons failed'}</strong>
          <span>{j.done}/{j.total}{j.flagged ? ` · ${j.flagged} to check` : ''}{j.kept ? ` · ${j.kept} hand-edited kept` : ''}{j.errors ? ` · ${j.errors} failed` : ''} · ai-epyc CPU{j.auto ? ' · auto' : ''}</span>
          {j.error && <span className={styles.jobErr} title={j.error}>{j.error}</span>}
          <span className={styles.spacer} />
          {j.flagged > 0 && j.state !== 'running' && <button className={styles.btnSm} onClick={() => { store.filterSkeleton = 'review' }}>Show the ones to check</button>}
          {j.state === 'running' && <button className={styles.btnDangerSm} onClick={() => void store.cancelSkeletons(j.id)}>Cancel</button>}
        </div>
      ))}
    </>
  )
})

/** Skeleton status under the mannequin thumbnail; opens the editor. */
const SkChip: React.FC<{ pose: Pose; onOpen: () => void }> = observer(({ pose, onOpen }) => {
  if (!pose.mannequin) return null
  if (store.detecting.has(pose.id)) return <div className={styles.mqPending}>skeleton…</div>
  const review = store.needsSkeletonReview(pose)
  const label = !pose.skeleton_at ? '+ skeleton' : pose.skeleton_stale ? 'skeleton stale' : review ? 'check skeleton' : pose.skeleton_source === 'edited' ? 'skeleton ✎' : 'skeleton ✓'
  return (
    <button className={`${styles.skChip} ${review ? styles.skChipWarn : pose.skeleton_at ? styles.skChipOk : ''}`} onClick={onOpen}
            title={pose.skeleton_at ? 'Open the skeleton editor' : 'No skeleton yet - open the editor to detect or place one'}>
      <Bone size={10} /> {label}
    </button>
  )
})

const PoseCard: React.FC<{ pose: Pose; onConvert: (ids: string[]) => void; onSkeleton: (p: Pose) => void }> = observer(({ pose, onConvert, onSkeleton }) => {
  const dirty = store.drafts.has(pose.id)
  const [big, setBig] = useState<string | null>(null)
  const sel = store.selected.has(pose.id)
  const converting = store.converting.has(pose.id)
  const removeMq = async () => {
    if (!(await confirmStore.confirm({ title: `Remove mannequin of ${pose.name}`, message: 'Delete the mannequin version? The original pose is kept.', confirmText: 'Remove' }))) return
    try { await store.removeMannequin(pose.id) } catch (e: any) { store.msg = 'Failed: ' + String(e?.message || e) }
  }

  const doDelete = async () => {
    if (!(await confirmStore.confirm({
      title: `Delete ${pose.name}`,
      message: `Remove this pose and its image from the library?\n\nAny workflow that selected it by name will fall back to the first pose. This cannot be undone.`,
      confirmText: 'Delete pose',
    }))) return
    try { await store.remove(pose.id) } catch (e: any) { store.msg = 'Failed: ' + String(e?.message || e) }
  }

  return (
    <div className={`${styles.card} ${dirty ? styles.cardDirty : ''} ${sel ? styles.cardSel : ''}`}>
      <div className={styles.thumbCol}>
        <label className={styles.selBox} title="Select for conversion"><input type="checkbox" checked={sel} onChange={() => store.toggleSelect(pose.id)} /></label>
        <img className={styles.thumb} src={igThumb(pose.rel)} alt={pose.name} loading="lazy"
             onClick={() => setBig(igImage(pose.rel))} title="Original — click to see it full size" />
        {pose.mannequin_rel ? (
          <div className={styles.mqWrap}>
            <img className={styles.thumbMq} src={igThumb(pose.mannequin_rel, pose.mannequin_at)} alt="mannequin" loading="lazy"
                 onClick={() => setBig(igImage(pose.mannequin_rel!, pose.mannequin_at))} title="Mannequin version — click to see it full size" />
            <div className={styles.mqActions}>
              <button className={styles.btnSm} disabled={converting} title="Regenerate this mannequin (new seed; the current one is replaced when the new one is done)" onClick={() => onConvert([pose.id])}><RotateCcw size={11} /> Regen</button>
              <button className={styles.btnSm} title="Remove the mannequin version" onClick={() => void removeMq()}><X size={11} /></button>
            </div>
          </div>
        ) : converting ? <div className={styles.mqPending}>converting…</div>
          : <button className={styles.mqMake} title="Convert this pose to a mannequin" onClick={() => onConvert([pose.id])}><PersonStanding size={12} /> mannequin</button>}
        {pose.mannequin_rel && !converting && <SkChip pose={pose} onOpen={() => onSkeleton(pose)} />}
      </div>
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
        <div className={styles.modalBg} onClick={() => setBig(null)}>
          <img className={styles.full} src={big} alt={pose.name} />
        </div>
      )}
    </div>
  )
})

export const PoseManagerPanel: React.FC = observer(() => {
  const [adding, setAdding] = useState(false)
  const [convertIds, setConvertIds] = useState<string[] | null>(null)
  const [mqSettingsOpen, setMqSettingsOpen] = useState(false)
  const [skPose, setSkPose] = useState<Pose | null>(null)
  useEffect(() => { void store.load(); void store.loadMqSettings(); void store.pollMq(); void store.pollSk() }, [])
  const withMq = [...store.selected].filter((id) => store.poses.find((p) => p.id === id)?.mannequin)
  const skCheck = store.poses.filter((p) => store.needsSkeletonReview(p)).length

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <button className={styles.btn} onClick={() => void store.load()} disabled={store.loading}>
          <RefreshCw size={14} /> {store.loading ? 'Loading…' : 'Reload'}
        </button>
        <button className={styles.btnPrimary} onClick={() => setAdding(true)}><Plus size={14} /> Add pose</button>
        <span className={styles.dim}>{store.poses.length} poses · {store.poses.filter((p) => p.mannequin).length} with mannequin · {store.poses.filter((p) => p.skeleton_at).length} with skeleton{skCheck ? ` (${skCheck} to check)` : ''}</span>
        <button className={styles.btn} title="Mannequin conversion settings (auto-convert new poses, default GPU)" onClick={() => setMqSettingsOpen(true)}>
          <Settings2 size={14} /> Mannequin{store.mqSettings.auto ? ' · auto' : ''}
        </button>
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
        <select className={styles.input} value={store.filterSkeleton} title="Filter by skeleton state"
                onChange={(e) => { store.filterSkeleton = e.target.value as typeof store.filterSkeleton }}>
          <option value="">any skeleton</option>
          <option value="review">skeleton to check</option>
          <option value="none">mannequin, no skeleton</option>
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

      <div className={styles.selBar}>
        <span>{store.selected.size ? <><strong>{store.selected.size}</strong> selected</> : <span className={styles.dim}>Tick poses to convert them to mannequins</span>}</span>
        <button className={styles.btnSm} onClick={() => store.selectVisible()}>Select all shown</button>
        <button className={styles.btnSm} onClick={() => store.selectWithoutMannequin()}>Select shown without mannequin</button>
        {store.selected.size > 0 && <button className={styles.btnSm} onClick={() => store.clearSelection()}>Clear</button>}
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={!withMq.length}
                title="Detect OpenPose skeletons on the selected poses' mannequins (ai-epyc CPU, ~2 s each). Hand-edited skeletons are kept."
                onClick={() => void store.detectSkeletons(withMq).catch((e) => { store.msg = 'Failed: ' + String(e?.message || e) })}>
          <Bone size={14} /> Detect skeletons{withMq.length ? ` (${withMq.length})` : ''}
        </button>
        <button className={styles.btnPrimary} disabled={!store.selected.size} onClick={() => setConvertIds([...store.selected])}>
          <PersonStanding size={14} /> Convert to mannequin…
        </button>
      </div>
      <MqJobBar />
      <SkJobBar />

      {store.error && <div className={styles.err}>{store.error}</div>}
      {store.msg && <div className={styles.msg}>{store.msg}</div>}

      <div className={styles.grid}>
        {store.visible.map((p) => <PoseCard key={p.id} pose={p} onConvert={setConvertIds} onSkeleton={setSkPose} />)}
        {!store.loading && !store.visible.length && !store.error && (
          <div className={styles.dim}>No poses match that filter.</div>
        )}
      </div>

      {/* Shared suggestion lists: the existing vocabulary, so edits converge on the same
          words instead of sprouting near-duplicate categories. */}
      <datalist id="pm-views">{store.views.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="pm-cats">{store.categories.map((c) => <option key={c} value={c} />)}</datalist>

      {adding && <AddPoseModal onClose={() => setAdding(false)} />}
      {convertIds && <ConvertModal ids={convertIds} onClose={() => setConvertIds(null)} />}
      {mqSettingsOpen && <MqSettingsModal onClose={() => setMqSettingsOpen(false)} />}
      {skPose && <PoseSkeletonEditor pose={store.poses.find((p) => p.id === skPose.id) || skPose} onClose={() => setSkPose(null)} />}
    </div>
  )
})
