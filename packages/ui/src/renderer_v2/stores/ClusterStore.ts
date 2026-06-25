import { makeAutoObservable, runInAction } from 'mobx'
import {
  loadTemplates,
  saveTemplates,
  defaultTemplate,
  type MetricCategory,
  type MetricTemplate,
} from './metricTemplates'

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
  onboot?: number
  protection?: number
  console?: number
  ostype?: string
  startup?: string
  unprivileged?: number
  tty?: number
  cmode?: string
  features?: string
  lxcenv?: Record<string, string>
}

export interface ClusterStatus {
  configured?: boolean
  cluster?: ClusterInfo
  nodes?: ClusterNode[]
  containers?: ClusterGuest[]
  vms?: ClusterGuest[]
  timestamp?: number
}

export type GuestSortKey = 'vmid' | 'name' | 'node' | 'status' | 'cpu' | 'mem'
export type SortDir = 'asc' | 'desc'
export interface GuestSort {
  key: GuestSortKey
  dir: SortDir
}

const NODE_ORDER_KEY = 'ai-lab-cluster-node-order'

function loadNodeOrder(): string[] {
  try {
    const raw = localStorage.getItem(NODE_ORDER_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

// Kept out of the observable graph on purpose (a timer handle is not UI state).
let pollTimer: ReturnType<typeof setInterval> | null = null

export class ClusterStore {
  status: ClusterStatus | null = null
  loading = false
  error: string | null = null
  lastUpdated: number | null = null
  filter = ''
  // Persisted, user-defined node card order (by node name).
  nodeOrder: string[] = loadNodeOrder()
  ctSort: GuestSort = { key: 'vmid', dir: 'asc' }
  vmSort: GuestSort = { key: 'vmid', dir: 'asc' }
  // Write-action state
  actionBusy: number | null = null // vmid currently running a write action
  actionError: string | null = null
  // Lazily-loaded data for the migrate / GPU modals
  gpuInventory: Record<string, any> | null = null
  gpuAssignments: Record<string, any> | null = null
  storages: any[] | null = null
  // Per-category metric templates (LXC / VM rows render from these)
  metricTemplates: Record<MetricCategory, MetricTemplate> = loadTemplates()
  // vmids that are AI-pool agents (from /api/ai/config) — highlighted in the list
  aiVmids: Set<number> = new Set()

  constructor() {
    makeAutoObservable(this)
  }

  /**
   * Nodes in a STABLE display order: user-ordered names first (in saved order),
   * then any nodes not yet ordered, alphabetically. Without this, PVE returns
   * nodes in a varying order each poll and the cards appear to shuffle randomly.
   */
  get orderedNodes(): ClusterNode[] {
    const nodes = this.status?.nodes ?? []
    const byName = new Map(nodes.map((n) => [n.node, n]))
    const ordered: ClusterNode[] = []
    for (const name of this.nodeOrder) {
      const n = byName.get(name)
      if (n) {
        ordered.push(n)
        byName.delete(name)
      }
    }
    const rest = [...byName.values()].sort((a, b) => a.node.localeCompare(b.node))
    return [...ordered, ...rest]
  }

  setNodeOrder(order: string[]): void {
    this.nodeOrder = order
    try {
      localStorage.setItem(NODE_ORDER_KEY, JSON.stringify(order))
    } catch {
      /* ignore quota / serialization errors */
    }
  }

  /** Move the dragged node so it lands at the dropped-on node's position. */
  moveNode(fromName: string, toName: string): void {
    const current = this.orderedNodes.map((n) => n.node)
    const from = current.indexOf(fromName)
    const to = current.indexOf(toName)
    if (from < 0 || to < 0 || from === to) return
    const [moved] = current.splice(from, 1)
    current.splice(to, 0, moved)
    this.setNodeOrder(current)
  }

  private matchesFilter(g: ClusterGuest): boolean {
    const f = this.filter.trim().toLowerCase()
    if (!f) return true
    return (
      String(g.vmid).includes(f) ||
      (g.name ?? '').toLowerCase().includes(f) ||
      (g.node ?? '').toLowerCase().includes(f)
    )
  }

  private sortGuests(list: ClusterGuest[], sort: GuestSort): ClusterGuest[] {
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      let av: number | string
      let bv: number | string
      switch (sort.key) {
        case 'name':
          av = (a.name ?? '').toLowerCase()
          bv = (b.name ?? '').toLowerCase()
          break
        case 'node':
          av = (a.node ?? '').toLowerCase()
          bv = (b.node ?? '').toLowerCase()
          break
        case 'status':
          av = a.status ?? ''
          bv = b.status ?? ''
          break
        case 'cpu':
          av = a.cpu ?? 0
          bv = b.cpu ?? 0
          break
        case 'mem':
          av = a.mem ?? 0
          bv = b.mem ?? 0
          break
        default:
          av = a.vmid
          bv = b.vmid
      }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
  }

  get containers(): ClusterGuest[] {
    return this.sortGuests((this.status?.containers ?? []).filter((g) => this.matchesFilter(g)), this.ctSort)
  }

  get vms(): ClusterGuest[] {
    return this.sortGuests((this.status?.vms ?? []).filter((g) => this.matchesFilter(g)), this.vmSort)
  }

  setSort(table: 'ct' | 'vm', key: GuestSortKey): void {
    const cur = table === 'ct' ? this.ctSort : this.vmSort
    const next: GuestSort =
      cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    if (table === 'ct') this.ctSort = next
    else this.vmSort = next
  }

  private get allGuests(): ClusterGuest[] {
    return [...(this.status?.containers ?? []), ...(this.status?.vms ?? [])]
  }

  get runningCount(): number {
    return this.allGuests.filter((g) => g.status === 'running').length
  }

  get stoppedCount(): number {
    return this.allGuests.filter((g) => g.status !== 'running').length
  }

  setFilter(value: string): void {
    this.filter = value
  }

  // ─── metric templates ───────────────────────────────────────────────────────
  getTemplate(category: MetricCategory): MetricTemplate {
    return this.metricTemplates[category]
  }

  saveTemplate(category: MetricCategory, template: MetricTemplate): void {
    this.metricTemplates = { ...this.metricTemplates, [category]: template }
    saveTemplates(this.metricTemplates)
  }

  resetTemplate(category: MetricCategory): void {
    this.saveTemplate(category, defaultTemplate(category))
  }

  // ─── Write actions (all via the backend cluster:request proxy; rule #1) ──────
  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api.request(method, path, body)
  }

  /** Run a write action, track busy/error, then refresh the snapshot. */
  private async run(vmid: number, fn: () => Promise<unknown>): Promise<void> {
    runInAction(() => {
      this.actionBusy = vmid
      this.actionError = null
    })
    try {
      await fn()
      await this.refresh()
    } catch (err) {
      runInAction(() => {
        this.actionError = err instanceof Error ? err.message : String(err)
      })
    } finally {
      runInAction(() => {
        this.actionBusy = null
      })
    }
  }

  guestPower(vmid: number, action: 'start' | 'stop' | 'shutdown' | 'reboot'): Promise<void> {
    return this.run(vmid, () => this.req('POST', `/api/guests/${vmid}/${action}`))
  }

  setConfig(vmid: number, patch: Record<string, unknown>): Promise<void> {
    return this.run(vmid, () => this.req('PUT', `/api/guests/${vmid}/config`, patch))
  }

  setResources(vmid: number, patch: Record<string, unknown>): Promise<void> {
    return this.run(vmid, () => this.req('PUT', `/api/guests/${vmid}/resources`, patch))
  }

  resizeDisk(vmid: number, disk: string, size: string): Promise<void> {
    return this.run(vmid, () => this.req('PUT', `/api/guests/${vmid}/resize`, { disk, size }))
  }

  migrate(vmid: number, body: Record<string, unknown>): Promise<void> {
    return this.run(vmid, () => this.req('POST', `/api/guests/${vmid}/migrate`, body))
  }

  setFeatures(vmid: number, features: string): Promise<void> {
    return this.run(vmid, () => this.req('PUT', `/api/guests/${vmid}/features`, { features }))
  }

  setEnv(vmid: number, vars: Record<string, string>): Promise<void> {
    return this.run(vmid, () => this.req('PUT', `/api/guests/${vmid}/lxc-env`, { vars }))
  }

  isAi(vmid: number): boolean {
    return this.aiVmids.has(vmid)
  }

  async loadAiConfig(): Promise<void> {
    try {
      const cfg = (await this.req('GET', '/api/ai/config')) as any
      const agents = cfg?.agents ?? {}
      const ids = Object.values(agents)
        .map((a: any) => Number(a?.vmid))
        .filter((n) => Number.isFinite(n))
      runInAction(() => {
        this.aiVmids = new Set(ids)
      })
    } catch {
      /* non-fatal */
    }
  }

  setGpuAssignment(vmid: number, body: Record<string, unknown>): Promise<void> {
    return this.run(vmid, () => this.req('PUT', `/api/gpu/assignments/${vmid}`, body))
  }

  clearGpuAssignment(vmid: number): Promise<void> {
    return this.run(vmid, () => this.req('DELETE', `/api/gpu/assignments/${vmid}`))
  }

  /** Load GPU inventory/assignments + storages for the migrate / GPU modals. */
  async loadModalData(): Promise<void> {
    const [inv, asn, st] = await Promise.all([
      this.req('GET', '/api/gpu/inventory').catch(() => null),
      this.req('GET', '/api/gpu/assignments').catch(() => null),
      this.req('GET', '/api/storages').catch(() => null),
    ])
    runInAction(() => {
      this.gpuInventory = inv
      this.gpuAssignments = asn
      this.storages = Array.isArray(st) ? st : (st as any)?.storages ?? null
    })
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
