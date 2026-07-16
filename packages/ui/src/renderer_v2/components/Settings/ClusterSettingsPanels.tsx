import React, { useEffect, useState } from 'react'
import { Eye, EyeOff, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { KNOWN_SOURCE_TAGS, externalModelSourceSchema, type CatalogModel } from '@gyshell/shared'
import { modelSourcesApi, balanceHistoryApi, type ExternalModelSourceWire, type AvailableModel, type SourceBalance, type BalanceHistoryResult } from '../../stores/modelSourcesApi'
import { providerServicesApi } from '../../stores/providerServicesApi'
import { PROVIDER_SERVICE_CAPS, type ProviderServiceWire } from '@gyshell/shared'
import { hermesApi } from '../../stores/hermesApi'
import { confirmStore } from '../../stores/confirmStore'

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
// Full-width variant for panels with wide content (External Services: model sources + the
// per-model curation table with cost columns). No artificial 620px cap.
const wrapWide: React.CSSProperties = { padding: '4px 2px', width: '100%' }
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

// ─── Container Identity (self IP/hostname resolver + manual overrides) ──────────
export const ContainerIdentityPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [ipOv, setIpOv] = useState('')
  const [hnOv, setHnOv] = useState('')
  useEffect(() => {
    if (s) {
      setIpOv((s as any).selfIdentity?.ipOverride ?? '')
      setHnOv((s as any).selfIdentity?.hostnameOverride ?? '')
    }
  }, [s])
  if (!s) return <div style={sub}>Loading…</div>
  const r = (s as any).selfIdentityResolved || {}
  const effIp = (ipOv.trim() || r.detectedIp || '')
  const effUrl = effIp ? `http://${effIp}:${r.port ?? 17890}` : ''
  const ro: React.CSSProperties = { ...inp, opacity: 0.6, cursor: 'default' }
  return (
    <div style={wrap}>
      <div style={h}>Container Identity</div>
      <div style={sub}>
        How AI-Lab addresses itself so agents, MCP servers, and fleet configs can reach it. Detected
        automatically from the container at runtime — override only if needed (multiple NICs, or a
        custom LAN hostname). These feed everything that points at AI-Lab, so a migration to a new
        IP/VLAN — or a fresh install on another host — just works.
      </div>
      <Field label="Detected IP"><input style={ro} value={r.detectedIp ?? ''} readOnly /></Field>
      <Field label="Detected hostname"><input style={ro} value={r.detectedHostname ?? ''} readOnly /></Field>
      <Field label="IP override"><input style={inp} value={ipOv} onChange={(e) => setIpOv(e.target.value)} placeholder={`auto — ${r.detectedIp ?? ''}`} /></Field>
      <Field label="Hostname override"><input style={inp} value={hnOv} onChange={(e) => setHnOv(e.target.value)} placeholder={`auto — ${r.detectedHostname ?? ''}`} /></Field>
      <Field label="Effective base URL"><input style={ro} value={effUrl} readOnly /></Field>
      <div style={{ ...row, marginTop: 18 }}>
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ selfIdentity: { ipOverride: ipOv.trim(), hostnameOverride: hnOv.trim() } })}>Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--success)' }}>{msg}</span>}
      </div>
      <div style={{ ...sub, marginTop: 10, marginBottom: 0 }}>
        Reconciling dependent fleet configs (Hermes / MCP endpoints that point at AI-Lab) when this
        changes is a follow-up step.
      </div>
    </div>
  )
}

// ─── External Services (model API sources + catalog + vector DBs) ───────────────
const VDB_TYPES = ['milvus', 'weaviate', 'chromadb', 'qdrant', 'hippocampai']
const smallInp: React.CSSProperties = { ...inp, flex: 'unset', padding: '5px 8px', fontSize: 12 }
const delBtn: React.CSSProperties = { ...btn, padding: 6, color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }
const addBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px dashed var(--border-strong)', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer' }
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--fg-muted)', margin: '16px 0 8px' }

