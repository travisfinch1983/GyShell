import { makeAutoObservable, runInAction } from 'mobx'
import { liveConsoleStore } from './LiveConsoleStore'
import {
  TTS_LAUNCH_TEMPLATES, GENERIC_LAUNCH_TEMPLATES,
  buildTtsLaunchCommand, buildGenericLaunchCommand,
} from '../components/AiModality/serviceLaunchTemplates'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

type Cat = 'tts' | 'image' | 'training'
interface CardState { node: string; gpus: string[]; model?: string; backend?: string; port: number; configName?: string }
interface GpuOpt { pciId: string; containerIdx: number; label: string }

/**
 * Per-provider launch cards for the simple service launchers (TTS, Imagegen).
 * Mirrors ProxLab's renderTtsLaunchTab / renderGenericLaunchTab: one card per
 * installed provider with node + GPU + (optional model/backend) + port, a live
 * command preview, and Launch / Launch-as-Service buttons. Reuses the same
 * /api/ai/launch + /launch-service contract as the LLM launcher.
 */
export class ServiceLaunchStore {
  category: Cat
  templates: Record<string, any>
  providers: any[] = []
  agents: any[] = []
  cards: Record<string, CardState> = {}
  loaded = false
  loading = false
  busy = '' // providerId currently launching
  msg = ''
  err = ''
  // Training config workspace state (keyed by providerId)
  trainOpen: Record<string, boolean> = {}
  trainTemplates: Record<string, string[]> = {}
  trainSelTemplate: Record<string, string> = {}
  trainEditor: Record<string, string> = {}
  trainStatus: Record<string, { msg: string; ok: boolean }> = {}

  constructor(category: Cat) {
    this.category = category
    this.templates = category === 'tts' ? TTS_LAUNCH_TEMPLATES : GENERIC_LAUNCH_TEMPLATES
    makeAutoObservable(this)
  }

  isMultiGpu(providerId: string): boolean {
    return this.templates[providerId]?.multiGpu === true
  }
  isCli(providerId: string): boolean {
    return !this.templates[providerId]?.defaultPort
  }

