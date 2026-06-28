import { makeAutoObservable, runInAction, toJS } from 'mobx'
import {
  LAUNCH_TEMPLATES,
  MODEL_IDENTIFIER_FLAG_BY_PROVIDER,
  SLOT_SETTING_KEY_BY_PROVIDER,
} from '../components/AiLlm/launchTemplates'
import { liveConsoleStore } from './LiveConsoleStore'

/**
 * LlmLaunchStore — native port of ProxLab's LLM Launch tab engine. Drives the AI·LLM › Launch UI:
 * model/quant selection, per-engine settings, VRAM estimate + GPU placement, command building, and
 * launch (ephemeral → Live Console PTY) / launch-as-service (persistent systemd). Calls the now-native
 * /api/ai endpoints through the cluster bridge.
 */

// ─── Format → compatible engines (ported) ─────────────────────────────
const FORMAT_PROVIDER_MAP: Record<string, string[]> = {
  GGUF: ['koboldcpp', 'llama-server', 'llama-server-mtp', 'ollama'],
  FP16: ['vllm', '1cat-vllm', 'lmdeploy', 'sglang', 'aphrodite'],
  BF16: ['vllm', '1cat-vllm', 'lmdeploy', 'sglang', 'aphrodite'],
  AWQ: ['vllm', '1cat-vllm', 'lmdeploy', 'sglang', 'aphrodite'],
  GPTQ: ['vllm', '1cat-vllm', 'lmdeploy', 'sglang', 'aphrodite', 'tabbyapi'],
  EXL2: ['tabbyapi', 'aphrodite'],
  EXL3: ['tabbyapi'],
}

export interface QuantRow { format: string; quant: string; bpw: number | null; path: string | null; sizeMB: number | null; onDisk: boolean }
export interface AgentGpu { cuda_index: number; pci_id: string; name: string; vram_mb: number; arch?: string; provider?: string }
export interface Agent { vmid: number; name: string; ip: string; host_node: string; gpus: AgentGpu[] }

function bridge() {
  const api = (window as any).gyshell?.cluster
  if (!api?.request) throw new Error('cluster gateway RPC not available')
  return api as { request: (method: string, path: string, body?: unknown) => Promise<unknown> }
}

export class LlmLaunchStore {
  models: any = null
  presets: any = null
  providers: any[] = []
  agents: Agent[] = []
  cacheEntries: any[] = []

  loading = false
  rescanning = false
  error = ''

  selectedFamily = ''
  selectedVariant = ''
  selectedFormat = ''
  selectedQuant = ''
  selectedBpw: number | null = null
  selectedProvider = ''
  selectedNode = ''
  settings: Record<string, any> = {}

  lastEstimate: any = null
  selectedPlacement: any = null
  manualGpus: string[] = [] // pci_ids chosen via the manual GPU bar (overrides auto-placement)
  estimating = false

  launching = false
  launchMsg = ''
  launchErr = ''

