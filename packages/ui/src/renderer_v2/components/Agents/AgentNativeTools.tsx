/**
 * AgentNativeTools — per-agent toggles for Hermes' NATIVE (built-in) tools,
 * backed by claude1's acp-tool-override user plugin (88bbf79): the toolset is
 * redefined minus the disabled tools at agent load, so this is a REAL removal
 * (the model never sees them — the fix for "what am I looking at" spinning up
 * a blank headless browser instead of view_screen).
 *
 * Different axis from the gateway picker above: that scopes MCP gateway tools;
 * this scopes the agent's own built-ins (browser_*, file, terminal, …).
 * PUT sends the full OFF list; "Apply to ALL agents" uses the global endpoint.
 * Changes take effect on the agent's next chat-session spawn.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Save, Users } from 'lucide-react'
import { hermesApi } from '../../stores/hermesApi'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Agents.module.scss'

interface NativeTool { name: string; category: string; enabled: boolean }

export const AgentNativeTools: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [tools, setTools] = useState<NativeTool[] | null>(null)
  const [baselineOff, setBaselineOff] = useState<Set<string>>(new Set())
  const [off, setOff] = useState<Set<string>>(new Set())
  const [pluginInstalled, setPluginInstalled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void hermesApi.agentNativeTools(agentId).then((r) => {
      if (r === null) { setErr('Failed to read native-tool state — backend unreachable?'); return }
      const disabled = new Set(r.tools.filter((t) => !t.enabled).map((t) => t.name))
      setTools(r.tools)
      setOff(disabled)
      setBaselineOff(new Set(disabled))
      setPluginInstalled(r.pluginInstalled)
    })
  }, [agentId])

  const groups = useMemo(() => {
    const byCat = new Map<string, NativeTool[]>()
    for (const t of tools ?? []) {
      const list = byCat.get(t.category) ?? []
      list.push(t)
      byCat.set(t.category, list)
    }
    return [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([category, items]) => ({ category, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
  }, [tools])

  const dirty = off.size !== baselineOff.size || [...off].some((n) => !baselineOff.has(n))

  const toggle = (name: string) =>
    setOff((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next })

  const toggleCategory = (items: NativeTool[]) =>
    setOff((prev) => {
      const next = new Set(prev)
      const allOn = items.every((t) => !next.has(t.name))
      for (const t of items) { if (allOn) next.add(t.name); else next.delete(t.name) }
      return next
    })

  const save = async () => {
    setBusy(true); setMsg(''); setErr('')
    const r = await hermesApi.putAgentNativeTools(agentId, [...off])
    setBusy(false)
    if (!r.ok) { setErr(`Save failed: ${r.error ?? 'unknown'}`); return }
    setBaselineOff(new Set(off))
    setPluginInstalled(true)
    setMsg(`Saved ✓ — ${off.size} tool${off.size === 1 ? '' : 's'} off · applies on ${agentId}'s next session`)
  }

  const applyAll = async () => {
    const sure = await confirmStore.confirm({
      title: 'Apply to ALL agents',
      message: `Apply this exact native-tool set (${off.size} disabled) to EVERY agent as the global default? Each agent's own overrides are replaced.`,
      confirmText: 'Apply to all',
    })
    if (!sure) return
    setBusy(true); setMsg(''); setErr('')
    const r = await hermesApi.putGlobalNativeTools([...off])
    setBusy(false)
    if (!r.ok) { setErr(`Global apply failed: ${r.error ?? 'unknown'}`); return }
    setBaselineOff(new Set(off))
    setMsg(`Applied to all agents ✓ — takes effect as each agent's next session spawns`)
  }

  return (
    <div className={styles.card}>
      <div className={styles.summaryRow}>
        <div>
          <strong>Native (built-in) tools</strong>
          <div className={styles.dim}>
            Hermes' own tools — disabling here removes them from the agent's toolset entirely
            (the acp-tool-override plugin{pluginInstalled ? '' : ', installed on first save'}).
          </div>
        </div>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy || !tools} title="Apply this exact set to every agent (global default)" onClick={() => void applyAll()}>
          <Users size={13} /> Apply to all agents
        </button>
        <button className={styles.btnPrimary} disabled={busy || !dirty} onClick={() => void save()}>
          <Save size={13} /> {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {err && <div className={styles.formMsg} style={{ color: 'var(--danger, #f87171)' }}>{err}</div>}
      {msg && <div className={styles.formMsg} style={{ color: 'var(--accent)' }}>{msg}</div>}
      {!tools && !err && <div className={styles.dim}>Loading native-tool state…</div>}
      {groups.map((g) => {
        const onCount = g.items.filter((t) => !off.has(t.name)).length
        return (
          <div key={g.category} style={{ marginTop: 8 }}>
            <label className={styles.dim} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={onCount === g.items.length}
                ref={(el) => { if (el) el.indeterminate = onCount > 0 && onCount < g.items.length }}
                onChange={() => toggleCategory(g.items)}
                disabled={busy}
              />
              {g.category} ({onCount}/{g.items.length} on)
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 16px', marginLeft: 22 }}>
              {g.items.map((t) => (
                <label key={t.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', opacity: off.has(t.name) ? 0.55 : 1 }}>
                  <input type="checkbox" checked={!off.has(t.name)} onChange={() => toggle(t.name)} disabled={busy} />
                  <span className={styles.mono} style={{ fontSize: 11.5 }}>{t.name}</span>
                </label>
              ))}
            </div>
          </div>
        )
      })}
      <div className={styles.dim} style={{ marginTop: 8, fontSize: 11 }}>
        Changes apply on the agent's next chat-session spawn (existing sessions keep their tools).
      </div>
    </div>
  )
}
