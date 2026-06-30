import { makeAutoObservable, runInAction, toJS } from 'mobx'
import {
  LAUNCH_TEMPLATES,
  MODEL_IDENTIFIER_FLAG_BY_PROVIDER,
  SLOT_SETTING_KEY_BY_PROVIDER,
} from '../components/AiLlm/launchTemplates'
import { liveConsoleStore } from './LiveConsoleStore'
import { SAMPLER_PRESETS_BUILTIN } from '../components/AiLlm/samplerPresets'

// Setting keys a sampler preset captures (mirrors ProxLab snapshotCurrentSamplerValues).
const SAMPLER_PRESET_KEYS = [
  'temp', 'topK', 'topP', 'minP', 'repeatPenalty', 'presencePenalty', 'frequencyPenalty',
  'dryMultiplier', 'mirostat', 'samplers', 'contextSize', 'ropeScaling', 'ropeScale',
  'ropeFreqBase', 'yarnOrigCtx', 'parallel', 'reasoning', 'chatTemplateKwargs',
  'reasoningFormat', 'reasoningBudget', 'specType', 'draftMax',
]
// Providers that take llama.cpp-style sampler args (where presets apply).
export const SAMPLER_PRESET_PROVIDERS = new Set(['llama-server', 'llama-server-mtp'])

