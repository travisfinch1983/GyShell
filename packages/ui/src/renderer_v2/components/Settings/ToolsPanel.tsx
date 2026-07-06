/**
 * Settings › Tools — config-federation control surface, two sub-tabs + approval.
 *
 * • "Quick Toggle": native grouped accordion over GET /api/mcp/tree — one row
 *   per gateway server (master toggle, scope:"server") expanding to per-tool
 *   toggles (scope:"tool", full `server__tool` name). The agent's built-ins
 *   ride along as the `ailab-native` server. Optimistic flips; refetch on error.
 * • "Gateway": the MCPJungle webui embed for detailed edits, scale-fitted so
 *   its fixed min-width doesn't force a horizontal scrollbar.
 * • Below both: the approval-behavior rows for the prompting built-ins —
 *   the ORTHOGONAL axis (how a call is confirmed, not whether the tool
 *   exists), driving settings.tools.builtInPermissions only.
 */
import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, ExternalLink } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { McpToolTree, useMcpTree } from '../Common/McpToolTree'
import './ToolsPanel.scss'

function bridge(): any { return (window as any).gyshell?.cluster }

const MCP_GATEWAY_URL = 'https://mcp.deeveeyant.com'
/** Only the webui's own Tools tab (a wide table) overflows; we can't target it
 *  inside the iframe, so scale the whole page — but keep k near 0.9 so the
 *  tabs that already fit don't visibly shrink. */
const GATEWAY_SCALE = 0.9

const QuickTogglePanel: React.FC = () => {
  const { servers, setServers, loading, err, setErr, reload } = useMcpTree()

  const toggle = async (scope: 'server' | 'tool', name: string, enabled: boolean) => {
    // optimistic flip; the tree refetch on failure restores gateway truth
    setServers((prev) => prev.map((s) => {
      if (scope === 'server') return s.name === name ? { ...s, enabled } : s
      if (!s.tools.some((t) => t.name === name)) return s
      const tools = s.tools.map((t) => (t.name === name ? { ...t, enabled } : t))
      return { ...s, tools, enabledCount: tools.filter((t) => t.enabled).length }
    }))
    try {
      const r = await bridge().request('POST', '/api/mcp/toggle', { scope, name, enabled })
      if (r?.error) throw new Error(String(r.error))
    } catch (e: any) {
      setErr(`Toggle failed: ${e?.message || e}`)
      void reload()
    }
  }

  return (
    <div className="tools-quick">
      {err && <div className="settings-error" style={{ marginBottom: 8 }}>{err}</div>}
      <McpToolTree
        servers={servers}
        emptyLabel={loading ? 'Loading the gateway tool tree…' : 'No servers registered on the gateway.'}
        serverControl={(s) => (
          <label className="switch" title={`${s.enabled ? 'Disable' : 'Enable'} the whole ${s.name} server`}>
            <input type="checkbox" checked={s.enabled} onChange={(e) => void toggle('server', s.name, e.target.checked)} />
            <span className="switch-slider" />
          </label>
        )}
        toolControl={(tool) => (
          <label className="switch">
            <input type="checkbox" checked={tool.enabled} onChange={(e) => void toggle('tool', tool.name, e.target.checked)} />
            <span className="switch-slider" />
          </label>
        )}
      />
    </div>
  )
}

const GatewayEmbed: React.FC<{ frameKey: number }> = ({ frameKey }) => (
  <div className="tools-gw-wrap">
    {/* scale-to-fit: MCPJungle has a fixed min-width; shrink the whole page so
        nothing overflows horizontally (wrapper clips, iframe over-sizes by 1/k) */}
    <iframe
      key={frameKey}
      src={MCP_GATEWAY_URL}
      title="MCP Gateway"
      style={{
        width: `${100 / GATEWAY_SCALE}%`,
        height: `${100 / GATEWAY_SCALE}%`,
        transform: `scale(${GATEWAY_SCALE})`,
        transformOrigin: 'top left',
        border: 'none',
      }}
    />
  </div>
)

