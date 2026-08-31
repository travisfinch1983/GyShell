import React, { useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Play, Download, Loader2, Save } from 'lucide-react'
import { mcpServersStore } from '../../stores/McpServersStore'

function bridge(): any { return (window as any).gyshell?.cluster }
const BASE = '/api/proxy/claude-max'

interface CaptureStatus { enabled: boolean; max: number; captured: number }
interface CaptureRow { index: number; t: number; endpoint?: string; model?: string; prefixLen: number; blocks?: Array<{ label: string; len: number; hash: string }> }
interface DiffBlock { label: string; changed: boolean; a: { len: number; hash: string } | null; b: { len: number; hash: string } | null }
interface DiffResult { identical?: boolean; error?: string; lenA?: number; lenB?: number; firstDivergenceAt?: number | null; contextA?: string | null; contextB?: string | null; blocks?: DiffBlock[] }

const fmtTime = (t: number) => new Date(t).toLocaleTimeString()

function downloadFile(name: string, data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** MCP tool-injection settings for the llm proxy (PUT /api/mcp/settings) —
 *  AI-Lab's own proxy config, relocated here from the AI-Tools MCP panel when
 *  that panel became the MCPJungle dashboard embed (which has no surface for it). */
const McpToolProxySection: React.FC = observer(() => {
  const store = mcpServersStore
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const [saved, setSaved] = useState(false)
  const save = async () => { await store.saveSettings(); setSaved(true); setTimeout(() => setSaved(false), 2000) }

  return (
    <>
      <div className="settings-section-header">
        <div className="settings-section-title">MCP Tool Proxy</div>
      </div>
      <div className="settings-rows">
        <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
          How the LLM proxy uses the MCP gateway's tools. Server registration and per-tool
          enable/disable live in the MCP dashboard (AI · Tools → MCP Servers).
        </p>
        {/* toolInjection switch removed 2026-08-31 — it controlled deleted dead
            code; a switch reporting state it does not control is a false
            instrument. maxToolRounds below is FLAGGED for the same review
            (no live consumer found) but awaits claude1's ruling. */}
        <div className="settings-row">
          <div className="settings-row-label-with-info">
            <label>Max tool rounds</label>
          </div>
          <input
            type="number"
            min={1}
            max={50}
            value={store.settings.maxToolRounds ?? 20}
            onChange={(e) => store.setSetting('maxToolRounds', parseInt(e.target.value, 10) || 20)}
            style={{ width: 70, height: 28, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--control-bg)', color: 'var(--fg)', fontSize: 13 }}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label-with-info">
            <label>Apply</label>
          </div>
          <button className="btn-secondary" onClick={() => void save()}>
            <Save size={14} /> {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )
})

/** Settings → Proxy: MCP tool-proxy config + Claude Max prompt-capture toggle + cache-miss diff viewer. */
export const ProxySettingsPanel: React.FC = () => {
  const [status, setStatus] = useState<CaptureStatus | null>(null)
  const [captures, setCaptures] = useState<CaptureRow[]>([])
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const r = await bridge().request('GET', `${BASE}/debug/captures`)
      setStatus({ enabled: !!r?.enabled, max: r?.max ?? 8, captured: r?.captured ?? 0 })
      setCaptures(r?.captures ?? [])
      setErr('')
    } catch (e: any) {
      setErr(e?.message || 'Failed to reach proxy')
    }
  }, [])

  // Poll while the tab is open so the captured-count stays live as you send messages.
  useEffect(() => {
    void refresh()
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [refresh])

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try {
      await bridge().request('POST', `${BASE}/debug/capture`, { enabled })
      if (!enabled) { setDiff(null) }
      await refresh()
    } catch (e: any) {
      setErr(e?.message || 'Toggle failed')
    } finally { setBusy(false) }
  }

  const runDiff = async () => {
    setBusy(true)
    try {
      const r = await bridge().request('GET', `${BASE}/debug/diff`)
      setDiff(r)
      setErr('')
    } catch (e: any) {
      setErr(e?.message || 'Diff failed')
    } finally { setBusy(false) }
  }

  const downloadCaptures = async () => {
    setBusy(true)
    try {
      const r = await bridge().request('GET', `${BASE}/debug/captures?full=1`)
      downloadFile(`claude-max-captures-${Date.now()}.json`, r)
    } catch (e: any) {
      setErr(e?.message || 'Download failed')
    } finally { setBusy(false) }
  }

  const enabled = !!status?.enabled

  return (
    <>
      <McpToolProxySection />

      <div className="settings-section-header" style={{ marginTop: 20 }}>
        <div className="settings-section-title">Claude Max — Prompt Capture</div>
      </div>
      <div className="settings-rows">
        <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
          Records the exact prompt prefixes sent upstream through <code>/api/proxy/claude-max</code>, so you can find why a
          client busts the prompt cache (a per-send timestamp, counter, or reordered history changes the prefix every turn).
          Arm it, send <strong>two</strong> messages from the client, then run the diff to see the first point they differ.
          Off by default; captures live in memory only and auto-disable after 30 minutes idle.
        </p>

        <div className="settings-row">
          <div className="settings-row-label-with-info">
            <label>Capture enabled</label>
          </div>
          <label className="switch">
            <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
            <span className="switch-slider" />
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-label-with-info">
            <label>Status</label>
          </div>
          <span style={{ fontSize: 12.5, color: enabled ? 'var(--accent)' : 'var(--fg-muted)' }}>
            {enabled ? 'ARMED' : 'off'} · {status?.captured ?? 0} captured (keeps last {status?.max ?? 8})
          </span>
        </div>

        <div className="settings-row">
          <div className="settings-row-label-with-info">
            <label>Actions</label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-secondary" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw size={14} /> Refresh
            </button>
            <button className="btn-secondary" onClick={() => void runDiff()} disabled={busy || (status?.captured ?? 0) < 2}>
              {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Run diff (last 2)
            </button>
            <button className="btn-secondary" onClick={() => diff && downloadFile(`claude-max-diff-${Date.now()}.json`, diff)} disabled={!diff}>
              <Download size={14} /> Save diff
            </button>
            <button className="btn-secondary" onClick={() => void downloadCaptures()} disabled={busy || (status?.captured ?? 0) === 0}>
              <Download size={14} /> Save full captures
            </button>
          </div>
        </div>
      </div>

      {err && <div className="settings-error" style={{ marginTop: 8 }}>{err}</div>}

      {diff && (
        <>
          <div className="settings-section-header" style={{ marginTop: 20 }}>
            <div className="settings-section-title">Diff result</div>
          </div>
          <div className="settings-rows">
            {diff.error ? (
              <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{diff.error}</div>
            ) : diff.identical ? (
              <div style={{ fontSize: 13, color: 'var(--accent)' }}>
                ✓ The two most recent prefixes are <strong>identical</strong> ({diff.lenA} chars). A continuing conversation
                should be hitting cache — if you saw a miss, the difference is elsewhere (e.g. tools or non-text blocks).
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  Prefixes diverge at <strong>char {diff.firstDivergenceAt}</strong> · lengths {diff.lenA} vs {diff.lenB}.
                  The changed block(s) below are what's busting the cache.
                </div>
                <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--fg-faint)', marginBottom: 3 }}>Request A (older) — around the divergence</div>
                    <pre style={{ margin: 0, padding: 8, background: 'var(--app-bg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflow: 'auto' }}>{diff.contextA}</pre>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--fg-faint)', marginBottom: 3 }}>Request B (newer) — around the divergence</div>
                    <pre style={{ margin: 0, padding: 8, background: 'var(--app-bg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflow: 'auto' }}>{diff.contextB}</pre>
                  </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                      <th style={{ padding: '4px 8px' }}>Block</th><th style={{ padding: '4px 8px' }}>Changed</th>
                      <th style={{ padding: '4px 8px' }}>Len A → B</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(diff.blocks ?? []).map((b, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)', color: b.changed ? 'var(--danger)' : 'inherit' }}>
                        <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{b.label}</td>
                        <td style={{ padding: '4px 8px' }}>{b.changed ? 'changed' : 'same'}</td>
                        <td style={{ padding: '4px 8px' }}>{b.a?.len ?? '—'} → {b.b?.len ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ fontSize: 11.5, color: 'var(--fg-faint)', marginTop: 8 }}>
                  Note: <code>system[0]</code> is AI-Lab's injected Claude Code identity (always stable). A changed
                  <code> system[n]</code> means the client injects dynamic content into its system prompt; a changed older
                  <code> msg[n]</code> means it rewrites history each turn.
                </p>
              </>
            )}
          </div>
        </>
      )}

      {captures.length > 0 && (
        <>
          <div className="settings-section-header" style={{ marginTop: 20 }}>
            <div className="settings-section-title">Captured requests ({captures.length})</div>
          </div>
          <div className="settings-rows">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                  <th style={{ padding: '4px 8px' }}>#</th><th style={{ padding: '4px 8px' }}>Time</th>
                  <th style={{ padding: '4px 8px' }}>Endpoint</th><th style={{ padding: '4px 8px' }}>Model</th>
                  <th style={{ padding: '4px 8px' }}>Prefix chars</th>
                </tr>
              </thead>
              <tbody>
                {captures.map((c) => (
                  <tr key={c.index} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '4px 8px' }}>{c.index}</td>
                    <td style={{ padding: '4px 8px' }}>{fmtTime(c.t)}</td>
                    <td style={{ padding: '4px 8px' }}>{c.endpoint}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{c.model}</td>
                    <td style={{ padding: '4px 8px' }}>{c.prefixLen.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
