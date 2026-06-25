import React, { useEffect, useState } from 'react'
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'

/**
 * Settings panels for the ProxLab-replacement domain — stored NATIVELY on CT 152 via
 * the `clusterSettings:*` gateway RPCs (AI-Lab is becoming the new ProxLab). Secrets
 * are masked: the backend returns `*Set` booleans, and a blank field leaves the stored
 * secret unchanged.
 */
type Settings = any

function useClusterSettings() {
  const [s, setS] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const load = async () => {
    const api = (window as any).gyshell?.clusterSettings
    const r = await api?.get?.()
    setS(r?.settings ?? null)
  }
  useEffect(() => {
    void load()
  }, [])
  const save = async (patch: Settings, okMsg = 'Saved') => {
    setBusy(true)
    setMsg(null)
    try {
      const api = (window as any).gyshell?.clusterSettings
      const r = await api?.set?.(patch)
      setS(r?.settings ?? null)
      setMsg(okMsg)
      setTimeout(() => setMsg(null), 2500)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return { s, busy, msg, save, reload: load }
}

const wrap: React.CSSProperties = { padding: '4px 2px', maxWidth: 620 }
const h: React.CSSProperties = { fontSize: 15, fontWeight: 600, marginBottom: 4 }
const sub: React.CSSProperties = { fontSize: 12, color: 'var(--fg-muted)', marginBottom: 16 }
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }
const lbl: React.CSSProperties = { width: 150, flex: '0 0 auto', fontSize: 12, color: 'var(--fg-muted)' }
const inp: React.CSSProperties = {
  flex: 1, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--control-bg)', color: 'var(--fg)', fontSize: 13,
}
const btn: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--control-bg)', color: 'var(--fg)', fontSize: 13, cursor: 'pointer',
}
const primaryBtn: React.CSSProperties = { ...btn, background: 'var(--accent)', borderColor: 'var(--accent)', color: '#06121f', fontWeight: 600 }

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={row}>
    <span style={lbl}>{label}</span>
    {children}
  </div>
)

/** Secret input pre-filled with the real value, obscured, with an eyeball reveal toggle. */
const SecretInput: React.FC<{ value: string; onChange: (v: string) => void; placeholder?: string }> = ({ value, onChange, placeholder }) => {
  const [show, setShow] = useState(false)
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        style={{ ...inp, flex: 1 }}
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        style={{ ...btn, padding: 7, display: 'inline-flex', alignItems: 'center' }}
        title={show ? 'Hide' : 'Show'}
        onClick={() => setShow((s) => !s)}
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}

/** Load the actual secret values for the reveal/eyeball affordance. */
async function loadSecrets(): Promise<any> {
  const r = await (window as any).gyshell?.clusterSettings?.reveal?.()
  return r?.secrets ?? null
}

// ─── Proxmox connection ───────────────────────────────────────────────────────
export const ProxmoxSettingsPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [f, setF] = useState<any>({})
  const [test, setTest] = useState<string | null>(null)
  useEffect(() => {
    if (s?.pve) setF((prev: any) => ({ ...s.pve, tokenSecret: prev.tokenSecret ?? '' }))
  }, [s])
  useEffect(() => {
    void loadSecrets().then((sec) => {
      if (sec?.pve) setF((prev: any) => ({ ...prev, tokenSecret: sec.pve.tokenSecret ?? '' }))
    })
  }, [])
  if (!s) return <div style={sub}>Loading…</div>
  const runTest = async () => {
    setTest('testing…')
    // persist first so the backend client uses the latest values
    await save({ pve: f }, 'Saved')
    const r = await (window as any).gyshell?.clusterSettings?.testPve?.()
    setTest(r?.ok ? `✓ Connected — PVE ${r.version} (${r.release})` : `✗ ${r?.error || 'failed'}`)
  }
  return (
    <div style={wrap}>
      <div style={h}>Proxmox Connection</div>
      <div style={sub}>Native PVE API connection used by AI-Lab (CT 152). Token auth.</div>
      <Field label="Host / IP"><input style={inp} value={f.host ?? ''} onChange={(e) => setF({ ...f, host: e.target.value })} /></Field>
      <Field label="Port"><input style={inp} type="number" value={f.port ?? 8006} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></Field>
      <Field label="Token ID"><input style={inp} placeholder="user@realm!tokenname" value={f.tokenId ?? ''} onChange={(e) => setF({ ...f, tokenId: e.target.value })} /></Field>
      <Field label="Token Secret"><SecretInput value={f.tokenSecret ?? ''} onChange={(v) => setF({ ...f, tokenSecret: v })} placeholder="token secret UUID" /></Field>
      <Field label="Default node"><input style={inp} placeholder="(optional)" value={f.node ?? ''} onChange={(e) => setF({ ...f, node: e.target.value })} /></Field>
      <Field label="Verify SSL">
        <input type="checkbox" checked={!!f.verifySsl} onChange={(e) => setF({ ...f, verifySsl: e.target.checked })} />
        <span style={{ fontSize: 12, color: 'var(--fg-faint)' }}>off for self-signed PVE certs</span>
      </Field>
      <div style={{ ...row, marginTop: 18 }}>
        <button style={btn} disabled={busy} onClick={() => void runTest()}>Test connection</button>
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ pve: f })}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
        {test && <span style={{ fontSize: 12, color: test.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>{test}</span>}
      </div>
    </div>
  )
}