  async load(): Promise<void> {
    this.loading = true
    this.err = ''
    try {
      const [provs, gpus] = await Promise.all([
        bridge().request('GET', '/api/ai/providers').catch(() => null),
        bridge().request('GET', '/api/ai/agent-gpus').catch(() => null),
      ])
      runInAction(() => {
        this.providers = (((provs as any)?.providers ?? []) as any[]).filter((p) => p.category === this.category && this.templates[p.id])
        this.agents = ((gpus as any)?.agents ?? []) as any[]
        for (const p of this.installedProviders) {
          if (this.cards[p.id]) continue
          const nodes = this.installedNodes(p)
          const t = this.templates[p.id] || {}
          this.cards[p.id] = { node: nodes[0] || '', gpus: [], port: t.defaultPort || 0, model: t.defaultModel, backend: t.defaultBackend, configName: 'default' }
        }
        this.loaded = true
      })
    } catch (e: any) {
      runInAction(() => { this.err = e?.message || 'Failed to load providers' })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  get installedProviders(): any[] {
    return this.providers.filter((p) => Object.values(p.agents || {}).some((s: any) => s?.installed))
  }
  installedNodes(p: any): string[] {
    return Object.entries(p.agents || {}).filter(([, s]: any) => s?.installed).map(([n]) => n)
  }
  /** NVIDIA GPUs available on the given node (matched by agent host_node). */
  gpusForNode(node: string): GpuOpt[] {
    const ag = this.agents.find((a) => a.host_node === node)
    return ((ag?.gpus ?? []) as any[])
      .filter((g) => g.provider === 'nvidia' && g.vram_mb > 0)
      .map((g) => ({ pciId: g.pci_id, containerIdx: g.cuda_index, label: `${g.name} (${(g.vram_mb / 1024).toFixed(0)} GB)` }))
  }
  set(providerId: string, patch: Partial<CardState>): void {
    this.cards[providerId] = { ...this.cards[providerId], ...patch }
  }
  /** Single-GPU select (TTS + single-GPU generic). pciId === 'auto' clears the selection. */
  setGpu(providerId: string, pciId: string): void {
    this.set(providerId, { gpus: pciId === 'auto' ? [] : [pciId] })
  }
  /** Multi-GPU toggle (comfyui / kohya-ss). */
  toggleGpu(providerId: string, pciId: string): void {
    const cur = this.cards[providerId]?.gpus || []
    this.set(providerId, { gpus: cur.includes(pciId) ? cur.filter((x) => x !== pciId) : [...cur, pciId] })
  }
  isGpuSelected(providerId: string, pciId: string): boolean {
    return (this.cards[providerId]?.gpus || []).includes(pciId)
  }
  /** Container-local CUDA indices of the selected GPUs, in selection order. */
  private cudaIdxList(providerId: string): number[] {
    const c = this.cards[providerId]
    if (!c?.gpus?.length) return []
    const opts = this.gpusForNode(c.node)
    return c.gpus.map((pid) => opts.find((g) => g.pciId === pid)?.containerIdx).filter((i): i is number => i != null)
  }
  command(providerId: string): string {
    const c = this.cards[providerId]
    if (!c) return ''
    const idxs = this.cudaIdxList(providerId)
    if (this.category === 'tts') {
      return buildTtsLaunchCommand(providerId, c.port, c.model, idxs.length ? idxs[0] : undefined, c.backend)
    }
    const gpuIndices = idxs.length ? idxs.join(',') : undefined
    return buildGenericLaunchCommand(providerId, c.port, gpuIndices, { configName: c.configName || 'default' })
  }

  async launch(providerId: string): Promise<void> {
    const c = this.cards[providerId]
    const command = this.command(providerId)
    if (!c?.node || !command) { this.err = 'Pick a node first.'; return }
    this.busy = providerId; this.err = ''; this.msg = ''
    try {
      const tmuxSession = `${providerId}-${c.port}`
      const data: any = await bridge().request('POST', '/api/ai/launch', { node: c.node, providerId, command, port: c.port, tmuxSession })
      if (data?.command && data?.pveHostIp) liveConsoleStore.openInstall(`launch:${tmuxSession}`, data.pveHostIp, data.command)
      runInAction(() => { this.msg = `Launched ${providerId} on ${c.node}${c.port ? ':' + c.port : ''} — see the Live Console.` })
    } catch (e: any) {
      runInAction(() => { this.err = 'Launch failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.busy = '' })
    }
  }

  async launchAsService(providerId: string): Promise<void> {
    const c = this.cards[providerId]
    const command = this.command(providerId)
    if (!c?.node || !command) { this.err = 'Pick a node first.'; return }
    this.busy = providerId; this.err = ''; this.msg = ''
    try {
      const flag = this.category === 'tts' ? 'isTts' : 'isImageGen'
      const body: any = { node: c.node, providerId, command, port: c.port, tmuxSession: `${providerId}-${c.port}`, [flag]: true }
      const idxs = this.cudaIdxList(providerId)
      if (idxs.length) {
        body.cudaDevices = idxs
        const opts = this.gpusForNode(c.node)
        body.gpuPciIds = c.gpus.map((pid) => opts.find((g) => g.pciId === pid)?.pciId).filter(Boolean)
      }
      const r: any = await bridge().request('POST', '/api/ai/launch-service', body)
      runInAction(() => { this.msg = r?.service ? `Service created for ${providerId} on port ${c.port} (auto-starts on boot).` : 'Launch-as-service submitted.' })
    } catch (e: any) {
      runInAction(() => { this.err = 'Launch as service failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.busy = '' })
    }
  }

  // ─── Training config workspace (CLI trainers) ───
  toggleTrainWorkspace(providerId: string): void {
    this.trainOpen[providerId] = !this.trainOpen[providerId]
    if (this.trainOpen[providerId] && !this.trainTemplates[providerId]) void this.loadTrainTemplates(providerId)
  }
  setTrainEditor(providerId: string, content: string): void { this.trainEditor[providerId] = content }
  setTrainSelTemplate(providerId: string, name: string): void { this.trainSelTemplate[providerId] = name }
  private setTrainStatus(providerId: string, msg: string, ok: boolean): void { this.trainStatus[providerId] = { msg, ok } }

  async loadTrainTemplates(providerId: string): Promise<void> {
    try {
      const r: any = await bridge().request('GET', `/api/ai/training/${providerId}/templates`)
      const list = Array.isArray(r) ? r : (r?.templates ?? [])
      runInAction(() => { this.trainTemplates[providerId] = list.map((x: any) => (typeof x === 'string' ? x : x.name || x.id)) })
    } catch { runInAction(() => { this.trainTemplates[providerId] = [] }) }
  }
  async loadTrainConfig(providerId: string): Promise<void> {
    const name = this.trainSelTemplate[providerId]
    if (!name) return
    try {
      const r: any = await bridge().request('GET', `/api/ai/training/${providerId}/config/${encodeURIComponent(name)}`)
      runInAction(() => {
        this.trainEditor[providerId] = r?.content ?? (typeof r === 'string' ? r : '')
        const c = this.cards[providerId]
        if (c && (!c.configName || c.configName === 'default')) this.set(providerId, { configName: name.replace(/[^a-zA-Z0-9_-]/g, '-') })
        this.setTrainStatus(providerId, `Loaded template: ${name}`, true)
      })
    } catch (e: any) { runInAction(() => this.setTrainStatus(providerId, 'Load failed: ' + (e?.message || e), false)) }
  }
  async saveTrainConfig(providerId: string): Promise<boolean> {
    const c = this.cards[providerId]
    const name = (c?.configName || '').trim()
    const content = this.trainEditor[providerId]
    if (!name) { this.setTrainStatus(providerId, 'Enter a config name', false); return false }
    if (!content) { this.setTrainStatus(providerId, 'Config is empty', false); return false }
    try {
      await bridge().request('PUT', `/api/ai/training/${providerId}/config/${encodeURIComponent(name)}`, { content })
      runInAction(() => this.setTrainStatus(providerId, `Saved: ${name}`, true))
      return true
    } catch (e: any) { runInAction(() => this.setTrainStatus(providerId, 'Save failed: ' + (e?.message || e), false)); return false }
  }
  /** Start a CLI training run: save the config, then launch with that config name. */
  async startTraining(providerId: string): Promise<void> {
    const ok = await this.saveTrainConfig(providerId)
    if (!ok) return
    await this.launch(providerId)
  }
}

export const ttsLaunchStore = new ServiceLaunchStore('tts')
export const imageLaunchStore = new ServiceLaunchStore('image')
export const trainingLaunchStore = new ServiceLaunchStore('training')
