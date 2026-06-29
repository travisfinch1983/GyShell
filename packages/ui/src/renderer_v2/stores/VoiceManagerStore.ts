import { makeAutoObservable, runInAction } from 'mobx'
import { ttsLogStore } from './ttsLogStore'
import { uiPrefsStore } from './uiPrefsStore'

const log = (m: string, l: any = 'info') => ttsLogStore.log(m, l)
async function jget(p: string): Promise<any> { const r = await fetch(p); if (!r.ok) throw new Error(`${r.status}`); return r.json() }
async function jpost(p: string, b?: any): Promise<Response> { return fetch(p, { method: 'POST', headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }) }

export const STEP_COLORS: Record<string, string> = { original: '#64748b', base: '#64748b', isolate: '#4ea1ff', denoise: '#22d3ee', upscale: '#a78bfa', pipeline: '#f472b6', trim: '#4ade80' }
export const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`)
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export class VoiceManagerStore {
  loaded = false
  // Audio Tools service
  atStatus: 'online' | 'offline' | 'starting' = 'offline'
  atServiceId = ''
  atDetail = ''
  // saved voices
  voices: { name: string; duration: number }[] = []
  // workspace
  wsId = ''
  filename = ''
  origPeaks: number[][] = []
  layers: { type: string; peaks: number[][] }[] = []
  duration = 0
  origDuration = 0
  sampleRate = 0
  historyCount = 0
  steps: any[] = []
  selStart = 0
  selEnd = 0
  shifts = 2
  timestep = 2
  busy = false
  progress = 0
  progressText = ''
  saveName = ''
  status = ''
  // file browser
  fbOpen = false
  fbDir = '/claude'
  fbDirs: { name: string; path: string }[] = []
  fbFiles: { name: string; path: string; size: number; isVideo: boolean }[] = []
  fbTarget: 'workspace' | 'ripper' = 'workspace'
  fbStatus = ''
  // audio ripper
  arFile: File | null = null
  arServerPath = ''
  arSavePath = '/claude/ripped-audio/'
  arProgress = 0
  arStatus = ''
  arBusy = false

  constructor() { makeAutoObservable(this) }

  get hasWorkspace() { return !!this.wsId }
  get selDuration() { return Math.max(0, this.selEnd - this.selStart) }
  set<K extends keyof VoiceManagerStore>(k: K, v: any): void { (this as any)[k] = v }

  async load(): Promise<void> {
    await uiPrefsStore.ensureLoaded()
    await Promise.all([this.atCheckStatus(), this.loadVoices()])
    // resume saved workspace session
    const sess = uiPrefsStore.get('vmSession', '') as string
    if (sess) { try { await jget(`/api/ai/workspace/${sess}/info`); await this.loadWorkspace(sess) } catch { uiPrefsStore.set('vmSession', '') } }
    runInAction(() => { this.loaded = true })
  }

  // ── Audio Tools service ──
  async atCheckStatus(): Promise<void> {
    try {
      const a = await jget('/api/ai/active-services')
      const svc: any = Object.values(a?.services || {}).find((s: any) => s.providerId === 'audio-tools')
      if (svc) { runInAction(() => { this.atStatus = 'online'; this.atServiceId = svc.id || svc.serviceId || ''; this.atDetail = `${svc.containerIp}:${svc.port}` }); return }
    } catch { /* ignore */ }
    try { const h = await jget('/api/proxy/audio-tools/health'); runInAction(() => { this.atStatus = 'online'; this.atServiceId = ''; this.atDetail = h?.gpu ? `${h.gpu} · ${h.vram_used_mb || '?'}/${h.vram_total_mb || '?'}MB` : 'running (unregistered)' }) }
    catch { runInAction(() => { this.atStatus = 'offline'; this.atDetail = '' }) }
  }
  async atStart(): Promise<void> {
    runInAction(() => { this.atStatus = 'starting' })
    log('Starting Audio Tools service…')
    const body = { node: 'px-gpu', providerId: 'audio-tools', command: 'CUDA_VISIBLE_DEVICES=7 source /opt/miniconda3/etc/profile.d/conda.sh && conda activate audio-tools && cd /opt/proxlab-audio-tools && python server.py --port 8890', port: 8890, tmuxSession: 'audio-tools-8890', cudaDevices: [7], isTools: true }
    try {
      const r = await jpost('/api/ai/launch-service', body)
      if (!r.ok && r.status !== 409) throw new Error(`${r.status} ${await r.text().catch(() => '')}`)
      for (let i = 0; i < 30; i++) { await new Promise((res) => setTimeout(res, 2000)); try { await jget('/api/proxy/audio-tools/health'); break } catch { /* keep polling */ } }
      await this.atCheckStatus(); log('Audio Tools online', 'ok')
    } catch (e: any) { runInAction(() => { this.atStatus = 'offline' }); log(`Audio Tools start failed: ${e?.message || e}`, 'err') }
  }
  async atStop(): Promise<void> {
    if (!this.atServiceId) return
    await jpost(`/api/ai/active-services/${encodeURIComponent(this.atServiceId)}/kill`)
    await this.atCheckStatus(); log('Audio Tools stopped', 'warn')
  }

  // ── saved voices ──
  async loadVoices(): Promise<void> {
    try { const d = await jget('/api/proxy/multi-tts/voices'); const arr = (d?.voices || []).map((v: any) => ({ name: typeof v === 'string' ? v : v.name, duration: v?.duration || 0 })); runInAction(() => { this.voices = arr }) }
    catch { /* ignore */ }
  }
  async deleteVoice(name: string): Promise<void> { await fetch(`/api/proxy/multi-tts/voices/${encodeURIComponent(name)}`, { method: 'DELETE' }); await this.loadVoices(); log(`Deleted voice "${name}"`, 'ok') }

  // ── workspace lifecycle ──
  async createFromFile(file: File): Promise<void> {
    runInAction(() => { this.status = 'Uploading…' })
    const fd = new FormData(); fd.append('file', file)
    try { const r = await fetch('/api/ai/workspace', { method: 'POST', body: fd }); const d = await r.json(); if (!r.ok) throw new Error(d?.error || r.status); await this.loadWorkspace(d.id) }
    catch (e: any) { runInAction(() => { this.status = 'Upload failed: ' + (e?.message || e) }); log(`Workspace upload failed: ${e?.message || e}`, 'err') }
  }
  async createFromServer(path: string): Promise<void> {
    try { const r = await jpost('/api/ai/workspace', { source: 'server', path }); const d = await r.json(); if (!r.ok) throw new Error(d?.error || r.status); await this.loadWorkspace(d.id) }
    catch (e: any) { runInAction(() => { this.status = 'Load failed: ' + (e?.message || e) }); log(`Workspace from server failed: ${e?.message || e}`, 'err') }
  }
  async loadWorkspace(id: string, width = 1000): Promise<void> {
    try {
      const [info, peaks, layers] = await Promise.all([
        jget(`/api/ai/workspace/${id}/info`),
        jget(`/api/ai/workspace/${id}/peaks?source=original&width=${width}`),
        jget(`/api/ai/workspace/${id}/layers`),
      ])
      runInAction(() => {
        this.wsId = id; this.filename = info.filename || ''
        this.origPeaks = peaks.peaks || []; this.origDuration = peaks.duration || info.duration || 0; this.sampleRate = info.sampleRate || 0
        this.duration = info.duration || 0; this.historyCount = info.historyCount || 0; this.steps = info.steps || []
        this.layers = layers.layers || []
        this.selStart = 0; this.selEnd = this.duration
      })
      uiPrefsStore.set('vmSession', id)
      log(`Workspace loaded: ${info.filename || id} (${this.duration.toFixed(1)}s)`, 'ok')
      if (this.duration < 5) log('Audio under 5s — too short to save as a voice', 'warn')
    } catch (e: any) { log(`Load workspace failed: ${e?.message || e}`, 'err') }
  }
  async refreshLayers(): Promise<void> {
    if (!this.wsId) return
    try {
      const [info, layers] = await Promise.all([jget(`/api/ai/workspace/${this.wsId}/info`), jget(`/api/ai/workspace/${this.wsId}/layers`)])
      runInAction(() => { this.duration = info.duration || 0; this.historyCount = info.historyCount || 0; this.steps = info.steps || []; this.layers = layers.layers || []; if (this.selEnd > this.duration || this.selEnd === 0) this.selEnd = this.duration })
    } catch { /* ignore */ }
  }
  closeWorkspace(): void { runInAction(() => { this.wsId = ''; this.origPeaks = []; this.layers = []; this.duration = 0; this.historyCount = 0; this.steps = []; this.selStart = 0; this.selEnd = 0 }); uiPrefsStore.set('vmSession', '') }

  // ── workspace ops ──
  async process(action: string): Promise<void> {
    if (!this.wsId) return
    runInAction(() => { this.busy = true; this.progress = 30; this.progressText = `${action}…` })
    log(`Workspace: ${action}…`)
    const body: any = { action }
    if (action === 'isolate' || action === 'pipeline') body.shifts = this.shifts
    if (action === 'upscale' || action === 'pipeline') body.timestep = this.timestep
    try { const r = await jpost(`/api/ai/workspace/${this.wsId}/process`, body); if (!r.ok) throw new Error(await r.text()); await this.refreshLayers(); log(`${action} done`, 'ok') }
    catch (e: any) { log(`${action} failed: ${e?.message || e}`, 'err') }
    finally { runInAction(() => { this.busy = false; this.progress = 0; this.progressText = '' }) }
  }
  async undo(): Promise<void> { if (this.wsId) { await jpost(`/api/ai/workspace/${this.wsId}/undo`); await this.refreshLayers() } }
  async reset(): Promise<void> { if (this.wsId) { await jpost(`/api/ai/workspace/${this.wsId}/reset`); await this.refreshLayers() } }
  async rollback(idx: number): Promise<void> { if (this.wsId) { await jpost(`/api/ai/workspace/${this.wsId}/rollback/${idx}`); await this.refreshLayers() } }
  async trim(): Promise<void> { if (this.wsId) { await jpost(`/api/ai/workspace/${this.wsId}/trim`, { start: this.selStart, end: this.selEnd }); await this.refreshLayers() } }
  download(): void { if (this.wsId) window.open(`/api/ai/workspace/${this.wsId}/download`) }
  async saveVoice(): Promise<void> {
    if (!this.wsId || !this.saveName.trim()) { runInAction(() => { this.status = 'Enter a voice name' }); return }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(this.saveName)) { runInAction(() => { this.status = 'Name: letters/numbers/_/- only' }); return }
    if (this.selDuration < 5) { runInAction(() => { this.status = 'Selection must be ≥5s' }); return }
    runInAction(() => { this.busy = true; this.status = 'Saving voice…' })
    try {
      const r = await jpost(`/api/ai/workspace/${this.wsId}/save-voice`, { name: this.saveName.trim(), start: this.selStart, end: this.selEnd })
      const d = await r.json(); if (!r.ok) throw new Error(d?.error || r.status)
      runInAction(() => { this.status = `Saved voice "${this.saveName.trim()}"` }); log(`Saved voice "${this.saveName.trim()}"`, 'ok')
      await this.loadVoices()
      if (d.workspaceClosed) this.closeWorkspace()
    } catch (e: any) { runInAction(() => { this.status = 'Save failed: ' + (e?.message || e) }); log(`Save voice failed: ${e?.message || e}`, 'err') }
    finally { runInAction(() => { this.busy = false }) }
  }

  // ── file browser ──
  openBrowser(target: 'workspace' | 'ripper'): void { runInAction(() => { this.fbTarget = target; this.fbOpen = true }); void this.fbNavigate(this.fbDir) }
  closeBrowser(): void { runInAction(() => { this.fbOpen = false }) }
  async fbNavigate(dir: string): Promise<void> {
    runInAction(() => { this.fbStatus = 'Loading…' })
    try { const d = await jget(`/api/ai/browse-files?dir=${encodeURIComponent(dir)}`); runInAction(() => { this.fbDir = dir; this.fbDirs = d.dirs || []; this.fbFiles = d.files || []; this.fbStatus = '' }) }
    catch (e: any) { runInAction(() => { this.fbStatus = 'Error: ' + (e?.message || e) }) }
  }
  fbSelect(f: { path: string }): void {
    const target = this.fbTarget
    this.closeBrowser()
    if (target === 'ripper') { runInAction(() => { this.arServerPath = f.path; this.arFile = null; this.arSavePath = '/claude/ripped-audio/' + (f.path.split('/').pop() || 'audio').replace(/\.[^.]+$/, '') + '.wav' }); log(`Ripper: selected ${f.path}`) }
    else void this.createFromServer(f.path)
  }

  // ── audio ripper ──
  async ripExtract(): Promise<void> {
    runInAction(() => { this.arBusy = true; this.arProgress = 0; this.arStatus = 'Extracting…' })
    try {
      let wav: Uint8Array
      if (this.arFile) { wav = await this.ripLocal(this.arFile) }
      else if (this.arServerPath) { wav = await this.ripServer(this.arServerPath) }
      else { runInAction(() => { this.arStatus = 'Pick a file first' }); return }
      await this.ripUpload(this.arSavePath, wav)
      runInAction(() => { this.arStatus = `Saved ${this.arSavePath}` }); log(`Audio Ripper: saved ${this.arSavePath}`, 'ok')
    } catch (e: any) { runInAction(() => { this.arStatus = 'Failed: ' + (e?.message || e) }); log(`Audio Ripper failed: ${e?.message || e}`, 'err') }
    finally { runInAction(() => { this.arBusy = false; this.arProgress = 0 }) }
  }
  private async ripServer(path: string): Promise<Uint8Array> {
    runInAction(() => { this.arStatus = 'Server extracting…' })
    const r = await fetch('/api/ai/extract-audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
    if (!r.ok || !r.body) throw new Error(`extract ${r.status}`)
    const total = Number(r.headers.get('Content-Length') || 0); const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let got = 0
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (total) runInAction(() => { this.arProgress = Math.round((got / total) * 80) }) }
    const out = new Uint8Array(got); let off = 0; for (const c of chunks) { out.set(c, off); off += c.length }
    return out
  }
  private async ripLocal(file: File): Promise<Uint8Array> {
    // ffmpeg-wasm is not bundled in AI-Lab; fall back to server-side extraction transparently.
    log('Local ffmpeg-wasm not bundled — using server extraction', 'warn')
    // Upload the file to a temp server path? Simpler: server extraction needs a server path. So local files
    // must go through a direct upload+extract. Use save-audio of the raw file then extract is overkill;
    // instead inform the user to use "From Server". For parity we attempt dynamic import, else throw clear msg.
    try {
      const ffPath = '/vendor/ffmpeg/index.js', utilPath = '/vendor/ffmpeg-util/index.js'
      const mod: any = await import(/* @vite-ignore */ ffPath)
      const { fetchFile }: any = await import(/* @vite-ignore */ utilPath)
      const ff = new mod.FFmpeg(); await ff.load({ coreURL: '/vendor/ffmpeg-core/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg-core/ffmpeg-core.wasm' })
      await ff.writeFile('in', await fetchFile(file))
      await ff.exec(['-i', 'in', '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '1', 'out.wav'])
      const data = await ff.readFile('out.wav'); return data as Uint8Array
    } catch {
      throw new Error('Local extraction unavailable (ffmpeg-wasm not bundled). Use “From Server” instead.')
    }
  }
  private async ripUpload(savePath: string, bytes: Uint8Array): Promise<void> {
    runInAction(() => { this.arProgress = 90; this.arStatus = 'Uploading…' })
    const blobSrc = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) ? bytes.buffer : bytes.slice().buffer
    const r = await fetch(`/api/ai/save-audio?path=${encodeURIComponent(savePath)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blobSrc as ArrayBuffer })
    if (!r.ok) throw new Error(`save ${r.status}`)
    runInAction(() => { this.arProgress = 100 })
  }
}

export const voiceManagerStore = new VoiceManagerStore()