// ─── VRAM placement evaluation (ported verbatim from ProxLab) ───
function computeBufferPerGpu(params: number | undefined, numGpus: number): number {
  const p = params || 7
  const infBuf = Math.min(4200, Math.max(800, Math.round(1000 + 500 * Math.log2(p + 1))))
  const cudaCtx = 300
  if (!numGpus || numGpus <= 1) return cudaCtx + infBuf
  const perGpu = Math.round((infBuf / numGpus) * 1.3)
  return cudaCtx + Math.min(perGpu, infBuf)
}
function evaluateCustomGpus(selectedGpus: any[], weightsMB: number, kvCacheMB: number, params: number | undefined): any {
  if (!selectedGpus.length) return null
  const cbPerGpu = computeBufferPerGpu(params, selectedGpus.length)
  const usable = selectedGpus.map((g) => Math.max(0, (g.availableVramMB ?? g.vramMB) - cbPerGpu))
  const totalUsable = usable.reduce((a, b) => a + b, 0)
  const modelPayload = weightsMB + kvCacheMB
  if (selectedGpus.length === 1) {
    const headroom = totalUsable - modelPayload
    return { fits: headroom >= 0, headroomMB: Math.floor(headroom), riskLabel: null, splitRatios: usable }
  }
  if (totalUsable < modelPayload) return { fits: false, headroomMB: Math.floor(totalUsable - modelPayload), riskLabel: null, splitRatios: usable }
  let minH = Infinity
  for (let i = 0; i < selectedGpus.length; i++) {
    const load = modelPayload * (usable[i] / totalUsable) + cbPerGpu
    minH = Math.min(minH, (selectedGpus[i].availableVramMB ?? selectedGpus[i].vramMB) - load)
  }
  const headroom = Math.floor(minH)
  const riskLabel = headroom < 1024 ? 'tight' : headroom < 4096 ? 'safe' : 'spacious'
  return { fits: true, headroomMB: headroom, riskLabel, splitRatios: usable }
}

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
  userSamplerPresets: any[] = []

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
  // Auto-assigned free port used when the Port field is left blank (blank = auto, a value = manual override).
  // Fetched from the backend's conflict-aware allocator; cleared after each launch so the next is fresh.
  autoPort: number | null = null

  lastEstimate: any = null
  selectedPlacement: any = null
  customGpus: any[] = [] // GPUs chosen via the Custom placement selector (availableGpus entries)
  estimating = false

  launching = false
  launchMsg = ''
  launchErr = ''

  // saved launch templates
  savedTemplates: any[] = []
  loadedTemplateId: string | null = null

  constructor() {
    makeAutoObservable(this)
  }

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      const [scan, provs, gpus, cache, samplers, templates] = await Promise.all([
        bridge().request('GET', '/api/ai/models/scan').catch(() => null),
        bridge().request('GET', '/api/ai/providers').catch(() => null),
        bridge().request('GET', '/api/ai/agent-gpus').catch(() => null),
        bridge().request('GET', '/api/ai/models/cache').catch(() => null),
        bridge().request('GET', '/api/ai/sampler-presets').catch(() => null),
        bridge().request('GET', '/api/ai/templates').catch(() => null),
      ])
      runInAction(() => {
        this.models = scan || { models: [] }
        this.presets = (scan as any)?.presets || null
        this.providers = ((provs as any)?.providers ?? []) as any[]
        this.agents = ((gpus as any)?.agents ?? []) as Agent[]
        this.cacheEntries = (((cache as any)?.entries ?? []) as any[]).filter((e) => e.status === 'cached' || e.cachedAt)
        this.userSamplerPresets = (((samplers as any)?.presets) ?? []) as any[]
        this.savedTemplates = (((templates as any)?.templates) ?? []) as any[]
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

  // ─── saved launch templates ───
  async reloadTemplates(): Promise<void> {
    const r: any = await bridge().request('GET', '/api/ai/templates').catch(() => null)
    runInAction(() => { this.savedTemplates = (r?.templates ?? []) as any[] })
  }

  /** Load a saved template's model + provider + settings into the launcher. */
  loadTemplate(id: string): void {
    const t = this.savedTemplates.find((x) => x.id === id)
    if (!t) return
    runInAction(() => {
      this.selectedFamily = t.family || ''
      this.selectedVariant = t.variant || ''
      this.selectedFormat = t.format || ''
      this.selectedQuant = t.quant || ''
      this.selectedProvider = t.providerId || ''
      this.settings = { ...(t.settings || {}) }
      this.loadedTemplateId = id
      // sampler-preset binding doesn't carry across template loads
      this.selectedSamplerPresetId = ''
      this.presetKeys = []
    })
    // The quant table (step 2) is gated on `model` resolving from the scan. If the template's model isn't
    // in the current index (e.g. not yet scanned), pull that family so the table + quant rows appear (#4).
    if (this.selectedFamily && !this.model) void this.rescanFamily(this.selectedFamily)
    this.scheduleEstimate()
  }

  get canSaveChanges(): boolean { return !!this.loadedTemplateId }
  get canSaveAsNew(): boolean { return !!this.selectedProvider }
  get loadedTemplateName(): string { return this.savedTemplates.find((t) => t.id === this.loadedTemplateId)?.name || '' }

  private templateBody(extra: Record<string, any> = {}): any {
    return {
      providerId: this.selectedProvider,
      family: this.selectedFamily,
      variant: this.selectedVariant,
      format: this.selectedFormat,
      quant: this.selectedQuant,
      settings: { ...this.settings },
      ...extra,
    }
  }

  /** Save Changes — overwrite the currently-loaded template in place. */
  async saveTemplateChanges(): Promise<void> {
    if (!this.loadedTemplateId) return
    const existing = this.savedTemplates.find((t) => t.id === this.loadedTemplateId)
    if (!existing) return
    try {
      await bridge().request('POST', '/api/ai/templates', this.templateBody({ id: this.loadedTemplateId, name: existing.name }))
      runInAction(() => { this.launchMsg = `Saved changes to "${existing.name}"` })
      await this.reloadTemplates()
    } catch (e: any) { runInAction(() => { this.launchErr = 'Save failed: ' + (e?.message || e) }) }
  }

  /** Save As New Template — create a new template from the current launcher state. */
  async saveAsNewTemplate(name: string): Promise<void> {
    if (!name.trim() || !this.selectedProvider) return
    try {
      const r: any = await bridge().request('POST', '/api/ai/templates', this.templateBody({ name: name.trim() }))
      runInAction(() => { this.loadedTemplateId = r?.id || null; this.launchMsg = `Saved template "${name.trim()}"` })
      await this.reloadTemplates()
    } catch (e: any) { runInAction(() => { this.launchErr = 'Save failed: ' + (e?.message || e) }) }
  }

  /** Inline rename — keeps all other fields of the template intact. */
  async renameTemplate(id: string, name: string): Promise<void> {
    const t = this.savedTemplates.find((x) => x.id === id)
    if (!t || !name.trim()) return
    try {
      await bridge().request('POST', '/api/ai/templates', {
        id, name: name.trim(), providerId: t.providerId, family: t.family, variant: t.variant, format: t.format, quant: t.quant, settings: t.settings,
      })
      await this.reloadTemplates()
    } catch (e: any) { runInAction(() => { this.launchErr = 'Rename failed: ' + (e?.message || e) }) }
  }

  async deleteTemplate(id: string): Promise<void> {
    try {
      await bridge().request('DELETE', `/api/ai/templates/${encodeURIComponent(id)}`)
      runInAction(() => { if (this.loadedTemplateId === id) this.loadedTemplateId = null })
      await this.reloadTemplates()
    } catch (e: any) { runInAction(() => { this.launchErr = 'Delete failed: ' + (e?.message || e) }) }
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
      if (format === 'MMPROJ') continue // vision projector, not a selectable model quant (auto-wired via mmproj)
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
    // Seed the provider's settings, but PRESERVE values the user already set (settings persist across
    // model/provider changes). Only fill defaults for keys not already present; keys the new provider
    // doesn't have are dropped. This is why switching models keeps your tweaked settings (#1/#5).
    const t = (LAUNCH_TEMPLATES as any)[id]
    const prev = this.settings || {}
    const s: Record<string, any> = {}
    if (t) {
      for (const [k, a] of Object.entries<any>(t.args || {})) s[k] = (prev[k] !== undefined ? prev[k] : a.default)
      for (const [k, a] of Object.entries<any>(t.advancedArgs || {})) s[k] = (prev[k] !== undefined ? prev[k] : a.default)
    }
    // Auto-wire the vision projector: a model that ships an mmproj/ gets it pre-filled (enables image
    // input); others are cleared. Overrides any persisted value so mmproj always matches the chosen model.
    if (t?.supportsMmproj) s.mmproj = this.detectedMmprojPath() || ''
    this.settings = s
    this.selectedSamplerPresetId = ''
    this.presetKeys = []
    this.samplerReadOnly = false
    this.scheduleEstimate()
  }

  /** Path of the multimodal projector the selected model ships (scan exposes it as a MMPROJ "format"),
   *  or null. Used to auto-fill the mmproj field for vision-capable GGUF models. */
  detectedMmprojPath(): string | null {
    return this.mmprojOptions[0]?.value || null
  }

  /** All multimodal projectors in the selected model's shared mmproj/ folder (sits in the GGUF parent
   *  alongside the quant folders, shared across quants). The scan exposes them as MMPROJ "format" entries.
   *  Drives the mmproj dropdown in the launcher. */
  get mmprojOptions(): { label: string; value: string }[] {
    const fmts = this.model?.formats?.MMPROJ
    if (!fmts || typeof fmts !== 'object') return []
    return Object.entries<any>(fmts)
      .filter(([, v]) => v && typeof v.path === 'string')
      .map(([name, v]) => ({ label: name, value: v.path as string }))
  }
  setSetting(key: string, val: any): void {
    this.settings = { ...this.settings, [key]: val }
  }

  // ─── sampler presets (llama.cpp / ik_llama.cpp) ───
  selectedSamplerPresetId = ''
  samplerReadOnly = false
  /** The settings keys "in" the current preset — drives the highlight border + which keys get saved. */
  presetKeys: string[] = []

  get supportsSamplerPresets(): boolean {
    return SAMPLER_PRESET_PROVIDERS.has(this.selectedProvider)
  }
  get allSamplerPresets(): any[] {
    return [...(SAMPLER_PRESETS_BUILTIN as any[]), ...this.userSamplerPresets]
  }
  /** True when the per-setting preset checkboxes/borders should show (provider supports + preset chosen). */
  get samplerPresetActive(): boolean {
    return this.supportsSamplerPresets && this.selectedSamplerPresetId !== ''
  }
  isPresetKey(key: string): boolean {
    return this.presetKeys.includes(key)
  }
  setSamplerReadOnly(v: boolean): void {
    this.samplerReadOnly = v
  }
  /** Select (not apply) a preset in the dropdown — reveals which keys it owns (checkboxes + borders). */
  selectSamplerPreset(id: string): void {
    this.selectedSamplerPresetId = id
    const p = this.samplerPresetById(id)
    this.samplerReadOnly = !!p?.readOnly
    this.presetKeys = p?.values ? Object.keys(p.values) : []
  }
  /** Toggle whether a setting key is part of the preset (checkbox next to its label). */
  togglePresetKey(key: string): void {
    this.presetKeys = this.presetKeys.includes(key)
      ? this.presetKeys.filter((k) => k !== key)
      : [...this.presetKeys, key]
  }
  /** Apply a preset's values onto the current settings (overwrites only the keys it defines). */
  applySamplerPreset(id: string): void {
    const p = this.allSamplerPresets.find((x) => x.id === id)
    if (!p?.values) return
    this.settings = { ...this.settings, ...p.values }
    this.presetKeys = Object.keys(p.values) // highlight what the preset changed
  }
  /** Snapshot the values to save — only the keys the user has checked into the preset (presetKeys);
   *  falls back to the default sampler key set if nothing is explicitly checked. */
  private snapshotSamplerValues(): Record<string, any> {
    const keys = this.presetKeys.length ? this.presetKeys : SAMPLER_PRESET_KEYS
    const out: Record<string, any> = {}
    for (const k of keys) if (this.settings[k] !== undefined) out[k] = this.settings[k]
    return out
  }
  async loadSamplerPresets(): Promise<void> {
    try {
      const r: any = await bridge().request('GET', '/api/ai/sampler-presets')
      runInAction(() => { this.userSamplerPresets = (r?.presets ?? []) as any[] })
    } catch { /* keep built-ins */ }
  }
  samplerPresetById(id: string): any {
    return this.allSamplerPresets.find((x) => x.id === id) || null
  }
  /** Save As — create a NEW preset from current sampler settings (optionally read-only). */
  async saveSamplerPreset(name: string, readOnly = false): Promise<string | null> {
    if (!name?.trim()) return null
    const r: any = await bridge().request('POST', '/api/ai/sampler-presets', { name: name.trim(), readOnly, values: this.snapshotSamplerValues() })
    await this.loadSamplerPresets()
    return r?.preset?.id ?? null
  }
  /** Update — overwrite the selected preset with current settings. Built-ins are JS constants and
   *  can't be mutated, so they fork into a "(custom)" copy (matches ProxLab). Returns the live id. */
  async updateSamplerPreset(id: string, readOnly: boolean): Promise<string | null> {
    if (!id) return null
    const preset = this.samplerPresetById(id)
    if (String(id).startsWith('builtin-')) {
      const r: any = await bridge().request('POST', '/api/ai/sampler-presets', {
        name: `${preset?.name ?? 'Preset'} (custom)`, readOnly, values: this.snapshotSamplerValues(),
      })
      await this.loadSamplerPresets()
      return r?.preset?.id ?? null
    }
    await bridge().request('PUT', `/api/ai/sampler-presets/${encodeURIComponent(id)}`, { values: this.snapshotSamplerValues(), readOnly })
    await this.loadSamplerPresets()
    return id
  }
  async deleteSamplerPreset(id: string): Promise<void> {
    if (!id || String(id).startsWith('builtin-')) return // built-ins are read-only
    await bridge().request('DELETE', `/api/ai/sampler-presets/${encodeURIComponent(id)}`)
    await this.loadSamplerPresets()
  }
  setPlacement(p: any): void {
    this.customGpus = [] // choosing a suggested placement clears any custom GPU selection
    this.selectedPlacement = p
    this.selectedNode = p?.node || p?.gpus?.[0]?.node || this.selectedNode
    this.applyPlacementSettings(p)
  }

  // ─── Custom GPU selector (ProxLab "Custom" placement row) ───
  get availableNvidiaGpus(): any[] {
    return ((this.lastEstimate?.availableGpus ?? []) as any[]).filter((g) => g.provider === 'nvidia' && g.vramMB > 0)
  }
  get customAddableGpus(): any[] {
    return this.availableNvidiaGpus.filter((g) => !this.customGpus.some((s) => s.node === g.node && s.pciId === g.pciId))
  }
  get isCustomSelected(): boolean {
    return !!this.selectedPlacement?.custom
  }
  get customEval(): any {
    const est = this.lastEstimate?.estimate
    if (!this.customGpus.length || !est) return null
    return evaluateCustomGpus(this.customGpus, est.weightsMB, est.kvCacheMB, est.breakdown?.params)
  }
  /** Add a GPU to the custom selection — value is "node:pciId" from the dropdown. */
  addCustomGpu(value: string): void {
    if (!value) return
    const [node, ...rest] = value.split(':')
    const pciId = rest.join(':')
    const gpu = this.availableNvidiaGpus.find((g) => g.node === node && g.pciId === pciId)
    if (!gpu || this.customGpus.some((s) => s.node === node && s.pciId === pciId)) return
    this.customGpus = [...this.customGpus, gpu]
    this.selectCustomPlacement()
  }
  removeCustomGpu(node: string, pciId: string): void {
    this.customGpus = this.customGpus.filter((g) => !(g.node === node && g.pciId === pciId))
    if (this.customGpus.length) this.selectCustomPlacement()
    else { this.selectedPlacement = null } // nothing selected — user can pick a suggested placement
  }
  private selectCustomPlacement(): void {
    const gpus = this.customGpus
    if (!gpus.length) return
    const ev = this.customEval
    const p = {
      type: gpus.length === 1 ? 'single' : 'multi-gpu',
      gpus, node: gpus[0].node, gpuCount: gpus.length,
      totalVramMB: gpus.reduce((s, g) => s + g.vramMB, 0),
      availableVramMB: gpus.reduce((s, g) => s + (g.availableVramMB ?? g.vramMB), 0),
      headroomMB: ev?.headroomMB, riskLabel: ev?.riskLabel, splitRatios: ev?.splitRatios,
      nvlink: false, custom: true,
    }
    this.selectedPlacement = p
    this.selectedNode = p.node
    this.applyPlacementSettings(p)
  }

  private hasArg(key: string): boolean {
    const t = this.template
    return !!(t && ((t.args && key in t.args) || (t.advancedArgs && key in t.advancedArgs)))
  }
  /** Auto-config tensor-parallel / split settings from the chosen placement (ProxLab applyPlacementSettings). */
  applyPlacementSettings(p: any): void {
    if (!this.template || !p) return
    const set = (k: string, v: any) => { this.settings = { ...this.settings, [k]: v } }
    const gpus: any[] = p.gpus || []
    const count = p.gpuCount ?? gpus.length
    const isTabby = this.selectedProvider === 'tabbyapi'
    const llamaLike = this.selectedProvider === 'llama-server' || this.selectedProvider === 'llama-server-mtp'
    if (count > 1) {
      const smallestMB = Math.min(...gpus.map((g) => g.vramMB))
      const perGpuGB = Math.floor((smallestMB - 2048) / 1024)
      if (this.hasArg('tensorParallel')) set('tensorParallel', isTabby ? 'true' : count)
      if (this.hasArg('tpBackend')) set('tpBackend', p.nvlink ? 'nccl' : 'native')
      if (this.hasArg('gpuSplit')) {
        if (p.splitRatios?.length === count) set('gpuSplit', p.splitRatios.map((r: number) => Math.floor(r / 1024)).join(' '))
        else set('gpuSplit', Array(count).fill(perGpuGB).join(' '))
      }
      if (this.hasArg('tensorSplit')) {
        const sep = llamaLike ? ',' : ' '
        if (p.splitRatios?.length === count) {
          const maxR = Math.max(...p.splitRatios)
          set('tensorSplit', p.splitRatios.map((r: number) => (maxR > 0 ? (r / maxR).toFixed(2) : '1')).join(sep))
        } else set('tensorSplit', Array(count).fill('1').join(sep))
      }
    } else {
      if (this.hasArg('tensorParallel')) set('tensorParallel', isTabby ? '' : 1)
      if (this.hasArg('tpBackend')) set('tpBackend', 'native')
      if (this.hasArg('gpuSplit')) set('gpuSplit', '')
      if (this.hasArg('tensorSplit')) set('tensorSplit', '')
    }
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
    return `${this.selectedProvider}-${this.effectivePort}`
  }

  /** The port a launch will actually use: a manual value in the Port field overrides; otherwise the
   *  auto-assigned free port (blank = auto). 5001 is only a last-resort fallback if the fetch failed. */
  get effectivePort(): number {
    const manual = parseInt(this.settings.port, 10)
    if (Number.isFinite(manual) && manual > 0) return manual
    return this.autoPort || 5001
  }

  /** Fetch a conflict-free port from the backend allocator when the Port field is blank. Cached until a
   *  launch consumes it (or force=true), so we don't burn a reserved port on every re-estimate. */
  async ensureAutoPort(force = false): Promise<void> {
    const manual = parseInt(this.settings.port, 10)
    if (Number.isFinite(manual) && manual > 0) return // manual override → no auto
    if (this.autoPort && !force) return
    try {
      const r: any = await bridge().request('GET', '/api/ai/next-port')
      if (r?.port) runInAction(() => { this.autoPort = Number(r.port) })
    } catch { /* keep fallback */ }
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
      // Port: blank field → use the auto-assigned free port (blank = auto).
      if (key === 'port' && (val === '' || val == null || Number(val) === 0)) val = this.effectivePort
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
    void this.ensureAutoPort() // warm a free port for the command preview (cached; only fetches if blank)
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
        this.customGpus = [] // availableGpus refreshed — drop any stale custom selection
        const placements = (r as any)?.placements || []
        if (placements.length) this.setPlacement(placements[0]) // auto-select best (ProxLab parity)
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
    if (!this.selectedProvider || !this.selectedNode) { this.launchErr = 'Select a model, provider and GPU placement first.'; return }
    this.launching = true; this.launchErr = ''; this.launchMsg = ''
    try {
      await this.ensureAutoPort(true) // resolve a fresh free port if the field is blank, BEFORE building the command
      const command = this.command
      if (!command) { this.launchErr = 'Select a model, provider and GPU placement first.'; return }
      const port = this.effectivePort
      const tmuxSession = this.getTmuxSession()
      const data: any = await bridge().request('POST', '/api/ai/launch', { node: this.selectedNode, providerId: this.selectedProvider, command, port, tmuxSession })
      // Run the returned (tmux-wrapping) command in the Live Console PTY on the target host.
      if (data?.command && data?.pveHostIp) {
        liveConsoleStore.openInstall(`launch:${tmuxSession}`, data.pveHostIp, data.command)
      }
      runInAction(() => { this.launchMsg = `Launched ${this.selectedProvider} on ${this.selectedNode}:${port} — see the Live Console.`; this.autoPort = null })
    } catch (e: any) {
      runInAction(() => { this.launchErr = 'Launch failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.launching = false })
    }
  }

  async launchAsService(): Promise<void> {
    if (!this.selectedProvider || !this.selectedNode) { this.launchErr = 'Select a model, provider and GPU placement first.'; return }
    this.launching = true; this.launchErr = ''; this.launchMsg = ''
    try {
      await this.ensureAutoPort(true) // resolve a fresh free port if the field is blank, BEFORE building the command
      const command = this.command
      if (!command) { this.launchErr = 'Select a model, provider and GPU placement first.'; return }
      const port = this.effectivePort
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
      runInAction(() => { this.launchMsg = r?.service ? `Service created for ${this.selectedProvider} on port ${port} (auto-starts on boot).` : 'Launch-as-service submitted.'; this.autoPort = null })
    } catch (e: any) {
      runInAction(() => { this.launchErr = 'Launch as service failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.launching = false })
    }
  }
}

export const llmLaunchStore = new LlmLaunchStore()
