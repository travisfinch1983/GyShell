import { WebSocket } from 'ws'

/**
 * CatalogInstallService — runs a Helper-Scripts installer on a PVE node and streams the
 * output to the renderer.
 *
 * RULE #1: the browser never connects to ProxLab directly. CT 152 has no cluster SSH key,
 * so we relay through ProxLab's existing terminal WebSocket (10.0.0.140:7777/ws) — ProxLab
 * already owns the SSH-to-node PTY. Output frames are pushed to the renderer via the gateway
 * `broadcastRaw` channel (`catalogInstall:data` / `catalogInstall:exit`), keyed by session id.
 * The native CT 152 → node SSH path can replace the relay later without changing the RPC.
 */
const DEFAULT_BASE = process.env.PROXLAB_API_BASE || 'http://10.0.0.140:7777'

type Publish = (channel: string, data: unknown) => void

export interface StartInstallOptions {
  host: string // PVE node IP
  command: string // full var-prefixed install command
  cols?: number
  rows?: number
}

export class CatalogInstallService {
  private readonly wsBase: string
  private readonly publish: Publish
  private readonly sessions = new Map<string, WebSocket>()
  private seq = 0

  constructor(opts: { publish: Publish; proxlabBase?: string }) {
    this.publish = opts.publish
    const base = (opts.proxlabBase || DEFAULT_BASE).replace(/\/+$/, '')
    this.wsBase = base.replace(/^http/, 'ws')
  }

  start({ host, command, cols = 120, rows = 30 }: StartInstallOptions): { id: string } {
    if (!host) throw new Error('host is required')
    const id = `ci-${++this.seq}-${Date.now()}`
    const sock = new WebSocket(`${this.wsBase}/ws`)
    const emit = (data: string) => this.publish('catalogInstall:data', { id, data })
    const exit = (code: number) => this.publish('catalogInstall:exit', { id, code })

    sock.on('open', () => {
      sock.send(JSON.stringify({ type: 'shell', host, cols, rows }))
    })
    sock.on('message', (buf: Buffer) => {
      let m: any
      try {
        m = JSON.parse(buf.toString())
      } catch {
        emit(buf.toString())
        return
      }
      if (m.type === 'shell-ready') {
        emit('\x1b[36m▶ connected — running installer…\x1b[0m\r\n')
        sock.send(JSON.stringify({ type: 'input', data: command + '\n' }))
      } else if (m.type === 'output' || m.type === 'data') {
        emit(m.data || m.output || '')
      } else if (m.type === 'shell-exit') {
        exit(typeof m.code === 'number' ? m.code : 0)
      } else if (m.type === 'error') {
        emit(`\r\n\x1b[31mError: ${m.message || m.error}\x1b[0m\r\n`)
        exit(1)
      }
    })
    sock.on('close', () => {
      exit(0)
      this.sessions.delete(id)
    })
    sock.on('error', (e: Error) => {
      emit(`\r\n\x1b[31mRelay error: ${e.message}\x1b[0m\r\n`)
      exit(1)
      this.sessions.delete(id)
    })
    this.sessions.set(id, sock)
    return { id }
  }

  input(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'input', data }))
  }
  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'resize', cols, rows }))
  }
  close(id: string): void {
    const s = this.sessions.get(id)
    if (s) {
      try {
        s.close()
      } catch {
        /* ignore */
      }
      this.sessions.delete(id)
    }
  }
}
