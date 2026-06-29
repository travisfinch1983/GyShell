import { makeAutoObservable, runInAction } from 'mobx'
import { ttsLogStore } from './ttsLogStore'
import { uiPrefsStore } from './uiPrefsStore'

const log = (m: string, l: any = 'info') => ttsLogStore.log(m, l)

/** Direct same-origin HTTP to the native universal proxy (Vite proxies /api → :17890).
 *  Used instead of the WS bridge because TTS returns binary audio / SSE streams. */
async function jget(path: string): Promise<any> {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.trim())
  return r.json()
}
async function jpost(path: string, body: any): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

const ENGINE_MAP: Record<string, string> = { 'dramabox': 'dramabox', 'qwen-tts': 'qwen3-tts', 'proxlab-tts': 'chatterbox', 'chatterbox': 'chatterbox' }
const NAME_MAP: Record<string, string> = { 'proxlab-tts': 'Chatterbox (multi-TTS)', 'qwen-tts': 'Qwen3-TTS', 'dramabox': 'Dramabox' }
const TTS_DEFAULTS = { speed: 1.0, temperature: 0.8, topK: 1000, topP: 0.95, repPen: 1.2, exag: 0.5, cfg: 0.5, minP: 0.05 }
const TAGS = ['laugh', 'chuckle', 'sigh', 'gasp', 'cough', 'groan', 'sniff', 'shush', 'clear throat']

export class TtsTestStore {
  // service / engine
  services: { id: string; label: string; base: string; engine: string }[] = []
  selectedService = 'multi-tts'
  endpoint = '' // custom URL
  engine = 'chatterbox'
  engineDetail = ''
  backendName = ''
  // voices / models / format
  voices: { name: string; kind: string; label: string }[] = []
  selectedVoice = ''
  models: string[] = []
  selectedModel = 'chatterbox-turbo'
  format = 'wav'
  // params
  text = 'Hello! This is a test of the Proxlab TTS system.'
  speed = TTS_DEFAULTS.speed; temperature = TTS_DEFAULTS.temperature; topK = TTS_DEFAULTS.topK
  topP = TTS_DEFAULTS.topP; repPen = TTS_DEFAULTS.repPen; exag = TTS_DEFAULTS.exag; cfg = TTS_DEFAULTS.cfg; minP = TTS_DEFAULTS.minP
  qwenLanguage = 'Auto'; qwenInstruction = ''
  dbCfg = 2.5; dbStg = 1.5; dbDurMult = 1.1; dbSeed = 42; dbNoWatermark = false
  // presets
  presets: Record<string, any> = {}
  selectedPreset = ''
  // rvc
  rvcEnabled = false; rvcModels: { name: string; loaded: boolean }[] = []; rvcModel = ''
  rvcF0Method = 'rmvpe'; rvcF0Key = 0; rvcIndexRate = 0.75; rvcFilter = 3; rvcRmsMix = 0.25; rvcProtect = 0.33
  rvcStatus = ''
  // streaming
  streaming = false
  streamSentences: any[] = []
  streamSummary = ''
  // output
  status = ''; info = ''; audioUrl = ''
  busy = false
  loaded = false
  readonly TAGS = TAGS

  constructor() { makeAutoObservable(this) }

  get isCustom() { return this.selectedService === 'custom' }
  // Turbo only when the model id says so; plain "chatterbox" / "chatterbox (original)" is the 7-setting model.
  get isTurbo() { return /turbo/i.test(this.selectedModel) }
  get isQwen() { return this.engine === 'qwen3-tts' }
  get isDramabox() { return this.engine === 'dramabox' }
  get isChatterbox() { return this.engine === 'chatterbox' }
  get voiceDesign() { return /VoiceDesign/i.test(this.selectedModel) || /VoiceDesign/i.test(this.engineDetail) }
  get cloneOnQwen() { return this.isQwen && this.selectedVoice && this.voices.find((v) => v.name === this.selectedVoice)?.kind === 'clone' }
  /** The multi-TTS aggregator endpoint always drives the streaming pipeline (handles RVC, won't time out). */
  get isMultiTts() { const b = this.activeBase(); return !b || b.includes('/multi-tts') }

