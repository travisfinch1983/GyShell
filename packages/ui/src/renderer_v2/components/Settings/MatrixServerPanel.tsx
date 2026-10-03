import React, { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

type Mode = 'closed' | 'token' | 'approval' | 'unknown'

const MODE_INFO: Record<Exclude<Mode, 'unknown'>, { label: string; desc: string }> = {
  closed: { label: 'Closed', desc: 'Nobody can create an account.' },
  token: { label: 'Token', desc: 'Anyone with the registration token can sign up; the account is active immediately.' },
  approval: {
    label: 'Approval',
    desc: 'Sign-up needs the token AND new accounts start suspended (read-only). The server posts a notice in your admin room; approve with !admin users unsuspend @name:deeveeyant.com, or reject with !admin users deactivate @name:deeveeyant.com.',
  },
}

const wrap: React.CSSProperties = { maxWidth: 760, padding: '8px 4px' }
const h: React.CSSProperties = { fontSize: 18, fontWeight: 600, marginBottom: 4 }
const sub: React.CSSProperties = { fontSize: 12, opacity: 0.75, marginBottom: 16, lineHeight: 1.5 }
const card: React.CSSProperties = { border: '1px solid var(--border, #3334)', borderRadius: 8, padding: 14, marginBottom: 12 }
const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border, #3336)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 }
const btnOn: React.CSSProperties = { ...btn, background: 'var(--accent, #3b82f6)', color: '#fff', borderColor: 'transparent' }

/** Settings → Matrix Server. Sign-up mode for the continuwuity homeserver (deeveeyant.com). The
 *  server is the source of truth: the panel shows what the registration API reports, and a change
 *  only reports success after the VPS script has verified it. */
export const MatrixServerPanel: React.FC = () => {
  const [mode, setMode] = useState<Mode>('unknown')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [tokenIn, setTokenIn] = useState('')
  const [issued, setIssued] = useState<string>('')

  const load = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await bridge().request('GET', '/api/matrix/signups')
      if (r?.error) setMsg({ text: String(r.error), ok: false })
      setMode((r?.mode as Mode) || 'unknown')
    } catch (e: any) { setMsg({ text: 'Could not reach the Matrix server: ' + (e?.message || e), ok: false }) }
    finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])

  const apply = async (next: Exclude<Mode, 'unknown'>) => {
    setBusy(true); setMsg(null); setIssued('')
    try {
      const body: any = { mode: next }
      if (next !== 'closed' && tokenIn.trim()) body.token = tokenIn.trim()
      const r = await bridge().request('POST', '/api/matrix/signups', body)
      if (r?.error) { setMsg({ text: String(r.error), ok: false }); setMode((r?.mode as Mode) || mode) }
      else {
        setMode(r.mode as Mode)
        if (r.token) setIssued(r.token)
        setMsg({ text: `Sign-ups are now ${MODE_INFO[r.mode as Exclude<Mode, 'unknown'>]?.label ?? r.mode}${r.via ? ` (applied via ${r.via})` : ''}.`, ok: true })
        setTokenIn('')
      }
    } catch (e: any) { setMsg({ text: 'Change failed: ' + (e?.message || e), ok: false }) }
    finally { setBusy(false) }
  }

  return (
    <div style={wrap}>
      <div style={h}>Matrix Server</div>
      <div style={sub}>
        continuwuity homeserver for <b>deeveeyant.com</b> on the US VPS. Every open mode needs a registration token:
        continuwuity's release builds do not allow token-free sign-ups at all.
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <b>Sign-ups</b>
          <span style={{ fontSize: 12, opacity: 0.8 }}>
            current: <b>{mode === 'unknown' ? (busy ? 'checking…' : 'unknown') : MODE_INFO[mode].label}</b>
          </span>
          <span style={{ flex: 1 }} />
          <button style={btn} disabled={busy} onClick={() => void load()} title="Re-read the mode from the server"><RefreshCw size={13} /></button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {(['closed', 'token', 'approval'] as const).map((m) => (
            <button key={m} style={mode === m ? btnOn : btn} disabled={busy} onClick={() => void apply(m)}>{MODE_INFO[m].label}</button>
          ))}
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.5, marginBottom: 10 }}>
          {(['closed', 'token', 'approval'] as const).map((m) => <div key={m}><b>{MODE_INFO[m].label}:</b> {MODE_INFO[m].desc}</div>)}
        </div>
        <label style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          Token for Token/Approval (optional; 8-64 letters/digits, generated if blank):
          <input value={tokenIn} onChange={(e) => setTokenIn(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} maxLength={64}
                 style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border, #3336)', background: 'transparent', color: 'inherit', minWidth: 220 }} />
        </label>
        {issued && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            Registration token (shown once; copy it now): <code style={{ userSelect: 'all', fontWeight: 600 }}>{issued}</code>
          </div>
        )}
        {msg && <div style={{ marginTop: 10, fontSize: 12, color: msg.ok ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)' }}>{msg.text}</div>}
      </div>
    </div>
  )
}
