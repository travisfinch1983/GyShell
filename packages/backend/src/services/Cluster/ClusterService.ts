/**
 * ClusterService — backend-side access to Proxmox cluster data + actions for the
 * Cluster tab.
 *
 * ARCHITECTURE / RULE #1: all cluster + PVE network calls live HERE on the backend
 * (CT 152), never in the browser. The renderer reaches this only through the
 * WebSocket gateway RPCs `cluster:getStatus` (read) and `cluster:request` (the
 * path-allowlisted proxy for actions), both wired as `clusterBridge` in
 * startGyBackend.ts. We proxy ProxLab's existing REST API (10.0.0.140:7777), which
 * already owns the PVE integration (token, migrations, GPU hookscripts, bind-mount
 * handling). The direct-PVE rebuild can later replace the fetch target without
 * changing the RPC surface or the renderer.
 *
 * Configure the upstream with PROXLAB_API_BASE (default http://10.0.0.140:7777).
 */
const DEFAULT_BASE = process.env.PROXLAB_API_BASE || 'http://10.0.0.140:7777'

export interface ClusterServiceOptions {
  proxlabBase?: string
  timeoutMs?: number
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class ClusterService {
  private readonly base: string
  private readonly timeoutMs: number

  // Only cluster-management paths are proxyable from the renderer.
  private static readonly ALLOWED_PREFIXES = ['/api/guests/', '/api/gpu', '/api/storages', '/api/pve/', '/api/ai', '/api/discovery', '/api/scripts', '/api/script-catalog', '/api/file-manager', '/api/civitai', '/api/system', '/api/mcp', '/api/ui-prefs', '/api/proxy', '/api/claude']

  constructor(opts: ClusterServiceOptions = {}) {
    this.base = (opts.proxlabBase || DEFAULT_BASE).replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 20000
  }

  // Prefixes served natively by AI-Lab's own proxy HTTP listener (not ProxLab). As tabs migrate
  // to native execution, add their prefixes here so the bridge routes to localhost, not ProxLab.
  // /api/ai is now fully native (the ported launch/scan/estimate/gpu/providers/services/HF router on the
  // universal proxy). AI-Lab only uses /api/ai/{providers,hf,active-services,config} + the launch
  // endpoints — none of the un-ported RAG/inventory sub-paths — so the whole prefix routes local.
  private static readonly LOCAL_PREFIXES = ['/api/civitai', '/api/ai', '/api/system', '/api/mcp', '/api/ui-prefs', '/api/proxy', '/api/claude']
  private localBase = `http://127.0.0.1:${process.env.AILAB_PROXY_PORT || 17890}`

  private async send(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
    const base = ClusterService.LOCAL_PREFIXES.some((p) => path.startsWith(p)) ? this.localBase : this.base
    const url = `${base}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const resp = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const text = await resp.text()
      const data = text ? safeJson(text) : null
      if (!resp.ok) {
        const msg = (data && (data as any).error) || `${resp.status} ${resp.statusText}`
        throw new Error(`ProxLab ${method} ${path}: ${msg}`)
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  /** Full cluster snapshot: { configured, cluster, nodes[], containers[], vms[], timestamp }. */
  async getStatus(): Promise<unknown> {
    return this.send('GET', '/api/pve/status')
  }

  /**
   * Path-allowlisted proxy used for all Cluster-tab actions (power, config,
   * resources, resize, migrate, gpu). Rejects anything outside the cluster API.
   */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const m = (method || 'GET').toUpperCase() as HttpMethod
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(m)) {
      throw new Error(`cluster proxy: method not allowed: ${m}`)
    }
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('..')) {
      throw new Error(`cluster proxy: invalid path: ${path}`)
    }
    if (!ClusterService.ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
      throw new Error(`cluster proxy: path not allowed: ${path}`)
    }
    return this.send(m, path, body)
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/** Shared singleton used by the gateway adapter's clusterBridge. */
export const clusterService = new ClusterService()