  /** Single entry point — endpoint decides the path (no separate stream toggle). */
  async submit(): Promise<void> {
    if (this.isMultiTts) await this.streamGenerate()
    else await this.generate()
  }

  normalizeBase(url: string): string { return (url || '').replace(/\/+$/, '').replace(/\/v1$/, '') }
  /** Custom endpoints are absolute http(s) URLs to LAN services — route them through the backend
   *  passthrough so the browser never fetches a private IP directly (no PNA prompt / mixed content). */
  private u(url: string): string {
    return /^https?:\/\//i.test(url) ? `/api/proxy/passthrough?url=${encodeURIComponent(url)}` : url
  }
  activeBase(): string {
    if (this.isCustom) return this.normalizeBase(this.endpoint)
    return this.services.find((s) => s.id === this.selectedService)?.base || '/api/proxy/multi-tts'
  }

  set<K extends keyof TtsTestStore>(k: K, v: any): void { (this as any)[k] = v; this.persist() }

  async load(): Promise<void> {
    await uiPrefsStore.ensureLoaded()
    this.restore()
    await this.populateServices()
    // auto-detect running proxlab-tts endpoint if no custom set
    if (!this.endpoint) {
      try {
        const a = await jget('/api/ai/active-services')
        const svc: any = Object.values(a?.services || {}).find((s: any) => s.providerId === 'proxlab-tts')
        if (svc?.containerIp && svc?.port) this.endpoint = `http://${svc.containerIp}:${svc.port}`
      } catch { /* ignore */ }
    }
    await this.detectEngine()
    await Promise.all([this.refreshVoices(), this.refreshModels(), this.refreshPresets(), this.loadRvcModels()])
    runInAction(() => { this.loaded = true })
  }

  async populateServices(): Promise<void> {
    try {
      const d = await jget('/api/proxy/services')
      const tts = (d?.tts || []).filter((s: any) => s.providerId !== 'rvc')
      const list: any[] = []
      if (tts.some((s: any) => s.providerId === 'proxlab-tts')) list.push({ id: 'multi-tts', label: 'Chatterbox (multi-TTS aggregator)', base: '/api/proxy/multi-tts', engine: 'chatterbox' })
      const seen = new Set<string>()
      for (const s of tts) {
        if (s.providerId === 'proxlab-tts' || seen.has(s.providerId)) continue
        seen.add(s.providerId)
        list.push({ id: s.providerId, label: NAME_MAP[s.providerId] || s.providerId, base: `/api/proxy/${s.providerId}`, engine: ENGINE_MAP[s.providerId] || 'unknown' })
      }
      list.push({ id: 'custom', label: 'Custom endpoint…', base: '', engine: '' })
      runInAction(() => { this.services = list })
    } catch (e: any) { log(`Service list failed: ${e?.message || e}`, 'warn') }
  }

  async detectEngine(): Promise<void> {
    const base = this.activeBase()
    if (!this.isCustom && this.selectedService !== 'multi-tts') {
      const eng = this.services.find((s) => s.id === this.selectedService)?.engine
      if (eng && eng !== 'unknown') { runInAction(() => { this.engine = eng; this.engineDetail = '' }); return }
    }
    if (base.includes('/multi-tts') || base === '/api/proxy/multi-tts') { runInAction(() => { this.engine = 'chatterbox'; this.engineDetail = 'multi-TTS aggregator' }); return }
    try {
      const h = await jget(this.u(`${base}/health`))
      runInAction(() => {
        if (h?.engine === 'dramabox') { this.engine = 'dramabox'; this.engineDetail = `Dramabox · ${h.sample_rate || ''}Hz` }
        else if (h?.engine === 'chatterbox') { this.engine = 'chatterbox'; this.engineDetail = 'Chatterbox' }
        else if (h?.backend) { this.engine = 'qwen3-tts'; this.backendName = h.backend.name || ''; this.engineDetail = `Qwen3-TTS · ${h.backend.name || ''} · ${h.backend.model_id || ''}` }
        else { this.engine = 'unknown'; this.engineDetail = '' }
      })
    } catch { runInAction(() => { this.engine = 'unknown'; this.engineDetail = 'health probe failed' }) }
  }

