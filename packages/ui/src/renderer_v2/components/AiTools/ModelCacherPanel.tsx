import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, FolderOpen, ArrowUp, HardDrive, Save, Loader2, Download } from 'lucide-react'
import { modelCacherStore as store } from '../../stores/ModelCacherStore'
import { confirmStore } from '../../stores/confirmStore'
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

      {/* RAM-drive capacity (detected live via df) */}
      <div className={styles.ragCard}>
        <div className={styles.head}><h4 className={styles.h4}>RAM Drive Capacity</h4><span className={styles.spacer} /><button className={styles.btn} onClick={() => void store.refreshList()}><RefreshCw size={13} /> Refresh</button></div>
        <div className={styles.capRow}>
          {Object.keys(store.capacities).length === 0 && <div className={styles.muted}>No capacity reported — no cache-enabled nodes reachable.</div>}
          {Object.entries(store.capacities).map(([node, cap]: any) => {
            const pct = cap.totalMB ? Math.min(100, Math.round((cap.usedMB / cap.totalMB) * 100)) : 0
            return (
              <div key={node} className={styles.capBox}>
                <div className={styles.capLabel}><HardDrive size={13} /> <strong>{node}</strong> — {gb(cap.usedMB)} used / {gb(cap.totalMB)} total · {gb(cap.freeMB)} free ({pct}%)</div>
                <div className={styles.capBar}><div className={pct > 90 ? styles.capFillHot : styles.capFill} style={{ width: `${pct}%` }} /></div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Cache an LLM by Family / Variant / Quant — copies the WHOLE quant folder */}
      <div className={styles.ragCard}>
        <h4 className={styles.h4}>Cache LLM Model</h4>
        <p className={styles.muted}>Select a model — the entire quant folder is copied (handles multi-file AWQ / FP16-safetensors / sharded GGUF).</p>
        <div className={styles.qcGrid}>
          <label className={styles.cfgField}><span className={styles.subLbl}>Node</span>
            <select className={styles.subInput} value={store.qcNode} onChange={(e) => store.setQc('qcNode', e.target.value)}>
              {store.cacheableNodes.map((n) => <option key={n} value={n}>{n}</option>)}
            </select></label>
          <label className={styles.cfgField}><span className={styles.subLbl}>Family</span>
            <select className={styles.subInput} value={store.qcFamily} onChange={(e) => store.setQc('qcFamily', e.target.value)}>
              <option value="">—</option>{store.qcFamilies.map((f) => <option key={f} value={f}>{f}</option>)}
            </select></label>
          <label className={styles.cfgField}><span className={styles.subLbl}>Variant</span>
            <select className={styles.subInput} value={store.qcVariant} disabled={!store.qcFamily} onChange={(e) => store.setQc('qcVariant', e.target.value)}>
              <option value="">—</option>{store.qcVariants.map((v) => <option key={v} value={v}>{v}</option>)}
            </select></label>
          <label className={styles.cfgField}><span className={styles.subLbl}>Quant</span>
            <select className={styles.subInput} value={store.qcQuant} disabled={!store.qcVariant} onChange={(e) => store.setQc('qcQuant', e.target.value)}>
              <option value="">—</option>{store.qcQuants.map((q) => <option key={q.key} value={q.key}>{q.label} ({gb(q.sizeMB)})</option>)}
            </select></label>
          <button className={styles.btnPrimary} disabled={store.busy || !store.qcQuant || !store.qcNode} onClick={() => void store.cacheSelectedQuant()}>
            {store.busy ? <Loader2 size={13} className={styles.spin} /> : <Download size={13} />} Cache
          </button>
        </div>
      </div>

      {/* Browse & cache imagegen / TTS / model folders */}
      <div className={styles.ragCard}>
        <h4 className={styles.h4}>Browse &amp; Cache Folders</h4>
        <p className={styles.muted}>For imagegen / TTS assets — use “Cache dir” to copy an entire folder.</p>
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
                <button className={styles.smBtn} disabled={store.busy} onClick={() => void store.cacheItem(f.name, f.sizeMB)}>Cache file</button>
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
            {store.entriesForNode(node).map((e) => {
              const caching = e.status === 'caching'
              const queued = e.status === 'queued'
              const pct = caching ? store.progressPct(e) : null
              return (
                <div key={e.cacheDir} className={styles.cacheEntry}>
                  <div className={styles.browseRow}>
                    <span className={styles.bold}>{e.displayName || [e.family, e.variant, e.quant].filter(Boolean).join(' / ') || e.cacheDir}</span>
                    <span className={`${e.status === 'cached' ? styles.up : caching || queued ? styles.unknown : styles.down}`}>{e.status}{queued && e.queuePosition ? ` #${e.queuePosition}` : ''}</span>
                    <span className={styles.dim}>{caching && pct != null ? `${gb(e.sizeMB)} (${pct}%)` : gb(e.sizeMB)}</span>
                    <span className={styles.spacer} />
                    <button className={styles.iconDanger} title="Remove from cache" onClick={async () => {
                      const ok = await confirmStore.confirm({ title: 'Evict cached model', message: `Remove “${e.displayName || e.cacheDir}” from ${node}'s RAM cache? The original on disk is not affected.`, confirmText: 'Evict', danger: true })
                      if (ok) void store.removeEntry(e)
                    }}><Trash2 size={12} /></button>
                  </div>
                  {(caching || queued) && (
                    <div className={styles.capBar}>
                      <div className={pct != null ? styles.capFill : styles.capIndeterminate} style={pct != null ? { width: `${pct}%` } : undefined} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
})
