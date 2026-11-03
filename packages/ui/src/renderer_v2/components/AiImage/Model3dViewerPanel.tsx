import React, { useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Download, Archive, Trash2, RotateCcw, Search } from 'lucide-react'
import { image3dStore as store } from '../../stores/Image3dStore'
import { confirmStore } from '../../stores/confirmStore'
import { Model3dCanvas, type ViewOpts } from './Model3dCanvas'
import styles from './Image3d.module.scss'

/** 3D Viewer (claude1 2026-11-03): every generated model on the left (with the model that made it), a viewer on the right. */

const when = (t?: number) => (t ? new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

export const Model3dViewerPanel: React.FC = observer(() => {
  const [opts, setOpts] = useState<ViewOpts>({ wireframe: false, autoRotate: false, dark: true, grid: true })
  const [resetKey, setResetKey] = useState(0)
  const [filter, setFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  useEffect(() => { store.load(); store.watch(); return () => store.unwatch() }, [])

  const list = useMemo(() => store.done.filter((j) =>
    (!modelFilter || j.model === modelFilter) && (!filter || `${j.name} ${j.model_label}`.toLowerCase().includes(filter.toLowerCase()))),
  [store.done, filter, modelFilter])
  const j = store.selected
  const toggle = (k: keyof ViewOpts) => setOpts((o) => ({ ...o, [k]: !o[k] }))

  const del = async () => {
    if (!j) return
    const ok = await confirmStore.confirm({ title: 'Delete 3D model', message: `Delete "${j.name}" (${j.model_label}) and all its files? This can't be undone.`, confirmText: 'Delete', danger: true })
    if (ok) store.remove(j)
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.title}>3D Viewer</span>
        <span className={styles.dim}>{store.done.length} models</span>
        <span className={styles.spacer} />
        <button className={styles.btn} onClick={() => store.load()} disabled={store.loading}><RefreshCw size={12} className={store.loading ? styles.spin : ''} /> Refresh</button>
      </div>
      {store.error && <div className={styles.errorBar} onClick={() => store.clearError()}>{store.error}</div>}
      <div className={styles.viewerBody}>
        <div className={styles.side}>
          <div className={styles.searchRow}>
            <Search size={12} />
            <input className={styles.input} placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <select className={styles.input} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}>
            <option value="">All generators</option>
            {store.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <div className={styles.sideList}>
            {!list.length && <div className={styles.empty}>Nothing here yet.</div>}
            {list.map((x) => (
              <button key={x.id} className={`${styles.sideItem} ${x.id === store.selectedId ? styles.sideItemSel : ''}`} onClick={() => store.select(x.id)}>
                <img src={store.thumbUrl(x)} alt="" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                <span className={styles.sideText}>
                  <b>{x.name}</b>
                  <span className={styles.genTag}>{x.model_label}</span>
                  <span className={styles.dim}>{when(x.created)}{x.inputs.length > 1 ? ` · ${x.inputs.length} photos` : ''}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.viewMain}>
          {!j && <div className={styles.empty}>Pick a model on the left.</div>}
          {j && (
            <>
              <div className={styles.viewBar}>
                <b className={styles.viewName}>{j.name}</b>
                <span className={styles.genTag}>{j.model_label}</span>
                <span className={styles.spacer} />
                {j.output_type === 'mesh' && <button className={`${styles.btn} ${opts.wireframe ? styles.btnOn : ''}`} onClick={() => toggle('wireframe')}>Wireframe</button>}
                {j.output_type === 'mesh' && <button className={`${styles.btn} ${opts.autoRotate ? styles.btnOn : ''}`} onClick={() => toggle('autoRotate')}>Spin</button>}
                {j.output_type === 'mesh' && <button className={`${styles.btn} ${opts.grid ? styles.btnOn : ''}`} onClick={() => toggle('grid')}>Grid</button>}
                <button className={styles.btn} onClick={() => toggle('dark')}>{opts.dark ? 'Light bg' : 'Dark bg'}</button>
                <button className={styles.btn} onClick={() => setResetKey((k) => k + 1)} title="Reset the camera"><RotateCcw size={12} /></button>
                <a className={styles.btn} href={store.fileUrl(j, undefined, true)}><Download size={12} /> {j.output_type === 'splat' ? '.ply' : '.glb'}</a>
                <a className={styles.btn} href={store.zipUrl(j)} title="Model, textures, inputs and job info as one zip"><Archive size={12} /> All files</a>
                <button className={styles.btn} onClick={del} title="Delete"><Trash2 size={12} /></button>
              </div>
              <Model3dCanvas key={j.id} url={store.fileUrl(j)} type={j.output_type} opts={opts} resetKey={resetKey} />
              <div className={styles.inputsStrip}>
                <span className={styles.dim}>Input{j.inputs.length > 1 ? 's' : ''}:</span>
                {j.inputs.map((p) => <a key={p} href={store.fileUrl(j, p)} target="_blank" rel="noreferrer"><img src={store.fileUrl(j, p)} alt="" /></a>)}
                <span className={styles.spacer} />
                <span className={styles.dim}>GPU {j.gpu} {j.gpu_name?.replace('NVIDIA GeForce ', '')}{j.result?.run_s != null ? ` · ${String(j.result.run_s)} s` : ''}{j.note ? ` · ${j.note}` : ''}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
})