  async refreshVoices(): Promise<void> {
    const base = this.activeBase()
    let url: string
    if (this.isQwen) url = `${base}/v1/audio/voices`
    else if (base.includes('/multi-tts')) url = `${base}/voices`
    else if (this.isDramabox) url = `${base || '/api/proxy/dramabox'}/v1/voices`
    else if (this.isChatterbox && !this.isCustom) url = `${base}/voices`
    else url = base ? `${base}/v1/voices` : '/api/proxy/multi-tts/voices'
    try {
      const d = await jget(this.u(url))
      const arr: any[] = d?.voices || d || []
      const out = arr.map((v: any) => {
        const name = typeof v === 'string' ? v : (v.name || v.id)
        const kind = v?.kind || (this.isQwen ? 'preset' : 'native')
        const dur = v?.duration ? ` (${Math.round(v.duration)}s)` : ''
        const lang = v?.language ? ` [${v.language}]` : ''
        const prefix = kind === 'clone' ? '[clone] ' : kind === 'preset' ? '[preset] ' : ''
        return { name, kind, label: `${prefix}${name}${dur}${lang}` }
      })
      // qwen unions chatterbox clone library
      if (this.isQwen) {
        try {
          const cl = await jget('/api/proxy/multi-tts/voices')
          for (const v of (cl?.voices || [])) { const name = typeof v === 'string' ? v : v.name; if (!out.find((o) => o.name === name)) out.push({ name, kind: 'clone', label: `[clone] ${name}` }) }
        } catch { /* ignore */ }
      }
      runInAction(() => { this.voices = out; if (!out.find((o) => o.name === this.selectedVoice)) this.selectedVoice = out[0]?.name || '' })
      log(`Loaded ${out.length} voices`, 'ok')
    } catch (e: any) { log(`Voice list failed: ${e?.message || e}`, 'warn') }
  }

  async refreshModels(): Promise<void> {
    const base = this.activeBase()
    if (base.includes('/multi-tts')) return
    try {
      const d = await jget(this.u(`${base}/v1/models`))
      const ms = (d?.data || d?.models || []).map((m: any) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean) as string[]
      runInAction(() => { if (ms.length) { this.models = ms; if (!ms.includes(this.selectedModel)) this.selectedModel = ms[0] } })
    } catch { /* models optional */ }
  }

