import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { Rocket, Server, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import type { ServiceLaunchStore } from '../../stores/ServiceLaunchStore'
import styles from './ServiceLaunch.module.scss'

const TTS_NOTES: Record<string, string> = {
  'tts-webui': 'Patches config.json for 0.0.0.0 binding. Gradio UI on this port, React UI on :3000.',
  alltalk: 'V2 — API on this port, Gradio settings UI on port+1. Patches confignew.json.',
}

/** Collapsible config workspace for CLI training tools (no web UI). */
const TrainWorkspace: React.FC<{ store: ServiceLaunchStore; providerId: string }> = observer(({ store, providerId }) => {
  const open = !!store.trainOpen[providerId]
  const tpls = store.trainTemplates[providerId] || []
  const status = store.trainStatus[providerId]
  const c = store.cards[providerId]
  return (
    <div className={styles.train}>
      <button className={styles.trainToggle} onClick={() => store.toggleTrainWorkspace(providerId)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Configure Training
      </button>
      {open && (
        <div className={styles.trainBody}>
          <div className={styles.row}>
            <label className={styles.lbl}>Template</label>
            <select className={styles.select} value={store.trainSelTemplate[providerId] ?? ''} onChange={(e) => store.setTrainSelTemplate(providerId, e.target.value)}>
              <option value="">{tpls.length ? 'Select a template…' : 'No templates'}</option>
              {tpls.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className={styles.smBtn} disabled={!store.trainSelTemplate[providerId]} onClick={() => void store.loadTrainConfig(providerId)}>Load</button>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl}>Config Name</label>
            <input className={styles.grow} placeholder="my-training-run" value={c?.configName ?? ''} onChange={(e) => store.set(providerId, { configName: e.target.value })} />
          </div>
          <textarea className={styles.editor} rows={16} spellCheck={false} placeholder="Load a template or paste config here…" value={store.trainEditor[providerId] ?? ''} onChange={(e) => store.setTrainEditor(providerId, e.target.value)} />
          <div className={styles.row}>
            <button className={styles.smBtn} onClick={() => void store.saveTrainConfig(providerId)}>Save Config</button>
            <button className={styles.startBtn} disabled={store.busy === providerId} onClick={() => void store.startTraining(providerId)}>Start Training</button>
            {status && <span className={status.ok ? styles.ok : styles.error}>{status.msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
})

/** Per-provider launch cards for the simple service launchers (TTS / Imagegen / Training). */
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
        const cli = store.isCli(p.id)
        const multi = store.isMultiGpu(p.id)
        const note = store.category === 'tts' ? TTS_NOTES[p.id] : undefined
        const showTrain = store.category === 'training' && cli
        return (
          <section key={p.id} className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.name}>{p.name}</span>
              {cli && <span className={styles.cliTag}>CLI only</span>}
              <select className={styles.select} value={c.node} onChange={(e) => store.set(p.id, { node: e.target.value, gpus: [] })}>
                {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>

            <textarea className={styles.command} readOnly rows={Math.min(8, Math.max(2, store.command(p.id).split('\n').length))} value={store.command(p.id)} />
            {note && <div className={styles.note}>{note}</div>}

            <div className={styles.row}>
              <label className={styles.lbl}>{multi ? 'GPUs' : 'GPU'}</label>
              {multi ? (
                <div className={styles.gpuChips}>
                  {gpus.length === 0 && <span className={styles.muted}>none on this node</span>}
                  {gpus.map((g) => (
                    <button key={g.pciId} className={`${styles.gpuChip} ${store.isGpuSelected(p.id, g.pciId) ? styles.gpuChipSel : ''}`} onClick={() => store.toggleGpu(p.id, g.pciId)}>{g.label}</button>
                  ))}
                </div>
              ) : (
                <select className={styles.select} value={c.gpus[0] ?? 'auto'} onChange={(e) => store.setGpu(p.id, e.target.value)}>
                  <option value="auto">Auto (default)</option>
                  {gpus.map((g) => <option key={g.pciId} value={g.pciId}>{g.label}</option>)}
                </select>
              )}

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

              {!cli && (
                <>
                  <label className={styles.lbl}>Port</label>
                  <input className={styles.port} type="number" min={1024} max={65535} value={c.port} onChange={(e) => store.set(p.id, { port: parseInt(e.target.value, 10) || 0 })} />
                </>
              )}

              <span className={styles.spacer} />
              <button className={styles.launchBtn} disabled={busy} onClick={() => void store.launch(p.id)}>
                {busy ? <Loader2 size={13} className={styles.spin} /> : <Rocket size={13} />} Launch
              </button>
              {!cli && (
                <button className={styles.serviceBtn} disabled={busy} onClick={() => void store.launchAsService(p.id)}>
                  <Server size={13} /> Service
                </button>
              )}
            </div>

            {showTrain && <TrainWorkspace store={store} providerId={p.id} />}
          </section>
        )
      })}
    </div>
  )
})
