import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { trainingImagesStore as store } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

const PROMPT_KEY = 'aig-wm-prompt'

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

  useEffect(() => {
    void (async () => {
      try {
        const i = await store.watermarkInfo()
        setInfo(i)
        let saved = ''
        try { saved = localStorage.getItem(PROMPT_KEY) || '' } catch { /* private window */ }
        setPrompt(saved || i.defaultPrompt)
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
      const job = await store.startWatermark(files, prompt.trim())
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
