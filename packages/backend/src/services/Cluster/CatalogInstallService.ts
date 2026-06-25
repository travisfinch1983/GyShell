import * as ssh2 from 'ssh2'
import { readFileSync } from 'fs'

/**
 * CatalogInstallService — runs a Helper-Scripts installer on a PVE node and streams the
 * output to the renderer. FULLY NATIVE: CT 152 SSHes to the node itself with AI-Lab's own
 * key (no ProxLab dependency). Output frames are pushed to the renderer via the gateway
 * `broadcastRaw` channel (`catalogInstall:data` / `catalogInstall:exit`), keyed by session id.
 *
 * RULE #1: the SSH/PTY runs on the backend (CT 152); the browser only talks to the gateway.
 */
type Publish = (channel: string, data: unknown) => void

export interface StartInstallOptions {
  host: string // PVE node IP
  command: string // full var-prefixed install command
  cols?: number
  rows?: number
}

interface Session {
  conn: ssh2.Client
  stream?: ssh2.ClientChannel
}

export class CatalogInstallService {
  private readonly publish: Publish
  private readonly keyPath: string
  private readonly user: string
  private privateKey?: Buffer
  private readonly sessions = new Map<string, Session>()
  private seq = 0

  constructor(opts: { publish: Publish; keyPath: string; user?: string }) {
    this.publish = opts.publish
    this.keyPath = opts.keyPath
    this.user = opts.user || 'root'
  }

  private loadKey(): Buffer {
    if (!this.privateKey) this.privateKey = readFileSync(this.keyPath)
    return this.privateKey
  }

  start({ host, command, cols = 120, rows = 30 }: StartInstallOptions): { id: string } {
    if (!host) throw new Error('host is required')
    const id = `ci-${++this.seq}-${Date.now()}`
    const emit = (data: string) => this.publish('catalogInstall:data', { id, data })
    const exit = (code: number) => this.publish('catalogInstall:exit', { id, code })

    let key: Buffer
    try {
      key = this.loadKey()
    } catch {
      emit(`\r\n\x1b[31mAI-Lab SSH key not found at ${this.keyPath}.\x1b[0m\r\n`)
      exit(1)
      return { id }
    }

    const conn = new ssh2.Client()
    this.sessions.set(id, { conn })

    conn.on('ready', () => {
      emit('\x1b[36m▶ connected — running installer…\x1b[0m\r\n')
      conn.shell({ term: 'xterm-256color', cols, rows } as any, (err, stream) => {
        if (err) {
          emit(`\r\n\x1b[31mShell error: ${err.message}\x1b[0m\r\n`)
          exit(1)
          conn.end()
          return
        }
        const s = this.sessions.get(id)
        if (s) s.stream = stream
        stream.on('data', (d: Buffer) => emit(d.toString('utf8')))
        stream.stderr.on('data', (d: Buffer) => emit(d.toString('utf8')))
        stream.on('close', () => {
          exit(0)
          try {
            conn.end()
          } catch {
            /* ignore */
          }
          this.sessions.delete(id)
        })
        stream.write(command + '\n')
      })
    })
    conn.on('error', (e: Error) => {
      emit(`\r\n\x1b[31mSSH error: ${e.message}\x1b[0m\r\n`)
      exit(1)
      this.sessions.delete(id)
    })
    conn.on('close', () => {
      this.sessions.delete(id)
    })
    conn.connect({
      host,
      port: 22,
      username: this.user,
      privateKey: key,
      readyTimeout: 12000,
      hostVerifier: () => true,
    })
    return { id }
  }

  input(id: string, data: string): void {
    this.sessions.get(id)?.stream?.write(data)
  }
  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.stream?.setWindow(rows, cols, 0, 0)
  }
  close(id: string): void {
    const s = this.sessions.get(id)
    if (s) {
      try {
        s.stream?.end()
      } catch {
        /* ignore */
      }
      try {
        s.conn.end()
      } catch {
        /* ignore */
      }
      this.sessions.delete(id)
    }
  }
}