// ─── Per-model curation (checkboxes + cost columns) ─────────────────────────────
const thc: React.CSSProperties = { padding: '5px 8px', fontWeight: 600, fontSize: 11, textAlign: 'center', whiteSpace: 'nowrap' }
const tdc: React.CSSProperties = { padding: '4px 8px', textAlign: 'center', whiteSpace: 'nowrap' }
const fmtCtx = (n?: number | null) => (n == null ? '—' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const fmtCost = (v?: number | null) =>
  v == null ? '—' : v === 0 ? 'free' : v < 1 ? `$${v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}` : `$${v.toFixed(2)}`

/** Expandable list of a source's upstream models with enable checkboxes + cost/context columns.
 *  Curate which models are proxied / shown (all checked ⇒ empty allow-list = allow-all). */
const ModelCuration: React.FC<{ sourceId: string; onSelection: (models: string[]) => void }> = ({ sourceId, onSelection }) => {
  const [models, setModels] = useState<AvailableModel[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true); setErr(null)
    modelSourcesApi.available(sourceId).then((r) => {
      if (!alive) return
      setModels(r.models)
      setChecked(new Set(r.models.filter((m) => m.enabled).map((m) => m.id)))
      setLoading(false)
    }).catch((e) => { if (alive) { setErr(String(e?.message ?? e)); setLoading(false) } })
    return () => { alive = false }
  }, [sourceId])

  const filtered = q ? models.filter((m) => (m.id + ' ' + (m.name || '')).toLowerCase().includes(q.toLowerCase())) : models
  const toggle = (id: string) => setChecked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const setAllVisible = (on: boolean) => setChecked((s) => { const n = new Set(s); filtered.forEach((m) => on ? n.add(m.id) : n.delete(m.id)); return n })
  // Report the current allow-list up to the parent (which owns the Save button, next to the
  // Curate-models toggle). all checked ⇒ [] = allow-all.
  useEffect(() => {
    if (!loading && models.length) onSelection(checked.size === models.length ? [] : [...checked])
  }, [checked, loading, models.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div style={{ ...sub, padding: '6px 0' }}>Loading models…</div>
  if (err) return <div style={{ fontSize: 12, color: 'var(--danger)', padding: '4px 0' }}>Couldn’t load models: {err}</div>
  if (!models.length) return <div style={{ ...sub, padding: '4px 0' }}>No models discovered (check the base URL / key).</div>

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <input style={{ ...smallInp, flex: 1, minWidth: 150 }} placeholder={`Filter ${models.length} models…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <button style={{ ...btn, padding: '4px 10px', fontSize: 12 }} onClick={() => setAllVisible(true)}>Select all{q ? ' shown' : ''}</button>
        <button style={{ ...btn, padding: '4px 10px', fontSize: 12 }} onClick={() => setAllVisible(false)}>Deselect all{q ? ' shown' : ''}</button>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{checked.size}/{models.length} enabled</span>
      </div>
      <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-elev, var(--bg))', color: 'var(--fg-muted)' }}>
              <th style={thc}></th><th style={{ ...thc, textAlign: 'left' }}>Model</th>
              <th style={thc}>Ctx</th><th style={thc}>In $/M</th><th style={thc}>Out $/M</th><th style={thc}>Cache $/M</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => toggle(m.id)}>
                <td style={tdc}><input type="checkbox" checked={checked.has(m.id)} readOnly /></td>
                <td style={{ ...tdc, textAlign: 'left', fontFamily: 'var(--font-mono)' }} title={m.name}>{m.id}</td>
                <td style={tdc}>{fmtCtx(m.contextLength)}</td>
                <td style={tdc}>{fmtCost(m.pricing?.inputPerM)}</td>
                <td style={tdc}>{fmtCost(m.pricing?.outputPerM)}</td>
                <td style={tdc}>{fmtCost(m.pricing?.cacheReadPerM)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Model API sources (external-sources registry) ──────────────────────────────
/** Draft row state over the wire source; blank/masked apiKey ⇒ server keeps the key. */
type SourceDraft = ExternalModelSourceWire & { _isNew?: boolean; _dirty?: boolean; _msg?: string | null }

const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '')

/**
 * Per-transport capability descriptor — keyed on the API *dialect* (`transport`), NOT the
 * display name, so detection is reliable and adding a future provider-type that needs a
 * separate usage/cost credential is a one-line entry here. No hardcoded provider list and
 * `baseUrl` stays free-form; any provider speaking a listed dialect inherits its caps.
 *   adminKey     — this dialect's balance/usage reporting needs a SEPARATE credential from
 *                  the chat key (e.g. Anthropic's `sk-ant-admin…` org cost report).
 *   balanceKind  — how the proxy reports spend for this dialect ('spend' = org cost report
 *                  via the admin key; 'balance' = remaining credit via the chat key).
 * Unlisted transports simply get no aux field (the lookup returns undefined).
 */
const TRANSPORT_CAPS: Record<
  string,
  { adminKey?: boolean; adminKeyLabel?: string; adminKeyTitle?: string; balanceKind?: 'balance' | 'spend' }
> = {
  anthropic: {
    adminKey: true,
    adminKeyLabel: 'Admin key (sk-ant-admin…) — usage/cost',
    adminKeyTitle:
      'Anthropic Admin API key (sk-ant-admin…) — enables org usage/cost tracking. Separate from the chat key.',
    balanceKind: 'spend',
  },
  openai_chat: {
    balanceKind: 'balance',
  },
}
const capsFor = (transport?: string) => TRANSPORT_CAPS[transport ?? 'openai_chat']

/** Credit cost-over-time for one source: inline SVG line chart + burn/runway readout. */
const BalanceChart: React.FC<{ sourceId: string }> = ({ sourceId }) => {
  const [days, setDays] = useState(30)
  const [h, setH] = useState<BalanceHistoryResult | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (d = days) => { setBusy(true); setH(await balanceHistoryApi.history(sourceId, d)); setBusy(false) }
  useEffect(() => { void load() }, [sourceId, days])
  const vals = (h?.series ?? []).map((pt) => (typeof pt.balance === 'number' ? pt.balance : typeof pt.spend === 'number' ? pt.spend : typeof pt.usage === 'number' ? pt.usage : null)).filter((v): v is number => v !== null)
  const W = 420, H = 80
  const min = Math.min(...vals), max = Math.max(...vals)
  const span = max - min || 1
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * W},${H - ((v - min) / span) * (H - 6) - 3}`).join(' ')
  return (
    <div style={{ margin: '4px 0 8px', padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--app-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
        <span>cost over time · {h?.method ?? '…'}</span>
        <select style={{ ...smallInp, width: 80, padding: '2px 6px' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 30, 90].map((d) => <option key={d} value={d}>{d}d</option>)}
        </select>
        <button style={{ ...btn, padding: '2px 8px', fontSize: 11 }} disabled={busy} title="Snapshot balances now (6h auto)" onClick={async () => { await balanceHistoryApi.snapshot(); await load() }}>
          <RefreshCw size={11} />
        </button>
        <span style={{ flex: 1 }} />
        {h?.burnPerDay != null && <span>burn ${Number(h.burnPerDay).toFixed(2)}/day</span>}
        {h?.runwayDays != null && <span style={{ color: h.runwayDays < 7 ? 'var(--danger)' : 'var(--success)' }}>runway {Math.round(h.runwayDays)}d</span>}
      </div>
      {vals.length >= 2 ? (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', height: H }}>
          <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        </svg>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--fg-faint)' }}>{busy ? 'loading…' : `not enough snapshots yet (${h?.samples ?? 0}) — the 6h snapshotter fills this in`}</div>
      )}
    </div>
  )
}

/** Keyed non-model providers (ElevenLabs TTS…): account key ONCE → Hermes .env. */
const ProviderServicesSection: React.FC = () => {
  type Draft = ProviderServiceWire & { _isNew?: boolean; _dirty?: boolean; _msg?: string | null }
  const [rows, setRows] = useState<Draft[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const load = async () => { try { setRows((await providerServicesApi.list()).map((s) => ({ ...s }))) } catch { /* unreachable */ } }
  useEffect(() => { void load() }, [])
  const up = (i: number, patch: Partial<Draft>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch, _dirty: true, _msg: null } : x)))
  const saveRow = async (i: number) => {
    const d = rows[i]
    const id = d.id || slugify(d.displayName || d.provider || '')
    if (!id || !d.provider) { up(i, { _msg: 'provider + name required' }); return }
    setBusyId(id)
    const r = await providerServicesApi.save({
      id, provider: d.provider, displayName: d.displayName || PROVIDER_SERVICE_CAPS[d.provider]?.label || d.provider,
      apiKey: d.apiKey && !d.apiKey.startsWith('***') ? d.apiKey : undefined, enabled: d.enabled !== false,
    })
    setBusyId(null)
    if (!r.ok) { up(i, { _msg: r.error || 'save failed' }); return }
    await load()
  }
  const removeRow = async (i: number) => {
    const d = rows[i]
    if (d._isNew) { setRows((r) => r.filter((_, j) => j !== i)); return }
    const ok = await confirmStore.confirm({ title: 'Remove provider service', message: `Remove "${d.displayName || d.id}"? Its key is deleted from the registry (and Hermes .env on next sync).`, confirmText: 'Remove' })
    if (!ok) return
    setBusyId(d.id)
    const r = await providerServicesApi.remove(d.id)
    setBusyId(null)
    if (!r.ok) { up(i, { _msg: r.error || 'delete failed' }); return }
    await load()
  }
  return (
    <>
      <div style={sectionTitle}>Provider services</div>
      <div style={{ ...sub, marginBottom: 8 }}>
        Non-model provider accounts (TTS etc.). The key is stored ONCE here — the backend pushes it into
        Hermes <code>.env</code> so any agent using the provider picks it up. Masked like model sources.
      </div>
      {rows.map((d, i) => (
        <div key={d._isNew ? `new-${i}` : d.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select style={{ ...smallInp, width: 130 }} value={d.provider ?? ''} disabled={!d._isNew} onChange={(ev) => up(i, { provider: ev.target.value })}>
            <option value="" disabled>provider…</option>
            {Object.entries(PROVIDER_SERVICE_CAPS).map(([slug, cap]) => <option key={slug} value={slug}>{cap.label} ({cap.kind})</option>)}
          </select>
          <input style={{ ...smallInp, width: 140 }} placeholder="display name" value={d.displayName ?? ''} onChange={(ev) => up(i, { displayName: ev.target.value })} />
          <input
            style={{ ...smallInp, flex: 1, minWidth: 160 }}
            type="password"
            placeholder={d.hasKey ? `key set (${d.apiKey ?? '***'}) — blank keeps it` : 'API key'}
            value={d.apiKey && !d.apiKey.startsWith('***') ? d.apiKey : ''}
            onChange={(ev) => up(i, { apiKey: ev.target.value })}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--fg-muted)' }}>
            <input type="checkbox" checked={d.enabled !== false} onChange={(ev) => up(i, { enabled: ev.target.checked })} /> enabled
          </label>
          {d.provider && PROVIDER_SERVICE_CAPS[d.provider] && (
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-faint)' }}>{PROVIDER_SERVICE_CAPS[d.provider].envVar}</span>
          )}
          <button style={{ ...btn, padding: '4px 10px', fontSize: 12 }} disabled={busyId !== null || (!d._dirty && !d._isNew)} onClick={() => void saveRow(i)}>{d._isNew ? 'Register' : 'Save'}</button>
          <button style={delBtn} disabled={busyId !== null} onClick={() => void removeRow(i)}><Trash2 size={13} /></button>
          {d._msg && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{d._msg}</span>}
        </div>
      ))}
      <button style={addBtn} onClick={() => setRows((r) => [...r, { id: '', provider: '', displayName: '', enabled: true, _isNew: true, _dirty: true } as Draft])}>
        <Plus size={13} /> Add provider service
      </button>
    </>
  )
}

