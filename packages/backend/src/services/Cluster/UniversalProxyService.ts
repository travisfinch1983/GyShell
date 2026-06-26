import http from 'node:http'
import { clusterService } from './ClusterService'

/**
 * UniversalProxyService — the AI-Lab Universal API Proxy (native replacement for ProxLab's
 * /api/proxy). A standalone HTTP listener (the WS gateway can't serve external API clients)
 * that fronts the running inference services by slot:
 *
 *   /llm/v1/chat/completions          → model-routed (body.model → service) else slot 1
 *   /llm/:slot/v1/...                 → specific LLM by proxySlot
 *   /embed/v1/... , /embed/:slot/...  → embedding service
 *   /rerank/v1|v2/... , /rerank/:slot → reranker
 *   /tts/v1/audio/speech , /tts/:slot → TTS
 *   /<type>/:slot/v1/...              → generic per-slot for any type
 *   GET /services                     → routing-state JSON
 *
 * The slot registry is refreshed from /api/ai/active-services (bridged for now) on a timer;
 * requests forward DIRECTLY to each service's containerIp:port (backend-side, rule #1) with
 * SSE pass-through. kvcache-proxy fronting later.
 */
const DEFAULT_PORT = Number(process.env.AILAB_PROXY_PORT || 17890)
const PROXY_TYPES = new Set(['llm', 'tts', 'stt', 'embed', 'rerank', 'image'])

interface ProxySvc {
  id: string
  type: string
  slot: number
  containerIp: string
  port: number
  model?: string
  aliasOverride?: string
  providerName?: string
  node?: string
}

export class UniversalProxyService {
  private server?: http.Server
  private registry: Record<string, ProxySvc[]> = {}
  private refreshTimer?: ReturnType<typeof setInterval>
  private lastRefresh = 0
  private readonly host: string
  private readonly port: number

  constructor(opts: { host?: string; port?: number } = {}) {
    this.host = opts.host || '0.0.0.0'
    this.port = opts.port || DEFAULT_PORT
  }

  async start(): Promise<void> {
    await this.refresh().catch(() => undefined)
    this.refreshTimer = setInterval(() => void this.refresh().catch(() => undefined), 10000)
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.on('error', (e) => console.warn('[universal-proxy] server error:', e))
    await new Promise<void>((resolve) => this.server!.listen(this.port, this.host, resolve))
    console.log(`[universal-proxy] listening on http://${this.host}:${this.port}`)
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()))
  }

  private async refresh(): Promise<void> {
    const data = (await clusterService.request('GET', '/api/ai/active-services')) as any
    const raw = data?.services ?? data ?? {}
    const list: any[] = Array.isArray(raw) ? raw : Object.values(raw)
    const reg: Record<string, ProxySvc[]> = {}
    for (const s of list) {
      const type = s.serviceType || 'llm'
      if (!PROXY_TYPES.has(type)) continue
      if (!s.containerIp || !s.port) continue
      ;(reg[type] ??= []).push({
        id: s.id,
        type,
        slot: typeof s.proxySlot === 'number' ? s.proxySlot : 0,
        containerIp: s.containerIp,
        port: s.port,
        model: s.model,
        aliasOverride: s.aliasOverride,
        providerName: s.providerName,
        node: s.node,
      })
    }
    for (const t of Object.keys(reg)) reg[t].sort((a, b) => a.slot - b.slot)
    this.registry = reg
    this.lastRefresh = Date.now()
  }

  /** Routing-state for the proxy card (served over the WS gateway, not this HTTP port). */
  getState(): unknown {
    return {
      port: this.port,
      lastRefresh: this.lastRefresh,
      types: this.registry,
    }
  }

  private bySlot(type: string, slot: number): ProxySvc | undefined {
    return (this.registry[type] || []).find((s) => s.slot === slot)
  }
  private defaultSvc(type: string): ProxySvc | undefined {
    return (this.registry[type] || [])[0]
  }
  /** Match body.model against served-name/alias/model; else first LLM. */
  private routeByModel(type: string, model?: string): ProxySvc | undefined {
    const pool = this.registry[type] || []
    if (model) {
      const m = model.toLowerCase()
      const hit = pool.find((s) => [s.aliasOverride, s.model, s.id].some((v) => v && v.toLowerCase() === m))
      if (hit) return hit
    }
    return pool[0]
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`)
    const path = url.pathname.replace(/^\/+/, '') // strip leading slash
    const parts = path.split('/')

    if (path === 'services' || path === 'health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.getState()))
      return
    }

    const type = parts[0]
    if (!PROXY_TYPES.has(type)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `unknown proxy type: ${type}` }))
      return
    }

    // /<type>/<slot>/v1/... (numeric slot) vs /<type>/v1/... (default/model-routed)
    const slotIsNum = /^\d+$/.test(parts[1] || '')
    const rest = '/' + parts.slice(slotIsNum ? 2 : 1).join('/') // e.g. /v1/chat/completions

    if (slotIsNum) {
      const svc = this.bySlot(type, parseInt(parts[1], 10))
      if (!svc) return this.unavailable(res, type, parseInt(parts[1], 10))
      return this.forward(req, res, svc, rest)
    }

    // No slot: model-routed for llm on chat/completions; else default slot.
    if (type === 'llm' && req.method === 'POST' && /\/v1\/(chat\/)?completions$/.test(rest)) {
      return this.bufferAndRoute(req, res, rest)
    }
    const svc = this.defaultSvc(type)
    if (!svc) return this.unavailable(res, type)
    this.forward(req, res, svc, rest)
  }

  private unavailable(res: http.ServerResponse, type: string, slot?: number): void {
    const avail = (this.registry[type] || []).map((s) => s.slot)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `no ${type} service${slot != null ? ` at slot ${slot}` : ''}`, availableSlots: avail }))
  }

  /** Buffer the body to read body.model, pick the service, then forward the buffered body. */
  private bufferAndRoute(req: http.IncomingMessage, res: http.ServerResponse, rest: string): void {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      let model: string | undefined
      try {
        model = JSON.parse(body.toString('utf8')).model
      } catch {
        /* ignore */
      }
      const svc = this.routeByModel('llm', model)
      if (!svc) return this.unavailable(res, 'llm')
      this.forward(req, res, svc, rest, body)
    })
    req.on('error', () => this.unavailable(res, 'llm'))
  }

  private forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    svc: ProxySvc,
    path: string,
    bufferedBody?: Buffer,
  ): void {
    const headers = { ...req.headers }
    headers.host = `${svc.containerIp}:${svc.port}`
    if (bufferedBody) headers['content-length'] = String(bufferedBody.length)

    const upstream = http.request(
      { host: svc.containerIp, port: svc.port, method: req.method, path, headers, timeout: 600000 },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `proxy upstream error: ${e.message}` }))
    })
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))

    if (bufferedBody) {
      upstream.end(bufferedBody)
    } else {
      req.pipe(upstream)
    }
  }
}

export const universalProxyService = new UniversalProxyService()
