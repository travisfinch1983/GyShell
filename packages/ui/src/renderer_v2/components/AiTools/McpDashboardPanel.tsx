import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, ExternalLink } from 'lucide-react'
import { mcpServersStore as store } from '../../stores/McpServersStore'
import styles from './AiTools.module.scss'

/**
 * McpDashboardPanel — embeds the MCPJungle Dashboard (NPM → CT152:8080) and
 * replaces the hand-rolled McpServersPanel server/tool mirror. Server
 * registration and per-tool enable/disable now happen IN the dashboard.
 *
 * The embed is https via NPM (`mcp.deeveeyant.com`, wildcard cert, internal
 * DNS) — same-scheme as the AI-Lab origin, so no mixed content; the browser
 * still never talks to a 10.0.0.x address directly.
 *
 * The Tool Proxy Settings (maxToolRounds — AI-Lab's OWN llm-proxy config the
 * dashboard can't manage) live in Settings › Proxy. (toolInjection was removed
 * 2026-08-31 with the dead code it switched.)
 */
const DASHBOARD_URL = 'https://mcp.deeveeyant.com'

export const McpDashboardPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const [frameKey, setFrameKey] = useState(0)

  return (
    <div className={`${styles.panel} ${styles.dashPanel}`}>
      <div className={styles.head}>
        <h3 className={styles.h3}>MCP Dashboard</h3>
        <span className={`${styles.badge} ${store.connected ? styles.badgeOk : styles.badgeBad}`}>
          {store.loading ? 'checking…' : store.connected ? 'Gateway connected' : 'Gateway unreachable'}
        </span>
        <span className={styles.spacer} />
        <button className={styles.btn} title="Reload dashboard" onClick={() => { setFrameKey((k) => k + 1); void store.load() }}>
          <RefreshCw size={13} />
        </button>
        <a className={styles.btn} href={DASHBOARD_URL} target="_blank" rel="noreferrer" title="Open in a new tab">
          <ExternalLink size={13} />
        </a>
      </div>
      <iframe key={frameKey} className={styles.dashFrame} src={DASHBOARD_URL} title="MCPJungle Dashboard" />
    </div>
  )
})
