import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { Download, RefreshCw, Search, Square, Play, X, Trash2, Loader2, Save } from 'lucide-react'
import { modelDownloadsStore as store, type DLItem, type HFFile } from '../../stores/ModelDownloadsStore'
import styles from './ModelDownloads.module.scss'

function gb(b?: number): string {
  if (!b || b <= 0) return '0'
  const g = b / 1024 ** 3
  return g >= 1 ? `${g.toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`
}
function pct(item: DLItem): number {
  if (!item.size || !item.progress) return 0
  return Math.min(100, Math.round((item.progress / item.size) * 100))
}

const QueueItem: React.FC<{ source: 'hf' | 'civ'; item: DLItem }> = observer(({ source, item }) => {
  const st = item.status || ''
  const active = st === 'downloading'
  const done = st === 'complete'
  const name = item.fileName || item.modelName || item.repo || item.id
  return (
    <div className={styles.qItem}>
      <div className={styles.qHead}>
        <span className={styles.qName} title={name}>{name}</span>
        <span className={`${styles.qStatus} ${done ? styles.sDone : st === 'failed' ? styles.sFail : active ? styles.sActive : styles.sQueued}`}>{st}</span>
      </div>
      {item.targetDir && <div className={styles.qDest} title={item.targetDir}>{item.targetDir}</div>}
      {active && (
        <div className={styles.qBarWrap}>
          <div className={styles.qBar} style={{ width: `${pct(item)}%` }} />
        </div>
      )}
      <div className={styles.qMeta}>
        {active ? <span>{pct(item)}% · {gb(item.progress)} / {gb(item.size)}{item.speed ? ` · ${gb(item.speed)}/s` : ''}</span> : <span>{gb(item.size)}</span>}
        {item.error && <span className={styles.qErr} title={item.error}>{item.error}</span>}
        <div className={styles.spacer} />
        {active && <button className={styles.qAct} title="Stop" onClick={() => void store.action(source, item.id, 'stop')}><Square size={12} /></button>}
        {(st === 'queued' || st === 'pending' || st === 'failed') && <button className={styles.qAct} title="Force start" onClick={() => void store.action(source, item.id, 'force')}><Play size={12} /></button>}
        <button className={`${styles.qAct} ${styles.danger}`} title="Cancel / remove" onClick={() => void store.action(source, item.id, 'cancel')}><X size={12} /></button>
      </div>
    </div>
  )
})

const QueueColumn: React.FC<{ source: 'hf' | 'civ'; title: string; items: DLItem[] }> = observer(({ source, title, items }) => {
  const active = items.filter((i) => i.status !== 'complete')
  const done = items.filter((i) => i.status === 'complete')
  return (
    <div className={styles.qCol}>
      <div className={styles.qColHead}>
        <span>{title}</span>
        <span className={styles.qCount}>{active.length} active</span>
        {done.length > 0 && <button className={styles.linkBtn} onClick={() => void store.clearCompleted(source)}>clear {done.length} done</button>}
      </div>
      {active.length === 0 && done.length === 0 && <div className={styles.empty}>No downloads.</div>}
      {active.map((i) => <QueueItem key={i.id} source={source} item={i} />)}
      {done.map((i) => <QueueItem key={i.id} source={source} item={i} />)}
    </div>
  )
})

const HFFileRow: React.FC<{ f: HFFile }> = observer(({ f }) => (
  <label className={styles.fileRow}>
    <input type="checkbox" checked={!!store.hfSelected[f.path]} onChange={() => store.toggleHfFile(f.path)} />
    <span className={styles.fileName}>{f.path}</span>
    {f.quant && <span className={styles.quantBadge}>{f.quant}</span>}
    <span className={styles.fileSize}>{gb(f.size)}</span>
  </label>
))

