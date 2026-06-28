import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { Box, Loader2 } from 'lucide-react'
import { quantizationStore as store } from '../../stores/QuantizationStore'
import styles from './Quantization.module.scss'

/** Quantization scripts — one card per tool (GGUF / AWQ / GPTQ / EXL2 / EXL3). */
export const QuantizationPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  return (
    <div className={styles.panel}>
      {store.err && <div className={styles.error}>{store.err}</div>}
      {store.msg && <div className={styles.ok}>{store.msg}</div>}
      {store.tools.map((t) => {
        const s = store.state[t.id]
        const gpus = store.gpusForNode(t.node)
        const busy = store.busy === t.id
        return (
          <section key={t.id} className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.name}>{t.name}</span>
              <span className={styles.desc}>{t.description}</span>
              <span className={styles.spacer} />
              <span className={styles.node}>{t.node}</span>
            </div>

            <label className={styles.field}>
              <span className={styles.lbl}>Input Model</span>
              <input className={styles.input} value={s.modelPath} placeholder="/models/Family/Variant/FP16-Safetensors" spellCheck={false} onChange={(e) => store.set(t.id, { modelPath: e.target.value })} />
            </label>
            <label className={styles.field}>
              <span className={styles.lbl}>Output Dir</span>
              <input className={styles.input} value={s.outputPath} placeholder="/models/Family/Variant/Q4_K_M" spellCheck={false} onChange={(e) => store.set(t.id, { outputPath: e.target.value })} />
            </label>

            <div className={styles.row}>
              <label className={styles.lbl}>Quant</label>
              <select className={styles.select} value={s.quantType} onChange={(e) => store.set(t.id, { quantType: e.target.value })}>
                {t.quants.map((q: string) => <option key={q} value={q}>{q}</option>)}
              </select>
              <label className={styles.lbl}>GPU</label>
              <select className={styles.select} value={s.gpu} onChange={(e) => store.set(t.id, { gpu: e.target.value })}>
                <option value="auto">Auto</option>
                {gpus.map((g) => <option key={g.pciId} value={g.pciId}>{g.label}</option>)}
              </select>
              <span className={styles.spacer} />
              <button className={styles.runBtn} disabled={busy} onClick={() => void store.run(t.id)}>
                {busy ? <Loader2 size={13} className={styles.spin} /> : <Box size={13} />} Quantize
              </button>
            </div>

            <textarea className={styles.command} readOnly rows={Math.min(10, Math.max(3, store.command(t.id).split('\n').length))} value={store.command(t.id)} />
          </section>
        )
      })}
    </div>
  )
})