// ─── Download tokens ──────────────────────────────────────────────────────────
export const ClusterTokensPanel: React.FC = () => {
  const { busy, msg, save } = useClusterSettings()
  const [hf, setHf] = useState('')
  const [civ, setCiv] = useState('')
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void loadSecrets().then((sec) => {
      if (sec) {
        setHf(sec.tokens?.hfToken ?? '')
        setCiv(sec.tokens?.civitaiToken ?? '')
      }
      setLoaded(true)
    })
  }, [])
  if (!loaded) return <div style={sub}>Loading…</div>
  return (
    <div style={wrap}>
      <div style={h}>Download Tokens</div>
      <div style={sub}>API tokens for model downloads. Stored on CT 152. Click the eye to reveal.</div>
      <Field label="HuggingFace"><SecretInput value={hf} onChange={setHf} placeholder="hf_..." /></Field>
      <Field label="CivitAI"><SecretInput value={civ} onChange={setCiv} placeholder="civitai api key" /></Field>
      <div style={{ ...row, marginTop: 18 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ tokens: { hfToken: hf, civitaiToken: civ } })}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
      </div>
    </div>
  )
}

// ─── Cluster UI prefs ─────────────────────────────────────────────────────────
export const ClusterUiPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [f, setF] = useState<any>({})
  const [lab, setLab] = useState('')
  useEffect(() => {
    if (s) {
      setF({ ...s.ui })
      setLab(s.labName ?? '')
    }
  }, [s])
  if (!s) return <div style={sub}>Loading…</div>
  const num = (k: string, label: string) => (
    <Field label={label}><input style={inp} type="number" value={f[k] ?? 0} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} /></Field>
  )
  return (
    <div style={wrap}>
      <div style={h}>Cluster UI Preferences</div>
      <div style={sub}>Display + interaction defaults for the Cluster tab.</div>
      <Field label="Lab name"><input style={inp} value={lab} onChange={(e) => setLab(e.target.value)} /></Field>
      {num('metricsRefreshMs', 'Metrics refresh (ms)')}
      {num('pveRefreshMs', 'Cluster refresh (ms)')}
      {num('ramIncrementMB', 'RAM step (MB)')}
      {num('swapIncrementMB', 'Swap step (MB)')}
      {num('cpuIncrement', 'CPU step (cores)')}
      <div style={{ ...row, marginTop: 18 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ ui: f, labName: lab })}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
      </div>
    </div>
  )
}

// ─── External Services (LLM/embed/rerank/TTS/STT) + Vector DBs ──────────────────
const SVC_TYPES = ['llm', 'embeddings', 'reranker', 'tts', 'stt']
const VDB_TYPES = ['milvus', 'weaviate', 'chromadb', 'qdrant', 'hippocampai']
const smallInp: React.CSSProperties = { ...inp, flex: 'unset', padding: '5px 8px', fontSize: 12 }
const delBtn: React.CSSProperties = { ...btn, padding: 6, color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }
const addBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px dashed var(--border-strong)', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer' }
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--fg-muted)', margin: '16px 0 8px' }

