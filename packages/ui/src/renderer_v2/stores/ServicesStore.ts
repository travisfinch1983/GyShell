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
  // enriched by the native ground-truth probe (community-scripts catalog + http probe):
  proto?: 'http' | 'https' | 'tcp'
  status?: number | null
  url?: string | null
  category?: string
  icon?: string | null // dashboard-icons slug
  knownScript?: boolean
  title?: string
}

/** dashboard-icons CDN URL for a slug (public CDN — not a LAN resource, browser-direct is fine). */
export function iconUrl(slug?: string | null): string | null {
  return slug ? `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${slug}.svg` : null
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

  /**
   * Drop ProxLab's hardcoded `static` host entries (config.yaml) — they reference hosts
   * that no longer exist and show as connection errors (coding std #5: no stale hardcoded
   * data). AI-Lab's Services view reflects LIVE inventory (PVE guests + nodes). A native,
   * user-managed external-hosts list can be added later if needed.
   */
  private normalize(hosts: DiscoveryHost[]): DiscoveryHost[] {
    return hosts.filter((h) => h.guestType !== 'static')
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

  /**
   * Friendly name + whether it's a reachable web service (drives the status dot: green = http(s) up,
   * grey = raw tcp port). The native probe already identifies the app (svc.name), so a manual rename
   * (custom) or the shared serviceNames map only override it.
   */
  resolveName(hostId: string, svc: DiscoveredService): { name: string; reliable: boolean } {
    const reachable = svc.proto === 'http' || svc.proto === 'https'
    const custom = this.serviceNames.custom[`${hostId}:${svc.port}`]
    if (custom) return { name: custom, reliable: reachable }
    const common = this.serviceNames.common[`${svc.port}:${svc.process}`]
    if (common) return { name: common, reliable: reachable }
    const name = svc.name && svc.name !== 'Unknown' ? svc.name : (svc.process || `:${svc.port}`)
    return { name, reliable: reachable }
  }

  async load(): Promise<void> {
    this.loading = true
    try {
      const api = this.cluster()
      const [disc, settings] = await Promise.all([
        api.request('GET', '/api/discovery'),
        (window as any).gyshell?.clusterSettings?.get?.(),
      ])
      const hosts = this.normalize(Object.values(disc || {}) as DiscoveryHost[])
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
        this.hosts = this.normalize(Object.values(r || {}) as DiscoveryHost[])
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
