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
  // optional helper script written to the node (via SFTP) before the command runs —
  // used by the custom-OS-template flow to drop a patched-build.func wrapper.
  setup?: { path: string; content: string }
}

export interface NodeTemplate {
  volid: string // e.g. local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst
  storage: string // local
  name: string // debian-13-standard_13.1-1_amd64.tar.zst
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

  start({ host, command, cols = 120, rows = 30, setup }: StartInstallOptions): { id: string } {
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

    const openShell = () => {
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
    }

    conn.on('ready', () => {
      emit('\x1b[36m▶ connected — running installer…\x1b[0m\r\n')
      if (setup) {
        conn.sftp((err, sftp) => {
          if (err) {
            emit(`\r\n\x1b[31mSFTP error: ${err.message}\x1b[0m\r\n`)
            exit(1)
            conn.end()
            return
          }
          sftp.writeFile(setup.path, setup.content, { mode: 0o700 }, (werr) => {
            if (werr) {
              emit(`\r\n\x1b[31mSetup-file write error: ${werr.message}\x1b[0m\r\n`)
              exit(1)
              conn.end()
              return
            }
            openShell()
          })
        })
      } else {
        openShell()
      }
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

  /** List LXC templates available on a node's vztmpl-capable storages (native `pveam`). */
  listTemplates(host: string): Promise<NodeTemplate[]> {
    return new Promise((resolve, reject) => {
      let key: Buffer
      try {
        key = this.loadKey()
      } catch {
        reject(new Error(`AI-Lab SSH key not found at ${this.keyPath}`))
        return
      }
      const conn = new ssh2.Client()
      // For each storage that can hold container templates, list its vztmpl volumes.
      const cmd =
        `for s in $(pvesm status --content vztmpl 2>/dev/null | awk 'NR>1{print $1}'); do ` +
        `pveam list "$s" 2>/dev/null | awk 'NR>1{print $1}'; done`
      let out = ''
      let errOut = ''
      const done = (fn: () => void) => {
        try {
          conn.end()
        } catch {
          /* ignore */
        }
        fn()
      }
      conn.on('ready', () => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
            done(() => reject(err))
            return
          }
          stream.on('data', (d: Buffer) => (out += d.toString('utf8')))
          stream.stderr.on('data', (d: Buffer) => (errOut += d.toString('utf8')))
          stream.on('close', () => {
            const templates: NodeTemplate[] = out
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.includes(':vztmpl/'))
              .map((volid) => {
                const storage = volid.split(':')[0]
                const name = volid.split('/').pop() || volid
                return { volid, storage, name }
              })
            done(() => resolve(templates))
          })
        })
      })
      conn.on('error', (e: Error) => reject(new Error(`${e.message}${errOut ? ' / ' + errOut : ''}`)))
      conn.connect({ host, port: 22, username: this.user, privateKey: key, readyTimeout: 12000, hostVerifier: () => true })
    })
  }
}
