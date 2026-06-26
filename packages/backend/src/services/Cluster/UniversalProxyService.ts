import http from 'node:http'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as ssh2 from 'ssh2'
// @ts-expect-error — ported ProxLab routers are plain JS (run under tsx), no .d.ts
import { createProxyRouter } from './proxy/proxy.js'
// @ts-expect-error
import { createVectorProxyRouter } from './proxy/vector-proxy.js'
// @ts-expect-error
import { createAnthropicProxyRouter } from './proxy/anthropic-proxy.js'
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

    const express = (await import('express')).default
    const app = express()
    app.use('/api/proxy/vector', createVectorProxyRouter())
    app.use('/api/proxy/anthropic', createAnthropicProxyRouter())
    app.use('/api/proxy', createProxyRouter({ exec: this.sshExec }))

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
  }

  /** Routing-state for the proxy card (served over the WS gateway). */
  getState(): unknown {
    return { port: this.port, basePath: '/api/proxy', lastRefresh: this.lastRefresh, types: this.registry }
  }
}

export const universalProxyService = new UniversalProxyService()