/** The ~8 built-ins whose default permission is not always-allow (backend
 *  DEFAULT_BUILT_IN_TOOL_PERMISSIONS) — the only ones where approval behavior
 *  is a live decision. */
const PROMPTING_TOOLS = [
  'exec_command',
  'write_stdin',
  'create_or_edit',
  'exec_headless',
  'memory_save',
  'memory_create_collection',
  'memory_delete',
  'create_skill',
]

const ApprovalSection: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const rows = PROMPTING_TOOLS
    .map((name) => store.builtInTools.find((t) => t.name === name))
    .filter((t): t is NonNullable<typeof t> => !!t)
  return (
    <>
      <div className="settings-section-header" style={{ marginTop: 24 }}>
        <div className="settings-section-title">Approval behavior</div>
      </div>
      <p className="tools-caption">
        How the agent's prompting built-in tools ask before running — the approval axis, independent of the
        enable/disable state above (that lives on the gateway). Read-only tools never prompt and aren't listed.
      </p>
      <div className="settings-rows">
        {rows.map((tool) => {
          const perm = (tool as any).permission || 'always-ask'
          return (
            <div key={tool.name} className="settings-row">
              <div className="settings-row-label-with-info">
                <label title={tool.description || tool.name}>{tool.name}</label>
              </div>
              <select
                className="tools-perm-select"
                value={perm}
                onChange={(e) => void store.setBuiltInToolPermission(tool.name, e.target.value as any)}
                title={
                  perm === 'always-allow' ? 'Runs without ever prompting' :
                  perm === 'ask-once-session' ? 'Prompts on first use each session, then auto-allows' :
                  perm === 'always-ask' ? 'Prompts for approval on every call' :
                  'Legacy disabled state — pick a level (enable/disable now lives on the gateway)'
                }
              >
                <option value="always-allow">Always Allow</option>
                <option value="ask-once-session">Ask Once / Session</option>
                <option value="always-ask">Always Ask</option>
                {perm === 'disabled' && <option value="disabled">Disabled (legacy)</option>}
              </select>
            </div>
          )
        })}
        {rows.length === 0 && <div className="tool-empty">Built-in tool list not loaded yet.</div>}
      </div>
    </>
  )
})

export const ToolsPanel: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const [tab, setTab] = useState<'quick' | 'gateway'>('quick')
  const [frameKey, setFrameKey] = useState(0)
  const [treeKey, setTreeKey] = useState(0)

  return (
    <>
      <div className="settings-section-header">
        <div className="settings-section-title">Tools — MCP Gateway</div>
        <div className="settings-actions">
          <div className="tools-subtabs">
            <button className={`tools-subtab ${tab === 'quick' ? 'tools-subtab-active' : ''}`} onClick={() => setTab('quick')}>Quick Toggle</button>
            <button className={`tools-subtab ${tab === 'gateway' ? 'tools-subtab-active' : ''}`} onClick={() => setTab('gateway')}>Gateway</button>
          </div>
          <button
            className="btn-icon-reload"
            onClick={() => (tab === 'gateway' ? setFrameKey((k) => k + 1) : setTreeKey((k) => k + 1))}
            title={tab === 'gateway' ? 'Reload the gateway webui' : 'Refetch the tool tree'}
          >
            <RefreshCw size={14} />
          </button>
          <a className="btn-secondary" href={MCP_GATEWAY_URL} target="_blank" rel="noreferrer" title="Open the gateway webui in a new tab">
            <ExternalLink size={14} />
          </a>
        </div>
      </div>
      <p className="tools-caption">
        One surface for every tool — MCP servers <em>and</em> the agent's built-ins (the <code>ailab-native</code> server).
        Quick Toggle flips tools globally on the gateway (takes effect within ~30s); the Gateway tab is the full webui
        for registration and details. Proxy injection settings live in Settings › Proxy.
      </p>
      {tab === 'quick' ? <QuickTogglePanel key={treeKey} /> : <GatewayEmbed frameKey={frameKey} />}
      <ApprovalSection store={store} />
    </>
  )
})
