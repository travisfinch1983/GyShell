import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { Download, RefreshCw, Search, Square, Play, X, Loader2, Save } from 'lucide-react'
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
function when(ts?: string): string {
  if (!ts) return ''
  const d = Date.parse(ts)
  return d ? new Date(d).toLocaleDateString() : ''
}

/** Flatten /civitai/variables (array | grouped object | strings) into {token,label,group}[]. */
function flatVars(v: any): Array<{ token: string; label: string; group: string }> {
  const out: Array<{ token: string; label: string; group: string }> = []
  const tok = (s: string) => (s.startsWith('$') ? s : '$' + s)
  const push = (x: any, group = '') => {
    if (typeof x === 'string') out.push({ token: tok(x), label: x, group })
    else if (x && typeof x === 'object') {
      const t = x.token || x.name || x.var || x.key || x.value
      if (t) out.push({ token: tok(String(t)), label: x.label || x.name || String(t), group: x.group || group })
    }
  }
  if (Array.isArray(v)) v.forEach((x) => push(x))
  else if (v && typeof v === 'object') for (const [g, arr] of Object.entries(v)) (Array.isArray(arr) ? arr : [arr]).forEach((x) => push(x, g))
  return out
}

const HistoryList: React.FC<{ items: any[]; kind: 'hf' | 'civ' }> = ({ items, kind }) => {
  if (!items.length) return <div className={styles.empty}>No download history.</div>
  return (
    <div className={styles.histList}>
      {items.slice(0, 200).map((h, i) => {
        const name = kind === 'hf' ? h.repo : h.modelName || h.repo
        const dir = h.targetDir
        const size = kind === 'hf' ? h.totalSize : h.size
        return (
          <div key={(h.repo || h.modelId || i) + ':' + i} className={styles.histItem}>
            <div className={styles.histHead}>
              <span className={styles.histName} title={name}>{name}</span>
              {h.modelType && <span className={styles.histType}>{h.modelType}</span>}
              <span className={styles.histDate}>{when(h.lastDownloadedAt || h.downloadedAt)}</span>
            </div>
            {dir && <div className={styles.histDir} title={dir}>{dir}</div>}
            <div className={styles.histMeta}>{gb(size)}{(h.files?.length ?? 0) > 0 ? ` · ${h.files.length} files` : ''}</div>
          </div>
        )
      })}
    </div>
  )
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
        <label className={styles.inlineLabel}>Category</label>
        <select className={styles.select} value={store.hfCategory} onChange={(e) => (store.hfCategory = e.target.value as any)}>
          {store.categories.map((c) => <option key={c} value={c}>{c === 'image-gen' ? 'Image Generation' : c === 'llm' ? 'LLM' : 'TTS'}</option>)}
        </select>
        <label className={styles.inlineLabel} title="Max concurrent file downloads">Concurrent</label>
        <input className={styles.numInput} type="number" min={1} max={10} value={store.hfMaxActive} onChange={(e) => (store.hfMaxActive = Number(e.target.value))} />
      </div>
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
      <div className={styles.histSection}>
        <div className={styles.sectionLabel}>Download History</div>
        <HistoryList items={store.hfHistory} kind="hf" />
      </div>
    </div>
  )
})

