import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, Save } from 'lucide-react'
import { mcpServersStore as store } from '../../stores/McpServersStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './AiTools.module.scss'

export const McpServersPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const [saved, setSaved] = React.useState(false)
  const save = async () => { await store.saveSettings(); setSaved(true); setTimeout(() => setSaved(false), 2000) }

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

      {/* Servers */}
      <div className={styles.serverList}>
        {store.servers.length === 0 && <div className={styles.muted}>{store.loaded ? 'No MCP servers registered' : 'Loading…'}</div>}
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
      <div className={styles.settingsBox}>
        <h4 className={styles.h4}>Tool Proxy Settings</h4>
        <div className={styles.settingsRow}>
          <label className={styles.chk}>
            <input type="checkbox" checked={store.settings.toolInjection !== false} onChange={(e) => store.setSetting('toolInjection', e.target.checked)} />
            Inject tools into LLM requests
          </label>
          <label className={styles.numLbl}>
            Max tool rounds
            <input className={styles.num} type="number" min={1} max={50} value={store.settings.maxToolRounds ?? 20} onChange={(e) => store.setSetting('maxToolRounds', parseInt(e.target.value, 10) || 20)} />
          </label>
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} onClick={() => void save()}><Save size={13} /> {saved ? 'Saved!' : 'Save'}</button>
        </div>
      </div>

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
