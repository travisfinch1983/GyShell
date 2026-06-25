import { makeAutoObservable, runInAction } from 'mobx'

/**
 * ServicesStore — service-discovery tab (migrated from ProxLab).
 *
 * Discovery data is read via the backend `cluster:request` proxy (ProxLab's SSH port
 * scan for now — native scan is a later port; rule #1 keeps it backend-side either way).
 * Friendly names come from the NATIVE `serviceNames` cluster-settings (the same store the
 * Service Names settings tab edits), so inline renames here persist natively.
 */
export interface DiscoveredService {
  port: number
  process: string
  name: string
  configured?: boolean
}
export interface DiscoveryHost {
  hostId: string
  hostName: string
  hostIp: string
  vmid: number | null
  guestType: string
  node: string | null
  services: DiscoveredService[]
  timestamp?: number
  error?: string | null
}
interface ServiceNames {
  common: Record<string, string>
  custom: Record<string, string>
}

// Generic runtimes whose process name isn't a meaningful service label.
const GENERIC = new Set(['node', 'python', 'python3', 'java', 'beam.smp', 'ruby', 'php', 'perl', 'dotnet'])

let pollTimer: ReturnType<typeof setInterval> | null = null

export class ServicesStore {
  hosts: DiscoveryHost[] = []
  serviceNames: ServiceNames = { common: {}, custom: {} }
  loading = false
  error: string | null = null
  lastUpdated: number | null = null
  scanningAll = false
  scanningHost: string | null = null
  filter = ''

  constructor() {
    makeAutoObservable(this)
  }

  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }

  get filteredHosts(): DiscoveryHost[] {
    const f = this.filter.trim().toLowerCase()
    const sorted = [...this.hosts].sort((a, b) => {
      if (!!a.error !== !!b.error) return a.error ? 1 : -1
      const order: Record<string, number> = { lxc: 0, node: 1, qemu: 2, static: 3 }
      const d = (order[a.guestType] ?? 9) - (order[b.guestType] ?? 9)
      return d !== 0 ? d : (a.hostName || '').localeCompare(b.hostName || '')
    })
    if (!f) return sorted
    return sorted.filter(
      (h) =>
        (h.hostName || '').toLowerCase().includes(f) ||
        (h.hostIp || '').includes(f) ||
        h.services.some((s) => String(s.port).includes(f) || (s.process || '').toLowerCase().includes(f)),
    )
  }

  get serviceCount(): number {
    return this.hosts.reduce((n, h) => n + (h.services?.length ?? 0), 0)
  }

  setFilter(v: string): void {
    this.filter = v
  }

  /** Friendly name + whether it's a reliable/known label (drives the status dot). */
  resolveName(hostId: string, svc: DiscoveredService): { name: string; reliable: boolean } {
    const custom = this.serviceNames.custom[`${hostId}:${svc.port}`]
    if (custom) return { name: custom, reliable: true }
    const common = this.serviceNames.common[`${svc.port}:${svc.process}`]
    if (common) return { name: common, reliable: true }
    if (GENERIC.has(svc.process) || /^port-\d+$/.test(svc.name || '')) return { name: 'Unknown', reliable: false }
    return { name: svc.name || svc.process || `:${svc.port}`, reliable: true }
  }

  async load(): Promise<void> {
    this.loading = true
    try {
      const api = this.cluster()
      const [disc, settings] = await Promise.all([
        api.request('GET', '/api/discovery'),
        (window as any).gyshell?.clusterSettings?.get?.(),
      ])
      const hosts = Object.values(disc || {}) as DiscoveryHost[]
      const sn = settings?.settings?.serviceNames ?? { common: {}, custom: {} }
      runInAction(() => {
        this.hosts = hosts
        this.serviceNames = { common: sn.common ?? {}, custom: sn.custom ?? {} }
        this.error = null
        this.lastUpdated = Date.now()
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }

  async rescanAll(): Promise<void> {
    this.scanningAll = true
    try {
      const r = await this.cluster().request('POST', '/api/discovery/scan')
      runInAction(() => {
        this.hosts = Object.values(r || {}) as DiscoveryHost[]
        this.lastUpdated = Date.now()
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.scanningAll = false
      })
    }
  }

  async rescanHost(hostId: string): Promise<void> {
    this.scanningHost = hostId
    try {
      const r = (await this.cluster().request('POST', `/api/discovery/scan/${hostId}`)) as DiscoveryHost
      runInAction(() => {
        this.hosts = this.hosts.map((h) => (h.hostId === hostId ? r : h))
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.scanningHost = null
      })
    }
  }

  /** Inline rename → persists to the NATIVE serviceNames store (blank clears the override). */
  async setCustomName(hostId: string, port: number, name: string): Promise<void> {
    const custom = { ...this.serviceNames.custom }
    const key = `${hostId}:${port}`
    if (name && name.trim()) custom[key] = name.trim()
    else delete custom[key]
    const next = { ...this.serviceNames, custom }
    runInAction(() => {
      this.serviceNames = next
    })
    await (window as any).gyshell.clusterSettings.set({ serviceNames: next })
  }

  startPolling(intervalMs = 30000): void {
    void this.load()
    if (pollTimer) return
    pollTimer = setInterval(() => void this.load(), intervalMs)
  }

  stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}

export const servicesStore = new ServicesStore()
