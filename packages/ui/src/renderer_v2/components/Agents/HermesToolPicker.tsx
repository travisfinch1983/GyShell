/**
 * HermesToolPicker — per-agent gateway tool scoping for HERMES agents (JOB2,
 * contract 047cc8b). Lives in the Hermes agent editor's Tools tab.
 *
 * Each scoped agent gets its own gateway group `agent-<id>` and its Hermes MCP
 * config repoints at /v0/groups/agent-<id>/mcp — groups are the native
 * mechanism, so there is no execution gap. Contract:
 *   GET    /api/hermes/agents/:id/tools → { selected, scoped, endpoint }
 *   PUT    { selected }                 → { ok, endpoint, toolCount }  (upsert + repoint)
 *   DELETE                              → { ok }  (revert to full gateway, group deleted)
 *
 * Render (agreed with claude1): scoped:false → ALL UNCHECKED + "on the full
 * gateway" banner (Save = scope down; no 200-checkbox lie); scoped:true →
 * exactly the group's tools checked + a Reset-to-full-access button. RED
 * (.mcptree-tool-conflict) = checked && globally disabled on the gateway.
 * PUT/DELETE are synchronous (~1-3s) — Syncing state, no client timeout.
 * Changes apply on the agent's NEXT session (Hermes caches tools per session).
 */
import React, { useEffect, useState } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { McpToolTree, useMcpTree, type McpTreeServer } from '../Common/McpToolTree'
import { hermesApi } from '../../stores/hermesApi'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Agents.module.scss'

export const HermesToolPicker: React.FC<{ agentId: string }> = ({ agentId }) => {
  const { servers, loading: treeLoading, err: treeErr } = useMcpTree()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [baseline, setBaseline] = useState<Set<string>>(new Set())
  const [scoped, setScoped] = useState(false)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    void hermesApi.getTools(agentId).then((r) => {
      if (r === null) { setErr('Failed to read this agent’s tool scoping — backend unreachable?'); return }
      const sel = new Set(r.selected)
      setSelected(sel)
      setBaseline(new Set(sel))
      setScoped(r.scoped)
      setEndpoint(r.endpoint)
      setLoaded(true)
    })
  }, [agentId])

  const totalTools = servers.reduce((n, s) => n + s.toolCount, 0)
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

  const scope = async () => {
    if (selected.size === 0) {
      const sure = await confirmStore.confirm({
        title: 'Scope to ZERO tools?',
        message: `Saving an empty selection removes ALL gateway tools from “${agentId}”. If you meant to restore everything, use “Reset to full access” instead.`,
        confirmText: 'Scope to zero',
      })
      if (!sure) return
    }
    setBusy(true); setErr(''); setStatus('')
    const r = await hermesApi.putTools(agentId, [...selected])
    setBusy(false)
    if (!r.ok) { setErr(`Scope failed: ${r.error ?? 'unknown'}`); return }
    setScoped(true)
    setBaseline(new Set(selected))
    setEndpoint(r.endpoint ?? null)
    setStatus(`Scoped ✓ — ${r.toolCount ?? selected.size} tools${r.endpoint ? ` · ${r.endpoint}` : ''} · applies on the agent's next session`)
  }

  const reset = async () => {
    const sure = await confirmStore.confirm({
      title: 'Reset to full access',
      message: `Restore “${agentId}” to the FULL gateway (all ${totalTools || '~200'} tools)? This clears the agent's tool group.`,
      confirmText: 'Reset',
    })
    if (!sure) return
    setBusy(true); setErr(''); setStatus('')
    const r = await hermesApi.deleteTools(agentId)
    setBusy(false)
    if (!r.ok) { setErr(`Reset failed: ${r.error ?? 'unknown'}`); return }
    setScoped(false)
    setSelected(new Set())
    setBaseline(new Set())
    setEndpoint(null)
    setStatus("Full gateway access restored · applies on the agent's next session")
  }

  return (
    <div className={styles.card}>
      <div className={styles.summaryRow}>
        <div>
          <strong>Gateway tool scoping</strong>
          <div className={styles.dim}>
            {scoped
              ? `Scoped to ${baseline.size} tools${endpoint ? ` · ${endpoint}` : ''}`
              : `On the full gateway (all ${totalTools || '~200'} tools)`}
          </div>
        </div>
        <span className={styles.spacer} />
        {scoped && (
          <button
            className={styles.btn}
            disabled={busy}
            title="Reset clears the agent's tool group and restores full gateway access"
            onClick={() => void reset()}
          >
            <RotateCcw size={13} /> Reset to full access
          </button>
        )}
        <button
          className={styles.btnPrimary}
          disabled={busy || !loaded || (!dirty && scoped)}
          title={!loaded ? 'Waiting for the scoping state' : scoped && !dirty ? 'No changes' : 'Scope the agent to the selected tools'}
          onClick={() => void scope()}
        >
          <Save size={13} /> {busy ? 'Syncing…' : scoped ? 'Save selection' : 'Scope to selection'}
        </button>
      </div>

      {!scoped && loaded && (
        <div className={styles.dim} style={{ margin: '6px 0' }}>
          This agent sees every gateway tool. Check a subset below and “Scope to selection” to
          create its own tool group — nothing is pre-checked because nothing is restricted yet.
        </div>
      )}
      {err && <div className={styles.formMsg} style={{ color: 'var(--danger, #f87171)' }}>{err}</div>}
      {treeErr && <div className={styles.formMsg} style={{ color: 'var(--danger, #f87171)' }}>{treeErr}</div>}
      {status && <div className={styles.formMsg} style={{ color: 'var(--accent)' }}>{status}</div>}

      <McpToolTree
        servers={servers}
        dimDisabled={false}
        emptyLabel={treeLoading ? 'Loading the gateway tool tree…' : 'No servers registered on the gateway.'}
        serverBadge={(s) => {
          const n = s.tools.filter((t) => selected.has(t.name)).length
          return (
            <span className="mcptree-count" title={`${n} of ${s.toolCount} tools selected`}>
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
              disabled={busy}
            />
          )
        }}
        toolControl={(t) => (
          <input type="checkbox" checked={selected.has(t.name)} onChange={() => toggleTool(t.name)} disabled={busy} />
        )}
        toolClassName={(t) => (selected.has(t.name) && !t.enabled ? 'mcptree-tool-conflict' : '')}
      />
      {conflicts.length > 0 && (
        <div className={styles.formMsg} style={{ color: 'var(--danger, #f87171)' }}>
          {conflicts.length} selected tool{conflicts.length === 1 ? ' is' : 's are'} globally disabled and won't function: {conflicts.map((t) => t.shortName).join(', ')}
        </div>
      )}
      <div className={styles.dim} style={{ marginTop: 6, fontSize: 11 }}>
        Changes apply on the agent's next session — Hermes caches tools per session.
      </div>
    </div>
  )
}
