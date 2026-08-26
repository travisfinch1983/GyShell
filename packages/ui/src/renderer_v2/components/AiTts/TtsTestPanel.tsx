import React, { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { Play, RefreshCw, Save, Trash2, RotateCcw, Loader2 } from 'lucide-react'
import { ttsTestStore as store } from '../../stores/TtsTestStore'
import { ttsLogStore } from '../../stores/ttsLogStore'
import { promptStore } from '../../stores/promptStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './TtsTest.module.scss'

const Slider: React.FC<{ label: string; k: any; min: number; max: number; step: number; unit?: string }> = observer(({ label, k, min, max, step, unit }) => (
  <label className={styles.slider}>
    <span className={styles.sLabel}>{label}<b>{(store as any)[k]}{unit || ''}</b></span>
    <input type="range" min={min} max={max} step={step} value={(store as any)[k]} onChange={(e) => store.set(k, Number(e.target.value))} />
  </label>
))

const ActivityLog: React.FC = observer(() => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [ttsLogStore.lines.length])
  return (
    <section className={styles.card}>
      <div className={styles.head}><h4 className={styles.h4}>Activity Log</h4><span className={styles.spacer} /><button className={styles.btn} onClick={() => ttsLogStore.clear()}>Clear</button></div>
      <div ref={ref} className={styles.log}>
        {ttsLogStore.lines.map((l, i) => <div key={i} className={styles[`lvl_${l.level}`]}><span className={styles.logT}>{l.t}</span> {l.msg}</div>)}
        {ttsLogStore.lines.length === 0 && <div className={styles.muted}>No activity yet.</div>}
      </div>
    </section>
  )
})

