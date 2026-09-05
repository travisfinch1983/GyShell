import React, { useEffect, useState } from 'react'
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
  'blip-large': 'Writes one plain-English sentence describing the image. Fast, but generic - it cannot be steered, and on a material/style set it misread the garment.',
  'vlm-custom': 'Sends each image to a model YOU pick from the AI-Lab proxy, with an instruction, so the caption can be aimed at material, light and cut. Roughly 3s per image on a local 9B-class VLM. Give it the set context below.',
}

type OutKind = 'tags' | 'nl'

// Both natural-language engines write .caption; only the ONNX taggers write .txt tags.
const KIND_OF = (t: any): OutKind => (t?.engine === 'blip' || t?.engine === 'vlm' ? 'nl' : 'tags')

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

/**
 * `path` lets a caller outside the Training Images browser reuse this dialog — the Dataset
 * Review tab captions dataset TILES, which live at _datasets/<name>/tiles rather than under
 * the browser's cwd. The backend already accepts any path under the imagegen root, so this
 * is purely about not assuming the training-images store owns the location.
 */
export const AutoCaptionModal: React.FC<{ onClose: () => void; files?: string[]; path?: string; label?: string }> = ({ onClose, files, path, label }) => {
  const [taggers, setTaggers] = useState<any[]>([])
  const [outKind, setOutKind] = useState<OutKind>('tags')
  const [model, setModel] = useState('')
  const [device, setDevice] = useState('cuda')
  // GPU roster from /taggers (PCI order — the same numbering nvidia-smi and the dispatched
  // job see, because the backend pins CUDA_DEVICE_ORDER=PCI_BUS_ID). An empty roster means
  // the host could not be read — that is said out loud, never rendered as a confident
  // empty picker.
  const [gpus, setGpus] = useState<any[]>([])
  const [gpuIndex, setGpuIndex] = useState<string>('')
  const [thr, setThr] = useState('0.35'); const [cthr, setCthr] = useState('0.85')
  const [spaces, setSpaces] = useState(false)
  // Trigger, context and the overwrite toggle persist across reopen/reload: per-FOLDER
  // first, falling back to the last value used anywhere (Travis, 2026-09-02 — he chose
  // convenience over the stale-trigger caution, so DO CHECK the trigger when captioning
  // a different set: it carries over and gets prepended to every caption).
  const [overwrite, setOverwriteRaw] = useState(() => { try { return localStorage.getItem('aig-cap-overwrite') === '1' } catch { return false } })
  const setOverwrite = (v: boolean) => { setOverwriteRaw(v); try { localStorage.setItem('aig-cap-overwrite', v ? '1' : '0') } catch {} }
  const [trigger, setTriggerRaw] = useState(() => { try { return localStorage.getItem('aig-cap-trigger:' + store.cwd) ?? localStorage.getItem('aig-cap-trigger:*') ?? '' } catch { return '' } })
  const setTrigger = (v: string) => { setTriggerRaw(v); try { localStorage.setItem('aig-cap-trigger:' + store.cwd, v); localStorage.setItem('aig-cap-trigger:*', v) } catch {} }
  // vlm only: what this SET is. Goes into the instruction so the model knows
  // what it is looking at; the trigger phrase stays OUT of the prose.
  const [context, setContextRaw] = useState(() => { try { return localStorage.getItem('aig-cap-context:' + store.cwd) ?? localStorage.getItem('aig-cap-context:*') ?? '' } catch { return '' } })
  const setContext = (v: string) => { setContextRaw(v); try { localStorage.setItem('aig-cap-context:' + store.cwd, v); localStorage.setItem('aig-cap-context:*', v) } catch {} }
  const [status, setStatus] = useState(''); const [running, setRunning] = useState(false)
  // Custom NL engine: which proxy model does the captioning. The list is fetched lazily
  // (only when the vlm engine is chosen); on failure the picker degrades to a free-text
  // field — an honest fallback beats a dead dropdown.
  const [vlmModels, setVlmModels] = useState<string[]>([])
  const [vlmModel, setVlmModel] = useState('')
  const [vlmListErr, setVlmListErr] = useState(false)
  // True when the vision filter had to be bypassed (proxy reported NO vision-capable
  // models — a regression upstream, not a lab with zero VLMs). The dropdown then shows
  // everything and says so, instead of rendering empty-but-confident.
  const [vlmAllShown, setVlmAllShown] = useState(false)

  useEffect(() => {
    store.taggers()
      .then((d) => {
        setTaggers(d.taggers || [])
        setGpus(Array.isArray(d.gpus) ? d.gpus : [])
        if (d.default_gpu_index !== undefined) setGpuIndex(String(d.default_gpu_index))
        if (d.vlm_default_model) setVlmModel(String(d.vlm_default_model))
      })
      .catch(() => setStatus('No taggers available.'))
  }, [])

  // Models for the chosen output type. Selecting the OUTPUT first, then the model, is the order
  // the decision actually happens in — the output file is what a trainer consumes.
  const forKind = taggers.filter((t) => KIND_OF(t) === outKind)
  useEffect(() => {
    if (!forKind.length) { setModel(''); return }
    if (!forKind.some((t) => t.id === model)) setModel(forKind[0].id)
  }, [outKind, taggers])

  const cur = taggers.find((t) => t.id === model)
  const isVlm = cur?.engine === 'vlm'
  // Either NL engine: no thresholds, no tag options. Was `isBlip`, which
  // left the vlm engine showing tag controls that do nothing.
  const isNl = cur?.engine === 'blip' || isVlm
  useEffect(() => { if (isNl) setDevice('cuda') }, [isNl])
  // BLIP runs on a local card too (forced cuda); the VLM engine leaves the box over the API.
  const usesLocalGpu = (!isNl && device === 'cuda') || cur?.engine === 'blip'

  const info = OUT_INFO[outKind]

  useEffect(() => {
    if (!isVlm || vlmModels.length || vlmListErr) return
    fetch('/api/proxy/llm/v1/models')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        const all = (d?.data || []).filter((m: any) => m && m.id)
        // The proxy annotates every model with capabilities {text, vision, audio} —
        // captioning needs eyes, so only vision:true is offered. A text-only model
        // would "caption" from nothing and the output would look plausible.
        const vision = all.filter((m: any) => m?.capabilities?.vision === true)
        const list = vision.length ? vision : all
        const ids = list.map((m: any) => String(m.id))
        if (!ids.length) throw new Error('empty model list')
        setVlmAllShown(vision.length === 0)
        setVlmModels(ids)
        setVlmModel((v) => (v && ids.includes(v) ? v : ids[0]))
      })
      .catch(() => setVlmListErr(true))
  }, [isVlm])

  const run = async () => {
    if (!cur) return
    const body: Record<string, unknown> = {
      path: store.cwd, engine: cur.engine, model, device,
      threshold: parseFloat(thr) || 0.35, char_threshold: parseFloat(cthr) || 0.85,
      spaces, trigger: trigger.trim(), overwrite,
    }
    if (usesLocalGpu && gpuIndex !== '') body.gpu_index = parseInt(gpuIndex, 10)

    // `avoid` defaults to the trigger backend-side, so the phrase is stated
    // once (by the prepend) instead of twice.
    if (isVlm && context.trim()) body.context = context.trim()
    if (isVlm && vlmModel.trim()) body.vlm_model = vlmModel.trim()
    setRunning(true); setStatus('Starting…')
    try {
      // ONE JOB PER FOLDER: the tagger walks a single directory, so a selection spanning
      // batch subsections fans out (files are dir-qualified keys), and a whole-folder run
      // on a SECTIONED batch covers every subsection plus any loose root images — without
      // this, subsection images 404'd ('not found: green-12.png') or were silently skipped.
      let jobs: Array<{ sub: string; names?: string[] }>
      if (path) {
        // An explicit path is a single flat directory — no sections, no dir-qualified keys.
        jobs = [{ sub: '', names: files?.length ? files : undefined }]
      } else if (files?.length) {
        jobs = store.splitKeys(files)
      } else if (store.sections.length) {
        jobs = store.sections.map((s) => ({ sub: s.folder }))
        if (store.images.some((im) => !im.dir)) jobs.unshift({ sub: '' })
      } else {
        jobs = [{ sub: '' }]
      }
      let lastJob = ''
      for (const j of jobs) {
        const jbody: Record<string, unknown> = { ...body, path: path ?? store.dirPath(j.sub) }
        if (j.names) jbody.files = j.names
        else delete jbody.files
        const { jobId } = await store.autoCaption(jbody)
        lastJob = jobId
        // Progress lives on the browser page + Task Progress panel; each folder's job is
        // tracked server-side, the store follows the last one for the grid refresh.
        store.trackCaptionJob(jobId, `${isVlm ? vlmModel.trim() : (model || cur.label)}${j.sub ? ` · ${j.sub}` : ''}`)
      }
      void lastJob
      onClose()
    } catch (e: any) { setRunning(false); setStatus('Failed: ' + (e?.message || e)) }
  }

  return (
    <div className={styles.modalBg}>{/* deliberately NOT click-to-close: a stray backdrop click was eating typed input */}
      <div className={styles.pkBox} style={{ width: 'min(560px,94%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Auto-caption — {label ?? (files?.length ? `${files.length} selected image${files.length > 1 ? 's' : ''}` : (store.cwd.split('/').pop() || 'training_images'))}</strong>
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
        {!isNl && (
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
                <option value="cpu">CPU</option><option value="cuda">GPU</option>
              </select>
            </label>
            <div className={styles.acHint}>
              The cards are shared with ComfyUI — pick CPU to avoid contending, or choose a
              quieter card below. Either way the result line names the provider that actually ran.
            </div>
          </>
        )}
        {usesLocalGpu && (
          <>
            <div className={styles.acSection}>GPU</div>
            {gpus.length === 0 ? (
              <div className={styles.acHint}>
                GPU list unavailable (could not read the GPU host) — the job will run on the
                default card (#{gpuIndex || '?'}).
              </div>
            ) : (
              <>
                <select className={styles.input} style={{ width: '100%' }} value={gpuIndex} disabled={running} onChange={(e) => setGpuIndex(e.target.value)}>
                  {gpus.map((g) => (
                    <option key={g.index} value={String(g.index)}>
                      #{g.index} — {g.name} ({(g.free_mib / 1024).toFixed(1)} GiB free of {Math.round(g.total_mib / 1024)})
                    </option>
                  ))}
                </select>
                {(() => {
                  const sel = gpus.find((g) => String(g.index) === gpuIndex)
                  return sel && sel.free_mib < 2048 ? (
                    <div className={styles.acHint}>
                      ⚠ Only {sel.free_mib} MiB free on this card. The tagger needs ~2 GiB and a
                      full card fails with an allocator error — it does not queue. Pick one with
                      headroom.
                    </div>
                  ) : (
                    <div className={styles.acHint}>
                      Numbers match nvidia-smi (PCI order). Free VRAM matters: a full card fails
                      outright rather than queueing.
                    </div>
                  )
                })()}
              </>
            )}
          </>
        )}
        {isVlm && (
          <>
            <div className={styles.acSection}>Proxy model</div>
            {vlmListErr ? (
              <>
                <input className={styles.input} style={{ width: '100%' }} value={vlmModel} disabled={running}
                       placeholder="model id exactly as the proxy serves it" onChange={(e) => setVlmModel(e.target.value)} />
                <div className={styles.acHint}>Could not load the proxy model list — type the model id by hand.</div>
              </>
            ) : (
              <>
                <select className={styles.input} style={{ width: '100%' }} value={vlmModel} disabled={running || !vlmModels.length} onChange={(e) => setVlmModel(e.target.value)}>
                  {!vlmModels.length && <option value={vlmModel}>{vlmModel ? `${vlmModel} (loading list…)` : 'loading…'}</option>}
                  {vlmModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <div className={styles.acHint}>
                  {vlmAllShown
                    ? '⚠ The proxy reported no vision-capable models, so ALL models are listed — pick one you know can see images.'
                    : 'Only models the proxy reports as vision-capable are listed — a text-only model would invent captions from nothing.'}
                </div>
              </>
            )}
            <div className={styles.acSection}>Set context</div>
            <textarea
              className={styles.input}
              style={{ width: '100%', minHeight: 64, resize: 'vertical' }}
              placeholder='optional - what every image in this set shows, e.g. "Every image shows red satin string bikini panties; the set is for a LoRA about the MATERIAL and STYLE of the garment."'
              value={context}
              disabled={running}
              onChange={(e) => setContext(e.target.value)}
            />
            <div className={styles.acHint}>
              Tells the model what it is looking at so it uses the right vocabulary. The
              trigger below is kept OUT of the sentence itself - it is prepended, so saying
              it twice is redundant.
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
