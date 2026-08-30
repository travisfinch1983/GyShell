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
  private cacheReconcileTimer?: ReturnType<typeof setInterval>
  private lastRefresh = 0
  private host = '0.0.0.0'
  private port = DEFAULT_PORT
  private dataDir = '/opt/ai-lab/.gybackend-data'
  private keyPath = ''
  private privateKey?: Buffer
  private lanIp = '127.0.0.1'
  private fullServices: unknown = null
  private vectorList: unknown = null
  /** AI-Lab x Hermes control-plane HTTP surface (createHermesRouter) — set via start opts. */
  private hermesRouter: unknown = null
  /** NotificationsService — set via start opts; receives ai.js broadcast() events + mounts /api/notifications. */
  private notifications: { ingestAiEvent: (msg: any) => void } | null = null
  private agentToolsRouter: unknown = null

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

  async start(opts: { dataDir?: string; host?: string; port?: number; hermesRouter?: unknown; agentToolsRouter?: unknown; notifications?: unknown } = {}): Promise<void> {
    this.notifications = (opts.notifications as typeof this.notifications) ?? this.notifications
    this.hermesRouter = opts.hermesRouter ?? this.hermesRouter
    this.agentToolsRouter = opts.agentToolsRouter ?? this.agentToolsRouter
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
    const { createFlowchartsRouter } = await import('./flowchartsHttp')
    const { createPagesRouter } = await import('./pagesHttp')
    const { createReportsRouter } = await import('./reportsHttp')
    const { createJournalRouter } = await import('./journalHttp')
    const { createSvgsRouter } = await import('./svgsHttp')
    const { createNotesRouter } = await import('./notesHttp')
    // @ts-expect-error — native service-log viewer (tails logs over AI-Lab's own SSH, reads local data)
    const { createSystemRouter } = await import('./proxy/system.js')
    // @ts-expect-error — full native LLM/AI router: launch, models/scan, estimate, gpu, providers, services, HF
    const { createAiRouter } = await import('./proxy/llm/routes/ai.js')
    // @ts-expect-error
    const { SSHService } = await import('./proxy/llm/services/ssh.js')
    // @ts-expect-error
    const { MultiPveApi } = await import('./proxy/llm/services/multi-pve-api.js')
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
    const llmPve = new MultiPveApi(llmConfig)
    const llmGpuMon = new GpuMonitor(llmConfig, llmSsh, llmPve, { interval: 5000 })
    const llmHook = new HookscriptDeploy(llmSsh, llmPve, llmGpuMon, llmConfig)
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

    // #263: AI-Lab now owns service health recovery (ProxLab is decommissioned, so no dueling
    // watchdogs). The watchdog honors the persisted enable flag and always skips suspended
    // services, and re-checks suspend/disable intent immediately before any restart — so a
    // suspended service is never auto-resurrected.
    // The watchdog's broadcast() events (watchdog-restart / watchdog-never-healthy)
    // finally get their consumer: the Notifications panel.
    if (this.notifications) {
      const sink = this.notifications
      aiModule.setBroadcast?.((msg: unknown) => {
        try { sink.ingestAiEvent(msg as { type?: string }) } catch { /* a bad event must not kill the proxy */ }
      })
    }
    aiModule.startWatchdog?.()

    // #266 auto model-cacher: on boot, reconcile the tmpfs cache against the model-cache.json
    // manifest (the explicit "keep cached" set) — re-copy anything a host reboot cleared. Deferred
    // so the PVE nodeMap (needed to resolve host IPs) has populated from the poll above.
    setTimeout(() => {
      Promise.resolve(aiModule.runCacheReconcile?.('boot'))
        .then((s: any) => s && console.log('[universal-proxy] cache reconcile (boot):', JSON.stringify({
          totalEntries: s.totalEntries, present: s.present, missing: s.missing, requeued: s.requeued, skippedNodes: s.skippedNodes,
        })))
        .catch((e: any) => console.warn('[universal-proxy] boot cache reconcile failed:', e?.message))
      Promise.resolve(aiModule.runOrphanCleanup?.('boot'))
        .then((s: any) => { if (s && s.count > 0) console.log('[universal-proxy] orphan cleanup (boot): removed', s.count, 'orphan unit(s)') })
        .catch(() => undefined)
    }, 30000)

    // #266 follow-up: a NODE reboot (e.g. px-epyc) wipes its tmpfs /model-cache but does NOT restart
    // AI-Lab, so the one-shot boot reconcile above never re-fires and the cache stays empty until a
    // manual trigger. Poll periodically (single-flight guarded in runCacheReconcile; ~sub-second when
    // everything is present) so a rebooted node auto-refills within the interval. Cache is only a perf
    // optimization (services fall back to NAS via the mc() resolver), so a modest cadence is enough.
    this.cacheReconcileTimer = setInterval(() => {
      Promise.resolve(aiModule.runCacheReconcile?.('periodic'))
        .then((s: any) => { if (s && s.requeued > 0) console.log('[universal-proxy] cache reconcile (periodic): re-queued', s.requeued, 'missing cache entr(ies)', JSON.stringify({ present: s.present, missing: s.missing, byNode: s.byNode })) })
        .catch(() => undefined)
      Promise.resolve(aiModule.runOrphanCleanup?.('periodic'))
        .then((s: any) => { if (s && s.count > 0) console.log('[universal-proxy] orphan cleanup (periodic): removed', s.count, 'orphan(s):', (s.cleaned || []).join(', ')) })
        .catch(() => undefined)
    }, 10 * 60 * 1000)

    const app = express()
    app.use('/api/proxy/vector', createVectorProxyRouter())
    // Claude MAX-subscription proxy (direct api.anthropic.com via OAuth). Mounted at the
    // canonical /claude-max path the proxy card advertises, with /anthropic kept as a
    // back-compat alias. One router instance serves both mounts.
    //
    // DISABLED BY DEFAULT since 2026-08-20 (Travis). Its whole purpose was to point
    // Anthropic/OpenAI-API clients at the MAX subscription back when `claude -p` did not
    // consume extra usage credits. Anthropic has since changed that, so it has no current
    // use. Measured before switching it off: ZERO requests to the route across ~3 weeks of
    // journal retention, while its OAuth refresh failed every 30 minutes — 961
    // `invalid_grant: Refresh token expired` lines, pure noise on a path nobody calls.
    //
    // Creating the router also STARTS that refresh timer (anthropic-proxy.js:73 ->
    // startBackgroundRefresh), so NOT calling the factory stops the routes AND the noise.
    //
    // Re-enable with CLAUDE_MAX_PROXY=1 in the systemd unit. NOTE: the OAuth credentials on
    // this host (~/.claude/.credentials.json) are EXPIRED — re-authenticate Claude Code here
    // first, or supply CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_MAX_TOKEN_FILE, or it will just
    // resume failing.
    const claudeMaxEnabled = /^(1|true|yes|on)$/i.test(String(process.env.CLAUDE_MAX_PROXY || ''))
    if (claudeMaxEnabled) {
      const claudeMaxRouter = createAnthropicProxyRouter()
      app.use('/api/proxy/claude-max', claudeMaxRouter)
      app.use('/api/proxy/anthropic', claudeMaxRouter)
    } else {
      console.log('[universal-proxy] Claude MAX proxy DISABLED (set CLAUDE_MAX_PROXY=1 to re-enable)')
      // Answer explicitly rather than letting these fall through to the generic /api/proxy
      // router below, which would 404 or mis-route and make this look like a bug.
      const disabled = (_req: any, res: any) => res.status(503).json({
        error: 'claude-max proxy disabled',
        detail: 'The Claude MAX-subscription proxy is intentionally disabled (CLAUDE_MAX_PROXY unset). '
          + 'Anthropic now bills `claude -p` as extra usage credits, so this path is not in use.',
      })
      app.use('/api/proxy/claude-max', disabled)
      app.use('/api/proxy/anthropic', disabled)
    }
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
    if (this.agentToolsRouter) app.use(this.agentToolsRouter as any) // /api/mcp/agent-tools/* — before /api/mcp
    const { createMcpRouter } = await import('./proxy/mcp.js')
    app.use('/api/mcp', createMcpRouter({ exec: this.sshExec }))

    // Search metaproxy — stable URL for the self-hosted SearXNG instance (Travis's rule:
    // services are addressed via the proxy, never raw IP:PORT, so the URL survives moves).
    // Passthrough only; SearXNG's own API shape (/search?q=&format=json) is the contract.
    const SEARXNG_BACKEND = process.env.AILAB_SEARXNG_URL || 'http://127.0.0.1:8888'
    app.use('/api/proxy/search', async (req: any, res: any) => {
      try {
        const target = `${SEARXNG_BACKEND}${req.url}`
        const r = await fetch(target, { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } })
        res.status(r.status)
        const ct = r.headers.get('content-type'); if (ct) res.setHeader('content-type', ct)
        res.send(Buffer.from(await r.arrayBuffer()))
      } catch (e) {
        res.status(502).json({ error: `searxng unreachable: ${String((e as Error).message)}` })
      }
    })
    const { createUiPrefsRouter } = await import('./proxy/ui-prefs.js')
    app.use('/api/ui-prefs', createUiPrefsRouter())
    const { createClaudeRouter, attachClaudeTermUpgrade } = await import('./proxy/claude.js')
    app.use('/api/claude', createClaudeRouter({ exec: this.sshExec }))
    // @ts-expect-error — JS router: LoRA training-image browser/organizer (local-fs + sharp on /ai-assets/imagegen)
    const { createImagegenRouter } = await import('./proxy/llm/routes/imagegen.js')
    app.use('/api/imagegen', createImagegenRouter({ keyPath: this.keyPath }))
    // @ts-expect-error — JS router: native service discovery (replaces ProxLab-bridged /api/discovery)
    const { createDiscoveryRouter } = await import('./proxy/discovery.js')
    app.use('/api/discovery', createDiscoveryRouter({ dataDir: this.dataDir }))
    // @ts-expect-error — JS router: Dynacat (Home dashboard) config editor — read/validate/save the YAML
    const { createDynacatRouter } = await import('./proxy/dynacat.js')
    app.use('/api/dynacat', createDynacatRouter())
    // @ts-expect-error — JS router: runtime addon registry + reverse-proxy (drop-in addons, no rebuild)
    const { createAddonsRouter, createAddonsProxyRouter, attachAddonsUpgrade } = await import('./proxy/addons.js')
    app.use('/api/addons', createAddonsRouter())          // GET list of registered addons (runtime)
    app.use('/addons', createAddonsProxyRouter())         // reverse-proxy /addons/<id>/* + shared theme.css
    // @ts-expect-error — JS router: native helper-script list/run (replaces ProxLab-bridged /api/scripts)
    const { createScriptsRouter } = await import('./proxy/scripts.js')
    app.use('/api/scripts', express.json({ limit: '10mb' }), createScriptsRouter({ sshExec: this.sshExec, pveApi: llmPve, dataDir: this.dataDir }))
    // @ts-expect-error — JS router: native community-scripts catalog (replaces ProxLab-bridged /api/script-catalog)
    const { createScriptCatalogRouter } = await import('./proxy/script-catalog.js')
    app.use('/api/script-catalog', express.json({ limit: '10mb' }), createScriptCatalogRouter({ pveApi: llmPve, sshExec: this.sshExec, dataDir: this.dataDir }))
    // Fleet FEED: the Fleet tab's surface, proxied to fleetd. Sole owner of
    // /api/fleet/* since the ConversationBus router retired (bus-retirement 3/5).
    {
      const { createFleetFeedRouter } = await import('../Fleet/fleetFeedHttp.js')
      app.use(createFleetFeedRouter())
    }
    // AI-Lab x Hermes control plane (createHermesRouter): /api/hermes/* — before the broad /api cluster router.
    if (this.hermesRouter) {
      app.use(this.hermesRouter)
    }
    // Flowchart diagram store: /api/flowcharts/* — before the broad /api cluster router.
    app.use(createFlowchartsRouter(this.dataDir))
    // Pages store (Pages tab): /api/pages/* — versioned documents, same dataDir pattern.
    app.use(createPagesRouter(this.dataDir))
    // Reports and the Journal are their OWN surfaces, not sub-paths of pages:
    // three separate things, three separate toolsets (Travis 2026-08-30).
    app.use(createReportsRouter(this.dataDir))
    app.use(createJournalRouter(this.dataDir))
    // Notifications: /api/notifications/* — state, emit (the estate-wide cheap path), ack, debug.
    if (this.notifications) {
      const { createNotificationsRouter } = await import('../Notifications/notificationsHttp')
      app.use(createNotificationsRouter(this.notifications as never))
    }
    // SVG store + rasteriser, feeding both the SVG tab and the svg_* MCP tools.
    app.use(createSvgsRouter(this.dataDir))
    app.use(createNotesRouter(this.dataDir))
    // @ts-expect-error — JS router: native Proxmox cluster/guest/GPU management (replaces ProxLab-bridged
    // /api/pve, /api/guests, /api/gpu, /api/storages). Mounted at /api (declares its real public paths);
    // placed AFTER the specific /api/* routers so it can't shadow them.
    // AI-Lab FTP control plane (createFtpRouter): /api/ftp/* — SFTPGo (ai-lab-ftp.service) wrapper.
    {
      const { FtpService } = await import('../Ftp/FtpService')
      const { createFtpRouter } = await import('../Ftp/ftpHttp')
      const ftp = new FtpService({
        adminUrl: process.env.SFTPGO_ADMIN_URL || 'http://127.0.0.1:8092',
        adminUser: process.env.SFTPGO_ADMIN_USER || 'ailab',
        adminPass: process.env.SFTPGO_ADMIN_PASS || '',
        sftpPort: Number(process.env.FTP_SFTP_PORT || 2022),
        ftpPort: Number(process.env.FTP_FTP_PORT || 2121),
        publicHost: process.env.FTP_PUBLIC_HOST || this.lanIp,
      })
      app.use(createFtpRouter(ftp))
    }

    // AI-Lab native-tools bridge (config federation): /api/agent/native-tools surfaces the
    // agent built-in tools to the gateway (the ailab-native MCP server mirrors them).
    {
      const { createNativeToolsRouter } = await import('../Agent/nativeToolsHttp')
      app.use(createNativeToolsRouter())
    }

    const { createClusterRouter } = await import('./proxy/cluster.js')
    app.use('/api', express.json({ limit: '10mb' }), createClusterRouter({
      pveApi: llmPve, gpuMonitor: llmGpuMon, hookscriptDeploy: llmHook,
      sshExec: this.sshExec, dataDir: this.dataDir,
    }))

    this.server = http.createServer(app)
    attachClaudeTermUpgrade(this.server) // ttyd WebSocket reverse-proxy for the Claude tab terminals (kept during the native-console transition)
    attachAddonsUpgrade(this.server) // addon WebSocket reverse-proxy (/addons/<id>/*)
    // Native xterm.js console bridge (/api/claude/console/:id) — single-writer dtach attach
    // over SSH; replaces the ttyd terminals once verified (ailab-native-console.md).
    const { ClaudeConsoleService } = await import('../ClaudeConsole/ClaudeConsoleService')
    new ClaudeConsoleService({
      managerUrl: (process.env.CLAUDE_INSTANCE_MANAGER_URL || 'http://10.0.0.161:7700').replace(/\/+$/, ''),
      sshKeyPath: this.keyPath,
      sshTarget: process.env.CLAUDE_CONSOLE_SSH_TARGET || 'root@10.0.0.161',
    }).attachUpgrade(this.server)
    this.server.on('error', (e) => console.warn('[universal-proxy] server error:', e))
    await new Promise<void>((resolve) => this.server!.listen(this.port, this.host, resolve))
    console.log(`[universal-proxy] listening on http://${this.host}:${this.port}/api/proxy`)
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.cacheReconcileTimer) clearInterval(this.cacheReconcileTimer)
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
