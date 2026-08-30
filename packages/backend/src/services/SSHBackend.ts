import * as ssh2 from 'ssh2'
import { TransitionLatch } from './notifyLocal'
import * as fs from 'fs'
import * as net from 'net'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { SocksClient } from 'socks'
import {
  isSshConnectionConfig,
  type TerminalBackend,
  type TerminalConfig,
  type TerminalExecOptions,
  type SSHConnectionConfig,
  type FileSystemEntry,
  type FileStatInfo,
} from '../types'
import {
  DEFAULT_SFTP_TRANSFER_PROFILES,
  SftpAdaptiveTransferTuner,
  type SftpTransferDirection,
  type SftpTransferProfile
} from './ssh/SftpAdaptiveTransferTuner'

/** SSH session-shape emitters: one event per subject, never per attempt. */
const sshLatch = new TransitionLatch(3, 'ssh-session')

const GYSHELL_READY_MARKER = '__GYSHELL_READY__'

interface SSHInstance {
  client: ssh2.Client
  sshConfig?: SSHConnectionConfig
  stream?: ssh2.ClientChannel
  sftp?: ssh2.SFTPWrapper
  sftpInitPromise?: Promise<ssh2.SFTPWrapper>
  sftpInitError?: string
  dataCallbacks: Set<(data: string) => void>
  exitCallbacks: Set<(code: number) => void>
  isInitializing: boolean
  buffer: string
  oscBuffer: string
  cwd?: string
  homeDir?: string
  remoteOs?: 'unix' | 'windows'
  systemInfo?: any
  systemInfoPromise?: Promise<any>
  systemInfoRetryTimer?: ReturnType<typeof setTimeout>
  systemInfoRetryCount?: number
  forwardServers: net.Server[]
  remoteForwards: Array<{ host: string; port: number }>
  remoteForwardHandlerInstalled: boolean
  initializationState: 'initializing' | 'ready' | 'failed'
}

interface SftpChunkWriteSession {
  sftp: ssh2.SFTPWrapper
  handle: Buffer
  expectedOffset: number
  cleanupTimer?: ReturnType<typeof setTimeout>
}

export class SSHBackend implements TerminalBackend {
  private sessions: Map<string, SSHInstance> = new Map()
  private readonly chunkWriteSessions = new Map<string, SftpChunkWriteSession>()
  private readonly transferTuner = new SftpAdaptiveTransferTuner({
    profiles: DEFAULT_SFTP_TRANSFER_PROFILES,
    preferredProfileId: 'balanced-32x128k',
    explorationInterval: 8
  })
  private static readonly CHUNK_SESSION_IDLE_MS = 8000
  private static readonly MAX_SFTP_READ_REQUEST_BYTES = 64 * 1024
  private static readonly FAST_TRANSFER_TIMEOUT_MIN_MS = 45_000
  private static readonly FAST_TRANSFER_TIMEOUT_MAX_MS = 10 * 60 * 1000
  private static readonly FAST_TRANSFER_TIMEOUT_PER_MB_MS = 12_000
  private static readonly SYSTEM_INFO_RETRY_BASE_MS = 1500
  private static readonly SYSTEM_INFO_RETRY_MAX_MS = 8000
  private static readonly SYSTEM_INFO_RETRY_MAX_ATTEMPTS = 6

  /**
   * Public exec wrapper for ResourceMonitorService.
   * Executes a command on an existing SSH session and collects output.
   */
  async execOnSession(
    ptyId: string,
    command: string,
    timeoutMs = 6000,
    options?: TerminalExecOptions
  ): Promise<{ stdout: string; stderr: string } | null> {
    const instance = this.sessions.get(ptyId)
    if (!instance) return null
    try {
      return await this.execCollect(instance.client, command, timeoutMs, options)
    } catch (e) {
      // This is the SOLE feed for the monitor panel: swallowing here meant a
      // 10s monitor-command timeout every 2s produced zero backend output and
      // the panel just went stale. One warn per session per minute — enough to
      // name the cause without flooding on a 2s poll.
      const now = Date.now()
      const last = this.execWarnAt.get(ptyId) ?? 0
      if (now - last > 60_000) {
        this.execWarnAt.set(ptyId, now)
        console.warn(`[SSH] execOnSession failed on ${ptyId}: ${(e as Error)?.message ?? e} (cmd: ${command.slice(0, 80)}…)`)
      }
      return null
    }
  }

  /** Per-session rate limit for execOnSession failure logging (2s poll cadence). */
  private readonly execWarnAt = new Map<string, number>()

  private stripReadyMarker(chunk: string): string {
    if (!chunk.includes(GYSHELL_READY_MARKER)) return chunk
    return chunk.replace(/__GYSHELL_READY__/g, '')
  }

  private clearSystemInfoRetry(instance: SSHInstance): void {
    if (instance.systemInfoRetryTimer) {
      clearTimeout(instance.systemInfoRetryTimer)
      instance.systemInfoRetryTimer = undefined
    }
    instance.systemInfoRetryCount = 0
  }

  private scheduleSystemInfoRetry(ptyId: string): void {
    const instance = this.sessions.get(ptyId)
    if (!instance || instance.systemInfo || instance.systemInfoPromise || instance.systemInfoRetryTimer) {
      return
    }
    if (instance.initializationState === 'failed') {
      return
    }
    const nextAttempt = (instance.systemInfoRetryCount || 0) + 1
    if (nextAttempt > SSHBackend.SYSTEM_INFO_RETRY_MAX_ATTEMPTS) {
      // Giving up permanently was invisible across four swallowed layers — the
      // monitor header just stayed blank forever with nothing saying why. Once,
      // at the moment the cap is hit.
      console.warn(`[SSH] ${ptyId}: systemInfo abandoned after ${SSHBackend.SYSTEM_INFO_RETRY_MAX_ATTEMPTS} attempts — host details stay blank for this session`)
      sshLatch.once(`sysinfo-abandoned:${ptyId}`, 'warning',
        'Host details unavailable for a session — retries exhausted',
        `Session '${ptyId}': getSystemInfo failed ${SSHBackend.SYSTEM_INFO_RETRY_MAX_ATTEMPTS} times and will not retry again. The monitor header (hostname/OS/arch/shell) stays blank; the connection itself still works.`)
      return
    }
    instance.systemInfoRetryCount = nextAttempt
    const delayMs = Math.min(
      SSHBackend.SYSTEM_INFO_RETRY_BASE_MS * Math.max(1, 2 ** (nextAttempt - 1)),
      SSHBackend.SYSTEM_INFO_RETRY_MAX_MS
    )
    instance.systemInfoRetryTimer = setTimeout(() => {
      const current = this.sessions.get(ptyId)
      if (!current) {
        return
      }
      current.systemInfoRetryTimer = undefined
      void this.getSystemInfo(ptyId)
    }, delayMs)
  }

