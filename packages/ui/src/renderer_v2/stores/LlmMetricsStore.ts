import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

export interface LlmMetricRow {
  fingerprint: string
  model?: string
  displayName?: string
  modelFamily?: string
  provider?: string
  providerId?: string
  quant?: string
  contextSize?: number
  slotCount?: number
  reasoningMode?: string
  gpuCount?: number
  gpus?: string[]
  node?: string
  vramMB?: number | null
  endpoint?: string
  running?: boolean
  firstSeen?: number
  lastSeen?: number
  decodeTps?: number
  prefillTps?: number
  cum_genTokens?: number
  cum_promptTokens?: number
  cum_cacheHits?: number
  cum_cacheQueries?: number
  cum_optaneHits?: number
  cum_optaneQueries?: number
  optaneRestoreMs?: number
  toolCalls?: number
  toolErrStructure?: number
  toolErrHallucination?: number
  settings?: Record<string, any>
}

export class LlmMetricsStore {
  rows: LlmMetricRow[] = []
  loaded = false
  error = ''
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const r = await bridge().request('GET', '/api/ai/llm-metrics')
      runInAction(() => { this.rows = (r as any)?.rows ?? []; this.loaded = true; this.error = '' })
    } catch (e: any) {
      runInAction(() => { this.error = e?.message || 'load failed'; this.loaded = true })
    }
  }

  startPolling(ms = 20000): void {
    if (this.timer) return
    void this.load()
    this.timer = setInterval(() => void this.load(), ms)
  }
  stopPolling(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  async deleteRow(fp: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/llm-metrics/${encodeURIComponent(fp)}`).catch(() => undefined)
    await this.load()
  }

  /** Rows grouped by base model, each group sorted running-first then by last-seen. */
  get grouped(): { model: string; rows: LlmMetricRow[] }[] {
    const map = new Map<string, LlmMetricRow[]>()
    for (const r of this.rows) {
      const k = r.model || r.displayName || '—'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(r)
    }
    const groups = [...map.entries()].map(([model, rows]) => ({
      model,
      rows: rows.slice().sort((a, b) => (Number(b.running) - Number(a.running)) || ((b.lastSeen || 0) - (a.lastSeen || 0))),
    }))
    groups.sort((a, b) => a.model.localeCompare(b.model))
    return groups
  }
}

export const llmMetricsStore = new LlmMetricsStore()