export const ExternalServicesPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [svc, setSvc] = useState<any[]>([])
  const [vdb, setVdb] = useState<any[]>([])
  useEffect(() => {
    if (s) { setSvc(s.externalServices ?? []); setVdb(s.vectorDbs ?? []) }
  }, [s])
  if (!s) return <div style={sub}>Loading…</div>
  const up = (arr: any[], set: any, i: number, patch: any) => set(arr.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  return (
    <div style={wrap}>
      <div style={h}>External Services</div>
      <div style={sub}>LLM / embeddings / reranker / TTS / STT endpoints + vector DBs. Stored on CT 152.</div>

      <div style={sectionTitle}>AI service endpoints</div>
      {svc.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ ...smallInp, width: 110 }} placeholder="name" value={e.name ?? ''} onChange={(ev) => up(svc, setSvc, i, { name: ev.target.value })} />
          <select style={{ ...smallInp, width: 110 }} value={e.type ?? 'llm'} onChange={(ev) => up(svc, setSvc, i, { type: ev.target.value })}>
            {SVC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input style={{ ...smallInp, flex: 1, minWidth: 160 }} placeholder="http://host:port" value={e.url ?? ''} onChange={(ev) => up(svc, setSvc, i, { url: ev.target.value })} />
          <input style={{ ...smallInp, width: 120 }} placeholder="model (opt)" value={e.model ?? ''} onChange={(ev) => up(svc, setSvc, i, { model: ev.target.value })} />
          <button style={delBtn} title="Remove" onClick={() => setSvc(svc.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button style={addBtn} onClick={() => setSvc([...svc, { name: '', type: 'llm', url: '', model: '' }])}><Plus size={13} /> Add service</button>

      <div style={sectionTitle}>Vector databases</div>
      {vdb.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ ...smallInp, width: 110 }} placeholder="name" value={e.name ?? ''} onChange={(ev) => up(vdb, setVdb, i, { name: ev.target.value })} />
          <select style={{ ...smallInp, width: 120 }} value={e.type ?? 'qdrant'} onChange={(ev) => up(vdb, setVdb, i, { type: ev.target.value })}>
            {VDB_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input style={{ ...smallInp, flex: 1, minWidth: 140 }} placeholder="host" value={e.host ?? ''} onChange={(ev) => up(vdb, setVdb, i, { host: ev.target.value })} />
          <input style={{ ...smallInp, width: 90 }} type="number" placeholder="port" value={e.port ?? ''} onChange={(ev) => up(vdb, setVdb, i, { port: Number(ev.target.value) })} />
          <button style={delBtn} title="Remove" onClick={() => setVdb(vdb.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button style={addBtn} onClick={() => setVdb([...vdb, { name: '', type: 'qdrant', host: '', port: 6333 }])}><Plus size={13} /> Add vector DB</button>

      <div style={{ ...row, marginTop: 20 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ externalServices: svc, vectorDbs: vdb })}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
      </div>
    </div>
  )
}

// ─── Service-name overrides ─────────────────────────────────────────────────────
type KV = { k: string; v: string }
const toRows = (m: Record<string, string>): KV[] => Object.entries(m || {}).map(([k, v]) => ({ k, v }))
const toMap = (rows: KV[]): Record<string, string> => { const o: Record<string, string> = {}; rows.forEach((r) => { if (r.k.trim()) o[r.k.trim()] = r.v }); return o }

export const ServiceNamesPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [common, setCommon] = useState<KV[]>([])
  const [custom, setCustom] = useState<KV[]>([])
  useEffect(() => {
    if (s?.serviceNames) { setCommon(toRows(s.serviceNames.common)); setCustom(toRows(s.serviceNames.custom)) }
  }, [s])
  if (!s) return <div style={sub}>Loading…</div>
  const editRows = (rows: KV[], set: any, keyPlaceholder: string) => (
    <>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input style={{ ...smallInp, width: 200, fontFamily: 'var(--font-mono)' }} placeholder={keyPlaceholder} value={r.k} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <span style={{ color: 'var(--fg-faint)' }}>→</span>
          <input style={{ ...smallInp, flex: 1 }} placeholder="display name" value={r.v} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
          <button style={delBtn} title="Remove" onClick={() => set(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      ))}
    </>
  )
  return (
    <div style={wrap}>
      <div style={h}>Service Names</div>
      <div style={sub}>Friendly display names for discovered services. Stored on CT 152.</div>
      <div style={sectionTitle}>Common (by port:process)</div>
      {editRows(common, setCommon, '8080:nginx')}
      <button style={addBtn} onClick={() => setCommon([...common, { k: '', v: '' }])}><Plus size={13} /> Add</button>
      <div style={sectionTitle}>Per-host (by host:port)</div>
      {editRows(custom, setCustom, 'pve-2:22')}
      <button style={addBtn} onClick={() => setCustom([...custom, { k: '', v: '' }])}><Plus size={13} /> Add</button>
      <div style={{ ...row, marginTop: 20 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ serviceNames: { common: toMap(common), custom: toMap(custom) } })}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
      </div>
    </div>
  )
}

