import { makeAutoObservable, runInAction } from 'mobx'
import { liveConsoleStore } from './LiveConsoleStore'
import {
  TTS_LAUNCH_TEMPLATES, IMAGE_LAUNCH_TEMPLATES,
  buildTtsLaunchCommand, buildGenericLaunchCommand,
} from '../components/AiModality/serviceLaunchTemplates'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

type Cat = 'tts' | 'image'
interface CardState { node: string; gpu: string; model?: string; backend?: string; port: number }
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

  constructor(category: Cat) {
    this.category = category
    this.templates = category === 'tts' ? TTS_LAUNCH_TEMPLATES : IMAGE_LAUNCH_TEMPLATES
    makeAutoObservable(this)
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
          this.cards[p.id] = { node: nodes[0] || '', gpu: 'auto', port: t.defaultPort || 0, model: t.defaultModel, backend: t.defaultBackend }
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
  /** Container-local CUDA index of the selected GPU, or undefined for "auto". */
  gpuIndex(providerId: string): number | undefined {
    const c = this.cards[providerId]
    if (!c || c.gpu === 'auto') return undefined
    const g = this.gpusForNode(c.node).find((x) => x.pciId === c.gpu)
    return g ? g.containerIdx : undefined
  }
  command(providerId: string): string {
    const c = this.cards[providerId]
    if (!c) return ''
    const gi = this.gpuIndex(providerId)
    if (this.category === 'tts') return buildTtsLaunchCommand(providerId, c.port, c.model, gi, c.backend)
    return buildGenericLaunchCommand(providerId, c.port, gi === undefined ? undefined : String(gi))
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
      runInAction(() => { this.msg = `Launched ${providerId} on ${c.node}:${c.port} — see the Live Console.` })
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
      const body: any = {
        node: c.node, providerId, command, port: c.port, tmuxSession: `${providerId}-${c.port}`,
        [this.category === 'tts' ? 'isTts' : 'isImageGen']: true,
      }
      const gi = this.gpuIndex(providerId)
      if (gi !== undefined) {
        body.cudaDevices = [gi]
        const g = this.gpusForNode(c.node).find((x) => x.containerIdx === gi)
        if (g) body.gpuPciIds = [g.pciId]
      }
      const r: any = await bridge().request('POST', '/api/ai/launch-service', body)
      runInAction(() => { this.msg = r?.service ? `Service created for ${providerId} on port ${c.port} (auto-starts on boot).` : 'Launch-as-service submitted.' })
    } catch (e: any) {
      runInAction(() => { this.err = 'Launch as service failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.busy = '' })
    }
  }
}

export const ttsLaunchStore = new ServiceLaunchStore('tts')
export const imageLaunchStore = new ServiceLaunchStore('image')
