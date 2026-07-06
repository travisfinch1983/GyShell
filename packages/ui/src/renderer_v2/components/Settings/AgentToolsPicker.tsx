/**
 * AgentToolsSelector — per-agent tool SELECTION over the gateway tree, rendered
 * as the "Tools" sub-tab of the delegate-agent editor (Settings›Agents).
 *
 * Same Common/McpToolTree accordion as Quick Toggle, different axis:
 * checkboxes mean "in this agent's set", not the global enable state. A tool
 * that is CHECKED but globally disabled paints red (.mcptree-tool-conflict):
 * granted, but it won't function until re-enabled on the gateway. dimDisabled
 * is off so globally-disabled tools stay fully visible and grantable.
 *
 * The selection's canonical form is BACKEND-OWNED — this is the SOLE
 * allowedTools write path (the old inline grid is gone) and it never writes
 * agent.allowedTools or /api/mcp/groups directly. It speaks only:
 *   GET /api/mcp/agent-tools/:agentId → { selected: string[] }   (gateway names)
 *   PUT /api/mcp/agent-tools/:agentId { selected } → { ok, endpoint,
 *       functionalCount, disabledSelectedCount, unsupportedCount }
 * The backend persists to allowedTools (naming reconciliation between the
 * runtime's double-prefixed names and the gateway's server__tool names is its
 * job) and syncs the agent's gateway group. Until those endpoints are deployed
 * the selector runs read-only with a banner (GET failure → preview mode).
 */
import React, { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { McpToolTree, useMcpTree, type McpTreeServer } from '../Common/McpToolTree'

function bridge(): any { return (window as any).gyshell?.cluster }

interface SaveResult {
  ok: boolean
  endpoint?: string
  functionalCount?: number
  disabledSelectedCount?: number
  /** Selected tools the in-process executor can't run yet (fast-follow). */
  unsupportedCount?: number
}

export const AgentToolsSelector: React.FC<{
  agentId: string
  /** False while the agent draft has never been saved — the backend can't
   *  persist a selection for an id that doesn't exist yet. */
  persisted: boolean
  /** Called after a successful PUT so the owner can refresh its agent list
   *  (the backend rewrote allowedTools). */
  onSaved?: () => void
}> = ({ agentId, persisted, onSaved }) => {
  const { servers, loading, err: treeErr } = useMcpTree()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [baseline, setBaseline] = useState<Set<string>>(new Set())
  const [endpointsLive, setEndpointsLive] = useState<boolean | null>(null) // null = probing
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!persisted) return
    void (async () => {
      try {
        const r = await bridge().request('GET', `/api/mcp/agent-tools/${encodeURIComponent(agentId)}`)
        if (r?.error) throw new Error(String(r.error))
        const sel = new Set<string>(Array.isArray(r?.selected) ? r.selected : [])
        setSelected(sel)
        setBaseline(new Set(sel))
        setEndpointsLive(true)
      } catch {
        setEndpointsLive(false) // backend lane not deployed yet — preview only
      }
    })()
  }, [agentId, persisted])

  const dirty = selected.size !== baseline.size || [...selected].some((n) => !baseline.has(n))
  const conflicts = servers.flatMap((s) => s.tools.filter((t) => selected.has(t.name) && !t.enabled))

  const toggleTool = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  const toggleServer = (s: McpTreeServer) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const all = s.tools.length > 0 && s.tools.every((t) => next.has(t.name))
      for (const t of s.tools) { if (all) next.delete(t.name); else next.add(t.name) }
      return next
    })
  }

  const save = async () => {
    setSaving(true); setErr(''); setStatus('')
    try {
      const r: SaveResult = await bridge().request('PUT', `/api/mcp/agent-tools/${encodeURIComponent(agentId)}`, { selected: [...selected] })
      if ((r as any)?.error || r?.ok === false) throw new Error(String((r as any)?.error ?? 'save failed'))
      setBaseline(new Set(selected))
      const bits = [
        `Synced${r.endpoint ? ` — ${r.endpoint}` : ''}`,
        `${r.functionalCount ?? selected.size - conflicts.length} functional`,
      ]
      if ((r.disabledSelectedCount ?? conflicts.length) > 0) bits.push(`${r.disabledSelectedCount ?? conflicts.length} granted but globally disabled`)
      if ((r.unsupportedCount ?? 0) > 0) bits.push(`${r.unsupportedCount} not yet runnable in-process`)
      setStatus(bits.join(' · '))
      onSaved?.()
    } catch (e: any) {
      setErr(`Save failed: ${e?.message || e}`)
    } finally {
      setSaving(false)
    }
  }

  if (!persisted) {
    return (
      <div className="tool-empty" style={{ padding: '12px 0' }}>
        Save the agent first, then pick its tools — the selection is stored against the agent's id.
      </div>
    )
  }

  return (
    <>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
        Which gateway tools this agent may use ({selected.size} selected). Checking a tool grants it to
        the agent; the global on/off lives in Settings › Tools. A <span style={{ color: 'var(--danger, #f87171)' }}>red</span> tool
        is granted here but globally disabled — it won't function until re-enabled on the gateway.
      </p>
      {endpointsLive === false && (
        <div className="settings-error" style={{ marginBottom: 8 }}>
          Agent-tools endpoints aren't deployed yet — preview only, saving is disabled.
        </div>
      )}
      {treeErr && <div className="settings-error" style={{ marginBottom: 8 }}>{treeErr}</div>}
      <McpToolTree
        servers={servers}
        dimDisabled={false}
        emptyLabel={loading ? 'Loading the gateway tool tree…' : 'No servers registered on the gateway.'}
        serverBadge={(s) => {
          const n = s.tools.filter((t) => selected.has(t.name)).length
          return (
            <span className="mcptree-count" title={`${n} of ${s.toolCount} tools selected for this agent`}>
              {n}/{s.toolCount}
            </span>
          )
        }}
        serverControl={(s) => {
          const picked = s.tools.filter((t) => selected.has(t.name)).length
          const all = s.tools.length > 0 && picked === s.tools.length
          return (
            <input
              type="checkbox"
              title={all ? `Deselect all ${s.name} tools` : `Select all ${s.name} tools`}
              checked={all}
              ref={(el) => { if (el) el.indeterminate = picked > 0 && !all }}
              onChange={() => toggleServer(s)}
              disabled={saving}
            />
          )
        }}
        toolControl={(t) => (
          <input type="checkbox" checked={selected.has(t.name)} onChange={() => toggleTool(t.name)} disabled={saving} />
        )}
        toolClassName={(t) => (selected.has(t.name) && !t.enabled ? 'mcptree-tool-conflict' : '')}
      />
      {conflicts.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--danger, #f87171)', marginTop: 8 }}>
          {conflicts.length} selected tool{conflicts.length === 1 ? ' is' : 's are'} globally disabled and won't function: {conflicts.map((t) => t.shortName).join(', ')}
        </div>
      )}
      {err && <div className="settings-error" style={{ marginTop: 8 }}>{err}</div>}
      {status && <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 8 }}>{status}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button
          className="btn-primary"
          onClick={() => void save()}
          disabled={saving || !dirty || endpointsLive !== true}
          title={endpointsLive !== true ? 'Waiting for the agent-tools backend' : dirty ? 'Sync the selection to the agent' : 'No changes'}
        >
          <Save size={14} /> {saving ? 'Syncing…' : 'Save selection'}
        </button>
      </div>
    </>
  )
}
