import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, ExternalLink, Save } from 'lucide-react'
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
 * The Tool Proxy Settings strip stays native: toolInjection/maxToolRounds are
 * AI-Lab's OWN llm-proxy config (PUT /api/mcp/settings), not gateway state —
 * the dashboard has no surface for them.
 */
const DASHBOARD_URL = 'https://mcp.deeveeyant.com'

export const McpDashboardPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const [frameKey, setFrameKey] = useState(0)
  const [saved, setSaved] = useState(false)
  const save = async () => { await store.saveSettings(); setSaved(true); setTimeout(() => setSaved(false), 2000) }

  return (
    <div className={`${styles.panel} ${styles.dashPanel}`}>
      <div className={styles.head}>
        <h3 className={styles.h3}>MCP Dashboard</h3>
        <span className={`${styles.badge} ${store.connected ? styles.badgeOk : styles.badgeBad}`}>
          {store.loading ? 'checking…' : store.connected ? 'Gateway connected' : 'Gateway unreachable'}
        </span>
        <span className={styles.spacer} />
        <label className={styles.chk}>
          <input type="checkbox" checked={store.settings.toolInjection !== false} onChange={(e) => store.setSetting('toolInjection', e.target.checked)} />
          Inject tools into LLM requests
        </label>
        <label className={styles.numLbl}>
          Max tool rounds
          <input className={styles.num} type="number" min={1} max={50} value={store.settings.maxToolRounds ?? 20} onChange={(e) => store.setSetting('maxToolRounds', parseInt(e.target.value, 10) || 20)} />
        </label>
        <button className={styles.btnPrimary} onClick={() => void save()}><Save size={13} /> {saved ? 'Saved!' : 'Save'}</button>
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
