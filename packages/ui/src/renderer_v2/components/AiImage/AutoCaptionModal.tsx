import React, { useEffect, useRef, useState } from 'react'
import { trainingImagesStore as store } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

/** What each model actually produces, in the words someone picking one needs.
 *  The list previously showed bare ids (`wd-eva02-large-tagger-v3`, `joytag`) with nothing
 *  saying what they do or even whether the output was booru tags or a sentence — which is the
 *  one thing that decides which trainer can use the result. */
const MODEL_NOTES: Record<string, string> = {
  'wd-vit-tagger-v3': 'Balanced and fast. Good default for SDXL / Illustrious / Pony sets.',
  'wd-swinv2-tagger-v3': 'Balanced alternative to ViT — sometimes catches different tags.',
  'wd-convnext-tagger-v3': 'Balanced alternative; a third opinion on the same images.',
  'wd-vit-large-tagger-v3': 'Larger, more accurate, noticeably slower.',
  'wd-eva02-large-tagger-v3': 'Most accurate of the WD v3 family, and the slowest.',
  'wd-v1-4-vit-tagger-v2': 'Older v2 generation. Kept for consistency with sets tagged earlier.',
  joytag: 'Booru-style tagger with broad general and NSFW coverage.',
  'blip-large': 'Writes one plain-English sentence describing the image.',
}

type OutKind = 'tags' | 'nl'

const KIND_OF = (t: any): OutKind => (t?.engine === 'blip' ? 'nl' : 'tags')

const OUT_INFO: Record<OutKind, { label: string; ext: string; blurb: string }> = {
  tags: {
    label: 'Booru tags',
    ext: '.txt',
    blurb: 'Comma-separated Danbooru-style tags — what kohya reads for SDXL, Illustrious and Pony LoRAs.',
  },
  nl: {
    label: 'Natural language',
    ext: '.caption',
    blurb: 'A descriptive sentence — for models with a language/VL text encoder, e.g. Krea 2.',
  },
}

