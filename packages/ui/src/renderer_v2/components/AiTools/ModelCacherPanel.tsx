import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, FolderOpen, ArrowUp, HardDrive, Save, Loader2 } from 'lucide-react'
import { modelCacherStore as store } from '../../stores/ModelCacherStore'
import styles from './AiTools.module.scss'

const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb || 0)} MB`)

const NodeConfigRow: React.FC<{ node: string }> = observer(({ node }) => {
  const c = store.agents[node]?.cache || {}
  const [edit, setEdit] = React.useState<any>(null)
  const cur = edit ?? c
  const set = (k: string, v: any) => setEdit({ ...cur, [k]: v })
  return (
    <div className={styles.invEntry}>
      <div className={styles.invHead}>
        <label className={styles.efCheck}><input type="checkbox" checked={!!cur.enabled} onChange={(e) => { set('enabled', e.target.checked) }} /> {node}</label>
        <span className={styles.spacer} />
        {edit && <button className={styles.smBtn} onClick={() => { void store.saveNodeConfig(node, cur); setEdit(null) }}><Save size={12} /> Save</button>}
      </div>
      <div className={styles.cfgGrid}>
        {[['containerPath', 'Container'], ['hostPath', 'Host'], ['modelsHostPath', 'LLM models'], ['imagegenHostPath', 'Imagegen'], ['ttsHostPath', 'TTS']].map(([k, label]) => (
          <label key={k} className={styles.cfgField}><span className={styles.subLbl}>{label}</span>
            <input className={styles.subInput} value={cur[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></label>
        ))}
      </div>
    </div>
  )
})

export const ModelCacherPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])

  return (
    <div className={styles.panel}>
      {store.err && <div className={styles.error}>{store.err}</div>}
      {store.msg && <div className={styles.ok}>{store.msg}</div>}

      {/* Node config + capacity */}
      <div className={styles.ragCard}>
        <div className={styles.head}><h4 className={styles.h4}>Node Cache Config</h4><span className={styles.spacer} /><button className={styles.btn} onClick={() => void store.load()}><RefreshCw size={13} /> Refresh</button></div>
        {store.nodes.map((n) => <NodeConfigRow key={n} node={n} />)}
        <div className={styles.capRow}>
          {Object.entries(store.capacities).map(([node, cap]: any) => {
            const pct = cap.totalMB ? Math.min(100, Math.round((cap.usedMB / cap.totalMB) * 100)) : 0
            return (
              <div key={node} className={styles.capBox}>
                <div className={styles.capLabel}><HardDrive size={12} /> {node} — {gb(cap.usedMB)} / {gb(cap.totalMB)} ({gb(cap.freeMB)} free)</div>
                <div className={styles.capBar}><div className={styles.capFill} style={{ width: `${pct}%` }} /></div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Browse & cache */}
      <div className={styles.ragCard}>
        <h4 className={styles.h4}>Browse &amp; Cache</h4>
        <div className={styles.filterRow}>
          <select className={styles.miniSelect} value={store.bNode} onChange={(e) => store.setBrowse('bNode', e.target.value)}>
            {store.nodes.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select className={styles.miniSelect} value={store.bRoot} onChange={(e) => store.setBrowse('bRoot', e.target.value)}>
            <option value="imagegen">/imagegen</option><option value="tts">/tts</option><option value="models">/models (LLM)</option>
          </select>
          <input className={styles.searchInput} style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 6, padding: '0 9px', height: 30 }} placeholder="jump to subpath e.g. checkpoints/sdxl" value={store.bRel} onChange={(e) => store.setBrowse('bRel', e.target.value)} />
          <button className={styles.btn} disabled={store.browsing} onClick={() => void store.browse()}>{store.browsing ? <Loader2 size={13} className={styles.spin} /> : <FolderOpen size={13} />} Browse</button>
        </div>
        {store.browseErr && <div className={styles.error}>{store.browseErr}</div>}
        {(store.bDirs.length > 0 || store.bFiles.length > 0 || store.bCwd) && (
          <div className={styles.browser}>
            <div className={styles.crumb}>{store.bCwd} {store.bRel && <button className={styles.smBtn} onClick={() => store.up()}><ArrowUp size={11} /> up</button>}</div>
            {store.bDirs.map((d) => (
              <div key={'d:' + d} className={styles.browseRow}>
                <button className={styles.dirBtn} onClick={() => store.descend(d)}><FolderOpen size={12} /> {d}/</button>
                <span className={styles.spacer} />
                <button className={styles.smBtn} disabled={store.busy} onClick={() => void store.cacheItem(d, 0)}>Cache dir</button>
              </div>
            ))}
            {store.bFiles.map((f) => (
              <div key={'f:' + f.name} className={styles.browseRow}>
                <span className={styles.fileName}>{f.name}</span>
                <span className={styles.dim}>{gb(f.sizeMB)}</span>
                <span className={styles.spacer} />
                <button className={styles.smBtn} disabled={store.busy} onClick={() => void store.cacheItem(f.name, f.sizeMB)}>Cache</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cached models */}
      <div className={styles.ragCard}>
        <div className={styles.head}><h4 className={styles.h4}>Cached Models <span className={styles.dim}>({store.entries.length})</span></h4><span className={styles.spacer} /><button className={styles.btn} onClick={() => void store.refreshList()}><RefreshCw size={13} /> Refresh</button></div>
        {store.cacheableNodes.length === 0 && store.entries.length === 0 && <div className={styles.muted}>No cache-enabled nodes / cached models.</div>}
        {store.nodes.filter((n) => store.entriesForNode(n).length).map((node) => (
          <div key={node} className={styles.cacheGroup}>
            <div className={styles.cacheGroupLabel}>{node}</div>
            {store.entriesForNode(node).map((e) => (
              <div key={e.cacheDir} className={styles.browseRow}>
                <span className={styles.bold}>{e.displayName || [e.family, e.variant, e.quant].filter(Boolean).join(' / ') || e.cacheDir}</span>
                <span className={`${e.status === 'cached' ? styles.up : e.status === 'caching' || e.status === 'queued' ? styles.unknown : styles.down}`}>{e.status}{e.queuePosition ? ` #${e.queuePosition}` : ''}</span>
                <span className={styles.dim}>{gb(e.sizeMB)}</span>
                <span className={styles.spacer} />
                <button className={styles.iconDanger} title="Remove from cache" onClick={() => { if (window.confirm(`Evict "${e.displayName || e.cacheDir}" from ${node}'s cache?`)) void store.removeEntry(e) }}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
})
