import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2 } from 'lucide-react'
import { mcpServersStore as store } from '../../stores/McpServersStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './AiTools.module.scss'

export const McpServersPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3 className={styles.h3}>MCP Gateway</h3>
        <span className={`${styles.badge} ${store.connected ? styles.badgeOk : styles.badgeBad}`}>
          {store.loading ? 'checking…' : store.connected ? 'Connected' : 'Unreachable'}
        </span>
        <span className={styles.spacer} />
        <button className={styles.btn} onClick={() => void store.load()} disabled={store.loading}>
          <RefreshCw size={13} className={store.loading ? styles.spin : ''} /> Refresh
        </button>
      </div>

      {/* err was declared in the store and rendered nowhere — the one signal
          that could distinguish "no servers" from "the load failed" was
          invisible. It renders first, above everything it explains. */}
      {store.err && <div className={styles.errBanner}>⚠ {store.err}</div>}

      {/* Servers */}
      <div className={styles.serverList}>
        {store.servers.length === 0 && (
          <div className={styles.muted}>
            {!store.loaded ? 'Loading…' : store.err ? 'Server list unavailable (see error above) — this does NOT mean none are registered.' : 'No MCP servers registered'}
          </div>
        )}
        {store.servers.map((s) => {
          const tc = store.toolCount(s.name)
          return (
            <div key={s.name} className={styles.serverCard}>
              <div className={styles.serverHead}>
                <div className={styles.serverNameWrap}>
                  <span className={styles.serverName}>{s.name}</span>
                  <span className={styles.transport}>{s.transport || 'http'}</span>
                </div>
                <div className={styles.serverActions}>
                  <span className={styles.toolCount}>{tc.enabled}/{tc.total} tools</span>
                  <button className={styles.iconDanger} title="Remove server" onClick={async () => { if (await confirmStore.confirm({ title: 'Remove MCP server', message: `Remove MCP server “${s.name}”? This removes all its tools.`, confirmText: 'Remove' })) void store.deleteServer(s.name) }}><Trash2 size={13} /></button>
                </div>
              </div>
              {s.description && <div className={styles.serverDesc}>{s.description}</div>}
              {s.command && <div className={styles.detail}><strong>Command:</strong> {s.command}</div>}
              {s.url && <div className={styles.detail}><strong>URL:</strong> {s.url}</div>}
            </div>
          )
        })}
      </div>

      {/* Tool proxy settings */}
      {/* "Tool Proxy Settings" box REMOVED entirely (2026-08-31). Both knobs
          (toolInjection toggle, maxToolRounds number input) were false
          instruments wired to deleted dead code — and an empty settings box
          invites the next person to fill it. Server registration and per-tool
          enable/disable above are the live controls; /api/mcp/settings serves
          {} so a stale UI bundle degrades gracefully. */}

      {/* Tools grouped by server */}
      <div className={styles.toolsSection}>
        <h4 className={styles.h4}>Tools</h4>
        {store.tools.length === 0 && <div className={styles.muted}>No tools available</div>}
        {Object.entries(store.toolsByServer).map(([server, tools]) => (
          <div key={server} className={styles.toolGroup}>
            <div className={styles.toolGroupLabel}>{server}</div>
            <div className={styles.toolGrid}>
              {tools.map((t) => (
                <label key={t.fullName} className={`${styles.toolItem} ${t.enabled ? '' : styles.toolDisabled}`}>
                  <input type="checkbox" checked={!!t.enabled} onChange={(e) => void store.toggleTool(t.fullName, e.target.checked)} />
                  <span className={styles.toolName}>{t.tool}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})
