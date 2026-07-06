/**
 * McpToolTree — shared server→tools accordion over the gateway's grouped tree
 * (GET /api/mcp/tree). Presentation + expansion only; each consumer injects
 * its own right-side controls and write target:
 *
 *   • Settings›Tools "Quick Toggle": switches driving the GLOBAL gateway
 *     enable state (POST /api/mcp/toggle).
 *   • Agents›Tools per-agent picker (planned): selection checkboxes + group
 *     sync, with `toolClassName` painting globally-disabled-but-selected
 *     tools red (the tree's `enabled` flags stay global truth).
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import './mcpToolTree.scss'

function bridge(): any { return (window as any).gyshell?.cluster }

export interface McpTreeTool { name: string; shortName: string; enabled: boolean; description: string }
export interface McpTreeServer {
  name: string
  description: string
  enabled: boolean
  sessionMode: string
  transport: string
  toolCount: number
  enabledCount: number
  tools: McpTreeTool[]
}

/** Fetch + hold the gateway tree. `setServers` is exposed so consumers can
 *  apply optimistic mutations; `reload` restores gateway truth. */
export function useMcpTree() {
  const [servers, setServers] = useState<McpTreeServer[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const r = await bridge().request('GET', '/api/mcp/tree')
      if (r?.error) throw new Error(String(r.error))
      setServers(Array.isArray(r?.servers) ? r.servers : [])
      setErr('')
    } catch (e: any) {
      setErr(e?.message || 'Failed to load the gateway tool tree')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { servers, setServers, loading, err, setErr, reload }
}

export interface McpToolTreeProps {
  servers: McpTreeServer[]
  /** Right-side control on a server row (switch, checkbox, …). */
  serverControl?: (s: McpTreeServer) => React.ReactNode
  /** Right-side control on a tool row. */
  toolControl?: (t: McpTreeTool, s: McpTreeServer) => React.ReactNode
  /** Replaces the default enabledCount/toolCount badge. */
  serverBadge?: (s: McpTreeServer) => React.ReactNode
  /** Extra class per tool row — e.g. a red overlay for selected-but-globally-disabled. */
  toolClassName?: (t: McpTreeTool, s: McpTreeServer) => string
  /** Dim rows whose global `enabled` is false (default true — turn off when
   *  the consumer's axis isn't the global one). */
  dimDisabled?: boolean
  emptyLabel?: string
}

export const McpToolTree: React.FC<McpToolTreeProps> = ({
  servers,
  serverControl,
  toolControl,
  serverBadge,
  toolClassName,
  dimDisabled = true,
  emptyLabel = 'No servers registered on the gateway.',
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  if (servers.length === 0) return <div className="mcptree-empty">{emptyLabel}</div>
  return (
    <div className="mcptree">
      {servers.map((s) => {
        const open = expanded.has(s.name)
        return (
          <div key={s.name} className={`mcptree-server ${dimDisabled && !s.enabled ? 'mcptree-server-off' : ''}`}>
            <div className="mcptree-server-row">
              <button
                className={`mcptree-chevron ${open ? 'mcptree-chevron-open' : ''}`}
                title={open ? 'Collapse' : 'Expand tools'}
                onClick={() => setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(s.name)) next.delete(s.name); else next.add(s.name)
                  return next
                })}
              >
                <ChevronRight size={14} />
              </button>
              <div className="mcptree-server-info">
                <span className="mcptree-server-name">{s.name}</span>
                {s.description && <span className="mcptree-server-desc" title={s.description}>{s.description}</span>}
              </div>
              {serverBadge ? serverBadge(s) : (
                <span className="mcptree-count" title={`${s.enabledCount} of ${s.toolCount} tools enabled`}>
                  {s.enabledCount}/{s.toolCount}
                </span>
              )}
              {serverControl?.(s)}
            </div>
            {open && (
              <div className="mcptree-tool-list">
                {s.tools.map((tool) => (
                  <div
                    key={tool.name}
                    className={`mcptree-tool-row ${dimDisabled && !tool.enabled ? 'mcptree-tool-off' : ''} ${toolClassName?.(tool, s) ?? ''}`}
                  >
                    <span className="mcptree-tool-name" title={tool.description || tool.name}>{tool.shortName}</span>
                    {toolControl?.(tool, s)}
                  </div>
                ))}
                {s.tools.length === 0 && <div className="mcptree-empty">No tools reported for this server.</div>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