  private async execCollect(
    client: ssh2.Client,
    command: string,
    timeoutMs = 6000,
    options?: TerminalExecOptions
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`exec timeout: ${command}`))
      }, timeoutMs)

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }

        stream.on('data', (d: Buffer) => {
          stdout += d.toString('utf8')
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8')
        })
        // Capture the exit code: without it, a remote command exiting 127 was
        // byte-identical to one exiting 0 with no output — the structural root
        // of every "empty monitor section" ambiguity downstream.
        stream.on('exit', (c: number | null) => { code = c })
        stream.on('close', (c?: number | null) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ stdout, stderr, code: typeof c === 'number' ? c : code })
        })
        if (options?.stdin !== undefined) {
          try {
            stream.end(options.stdin)
          } catch (error) {
            clearTimeout(timer)
            reject(error)
            return
          }
        }
      })
    })
  }

  private buildWindowsPowerShellEncodedCommand(): string {
    const psInit = `
function Global:prompt {
  $ec = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { if ($?) { 0 } else { 1 } }
  $cwd_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path))
  $home_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HOME))
  Write-Host -NoNewline "$([char]27)]1337;gyshell_precmd;ec=$ec;cwd_b64=$cwd_b64;home_b64=$home_b64$([char]7)"
  return "PS $($PWD.Path)> "
}
Clear-Host
Write-Output "__GYSHELL_READY__"
`
    // PowerShell -EncodedCommand requires UTF-16LE.
    return Buffer.from(psInit, 'utf16le').toString('base64')
  }

  private async connectViaSocks5Proxy(opts: {
    proxyHost: string
    proxyPort: number
    proxyUsername?: string
    proxyPassword?: string
    dstHost: string
    dstPort: number
  }): Promise<net.Socket> {
    const info = await SocksClient.createConnection({
      proxy: {
        host: opts.proxyHost,
        port: opts.proxyPort,
        type: 5,
        userId: opts.proxyUsername,
        password: opts.proxyPassword
      },
      command: 'connect',
      destination: {
        host: opts.dstHost,
        port: opts.dstPort
      },
      timeout: 10000 // 10s timeout for proxy handshake
    })

    return info.socket
  }

  private async connectViaHttpProxy(opts: {
    proxyHost: string
    proxyPort: number
    proxyUsername?: string
    proxyPassword?: string
    dstHost: string
    dstPort: number
  }): Promise<net.Socket> {
    // socks library also supports HTTP proxies via type: 1 (or we can use it for CONNECT)
    // However, for maximum compatibility with standard HTTP proxies, we'll use SocksClient's HTTP support
    const info = await SocksClient.createConnection({
      proxy: {
        host: opts.proxyHost,
        port: opts.proxyPort,
        type: 5, // Default to 5, but we will check if socks supports HTTP directly or if we need another approach
        userId: opts.proxyUsername,
        password: opts.proxyPassword
      },
      command: 'connect',
      destination: {
        host: opts.dstHost,
        port: opts.dstPort
      }
    }).catch(async (err) => {
      // If socks library fails or doesn't support the specific HTTP proxy, 
      // we could fallback to a specialized HTTP tunnel library if needed.
      // But for now, let's stick to the most robust way.
      throw err
    })

    return info.socket
  }

  private async buildConnectSocketIfNeeded(sshConfig: SSHConnectionConfig, emit: (data: string) => void): Promise<net.Socket | undefined> {
    // 1. Handle Jump Host (Recursive)
    if (sshConfig.jumpHost) {
      const jumpId = `[Jump:${sshConfig.jumpHost.host}]`
      console.log(`${jumpId} Starting jump host connection flow...`)
      emit(`\x1b[36m▹ ${jumpId} Establishing tunnel via jump host ${sshConfig.jumpHost.host}...\x1b[0m\r\n`)
      
      const jumpClient = new ssh2.Client()
      
      // Recursive call to handle nested jump hosts or proxies for the jump host itself
      const jumpSock = await this.buildConnectSocketIfNeeded(sshConfig.jumpHost, emit)
      if (jumpSock) {
        console.log(`${jumpId} Jump host will itself connect via a proxy/nested jump.`)
      }
      
      await new Promise<void>((resolve, reject) => {
        const jumpConnectConfig: ssh2.ConnectConfig = {
          host: sshConfig.jumpHost!.host,
          port: sshConfig.jumpHost!.port,
          username: sshConfig.jumpHost!.username,
          readyTimeout: 20000,
          sock: jumpSock
        }

        if (sshConfig.jumpHost!.authMethod === 'password') {
          jumpConnectConfig.password = sshConfig.jumpHost!.password
        } else if (sshConfig.jumpHost!.authMethod === 'privateKey') {
          if (sshConfig.jumpHost!.privateKey) {
            jumpConnectConfig.privateKey = sshConfig.jumpHost!.privateKey
          } else if (sshConfig.jumpHost!.privateKeyPath) {
            try {
              jumpConnectConfig.privateKey = fs.readFileSync(sshConfig.jumpHost!.privateKeyPath)
            } catch (e: any) {
              reject(new Error(`${jumpId} Failed to read private key: ${e.message}`))
              return
            }
          }
          if (sshConfig.jumpHost!.passphrase) {
            jumpConnectConfig.passphrase = sshConfig.jumpHost!.passphrase
          }
        }

        jumpClient.on('ready', () => {
          console.log(`${jumpId} Jump host connection READY.`)
          resolve()
        })
        
        jumpClient.on('error', (err) => {
          console.error(`${jumpId} Jump host connection ERROR:`, err)
          reject(err)
        })
        
        jumpClient.connect(jumpConnectConfig)
      })

      emit(`\x1b[32m✔ ${jumpId} Jump host ready. Requesting forward to target ${sshConfig.host}:${sshConfig.port}...\x1b[0m\r\n`)
      console.log(`${jumpId} Requesting forwardOut to ${sshConfig.host}:${sshConfig.port}`)

      // Create stream to target
      return await new Promise((resolve, reject) => {
        jumpClient.forwardOut(
          '127.0.0.1', 0,
          sshConfig.host, sshConfig.port,
          (err, stream) => {
            if (err) {
              console.error(`${jumpId} forwardOut FAILED to ${sshConfig.host}:`, err)
              jumpClient.end()
              reject(new Error(`${jumpId} Jump host failed to forward to ${sshConfig.host}: ${err.message}`))
            } else {
              console.log(`${jumpId} forwardOut SUCCESS. Tunnel established.`)
              // We need to keep jumpClient alive as long as the stream is alive
              stream.on('close', () => {
                console.log(`${jumpId} Tunnel stream closed, ending jump client connection.`)
                jumpClient.end()
              })
              // In ssh2, the stream returned by forwardOut satisfies the Duplex stream interface
              // which is what 'sock' expects.
              resolve(stream as unknown as net.Socket)
            }
          }
        )
      })
    }

    // 2. Handle Proxy
    const proxy = sshConfig.proxy
    if (!proxy) return undefined

    if (proxy.type === 'socks5') {
      return await this.connectViaSocks5Proxy({
        proxyHost: proxy.host,
        proxyPort: proxy.port,
        proxyUsername: proxy.username,
        proxyPassword: proxy.password,
        dstHost: sshConfig.host,
        dstPort: sshConfig.port
      })
    }
    if (proxy.type === 'http') {
      return await this.connectViaHttpProxy({
        proxyHost: proxy.host,
        proxyPort: proxy.port,
        proxyUsername: proxy.username,
        proxyPassword: proxy.password,
        dstHost: sshConfig.host,
        dstPort: sshConfig.port
      })
    }

    return undefined
  }

  private async setupPortForwards(instance: SSHInstance, sshConfig: SSHConnectionConfig): Promise<void> {
    const tunnels = sshConfig.tunnels ?? []
    if (!tunnels.length) return

    const remoteTunnels = tunnels.filter((t) => t.type === 'Remote')
    if (remoteTunnels.length && !instance.remoteForwardHandlerInstalled) {
      instance.remoteForwardHandlerInstalled = true
      instance.client.on('tcp connection', (info: any, accept, reject) => {
        const match = remoteTunnels.find((t) => t.host === info.destIP && t.port === info.destPort)
        if (!match || !match.targetAddress || !match.targetPort) {
          reject?.()
          return
        }
        const upstream = net.connect(match.targetPort, match.targetAddress)
        upstream.once('error', () => {
          try {
            reject?.()
          } catch {}
        })
        const ch = accept()
        ch.on('data', (d: Buffer) => upstream.write(d))
        upstream.on('data', (d) => ch.write(d))
        ch.on('close', () => upstream.destroy())
        upstream.on('close', () => {
          try {
            ch.close()
          } catch {}
        })
      })
    }

    for (const t of tunnels) {
      if (t.type === 'Local') {
        const server = net.createServer((sock) => {
          const srcAddr = sock.remoteAddress ?? '127.0.0.1'
          const srcPort = sock.remotePort ?? 0
          const dstAddr = t.targetAddress ?? '127.0.0.1'
          const dstPort = t.targetPort ?? 0
          instance.client.forwardOut(srcAddr, srcPort, dstAddr, dstPort, (err, stream) => {
            if (err || !stream) {
              sock.destroy()
              return
            }
            sock.pipe(stream)
            stream.pipe(sock)
            stream.on('close', () => sock.destroy())
            sock.on('close', () => {
              try {
                stream.close()
              } catch {}
            })
          })
        })
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(t.port, t.host, resolve)
        })
        instance.forwardServers.push(server)
      } else if (t.type === 'Dynamic') {
        const server = net.createServer((sock) => {
          let buf = Buffer.alloc(0)
          const need = async (n: number): Promise<Buffer> => {
            while (buf.length < n) {
              const chunk = await new Promise<Buffer>((resolve, reject) => {
                const onData = (d: Buffer) => {
                  sock.off('error', onErr)
                  resolve(d)
                }
                const onErr = (e: Error) => {
                  sock.off('data', onData)
                  reject(e)
                }
                sock.once('data', onData)
                sock.once('error', onErr)
              })
              buf = Buffer.concat([buf, chunk])
            }
            const out = buf.subarray(0, n)
            buf = buf.subarray(n)
            return out
          }

          ;(async () => {
            try {
              const hello = await need(2)
              if (hello[0] !== 0x05) throw new Error('SOCKS version mismatch')
              const nMethods = hello[1]
              const methods = await need(nMethods)
              const wantsAuth = false
              const method = wantsAuth ? 0x02 : 0x00
              if (!methods.includes(method)) {
                sock.write(Buffer.from([0x05, 0xff]))
                sock.destroy()
                return
              }
              sock.write(Buffer.from([0x05, method]))

              const reqHead = await need(4)
              if (reqHead[0] !== 0x05) throw new Error('SOCKS request version mismatch')
              const cmd = reqHead[1]
              const atyp = reqHead[3]
              if (cmd !== 0x01) {
                sock.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                sock.destroy()
                return
              }

              let dstAddr = ''
              if (atyp === 0x01) {
                const a = await need(4)
                dstAddr = `${a[0]}.${a[1]}.${a[2]}.${a[3]}`
              } else if (atyp === 0x03) {
                const l = await need(1)
                const name = await need(l[0])
                dstAddr = name.toString('utf8')
              } else if (atyp === 0x04) {
                const a = await need(16)
                const parts: string[] = []
                for (let i = 0; i < 16; i += 2) {
                  parts.push(((a[i] << 8) | a[i + 1]).toString(16))
                }
                dstAddr = parts.join(':')
              } else {
                throw new Error('Unknown ATYP')
              }
              const p = await need(2)
              const dstPort = (p[0] << 8) | p[1]

              instance.client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, dstAddr, dstPort, (err, stream) => {
                if (err || !stream) {
                  sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                  sock.destroy()
                  return
                }
                sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                if (buf.length) {
                  stream.write(buf)
                  buf = Buffer.alloc(0)
                }
                sock.pipe(stream)
                stream.pipe(sock)
                stream.on('close', () => sock.destroy())
                sock.on('close', () => {
                  try {
                    stream.close()
                  } catch {}
                })
              })
            } catch {
              sock.destroy()
            }
          })()
        })
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(t.port, t.host, resolve)
        })
        instance.forwardServers.push(server)
      } else if (t.type === 'Remote') {
        await new Promise<void>((resolve, reject) => {
          instance.client.forwardIn(t.host, t.port, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        instance.remoteForwards.push({ host: t.host, port: t.port })
      }
    }
  }

  async spawn(config: TerminalConfig): Promise<string> {
    if (!isSshConnectionConfig(config)) {
      throw new Error('SSHBackend only supports ssh connections')
    }
    const sshConfig: SSHConnectionConfig = config

    const client = new ssh2.Client()
    
    const instance: SSHInstance = {
      client,
      sshConfig,
      dataCallbacks: new Set(),
      exitCallbacks: new Set(),
      isInitializing: true,
      buffer: '',
      oscBuffer: '',
      forwardServers: [],
      remoteForwards: [],
      remoteForwardHandlerInstalled: false,
      initializationState: 'initializing',
      systemInfoRetryCount: 0,
    }
    this.sessions.set(config.id, instance)

    // Start connection process in background so we can return the ID immediately
    // and allow TerminalService to register data listeners.
    ;(async () => {
      const emit = (data: string) => {
        instance.dataCallbacks.forEach(cb => cb(data))
      }

      client.on('ready', async () => {
        emit('\x1b[2J\x1b[H\x1b[32m✔ Connection established.\x1b[0m\r\n')
        console.log(`[SSH] Connection ready for ${sshConfig.host}:${sshConfig.port}`)
        try {
          emit('\x1b[36m▹ Setting up port forwards...\x1b[0m\r\n')
          console.log(`[SSH] Setting up port forwards...`)
          await this.setupPortForwards(instance, sshConfig)
        } catch (e: any) {
          console.error(`[SSH] Port forward setup failed:`, e)
          emit(`\x1b[31m✘ Port forward failed: ${e.message}\x1b[0m\r\n`)
          // We continue anyway to allow shell access
        }

        let unameProbeFailed = false
        try {
          emit('\x1b[36m▹ Detecting remote OS...\x1b[0m\r\n')
          console.log(`[SSH] Detecting remote OS...`)
          const uname = await this.execCollect(client, 'uname -s')
          const u = (uname.stdout || uname.stderr || '').toLowerCase()
          if (u.includes('linux') || u.includes('darwin')) {
            instance.remoteOs = 'unix'
          }
        } catch {
          unameProbeFailed = true
        }
        if (!instance.remoteOs) {
          try {
            const ver = await this.execCollect(client, 'cmd.exe /c ver')
            const v = (ver.stdout || ver.stderr || '').toLowerCase()
            if (v.includes('windows')) instance.remoteOs = 'windows'
          } catch {
            // expected on unix hosts; only meaningful when BOTH probes failed
          }
        }
        if (!instance.remoteOs) {
          instance.remoteOs = 'unix'
          if (unameProbeFailed) {
            // BOTH probes failed and the default was applied blind. Every
            // downstream command family (monitor sections, systeminfo, the
            // injection script) now targets a GUESSED OS — and if the guess is
            // wrong, all of it returns empty output that reads as "no data".
            console.warn(`[SSH] ${config.id}: remote OS defaulted to 'unix' — BOTH detection probes failed (slow link? restricted shell?)`)
            sshLatch.once(`os-default:${config.id}`, 'warning',
              'Remote OS detection failed — session is running on a guess',
              `Session '${config.id}' (${config.host}): uname and cmd.exe probes both failed, defaulting to unix. If the guess is wrong, the monitor and system info will show empty data rather than errors.`)
          }
        }
        console.log(`[SSH] Remote OS detected: ${instance.remoteOs}`)

        try {
          emit('\x1b[36m▹ Initializing SFTP channel...\x1b[0m\r\n')
          await this.initializeSftp(instance)
          emit('\x1b[32m✔ SFTP channel ready.\x1b[0m\r\n')
        } catch (error: any) {
          const message = error instanceof Error ? error.message : String(error)
          instance.sftpInitError = message
          // Keep interactive shell usable even when SFTP is unavailable.
          emit(`\x1b[33m⚠ SFTP unavailable: ${message}. File panel features may be limited.\x1b[0m\r\n`)
        }

        emit('\x1b[36m▹ Opening interactive shell...\x1b[0m\r\n')
        console.log(`[SSH] Opening interactive shell...`)
        client.shell(
          { 
            term: 'xterm-256color', 
            cols: config.cols, 
            rows: config.rows,
          },
          {
            // Fix for Chinese characters rendering issues in packaged apps
            // Setting LC_ALL and LANG to UTF-8 ensures the remote shell uses UTF-8 encoding
            env: {
              LC_ALL: 'en_US.UTF-8',
              LANG: 'en_US.UTF-8'
            }
          },
          (err, stream) => {
          if (err) {
            console.error(`[SSH] Failed to open shell:`, err)
            instance.initializationState = 'failed'
            instance.isInitializing = false
            emit(`\x1b[31m✘ Failed to open shell: ${err.message}\x1b[0m\r\n`)
            return
          }
          instance.stream = stream
          emit('\x1b[36m▹ Initializing shell integration...\x1b[0m\r\n')
          console.log(`[SSH] Shell stream opened. Starting robust initialization...`)

          let retryCount = 0
          const maxRetries = 3
          let isReadySent = false

          const attemptInjection = () => {
            if (!instance.stream || isReadySent || !instance.isInitializing) return
            
            console.log(`[SSH] Injection attempt ${retryCount + 1}...`)
            instance.stream.write('\x03\n\n')

            setTimeout(() => {
              if (!instance.stream || isReadySent || !instance.isInitializing) return
              if (instance.remoteOs === 'windows') {
                const b64 = this.buildWindowsPowerShellEncodedCommand()
                instance.stream.write(`powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand ${b64}\r`)
              } else {
                const script = this.getUnixInjectionScript()
                const b64 = Buffer.from(script).toString('base64')
                const injection = `  eval "$(printf '%s' '${b64}' | base64 -d 2>/dev/null || printf '%s' '${b64}' | base64 --decode 2>/dev/null)"\n`
                
                const CHUNK_SIZE = 256
                for (let i = 0; i < injection.length; i += CHUNK_SIZE) {
                  instance.stream.write(injection.slice(i, i + CHUNK_SIZE))
                }
              }
            }, 500)
          }

          setTimeout(attemptInjection, 1000)

          const watchdogInterval = setInterval(() => {
            if (instance.isInitializing) {
              retryCount++
              if (retryCount >= maxRetries) {
                instance.initializationState = 'failed'
                instance.isInitializing = false 
                emit('\x1b[31m✘ Initialization failed. Entering fallback mode.\x1b[0m\r\n')
                console.error(`[SSH] Initialization FAILED after ${maxRetries} attempts for ${config.id}.`)
                clearInterval(watchdogInterval)
                return
              }
              emit(`\x1b[33m⚠ Initialization timeout, retrying (${retryCount}/${maxRetries})...\x1b[0m\r\n`)
              attemptInjection()
            } else {
              clearInterval(watchdogInterval)
            }
          }, 8000)

          stream.on('data', (data: Buffer) => {
            const chunk = data.toString()
            if (instance.isInitializing) {
              instance.buffer += chunk
              if (instance.buffer.includes(GYSHELL_READY_MARKER)) {
                emit('\x1b[2J\x1b[H') // Clear screen
                isReadySent = true
                clearInterval(watchdogInterval)
                const sawContinuation = /(?:\r?\n)>>\s*\r?\n/.test(instance.buffer) || instance.buffer.trimEnd().endsWith('\n>>') || instance.buffer.trimEnd().endsWith('\r\n>>')
                instance.initializationState = 'ready'
                instance.isInitializing = false
                const parts = instance.buffer.split(GYSHELL_READY_MARKER)
                if (parts.length > 1) {
                  const realContent = this.stripReadyMarker(parts.slice(1).join(GYSHELL_READY_MARKER)).trimStart()
                  if (realContent) emit(realContent)
                }
                instance.buffer = '' 
                if (sawContinuation && instance.remoteOs === 'windows' && instance.stream) {
                  setTimeout(() => { try { instance.stream?.write('\r') } catch {} }, 50)
                }
              }
            } else {
              const sanitizedChunk = this.stripReadyMarker(chunk)
              this.consumeOscMarkers(instance, sanitizedChunk)
              if (sanitizedChunk) {
                emit(sanitizedChunk)
              }
            }
          })

          stream.on('close', (code: number) => {
            this.clearSystemInfoRetry(instance)
            for (const s of instance.forwardServers) { try { s.close() } catch {} }
            for (const rf of instance.remoteForwards) { try { instance.client.unforwardIn(rf.host, rf.port) } catch {} }
            try { instance.sftp?.end?.() } catch {}
            instance.exitCallbacks.forEach(cb => cb(code || 0))
            client.end()
            this.sessions.delete(config.id)
          })
        })
      })

      client.on('error', (err) => {
        console.error(`[SSH] Client error:`, err)
        instance.initializationState = 'failed'
        instance.isInitializing = false
        emit(`\x1b[31m✘ SSH Error: ${err.message}\x1b[0m\r\n`)
        instance.exitCallbacks.forEach(cb => cb(-1))
      })

      const connectConfig: ssh2.ConnectConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        readyTimeout: 20000,
      }

      if (sshConfig.authMethod === 'password') {
        connectConfig.password = sshConfig.password
      } else if (sshConfig.authMethod === 'privateKey') {
        if (sshConfig.privateKey) {
          connectConfig.privateKey = sshConfig.privateKey
        } else if (sshConfig.privateKeyPath) {
          try {
            connectConfig.privateKey = fs.readFileSync(sshConfig.privateKeyPath)
          } catch (e: any) {
            emit(`\x1b[31m✘ Failed to read private key: ${e.message}\x1b[0m\r\n`)
          }
        }
        if (sshConfig.passphrase) {
          connectConfig.passphrase = sshConfig.passphrase
        }
      }

      try {
        // Give TerminalService a tiny bit of time to register the listener
        await new Promise(r => setTimeout(r, 50))
        
        emit(`\x1b[36m▹ Connecting to ${sshConfig.host}:${sshConfig.port}...\x1b[0m\r\n`)
        console.log(`[SSH] Attempting to connect to ${sshConfig.host}:${sshConfig.port}...`)
        const sock = await this.buildConnectSocketIfNeeded(sshConfig, emit)
        if (sock) {
          console.log(`[SSH] SUCCESS: Connection to ${sshConfig.host} will be tunneled through sock (Jump Host/Proxy).`)
          emit('\x1b[36m▹ [Final] Using tunnel socket for target connection...\x1b[0m\r\n')
          connectConfig.sock = sock
        } else {
          console.log(`[SSH] DIRECT: No jump host or proxy, connecting directly to ${sshConfig.host}.`)
        }
        client.connect(connectConfig)
      } catch (e: any) {
        const errMsg = e instanceof Error ? e.message : String(e)
        instance.initializationState = 'failed'
        instance.isInitializing = false
        emit(`\x1b[31m✘ Connection failed: ${errMsg}\x1b[0m\r\n`)
        instance.exitCallbacks.forEach(cb => cb(-1))
      }
    })()

    return config.id
  }

  write(ptyId: string, data: string): void {
    const instance = this.sessions.get(ptyId)
    if (instance && instance.stream) {
      instance.stream.write(data)
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const instance = this.sessions.get(ptyId)
    if (instance && instance.stream) {
      instance.stream.setWindow(rows, cols, 0, 0)
    }
  }

  kill(ptyId: string): void {
    const instance = this.sessions.get(ptyId)
    if (instance) {
      this.clearSystemInfoRetry(instance)
      this.closeChunkSessionsForPty(ptyId)
      for (const s of instance.forwardServers) { try { s.close() } catch {} }
      for (const rf of instance.remoteForwards) { try { instance.client.unforwardIn(rf.host, rf.port) } catch {} }
      try { instance.sftp?.end?.() } catch {}
      instance.client.end()
      this.sessions.delete(ptyId)
    }
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const instance = this.sessions.get(ptyId)
    if (instance) { instance.dataCallbacks.add(callback) }
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const instance = this.sessions.get(ptyId)
    if (instance) { instance.exitCallbacks.add(callback) }
  }

  getCwd(ptyId: string): string | undefined {
    return this.sessions.get(ptyId)?.cwd
  }

  getRemoteOs(ptyId: string): 'unix' | 'windows' | undefined {
    return this.sessions.get(ptyId)?.remoteOs
  }

  getInitializationState(ptyId: string): 'initializing' | 'ready' | 'failed' | undefined {
    return this.sessions.get(ptyId)?.initializationState
  }

  private async waitForRemoteOs(instance: SSHInstance, timeoutMs = 4000): Promise<'unix' | 'windows' | undefined> {
    if (instance.remoteOs) {
      return instance.remoteOs
    }
    const deadline = Date.now() + timeoutMs
    while (!instance.remoteOs && instance.initializationState === 'initializing' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return instance.remoteOs
  }

  private buildWindowsSystemInfoCommand(): string {
    const script = [
      "$utf8=[System.Text.UTF8Encoding]::new($false)",
      '[Console]::OutputEncoding=$utf8',
      '$OutputEncoding=$utf8',
      '$os=Get-CimInstance Win32_OperatingSystem',
      "$json=([pscustomobject]@{Version=$os.Version;CSName=$os.CSName;Arch=$(if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'})}|ConvertTo-Json -Compress)",
      '$bytes=$utf8.GetBytes($json)',
      '[Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)',
    ].join(';')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
  }

  async getSystemInfo(ptyId: string): Promise<any> {
    const instance = this.sessions.get(ptyId)
    if (!instance) return undefined
    if (instance.systemInfo) {
      return instance.systemInfo
    }
    if (instance.systemInfoPromise) {
      return await instance.systemInfoPromise
    }

    const client = instance.client
    instance.systemInfoPromise = (async () => {
      const remoteOs = await this.waitForRemoteOs(instance)
      if (!remoteOs) {
        return undefined
      }
      const isWindows = remoteOs === 'windows'

      if (isWindows) {
        try {
          const info = await this.execCollect(
            client,
            this.buildWindowsSystemInfoCommand(),
            10000
          )
          const parsed = JSON.parse(info.stdout || '{}')
          const next = {
            os: 'Windows',
            platform: 'win32',
            release: parsed.Version || '',
            arch: parsed.Arch || '',
            hostname: parsed.CSName || '',
            isRemote: true,
            shell: 'powershell.exe'
          }
          this.clearSystemInfoRetry(instance)
          instance.systemInfo = next
          return next
        } catch {
          return undefined
        }
      }

      try {
        const [uname, osRelease, hostname] = await Promise.all([
          this.execCollect(client, 'uname -a', 8000),
          this.execCollect(client, 'cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null', 8000),
          this.execCollect(client, 'hostname', 8000)
        ])

        let os = 'unix'
        const releaseMatch = osRelease.stdout.match(/^ID=(.*)$/m)
        if (releaseMatch) {
          os = releaseMatch[1].replace(/"/g, '')
        } else {
          const unameS = uname.stdout.split(' ')[0].toLowerCase()
          os = unameS || 'unix'
        }
        const unameS = uname.stdout.split(' ')[0].toLowerCase()
        const platform =
          unameS.includes('darwin')
            ? 'darwin'
            : unameS.includes('linux')
              ? 'linux'
              : 'unix'

        const parts = uname.stdout.split(' ')
        const next = {
          os,
          platform,
          release: parts[2] || '',
          arch: parts[parts.length - 2] || '',
          hostname: hostname.stdout.trim() || parts[1] || '',
          isRemote: true,
          shell: '/bin/sh'
        }
        this.clearSystemInfoRetry(instance)
        instance.systemInfo = next
        return next
      } catch {
        return undefined
      }
    })()

    let result: any
    try {
      result = await instance.systemInfoPromise
    } finally {
      instance.systemInfoPromise = undefined
    }
    if (!result) {
      this.scheduleSystemInfoRetry(ptyId)
    }
    return result
  }

  private normalizeRemotePath(filePath: string): string {
    return filePath.replace(/\\/g, '/')
  }

  private isAbsoluteRemotePath(remotePath: string): boolean {
    return remotePath.startsWith('/') || /^[A-Za-z]:\//.test(remotePath)
  }

  private formatSftpError(error: unknown): string {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
      const code = (error as any)?.code
      return code !== undefined ? `${error.message} (code: ${String(code)})` : error.message
    }
    if (typeof error === 'string' && error.trim().length > 0) {
      return error
    }
    return 'Unknown SFTP error'
  }

  private async initializeSftp(instance: SSHInstance): Promise<ssh2.SFTPWrapper> {
    if (instance.sftp) return instance.sftp
    if (!instance.sftpInitPromise) {
      instance.sftpInitPromise = new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
        instance.client.sftp((err, sftpClient) => {
          if (err || !sftpClient) {
            reject(err || new Error('Failed to initialize SFTP'))
            return
          }
          resolve(sftpClient)
        })
      })
    }
    const sftp = await instance.sftpInitPromise
    instance.sftp = sftp
    instance.sftpInitError = undefined
    return sftp
  }

  private getUnixInjectionScript(): string {
    // Minified script to reduce payload size and potential TTY buffer issues
    const script = `
if [ -n "$ZSH_VERSION" ]; then
  gyshell_preexec() { builtin printf "\\033]1337;gyshell_preexec\\007"; }
  gyshell_precmd() { local ec=$? cwd_b64 home_b64; cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n"); home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n"); builtin printf "\\033]1337;gyshell_precmd;ec=%s;cwd_b64=%s;home_b64=%s\\007" "$ec" "$cwd_b64" "$home_b64"; }
  autoload -Uz add-zsh-hook 2>/dev/null || true
  add-zsh-hook preexec gyshell_preexec
  add-zsh-hook precmd gyshell_precmd
elif [ -n "$BASH_VERSION" ]; then
  __gyshell_in_command=0
  __gyshell_preexec() {
    case "$BASH_COMMAND" in
      __gyshell_precmd*|__gyshell_preexec* ) return ;;
    esac
    if [ "$__gyshell_in_command" = "0" ]; then
      __gyshell_in_command=1
      builtin printf "\\033]1337;gyshell_preexec\\007"
    fi
  }
  trap '__gyshell_preexec' DEBUG
  __gyshell_precmd() {
    local ec=$?
    local cwd_b64 home_b64
    __gyshell_in_command=0
    cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n")
    home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n")
    builtin printf "\\033]1337;gyshell_precmd;ec=%s;cwd_b64=%s;home_b64=%s\\007" "$ec" "$cwd_b64" "$home_b64"
  }
  PROMPT_COMMAND="__gyshell_precmd\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
fi
echo "__GYSHELL_READY__"
`.trim()
    return script
  }

  async getHomeDir(ptyId: string): Promise<string | undefined> {
    const instance = this.sessions.get(ptyId)
    if (!instance) return undefined
    if (instance.homeDir) return instance.homeDir
    try {
      const sftp = await this.getSftp(ptyId)
      const resolvedPath = await this.sftpRealpath(sftp, '.')
      instance.homeDir = resolvedPath
      if (!instance.cwd) {
        instance.cwd = resolvedPath
      }
      return resolvedPath
    } catch {
      return instance.homeDir
    }
  }

  private async getSftp(ptyId: string): Promise<ssh2.SFTPWrapper> {
    const instance = this.sessions.get(ptyId)
    if (!instance) {
      throw new Error(`SSH session ${ptyId} not found`)
    }
    if (instance.sftp) return instance.sftp
    if (instance.sftpInitError) {
      throw new Error(`SFTP unavailable for session ${ptyId}: ${instance.sftpInitError}`)
    }
    if (!instance.sftpInitPromise) {
      throw new Error(`SFTP channel has not been initialized for session ${ptyId}`)
    }
    try {
      const sftp = await instance.sftpInitPromise
      instance.sftp = sftp
      return sftp
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      instance.sftpInitError = message
      throw new Error(`SFTP unavailable for session ${ptyId}: ${message}`)
    }
  }

  private async createDedicatedSftp(ptyId: string): Promise<ssh2.SFTPWrapper> {
    const instance = this.sessions.get(ptyId)
    if (!instance) {
      throw new Error(`No SSH session found for ${ptyId}`)
    }
    return await new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
      instance.client.sftp((err, sftpClient) => {
        if (err || !sftpClient) {
          reject(err || new Error('Failed to open dedicated SFTP channel.'))
          return
        }
        resolve(sftpClient)
      })
    })
  }

  private getTransferEndpointKey(ptyId: string): string {
    const instance = this.sessions.get(ptyId)
    if (!instance) {
      return `pty:${ptyId}`
    }
    const cfg = instance.sshConfig
    if (!cfg) {
      return `pty:${ptyId}`
    }
    const username = typeof cfg.username === 'string' && cfg.username.length > 0 ? cfg.username : 'unknown-user'
    const host = typeof cfg.host === 'string' && cfg.host.length > 0 ? cfg.host : 'unknown-host'
    const port = Number.isFinite(cfg.port) ? Number(cfg.port) : 22
    return `${username}@${host}:${port}`
  }

  private selectAdaptiveFastTransferProfile(
    ptyId: string,
    direction: SftpTransferDirection
  ): { endpointKey: string; profile: SftpTransferProfile } {
    const endpointKey = this.getTransferEndpointKey(ptyId)
    const profile = this.transferTuner.selectProfile(endpointKey, direction)
    return { endpointKey, profile }
  }

  private getFastTransferTimeoutMs(totalBytes: number): number {
    const sizeInMb = Math.max(1, Math.ceil(Math.max(0, Number(totalBytes) || 0) / (1024 * 1024)))
    const timeoutBySize = sizeInMb * SSHBackend.FAST_TRANSFER_TIMEOUT_PER_MB_MS
    return Math.max(
      SSHBackend.FAST_TRANSFER_TIMEOUT_MIN_MS,
      Math.min(SSHBackend.FAST_TRANSFER_TIMEOUT_MAX_MS, timeoutBySize)
    )
  }

  private joinRemotePath(basePath: string, childName: string): string {
    if (!basePath) return childName
    if (basePath === '/') return `/${childName}`
    if (/^[A-Za-z]:\/$/.test(basePath)) return `${basePath}${childName}`
    return `${basePath.replace(/\/+$/, '')}/${childName}`
  }

  private getChunkSessionKey(kind: 'write', ptyId: string, normalizedPath: string): string {
    return `${kind}:${ptyId}:${normalizedPath}`
  }

  private refreshWriteSessionCleanupTimer(key: string, session: SftpChunkWriteSession): void {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer)
    }
    session.cleanupTimer = setTimeout(() => {
      void this.disposeWriteSession(key)
    }, SSHBackend.CHUNK_SESSION_IDLE_MS)
  }

  private async disposeWriteSession(key: string): Promise<void> {
    const session = this.chunkWriteSessions.get(key)
    if (!session) return
    this.chunkWriteSessions.delete(key)
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer)
    }
    await this.sftpClose(session.sftp, session.handle).catch(() => {})
  }

  private closeChunkSessionsForPty(ptyId: string): void {
    const writeKeys = Array.from(this.chunkWriteSessions.keys()).filter((key) => key.startsWith(`write:${ptyId}:`))
    writeKeys.forEach((key) => { void this.disposeWriteSession(key) })
  }

  private async closeChunkSessionsForPath(ptyId: string, normalizedPath: string): Promise<void> {
    const writeKey = this.getChunkSessionKey('write', ptyId, normalizedPath)
    await this.disposeWriteSession(writeKey)
  }

  private async sftpOpen(sftp: ssh2.SFTPWrapper, normalizedPath: string, flags: ssh2.OpenMode): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      sftp.open(normalizedPath, flags, (err, handle) => {
        if (err || !handle) {
          reject(err || new Error(`Failed to open path: ${normalizedPath}`))
          return
        }
        resolve(handle)
      })
    })
  }

  private async sftpClose(sftp: ssh2.SFTPWrapper, handle: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.close(handle, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  private async sftpWrite(
    sftp: ssh2.SFTPWrapper,
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.write(handle, buffer, offset, length, position, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  /**
   * Low-level: read bytes from an already-open SFTP handle at a given position.
   * Returns the number of bytes actually read (may be less than requested at EOF).
   */
  private async sftpReadDirect(
    sftp: ssh2.SFTPWrapper,
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      sftp.read(handle, buffer, offset, length, position, (err, bytesRead) => {
        if (err) {
          reject(err)
          return
        }
        resolve(bytesRead)
      })
    })
  }

  private async sftpStat(sftp: ssh2.SFTPWrapper, normalizedPath: string): Promise<ssh2.Stats> {
    return await new Promise<ssh2.Stats>((resolve, reject) => {
      sftp.stat(normalizedPath, (err, stats) => {
        if (err || !stats) {
          reject(err || new Error(`Failed to stat path: ${normalizedPath}`))
          return
        }
        resolve(stats)
      })
    })
  }

  private async sftpLstat(sftp: ssh2.SFTPWrapper, normalizedPath: string): Promise<ssh2.Stats> {
    return await new Promise<ssh2.Stats>((resolve, reject) => {
      sftp.lstat(normalizedPath, (err, stats) => {
        if (err || !stats) {
          reject(err || new Error(`Failed to lstat path: ${normalizedPath}`))
          return
        }
        resolve(stats)
      })
    })
  }

  private async sftpReaddir(sftp: ssh2.SFTPWrapper, normalizedPath: string): Promise<ssh2.FileEntry[]> {
    return await new Promise<ssh2.FileEntry[]>((resolve, reject) => {
      sftp.readdir(normalizedPath, (err, list) => {
        if (err || !list) {
          reject(err || new Error(`Failed to read directory: ${normalizedPath}`))
          return
        }
        resolve(list)
      })
    })
  }

  private async sftpRealpath(sftp: ssh2.SFTPWrapper, normalizedPath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      sftp.realpath(normalizedPath, (err, absolutePath) => {
        if (err || typeof absolutePath !== 'string' || absolutePath.length === 0) {
          reject(err || new Error(`Failed to resolve remote path: ${normalizedPath}`))
          return
        }
        resolve(this.normalizeRemotePath(absolutePath))
      })
    })
  }

  private async sftpMkdir(sftp: ssh2.SFTPWrapper, normalizedPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(normalizedPath, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  private async sftpRmdir(sftp: ssh2.SFTPWrapper, normalizedPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(normalizedPath, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  private async sftpUnlink(sftp: ssh2.SFTPWrapper, normalizedPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(normalizedPath, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  private async sftpRename(sftp: ssh2.SFTPWrapper, sourcePath: string, targetPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.rename(sourcePath, targetPath, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  private async sftpWriteFile(sftp: ssh2.SFTPWrapper, normalizedPath: string, content: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(normalizedPath, content, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  private async removePathRecursive(sftp: ssh2.SFTPWrapper, normalizedPath: string): Promise<void> {
    const stats = await this.sftpLstat(sftp, normalizedPath)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      await this.sftpUnlink(sftp, normalizedPath)
      return
    }

    const list = await this.sftpReaddir(sftp, normalizedPath)
    const children = list.filter((item) => item.filename !== '.' && item.filename !== '..')
    for (const child of children) {
      const childPath = this.joinRemotePath(normalizedPath, child.filename)
      await this.removePathRecursive(sftp, childPath)
    }
    await this.sftpRmdir(sftp, normalizedPath)
  }

  async statFile(ptyId: string, filePath: string): Promise<FileStatInfo> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(filePath)
    try {
      const stat = await this.sftpStat(sftp, normalizedPath)
      const isDirectory = stat.isDirectory()
      return { exists: true, isDirectory, size: isDirectory ? undefined : stat.size }
    } catch (err: any) {
      if (err?.code === 2 || err?.code === 'ENOENT') {
        return { exists: false, isDirectory: false }
      }
      throw err
    }
  }

  async listDirectory(ptyId: string, dirPath: string): Promise<FileSystemEntry[]> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(dirPath)
    const resolvedPath = this.isAbsoluteRemotePath(normalizedPath)
      ? normalizedPath
      : await this.sftpRealpath(sftp, normalizedPath)
    let list: ssh2.FileEntry[]
    try {
      list = await this.sftpReaddir(sftp, resolvedPath)
    } catch (error) {
      throw new Error(
        `Failed to list remote directory "${resolvedPath}": ${this.formatSftpError(error)}`
      )
    }
    const mapped = list
      .filter((item) => item.filename !== '.' && item.filename !== '..')
      .map((item) => {
        const attrs = item.attrs
        const modeValue = typeof attrs?.mode === 'number' ? attrs.mode : 0
        const typeBits = modeValue & 0o170000
        const isDirectory = typeBits === 0o040000 || item.longname?.startsWith('d') === true
        const isSymbolicLink = typeBits === 0o120000 || item.longname?.startsWith('l') === true
        const mode = typeof attrs?.mode === 'number' ? `0${(attrs.mode & 0o777).toString(8)}` : undefined
        const modifiedAt = typeof attrs?.mtime === 'number' ? new Date(attrs.mtime * 1000).toISOString() : undefined
        return {
          name: item.filename,
          path: this.joinRemotePath(resolvedPath, item.filename),
          isDirectory,
          isSymbolicLink,
          size: typeof attrs?.size === 'number' ? attrs.size : 0,
          mode,
          modifiedAt
        } satisfies FileSystemEntry
      })

    return mapped.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  }

  async createDirectory(ptyId: string, dirPath: string): Promise<void> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(dirPath)
    await this.sftpMkdir(sftp, normalizedPath)
  }

  async createFile(ptyId: string, filePath: string): Promise<void> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(filePath)
    await this.closeChunkSessionsForPath(ptyId, normalizedPath)
    try {
      await this.sftpLstat(sftp, normalizedPath)
      throw new Error(`Path already exists: ${normalizedPath}`)
    } catch (error: any) {
      if (!(error?.code === 2 || error?.code === 'ENOENT')) {
        throw error
      }
    }
    await this.sftpWriteFile(sftp, normalizedPath, Buffer.alloc(0))
  }

  async deletePath(ptyId: string, targetPath: string, options?: { recursive?: boolean }): Promise<void> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(targetPath)
    await this.closeChunkSessionsForPath(ptyId, normalizedPath)
    const stats = await this.sftpLstat(sftp, normalizedPath)
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (options?.recursive) {
        await this.removePathRecursive(sftp, normalizedPath)
        return
      }
      await this.sftpRmdir(sftp, normalizedPath)
      return
    }
    await this.sftpUnlink(sftp, normalizedPath)
  }

  async renamePath(ptyId: string, sourcePath: string, targetPath: string): Promise<void> {
    const sftp = await this.getSftp(ptyId)
    const normalizedSource = this.normalizeRemotePath(sourcePath)
    const normalizedTarget = this.normalizeRemotePath(targetPath)
    await this.closeChunkSessionsForPath(ptyId, normalizedSource)
    await this.closeChunkSessionsForPath(ptyId, normalizedTarget)
    await this.sftpRename(sftp, normalizedSource, normalizedTarget)
  }

  async readFile(ptyId: string, filePath: string): Promise<Buffer> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(filePath)
    const data = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(normalizedPath, (err, buf) => {
        if (err || !buf) {
          reject(err || new Error('Failed to read file'))
          return
        }
        resolve(buf as Buffer)
      })
    })
    return data
  }

  async downloadFileToLocalPath(
    ptyId: string,
    sourcePath: string,
    targetLocalPath: string,
    options?: {
      onProgress?: (progress: { bytesTransferred: number; totalBytes: number; eof: boolean }) => void
      signal?: AbortSignal
    }
  ): Promise<{ totalBytes: number }> {
    const createAbortError = (): Error => {
      const error = new Error('Transfer cancelled by user.')
      ;(error as Error & { name: string }).name = 'AbortError'
      return error
    }

    const normalizedPath = this.normalizeRemotePath(sourcePath)
    const statSftp = await this.getSftp(ptyId)
    const totalBytes = Math.max(0, Number((await this.sftpStat(statSftp, normalizedPath)).size) || 0)
    await fs.promises.mkdir(dirname(targetLocalPath), { recursive: true })

    const runStreamFallback = async (): Promise<void> => {
      const fallbackSftp = await this.createDedicatedSftp(ptyId)
      const readStream = fallbackSftp.createReadStream(normalizedPath, {
        autoClose: true,
        highWaterMark: 512 * 1024
      })
      const writeStream = fs.createWriteStream(targetLocalPath, { flags: 'w' })
      let bytesTransferred = 0
      readStream.on('data', (chunk: Buffer | string) => {
        const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        bytesTransferred += byteLength
        options?.onProgress?.({
          bytesTransferred,
          totalBytes,
          eof: bytesTransferred >= totalBytes
        })
      })

      let abortListener: (() => void) | undefined
      if (options?.signal) {
        const abortError = createAbortError()
        abortListener = () => {
          readStream.destroy(abortError)
          writeStream.destroy()
          try { fallbackSftp.end?.() } catch {}
        }
        if (options.signal.aborted) {
          abortListener()
        } else {
          options.signal.addEventListener('abort', abortListener, { once: true })
        }
      }

      try {
        await pipeline(readStream, writeStream)
      } finally {
        if (abortListener && options?.signal) {
          options.signal.removeEventListener('abort', abortListener)
        }
        try { fallbackSftp.end?.() } catch {}
      }
    }

    if (options?.signal?.aborted) {
      throw createAbortError()
    }

    const { endpointKey, profile } = this.selectAdaptiveFastTransferProfile(ptyId, 'download')
    const fastStartedAt = Date.now()
    const fastTimeoutMs = this.getFastTransferTimeoutMs(totalBytes)
    const transferSftp = await this.createDedicatedSftp(ptyId)
    let aborted = false
    let abortListener: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: unknown): void => {
          if (settled) return
          settled = true
          clearTimeout(timeoutTimer)
          if (error) {
            reject(error)
            return
          }
          resolve()
        }
        const timeoutTimer = setTimeout(() => {
          finish(new Error(`SFTP fastGet timed out after ${fastTimeoutMs}ms`))
        }, fastTimeoutMs)

        if (options?.signal) {
          abortListener = () => {
            aborted = true
            try { transferSftp.end?.() } catch {}
            finish(createAbortError())
          }
          options.signal.addEventListener('abort', abortListener, { once: true })
        }

        transferSftp.fastGet(
          normalizedPath,
          targetLocalPath,
          {
            concurrency: profile.concurrency,
            chunkSize: profile.chunkSize,
            step: (totalTransferred: number, _chunk: number, total: number) => {
              const transferred = Math.max(0, Number(totalTransferred) || 0)
              options?.onProgress?.({
                bytesTransferred: transferred,
                totalBytes: Math.max(totalBytes, Math.max(0, Number(total) || 0)),
                eof: transferred >= totalBytes
              })
            }
          },
          (error) => {
            finish(error)
          }
        )
      })
      this.transferTuner.reportSuccess(
        endpointKey,
        'download',
        profile.id,
        totalBytes,
        Date.now() - fastStartedAt
      )
    } catch (error) {
      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener)
      }
      try { transferSftp.end?.() } catch {}
      if (aborted || options?.signal?.aborted) {
        await fs.promises.unlink(targetLocalPath).catch(() => {})
        throw createAbortError()
      }
      this.transferTuner.reportFailure(endpointKey, 'download', profile.id)
      await runStreamFallback()
      options?.onProgress?.({
        bytesTransferred: totalBytes,
        totalBytes,
        eof: true
      })
      return { totalBytes }
    }

    if (abortListener && options?.signal) {
      options.signal.removeEventListener('abort', abortListener)
    }
    try { transferSftp.end?.() } catch {}
    options?.onProgress?.({
      bytesTransferred: totalBytes,
      totalBytes,
      eof: true
    })
    return { totalBytes }
  }

  async uploadFileFromLocalPath(
    ptyId: string,
    sourceLocalPath: string,
    targetPath: string,
    options?: {
      onProgress?: (progress: { bytesTransferred: number; totalBytes: number; eof: boolean }) => void
      signal?: AbortSignal
    }
  ): Promise<{ totalBytes: number }> {
    const createAbortError = (): Error => {
      const error = new Error('Transfer cancelled by user.')
      ;(error as Error & { name: string }).name = 'AbortError'
      return error
    }

    const normalizedTargetPath = this.normalizeRemotePath(targetPath)
    const totalBytes = Math.max(0, Number((await fs.promises.stat(sourceLocalPath)).size) || 0)
    await this.closeChunkSessionsForPath(ptyId, normalizedTargetPath)

    const runStreamFallback = async (): Promise<void> => {
      const fallbackSftp = await this.createDedicatedSftp(ptyId)
      const readStream = fs.createReadStream(sourceLocalPath, { highWaterMark: 512 * 1024 })
      const writeStream = fallbackSftp.createWriteStream(normalizedTargetPath, { flags: 'w', autoClose: true })
      let bytesTransferred = 0
      readStream.on('data', (chunk: Buffer | string) => {
        const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        bytesTransferred += byteLength
        options?.onProgress?.({
          bytesTransferred,
          totalBytes,
          eof: bytesTransferred >= totalBytes
        })
      })

      let abortListener: (() => void) | undefined
      if (options?.signal) {
        const abortError = createAbortError()
        abortListener = () => {
          readStream.destroy(abortError)
          writeStream.destroy()
          try { fallbackSftp.end?.() } catch {}
        }
        if (options.signal.aborted) {
          abortListener()
        } else {
          options.signal.addEventListener('abort', abortListener, { once: true })
        }
      }

      try {
        await pipeline(readStream, writeStream)
      } finally {
        if (abortListener && options?.signal) {
          options.signal.removeEventListener('abort', abortListener)
        }
        try { fallbackSftp.end?.() } catch {}
      }
    }

    if (options?.signal?.aborted) {
      throw createAbortError()
    }

    const { endpointKey, profile } = this.selectAdaptiveFastTransferProfile(ptyId, 'upload')
    const fastStartedAt = Date.now()
    const fastTimeoutMs = this.getFastTransferTimeoutMs(totalBytes)
    const transferSftp = await this.createDedicatedSftp(ptyId)
    let aborted = false
    let abortListener: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: unknown): void => {
          if (settled) return
          settled = true
          clearTimeout(timeoutTimer)
          if (error) {
            reject(error)
            return
          }
          resolve()
        }
        const timeoutTimer = setTimeout(() => {
          finish(new Error(`SFTP fastPut timed out after ${fastTimeoutMs}ms`))
        }, fastTimeoutMs)

        if (options?.signal) {
          abortListener = () => {
            aborted = true
            try { transferSftp.end?.() } catch {}
            finish(createAbortError())
          }
          options.signal.addEventListener('abort', abortListener, { once: true })
        }

        transferSftp.fastPut(
          sourceLocalPath,
          normalizedTargetPath,
          {
            concurrency: profile.concurrency,
            chunkSize: profile.chunkSize,
            step: (totalTransferred: number, _chunk: number, total: number) => {
              const transferred = Math.max(0, Number(totalTransferred) || 0)
              options?.onProgress?.({
                bytesTransferred: transferred,
                totalBytes: Math.max(totalBytes, Math.max(0, Number(total) || 0)),
                eof: transferred >= totalBytes
              })
            }
          },
          (error) => {
            finish(error)
          }
        )
      })
      this.transferTuner.reportSuccess(
        endpointKey,
        'upload',
        profile.id,
        totalBytes,
        Date.now() - fastStartedAt
      )
    } catch (error) {
      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener)
      }
      try { transferSftp.end?.() } catch {}
      if (aborted || options?.signal?.aborted) {
        throw createAbortError()
      }
      this.transferTuner.reportFailure(endpointKey, 'upload', profile.id)
      await runStreamFallback()
      options?.onProgress?.({
        bytesTransferred: totalBytes,
        totalBytes,
        eof: true
      })
      return { totalBytes }
    }

    if (abortListener && options?.signal) {
      options.signal.removeEventListener('abort', abortListener)
    }
    try { transferSftp.end?.() } catch {}
    options?.onProgress?.({
      bytesTransferred: totalBytes,
      totalBytes,
      eof: true
    })
    return { totalBytes }
  }

  async readFileChunk(
    ptyId: string,
    filePath: string,
    offset: number,
    chunkSize: number,
    options?: { totalSizeHint?: number }
  ): Promise<{ chunk: Buffer; bytesRead: number; totalSize: number; nextOffset: number; eof: boolean }> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(filePath)
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const safeChunkSize = Number.isFinite(chunkSize) && chunkSize > 0
      ? Math.floor(chunkSize)
      : 256 * 1024
    const hintedTotalSize = Number.isFinite(options?.totalSizeHint) && (options?.totalSizeHint || 0) >= 0
      ? Math.floor(options!.totalSizeHint as number)
      : null
    const totalSize = hintedTotalSize !== null
      ? hintedTotalSize
      : Math.max(0, Number((await this.sftpStat(sftp, normalizedPath)).size) || 0)
    if (safeOffset >= totalSize) {
      return {
        chunk: Buffer.alloc(0),
        bytesRead: 0,
        totalSize,
        nextOffset: safeOffset,
        eof: true
      }
    }

    const targetSize = Math.max(1, Math.min(safeChunkSize, totalSize - safeOffset))

    // Open the file handle once and issue multiple sftp.read calls, avoiding the
    // per-sub-request OPEN+READ+CLOSE round trips that sftp.createReadStream incurs.
    const handle = await this.sftpOpen(sftp, normalizedPath, 'r')
    try {
      const chunks: Buffer[] = []
      let bytesRead = 0
      while (bytesRead < targetSize) {
        const requestBytes = Math.min(
          SSHBackend.MAX_SFTP_READ_REQUEST_BYTES,
          targetSize - bytesRead
        )
        const buf = Buffer.allocUnsafe(requestBytes)
        const partRead = await this.sftpReadDirect(
          sftp,
          handle,
          buf,
          0,
          requestBytes,
          safeOffset + bytesRead
        )
        if (partRead <= 0) {
          break
        }
        chunks.push(buf.subarray(0, partRead))
        bytesRead += partRead
      }

      const chunk = chunks.length > 0 ? Buffer.concat(chunks, bytesRead) : Buffer.alloc(0)
      const nextOffset = safeOffset + bytesRead
      const eof = nextOffset >= totalSize

      return {
        chunk,
        bytesRead,
        totalSize,
        nextOffset,
        eof
      }
    } finally {
      await this.sftpClose(sftp, handle).catch(() => {})
    }
  }

  async writeFileChunk(
    ptyId: string,
    filePath: string,
    offset: number,
    content: Buffer,
    options?: { truncate?: boolean }
  ): Promise<{ writtenBytes: number; nextOffset: number }> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(filePath)
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const sessionKey = this.getChunkSessionKey('write', ptyId, normalizedPath)
    const shouldTruncateAtStart = options?.truncate === true && safeOffset === 0

    const existingSession = this.chunkWriteSessions.get(sessionKey)
    if (
      existingSession
      && (
        existingSession.sftp !== sftp
        || shouldTruncateAtStart
        || existingSession.expectedOffset !== safeOffset
      )
    ) {
      await this.disposeWriteSession(sessionKey)
    }

    let session = this.chunkWriteSessions.get(sessionKey)
    if (!session) {
      let handle: Buffer
      try {
        const openFlags: ssh2.OpenMode = shouldTruncateAtStart ? 'w' : 'r+'
        handle = await this.sftpOpen(sftp, normalizedPath, openFlags)
      } catch (error: any) {
        if (!(error?.code === 2 || error?.code === 'ENOENT') || safeOffset !== 0) {
          throw error
        }
        handle = await this.sftpOpen(sftp, normalizedPath, 'w')
      }

      session = {
        sftp,
        handle,
        expectedOffset: safeOffset
      }
      this.chunkWriteSessions.set(sessionKey, session)
    }
    this.refreshWriteSessionCleanupTimer(sessionKey, session)

    try {
      if (payload.length > 0) {
        await this.sftpWrite(session.sftp, session.handle, payload, 0, payload.length, safeOffset)
      }
      session.expectedOffset = safeOffset + payload.length
    } catch (error) {
      await this.disposeWriteSession(sessionKey)
      throw error
    }

    return {
      writtenBytes: payload.length,
      nextOffset: safeOffset + payload.length
    }
  }

  async writeFile(ptyId: string, filePath: string, content: string): Promise<void> {
    await this.writeFileBytes(ptyId, filePath, Buffer.from(content, 'utf8'))
  }

  async writeFileBytes(ptyId: string, filePath: string, content: Buffer): Promise<void> {
    const sftp = await this.getSftp(ptyId)
    const normalizedPath = this.normalizeRemotePath(filePath)
    await this.closeChunkSessionsForPath(ptyId, normalizedPath)
    await this.sftpWriteFile(sftp, normalizedPath, content)
  }

  private consumeOscMarkers(instance: SSHInstance, chunk: string): void {
    instance.oscBuffer += chunk
    const prefix = '\x1b]1337;gyshell_precmd'
    const suffix = '\x07'

    while (true) {
      const start = instance.oscBuffer.indexOf(prefix)
      if (start === -1) break
      const end = instance.oscBuffer.indexOf(suffix, start)
      if (end === -1) break

      const marker = instance.oscBuffer.slice(start, end)
      const cwdMatch = marker.match(/cwd_b64=([^;]+)/)
      if (cwdMatch && cwdMatch[1]) {
        try {
          const decoded = Buffer.from(cwdMatch[1], 'base64').toString('utf8')
          const normalized = this.normalizeDecodedRemotePath(decoded)
          if (normalized) instance.cwd = normalized
        } catch {}
      }

      const homeMatch = marker.match(/home_b64=([^;]+)/)
      if (homeMatch && homeMatch[1]) {
        try {
          const decoded = Buffer.from(homeMatch[1], 'base64').toString('utf8')
          const normalized = this.normalizeDecodedRemotePath(decoded)
          if (normalized) instance.homeDir = normalized
        } catch {}
      }

      instance.oscBuffer = instance.oscBuffer.slice(end + suffix.length)
    }

    if (instance.oscBuffer.length > 8192) {
      instance.oscBuffer = instance.oscBuffer.slice(-4096)
    }
  }

  private normalizeDecodedRemotePath(decodedPath: string): string | null {
    if (typeof decodedPath !== 'string' || decodedPath.length === 0) {
      return null
    }
    const sanitized = decodedPath.replace(/[\u0000-\u001f\u007f]/g, '')
    return sanitized.length > 0 ? sanitized : null
  }
}
