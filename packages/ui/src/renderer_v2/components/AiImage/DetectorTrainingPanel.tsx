import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Play, Square, Download, AlertTriangle, Cpu } from 'lucide-react'
import { detectorTrainingStore as store, type RunRec } from '../../stores/DetectorTrainingStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './DetectorTraining.module.scss'

const pct = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0)
const mib = (n?: number | null) => (n == null ? '—' : `${(n / 1024).toFixed(1)} GiB`)
const dur = (s?: number) => {
  if (!s) return '—'
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${Math.round(s % 60)}s`
}

/** Default install name in the convention the other detectors already use. */
const installName = (r: RunRec) =>
  `${(r.dataset || 'detector').replace(/(^.)/, (c) => c.toUpperCase())}-${r.run}-(segm)-(y11)-(Segment).pt`

const Metrics: React.FC<{ m?: Record<string, number> }> = ({ m }) => {
  if (!m || !Object.keys(m).length) return <span className={styles.dim}>no epoch finished yet</span>
  return (
    <span className={styles.metrics}>
      {(['mAP50(M)', 'mAP50-95(M)', 'precision(M)', 'recall(M)'] as const).map((k) =>
        m[k] == null ? null : <span key={k}><b>{m[k].toFixed(3)}</b> {k.replace('(M)', '')}</span>)}
    </span>
  )
}

export const DetectorTrainingPanel: React.FC = observer(() => {
  const [installing, setInstalling] = useState('')

  useEffect(() => {
    store.loadOptions()
    return () => store.stopWatching()
  }, [])

  const d = store.datasetRec
  const g = store.gpuRec
  const base = store.baseRec
  const errs = store.formErrors
  const live = store.detail

  const doInstall = async (r: RunRec) => {
    const name = installName(r)
    if (!await confirmStore.confirm({
      title: 'Install detector',
      message: `Copy this run's best.pt into the shared detector folder as "${name}"? ` +
               `ComfyUI and the dataset seeder both read from there.`,
      confirmText: 'Install', danger: false,
    })) return
    setInstalling(`${r.dataset}/${r.run}`)
    await store.install(r.dataset, r.run, name)
    setInstalling('')
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Detector Training</span>
        <button className={styles.btn} onClick={() => store.loadOptions()} disabled={store.loading}>
          <RefreshCw size={13} className={store.loading ? styles.spin : ''} /> Refresh
        </button>
        <div className={styles.spacer} />
        {store.notice && <span className={styles.ok}>{store.notice}</span>}
      </div>

      {store.error && <div className={styles.errorBar}>{store.error}</div>}

      <div className={styles.body}>
        {/* ── configure ─────────────────────────────────────────────── */}
        <div className={styles.form}>
          <label className={styles.lbl}>Dataset</label>
          <select className={styles.input} value={store.dataset}
                  onChange={(e) => { store.set('dataset', e.target.value); store.set('runName', store.suggestName()) }}>
            {!store.datasets.length && <option value="">no datasets found</option>}
            {store.datasets.map((x) => (
              <option key={x.name} value={x.name}>{x.name} — {x.trainable_tiles} trainable tiles</option>
            ))}
          </select>
          {d && (
            <div className={styles.meta}>
              {d.sources} source images · {d.tiles} tiles · <b>{d.positives}</b> positive
              {' / '}<b>{d.negatives}</b> background
              {d.held_back > 0 && <> · <span className={styles.warnText}>{d.held_back} held back
                (rejected or unlabelled — these never reach training)</span></>}
            </div>
          )}

          <label className={styles.lbl}>Base model to fine-tune</label>
          <select className={styles.input} value={store.baseModel}
                  onChange={(e) => store.set('baseModel', e.target.value)}>
            <optgroup label="Stock weights (recommended)">
              {store.baseModels.filter((m) => !m.trained).map((m) => (
                <option key={m.path} value={m.path}>{m.label} — {m.size_mib} MiB</option>
              ))}
            </optgroup>
            <optgroup label="Already-trained detectors">
              {store.baseModels.filter((m) => m.trained).map((m) => (
                <option key={m.path} value={m.path}>{m.label} — {m.size_mib} MiB</option>
              ))}
            </optgroup>
          </select>
          {base?.warn && (
            <div className={styles.warnBox}>
              <AlertTriangle size={13} />
              <span>{base.warn}</span>
            </div>
          )}

          <label className={styles.lbl}>GPU</label>
          <select className={styles.input} value={store.gpu} onChange={(e) => store.set('gpu', e.target.value)}>
            <option value="">choose a card…</option>
            {store.gpus.map((x) => (
              <option key={x.alias} value={x.alias}>
                {x.alias} — {mib(x.free_mib)} free of {mib(x.total_mib)}
                {x.processes.length ? ` · busy: ${x.processes.map((p) => p.name).join(', ')}` : ''}
              </option>
            ))}
          </select>
          {/* Selecting by NAME, not index: the number means a different card on this host
              depending on CUDA's ordering, which is how a job lands on a card nobody chose. */}
          <div className={styles.meta}>
            <Cpu size={11} /> needs about <b>{mib(store.vramEstimate)}</b> (estimate at batch {store.batch}, {store.imgsz}px)
            {g && <> · {store.gpu} has {mib(g.free_mib)} free</>}
          </div>
          {store.vramTight && (
            <div className={styles.warnBox}>
              <AlertTriangle size={13} />
              <span>
                {store.gpu} looks too full for this run. Free it, pick another card, or lower the
                batch size. {g?.processes.length ? `Holding it: ${g.processes.map((p) => `${p.name} (${mib(p.used_mib)})`).join(', ')}.` : ''}
                <label className={styles.chkLine}>
                  <input type="checkbox" checked={store.allowLowVram}
                         onChange={(e) => store.set('allowLowVram', e.target.checked)} />
                  launch anyway — the memory frees up before the model loads
                </label>
              </span>
            </div>
          )}
          {store.runningHere && (
            <div className={styles.warnBox}>
              <AlertTriangle size={13} />
              <span>{store.gpu} is already training <b>{store.runningHere.run}</b>. Two runs on one
                card OOM each other partway in — the launch will be refused.</span>
            </div>
          )}

          <div className={styles.row}>
            <div>
              <label className={styles.lbl}>Run name</label>
              <input className={styles.input} value={store.runName}
                     onChange={(e) => store.set('runName', e.target.value)} />
            </div>
            <div>
              <label className={styles.lbl}>Epochs</label>
              <input className={styles.input} type="number" value={store.epochs}
                     onChange={(e) => store.setNum('epochs', e.target.value)} />
            </div>
          </div>
          <div className={styles.row}>
            <div>
              <label className={styles.lbl}>Image size</label>
              <input className={styles.input} type="number" step={32} value={store.imgsz}
                     onChange={(e) => store.setNum('imgsz', e.target.value)} />
            </div>
            <div>
              <label className={styles.lbl}>Batch</label>
              <input className={styles.input} type="number" value={store.batch}
                     onChange={(e) => store.setNum('batch', e.target.value)} />
            </div>
            <div>
              <label className={styles.lbl}>Seed</label>
              <input className={styles.input} type="number" value={store.seed}
                     onChange={(e) => store.setNum('seed', e.target.value)} />
            </div>
          </div>
          <div className={styles.hint}>
            Tiles are 768px and train at {store.imgsz}px. The dataset is re-exported from the
            manifest at launch, so every review decision made up to now is included, and the
            train/val split is by SOURCE image — never by tile, or four near-identical crops of
            one render would straddle both sides and inflate the score.
          </div>

          {errs.length > 0 && (
            <ul className={styles.errs}>{errs.map((e) => <li key={e}>{e}</li>)}</ul>
          )}

          <button className={`${styles.btn} ${styles.btnGo}`} disabled={store.starting || errs.length > 0}
                  onClick={() => store.start()}>
            <Play size={13} /> {store.starting ? 'Exporting and launching…' : 'Start training'}
          </button>

          {/* The server's refusal, in full. It carries the actionable part — which card, how
              much was free, what is holding it — and collapsing it to "failed" throws that away. */}
          {store.refusal && (
            <div className={styles.refusal}>
              <b>Refused:</b> {store.refusal.error}
              {store.refusal.fix && <div className={styles.dim}>{store.refusal.fix}</div>}
              {Array.isArray(store.refusal.busy_with) && store.refusal.busy_with.length > 0 && (
                <div className={styles.dim}>holding it: {store.refusal.busy_with
                  .map((p: any) => `${p.name} (${mib(p.used_mib)})`).join(', ')}</div>
              )}
              {Array.isArray(store.refusal.gpus) && (
                <div className={styles.dim}>cards: {store.refusal.gpus
                  .map((x: any) => `${x.alias} ${mib(x.free_mib)} free`).join(' · ')}</div>
              )}
            </div>
          )}
        </div>

        {/* ── runs ─────────────────────────────────────────────────── */}
        <div className={styles.runs}>
          {live && (
            <div className={styles.liveCard}>
              <div className={styles.liveHead}>
                <span className={styles.fname}>{live.dataset} / {live.run}</span>
                <span className={`${styles.state} ${styles['st_' + (live.state || 'unknown')]}`}>{live.state}</span>
              </div>
              <div className={styles.bar}>
                <div className={styles.barFill}
                     style={{ width: `${pct(live.epochs_done || 0, live.epochs || 1)}%` }} />
              </div>
              <div className={styles.meta}>
                epoch <b>{live.epochs_done || 0}</b> / {live.epochs} · {dur(live.elapsed_s)} elapsed
                {live.gpu && <> · on <b>{live.gpu}</b></>}
              </div>
              <div className={styles.meta}><Metrics m={live.metrics} /></div>
              {live.note && <div className={styles.warnText}>{live.note}</div>}
              {live.error && <div className={styles.errText}>{live.error}</div>}
              <div className={styles.actions}>
                {live.state === 'running' && (
                  <button className={styles.btn} onClick={async () => {
                    if (await confirmStore.confirm({
                      title: 'Stop training',
                      message: `Stop ${live.dataset}/${live.run}? Checkpoints already written stay on disk.`,
                      confirmText: 'Stop', danger: true,
                    })) store.stopRun(live.dataset, live.run)
                  }}><Square size={12} /> Stop</button>
                )}
                {live.has_weights && (
                  <button className={styles.btn} disabled={installing === `${live.dataset}/${live.run}`}
                          onClick={() => doInstall(live)}><Download size={12} /> Install as detector</button>
                )}
              </div>
              {live.log_tail && <pre className={styles.log}>{live.log_tail}</pre>}
            </div>
          )}

          <div className={styles.runsHead}>Runs</div>
          <div className={styles.runList}>
            {!store.runs.length && <div className={styles.empty}>no training runs yet</div>}
            {store.runs.map((r) => (
              <button key={`${r.dataset}/${r.run}`}
                      className={`${styles.runRow} ${store.selected === `${r.dataset}/${r.run}` ? styles.runRowActive : ''}`}
                      onClick={() => store.watch(r.dataset, r.run)}>
                <span className={styles.runName}>{r.dataset} / <b>{r.run}</b></span>
                <span className={`${styles.state} ${styles['st_' + (r.state || 'unknown')]}`}>{r.state || 'on disk'}</span>
                <span className={styles.runMeta}>
                  {r.epochs_done != null && <>{r.epochs_done}{r.epochs ? `/${r.epochs}` : ''} ep · </>}
                  {r.metrics?.['mAP50(M)'] != null && <>mAP50 <b>{r.metrics['mAP50(M)'].toFixed(3)}</b> · </>}
                  {r.gpu || ''}
                  {r.base_is_trained && <span className={styles.warnText}> · fine-tuned from a trained detector</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
})
