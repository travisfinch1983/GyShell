import { makeAutoObservable, runInAction } from 'mobx'
import { liveConsoleStore } from './LiveConsoleStore'
import { QUANT_TOOLS } from '../components/AiLlm/quantTools'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

interface QState { modelPath: string; outputPath: string; quantType: string; gpu: string }
interface GpuOpt { pciId: string; containerIdx: number; label: string }

/** Quantization scripts (GGUF/AWQ/GPTQ/EXL2/EXL3) — one card per tool, runs via /api/ai/launch in tmux. */
export class QuantizationStore {
  agents: any[] = []
  state: Record<string, QState> = {}
  loaded = false
  busy = '' // toolId currently running
  msg = ''
  err = ''

  constructor() {
    for (const [id, t] of Object.entries<any>(QUANT_TOOLS)) {
      this.state[id] = { modelPath: '', outputPath: '', quantType: t.quants[0], gpu: 'auto' }
    }
    makeAutoObservable(this)
  }

  async load(): Promise<void> {
    try {
      const g = await bridge().request('GET', '/api/ai/agent-gpus').catch(() => null)
      runInAction(() => { this.agents = ((g as any)?.agents ?? []) as any[]; this.loaded = true })
    } catch { runInAction(() => { this.loaded = true }) }
  }

  get tools(): any[] {
    return Object.entries<any>(QUANT_TOOLS).map(([id, t]) => ({ id, ...t }))
  }
  gpusForNode(node: string): GpuOpt[] {
    const ag = this.agents.find((a) => a.host_node === node)
    return ((ag?.gpus ?? []) as any[])
      .filter((g) => g.provider === 'nvidia' && g.vram_mb > 0)
      .map((g) => ({ pciId: g.pci_id, containerIdx: g.cuda_index, label: `${g.name} (${(g.vram_mb / 1024).toFixed(0)} GB)` }))
  }
  set(id: string, patch: Partial<QState>): void {
    this.state[id] = { ...this.state[id], ...patch }
  }
  private gpuIdx(id: string): number | undefined {
    const s = this.state[id]
    const t = QUANT_TOOLS[id]
    if (!s || s.gpu === 'auto') return undefined
    const g = this.gpusForNode(t.node).find((x) => x.pciId === s.gpu)
    return g ? g.containerIdx : undefined
  }
  command(id: string): string {
    const t = QUANT_TOOLS[id]
    const s = this.state[id]
    if (!t || !s) return ''
    const env = ['export CUDA_DEVICE_ORDER=PCI_BUS_ID']
    const gi = this.gpuIdx(id)
    if (gi !== undefined) env.push(`export CUDA_VISIBLE_DEVICES=${gi}`)
    const model = s.modelPath || '/models/Family/Variant/FP16'
    const out = s.outputPath || `/models/Family/Variant/${s.quantType}`
    return env.join('\n') + '\n' + t.buildCommand(model, out, s.quantType)
  }

  async run(id: string): Promise<void> {
    const t = QUANT_TOOLS[id]
    const s = this.state[id]
    if (!s.modelPath.trim()) { this.err = 'Enter the input model path'; return }
    if (!s.outputPath.trim()) { this.err = 'Enter the output directory'; return }
    this.busy = id; this.err = ''; this.msg = ''
    try {
      const command = `mkdir -p "${s.outputPath.trim()}"\n` + this.command(id)
      const tmuxSession = `quant-${id}`
      const data: any = await bridge().request('POST', '/api/ai/launch', { node: t.node, providerId: `quant-${id}`, command, port: 0, tmuxSession })
      if (data?.command && data?.pveHostIp) liveConsoleStore.openInstall(`quant:${id}`, data.pveHostIp, data.command)
      runInAction(() => { this.msg = `Quantization started (${t.name}, ${s.quantType}) on ${t.node} — see the Live Console.` })
    } catch (e: any) {
      runInAction(() => { this.err = 'Quantize failed: ' + (e?.message || e) })
    } finally {
      runInAction(() => { this.busy = '' })
    }
  }
}

export const quantizationStore = new QuantizationStore()
