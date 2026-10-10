import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Loader2, Save, Pin, PinOff } from 'lucide-react'
import { imageModelsStore as store, KIND_LABEL, KIND_ROOT, type ModelRow } from '../../stores/ImageModelsStore'
import styles from '../AiTools/AiTools.module.scss'

const gb = (v: any) => (v == null || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(Number(v) < 10 ? 1 : 0)} GB`)
const ago = (t: number | null | undefined) => {
  if (!t) return '—'
  const s = Math.max(0, Date.now() / 1000 - t)
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

const Bar: React.FC<{ label: string; used: number; total: number; note?: string }> = ({ label, used, total, note }) => {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0
  return (
    <div className={styles.capBox}>
      <div className={styles.capLabel}>{label}: {gb(used)} / {gb(total)} ({pct}%){note ? ` · ${note}` : ''}</div>
      <div className={styles.capBar}><div className={pct > 90 ? styles.capFillHot : styles.capFill} style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 4, fontSize: 11, border: '1px solid var(--border)', whiteSpace: 'nowrap' }
const smallBtn: React.CSSProperties = { height: 22, padding: '0 7px', fontSize: 11 }

const Row: React.FC<{ n: any; r: ModelRow; label: string }> = observer(({ n, r, label }) => {
  const [target, setTarget] = useState('')
  const [gpuSel, setGpuSel] = useState('')   // '' = auto (omit gpu: the service picks)
  const svcs = store.servicesFor(n, r.kind)
  const cs = n.cacheService
  const busy = !!store.busyKey
  const body = { kind: r.kind, name: r.name }
  const loadOn = target || svcs.find((s: any) => !r.hotOn.some((h) => h.service === s.id))?.id || svcs[0]?.id || ''
  const loadSvc = svcs.find((s: any) => s.id === loadOn)
  const gpus: any[] = loadSvc?.service?.gpus || []
  const hotLabel = (h: ModelRow['hotOn'][number]) => {
    const fr = h.gpu != null ? (n.services || []).find((x: any) => x.id === h.service)?.gpuFriendly?.[h.gpu] : null
    return `:${h.port}${h.gpu != null ? ` GPU${h.gpu}` : ''}${fr ? ` (${fr.replace(/^GeForce /, '')})` : ''}`
  }
  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>
        {r.hotOn.map((h) => <span key={`${h.service}:${h.gpu}`} style={{ ...chip, borderColor: 'var(--accent)' }} title={`${h.tier} on :${h.port}${h.gpuName ? ` ${h.gpuName}` : ''}${h.busy ? ' (busy)' : ''}${h.waiting ? `, ${h.waiting} waiting` : ''}`}>🔥 {hotLabel(h)}{h.tier !== 'hot' ? ' (RAM-offloaded)' : ''}</span>)}
        {r.ram && <span style={chip} title={`RAM tier${r.ram.copying ? ' (copying)' : ''}`}>⚡ RAM{r.ram.copying ? '…' : ''}</span>}
        {r.persist && <span style={chip} title={`${label} tier${r.persist.copying ? ' (copying)' : ''}`}>💾 {label}{r.persist.copying ? '…' : ''}</span>}
        {!r.hotOn.length && !r.ram && !r.persist && <span style={{ ...chip, opacity: 0.6 }}>❄ NAS</span>}
      </td>
      <td>{KIND_LABEL[r.kind] || r.kind}</td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all' }}>{r.name}</td>
      <td style={{ whiteSpace: 'nowrap' }}>{gb(r.sizeGb)}</td>
      <td style={{ whiteSpace: 'nowrap' }} title="Decayed-LRU score; higher stays longer">{r.ram ? r.ram.score?.toFixed(2) : '—'}</td>
      <td style={{ whiteSpace: 'nowrap' }}>{ago(r.ram?.last ?? r.persist?.last)}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {!r.ram && cs && <button className={styles.btn} style={smallBtn} disabled={busy} title="Copy into this host's RAM tier (and the persistent mirror)" onClick={() => void store.act(cs, '/cache/warm', body, `Warm ${r.name}`)}>Warm</button>}
          {r.kind !== 'lora' && svcs.length > 0 && (
            <>
              <select className={styles.subInput} value={loadOn} onChange={(e) => { setTarget(e.target.value); setGpuSel('') }} title="Service to load it on">
                {svcs.map((s: any) => <option key={s.id} value={s.id}>:{s.port} {s.service?.gpu || s.gpuName || ''}</option>)}
              </select>
              {gpus.length > 1 && (
                <select className={styles.subInput} value={gpuSel} onChange={(e) => setGpuSel(e.target.value)} title="GPU within that service (auto: where it is already loaded, else the most free VRAM that fits)">
                  <option value="">auto</option>
                  {gpus.map((g) => <option key={g.index} value={String(g.index)}>GPU{g.index} · {loadSvc?.gpuFriendly?.[g.index] || g.name?.replace(/^NVIDIA (GeForce )?/, '')} ({Number(g.free_gb).toFixed(1)} GB free)</option>)}
                </select>
              )}
              <button className={styles.btn} style={smallBtn} disabled={busy || !loadOn} title="Make it hot on that service's GPU"
                onClick={() => void store.act(loadOn, '/models/load', gpuSel === '' ? body : { ...body, gpu: Number(gpuSel) }, `Load ${r.name}`)}>Load</button>
            </>
          )}
          {r.hotOn.map((h) => <button key={`${h.service}:${h.gpu}`} className={styles.btn} style={smallBtn} disabled={busy} title={`Unload the copy on ${hotLabel(h)}`}
            onClick={() => void store.act(h.service, '/models/unload', h.gpu != null ? { ...body, gpu: h.gpu } : body, `Unload ${r.name}`)}>Unload {hotLabel(h)}</button>)}
          {r.ram && cs && <button className={styles.btn} style={smallBtn} disabled={busy} title={r.ram.pinned ? 'Unpin (may be evicted)' : 'Pin (never evicted, restored first)'} onClick={() => void store.act(cs, '/cache/pin', { ...body, pinned: !r.ram.pinned, tier: 'ram' }, `${r.ram.pinned ? 'Unpin' : 'Pin'} ${r.name}`)}>{r.ram.pinned ? <PinOff size={11} /> : <Pin size={11} />}</button>}
          {r.ram && cs && <button className={styles.btn} style={smallBtn} disabled={busy} title="Remove from the RAM tier (the NAS copy stays)" onClick={() => void store.act(cs, '/cache/evict', { ...body, tier: 'ram' }, `Evict ${r.name} from RAM`)}>Evict RAM</button>}
          {r.persist && cs && <button className={styles.btn} style={smallBtn} disabled={busy} title={`Remove from the ${label} tier (the NAS copy stays)`} onClick={() => void store.act(cs, '/cache/evict', { ...body, tier: 'optane' }, `Evict ${r.name} from ${label}`)}>Evict {label}</button>}
        </div>
      </td>
    </tr>
  )
})

const NodeCard: React.FC<{ n: any }> = observer(({ n }) => {
  const c = n.cache
  const label = c?.config?.persist_label || c?.optane?.label || 'Persistent'
  const d = store.draft(n)
  const rows = store.rows(n)
  const shown = rows.slice(0, 300)
  return (
    <div className={styles.ragCard}>
      <div className={styles.head}>
        <h4 className={styles.h4} style={{ margin: 0 }}>{n.node}</h4>
        <span className={styles.muted} style={{ fontSize: 11 }}>{n.services.length} service{n.services.length === 1 ? '' : 's'} · cache read from {n.cacheService || '—'}</span>
      </div>
      {n.cacheError && <div style={{ color: 'var(--danger, #f87171)', fontSize: 12 }}>Cache: {n.cacheError}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={styles.muted} style={{ fontSize: 11, fontWeight: 600 }}>RAM tier</div>
          {store.kinds(n).map((k) => <Bar key={k} label={KIND_LABEL[k] || k} used={c?.ram?.[k]?.used_gb ?? 0} total={c?.ram?.[k]?.quota_gb ?? 0} note={c?.ram?.[k]?.copy_error ? `copy error: ${c.ram[k].copy_error}` : `${c?.ram?.[k]?.files ?? 0} files`} />)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={styles.muted} style={{ fontSize: 11, fontWeight: 600 }}>{label} tier · VRAM</div>
          {c?.optane && <Bar label={label} used={c.optane.used_gb ?? 0} total={c.optane.quota_gb ?? 0} note={c.optane.copy_error ? `copy error: ${c.optane.copy_error}` : `${c.optane.files ?? 0} files`} />}
          {n.services.map((s: any) => !s.ok
            ? <div key={s.id} style={{ color: 'var(--danger, #f87171)', fontSize: 11 }}>:{s.port} unreachable: {s.error}</div>
            : Array.isArray(s.service?.gpus) && s.service.gpus.length
              // Multi-GPU serve.py: one bar per GPU (vram_total/free_gb are sums over them).
              ? s.service.gpus.map((g: any) => {
                  const loaded = (s.resident || []).filter((m: any) => m.gpu === g.index).length
                  const rules = store.rulesOf(s)
                  const kinds: string[] = (s.service?.kinds || []).filter((k: string) => k !== 'lora')
                  return (
                    <div key={`${s.id}:${g.index}`} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <Bar label={`:${s.port} GPU${g.index} · ${s.gpuFriendly?.[g.index] || String(g.name || '').replace(/^NVIDIA (GeForce )?/, '')}`} used={(g.total_gb ?? 0) - (g.free_gb ?? 0)} total={g.total_gb ?? 0}
                        note={`${loaded} loaded${g.busy ? ' · busy' : ''}${g.waiting ? ` · ${g.waiting} waiting` : ''}`} />
                      {kinds.length > 0 && (
                        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center', fontSize: 10 }} title="Reserve this GPU for these kinds in auto-placement (other kinds then skip it). An explicit GPU on Load always wins.">
                          <span className={styles.muted} style={{ fontSize: 10 }}>reserve for:</span>
                          {kinds.map((k) => {
                            const on = (rules[k] || []).includes(g.index)
                            return (
                              <button key={k} type="button" disabled={!!store.busyKey} onClick={() => void store.toggleRule(s, k, g.index)}
                                style={{ ...chip, fontSize: 10, cursor: 'pointer', background: on ? 'var(--accent)' : 'transparent', color: on ? 'var(--accent-fg, #fff)' : 'var(--fg-muted)', borderColor: on ? 'var(--accent)' : 'var(--border)' }}>
                                {KIND_LABEL[k] || k}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })
              : <Bar key={s.id} label={`:${s.port} ${s.gpuName || s.service?.gpu || 'GPU'}`} used={(s.service?.vram_total_gb ?? 0) - (s.service?.vram_free_gb ?? 0)} total={s.service?.vram_total_gb ?? 0} note={`${(s.resident || []).length} loaded`} />)}
        </div>
        {d && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className={styles.muted} style={{ fontSize: 11, fontWeight: 600 }}>Quotas (this host; lowering prunes at once)</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 70px', gap: '4px 8px', alignItems: 'center', fontSize: 11 }}>
              {Object.keys(d.quota_gb || {}).map((k) => (
                <React.Fragment key={k}><span>{KIND_LABEL[k] || k} RAM (GB)</span>
                  <input className={styles.subInput} type="number" min={0} value={d.quota_gb[k] ?? ''} onChange={(e) => store.setDraft(n.node, ['quota_gb', k], Number(e.target.value))} /></React.Fragment>
              ))}
              <span>{label} (GB)</span><input className={styles.subInput} type="number" min={0} value={d.optane_quota_gb ?? ''} onChange={(e) => store.setDraft(n.node, ['optane_quota_gb'], Number(e.target.value))} />
              <span title="Usage score halves every this many hours">Score half-life (h)</span><input className={styles.subInput} type="number" min={1} value={d.half_life_h ?? ''} onChange={(e) => store.setDraft(n.node, ['half_life_h'], Number(e.target.value))} />
            </div>
            <button className={styles.btn} style={{ alignSelf: 'flex-start' }} disabled={!!store.busyKey} onClick={() => void store.saveQuotas(n)}><Save size={12} /> Save quotas</button>
          </div>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--fg-faint)' }}>
            <th>Where</th><th>Kind</th><th>Model</th><th>Size</th><th>Score</th><th>Last used</th><th>Actions</th>
          </tr></thead>
          <tbody>{shown.map((r) => <Row key={`${r.kind}:${r.name}`} n={n} r={r} label={label} />)}</tbody>
        </table>
        {rows.length === 0 && <div className={styles.muted}>No models match{store.showNas ? '' : ' (only cached/loaded shown: tick "Show NAS-only")'}.</div>}
        {rows.length > shown.length && <div className={styles.muted}>Showing {shown.length} of {rows.length}; narrow with the search box.</div>}
      </div>
    </div>
  )
})

const AddToCache: React.FC = observer(() => {
  const n = store.addTarget
  const root = KIND_ROOT[store.addKind]
  useEffect(() => { void store.loadFiles(root) }, [root])
  if (!n) return null
  const supported = store.kindSupported(n, store.addKind)
  const files = store.files[root]
  const matches = store.addMatches
  return (
    <div className={styles.ragCard}>
      <h4 className={styles.h4} style={{ margin: 0 }}>Add to cache</h4>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className={styles.subInput} value={n.node} onChange={(e) => store.set('addNode', e.target.value)} title="Host whose RAM cache gets it">
          {store.nodes.map((x) => <option key={x.node} value={x.node}>{x.node}</option>)}
        </select>
        <select className={styles.subInput} value={store.addKind} onChange={(e) => store.set('addKind', e.target.value)}>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}{store.kindSupported(n, k) ? '' : ' (not supported yet)'}</option>)}
        </select>
        <input className={styles.subInput} style={{ width: 220 }} placeholder={`Search /imagegen/${root}…`} value={store.addSearch} onChange={(e) => store.set('addSearch', e.target.value)} />
        <select className={styles.subInput} style={{ maxWidth: 420 }} value={store.addFile} onChange={(e) => store.set('addFile', e.target.value)}>
          <option value="">{store.filesErr[root] ? 'file list unavailable' : !files ? 'loading…' : `${matches.length}${matches.length === 200 ? '+' : ''} file(s) - pick one`}</option>
          {matches.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <button className={styles.btn} disabled={!supported || !store.addFile || !!store.busyKey || !n.cacheService}
          title={supported ? `Copy into ${n.node}'s RAM cache (and its persistent tier)` : `${n.node}'s image model service has no ${KIND_LABEL[store.addKind]} cache yet`}
          onClick={() => void store.addToCache()}>Add to RAM cache</button>
      </div>
      {!supported && <div className={styles.muted} style={{ fontSize: 12 }}>{KIND_LABEL[store.addKind]} isn't cached by {n.node}'s Image Model Service yet; claude2 is adding it.</div>}
    </div>
  )
})

export const ModelPlacementPanel: React.FC = observer(() => {
  useEffect(() => { store.start(); return () => store.stop() }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className={styles.ragCard}>
        <div className={styles.head}>
          <h4 className={styles.h4} style={{ margin: 0 }}>Model Cache &amp; Placement</h4>
          <span className={styles.spacer} />
          <input className={styles.subInput} style={{ width: 220 }} placeholder="Search models…" value={store.search} onChange={(e) => store.set('search', e.target.value)} />
          <select className={styles.subInput} value={store.kind} onChange={(e) => store.set('kind', e.target.value)}>
            <option value="">All kinds</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <label className={styles.muted} style={{ fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={store.showNas} onChange={(e) => store.set('showNas', e.target.checked)} /> Show NAS-only
          </label>
          <button className={styles.btn} onClick={() => void store.load()}>{store.loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh</button>
        </div>
        <div className={styles.muted} style={{ fontSize: 12 }}>
          🔥 loaded on a GPU · ⚡ in this host's RAM tier · 💾 in the persistent tier (Optane / Disk) · ❄ NAS only. Only Image Model Services launched from AI · Image Gen → Imagegen Launch appear here.
        </div>
        {store.msg && <div style={{ fontSize: 12, color: 'var(--ok, #4ade80)' }}>{store.msg}</div>}
        {store.error && <div style={{ fontSize: 12, color: 'var(--danger, #f87171)' }}>{store.error}</div>}
      </div>
      {store.nodes.length === 0 && !store.loading && <div className={styles.ragCard}><div className={styles.muted}>No Image Model Service is running. Launch one from Imagegen Launch → Image Model Service.</div></div>}
      {store.nodes.length > 0 && <AddToCache />}
      {store.nodes.map((n) => <NodeCard key={n.node} n={n} />)}
    </div>
  )
})