const TemplateBuilder: React.FC = observer(() => {
  const vars = flatVars(store.civVariables)
  const groups = [...new Set(vars.map((v) => v.group || 'Variables'))]
  const types = store.civFolderTypes.map((ft: any) => (typeof ft === 'string' ? { id: ft, label: ft } : { id: ft.id || ft.value || ft.type, label: ft.label || ft.name || ft.id }))
  return (
    <div className={styles.tplBuilder}>
      <div className={styles.tplHeader}>
        <span className={styles.tplTitle}>Path Template</span>
        <select className={styles.select} value={store.civTplType} onChange={(e) => store.setCivTplType(e.target.value)}>
          <option value="_global">Global Default</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select className={styles.select} value={store.currentSep} onChange={(e) => store.setTplField('separator', e.target.value)} title="Separator">
          <option value="-">Dash (-)</option><option value="_">Underscore (_)</option><option value=".">Dot (.)</option><option value=" ">Space</option>
        </select>
        <select className={styles.select} value={store.currentCase} onChange={(e) => store.setTplField('caseMode', e.target.value)} title="Case">
          <option value="standard">Standard</option><option value="lowercase">lowercase</option><option value="uppercase">UPPERCASE</option>
        </select>
      </div>
      <input className={styles.tplInput} value={store.currentTpl} onChange={(e) => store.setTpl(e.target.value)} spellCheck={false} />
      <div className={styles.tplControls}>
        <button className={styles.btn} title="Insert folder separator" onClick={() => store.setTpl(store.currentTpl + '/')}>/ New Folder</button>
        <button className={styles.btn} onClick={() => store.insertTplVar('$EXTENSION')}>$EXTENSION</button>
        <button className={styles.btn} onClick={() => store.setTpl('')}>Clear</button>
        <div className={styles.spacer} />
        <button className={styles.btnPrimary} onClick={() => void store.saveTemplate()}><Save size={13} /> Save Template</button>
      </div>
      <div className={styles.tplVarGroups}>
        {groups.map((g) => (
          <div key={g} className={styles.tplVarGroup}>
            <div className={styles.tplVarGroupLabel}>{g}</div>
            <div className={styles.tplVarChips}>
              {vars.filter((v) => (v.group || 'Variables') === g).map((v) => (
                <button key={v.token} className={styles.tplVarChip} title={v.token} onClick={() => store.insertTplVar(v.token)}>{v.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

function dateBadge(ts?: string): { cls: string; str: string; title: string } | null {
  if (!ts) return null
  const dt = new Date(ts)
  const str = dt.toLocaleDateString()
  const days = (Date.now() - dt.getTime()) / 86400000
  if (days < 1) return { cls: styles.dRecent, str, title: `Today — ${str}` }
  if (days < 30) return { cls: styles.dMonth, str, title: `This month — ${str}` }
  if (days < 365) return { cls: styles.dYear, str, title: `This year — ${str}` }
  return { cls: styles.dOld, str, title: `Over a year — ${str}` }
}

const CivHistory: React.FC = observer(() => {
  const items = store.civHistory
  const types = Object.keys(store.histTypeCounts).sort()
  const fc = store.histFlagCounts
  const filtered = store.filteredHistory
  const page = store.histPage
  const ps = store.histPageSize
  const from = filtered.length === 0 ? 0 : (ps === 0 ? 0 : page * ps) + 1
  const to = ps === 0 ? filtered.length : Math.min(filtered.length, page * ps + store.histPageItems.length)
  const noSel = store.histSelected.size === 0
  return (
    <div className={styles.histSection}>
      <div className={styles.histHeader}>
        <span className={styles.sectionLabel}>Download History ({items.length})</span>
        <div className={styles.spacer} />
        <button className={styles.btnSm} disabled={store.histSyncing} onClick={() => void store.histSync()}>{store.histSyncing ? 'Syncing…' : 'Sync'}</button>
        <button className={styles.btnSm} onClick={() => void store.histLocate()}>Locate</button>
        <button className={styles.btnSm} disabled={noSel} onClick={() => void store.histAction('/api/civitai/history/check-updates')}>Update</button>
        <button className={styles.btnSm} disabled={noSel} onClick={() => void store.histAction('/api/civitai/renamer/add')}>→ Renamer</button>
        <button className={styles.btnSmPrimary} disabled={noSel} onClick={() => void store.histAction('/api/civitai/history/send-to-queue')}>→ Queue</button>
      </div>

      <div className={styles.histBadges}>
        <button className={`${styles.hBadge} ${store.histAllOn ? styles.hBadgeActive : ''}`} onClick={() => store.histShowAll()}>All ({items.length})</button>
        {types.map((t) => (
          <button key={t} className={`${styles.hBadge} ${!store.histHiddenTypes.has(t) ? styles.hBadgeActive : ''}`} onClick={() => store.toggleHistType(t)}>{t} ({store.histTypeCounts[t]})</button>
        ))}
        <button className={`${styles.hBadge} ${styles.hFlag} ${!store.histHiddenFlags.has('located') ? styles.hBadgeActive : ''}`} onClick={() => store.toggleHistFlag('located')}>Located ({fc.located})</button>
        <button className={`${styles.hBadge} ${styles.hFlag} ${!store.histHiddenFlags.has('customPath') ? styles.hBadgeActive : ''}`} onClick={() => store.toggleHistFlag('customPath')}>Custom Path ({fc.customPath})</button>
        <button className={`${styles.hBadge} ${styles.hFlag} ${!store.histHiddenFlags.has('customFilename') ? styles.hBadgeActive : ''}`} onClick={() => store.toggleHistFlag('customFilename')}>Custom Filename ({fc.customFilename})</button>
      </div>

      <input className={styles.input} placeholder="Filter by name…" value={store.histText} onChange={(e) => store.setHistText(e.target.value)} />

      <div className={styles.histPager}>
        <button className={styles.btnSm} disabled={page <= 0} onClick={() => store.histPrev()}>◀</button>
        <span className={styles.pagerInfo}>{from}-{to} of {filtered.length}</span>
        <button className={styles.btnSm} disabled={page >= store.histTotalPages - 1} onClick={() => store.histNext()}>▶</button>
        <select className={styles.numInput} value={ps} onChange={(e) => store.setHistPageSize(Number(e.target.value))}>
          {[10, 50, 100, 250, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
          <option value={0}>All</option>
        </select>
        <button className={styles.btnSm} onClick={() => store.histSelectPage()}>Select Page</button>
        <button className={styles.btnSm} onClick={() => store.histSelectAll()}>Select All</button>
        <button className={styles.btnSm} disabled={noSel} onClick={() => store.histDeselectAll()}>Deselect ({store.histSelected.size})</button>
      </div>

      <div className={styles.histList}>
        {filtered.length === 0 && <div className={styles.empty}>{items.length ? 'No items match filter' : 'No history — click Sync.'}</div>}
        {store.histPageItems.map((it) => {
          const db = dateBadge(it.downloadedAt)
          const located = it.hasFiles || it.locatedFiles?.length
          return (
            <div key={`${it.modelId}:${it.versionId || ''}`} className={`${styles.histItem} ${store.isHistSelected(it) ? styles.histSel : ''}`}>
              <div className={styles.histHead}>
                <input type="checkbox" checked={store.isHistSelected(it)} onChange={() => store.toggleHistSelect(it)} />
                <a className={styles.histName} href={it.pageUrl || `https://civitai.com/models/${it.modelId}`} target="_blank" rel="noreferrer" title={it.modelName}>{it.modelName}</a>
              </div>
              <div className={styles.histTags}>
                <span className={styles.histType}>{it.modelType}</span>
                {it.versionName && <span className={styles.hTag}>{it.versionName}</span>}
                {it.baseModel && <span className={styles.hTagDim}>{it.baseModel}</span>}
                {it.pathOverride && <span className={styles.hTagPath} title={it.pathOverride}>custom path</span>}
                {it.fileNameOverride && <span className={styles.hTagFn} title={it.fileNameOverride}>custom filename</span>}
                {located ? <span className={styles.hTagLoc} title={it.locatedPath || 'located'}>located</span> : null}
                {db && <span className={`${styles.dBadge} ${db.cls}`} title={db.title}>{db.str}</span>}
                {it.source === 'synced' && <span className={styles.hTagDim}>synced</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
})

const CivitaiView: React.FC = observer(() => {
  const c = store.civConfig
  const set = (k: string, v: any) => store.setCivConfig(k, v)
  return (
    <div className={styles.civLayout}>
      {/* LEFT — mode toggle + downloader + history */}
      <div className={styles.civLeft}>
        <div className={styles.modeToggle}>
          {(['downloader', 'review', 'renamer'] as const).map((m) => (
            <button key={m} className={`${styles.modeBtn} ${store.civMode === m ? styles.modeBtnActive : ''}`} onClick={() => store.setCivMode(m)}>
              {m === 'downloader' ? 'Downloader' : m === 'review' ? 'Review' : 'Renamer'}
              {m === 'review' && store.civDownloads.length > 0 && <span className={styles.modeCount}>{store.civDownloads.length}</span>}
            </button>
          ))}
        </div>

        {store.civMode === 'downloader' && (
          <>
            <div className={styles.row}>
              <a className={styles.btn} href="https://civitai.com" target="_blank" rel="noreferrer">Open CivitAI</a>
              <input className={styles.input} placeholder="Paste CivitAI model URL" value={store.civUrl} onChange={(e) => (store.civUrl = e.target.value)} />
            </div>
            <div className={styles.row}>
              <input className={styles.input} placeholder="path override (optional)" value={store.civPathOverride} onChange={(e) => (store.civPathOverride = e.target.value)} />
              <button className={styles.btnPrimary} disabled={store.busy || !store.civUrl.trim()} onClick={() => void store.downloadCiv()}>
                {store.busy ? <Loader2 size={13} className={styles.spin} /> : <Download size={13} />} Download
              </button>
            </div>
            {store.civError && <div className={styles.errorBar}>{store.civError}</div>}
          </>
        )}
        {store.civMode === 'review' && (
          <div className={styles.note}>Review queue — items sent from the browser extension's “Review” button or “→ Queue” below appear in the Download Queue. (Full model/version review browser is the next parity pass.)</div>
        )}
        {store.civMode === 'renamer' && (
          <div className={styles.note}>Renamer — select history items below and use “→ Renamer” to queue relocations/renames. (Full renamer review pane is the next parity pass.)</div>
        )}

        <CivHistory />
      </div>

      {/* RIGHT — settings + template builder */}
      <div className={styles.civRight}>
        <div className={styles.settings}>
          <div className={styles.sectionLabel}>Download Settings</div>
          <div className={styles.settingRow}><label>Concurrent</label><input className={styles.numInput} type="number" value={c.concurrent ?? 3} onChange={(e) => set('concurrent', Number(e.target.value))} /></div>
          <label className={styles.check}><input type="checkbox" checked={c.downloadModel ?? true} onChange={(e) => set('downloadModel', e.target.checked)} /> Download model file</label>
          <label className={styles.check}><input type="checkbox" checked={c.saveMetadata ?? true} onChange={(e) => set('saveMetadata', e.target.checked)} /> Save metadata JSON</label>
          {c.saveMetadata !== false && (
            <div className={styles.settingRow}><label>Meta suffix</label><input className={styles.numInput} style={{ width: 100 }} value={c.metadataSuffix ?? 'civitai'} onChange={(e) => set('metadataSuffix', e.target.value)} /><span className={styles.note}>.json</span></div>
          )}
          <label className={styles.check}><input type="checkbox" checked={c.downloadImages ?? false} onChange={(e) => set('downloadImages', e.target.checked)} /> Download preview images</label>
          {c.downloadImages && (
            <>
              <div className={styles.settingRow}><label>Image count</label><input className={styles.numInput} type="number" value={c.imageCount ?? 10} onChange={(e) => set('imageCount', Number(e.target.value))} /></div>
              <div className={styles.settingRow}><label>Size</label><select className={styles.select} value={c.imageSize ?? 'original'} onChange={(e) => set('imageSize', e.target.value)}><option value="preview">Preview</option><option value="original">Original</option><option value="both">Both</option></select></div>
              <div className={styles.settingRow}><label>Source</label><select className={styles.select} value={c.imageSource ?? 'model-card-first'} onChange={(e) => set('imageSource', e.target.value)}><option value="model-card-first">Model Card First</option><option value="model-card">Model Card Only</option><option value="gallery-first">Gallery First</option><option value="gallery">Gallery Only</option></select></div>
            </>
          )}
          <div className={styles.actionsRow}>
            <div className={styles.spacer} />
            <button className={styles.btn} onClick={() => void store.saveCivConfig()}><Save size={13} /> Save Settings</button>
          </div>
        </div>
        <TemplateBuilder />
      </div>
    </div>
  )
})

export const ModelDownloadsPanel: React.FC = observer(() => {
  useEffect(() => {
    store.startPolling(3000)
    void store.loadCivConfig()
    void store.loadCivExtras()
    void store.loadHistories()
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
