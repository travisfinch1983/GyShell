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
import { RotateCcw, Save, AlertTriangle, Plug, History } from 'lucide-react'
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
  // Health is separate from the group: the group can be perfect while the agent serves nothing.
  const [health, setHealth] = useState<{ healthy: boolean; gaveUp: boolean; detail: string } | null>(null)
  const [backups, setBackups] = useState<Array<{ file: string; savedAt: string; toolCount: number }>>([])
  const [showBackups, setShowBackups] = useState(false)

  const refreshHealth = React.useCallback(async () => {
    const [h, b] = await Promise.all([hermesApi.getToolHealth(agentId), hermesApi.listToolBackups(agentId)])
    setHealth(h ? { healthy: h.healthy, gaveUp: h.gaveUp, detail: h.detail } : null)
    setBackups(b)
  }, [agentId])

  useEffect(() => { void refreshHealth() }, [refreshHealth])

  const reconnect = async () => {
    setBusy(true); setErr(''); setStatus('Reconnecting the agent…')
    const r = await hermesApi.reconnectTools(agentId)
    setBusy(false)
    if (!r.ok) { setErr(`Reconnect failed: ${r.error ?? 'unknown'}`); setStatus(''); return }
    setStatus(r.restarted ? 'Reconnected — the agent is reloading its tools.' : 'Gateway was not running; nothing to reconnect.')
    setTimeout(() => { void refreshHealth() }, 4000)
  }

  const restore = async (file: string, toolCount: number) => {
    const sure = await confirmStore.confirm({
      title: 'Restore this tool set?',
      body: `Replaces the agent's current tools with the ${toolCount}-tool snapshot from ${file}. Any tool removed or disabled since then will be reported instead of silently dropped.`,
      confirmText: 'Restore',
    })
    if (!sure) return
    setBusy(true); setErr(''); setStatus('Restoring…')
    const r = await hermesApi.restoreToolBackup(agentId, file)
    setBusy(false)
    if (!r.ok) { setErr(`Restore failed: ${r.error ?? 'unknown'}`); setStatus(''); return }
    setStatus(`Restored ${r.toolCount ?? '?'} tools.`)
    const fresh = await hermesApi.getTools(agentId)
    if (fresh) { setSelected(new Set(fresh.selected)); setBaseline(new Set(fresh.selected)); setScoped(fresh.scoped) }
    void refreshHealth()
  }

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

  // #86: session-bound AI-Lab built-ins are federated into the gateway for config only and can
  // NEVER execute for a Hermes agent (tools/call answers with a refusal the model reads as
  // output). Don't advertise them here at all.
  const hermesServers = React.useMemo(() => servers
    .map((s) => {
      const tools = s.tools.filter((t) => t.gatewayExecutable !== false)
      return { ...s, tools, toolCount: tools.length, enabledCount: tools.filter((t) => t.enabled).length }
    })
    .filter((s) => s.tools.length > 0), [servers])
  const nonExecutable = React.useMemo(
    () => new Set(servers.flatMap((s) => s.tools.filter((t) => t.gatewayExecutable === false).map((t) => t.name))),
    [servers])

  // Prune never-executable names out of the WORKING selection once the tree is known. The
  // baseline keeps the raw group, so the pruning registers as an unsaved change — saving then
  // genuinely cleans the agent's group (the backend strips them too, and reports it).
  const [prunedCount, setPrunedCount] = useState(0)
  useEffect(() => {
    if (!loaded || nonExecutable.size === 0) return
    setSelected((prev) => {
      const dead = [...prev].filter((n) => nonExecutable.has(n))
      if (!dead.length) return prev
      const next = new Set(prev)
      for (const n of dead) next.delete(n)
      setPrunedCount((c) => c + dead.length)
      return next
    })
  }, [loaded, nonExecutable])

  const totalTools = hermesServers.reduce((n, s) => n + s.toolCount, 0)
  const dirty = selected.size !== baseline.size || [...selected].some((n) => !baseline.has(n))
  const conflicts = hermesServers.flatMap((s) => s.tools.filter((t) => selected.has(t.name) && !t.enabled))

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
    const removedNote = r.removedNonExecutable?.length ? ` · removed ${r.removedNonExecutable.length} non-executable AI-Lab-internal tool(s)` : ''
    setStatus(`Scoped ✓ — ${r.toolCount ?? selected.size} tools${r.endpoint ? ` · ${r.endpoint}` : ''}${removedNote} · applies on the agent's next session`)
    setPrunedCount(0)
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
      {prunedCount > 0 && (
        <div className={styles.formMsg} style={{ color: 'var(--warning, #fbbf24)' }}>
          {prunedCount} tool{prunedCount === 1 ? '' : 's'} in this agent's group {prunedCount === 1 ? 'is an' : 'are'} AI-Lab-internal
          built-in{prunedCount === 1 ? '' : 's'} that can never execute for Hermes agents — hidden from the list; Save to remove
          {prunedCount === 1 ? ' it' : ' them'} from the group.
        </div>
      )}

      {/* The warning row shows only when something is wrong, but Reconnect is offered
          ALWAYS. Gating the control on !healthy produced two bad outcomes: a healthy-looking
          agent whose LIVE CHAT SESSION still held an old toolset could not be reconnected at
          all (an ACP session captures its tools when created, so a config change made outside
          the tool editor never reaches it), and in the `pending` state the detail text read
          "do NOT reconnect again" while sitting directly beside a Reconnect button. The advice
          and the control now agree. */}
      {health && !health.healthy && (
        <div className={styles.formMsg} style={{ color: 'var(--warning, #fbbf24)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={14} />
          <span style={{ flex: 1 }}>{health.detail}</span>
        </div>
      )}

      <div className={styles.formMsg} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={styles.dim} style={{ flex: 1, fontSize: 11 }}>
          Reconnect restarts this agent's gateway and reloads its live chat sessions with
          <code> --resume</code>, so conversation history is kept. Use it when the agent cannot see
          tools you have assigned — a chat opened before a tool change keeps the older set.
        </span>
        <button className={styles.btn} disabled={busy} onClick={() => void reconnect()}>
          <Plug size={13} /> Reconnect
        </button>
      </div>

      {backups.length > 0 && (
        <div style={{ margin: '6px 0' }}>
          <button className={styles.btn} onClick={() => setShowBackups((v) => !v)}>
            <History size={13} /> {showBackups ? 'Hide' : 'Restore'} previous tool sets ({backups.length})
          </button>
          {showBackups && (
            <div className={styles.dim} style={{ marginTop: 6 }}>
              Snapshots are taken automatically before every tool change.
              {backups.map((b) => (
                <div key={b.file} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <span style={{ flex: 1 }}>
                    {b.savedAt ? new Date(b.savedAt).toLocaleString() : b.file} · {b.toolCount} tools
                  </span>
                  <button className={styles.btn} disabled={busy} onClick={() => void restore(b.file, b.toolCount)}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <McpToolTree
        servers={hermesServers}
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