// ─── GPU & Pools (config stored native; inventory read via bridge for display) ──
const POOL_MODES = ['reserved', 'ai-pool']
export const GpuPoolsPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [cfg, setCfg] = useState<Record<string, any>>({})
  const [gpus, setGpus] = useState<Array<{ node: string; pciId: string; product: string; vendor: string }>>([])
  const [invErr, setInvErr] = useState<string | null>(null)
  useEffect(() => { if (s) setCfg({ ...(s.gpuConfig ?? {}) }) }, [s])
  useEffect(() => {
    void (async () => {
      try {
        const inv = await (window as any).gyshell?.cluster?.request?.('GET', '/api/gpu/inventory')
        const out: any[] = []
        for (const [node, data] of Object.entries(inv || {})) {
          for (const g of ((data as any).allGpus ?? (data as any).nvidiaGpus ?? [])) {
            out.push({ node, pciId: g.pciId, product: g.productName || g.friendlyName || '', vendor: g.vendor || '' })
          }
        }
        setGpus(out)
      } catch (e) { setInvErr(e instanceof Error ? e.message : String(e)) }
    })()
  }, [])
  if (!s) return <div style={sub}>Loading…</div>
  const set = (key: string, patch: any) => setCfg({ ...cfg, [key]: { ...(cfg[key] ?? {}), ...patch } })
  return (
    <div style={wrap}>
      <div style={h}>GPU &amp; Pools</div>
      <div style={sub}>Friendly names, fleet visibility, and pool mode per GPU. Config stored on CT 152 (applied in a later finalization pass).</div>
      {invErr && <div style={{ ...sub, color: 'var(--fg-faint)' }}>GPU inventory unavailable ({invErr}) — showing saved config only.</div>}
      {gpus.length === 0 && !invErr && <div style={sub}>No GPUs discovered.</div>}
      {gpus.map((g) => {
        const key = `${g.node}:${g.pciId}`
        const c = cfg[key] ?? {}
        return (
          <div key={key} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ width: 70, fontSize: 11, color: 'var(--fg-faint)' }}>{g.node}</span>
            <span style={{ width: 120, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{g.pciId}</span>
            <span style={{ width: 130, fontSize: 11 }}>{g.product}</span>
            <input style={{ ...smallInp, width: 140 }} placeholder="friendly name" value={c.friendlyName ?? ''} onChange={(e) => set(key, { friendlyName: e.target.value })} />
            <select style={{ ...smallInp, width: 100 }} value={c.poolMode ?? 'reserved'} onChange={(e) => set(key, { poolMode: e.target.value })}>
              {POOL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <label style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={!!c.showInFleet} onChange={(e) => set(key, { showInFleet: e.target.checked })} /> fleet
            </label>
          </div>
        )
      })}
      <div style={{ ...row, marginTop: 18 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ gpuConfig: cfg })}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
      </div>
    </div>
  )
}

