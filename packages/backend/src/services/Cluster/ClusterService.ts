/**
 * ClusterService — backend-side access to Proxmox cluster data for the Cluster tab.
 *
 * ARCHITECTURE / RULE #1: all cluster + PVE network calls live HERE on the backend
 * (CT 152), never in the browser. The renderer reaches this only through the
 * WebSocket gateway RPC `cluster:getStatus` (wired as `clusterBridge` in
 * startGyBackend.ts). For the first migration slice this proxies ProxLab's existing
 * `/api/pve/status` endpoint, which already owns the PVE integration (token, cluster
 * resources, guest config enrichment). The direct-PVE rebuild can later replace the
 * fetch target without changing the RPC surface or the renderer.
 *
 * Configure the upstream with PROXLAB_API_BASE (default http://10.0.0.140:7777).
 */
const DEFAULT_BASE = process.env.PROXLAB_API_BASE || 'http://10.0.0.140:7777'

export interface ClusterServiceOptions {
  proxlabBase?: string
  timeoutMs?: number
}

export class ClusterService {
  private readonly base: string
  private readonly timeoutMs: number

  constructor(opts: ClusterServiceOptions = {}) {
    this.base = (opts.proxlabBase || DEFAULT_BASE).replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 12000
  }

  /** Full cluster snapshot: { configured, cluster, nodes[], containers[], vms[], timestamp }. */
  async getStatus(): Promise<unknown> {
    const url = `${this.base}/api/pve/status`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const resp = await fetch(url, { signal: controller.signal })
      if (!resp.ok) {
        throw new Error(`ProxLab API responded ${resp.status} ${resp.statusText} for ${url}`)
      }
      return await resp.json()
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Shared singleton used by the gateway adapter's clusterBridge. */
export const clusterService = new ClusterService()