const ModelSourcesSection: React.FC<{ catalog: CatalogModel[]; onChanged: () => void }> = ({ catalog, onChanged }) => {
  const [rows, setRows] = useState<SourceDraft[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [balances, setBalances] = useState<Record<string, SourceBalance>>({})
  const [pendingSel, setPendingSel] = useState<Record<string, string[]>>({}) // curation selection per source (for the Save button)

  const [chartId, setChartId] = useState<string | null>(null)
  const loadBalances = () => {
    modelSourcesApi.balances()
      .then((bs) => setBalances(Object.fromEntries(bs.map((b) => [b.sourceId, b]))))
      .catch(() => { /* balances are best-effort */ })
  }
  useEffect(() => { loadBalances() }, [])

  const load = async () => {
    try {
      const sources = await modelSourcesApi.list()
      setRows(sources.map((s) => ({ ...s })))
    } catch { /* registry unreachable — rows stay empty; the add button still works */ }
    setLoaded(true)
  }
  useEffect(() => { void load() }, [])

  const up = (i: number, patch: Partial<SourceDraft>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch, _dirty: true, _msg: null } : x)))

  const discoveredCount = (sourceId: string) => catalog.filter((m) => m.sourceId === sourceId).length

  const saveRow = async (i: number, overrides: Partial<{ models: string[] }> = {}) => {
    const d = rows[i]
    if (overrides.models) up(i, { models: overrides.models }) // reflect the curated selection in the row
    const candidate = {
      id: d.id || slugify(d.displayName || ''),
      tag: (d.tag || '').toUpperCase(),
      displayName: d.displayName,
      transport: d.transport ?? 'openai_chat',
      baseUrl: d.baseUrl,
      // Blank or still-masked ⇒ omit so the server preserves the stored key.
      apiKey: d.apiKey && !d.apiKey.startsWith('***') ? d.apiKey : undefined,
      adminApiKey: d.adminApiKey && !d.adminApiKey.startsWith('***') ? d.adminApiKey : undefined,
      discovery: d.discovery ?? 'auto',
      models: overrides.models ?? d.models ?? [],
      enabled: d.enabled !== false,
    }
    const parsed = externalModelSourceSchema.safeParse(candidate)
    if (!parsed.success) {
      up(i, { _msg: parsed.error.issues.map((iss) => `${iss.path.join('.') || 'source'}: ${iss.message}`).join(' · ') })
      return
    }
    setBusyId(candidate.id)
    const r = await modelSourcesApi.save(parsed.data)
    setBusyId(null)
    if (!r.ok) { up(i, { _msg: r.error || 'save failed' }); return }
    await load()
    onChanged() // refresh the catalog so the discovered-count reflects the new source
  }

  const removeRow = async (i: number) => {
    const d = rows[i]
    if (d._isNew) { setRows((r) => r.filter((_, j) => j !== i)); return }
    const ok = await confirmStore.confirm({
      title: 'Remove model source',
      message: `Remove “${d.displayName || d.id}” from the registry? Its models drop out of the unified catalog and its stored API key is deleted.`,
      confirmText: 'Remove',
    })
    if (!ok) return
    setBusyId(d.id)
    const r = await modelSourcesApi.remove(d.id)
    setBusyId(null)
    if (!r.ok) { up(i, { _msg: r.error || 'delete failed' }); return }
    await load()
    onChanged()
  }

  return (
    <>
      <div style={sectionTitle}>Model API sources</div>
      <div style={{ ...sub, marginBottom: 8 }}>
        API model providers behind the AI-Lab proxy (source of truth: endpoint + key ⇒ all its models join the
        tagged catalog below and route through <code>/api/proxy</code>). Keys are stored server-side and never
        shown again — a masked field left untouched keeps the existing key.
      </div>
      {loaded && rows.length === 0 && <div style={{ ...sub, marginBottom: 8 }}>No sources registered yet.</div>}
      {rows.map((d, i) => (
        <div key={d._isNew ? `new-${i}` : d.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input style={{ ...smallInp, width: 150 }} placeholder="display name" value={d.displayName ?? ''} onChange={(ev) => up(i, { displayName: ev.target.value, ...(d._isNew && !d.id ? {} : {}) })} />
            <input
              style={{ ...smallInp, width: 90, fontFamily: 'var(--font-mono)' }}
              placeholder="TAG"
              title="Catalog tag, e.g. MAX / AN / DS / OC"
              list="known-source-tags"
              value={d.tag ?? ''}
              onChange={(ev) => up(i, { tag: ev.target.value.toUpperCase() })}
            />
            <datalist id="known-source-tags">
              {KNOWN_SOURCE_TAGS.filter((t) => t !== 'AI-LAB').map((t) => <option key={t} value={t} />)}
            </datalist>
            <select style={{ ...smallInp, width: 120 }} value={d.transport ?? 'openai_chat'} onChange={(ev) => up(i, { transport: ev.target.value as 'openai_chat' | 'anthropic' })}>
              <option value="openai_chat">openai_chat</option>
              <option value="anthropic">anthropic</option>
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--fg-muted)' }}>
              <input type="checkbox" checked={d.enabled !== false} onChange={(ev) => up(i, { enabled: ev.target.checked })} /> enabled
            </label>
            <span style={{ flex: 1 }} />
            {!d._isNew && (
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                {discoveredCount(d.id)} model{discoveredCount(d.id) === 1 ? '' : 's'} in catalog
              </span>
            )}
            {!d._isNew && balances[d.id]?.supported && balances[d.id].kind !== 'spend' && typeof balances[d.id].balance === 'number' && (
              <span
                title={`Credit remaining. Used $${Number(balances[d.id].totalUsage ?? balances[d.id].usage?.total ?? 0).toFixed(2)}${balances[d.id].usage?.monthly != null ? ` · $${Number(balances[d.id].usage!.monthly).toFixed(2)} this month` : ''}`}
                style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)', borderRadius: 5, padding: '2px 7px' }}
              >
                💳 ${Number(balances[d.id].balance).toFixed(2)} {balances[d.id].currency || ''}
              </span>
            )}
            {!d._isNew && balances[d.id]?.supported && balances[d.id].kind === 'spend' && typeof balances[d.id].spendMonth === 'number' && (
              <span
                title="Org spend this calendar month (Anthropic admin cost report)"
                style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', borderRadius: 5, padding: '2px 7px' }}
              >
                📊 ${Number(balances[d.id].spendMonth).toFixed(2)}/mo
              </span>
            )}
            {!d._isNew && (
              <button style={{ ...btn, padding: '2px 7px', fontSize: 11 }} title="Credit cost over time" onClick={() => setChartId((c) => (c === d.id ? null : d.id))}>
                📈
              </button>
            )}
          </div>
          {chartId === d.id && !d._isNew && <BalanceChart sourceId={d.id} />}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input style={{ ...smallInp, flex: 2, minWidth: 220 }} placeholder="base URL, e.g. https://api.deepseek.com/v1" value={d.baseUrl ?? ''} onChange={(ev) => up(i, { baseUrl: ev.target.value })} />
            <input
              style={{ ...smallInp, flex: 1, minWidth: 150 }}
              type="password"
              placeholder={d.hasKey ? `key set (${d.apiKey ?? '***'}) — blank keeps it` : 'API key (optional)'}
              value={d.apiKey && !d.apiKey.startsWith('***') ? d.apiKey : ''}
              onChange={(ev) => up(i, { apiKey: ev.target.value })}
            />
            {capsFor(d.transport)?.adminKey && (
              <input
                style={{ ...smallInp, flex: 1, minWidth: 180 }}
                type="password"
                title={capsFor(d.transport)?.adminKeyTitle}
                placeholder={d.hasAdminKey ? `admin key set (${d.adminApiKey ?? '***'}) — blank keeps it` : (capsFor(d.transport)?.adminKeyLabel ?? 'Admin key — usage/cost')}
                value={d.adminApiKey && !d.adminApiKey.startsWith('***') ? d.adminApiKey : ''}
                onChange={(ev) => up(i, { adminApiKey: ev.target.value })}
              />
            )}
            <select style={{ ...smallInp, width: 100 }} title="auto = discover via {baseUrl}/models; list = explicit ids" value={d.discovery ?? 'auto'} onChange={(ev) => up(i, { discovery: ev.target.value as 'auto' | 'list' })}>
              <option value="auto">auto</option>
              <option value="list">list</option>
            </select>
          </div>
          {d.discovery === 'list' && (
            <input
              style={{ ...smallInp, width: '100%', marginBottom: 6, fontFamily: 'var(--font-mono)' }}
              placeholder="model ids, comma-separated"
              value={(d.models ?? []).join(', ')}
              onChange={(ev) => up(i, { models: ev.target.value.split(',').map((m) => m.trim()).filter(Boolean) })}
            />
          )}
          {!d._isNew && d.discovery !== 'list' && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  style={{ ...btn, padding: '4px 10px', fontSize: 12 }}
                  onClick={() => setExpanded((e) => (e === d.id ? null : d.id))}
                >
                  {expanded === d.id ? '▾' : '▸'} Curate models {d.models && d.models.length ? `(${d.models.length} selected)` : '(all enabled)'}
                </button>
                {expanded === d.id && (
                  <button
                    style={{ ...btn, padding: '4px 12px', fontSize: 12, fontWeight: 600, borderColor: 'var(--accent)', color: 'var(--accent)' }}
                    disabled={busyId !== null}
                    onClick={() => void saveRow(i, { models: pendingSel[d.id] ?? d.models ?? [] })}
                  >
                    Save selection
                  </button>
                )}
              </div>
              {expanded === d.id && (
                <ModelCuration sourceId={d.id} onSelection={(models) => setPendingSel((p) => ({ ...p, [d.id]: models }))} />
              )}
            </div>
          )}
          {d._msg && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 6 }}>{d._msg}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{ ...btn, padding: '5px 12px', fontSize: 12 }} disabled={busyId !== null || (!d._dirty && !d._isNew)} onClick={() => void saveRow(i)}>
              {d._isNew ? 'Register source' : 'Save changes'}
            </button>
            <button style={delBtn} title="Remove source" disabled={busyId !== null} onClick={() => void removeRow(i)}><Trash2 size={13} /></button>
          </div>
        </div>
      ))}
      <button
        style={addBtn}
        onClick={() => setRows((r) => [...r, { id: '', tag: '', displayName: '', transport: 'openai_chat', baseUrl: '', discovery: 'auto', models: [], enabled: true, _isNew: true, _dirty: true } as SourceDraft])}
      >
        <Plus size={13} /> Add model source
      </button>
    </>
  )
}