export const AutoCaptionModal: React.FC<{ onClose: () => void; onDone: () => void }> = ({ onClose, onDone }) => {
  const [taggers, setTaggers] = useState<any[]>([])
  const [outKind, setOutKind] = useState<OutKind>('tags')
  const [model, setModel] = useState('')
  const [device, setDevice] = useState('cuda')
  const [thr, setThr] = useState('0.35'); const [cthr, setCthr] = useState('0.85')
  const [spaces, setSpaces] = useState(false); const [trigger, setTrigger] = useState(''); const [overwrite, setOverwrite] = useState(false)
  const [status, setStatus] = useState(''); const [running, setRunning] = useState(false)
  const poll = useRef<any>(null)

  useEffect(() => {
    store.taggers()
      .then((d) => setTaggers(d.taggers || []))
      .catch(() => setStatus('No taggers available.'))
    return () => { if (poll.current) clearInterval(poll.current) }
  }, [])

  // Models for the chosen output type. Selecting the OUTPUT first, then the model, is the order
  // the decision actually happens in — the output file is what a trainer consumes.
  const forKind = taggers.filter((t) => KIND_OF(t) === outKind)
  useEffect(() => {
    if (!forKind.length) { setModel(''); return }
    if (!forKind.some((t) => t.id === model)) setModel(forKind[0].id)
  }, [outKind, taggers])

  const cur = taggers.find((t) => t.id === model)
  const isBlip = cur?.engine === 'blip'
  useEffect(() => { if (isBlip) setDevice('cuda') }, [isBlip])

  const info = OUT_INFO[outKind]

  const run = async () => {
    if (!cur) return
    const body = {
      path: store.cwd, engine: cur.engine, model, device,
      threshold: parseFloat(thr) || 0.35, char_threshold: parseFloat(cthr) || 0.85,
      spaces, trigger: trigger.trim(), overwrite,
    }
    setRunning(true); setStatus('Starting…')
    try {
      const { jobId } = await store.autoCaption(body)
      let statusFailures = 0
      poll.current = setInterval(async () => {
        let s: any
        try { s = await store.autoCaptionStatus(jobId); statusFailures = 0 } catch {
          // Same cap as CropEditor: a dead status endpoint must not leave
          // "Captioning…" on screen forever with running never released.
          if (++statusFailures >= 15) {
            clearInterval(poll.current); poll.current = null; setRunning(false)
            setStatus('Lost contact with the captioning job (status endpoint unreachable) — it may still finish server-side; refresh to see results.')
          }
          return
        }
        if (s.state === 'running') { setStatus(`Captioning ${s.done}/${s.total || '…'}${s.provider ? ' (' + s.provider + ')' : ''}…`); return }
        clearInterval(poll.current); poll.current = null; setRunning(false)
        if (s.state === 'done') {
          // Report the provider that ACTUALLY ran. Asking for GPU and silently getting CPU is
          // the kind of thing that should never be invisible.
          setStatus(`Done — wrote ${s.wrote}, skipped ${s.skipped}, errors ${s.errors}`
            + `${s.provider ? ` · ran on ${s.provider}` : ''}`
            + `${s.lastError ? ' · Last: ' + s.lastError : ''}`)
          onDone()
        } else setStatus(`Failed: ${s.error || s.lastError || 'unknown'}`)
      }, 2000)
    } catch (e: any) { setRunning(false); setStatus('Failed: ' + (e?.message || e)) }
  }

  return (
    <div className={styles.modalBg} onClick={onClose}>
      <div className={styles.pkBox} style={{ width: 'min(560px,94%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Auto-caption — {store.cwd.split('/').pop() || 'training_images'}</strong>
          <button className={styles.btn} onClick={onClose}>Close</button>
        </div>

        {/* 1. WHAT the run produces. Tags and sentences live in separate sidecars, so both can
            exist on the same image and each trainer reads the one it understands. */}
        <div className={styles.acSection}>Output</div>
        <div className={styles.acSeg}>
          {(['tags', 'nl'] as OutKind[]).map((k) => (
            <button
              key={k}
              className={`${styles.acSegBtn} ${outKind === k ? styles.acSegOn : ''}`}
              disabled={running || !taggers.some((t) => KIND_OF(t) === k)}
              onClick={() => setOutKind(k)}
            >
              {OUT_INFO[k].label}
              <span className={styles.acSegExt}>{OUT_INFO[k].ext}</span>
            </button>
          ))}
        </div>
        <div className={styles.acHint}>{info.blurb}</div>
        <div className={styles.acHint}>
          Writes <code>&lt;image&gt;{info.ext}</code> next to each image. The other kind is left
          untouched — an image can carry both.
        </div>

        {/* 2. WHICH model, with what it is actually good for. */}
        <div className={styles.acSection}>Model</div>
        {forKind.length === 0
          ? <div className={styles.acHint}>No {info.label.toLowerCase()} model is installed.</div>
          : (
            <>
              <select className={styles.input} style={{ width: '100%' }} value={model} disabled={running} onChange={(e) => setModel(e.target.value)}>
                {forKind.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <div className={styles.acHint}>{MODEL_NOTES[model] || 'No description recorded for this model.'}</div>
            </>
          )}

        {/* 3. Options that only make sense for tag models. */}
        {!isBlip && (
          <>
            <div className={styles.acSection}>Tagging options</div>
            <label className={styles.acl}>General threshold
              <input className={styles.input} type="number" step="0.05" min="0" max="1" value={thr} onChange={(e) => setThr(e.target.value)} />
            </label>
            <div className={styles.acHint}>Lower = more tags (and more noise). 0.35 is a sane default.</div>
            <label className={styles.acl}>Character threshold
              <input className={styles.input} type="number" step="0.05" min="0" max="1" value={cthr} onChange={(e) => setCthr(e.target.value)} />
            </label>
            <div className={styles.acHint}>Higher, because a wrong character name is worse than a missing one.</div>
            <label className={styles.aclChk}>
              <input type="checkbox" checked={spaces} onChange={(e) => setSpaces(e.target.checked)} /> underscores → spaces
            </label>
            <label className={styles.acl}>Device
              <select className={styles.input} value={device} onChange={(e) => setDevice(e.target.value)}>
                <option value="cpu">CPU</option><option value="cuda">GPU (4090)</option>
              </select>
            </label>
            <div className={styles.acHint}>
              The 4090 is shared with ComfyUI — pick CPU if you would rather not contend for it.
              Either way the result line names the provider that actually ran.
            </div>
          </>
        )}

        <div className={styles.acSection}>Applies to</div>
        <label className={styles.acl}>Trigger word(s)
          <input className={styles.input} placeholder="optional — prepended, e.g. evegladden" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
        </label>
        <div className={styles.acHint}>Goes first, which is where kohya expects the trigger.</div>
        <label className={styles.aclChk}>
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> overwrite existing {info.ext} files
        </label>
        <div className={styles.acHint}>
          Off = images that already have {info.ext} are skipped, so you can top up a set without
          losing hand-edited work.
        </div>

        <div className={styles.msg}>{status}</div>
        <div className={styles.pkFoot}>
          <span className={styles.spacer} />
          <button className={styles.btnPrimary} disabled={running || !model} onClick={() => void run()}>
            {running ? 'Running…' : `Run → ${info.ext}`}
          </button>
        </div>
      </div>
    </div>
  )
}