  constructor() {
    makeAutoObservable(this)
  }

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      const [scan, provs, gpus, cache] = await Promise.all([
        bridge().request('GET', '/api/ai/models/scan').catch(() => null),
        bridge().request('GET', '/api/ai/providers').catch(() => null),
        bridge().request('GET', '/api/ai/agent-gpus').catch(() => null),
        bridge().request('GET', '/api/ai/models/cache').catch(() => null),
      ])
      runInAction(() => {
        this.models = scan || { models: [] }
        this.presets = (scan as any)?.presets || null
        this.providers = ((provs as any)?.providers ?? []) as any[]
        this.agents = ((gpus as any)?.agents ?? []) as Agent[]
        this.cacheEntries = (((cache as any)?.entries ?? []) as any[]).filter((e) => e.status === 'cached' || e.cachedAt)
      })
    } catch (e: any) {
      runInAction(() => { this.error = e?.message || 'Failed to load launch data' })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  /** Full rescan — forces a fresh SSH walk of the model dirs (not the cached index). */
  async rescanAll(): Promise<void> {
    this.rescanning = true
    this.error = ''
    try {
      const scan = await bridge().request('GET', '/api/ai/models/scan?refresh=1')
      runInAction(() => {
        this.models = scan || { models: [] }
        if ((scan as any)?.presets) this.presets = (scan as any).presets
      })
    } catch (e: any) {
      runInAction(() => { this.error = e?.message || 'Rescan failed' })
    } finally {
      runInAction(() => { this.rescanning = false })
    }
  }

  /** Targeted rescan of just the selected family folder; merges fresh results into the index. */
  async rescanFamily(family: string): Promise<void> {
    if (!family) return
    this.rescanning = true
    this.error = ''
    try {
      const r: any = await bridge().request('POST', '/api/ai/models/scan/family', { family })
      runInAction(() => { if (r?.models) this.models = { ...this.models, ...r } })
    } catch (e: any) {
      runInAction(() => { this.error = e?.message || 'Family rescan failed' })
    } finally {
      runInAction(() => { this.rescanning = false })
    }
  }

  // ─── derived ───
  get families(): string[] {
    const set = new Set<string>()
    for (const m of this.models?.models ?? []) set.add(m.family)
    return [...set].sort()
  }
  variantsFor(family: string): string[] {
    return (this.models?.models ?? []).filter((m: any) => m.family === family).map((m: any) => m.variant)
  }
  get model(): any {
    return (this.models?.models ?? []).find((m: any) => m.family === this.selectedFamily && m.variant === this.selectedVariant) || null
  }

  /** One unified table of ONLY the quants actually present on disk for the selected model, any format. */
  get quantRows(): QuantRow[] {
    const m = this.model
    if (!m) return []
    const rows: QuantRow[] = []
    for (const [format, data] of Object.entries<any>(m.formats || {})) {
      if (!data || typeof data !== 'object') continue
      if (typeof data.path === 'string') {
        // flat single-variant format (e.g. FP16/BF16) → one row
        rows.push({ format, quant: format, bpw: null, path: data.path, sizeMB: data.sizeMB ?? null, onDisk: true })
        continue
      }
      for (const [quant, v] of Object.entries<any>(data)) {
        if (!v || typeof v.path !== 'string') continue // skip anything not actually on disk
        const bpw = /bpw/i.test(quant) ? parseFloat(quant) : null
        rows.push({ format, quant, bpw: Number.isFinite(bpw as number) ? bpw : null, path: v.path, sizeMB: v.sizeMB ?? null, onDisk: true })
      }
    }
    return rows
  }

  get compatibleProviders(): any[] {
    const ids = FORMAT_PROVIDER_MAP[this.selectedFormat] || []
    return this.providers.filter((p) => ids.includes(p.id))
  }
  get template(): any {
    return (LAUNCH_TEMPLATES as any)[this.selectedProvider] || null
  }

  // ─── selection actions ───
  selectModel(family: string, variant: string): void {
    this.selectedFamily = family
    this.selectedVariant = variant
    this.selectedFormat = ''
    this.selectedQuant = ''
    this.selectedBpw = null
    this.selectedProvider = ''
    this.lastEstimate = null
    this.selectedPlacement = null
  }
  selectQuant(row: QuantRow): void {
    this.selectedFormat = row.format
    this.selectedQuant = row.quant
    this.selectedBpw = row.bpw
    // auto-pick the single compatible provider if there's exactly one installed; else clear
    this.selectedProvider = ''
    this.scheduleEstimate()
  }
  selectProvider(id: string): void {
    this.selectedProvider = id
    // seed settings from template defaults
    const t = (LAUNCH_TEMPLATES as any)[id]
    const s: Record<string, any> = {}
    if (t) {
      for (const [k, a] of Object.entries<any>(t.args || {})) s[k] = a.default
      for (const [k, a] of Object.entries<any>(t.advancedArgs || {})) s[k] = a.default
    }
    this.settings = s
    this.scheduleEstimate()
  }
  setSetting(key: string, val: any): void {
    this.settings = { ...this.settings, [key]: val }
  }
  setPlacement(p: any): void {
    this.manualGpus = [] // choosing an auto/suggested placement clears the manual selection
    this.selectedPlacement = p
    this.selectedNode = p?.node || p?.gpus?.[0]?.node || this.selectedNode
  }

  /** Manual GPU bar: toggle a specific GPU, rebuilding the placement from the current selection. */
  toggleGpu(_agent: Agent, gpu: AgentGpu): void {
    this.manualGpus = this.manualGpus.includes(gpu.pci_id)
      ? this.manualGpus.filter((x) => x !== gpu.pci_id)
      : [...this.manualGpus, gpu.pci_id]
    this.applyManualPlacement()
  }
  private applyManualPlacement(): void {
    if (!this.manualGpus.length) { this.selectedPlacement = null; return }
    // A service runs on one agent: anchor to the agent of the first selected GPU, include only its picks.
    const owner = this.agents.find((a) => a.gpus.some((g) => this.manualGpus.includes(g.pci_id)))
    if (!owner) { this.selectedPlacement = null; return }
    const gpus = owner.gpus
      .filter((g) => this.manualGpus.includes(g.pci_id))
      .map((g) => ({ pciId: g.pci_id, node: owner.host_node, cudaIndex: g.cuda_index, name: g.name, vramMB: g.vram_mb }))
    this.selectedPlacement = { node: owner.host_node, gpus, manual: true }
    this.selectedNode = owner.host_node
  }

  // ─── command helpers (ported) ───
  getSelectedModelPath(): string | null {
    const m = this.model
    if (!m) return null
    const formatData = m.formats?.[this.selectedFormat]
    if (!formatData) return null
    if (this.selectedQuant && formatData[this.selectedQuant]) return formatData[this.selectedQuant].path
    if (this.selectedQuant && (this.selectedFormat === 'EXL2' || this.selectedFormat === 'EXL3')) {
      const bpwVal = parseFloat(this.selectedQuant)
      if (!isNaN(bpwVal)) for (const [k, v] of Object.entries<any>(formatData)) if (parseFloat(k) === bpwVal && v?.path) return v.path
    }
    if (formatData.path) return formatData.path
    return null
  }
  getCachedModelPath(originalPath: string | null, node: string): string | null {
    if (!originalPath || !node || !this.cacheEntries?.length) return originalPath
    for (const entry of this.cacheEntries) {
      if (entry.node !== node || entry.status !== 'cached') continue
      if (originalPath.startsWith(entry.sourceDir + '/') || originalPath === entry.sourceDir) return originalPath.replace(entry.sourceDir, entry.cacheDir)
    }
    return originalPath
  }
  get isOnDisk(): boolean {
    return this.getSelectedModelPath() !== null
  }
  getTmuxSession(): string {
    return `${this.selectedProvider}-${this.settings.port || 5001}`
  }

  /** Container-local CUDA indices for the chosen placement (PCI-sorted, matching nvidia-smi order). */
  private cudaIndices(): number[] | null {
    const p = this.selectedPlacement
    if (!p?.gpus?.length) return null
    // Manual placements carry the real container cuda_index per GPU — use it directly.
    if (p.gpus.every((g: any) => g.cudaIndex != null)) return p.gpus.map((g: any) => g.cudaIndex)
    const pNode = p.node || p.gpus[0]?.node
    const allNodeGpus = (this.lastEstimate?.availableGpus || [])
      .filter((g: any) => g.node === pNode && g.provider === 'nvidia' && g.vramMB > 0)
      .sort((a: any, b: any) => String(a.pciId).localeCompare(String(b.pciId)))
    return p.gpus.map((g: any) => {
      const idx = allNodeGpus.findIndex((ng: any) => ng.pciId === g.pciId)
      return idx >= 0 ? idx : 0
    })
  }

  /** The full multi-line launch command (env exports + exec line). Ported from buildLaunchCommand. */
  get command(): string {
    const providerId = this.selectedProvider
    const template = this.template
    if (!template) return ''
    const rawModelPath = this.getSelectedModelPath()
    if (!rawModelPath) return ''
    const modelPath = this.getCachedModelPath(rawModelPath, this.selectedNode) as string

    const cudaIdx = this.cudaIndices()
    const envLines: string[] = ['export CUDA_DEVICE_ORDER=PCI_BUS_ID']
    if (cudaIdx) envLines.push(`export CUDA_VISIBLE_DEVICES=${cudaIdx.join(',')}`)

    // kcpps path (KoboldCpp): JSON → base64 → --config
    if (template.useKcpps) {
      const config = this.buildKcppsConfig()
      if (!config) return ''
      const b64 = (typeof btoa !== 'undefined' ? btoa : (s: string) => Buffer.from(s, 'binary').toString('base64'))(JSON.stringify(config))
      const kcppsPath = `/tmp/.kcpps-${this.getTmuxSession()}.kcpps`
      return [...envLines, `echo '${b64}' | base64 -d > ${kcppsPath} && \\\n  ${template.command} --config ${kcppsPath}`].join('\n')
    }

    const parts: string[] = [template.command]
    let modelDir = modelPath
    let modelName: string | null = null
    if (template.splitModelPath && modelPath) {
      const lastSlash = modelPath.replace(/\/$/, '').lastIndexOf('/')
      if (lastSlash > 0) { modelDir = modelPath.substring(0, lastSlash); modelName = modelPath.substring(lastSlash + 1).replace(/\/$/, '') }
    }

    const emitArg = (key: string, arg: any) => {
      const flag = (arg.flagByProvider && providerId in arg.flagByProvider) ? arg.flagByProvider[providerId] : arg.flag
      if ((flag === null || flag === undefined) && !arg.positional) return
      if (arg.type === 'derived') { if (key === 'modelName' && modelName) parts.push(`${flag} ${modelName}`); return }
      let val = key === 'model' ? modelDir : (this.settings[key] ?? arg.default)
      if (key === 'speculativeConfig' && typeof val === 'string') {
        const t = val.trim(); val = t && !t.startsWith('{') && !t.startsWith('[') ? `{${t}}` : t
      }
      if (key === 'chatTemplateKwargs' && typeof val === 'string') {
        let t = val.trim(); while (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) t = t.slice(1, -1).trim(); val = t
      }
      if (arg.type === 'flag') { if (val) parts.push(flag) }
      else if (arg.type === 'path' && arg.positional) { parts.push(val) }
      else if (val !== undefined && val !== '' && flag) {
        if (arg.skipIfZero && Number(val) === 0) return
        const sv = String(val)
        const needsQuote = /[{}"'[\]<>|&;`$\\!*?\s]/.test(sv)
        parts.push(`${flag} ${needsQuote ? `'${sv.replace(/'/g, "'\\''")}'` : sv}`)
      }
    }
    for (const [k, a] of Object.entries<any>(template.args || {})) emitArg(k, a)
    if (template.advancedArgs) for (const [k, a] of Object.entries<any>(template.advancedArgs)) emitArg(k, a)

    const identFlag = (MODEL_IDENTIFIER_FLAG_BY_PROVIDER as any)[providerId]
    const identVal = this.settings.modelIdentifier
    if (identFlag && typeof identVal === 'string' && identVal.trim()) parts.push(`${identFlag} ${identVal.trim()}`)

    if (template.supportsMmproj && this.settings.mmproj) parts.push(`--mmproj ${this.getCachedModelPath(this.settings.mmproj, this.selectedNode)}`)

    return [...envLines, parts.join(' \\\n  ')].join('\n')
  }

  buildKcppsConfig(): any | null {
    const template = (LAUNCH_TEMPLATES as any).koboldcpp
    const s = this.settings
    const raw = this.getSelectedModelPath()
    if (!raw) return null
    const modelPath = this.getCachedModelPath(raw, this.selectedNode)
    const port = parseInt(s.port, 10) || 5001
    let tensorSplit: number[] | null = null
    if (s.tensorSplit && String(s.tensorSplit).trim()) {
      tensorSplit = String(s.tensorSplit).trim().split(/\s+/).map(Number).filter((n) => !isNaN(n))
      if (tensorSplit.length === 0) tensorSplit = null
    }
    const val = (key: string) => {
      const argDef = template.args[key] || template.advancedArgs?.[key]
      const r = s[key] ?? argDef?.default
      if (argDef?.type === 'flag') return !!r && r !== 'false' && r !== false
      if (argDef?.type === 'number') return r === '' || r === undefined ? (argDef?.default ?? 0) : Number(r)
      return r ?? ''
    }
    return {
      model: [], model_param: modelPath, port, port_param: port, host: '', launch: false, config: null,
      threads: val('threads'), usecuda: ['normal'], usevulkan: null, useclblast: null, usecpu: false,
      contextsize: val('contextSize'), gpulayers: val('gpuLayers'), tensor_split: tensorSplit, autofit: false,
      maingpu: -1, batchsize: val('batchSize'), noshift: !val('contextShift'), nofastforward: val('noFastForward'),
      useswa: val('useSwa'), smartcache: val('smartCache'), usemmap: val('useMmap'), usemlock: val('useMlock'),
      debugmode: val('debugMode'), multiuser: val('multiuser'),
      mmproj: s.mmproj && s.mmproj !== '' ? s.mmproj : null,
      chatcompletionsadapter: val('jinja') ? '' : val('chatAdapter'), jinja: val('jinja'),
      jinja_kwargs: val('jinja') && val('jinjaKwargs') ? val('jinjaKwargs') : null,
      flashattention: val('flashAttn'), lowvram: val('lowVram'), quantkv: Number(val('quantKv')),
      smartcontext: val('smartContext'), moeexperts: val('moeExperts'), moecpu: val('moeCpu'),
      defaultgenamt: val('defaultGenAmt'), maxrequestsize: val('maxRequestSize'), pipelineparallel: val('pipelineParallel'),
      embeddingsmodel: val('embeddings') ? modelPath : '', embeddingsmaxctx: val('embeddingsMaxCtx'), embeddingsgpu: val('embeddingsGpu'),
      admin: val('admin'), adminpassword: val('adminPassword'), admindir: '/tmp',
    }
  }

  private deriveSlots(): number {
    const key = (SLOT_SETTING_KEY_BY_PROVIDER as any)[this.selectedProvider]
    const v = key ? Number(this.settings[key]) : NaN
    return Number.isFinite(v) && v > 0 ? v : 1
  }

  // ─── estimate ───
  private estTimer: any = null
  scheduleEstimate(): void {
    if (this.estTimer) clearTimeout(this.estTimer)
    this.estTimer = setTimeout(() => void this.runEstimate(), 300)
  }
  async runEstimate(): Promise<void> {
    const m = this.model
    if (!m || !this.selectedFormat) return
    const params = this.presetParams()
    const bpw = this.selectedBpw ?? this.bpwForQuant()
    this.estimating = true
    try {
      const body: any = {
        params, quant: this.selectedQuant, bpw, contextSize: Number(this.settings.contextSize || this.settings.maxModelLen || 8192),
        layers: m.arch?.layers, kvHeads: m.arch?.kvHeads, headDim: m.arch?.headDim, kvLayers: m.arch?.kvLayers,
      }
      const r = await bridge().request('POST', '/api/ai/estimate', body)
      runInAction(() => {
        this.lastEstimate = r
        const placements = (r as any)?.placements || []
        if (placements.length && !this.selectedPlacement) this.setPlacement(placements[0])
      })
    } catch { /* estimate is best-effort */ } finally {
      runInAction(() => { this.estimating = false })
    }
  }
  private presetParams(): number {
    // crude param count from variant string (e.g. "70B", "35B-A3B") — VRAM calc is rough by design
    const m = this.model
    const match = String(m?.variant || '').match(/(\d+(?:\.\d+)?)\s*B/i)
    return match ? parseFloat(match[1]) : 8
  }
  private bpwForQuant(): number {
    if (this.selectedBpw) return this.selectedBpw
    const q = this.selectedQuant
    const map: Record<string, number> = { Q8_0: 8.5, Q6_K: 6.57, Q5_K_M: 5.69, Q4_K_M: 4.85, Q4_K_S: 4.58, Q3_K_M: 3.91, IQ4_XS: 4.25 }
    return map[q] ?? 5
  }

  // ─── launch ───
  async launch(): Promise<void> {
    const command = this.command
    if (!this.selectedProvider || !this.selectedNode || !command) { this.launchErr = 'Select a model, provider and GPU placement first.'; return }
    this.launching = true; this.launchErr = ''; this.launchMsg = ''
    try {
      const port = parseInt(this.settings.port, 10) || 5001
      const tmuxSession = this.getTmuxSession()
      const data: any = await bridge().request('POST', '/api/ai/launch', { node: this.selectedNode, providerId: this.selectedProvider, command, port, tmuxSession })
      // Run the returned (tmux-wrapping) command in the Live Console PTY on the target host.
      if (data?.command && data?.pveHostIp) {
        liveConsoleStore.openInstall(`launch:${tmuxSession}`, data.pveHostIp, data.command)
      }
      runInAction(() => { this.launchMsg = `Launched ${this.selectedProvider} on ${this.selectedNode}:${port} — see the Live Console.` })
    } catch (e: any) {
      runInAction(() => { this.launchErr = 'Launch failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.launching = false })
    }
  }

  async launchAsService(): Promise<void> {
    const command = this.command
    if (!this.selectedProvider || !this.selectedNode || !command) { this.launchErr = 'Select a model, provider and GPU placement first.'; return }
    this.launching = true; this.launchErr = ''; this.launchMsg = ''
    try {
      const port = parseInt(this.settings.port, 10) || 5001
      const body: any = {
        node: this.selectedNode, providerId: this.selectedProvider, command, port, tmuxSession: this.getTmuxSession(),
        model: `${this.selectedFamily}/${this.selectedVariant}`, modelFamily: this.selectedFamily, modelVariant: this.selectedVariant,
        quantFormat: this.selectedFormat, quantSize: this.selectedQuant,
        contextSize: parseInt(this.settings.contextSize || this.settings.maxModelLen, 10) || 8192,
        reservedVramMB: this.settings.reservedVramMB, slots: this.deriveSlots(),
      }
      const cuda = this.cudaIndices()
      if (cuda) { body.cudaDevices = cuda; body.gpuPciIds = this.selectedPlacement.gpus.map((g: any) => g.pciId) }
      const r: any = await bridge().request('POST', '/api/ai/launch-service', toJS(body))
      runInAction(() => { this.launchMsg = r?.service ? `Service created for ${this.selectedProvider} on port ${port} (auto-starts on boot).` : 'Launch-as-service submitted.' })
    } catch (e: any) {
      runInAction(() => { this.launchErr = 'Launch as service failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.launching = false })
    }
  }
}

export const llmLaunchStore = new LlmLaunchStore()
