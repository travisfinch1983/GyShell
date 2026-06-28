import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { Rocket, Server, Loader2 } from 'lucide-react'
import type { ServiceLaunchStore } from '../../stores/ServiceLaunchStore'
import styles from './ServiceLaunch.module.scss'

/** Per-provider launch cards for the simple service launchers (TTS / Imagegen). */
export const ServiceLaunchPanel: React.FC<{ store: ServiceLaunchStore; emptyLabel: string }> = observer(({ store, emptyLabel }) => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])

  const installed = store.installedProviders

  return (
    <div className={styles.panel}>
      {store.loading && <div className={styles.muted}>Loading providers…</div>}
      {store.err && <div className={styles.error}>{store.err}</div>}
      {store.msg && <div className={styles.ok}>{store.msg}</div>}
      {store.loaded && installed.length === 0 && (
        <div className={styles.muted}>No {emptyLabel} providers are installed yet. Install one from the Provider Install tab.</div>
      )}

      {installed.map((p) => {
        const c = store.cards[p.id]
        if (!c) return null
        const t = store.templates[p.id] || {}
        const nodes = store.installedNodes(p)
        const gpus = store.gpusForNode(c.node)
        const busy = store.busy === p.id
        return (
          <section key={p.id} className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.name}>{p.name}</span>
              <select className={styles.select} value={c.node} onChange={(e) => store.set(p.id, { node: e.target.value, gpu: 'auto' })}>
                {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>

            <textarea className={styles.command} readOnly rows={Math.min(8, Math.max(2, store.command(p.id).split('\n').length))} value={store.command(p.id)} />

            <div className={styles.row}>
              <label className={styles.lbl}>GPU</label>
              <select className={styles.select} value={c.gpu} onChange={(e) => store.set(p.id, { gpu: e.target.value })}>
                <option value="auto">Auto (default)</option>
                {gpus.map((g) => <option key={g.pciId} value={g.pciId}>{g.label}</option>)}
              </select>

              {Array.isArray(t.models) && t.models.length > 0 && (
                <>
                  <label className={styles.lbl}>Model</label>
                  <select className={styles.select} value={c.model ?? ''} onChange={(e) => store.set(p.id, { model: e.target.value })}>
                    {t.models.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </>
              )}

              {Array.isArray(t.backends) && t.backends.length > 0 && (
                <>
                  <label className={styles.lbl}>Backend</label>
                  <select className={styles.select} value={c.backend ?? ''} onChange={(e) => store.set(p.id, { backend: e.target.value })}>
                    {t.backends.map((b: any) => <option key={b.id} value={b.id}>{b.label}</option>)}
                  </select>
                </>
              )}

              <label className={styles.lbl}>Port</label>
              <input className={styles.port} type="number" min={1024} max={65535} value={c.port} onChange={(e) => store.set(p.id, { port: parseInt(e.target.value, 10) || 0 })} />

              <span className={styles.spacer} />
              <button className={styles.launchBtn} disabled={busy} onClick={() => void store.launch(p.id)}>
                {busy ? <Loader2 size={13} className={styles.spin} /> : <Rocket size={13} />} Launch
              </button>
              <button className={styles.serviceBtn} disabled={busy} onClick={() => void store.launchAsService(p.id)}>
                <Server size={13} /> Service
              </button>
            </div>
          </section>
        )
      })}
    </div>
  )
})