// ─── AI Agents (node -> agent container vmid) ───────────────────────────────────
export const AiAgentsPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [rows, setRows] = useState<Array<{ node: string; vmid: string }>>([])
  useEffect(() => { if (s?.agents) setRows(Object.entries(s.agents).map(([node, vmid]) => ({ node, vmid: String(vmid) }))) }, [s])
  if (!s) return <div style={sub}>Loading…</div>
  const saveRows = () => {
    const agents: Record<string, number> = {}
    rows.forEach((r) => { if (r.node.trim() && r.vmid.trim()) agents[r.node.trim()] = Number(r.vmid) })
    void save({ agents })
  }
  return (
    <div style={wrap}>
      <div style={h}>AI Agents</div>
      <div style={sub}>Per-node agent container (vmid) that manages AI workloads. Applied in a later finalization pass.</div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input style={{ ...smallInp, width: 160 }} placeholder="node (e.g. px-gpu)" value={r.node} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, node: e.target.value } : x)))} />
          <span style={{ color: 'var(--fg-faint)' }}>→</span>
          <input style={{ ...smallInp, width: 100 }} type="number" placeholder="vmid" value={r.vmid} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, vmid: e.target.value } : x)))} />
          <button style={delBtn} title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button style={addBtn} onClick={() => setRows([...rows, { node: '', vmid: '' }])}><Plus size={13} /> Add agent</button>
      <div style={{ ...row, marginTop: 18 }}>
        <button style={primaryBtn} disabled={busy} onClick={saveRows}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
      </div>
    </div>
  )
}

// ─── Shared Folders / Storage ───────────────────────────────────────────────────
export const SharedFoldersPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [sf, setSf] = useState<any>(null)
  useEffect(() => { if (s?.sharedFolders) setSf(JSON.parse(JSON.stringify(s.sharedFolders))) }, [s])
  if (!s || !sf) return <div style={sub}>Loading…</div>
  const setGroup = (gi: number, patch: any) => setSf({ ...sf, groups: sf.groups.map((g: any, i: number) => (i === gi ? { ...g, ...patch } : g)) })
  const setCat = (gi: number, ci: number, patch: any) => setGroup(gi, { categories: sf.groups[gi].categories.map((c: any, i: number) => (i === ci ? { ...c, ...patch } : c)) })
  return (
    <div style={wrap}>
      <div style={h}>Shared Folders</div>
      <div style={sub}>Host→container mount groups. Definitions stored on CT 152; mounts provisioned in a later finalization pass.</div>
      <Field label="Mount parent"><input style={inp} value={sf.containerMountParent ?? ''} onChange={(e) => setSf({ ...sf, containerMountParent: e.target.value })} /></Field>
      {sf.groups.map((g: any, gi: number) => (
        <div key={gi} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10, background: 'var(--panel-bg)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={!!g.enabled} onChange={(e) => setGroup(gi, { enabled: e.target.checked })} />
            </label>
            <input style={{ ...smallInp, width: 110, fontWeight: 600 }} value={g.name} onChange={(e) => setGroup(gi, { name: e.target.value })} />
            <input style={{ ...smallInp, flex: 1 }} placeholder="base path on host" value={g.basePath ?? ''} onChange={(e) => setGroup(gi, { basePath: e.target.value })} />
            <button style={delBtn} title="Remove group" onClick={() => setSf({ ...sf, groups: sf.groups.filter((_: any, i: number) => i !== gi) })}><Trash2 size={13} /></button>
          </div>
          {(g.categories ?? []).map((c: any, ci: number) => (
            <div key={ci} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', paddingLeft: 24 }}>
              <input style={{ ...smallInp, width: 120 }} placeholder="category" value={c.name} onChange={(e) => setCat(gi, ci, { name: e.target.value })} />
              <input style={{ ...smallInp, flex: 1 }} placeholder="host path" value={c.hostPath ?? ''} onChange={(e) => setCat(gi, ci, { hostPath: e.target.value })} />
              <button style={delBtn} title="Remove" onClick={() => setGroup(gi, { categories: g.categories.filter((_: any, i: number) => i !== ci) })}><Trash2 size={12} /></button>
            </div>
          ))}
          <button style={{ ...addBtn, marginLeft: 24 }} onClick={() => setGroup(gi, { categories: [...(g.categories ?? []), { name: '', hostPath: '' }] })}><Plus size={12} /> category</button>
        </div>
      ))}
      <button style={addBtn} onClick={() => setSf({ ...sf, groups: [...sf.groups, { name: 'new-group', enabled: false, basePath: '', categories: [] }] })}><Plus size={13} /> Add group</button>
      <div style={{ ...row, marginTop: 18 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ sharedFolders: sf })}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
      </div>
    </div>
  )
}