  async refreshPresets(): Promise<void> {
    try { const d = await jget('/api/proxy/multi-tts/voice-presets'); runInAction(() => { this.presets = d || {} }) } catch { /* ignore */ }
  }
  applyPreset(p: any): void {
    if (!p) return
    runInAction(() => {
      if (p.voice) this.selectedVoice = p.voice
      if (p.model) this.selectedModel = p.model
      if (p.response_format) this.format = p.response_format
      if (p.speed != null) this.speed = p.speed
      if (p.temperature != null) this.temperature = p.temperature
      if (p.top_k != null) this.topK = p.top_k
      if (p.top_p != null) this.topP = p.top_p
      if (p.repetition_penalty != null) this.repPen = p.repetition_penalty
      if (p.exaggeration != null) this.exag = p.exaggeration
      if (p.cfg_weight != null) this.cfg = p.cfg_weight
      if (p.min_p != null) this.minP = p.min_p
      if (p.rvc_model) { this.rvcEnabled = true; this.rvcModel = p.rvc_model }
      if (p.rvc_params) { const r = p.rvc_params; this.rvcF0Method = r.f0_method ?? this.rvcF0Method; this.rvcF0Key = r.f0_up_key ?? this.rvcF0Key; this.rvcIndexRate = r.index_rate ?? this.rvcIndexRate; this.rvcRmsMix = r.rms_mix_rate ?? this.rvcRmsMix; this.rvcProtect = r.protect ?? this.rvcProtect }
    })
    this.persist()
  }
  async loadPreset(name: string): Promise<void> { if (!name) return; try { const p = await jget(`/api/proxy/multi-tts/voice-presets/${encodeURIComponent(name)}`); this.applyPreset(p); log(`Loaded preset "${name}"`, 'ok') } catch (e: any) { log(`Load preset failed: ${e?.message || e}`, 'err') } }
  async savePreset(name: string): Promise<void> {
    if (!name?.trim()) return
    const preset: any = { voice: this.selectedVoice, model: this.selectedModel, response_format: this.format, speed: this.speed, temperature: this.temperature, top_p: this.topP, repetition_penalty: this.repPen }
    if (this.isTurbo) preset.top_k = this.topK; else { preset.exaggeration = this.exag; preset.cfg_weight = this.cfg; preset.min_p = this.minP }
    if (this.rvcEnabled) { preset.rvc_model = this.rvcModel; preset.rvc_params = this.rvcParams() }
    const r = await jpost('/api/proxy/multi-tts/voice-presets', { name: name.trim(), ...preset })
    if (r.ok) { log(`Saved preset "${name.trim()}"`, 'ok'); await this.refreshPresets(); runInAction(() => { this.selectedPreset = name.trim() }) } else log(`Save preset failed: ${r.status}`, 'err')
  }
  async deletePreset(name: string): Promise<void> { if (!name) return; await fetch(`/api/proxy/multi-tts/voice-presets/${encodeURIComponent(name)}`, { method: 'DELETE' }); await this.refreshPresets(); runInAction(() => { this.selectedPreset = '' }); log(`Deleted preset "${name}"`, 'ok') }

  rvcParams() { return { rvc_model: this.rvcModel, f0_method: this.rvcF0Method, f0_up_key: this.rvcF0Key, index_rate: this.rvcIndexRate, filter_radius: this.rvcFilter, rms_mix_rate: this.rvcRmsMix, protect: this.rvcProtect } }
  async loadRvcModels(): Promise<void> {
    try {
      const d = await jget('/api/proxy/rvc/models')
      const ms = (d?.models || []).map((m: any) => ({ name: m.name || m, loaded: !!m.loaded }))
      runInAction(() => { this.rvcModels = ms; if (!ms.find((m: any) => m.name === this.rvcModel)) this.rvcModel = ms[0]?.name || ''; this.rvcStatus = `${ms.length} model(s)` })
    } catch { runInAction(() => { this.rvcStatus = 'RVC service offline' }) }
  }

  private genParams(): any {
    const p: any = { speed: this.speed, temperature: this.temperature, top_p: this.topP }
    if (this.isQwen) { if (this.qwenLanguage && this.qwenLanguage !== 'Auto') p.language = this.qwenLanguage; if (this.qwenInstruction) p.instruct = this.qwenInstruction }
    if (this.isChatterbox) { p.repetition_penalty = this.repPen; if (this.isTurbo) p.top_k = this.topK; else { p.exaggeration = this.exag; p.cfg_weight = this.cfg; p.min_p = this.minP } }
    return p
  }

