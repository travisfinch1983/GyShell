import { makeAutoObservable, runInAction } from 'mobx'

/**
 * ClusterStore — MobX state for the Cluster tab (migrated from ProxLab).
 *
 * Data comes from the backend RPC `cluster:getStatus` (see ClusterService on the
 * backend). RULE #1: this NEVER fetches a 10.0.0.x URL from the browser — it calls
 * the gateway RPC, which the backend proxies. Polls on an interval while the tab
 * is mounted; the WS push-stream (guests-update) can replace polling in a later slice.
 */
export interface ClusterInfo {
  id?: string
  name?: string
  version?: number
  nodes?: number
  quorate?: number
}

export interface ClusterNode {
  node: string
  status?: string
  online?: boolean
  cpu?: number // 0..1 ratio
  maxcpu?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  uptime?: number
  ip?: string
}

export interface ClusterGuest {
  vmid: number
  name?: string
  type?: 'lxc' | 'qemu'
  node?: string
  status?: string
  cpu?: number // 0..1 ratio
  maxcpu?: number
  mem?: number
  maxmem?: number
  maxdisk?: number
  uptime?: number
  tags?: string[]
}

export interface ClusterStatus {
  configured?: boolean
  cluster?: ClusterInfo
  nodes?: ClusterNode[]
  containers?: ClusterGuest[]
  vms?: ClusterGuest[]
  timestamp?: number
}

// Kept out of the observable graph on purpose (a timer handle is not UI state).
let pollTimer: ReturnType<typeof setInterval> | null = null

export class ClusterStore {
  status: ClusterStatus | null = null
  loading = false
  error: string | null = null
  lastUpdated: number | null = null
  filter = ''

  constructor() {
    makeAutoObservable(this)
  }

  get nodes(): ClusterNode[] {
    return this.status?.nodes ?? []
  }

  get guests(): ClusterGuest[] {
    return [...(this.status?.containers ?? []), ...(this.status?.vms ?? [])]
  }

  get filteredGuests(): ClusterGuest[] {
    const f = this.filter.trim().toLowerCase()
    if (!f) return this.guests
    return this.guests.filter(
      (g) =>
        String(g.vmid).includes(f) ||
        (g.name ?? '').toLowerCase().includes(f) ||
        (g.node ?? '').toLowerCase().includes(f),
    )
  }

  get runningCount(): number {
    return this.guests.filter((g) => g.status === 'running').length
  }

  get stoppedCount(): number {
    return this.guests.filter((g) => g.status !== 'running').length
  }

  setFilter(value: string): void {
    this.filter = value
  }

  async refresh(): Promise<void> {
    this.loading = true
    try {
      const api = (window as any).gyshell?.cluster
      if (!api?.getStatus) throw new Error('cluster gateway RPC not available')
      const data = (await api.getStatus()) as ClusterStatus
      runInAction(() => {
        this.status = data
        this.error = null
        this.lastUpdated = Date.now()
      })
    } catch (err) {
      runInAction(() => {
        this.error = err instanceof Error ? err.message : String(err)
      })
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }

  startPolling(intervalMs = 10000): void {
    void this.refresh()
    if (pollTimer) return
    pollTimer = setInterval(() => {
      void this.refresh()
    }, intervalMs)
  }

  stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

/** Singleton — the Cluster tab is a single global view. */
export const clusterStore = new ClusterStore()