const HFView: React.FC = observer(() => {
  const a = store.hfAnalysis
  return (
    <div className={styles.formWrap}>
      <div className={styles.row}>
        <input className={styles.input} placeholder="HuggingFace repo (owner/model or URL)" value={store.hfRepo} onChange={(e) => (store.hfRepo = e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void store.browseHf()} />
        {store.hfBranches.length > 0 && (
          <select className={styles.select} value={store.hfRevision} onChange={(e) => (store.hfRevision = e.target.value)}>
            {store.hfBranches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        )}
        <button className={styles.btn} disabled={store.hfBrowsing} onClick={() => void store.browseHf()}>
          {store.hfBrowsing ? <Loader2 size={13} className={styles.spin} /> : <Search size={13} />} Browse
        </button>
      </div>
      {store.hfError && <div className={styles.errorBar}>{store.hfError}</div>}

      {a && (
        <>
          <div className={styles.analysis}>
            <span className={styles.repoType}>{a.repoType || 'unknown'}</span>
            <select className={styles.select} value={store.hfCategory} onChange={(e) => (store.hfCategory = e.target.value as any)}>
              {store.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input className={styles.input} placeholder="subfolder" value={store.hfSuggestedSubfolder} onChange={(e) => (store.hfSuggestedSubfolder = e.target.value)} />
          </div>

          {(a.ggufQuants?.length ?? 0) > 0 && (
            <div className={styles.fileSection}>
              <div className={styles.sectionLabel}>GGUF quants</div>
              {a.ggufQuants!.map((f) => <HFFileRow key={f.path} f={f} />)}
            </div>
          )}
          {a.components && Object.entries(a.components).map(([name, c]) => (
            <div key={name} className={styles.fileSection}>
              <div className={styles.sectionLabel}>{name} ({gb(c.totalSize)})</div>
              {(c.files ?? []).map((f) => <HFFileRow key={f.path} f={f} />)}
            </div>
          ))}

          <div className={styles.actionsRow}>
            <label className={styles.check}><input type="checkbox" checked={store.hfIncludeExtras} onChange={() => (store.hfIncludeExtras = !store.hfIncludeExtras)} /> include README/config</label>
            <div className={styles.spacer} />
            <span className={styles.selSummary}>{store.hfSelectedFiles.length} files · {gb(store.hfSelectedFiles.reduce((n, f) => n + (f.size || 0), 0))}</span>
            <button className={styles.btnPrimary} disabled={store.busy || !store.hfSelectedFiles.length} onClick={() => void store.downloadHf()}>
              <Download size={13} /> Download Selected
            </button>
          </div>
        </>
      )}
    </div>
  )
})

const CivitaiView: React.FC = observer(() => {
  const c = store.civConfig
  const set = (k: string, v: any) => store.setCivConfig(k, v)
  return (
    <div className={styles.formWrap}>
      <div className={styles.row}>
        <input className={styles.input} placeholder="CivitAI model URL" value={store.civUrl} onChange={(e) => (store.civUrl = e.target.value)} />
        <button className={styles.btnPrimary} disabled={store.busy || !store.civUrl.trim()} onClick={() => void store.downloadCiv()}>
          {store.busy ? <Loader2 size={13} className={styles.spin} /> : <Download size={13} />} Download
        </button>
      </div>
      <input className={styles.input} placeholder="path override (optional)" value={store.civPathOverride} onChange={(e) => (store.civPathOverride = e.target.value)} />
      {store.civError && <div className={styles.errorBar}>{store.civError}</div>}

      <div className={styles.settings}>
        <div className={styles.sectionLabel}>Settings</div>
        <div className={styles.settingRow}><label>Concurrent</label><input className={styles.numInput} type="number" value={c.concurrent ?? 3} onChange={(e) => set('concurrent', Number(e.target.value))} /></div>
        <label className={styles.check}><input type="checkbox" checked={c.downloadModel ?? true} onChange={(e) => set('downloadModel', e.target.checked)} /> Download model file</label>
        <label className={styles.check}><input type="checkbox" checked={c.saveMetadata ?? true} onChange={(e) => set('saveMetadata', e.target.checked)} /> Save metadata JSON</label>
        <label className={styles.check}><input type="checkbox" checked={c.downloadImages ?? false} onChange={(e) => set('downloadImages', e.target.checked)} /> Download preview images</label>
        {c.downloadImages && (
          <div className={styles.settingRow}><label>Image count</label><input className={styles.numInput} type="number" value={c.imageCount ?? 10} onChange={(e) => set('imageCount', Number(e.target.value))} /></div>
        )}
        <div className={styles.settingRow}><label>Path template</label><input className={styles.input} value={c.pathTemplate ?? '$REPO_NAME/$MODEL_FILE_NAME$EXTENSION'} onChange={(e) => set('pathTemplate', e.target.value)} /></div>
        <div className={styles.actionsRow}>
          <div className={styles.spacer} />
          <button className={styles.btn} onClick={() => void store.saveCivConfig()}><Save size={13} /> Save Settings</button>
        </div>
        <div className={styles.note}>Template vars: $REPO_NAME, $MODEL_TYPE, $BASE_MODEL_SHORT, $VERSION_NAME, $MODEL_FILE_NAME, $EXTENSION, $USER_DEFINED, … (full visual template builder deferred)</div>
      </div>
    </div>
  )
})

export const ModelDownloadsPanel: React.FC = observer(() => {
  useEffect(() => {
    store.startPolling(3000)
    void store.loadCivConfig()
    return () => store.stopPolling()
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Download size={16} className={styles.headerIcon} />
        <span className={styles.title}>Model Downloads</span>
        <div className={styles.tabs}>
          {([['queue', 'Queue'], ['hf', 'HF Downloader'], ['civitai', 'CivitAI']] as const).map(([id, label]) => (
            <button key={id} className={`${styles.tab} ${store.subTab === id ? styles.tabActive : ''}`} onClick={() => store.setSubTab(id)}>
              {label}
              {id === 'queue' && store.hfDownloads.concat(store.civDownloads).some((d) => d.status === 'downloading') && <span className={styles.dot} />}
            </button>
          ))}
        </div>
        <div className={styles.spacer} />
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.loadDownloads()}><RefreshCw size={14} /></button>
      </div>

      <div className={styles.body}>
        {store.subTab === 'queue' && (
          <div className={styles.queueCols}>
            <QueueColumn source="hf" title="HuggingFace" items={store.hfDownloads} />
            <QueueColumn source="civ" title="CivitAI" items={store.civDownloads} />
          </div>
        )}
        {store.subTab === 'hf' && <HFView />}
        {store.subTab === 'civitai' && <CivitaiView />}
      </div>
    </div>
  )
})