  insertTag(tag: string): void { this.text = `${this.text} [${tag}] `.replace(/\s+\[/g, ' ['); this.persist() }

  async generate(): Promise<void> {
    const base = this.activeBase()
    if (!base && !this.isDramabox) { runInAction(() => { this.status = 'No endpoint selected' }); return }
    if (!this.text.trim()) { runInAction(() => { this.status = 'Enter text' }); return }
    if (this.rvcEnabled && !this.rvcModel) { runInAction(() => { this.status = 'Select an RVC model' }); return }
    runInAction(() => { this.busy = true; this.status = 'Generating…'; this.info = '' })
    const gp = this.genParams()
    let resp: Response
    try {
      if (this.rvcEnabled) { log('Generate via RVC pipeline'); resp = await jpost('/api/proxy/rvc/pipeline', { input: this.text, voice: this.selectedVoice, response_format: this.format, ...gp, ...this.rvcParams(), output_format: this.format }) }
      else if (this.cloneOnQwen && !this.voiceDesign) { log('Generate via cloned-speech (Qwen)'); resp = await jpost('/api/proxy/multi-tts/v1/audio/cloned-speech', { voice_name: this.selectedVoice, input: this.text, target_endpoint: base, response_format: this.format, ...gp }) }
      else if (this.isDramabox) { const drBase = base || '/api/proxy/dramabox'; log('Generate via Dramabox'); resp = await jpost(this.u(`${drBase}/generate`), { prompt: this.text, voice: this.selectedVoice || 'none', response_format: this.format, cfg_scale: this.dbCfg, stg_scale: this.dbStg, duration_multiplier: this.dbDurMult, seed: this.dbSeed, no_watermark: this.dbNoWatermark }) }
      else { resp = await jpost(this.u(`${base}/v1/audio/speech`), { model: this.selectedModel, input: this.text, voice: this.selectedVoice, response_format: this.format, ...gp }) }
      if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`.trim())
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      runInAction(() => { if (this.audioUrl) URL.revokeObjectURL(this.audioUrl); this.audioUrl = url; this.status = 'Done'; this.info = `${this.format} · ${(blob.size / 1024).toFixed(0)} KB · ${this.text.length} chars · voice ${this.selectedVoice || '—'}${this.rvcEnabled ? ` · RVC ${this.rvcModel}` : ''}` })
      log(`Generated ${(blob.size / 1024).toFixed(0)} KB ${this.format}`, 'ok')
    } catch (e: any) { runInAction(() => { this.status = 'Error: ' + (e?.message || e) }); log(`Generate failed: ${e?.message || e}`, 'err') }
    finally { runInAction(() => { this.busy = false }) }
  }

  async streamGenerate(): Promise<void> {
    if (!this.text.trim()) return
    runInAction(() => { this.streaming = true; this.streamSentences = []; this.streamSummary = ''; this.status = 'Streaming…' })
    const body: any = { input: this.text, voice: this.selectedVoice, model: this.selectedModel, output_format: this.format, speed: this.speed, temperature: this.temperature, top_p: this.topP, repetition_penalty: this.repPen }
    if (this.isTurbo) body.top_k = this.topK; else { body.exaggeration = this.exag; body.cfg_weight = this.cfg; body.min_p = this.minP }
    if (this.rvcEnabled) Object.assign(body, this.rvcParams())
    try {
      const resp = await jpost('/api/proxy/multi-tts/stream', body)
      if (!resp.ok || !resp.body) throw new Error(`stream ${resp.status}`)
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n'); buf = parts.pop() || ''
        for (const part of parts) {
          let ev = 'message'; let data = ''
          for (const line of part.split('\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim() }
          if (!data) continue
          let payload: any; try { payload = JSON.parse(data) } catch { continue }
          this.handleStreamEvent(ev, payload)
        }
      }
    } catch (e: any) { runInAction(() => { this.status = 'Stream error: ' + (e?.message || e) }); log(`Stream failed: ${e?.message || e}`, 'err') }
    finally { runInAction(() => { this.streaming = false }) }
  }
  private handleStreamEvent(ev: string, d: any): void {
    runInAction(() => {
      if (ev === 'info') {
        // The native /multi-tts/stream sends `sentences` as a COUNT (number); older/array form also handled.
        const arr = Array.isArray(d.sentences) ? d.sentences : null
        const n = arr ? arr.length : (Number(d.sentences) || 0)
        this.streamSentences = Array.from({ length: n }, (_, i) => ({ i, txt: arr ? arr[i] : '', status: 'pending', url: '', detail: null }))
        this.status = `Streaming ${n} sentences · ${d.pipelines || d.tts_instances || 1} pipelines`
      }
      else if (ev === 'audio') { const s = this.streamSentences[d.index]; if (s) { try { const bin = atob(d.audio); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); s.url = URL.createObjectURL(new Blob([u8], { type: 'audio/wav' })) } catch { /* ignore */ } s.status = 'ready'; if (d.text) s.txt = d.text; s.detail = d } }
      else if (ev === 'error') { const s = this.streamSentences[d.index]; if (s) s.status = 'error' }
      else if (ev === 'done') { this.streamSummary = `Done · ${d.total_sentences || this.streamSentences.length} sentences`; this.status = 'Stream complete' }
    })
  }

  async rvcConvert(file: File): Promise<void> {
    if (!file || !this.rvcModel) { runInAction(() => { this.rvcStatus = 'Pick a file + model' }); return }
    runInAction(() => { this.busy = true; this.rvcStatus = 'Converting…' })
    try {
      const fd = new FormData()
      fd.append('file', file); fd.append('model_name', this.rvcModel); fd.append('f0_method', this.rvcF0Method); fd.append('f0_up_key', String(this.rvcF0Key)); fd.append('index_rate', String(this.rvcIndexRate)); fd.append('filter_radius', String(this.rvcFilter)); fd.append('rms_mix_rate', String(this.rvcRmsMix)); fd.append('protect', String(this.rvcProtect)); fd.append('output_format', 'wav')
      const r = await fetch('/api/proxy/rvc/convert', { method: 'POST', body: fd })
      if (!r.ok) throw new Error(`${r.status}`)
      const url = URL.createObjectURL(await r.blob())
      runInAction(() => { if (this.audioUrl) URL.revokeObjectURL(this.audioUrl); this.audioUrl = url; this.rvcStatus = 'Converted' })
      log(`RVC convert done (${this.rvcModel})`, 'ok')
    } catch (e: any) { runInAction(() => { this.rvcStatus = 'Error: ' + (e?.message || e) }); log(`RVC convert failed: ${e?.message || e}`, 'err') }
    finally { runInAction(() => { this.busy = false }) }
  }

  resetDefaults(): void { Object.assign(this, TTS_DEFAULTS); this.persist() }

  // ─── persistence (backend, via uiPrefsStore) ───
  persist(): void {
    uiPrefsStore.set('ttsTest', {
      selectedService: this.selectedService, endpoint: this.endpoint, selectedVoice: this.selectedVoice, selectedModel: this.selectedModel, format: this.format,
      speed: this.speed, temperature: this.temperature, topK: this.topK, topP: this.topP, repPen: this.repPen, exag: this.exag, cfg: this.cfg, minP: this.minP,
      qwenLanguage: this.qwenLanguage, qwenInstruction: this.qwenInstruction, text: this.text,
      dbCfg: this.dbCfg, dbStg: this.dbStg, dbDurMult: this.dbDurMult, dbSeed: this.dbSeed, dbNoWatermark: this.dbNoWatermark,
    })
    uiPrefsStore.set('ttsRvc', { rvcEnabled: this.rvcEnabled, rvcModel: this.rvcModel, rvcF0Method: this.rvcF0Method, rvcF0Key: this.rvcF0Key, rvcIndexRate: this.rvcIndexRate, rvcFilter: this.rvcFilter, rvcRmsMix: this.rvcRmsMix, rvcProtect: this.rvcProtect })
  }
  restore(): void {
    const t = uiPrefsStore.get('ttsTest', null) as any
    if (t) Object.assign(this, t)
    const r = uiPrefsStore.get('ttsRvc', null) as any
    if (r) Object.assign(this, r)
  }
}

export const ttsTestStore = new TtsTestStore()