/** Read-only view of the unified catalog, grouped by source tag. */
const CatalogBrowser: React.FC<{ catalog: CatalogModel[]; loaded: boolean; onRefresh: () => void }> = ({ catalog, loaded, onRefresh }) => {
  const byTag = new Map<string, CatalogModel[]>()
  for (const m of catalog) {
    const list = byTag.get(m.tag) ?? []
    list.push(m)
    byTag.set(m.tag, list)
  }
  return (
    <>
      <div style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
        Unified model catalog
        <button style={{ ...btn, padding: 4 }} title="Refresh catalog" onClick={onRefresh}><RefreshCw size={12} /></button>
        <span style={{ fontWeight: 400, color: 'var(--fg-faint)' }}>{loaded ? `${catalog.length} models` : 'loading…'}</span>
      </div>
      {[...byTag.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, models]) => (
        <details key={tag} style={{ marginBottom: 6 }}>
          <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--fg)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>[{tag}]</span>{' '}
            <span style={{ color: 'var(--fg-muted)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
          </summary>
          <div style={{ padding: '4px 0 4px 18px' }}>
            {models.map((m) => (
              <div key={m.id} style={{ fontSize: 12, padding: '2px 0', color: 'var(--fg-muted)' }} title={m.id}>
                {m.displayName}
                <span style={{ color: 'var(--fg-faint)' }}> · {m.kind === 'local' ? m.upstreamModel !== m.displayName ? m.upstreamModel : 'local' : m.sourceId}</span>
              </div>
            ))}
          </div>
        </details>
      ))}
    </>
  )
}

export const ExternalServicesPanel: React.FC = () => {
  const { s, busy, msg, save } = useClusterSettings()
  const [vdb, setVdb] = useState<any[]>([])
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  useEffect(() => {
    if (s) setVdb(s.vectorDbs ?? [])
  }, [s])
  const refreshCatalog = async () => {
    try { setCatalog(await hermesApi.listCatalog()) } catch { /* proxy unreachable */ }
    setCatalogLoaded(true)
  }
  useEffect(() => { void refreshCatalog() }, [])
  if (!s) return <div style={sub}>Loading…</div>
  const up = (arr: any[], set: any, i: number, patch: any) => set(arr.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  return (
    <div style={wrapWide}>
      <div style={h}>External Services</div>
      <div style={sub}>Model API sources (the proxy&apos;s external-model registry) + vector DBs. Stored on CT 152.</div>

      <ModelSourcesSection catalog={catalog} onChanged={() => void refreshCatalog()} />

      <ProviderServicesSection />

      <CatalogBrowser catalog={catalog} loaded={catalogLoaded} onRefresh={() => void refreshCatalog()} />

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
        <button style={primaryBtn} disabled={busy} onClick={() => void save({ vectorDbs: vdb })}>Save vector DBs</button>
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
