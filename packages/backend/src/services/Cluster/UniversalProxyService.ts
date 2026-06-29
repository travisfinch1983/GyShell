import http from 'node:http'
import os from 'node:os'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as ssh2 from 'ssh2'
import { clusterService } from './ClusterService'

/**
 * UniversalProxyService — the AI-Lab Universal API Proxy. A dedicated HTTP listener
 * (the WS gateway can't serve external API clients) that hosts a 1:1 port of ProxLab's
 * proxy routers (createProxyRouter / createVectorProxyRouter / createAnthropicProxyRouter)
 * under Express, mounted at /api/proxy(/vector|/anthropic).
 *
 * Adaptation shims:
 *  - active-services: we sync the bridged /api/ai/active-services into <dataDir>/active-services.json
 *    (AILAB_PROXY_DATA_DIR) which the ported proxy.js reads unchanged. Native once launches move over.
 *  - sshService.exec(host, cmd, {timeout}) → ssh2 with AI-Lab's own cluster key (rule #1: backend-side).
 *  - vector self-refs (EMBED_URL / RERANKER_URL) repointed at this proxy's port.
 */
const DEFAULT_PORT = Number(process.env.AILAB_PROXY_PORT || 17890)
const PROXY_TYPES = new Set(['llm', 'tts', 'stt', 'embed', 'rerank', 'image'])

export class UniversalProxyService {
  private server?: http.Server
  private registry: Record<string, any[]> = {}
  private refreshTimer?: ReturnType<typeof setInterval>
  private lastRefresh = 0
  private host = '0.0.0.0'
  private port = DEFAULT_PORT
  private dataDir = '/opt/ai-lab/.gybackend-data'
  private keyPath = ''
  private privateKey?: Buffer
  private lanIp = '127.0.0.1'
  private fullServices: unknown = null
  private vectorList: unknown = null

