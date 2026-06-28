import { makeAutoObservable, runInAction } from 'mobx'

/**
 * LogsStore — service log viewer (migrated from ProxLab's System tab). Lists active + past services
 * (/api/system/logs/services) and tails the selected service's log (/api/system/logs/:id), which
 * reads the persistent tmux pipe-pane logfile (falling back to tmux capture-pane for live sessions).
 * Bridged via cluster:request for now; log reads execute on ProxLab over SSH to the PVE host.
 */
export interface LogService {
  id: string
  providerId?: string
  providerName?: string
  model?: string | null
  node?: string
  vmid?: number
  port?: number
  status: 'running' | 'stopped'
  exitReason?: string | null
  startedAt?: string
  stoppedAt?: string | null
}

export class LogsStore {
  services: LogService[] = []
  selectedId: string | null = null
  logText = ''
  source = '' // 'logfile' | 'tmux' | 'none'
  alive = false
  capturedAt = ''
  lines = 1000
  follow = true
  loadingList = false
  loadingLog = false
  error: string | null = null

  private poll: ReturnType<typeof setInterval> | null = null

  constructor() {
    makeAutoObservable(this)
  }
  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }
  get running(): LogService[] {
    return this.services.filter((s) => s.status === 'running')
  }
  get stopped(): LogService[] {
    return this.services.filter((s) => s.status !== 'running')
  }
  get selected(): LogService | null {
    return this.services.find((s) => s.id === this.selectedId) ?? null
  }

  async loadServices(): Promise<void> {
    this.loadingList = true
    try {
      const list = (await this.cluster().request('GET', '/api/system/logs/services')) as LogService[]
      runInAction(() => {
        this.services = Array.isArray(list) ? list : []
        // keep selection if still present
        if (this.selectedId && !this.services.some((s) => s.id === this.selectedId)) this.selectedId = null
      })
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.loadingList = false })
    }
  }

  select(id: string): void {
    if (this.selectedId === id) return
    this.selectedId = id
    this.logText = ''
    this.source = ''
    void this.fetchLog()
    this.restartPoll()
  }

  async fetchLog(): Promise<void> {
    const id = this.selectedId
    if (!id) return
    this.loadingLog = true
    try {
      const r = (await this.cluster().request('GET', `/api/system/logs/${encodeURIComponent(id)}?lines=${this.lines}`)) as any
      runInAction(() => {
        this.logText = r?.output || ''
        this.source = r?.source || 'none'
        this.alive = !!r?.alive
        this.capturedAt = r?.capturedAt || ''
        this.error = r?.error || null
      })
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.loadingLog = false })
    }
  }

  setLines(n: number): void {
    this.lines = n
    void this.fetchLog()
  }
  toggleFollow(): void {
    this.follow = !this.follow
  }

  private restartPoll(): void {
    this.stopPoll()
    // only auto-refresh a running service's log
    if (this.selected?.status === 'running') {
      this.poll = setInterval(() => void this.fetchLog(), 3000)
    }
  }
  stopPoll(): void {
    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
  }
  /** Periodic refresh of the service list (status changes). */
  startListPoll(intervalMs = 8000): void {
    void this.loadServices()
    if (this.listPoll) return
    this.listPoll = setInterval(() => void this.loadServices(), intervalMs)
  }
  private listPoll: ReturnType<typeof setInterval> | null = null
  stopListPoll(): void {
    if (this.listPoll) {
      clearInterval(this.listPoll)
      this.listPoll = null
    }
  }
  dispose(): void {
    this.stopPoll()
    this.stopListPoll()
  }
}

export const logsStore = new LogsStore()
