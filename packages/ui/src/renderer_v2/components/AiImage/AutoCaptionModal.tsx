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
export const AutoCaptionModal: React.FC<{ onClose: () => void; files?: string[]; path?: string; label?: string; allOfFolder?: boolean }> = ({ onClose, files, path, label, allOfFolder }) => {
  // Per-FOLDER with a fallback to the last value used anywhere. Defined up here because
  // several state initialisers below now read it.
  const per = (k: string) => { try { return localStorage.getItem(k + store.cwd) ?? localStorage.getItem(k + '*') ?? '' } catch { return '' } }
  const setPer = (k: string, v: string) => { try { localStorage.setItem(k + store.cwd, v); localStorage.setItem(k + '*', v) } catch {} }

  const [taggers, setTaggers] = useState<any[]>([])
  // Output type and engine persist too. Travis was re-picking "custom" and then the model on
  // every run. Both survive the async loads below without extra care: the effect that defaults
  // the tagger keeps the current one when it is valid for the chosen output, and the VLM list
  // loader keeps the current model when it is still in the list — so a restored value is only
  // replaced once it has genuinely become unavailable.
  const [outKind, setOutKindRaw] = useState<OutKind>(() => {
    const v = per('aig-cap-outkind:')
    return (v === 'tags' || v === 'caption') ? (v as OutKind) : 'tags'
  })
  const setOutKind = (v: OutKind) => { setOutKindRaw(v); setPer('aig-cap-outkind:', v) }
  const [model, setModelRaw] = useState(() => per('aig-cap-tagger:'))
  // Only remember a REAL choice: the defaulting effect calls this with '' when a kind has no
  // taggers, and persisting that would wipe the remembered one.
  const setModel = (v: string) => { setModelRaw(v); if (v) setPer('aig-cap-tagger:', v) }
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
  // Subject fields. The captioner's permanent half is now caption DISCIPLINE (consistency,
  // only what is visible, describe what varies); everything subject-specific is composed from
  // these. Persisted per folder like context, since they describe a SET, not a session.
  // FULL PROMPT OVERRIDE. The fields below describe a SUBJECT within the built-in LoRA caption
  // discipline; they cannot change the JOB. Captioning a folder for something other than LoRA
  // training — posing references, shot lists, accessibility alt text — needs the discipline
  // itself replaced, which is what this does. Empty = the LoRA path, unchanged.
  const [instruction, setInstructionRaw] = useState(() => per('aig-cap-instruction:'))
  const setInstruction = (v: string) => { setInstructionRaw(v); setPer('aig-cap-instruction:', v) }
  const [naming, setNamingRaw] = useState(() => per('aig-cap-naming:'))
  const setNaming = (v: string) => { setNamingRaw(v); setPer('aig-cap-naming:', v) }
  const [emphasize, setEmphasizeRaw] = useState(() => per('aig-cap-emph:'))
  const setEmphasize = (v: string) => { setEmphasizeRaw(v); setPer('aig-cap-emph:', v) }
  // Left BLANK by default on purpose. An exemplar is imitated — that is the point — so a
  // seeded one would push its own garment and setting into sets it was never written for,
  // and the per-folder store falls back to the last value used ANYWHERE. The validated
  // wording lives in the placeholder instead: visible, copyable, not silently applied.
  const [example, setExampleRaw] = useState(() => per('aig-cap-example:'))
  const setExample = (v: string) => { setExampleRaw(v); setPer('aig-cap-example:', v) }
  const [sizeWord, setSizeWordRaw] = useState(() => per('aig-cap-sizeword:'))
  const setSizeWord = (v: string) => { setSizeWordRaw(v); setPer('aig-cap-sizeword:', v) }
  // Default omit, and the reason is shown in the UI rather than assumed: measured on these
  // sets the VLM wrote "large" 21 times and "huge" once for the huge set. `state` stays
  // available because it is a real choice for another LoRA, not a footgun to hide.
  const [sizeMode, setSizeModeRaw] = useState<'omit' | 'state'>(() => (per('aig-cap-sizemode:') === 'state' ? 'state' : 'omit'))
  const setSizeMode = (v: 'omit' | 'state') => { setSizeModeRaw(v); setPer('aig-cap-sizemode:', v) }

  const [status, setStatus] = useState(''); const [running, setRunning] = useState(false)
  // Custom NL engine: which proxy model does the captioning. The list is fetched lazily
  // (only when the vlm engine is chosen); on failure the picker degrades to a free-text
  // field — an honest fallback beats a dead dropdown.
  const [vlmModels, setVlmModels] = useState<string[]>([])
  const [vlmModel, setVlmModelRaw] = useState(() => per('aig-cap-vlmmodel:'))
  // Takes the updater form too — the list loader calls setVlmModel(prev => ...).
  const setVlmModel: typeof setVlmModelRaw = (v) => {
    setVlmModelRaw((prev) => {
      const next = typeof v === 'function' ? (v as (p: string) => string)(prev) : v
      if (next) setPer('aig-cap-vlmmodel:', next)
      return next
    })
  }
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
        // Fill in the backend default ONLY when nothing is remembered. Applying it
        // unconditionally overwrote the restored choice on every open — the second async
        // load in this component that would have quietly undone the persistence.
        if (d.vlm_default_model) setVlmModel((v) => v || String(d.vlm_default_model))
      })
      .catch(() => setStatus('No taggers available.'))
  }, [])

  // Models for the chosen output type. Selecting the OUTPUT first, then the model, is the order
  // the decision actually happens in — the output file is what a trainer consumes.
  const forKind = taggers.filter((t) => KIND_OF(t) === outKind)
  useEffect(() => {
    // 🛑 Do NOT touch the model before the tagger list has loaded. On mount `taggers` is [],
    // so this ran once with an empty forKind and cleared the model — wiping the remembered
    // selection a moment before the list arrived to validate it, which would have made the
    // persistence look like it simply did not work.
    if (!taggers.length) return
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
    if (isVlm && instruction.trim()) body.instruction = instruction.trim()
    if (isVlm && context.trim()) body.context = context.trim()
    if (isVlm && naming.trim()) body.naming = naming.trim()
    if (isVlm && emphasize.trim()) body.emphasize = emphasize.trim()
    if (isVlm && example.trim()) body.example = example.trim()
    if (isVlm) {
      body.size_mode = sizeMode
      if (sizeMode === 'state' && sizeWord.trim()) body.size_word = sizeWord.trim()
    }
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
        const CHUNK = 200
        if (!files?.length || allOfFolder) {
          jobs = [{ sub: '' }]                       // let the tagger walk the directory
        } else {
          jobs = []
          for (let i = 0; i < files.length; i += CHUNK) {
            jobs.push({ sub: '', names: files.slice(i, i + CHUNK) })
          }
        }
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
            <div className={styles.acSection}>Custom instruction — replaces the LoRA prompt</div>
            <textarea
              className={styles.input}
              style={{ width: '100%', minHeight: 72, resize: 'vertical' }}
              placeholder={'leave EMPTY for normal LoRA training captions.\n\nFill this in to caption for something else entirely, e.g. "Describe the SUBJECT\'S POSE for use as a ComfyUI posing reference: body position, limb placement, weight distribution, head and gaze direction, and camera angle. Ignore clothing, styling and setting."'}
              value={instruction}
              disabled={running}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <div className={styles.acHint}>
              {instruction.trim()
                ? <><strong>Override active.</strong> Your text is the whole prompt. The LoRA caption
                  discipline, the one-sentence rule and the size-suppression line are all dropped —
                  only &ldquo;output the caption only, no preamble&rdquo; is kept. The fields below still
                  apply if filled, so clear any that do not suit this job.</>
                : <>Empty, so the built-in LoRA caption discipline is used and the fields below
                  describe the subject within it. Fill this in when the folder is not for LoRA
                  training — the fields below cannot change the job, only the subject.</>}
            </div>

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
              it twice is redundant. The caption discipline (one factual sentence, consistent
              wording, describe what VARIES, no preamble) is always applied - these fields say
              what the SUBJECT is, not how to write.
            </div>

            <div className={styles.acSection}>Consistent naming</div>
            <input
              className={styles.input} style={{ width: '100%' }} disabled={running}
              placeholder={'optional - e.g. Always call the genital area "the bulge", never "protrusion", "contour" or "shape".'}
              value={naming} onChange={(e) => setNaming(e.target.value)}
            />
            <div className={styles.acHint}>
              Sent verbatim. A model that drifts between synonyms for the same thing is what
              makes a concept hard to learn, so dictate the exact word.
            </div>

            <div className={styles.acSection}>Size</div>
            <div className={styles.acSeg}>
              {([['omit', "Don't caption size", 'recommended'],
                 ['state', 'Always say…', 'one fixed word']] as const).map(([v, label, ext]) => (
                <button
                  key={v} disabled={running}
                  className={`${styles.acSegBtn} ${sizeMode === v ? styles.acSegOn : ''}`}
                  onClick={() => setSizeMode(v)}
                >
                  {label}<span className={styles.acSegExt}>{ext}</span>
                </button>
              ))}
            </div>
            {sizeMode === 'state' && (
              <input
                className={styles.input} style={{ width: '100%', marginTop: 6 }} disabled={running}
                placeholder="the exact word to use, e.g. cute"
                value={sizeWord} onChange={(e) => setSizeWord(e.target.value)}
              />
            )}
            <div className={styles.acHint}>
              The model is unreliable at size: on the "huge" set it wrote "large" 21 times and
              "huge" once. Leave it out and stamp the size across the set afterwards with
              <b> Find &amp; replace</b> or <b>Blanket tags</b>, which are deterministic.
            </div>

            <div className={styles.acSection}>Emphasize / priority</div>
            <input
              className={styles.input} style={{ width: '100%' }} disabled={running}
              placeholder="optional - what to weigh highest, e.g. satin briefs, fabric sheen, high-cut"
              value={emphasize} onChange={(e) => setEmphasize(e.target.value)}
            />
            <div className={styles.acHint}>
              Cut, colour and fabric — not size. With size kept out of the sentence above, this
              box is the remaining way one could get back in, so avoid words like large,
              prominent or full here.
            </div>

            <div className={styles.acSection}>Format example</div>
            <input
              className={styles.input} style={{ width: '100%' }} disabled={running}
              placeholder='optional - e.g. Front view, standing pose, black lace bra and black satin briefs high-cut with the bulge visible through the fabric, indoor room.'
              value={example} onChange={(e) => setExample(e.target.value)}
            />
            <div className={styles.acHint}>
              One literal caption showing the exact shape you want. Measured as the strongest
              control here — a model copies an example far more reliably than it follows a rule.
              <b> Do not include the trigger word</b>: it is prepended separately, so an example
              containing it teaches the model to write it twice. Leave blank and no example is
              sent. Its LENGTH and DETAIL are copied too — a measured effect, not a guess: a
              short one-garment example pulled captions to 18 words and quietly dropped the
              second garment, so name two garments here if your images have two.
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