  private detectLanIp(): string {
    const ifaces = os.networkInterfaces()
    let firstNonInternal = '127.0.0.1'
    for (const list of Object.values(ifaces)) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          if (ni.address.startsWith('10.')) return ni.address
          if (firstNonInternal === '127.0.0.1') firstNonInternal = ni.address
        }
      }
    }
    return firstNonInternal
  }

  private loadKey(): Buffer {
    if (!this.privateKey) this.privateKey = readFileSync(this.keyPath)
    return this.privateKey
  }

  /** sshService.exec shim matching ProxLab: returns { code, stdout, stderr }. */
  private sshExec = (host: string, cmd: string, opts: { timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      let key: Buffer
      try {
        key = this.loadKey()
      } catch (e) {
        resolve({ code: 255, stdout: '', stderr: `ssh key missing: ${(e as Error).message}` })
        return
      }
      const conn = new ssh2.Client()
      let stdout = '', stderr = '', done = false
      const finish = (code: number) => {
        if (done) return
        done = true
        try {
          conn.end()
        } catch {
          /* ignore */
        }
        resolve({ code, stdout, stderr })
      }
      const to = setTimeout(() => finish(124), (opts.timeout || 15000) + 3000)
      conn.on('ready', () =>
        conn.exec(cmd, (err, stream) => {
          if (err) return finish(1)
          stream
            .on('close', (code: number) => {
              clearTimeout(to)
              finish(code ?? 0)
            })
            .on('data', (d: Buffer) => (stdout += d.toString()))
            .stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        }),
      )
      conn.on('error', (e: Error) => {
        stderr += e.message
        finish(255)
      })
      conn.connect({ host, port: 22, username: 'root', privateKey: key, readyTimeout: opts.timeout || 12000, hostVerifier: () => true })
    })

  async start(opts: { dataDir?: string; host?: string; port?: number } = {}): Promise<void> {
    this.dataDir = opts.dataDir || this.dataDir
    this.host = opts.host || this.host
    this.port = opts.port || this.port
    this.keyPath = process.env.AILAB_SSH_KEY || path.join(this.dataDir, 'ssh', 'id_ed25519')
    this.lanIp = this.detectLanIp()

    // env consumed by the ported routers (data dir + vector self-refs at our port)
    process.env.AILAB_PROXY_DATA_DIR = this.dataDir
    const self = `http://127.0.0.1:${this.port}/api/proxy`
    process.env.EMBED_URL = process.env.EMBED_URL || `${self}/embed/v1/embeddings`
    process.env.RERANKER_URL = process.env.RERANKER_URL || `${self}/rerank/v2/rerank`
    try {
      mkdirSync(this.dataDir, { recursive: true })
    } catch {
      /* ignore */
    }

    await this.refresh().catch(() => undefined)
    this.refreshTimer = setInterval(() => void this.refresh().catch(() => undefined), 10000)

    // Dynamic import AFTER env is set — the ported proxy.js reads PROXY_DATA_DIR at module load.
    const express = (await import('express')).default
    // @ts-expect-error — ported ProxLab routers are plain JS (run under tsx), no .d.ts
    const { createProxyRouter } = await import('./proxy/proxy.js')
    // @ts-expect-error
    const { createVectorProxyRouter } = await import('./proxy/vector-proxy.js')
    // @ts-expect-error
    const { createAnthropicProxyRouter } = await import('./proxy/anthropic-proxy.js')
    // @ts-expect-error — native CivitAI downloader (runs curl inside CT 152, writes to local /ai-assets)
    const { createCivitaiRouter } = await import('./proxy/civitai.js')
    // @ts-expect-error — native service-log viewer (tails logs over AI-Lab's own SSH, reads local data)
    const { createSystemRouter } = await import('./proxy/system.js')
    // @ts-expect-error — full native LLM/AI router: launch, models/scan, estimate, gpu, providers, services, HF
    const { createAiRouter } = await import('./proxy/llm/routes/ai.js')
    // @ts-expect-error
    const { SSHService } = await import('./proxy/llm/services/ssh.js')
    // @ts-expect-error
    const { PveApi } = await import('./proxy/llm/services/pve-api.js')
    // @ts-expect-error
    const { GpuMonitor } = await import('./proxy/llm/services/gpu-monitor.js')
    // @ts-expect-error
    const { HookscriptDeploy } = await import('./proxy/llm/services/hookscript-deploy.js')

    // LLM backend config (PVE API token + cluster metadata); force AI-Lab's own SSH key regardless of file.
    let llmConfig: any = {}
    try {
      llmConfig = JSON.parse(readFileSync(path.join(this.dataDir, 'llm-config.json'), 'utf8'))
    } catch {
      /* seeded on deploy */
    }
    llmConfig.ssh = { ...(llmConfig.ssh || {}), privateKeyPath: this.keyPath, defaultUser: 'root', connectTimeout: 10000 }
    const llmSsh = new SSHService(llmConfig.ssh)
    const llmPve = new PveApi(llmConfig)
    const llmGpuMon = new GpuMonitor(llmConfig, llmSsh, llmPve, { interval: 5000 })
    const llmHook = new HookscriptDeploy(llmSsh, llmPve, llmGpuMon, llmConfig)
    // Deliberately NOT calling startWatchdog()/startScanTimer() — ProxLab still runs those; dueling
    // watchdogs would double-restart services. Re-enable once ProxLab is decommissioned.
    const aiModule = createAiRouter(llmConfig, llmGpuMon, llmPve, llmSsh, llmHook)

    // Start live polling so /agent-gpus + /estimate placements populate (PVE guests + GPU metrics).
    // Read-only; runs alongside ProxLab's pollers until it's decommissioned.
    try {
      await llmPve.refreshAll?.()
    } catch {
      /* first poll may race; the interval will catch up */
    }
    llmPve.startRefresh?.(10000)
    Promise.resolve(llmGpuMon.start?.()).catch(() => undefined)

    const app = express()
    app.use('/api/proxy/vector', createVectorProxyRouter())
    app.use('/api/proxy/anthropic', createAnthropicProxyRouter())
    app.use('/api/proxy', createProxyRouter({ exec: this.sshExec }))
    app.use('/api/civitai', express.json({ limit: '10mb' }), createCivitaiRouter({}, { exec: this.sshExec }))
    // RAG routes (/api/ai/rag/*, /api/ai/docrag/*) registered BEFORE the /api/ai router so the specific
    // codebase/document-RAG paths match first.
    const { registerRagRoutes } = await import('./proxy/rag.js')
    registerRagRoutes(app, { exec: this.sshExec, selfPort: this.port })
    // Cluster Inventory / Hardware / Credential vault (also under /api/ai/* — mount before the /api/ai router)
    const { createInventoryRouter } = await import('./proxy/inventory.js')
    const invModule = createInventoryRouter(llmPve)
    const invJson = express.json({ limit: '10mb' })
    app.use('/api/ai/inventory', invJson, invModule.invRouter)
    app.use('/api/ai/hosts', invJson, invModule.hostRouter)
    app.use('/api/ai/credentials', invJson, invModule.credRouter)
    app.use('/api/ai', express.json({ limit: '50mb' }), aiModule.router)
    app.use('/api/system', createSystemRouter({ exec: this.sshExec }))
    const { createMcpRouter } = await import('./proxy/mcp.js')
    app.use('/api/mcp', createMcpRouter({ exec: this.sshExec }))
    const { createUiPrefsRouter } = await import('./proxy/ui-prefs.js')
    app.use('/api/ui-prefs', createUiPrefsRouter())

    this.server = http.createServer(app)
    this.server.on('error', (e) => console.warn('[universal-proxy] server error:', e))
    await new Promise<void>((resolve) => this.server!.listen(this.port, this.host, resolve))
    console.log(`[universal-proxy] listening on http://${this.host}:${this.port}/api/proxy`)
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()))
  }

  /** Sync bridged active-services into the file the ported proxy.js reads + build card registry. */
  private async refresh(): Promise<void> {
    const data = (await clusterService.request('GET', '/api/ai/active-services')) as any
    const rawObj = data?.services ?? data ?? {}
    const servicesObj = Array.isArray(rawObj)
      ? Object.fromEntries(rawObj.map((s: any) => [s.id, s]))
      : rawObj
    // file the ported router reads (unchanged ProxLab format: { services: {...} })
    try {
      writeFileSync(path.join(this.dataDir, 'active-services.json'), JSON.stringify({ services: servicesObj }))
    } catch {
      /* ignore */
    }
    // card registry (slot list per type)
    const reg: Record<string, any[]> = {}
    for (const s of Object.values(servicesObj) as any[]) {
      const type = s.serviceType || 'llm'
      if (!PROXY_TYPES.has(type) || !s.containerIp || !s.port) continue
      ;(reg[type] ??= []).push({
        id: s.id,
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

    // Pull the ported router's full /services + vector list (once listening) for the card.
    if (this.server?.listening) {
      const get = async (p: string) => {
        const r = await fetch(`http://127.0.0.1:${this.port}${p}`, { signal: AbortSignal.timeout(8000) })
        return r.ok ? r.json() : null
      }
      this.fullServices = await get('/api/proxy/services').catch(() => null)
      const vl = await get('/api/proxy/vector/list').catch(() => null)
      this.vectorList = (vl as any)?.databases ?? null
    }
  }

  /** Routing-state for the proxy card (served over the WS gateway). */
  getState(): unknown {
    return {
      port: this.port,
      basePath: '/api/proxy',
      lanIp: this.lanIp,
      lastRefresh: this.lastRefresh,
      types: this.registry,
      services: this.fullServices,
      vector: this.vectorList,
    }
  }
}

export const universalProxyService = new UniversalProxyService()
