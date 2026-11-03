import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Play, Square, Upload, X, Star, AlertTriangle, Box } from 'lucide-react'
import { image3dStore as store, type Job3d, type OptSpec } from '../../stores/Image3dStore'
import styles from './Image3d.module.scss'

/** Image → 3D (claude1 2026-11-03): upload photos, pick a model + GPU (or auto), go. Jobs run on the image model service. */

const dur = (s?: number) => (s == null ? '' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`)
const when = (t?: number) => (t ? new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`)

const OptionField: React.FC<{ k: string; spec: OptSpec }> = observer(({ k, spec }) => {
  const v = store.options[k]
  if (typeof spec === 'object') {
    return (
      <label className={styles.opt}><span>{k}</span>
        <select className={styles.input} value={String(v)} onChange={(e) => {
          const raw = e.target.value; store.setOption(k, typeof spec.default === 'number' ? Number(raw) : raw)
        }}>
          {spec.choices.map((c) => <option key={String(c)} value={String(c)}>{String(c)}</option>)}
        </select>
      </label>
    )
  }
  if (typeof spec === 'boolean') {
    return <label className={styles.optChk}><input type="checkbox" checked={Boolean(v)} onChange={(e) => store.setOption(k, e.target.checked)} /> {k}</label>
  }
  return (
    <label className={styles.opt}><span>{k}</span>
      <input className={styles.input} type={typeof spec === 'number' ? 'number' : 'text'} value={String(v ?? '')}
        onChange={(e) => store.setOption(k, typeof spec === 'number' ? Number(e.target.value) : e.target.value)} />
    </label>
  )
})

const JobCard: React.FC<{ j: Job3d }> = observer(({ j }) => {
  const active = ['queued', 'loading', 'running'].includes(j.status)
  const pct = Math.round((j.progress || 0) * 100)
  return (
    <div className={`${styles.jobCard} ${store.selectedId === j.id ? styles.jobCardSel : ''}`}>
      <img className={styles.jobThumb} src={store.thumbUrl(j)} alt="" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
      <div className={styles.jobBody}>
        <div className={styles.jobHead}>
          <span className={styles.jobName}>{j.name}</span>
          <span className={`${styles.state} ${styles['st_' + j.status] || ''}`}>{j.status}</span>
        </div>
        <div className={styles.jobMeta}>
          <b>{j.model_label}</b> · GPU {j.gpu} {j.gpu_name?.replace('NVIDIA GeForce ', '')} · {j.inputs.length} photo{j.inputs.length === 1 ? '' : 's'} · {when(j.created)}
        </div>
        {active && (
          <>
            <div className={styles.bar}><div className={styles.barFill} style={{ width: `${Math.max(3, pct)}%` }} /></div>
            <div className={styles.jobMeta}>{j.stage}{j.elapsed_s ? ` · ${dur(j.elapsed_s)}` : ''}{j.load_s ? ` · model loaded in ${dur(j.load_s)}` : ''}</div>
          </>
        )}
        {j.status === 'done' && (
          <div className={styles.jobMeta}>
            {j.result?.run_s != null && <>ran {dur(Number(j.result.run_s))}</>}
            {j.result?.peak_gb != null && <> · peak {String(j.result.peak_gb)} GB</>}
            {j.load_s != null && <> · load {dur(j.load_s)}</>}
          </div>
        )}
        {j.error && <div className={styles.errText}>{j.error}</div>}
        <div className={styles.actions}>
          {active && <button className={styles.btn} onClick={() => store.cancel(j)}><Square size={12} /> Cancel</button>}
          {j.status === 'done' && (
            <button className={styles.btn} onClick={() => store.select(j.id)} title="Open the 3D Viewer tab to see it">
              <Box size={12} /> {store.selectedId === j.id ? 'Selected in 3D Viewer' : 'Show in 3D Viewer'}
            </button>
          )}
          {j.status === 'done' && <a className={styles.btn} href={store.fileUrl(j, undefined, true)}>Download {j.output_type === 'splat' ? '.ply' : '.glb'}</a>}
        </div>
      </div>
    </div>
  )
})

