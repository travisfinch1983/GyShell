import React, { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

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