export const TtsTestPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const rvcFileRef = useRef<HTMLInputElement>(null)

  // Gate interaction until the store has loaded + restored saved settings — otherwise early clicks land on
  // default state and get overwritten when load()/restore() completes (the "flashes then reverts" bug).
  if (!store.loaded) return (
    <div className={styles.panel}><section className={styles.card}><div className={styles.muted}>Loading TTS console…</div></section></div>
  )

  return (
    <div className={styles.panel}>
      {/* ── TTS Test Console ── */}
      <section className={styles.card}>
        <div className={styles.head}><h4 className={styles.h4}>TTS Test Console</h4>
          <span className={`${styles.engBadge} ${styles['eng_' + store.engine] || ''}`}>{store.engine}</span>
          {store.engineDetail && <span className={styles.dim}>{store.engineDetail}</span>}
        </div>
        <div className={styles.grid2}>
          <label className={styles.field}><span>Service</span>
            <select value={store.selectedService} onChange={(e) => { store.set('selectedService', e.target.value); void store.detectEngine().then(() => Promise.all([store.refreshVoices(), store.refreshModels()])) }}>
              {store.services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          {store.isCustom && <label className={styles.field}><span>Endpoint URL</span>
            <input value={store.endpoint} placeholder="http://10.0.0.x:8880" onChange={(e) => store.set('endpoint', e.target.value)} onBlur={() => void store.detectEngine().then(() => store.refreshVoices())} />
          </label>}
          <label className={styles.field}><span>Voice</span>
            <select value={store.selectedVoice} onChange={(e) => store.set('selectedVoice', e.target.value)}>
              <option value="">— default —</option>
              {store.voices.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
            </select>
          </label>
          <label className={styles.field}><span>Model</span>
            <select value={store.selectedModel} onChange={(e) => store.set('selectedModel', e.target.value)}>
              {store.models.length ? store.models.map((m) => <option key={m} value={m}>{m}</option>) : ['chatterbox-turbo', 'chatterbox', 'dramabox'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className={styles.field}><span>Format</span>
            <select value={store.format} onChange={(e) => store.set('format', e.target.value)}>{['wav', 'mp3', 'opus', 'flac'].map((f) => <option key={f} value={f}>{f}</option>)}</select>
          </label>
        </div>

        <label className={styles.field}><span>Text</span>
          <textarea rows={4} value={store.text} onChange={(e) => store.set('text', e.target.value)} placeholder="Text to synthesize. Paralinguistic tags like [laugh] supported on Chatterbox turbo." />
        </label>
        {store.isChatterbox && store.isTurbo && (
          <div className={styles.tagRow}>{store.TAGS.map((t) => <button key={t} className={styles.tagBtn} onClick={() => store.insertTag(t)}>[{t}]</button>)}</div>
        )}

        {store.isQwen && <>
          <label className={styles.field}><span>{store.voiceDesign ? 'Voice description (VoiceDesign)' : 'Style instruction'}</span>
            <textarea rows={2} value={store.qwenInstruction} onChange={(e) => store.set('qwenInstruction', e.target.value)} /></label>
          <label className={styles.field}><span>Language</span>
            <select value={store.qwenLanguage} onChange={(e) => store.set('qwenLanguage', e.target.value)}>{['Auto', 'en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'].map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
        </>}

        {store.isDramabox && (
          <div className={styles.grid2}>
            <label className={styles.field}><span>CFG scale</span><input type="number" step="0.1" value={store.dbCfg} onChange={(e) => store.set('dbCfg', Number(e.target.value))} /></label>
            <label className={styles.field}><span>STG scale</span><input type="number" step="0.1" value={store.dbStg} onChange={(e) => store.set('dbStg', Number(e.target.value))} /></label>
            <label className={styles.field}><span>Duration mult</span><input type="number" step="0.1" value={store.dbDurMult} onChange={(e) => store.set('dbDurMult', Number(e.target.value))} /></label>
            <label className={styles.field}><span>Seed</span><input type="number" value={store.dbSeed} onChange={(e) => store.set('dbSeed', Number(e.target.value))} /></label>
            <label className={styles.check}><input type="checkbox" checked={store.dbNoWatermark} onChange={(e) => store.set('dbNoWatermark', e.target.checked)} /> No watermark</label>
          </div>
        )}

        <div className={styles.sliders}>
          <Slider label="Speed " k="speed" min={0.25} max={4} step={0.25} />
          <Slider label="Temperature " k="temperature" min={0.05} max={2} step={0.05} />
          {store.isChatterbox && store.isTurbo && <Slider label="Top-K " k="topK" min={0} max={2000} step={50} />}
          <Slider label="Top-P " k="topP" min={0} max={1} step={0.01} />
          {store.isChatterbox && <Slider label="Rep. penalty " k="repPen" min={1} max={2} step={0.05} />}
          {store.isChatterbox && !store.isTurbo && <>
            <Slider label="Exaggeration " k="exag" min={0} max={1} step={0.05} />
            <Slider label="CFG weight " k="cfg" min={0} max={1} step={0.05} />
            <Slider label="Min-P " k="minP" min={0} max={1} step={0.01} />
          </>}
        </div>

        {/* preset bar */}
        <div className={styles.presetBar}>
          <select value={store.selectedPreset} onChange={(e) => store.set('selectedPreset', e.target.value)}>
            <option value="">— voice preset —</option>
            {Object.keys(store.presets).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button className={styles.btn} disabled={!store.selectedPreset} onClick={() => void store.loadPreset(store.selectedPreset)}>Load</button>
          <button className={styles.btn} onClick={async () => { const n = await promptStore.prompt({ title: 'Save voice preset', label: 'Preset name', defaultValue: store.selectedPreset }); if (n) void store.savePreset(n) }}><Save size={12} /> Save</button>
          <button className={styles.btnDanger} disabled={!store.selectedPreset} onClick={async () => { if (await confirmStore.confirm({ title: 'Delete preset', message: `Delete preset “${store.selectedPreset}”?`, confirmText: 'Delete' })) void store.deletePreset(store.selectedPreset) }}><Trash2 size={12} /></button>
        </div>

        <div className={styles.actions}>
          <button className={styles.btn} onClick={() => { void store.refreshVoices(); void store.refreshModels() }}><RefreshCw size={13} /> Refresh Voices</button>
          <button className={styles.btnPrimary} disabled={store.busy || store.streaming} onClick={() => void store.submit()}>{(store.busy || store.streaming) ? <Loader2 size={13} className={styles.spin} /> : <Play size={13} />} Generate Speech</button>
          <button className={styles.btn} onClick={() => store.resetDefaults()}><RotateCcw size={13} /> Reset Defaults</button>
          <label className={styles.check}><input type="checkbox" checked={store.autoPlay} onChange={(e) => store.set('autoPlay', e.target.checked)} /> Auto-play</label>
          {store.isMultiTts && <span className={styles.dim}>multi-TTS pipeline (streamed)</span>}
          <span className={styles.dim}>{store.status}</span>
        </div>

        {store.audioUrl && <audio className={styles.audio} controls src={store.audioUrl} autoPlay={store.autoPlay} />}
        {store.info && <div className={styles.dim}>{store.info}</div>}

        {/* streaming sentences */}
        {store.streamSentences.length > 0 && (
          <div className={styles.streamBox}>
            <div className={styles.dim}>{store.streamSummary || `${store.streamSentences.filter((s) => s.status === 'ready').length}/${store.streamSentences.length} ready`}</div>
            {store.streamSentences.map((s) => (
              <div key={s.i} className={styles.streamRow}>
                <span className={s.status === 'ready' ? styles.up : s.status === 'error' ? styles.down : styles.unknown}>{s.status}</span>
                <span className={styles.streamTxt}>{s.txt}</span>
                {s.url && <audio controls src={s.url} className={styles.streamAudio} />}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── RVC Voice Conversion ── */}
      <section className={styles.card}>
        <div className={styles.head}><h4 className={styles.h4}>RVC Voice Conversion</h4><span className={styles.dim}>{store.rvcStatus}</span>
          <span className={styles.spacer} />
          <label className={styles.check}><input type="checkbox" checked={store.rvcEnabled} onChange={(e) => store.set('rvcEnabled', e.target.checked)} /> Route TTS through RVC</label>
        </div>
        <div className={styles.grid2}>
          <label className={styles.field}><span>RVC model</span>
            <select value={store.rvcModel} onChange={(e) => store.set('rvcModel', e.target.value)}>
              <option value="">— select —</option>
              {store.rvcModels.map((m) => <option key={m.name} value={m.name}>{m.name}{m.loaded ? ' (loaded)' : ''}</option>)}
            </select></label>
          <label className={styles.field}><span>F0 method</span>
            <select value={store.rvcF0Method} onChange={(e) => store.set('rvcF0Method', e.target.value)}>{['rmvpe', 'harvest', 'crepe', 'pm'].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        </div>
        <div className={styles.sliders}>
          <Slider label="F0 key " k="rvcF0Key" min={-12} max={12} step={1} unit=" st" />
          <Slider label="Index rate " k="rvcIndexRate" min={0} max={1} step={0.05} />
          <Slider label="Filter radius " k="rvcFilter" min={0} max={7} step={1} />
          <Slider label="RMS mix " k="rvcRmsMix" min={0} max={1} step={0.05} />
          <Slider label="Protect " k="rvcProtect" min={0} max={0.5} step={0.01} />
        </div>
        <div className={styles.actions}>
          <input ref={rvcFileRef} type="file" accept="audio/*" className={styles.fileInput} />
          <button className={styles.btn} disabled={store.busy} onClick={() => { const f = rvcFileRef.current?.files?.[0]; if (f) void store.rvcConvert(f) }}>Convert uploaded file</button>
          <button className={styles.btn} onClick={() => void store.loadRvcModels()}><RefreshCw size={13} /> Refresh models</button>
        </div>
      </section>

      {/* ── Pipeline defaults (persisted, server-side) ── */}
      <section className={styles.card}>
        <div className={styles.head}>
          <h4 className={styles.h4}>Pipeline Defaults</h4>
          <span className={styles.dim}>{store.pipelineStatus}</span>
          <span className={styles.spacer} />
          <label className={styles.check}>
            <input type="checkbox" checked={store.pipelineRvcEnabled}
              onChange={(e) => store.set('pipelineRvcEnabled', e.target.checked)} />
            {' '}Route ALL TTS through RVC by default
          </label>
        </div>
        <div className={styles.dim} style={{ marginBottom: 8 }}>
          Saved on the server and applied to every TTS request from every caller —
          agents, SillyTavern, Home Assistant. Unlike the test controls above, this
          is not per-request. A caller can still override any field, or send
          <code> rvc: false </code> to bypass the pipeline for one request.
        </div>
        <div className={styles.grid}>
          <label className={styles.field}><span>Default RVC model</span>
            <select value={store.pipelineRvcModel}
              onChange={(e) => store.set('pipelineRvcModel', e.target.value)}>
              <option value="">— none —</option>
              {store.rvcModels.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select></label>
          <label className={styles.field}><span>Default F0 method</span>
            <select value={store.pipelineRvcF0Method}
              onChange={(e) => store.set('pipelineRvcF0Method', e.target.value)}>
              {['rmvpe', 'harvest', 'crepe', 'pm'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select></label>
          <label className={styles.field}><span>Resample (Hz)</span>
            <input type="number" value={store.pipelineRvcResampleSr} min={0} step={1000}
              onChange={(e) => store.set('pipelineRvcResampleSr', Number(e.target.value))} /></label>
        </div>
        <div className={styles.sliders}>
          <Slider label="F0 key " k="pipelineRvcF0Key" min={-12} max={12} step={1} unit=" st" />
          <Slider label="Index rate " k="pipelineRvcIndexRate" min={0} max={1} step={0.05} />
          <Slider label="Filter radius " k="pipelineRvcFilter" min={0} max={7} step={1} />
          <Slider label="RMS mix " k="pipelineRvcRmsMix" min={0} max={1} step={0.05} />
          <Slider label="Protect " k="pipelineRvcProtect" min={0} max={0.5} step={0.01} />
        </div>
        <div className={styles.actions}>
          <button className={styles.btnPrimary} disabled={store.pipelineSaving}
            onClick={() => void store.savePipelineConfig()}>
            {store.pipelineSaving ? 'Saving…' : 'Save defaults'}
          </button>
          <button className={styles.btn} disabled={store.pipelineSaving}
            onClick={() => void store.loadPipelineConfig()}>Revert</button>
        </div>
      </section>

      <ActivityLog />
    </div>
  )
})