export const Image3dPanel: React.FC = observer(() => {
  const fileInput = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  useEffect(() => { store.load(); store.watch(); return () => store.unwatch() }, [])
  const m = store.model
  const recent = store.jobs.slice(0, 30)

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Image → 3D</span>
        <span className={styles.dim}>photos in, textured 3D model out · runs on the image model service</span>
        <span className={styles.spacer} />
        <button className={styles.btn} onClick={() => store.load()} disabled={store.loading}><RefreshCw size={12} className={store.loading ? styles.spin : ''} /> Refresh</button>
      </div>
      {store.error && <div className={styles.errorBar} onClick={() => store.clearError()}>{store.error}</div>}
      <div className={styles.body}>
        <div className={styles.form}>
          <div className={styles.lbl}>Model</div>
          <div className={styles.modelList}>
            {store.models.map((x) => (
              <button key={x.id} className={`${styles.modelCard} ${x.id === store.modelId ? styles.modelCardSel : ''}`} onClick={() => store.setModel(x.id)}>
                <div className={styles.modelHead}>
                  <b>{x.label}</b>
                  <span className={styles.tag}>{x.input === 'multi' ? 'multi-view' : '1 photo'}</span>
                  <span className={styles.tag}>{x.output === 'splat' ? 'splat' : 'mesh'}</span>
                </div>
                <div className={styles.modelNote}>{x.notes}</div>
                <div className={styles.modelNote}>{x.time} · needs {x.vram_gb} GB</div>
              </button>
            ))}
          </div>

          <div className={styles.lbl}>GPU</div>
          <select className={styles.input} value={String(store.gpu)} onChange={(e) => store.setGpu(e.target.value)}>
            <option value="auto">Auto (best free card that can run it)</option>
            {(m?.gpus || []).map((g) => {
              const info = store.gpus.find((x) => x.index === g.index)
              return <option key={g.index} value={g.index} disabled={!g.ok}>
                GPU {g.index} · {g.name.replace('NVIDIA GeForce ', '')}{info ? ` · ${info.free_gb}/${info.total_gb} GB free` : ''}{g.ok ? '' : ` (can't: ${g.why})`}
              </option>
            })}
          </select>
          {m && !store.usableGpus.length && <div className={styles.warnBox}><AlertTriangle size={13} /> No GPU can run {m.label} right now.</div>}

          <div className={styles.lbl}>Photos {m?.input === 'single' ? '(this model uses the first one)' : '(all are used; first = front)'}</div>
          <div className={`${styles.drop} ${drag ? styles.dropOn : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); store.addFiles(e.dataTransfer.files) }}
            onClick={() => fileInput.current?.click()}>
            <Upload size={16} /> Drop photos here or click to choose
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) store.addFiles(e.target.files); e.target.value = '' }} />
          </div>
          {!!store.uploads.length && (
            <div className={styles.upGrid}>
              {store.uploads.map((u, i) => (
                <div key={i} className={`${styles.upItem} ${m?.input === 'single' && i > 0 ? styles.upUnused : ''}`}>
                  <img src={u.dataUrl} alt="" />
                  {i === 0 && <span className={styles.frontBadge}>front</span>}
                  <div className={styles.upBar}>
                    <span title={u.name}>{kb(u.size)}</span>
                    {i > 0 && <button title="Use as the front / main photo" onClick={() => store.moveFirst(i)}><Star size={11} /></button>}
                    <button title="Remove" onClick={() => store.removeUpload(i)}><X size={11} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className={styles.lbl}>Name</div>
          <input className={styles.input} value={store.name} placeholder="e.g. PCS skid" onChange={(e) => store.setName(e.target.value)} />

          {m && Object.keys(m.options).length > 0 && (
            <>
              <div className={styles.lbl}>Options</div>
              <div className={styles.optGrid}>{Object.entries(m.options).map(([k, spec]) => <OptionField key={k} k={k} spec={spec} />)}</div>
            </>
          )}

          <button className={`${styles.btn} ${styles.btnGo}`} disabled={!m || !store.uploads.length || store.submitting || !store.usableGpus.length}
            onClick={() => store.submit()}>
            <Play size={13} /> {store.submitting ? 'Uploading…' : `Generate with ${m?.label || '…'}`}
          </button>
          <div className={styles.hint}>
            Tips: the object alone in frame (no hands or people), even light, plain background if you can.
            Multi-view: walk around it, front first. Outputs are unit-sized; real dimensions get applied afterwards.
          </div>
        </div>

        <div className={styles.jobs}>
          <div className={styles.runsHead}>Jobs</div>
          {!recent.length && <div className={styles.empty}>No jobs yet.</div>}
          {recent.map((j) => <JobCard key={j.id} j={j} />)}
        </div>
      </div>
    </div>
  )
})
