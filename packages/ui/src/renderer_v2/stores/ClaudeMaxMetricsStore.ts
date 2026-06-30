import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

export interface ClaudeMaxRow {
  model: string
  requests?: number
  errors?: number
  cum_promptTokens?: number
  cum_genTokens?: number
  cum_cacheCreate?: number
  cum_cacheCreate1h?: number
  cum_cacheCreate5m?: number
  cum_cacheRead?: number
  cum_retries?: number
  avgLatencyMs?: number | null
  avgTtftMs?: number | null
  avgDecodeTps?: number | null
  lastTtftMs?: number | null
  lastDecodeTps?: number | null
  cacheReadPct?: number
  totalInputTokens?: number
  firstSeen?: number
  lastSeen?: number
}

export interface ClaudeMaxRecent {
  t: number
  model: string
  endpoint?: string
  stream?: boolean
  ok?: boolean
  status?: number | null
  in?: number
  out?: number
  cacheRead?: number
  cacheCreate?: number
  latencyMs?: number | null
  ttftMs?: number | null
  decodeTps?: number | null
}

export class ClaudeMaxMetricsStore {
  rows: ClaudeMaxRow[] = []
  recent: ClaudeMaxRecent[] = []
  loaded = false
  error = ''
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const r = await bridge().request('GET', '/api/proxy/claude-max/metrics')
      runInAction(() => {
        this.rows = (r as any)?.rows ?? []
        this.recent = (r as any)?.recent ?? []
        this.loaded = true
        this.error = ''
      })
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

  async resetModel(model: string): Promise<void> {
    await bridge().request('DELETE', `/api/proxy/claude-max/metrics/${encodeURIComponent(model)}`).catch(() => undefined)
    await this.load()
  }

  get totals(): { requests: number; input: number; output: number; cacheRead: number; cacheCreate: number } {
    return this.rows.reduce(
      (a, r) => ({
        requests: a.requests + (r.requests || 0),
        input: a.input + (r.totalInputTokens || 0),
        output: a.output + (r.cum_genTokens || 0),
        cacheRead: a.cacheRead + (r.cum_cacheRead || 0),
        cacheCreate: a.cacheCreate + (r.cum_cacheCreate || 0),
      }),
      { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    )
  }
}

export const claudeMaxMetricsStore = new ClaudeMaxMetricsStore()
