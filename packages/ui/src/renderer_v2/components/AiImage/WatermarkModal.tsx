import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { trainingImagesStore as store, type WmGpu } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

const PROMPT_KEY = 'aig-wm-prompt'
const GPUS_KEY = 'aig-wm-gpus'
const UPSCALE_KEY = 'aig-wm-upscale'
const gkey = (g: { service: string; gpu: number }) => `${g.service}#${g.gpu}`
const shortName = (n: string) => n.split('/').pop()!.replace(/\.(safetensors|gguf|pth|pt)$/i, '')

/**
 * Remove watermarks from one image (the editor's button) or the selection. Native pipeline: the Image Model
 * Service runs the Qwen Image 2.1 edit (prompt enhancer -> edit with the image as reference), the result is
 * SeedVR2-upscaled when the original is bigger, and ONLY the changed regions are pasted back onto the original,
 * so the rest keeps its full resolution. The original is kept (.prewm) - the editor's ⇄ swaps back.
 * The job runs server-side and reports to the bell; this closes as soon as it is queued.
 */
export const WatermarkModal: React.FC<{ files: string[]; onClose: () => void }> = observer(({ files, onClose }) => {
  const [info, setInfo] = useState<{ available: boolean; services: string[]; defaultPrompt: string } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [gpus, setGpus] = useState<WmGpu[]>([])
  const [picked, setPicked] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(GPUS_KEY) || '[]')) } catch { return new Set() } })
  const [upscale, setUpscale] = useState(() => { try { return localStorage.getItem(UPSCALE_KEY) !== '0' } catch { return true } })

  useEffect(() => {
    void (async () => {
      try {
        const i = await store.watermarkInfo()
        setInfo(i)
        let saved = ''
        try { saved = localStorage.getItem(PROMPT_KEY) || '' } catch { /* private window */ }
        setPrompt(saved || i.defaultPrompt)
        setGpus(await store.watermarkGpus())
      } catch (e: any) { setMsg('Could not reach the watermark tool: ' + (e?.message || e)) }
    })()
  }, [])

  const start = async () => {
    setBusy(true); setMsg('')
    try {
      try {
        if (info && prompt.trim() !== info.defaultPrompt) localStorage.setItem(PROMPT_KEY, prompt.trim())
        else localStorage.removeItem(PROMPT_KEY)
      } catch { /* private window */ }
      const targets = gpus.filter((g) => picked.has(gkey(g)) && !g.reservedBy).map((g) => ({ service: g.service, gpu: g.gpu }))
      try { localStorage.setItem(GPUS_KEY, JSON.stringify([...picked])); localStorage.setItem(UPSCALE_KEY, upscale ? '1' : '0') } catch { /* private window */ }
      const job = await store.startWatermark(files, prompt.trim(), targets, upscale)
      store.trackWatermarkJob(job.id, job.label)
      onClose()
    } catch (e: any) { setBusy(false); setMsg('Failed: ' + (e?.message || e)) }
  }

  const n = files.length
  return (
    <div className={styles.modalBg}>{/* not click-to-close: a stray backdrop click would eat the typed instruction */}
      <div className={styles.pkBox} style={{ width: 'min(560px,94%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <b>🧽 Remove watermark — {n} image{n === 1 ? '' : 's'}</b>
          <button className={styles.btn} onClick={onClose}>Close</button>
        </div>
        {info && !info.available && (
          <div className={styles.error}>
            The watermark pipeline isn't running on any Image Model Service right now, so a job would fail. It needs the
            qwen_edit plugin on the service that holds the Qwen Image 2.1 model.
          </div>
        )}
        <div className={styles.acSection}>Instruction</div>
        <textarea className={styles.input} style={{ width: '100%', minHeight: 84, resize: 'vertical' }} disabled={busy || !info}
                  value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false} />
        <div className={styles.acHint}>
          The prompt enhancer looks at each image and turns this into a specific edit (it names the mark, where it sits
          and what to fill in). Naming the watermark helps — e.g. a site name or artist signature.
          {info && prompt.trim() !== info.defaultPrompt && (
            <> <a href="#" onClick={(e) => { e.preventDefault(); setPrompt(info.defaultPrompt) }}>Reset to default</a></>
          )}
        </div>
        <div className={styles.acHint} style={{ marginTop: 6 }}>
          Only the regions the edit changed are pasted back; the rest of each image keeps its original pixels and
          resolution. The original is kept — use ⇄ in the image editor to switch back. Roughly a minute per image;
          the job keeps running if you close this, and its progress shows in the bell.
        </div>
        <div className={styles.acSection} style={{ marginTop: 8 }}>GPUs - reserve cards for this job (one stream per card)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 210, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 4 }}>
          {gpus.length === 0 && <div className={styles.acHint}>Loading the Image Model Service GPUs…</div>}
          {gpus.map((g) => {
            const k = gkey(g), on = picked.has(k), held = !!g.reservedBy
            const pins = g.models.filter((m) => m.pinned || m.plugin)
            return (
              <label key={k} className={styles.chkLine} style={{ alignItems: 'flex-start', opacity: held ? 0.5 : 1 }}
                     title={held ? `Reserved by ${g.reservedBy}` : g.models.map((m) => `${m.kind} · ${m.name}${m.pinned ? ' (pinned)' : ''}${m.plugin ? ` (${m.plugin})` : ''}`).join('\n') || 'empty'}>
                <input type="checkbox" checked={on} disabled={held || busy}
                       onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(k); else n.delete(k); return n })} />
                <span style={{ flex: 1 }}>
                  <b>{g.name}</b> <span className={styles.dim}>· {g.node} · {g.free_gb}/{g.total_gb} GB free{g.busy ? ' · busy' : ''}{held ? ` · reserved by ${g.reservedBy}` : ''}</span>
                  {g.models.length > 0 && <span className={styles.dim} style={{ display: 'block', fontSize: 11 }}>
                    on it: {g.models.map((m) => shortName(m.name)).slice(0, 4).join(', ')}{g.models.length > 4 ? ` +${g.models.length - 4}` : ''}
                    {pins.length > 0 && ` · 📌 ${pins.length} pinned/locked - unloaded too, restored after`}</span>}
                </span>
              </label>
            )
          })}
        </div>
        <div className={styles.acHint}>
          {picked.size
            ? `${[...picked].filter((k) => gpus.some((g) => gkey(g) === k && !g.reservedBy)).length} GPU(s) reserved → that many images at once. Everything else on them (pinned models too) is unloaded for the job and reloaded afterwards, pinned first; models the job uses stay put.`
            : 'No GPU picked: automatic routing (the job uses whichever card holds the model or has the most room, and touches nothing else).'}
        </div>
        <label className={styles.chkLine} style={{ marginTop: 6 }}>
          <input type="checkbox" checked={upscale} disabled={busy} onChange={(e) => setUpscale(e.target.checked)} />
          <span>Restore detail with SeedVR2 <span className={styles.dim}>- the edit comes back at ~1 MP; on bigger originals SeedVR2 upscales it before the repaired areas are pasted back (on the same reserved card)</span></span>
        </label>
        <div className={styles.msg}>{msg}</div>
        <div className={styles.pkFoot}>
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} disabled={busy || !info || !prompt.trim() || !n} onClick={() => void start()}>
            {busy ? 'Starting…' : `Remove watermark${n === 1 ? '' : ` from ${n} images`}`}
          </button>
        </div>
      </div>
    </div>
  )
})
