import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Loader2, Download, Trash2, ArrowUpCircle, ExternalLink, CheckCircle2, Circle } from 'lucide-react'
import { aiProvidersStore as store, type Provider } from '../../stores/AiProvidersStore'
import { liveConsoleStore } from '../../stores/LiveConsoleStore'
import styles from './AiModality.module.scss'

const CAT_LABEL: Record<string, string> = {
  llm: 'LLM Engines', tts: 'TTS / STT', stt: 'STT', image: 'Image Generation', training: 'LoRA Training', tools: 'Tools',
}
const COMPLEXITY_COLOR: Record<string, string> = { easy: 'var(--success)', medium: '#e0a832', complex: 'var(--danger)' }

const ProviderCard: React.FC<{ p: Provider }> = observer(({ p }) => {
  const [extras, setExtras] = useState<Set<string>>(new Set())
  const [models, setModels] = useState<Set<string>>(new Set())
  const nodes = Object.keys(p.agents ?? {})
  const anyInstalled = nodes.some((n) => p.agents?.[n]?.installed)

  const doInstall = async (node: string, isUpdate = false) => {
    const r = isUpdate
      ? await store.prepareUpdate(p.id, node)
      : await store.prepareInstall(p.id, node, [...extras], [...models])
    if (!r) return
    // Run in the Live Console (focuses that tab); no popup terminal.
    liveConsoleStore.openInstall(`${isUpdate ? 'update' : 'install'} ${p.id} on ${node}`, r.pveHostIp, `pct exec ${r.vmid} -- ${r.command}`)
  }

  return (
    <div className={styles.provCard}>
      <div className={styles.provHead}>
        <span className={styles.provName}>{p.name}</span>
        {p.complexity && <span className={styles.provComplexity} style={{ color: COMPLEXITY_COLOR[p.complexity] || 'var(--fg-muted)' }}>{p.complexity}</span>}
        {p.defaultPort ? <span className={styles.provPort}>:{p.defaultPort}</span> : null}
        <div className={styles.spacer} />
        {p.website && <a className={styles.provLink} href={p.website} target="_blank" rel="noreferrer"><ExternalLink size={12} /></a>}
        <button className={styles.iconBtnSm} title="Refresh status" disabled={store.busyId === `${p.id}:status`} onClick={() => void store.refreshStatus(p.id)}>
          {store.busyId === `${p.id}:status` ? <Loader2 size={12} className={styles.spin} /> : <RefreshCw size={12} />}
        </button>
        <button className={styles.linkBtn} disabled={store.busyId === `${p.id}:update`} onClick={() => void store.checkUpdate(p.id)}>check updates</button>
      </div>
      {p.description && <div className={styles.provDesc}>{p.description}</div>}

      {/* optional extras / models (only meaningful before install) */}
      {!anyInstalled && (p.installExtras?.length || p.installModels?.length) ? (
        <div className={styles.provOpts}>
          {p.installExtras?.map((x) => (
            <label key={x.id} className={styles.optChk}><input type="checkbox" checked={extras.has(x.id)} onChange={() => setExtras((s) => { const n = new Set(s); n.has(x.id) ? n.delete(x.id) : n.add(x.id); return n })} /> {x.label}{x.size ? ` (${x.size})` : ''}</label>
          ))}
          {p.installModels?.map((m) => (
            <label key={m.id} className={styles.optChk}><input type="checkbox" checked={models.has(m.id)} onChange={() => setModels((s) => { const n = new Set(s); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n })} /> model: {m.label}{m.size ? ` (${m.size})` : ''}</label>
          ))}
        </div>
      ) : null}

      <div className={styles.provNodes}>
        {nodes.length === 0 && <span className={styles.note}>No agent nodes available.</span>}
        {nodes.map((node) => {
          const a = p.agents![node]
          const busy = store.busyId === `${p.id}:${node}`
          return (
            <div key={node} className={styles.nodeRow}>
              {a?.installed ? <CheckCircle2 size={13} className={styles.okIcon} /> : <Circle size={13} className={styles.offIcon} />}
              <span className={styles.nodeName}>{node}</span>
              {a?.installed && a.version && <span className={styles.nodeVer}>{String(a.version).startsWith('$') ? 'installed' : a.version}</span>}
              {a?.updateAvailable && <span className={styles.updBadge}>update {a.updateAvailable}</span>}
              <div className={styles.spacer} />
              {a?.updateAvailable && <button className={styles.btnSm} onClick={() => void doInstall(node, true)}><ArrowUpCircle size={12} /> Update</button>}
              {a?.installed ? (
                <button className={`${styles.btnSm} ${styles.danger}`} disabled={busy} onClick={() => void store.uninstall(p.id, node)}>{busy ? <Loader2 size={12} className={styles.spin} /> : <Trash2 size={12} />} Uninstall</button>
              ) : (
                <button className={styles.btnSmPrimary} onClick={() => void doInstall(node)}><Download size={12} /> Install</button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

export const ProviderInstall: React.FC<{ categories: string[] }> = observer(({ categories }) => {
  useEffect(() => {
    void (async () => {
      if (!store.providers.length) await store.load()
      // Reflect reality, not stale ai-config: live-verify the providers shown in this tab.
      void store.liveVerify(store.byCategory(categories).map((p) => p.id))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.join(',')])

  const providers = store.byCategory(categories)
  // group by category when the tab spans more than one (e.g. image + training)
  const groups = categories.map((c) => ({ cat: c, items: providers.filter((p) => p.category === c) })).filter((g) => g.items.length)

  return (
    <div className={styles.provWrap}>
      <div className={styles.provBar}>
        <span className={styles.provCount}>{providers.length} providers</span>
        <div className={styles.spacer} />
        <button className={styles.btnSm} disabled={store.loading} onClick={() => void store.load()}>{store.loading ? <Loader2 size={13} className={styles.spin} /> : <RefreshCw size={13} />} Refresh</button>
      </div>
      {store.error && <div className={styles.errorBar}>{store.error}</div>}
      {groups.map((g) => (
        <div key={g.cat} className={styles.provGroup}>
          {groups.length > 1 && <div className={styles.groupLabel}>{CAT_LABEL[g.cat] || g.cat}</div>}
          {g.items.map((p) => <ProviderCard key={p.id} p={p} />)}
        </div>
      ))}
      {providers.length === 0 && !store.loading && <div className={styles.empty}>No providers in this category.</div>}
    </div>
  )
})
