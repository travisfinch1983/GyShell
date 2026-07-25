import type {
  GatewayEvent,
  GatewayIncomingEnvelope,
  RpcRequest,
  UIUpdateAction
} from './types'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

type GatewayClientEventMap = {
  uiUpdate: (action: UIUpdateAction) => void
  gatewayEvent: (event: GatewayEvent) => void
  raw: (channel: string, payload: unknown) => void
  status: (status: ConnectionStatus, detail?: string) => void
  error: (message: string) => void
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RPC_TIMEOUT = 15000

function formatCloseDetail(event: CloseEvent): string {
  const code = Number.isFinite(event.code) ? event.code : 1006
  const reason = typeof event.reason === 'string' ? event.reason.trim() : ''
  const cleanSuffix = event.wasClean ? ', clean' : ', unclean'
  return reason ? `code=${code}${cleanSuffix}, reason=${reason}` : `code=${code}${cleanSuffix}`
}

const HEARTBEAT_INTERVAL_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 8_000

export class GatewayClient {
  private socket: WebSocket | null = null
  private nextRequestId = 1
  private pending = new Map<string, PendingRequest>()
  private manualClose = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  private listeners: {
    [K in keyof GatewayClientEventMap]: Set<GatewayClientEventMap[K]>
  } = {
    uiUpdate: new Set(),
    gatewayEvent: new Set(),
    raw: new Set(),
    status: new Set(),
    error: new Set()
  }

  on<K extends keyof GatewayClientEventMap>(
    event: K,
    listener: GatewayClientEventMap[K]
  ): () => void {
    this.listeners[event].add(listener)
    return () => {
      this.listeners[event].delete(listener)
    }
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async connect(url: string, timeoutMs = 4000): Promise<void> {
    this.disconnect()
    this.manualClose = false
    this.emit('status', 'connecting')

    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.emit('error', `WebSocket open failed: ${message}`)
        this.emit('status', 'disconnected', `open failed: ${message}`)
        reject(error instanceof Error ? error : new Error(message))
        return
      }
      this.socket = socket
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch {
          // ignore close errors
        }
        reject(new Error(`Connection timeout (${timeoutMs}ms)`))
      }, timeoutMs)

      socket.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.emit('status', 'connected')
        this.startHeartbeat()
        resolve()
      }

      socket.onerror = () => {
        this.emit('error', 'WebSocket transport error')
      }

      socket.onclose = (event) => {
        clearTimeout(timer)
        this.stopHeartbeat()
        this.rejectAllPending(new Error(`Socket closed (${event.code})`))
        this.socket = null
        if (!this.manualClose && !settled) {
          settled = true
          reject(new Error(`Socket closed before connected (${event.code})`))
        }
        const reason = formatCloseDetail(event)
        this.emit('status', 'disconnected', reason)
      }

      socket.onmessage = (event) => {
        void this.handleIncoming(event.data)
      }
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    // Client-side liveness: on a half-open/flaky link the browser never fires onclose,
    // so RPCs would silently time out forever (zombie socket). Ping the gateway; if it
    // doesn't answer in time, force-close to trigger the shim's reconnect.
    this.heartbeatTimer = setInterval(() => {
      const s = this.socket
      // A missing socket, or one stuck mid-teardown that never fired onclose, is a zombie
      // socket. Returning here (as this used to) meant the one mechanism designed to catch a
      // dead link silently did nothing in precisely the case it exists for. Escalate so the
      // consumer's reconnect driver actually runs. CONNECTING is legitimately transient.
      if (!s) {
        this.stopHeartbeat()
        this.emit('status', 'disconnected', 'heartbeat: no socket')
        return
      }
      if (s.readyState === WebSocket.CONNECTING) return
      if (s.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat()
        try { s.close() } catch { /* noop */ }
        this.rejectAllPending(new Error('Socket not open (heartbeat)'))
        this.socket = null
        this.emit('status', 'disconnected', `heartbeat: readyState=${s.readyState}`)
        return
      }
      this.request('gateway:ping', {}, HEARTBEAT_TIMEOUT_MS).catch(() => {
        try { s.close() } catch { /* noop */ }
      })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  disconnect(): void {
    this.manualClose = true
    this.stopHeartbeat()
    if (!this.socket) return
    try {
      this.socket.close()
    } catch {
      // ignore close errors
    }
    this.rejectAllPending(new Error('Socket disconnected'))
    this.socket = null
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_RPC_TIMEOUT
  ): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway socket is not connected')
    }

    const id = String(this.nextRequestId++)
    const payload: RpcRequest = { id, method, params }

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

      try {
        socket.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private emit<K extends keyof GatewayClientEventMap>(
    event: K,
    ...args: Parameters<GatewayClientEventMap[K]>
  ): void {
    this.listeners[event].forEach((listener) => {
      try {
        ;(listener as (...values: Parameters<GatewayClientEventMap[K]>) => void)(...args)
      } catch (error) {
        console.error(`[GatewayClient] Listener error for ${event}:`, error)
      }
    })
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private async handleIncoming(raw: unknown): Promise<void> {
    const text = await this.coerceToText(raw)
    let payload: GatewayIncomingEnvelope

    try {
      payload = JSON.parse(text) as GatewayIncomingEnvelope
    } catch {
      this.emit('error', `Invalid JSON received: ${text.slice(0, 120)}`)
      return
    }

    if (!payload || typeof payload !== 'object' || !('type' in payload)) return

    if (payload.type === 'gateway:response') {
      const pending = this.pending.get(payload.id)
      if (!pending) return

      clearTimeout(pending.timer)
      this.pending.delete(payload.id)

      if (payload.ok) {
        pending.resolve(payload.result)
      } else {
        pending.reject(new Error(`${payload.error.code}: ${payload.error.message}`))
      }
      return
    }

    if (payload.type === 'gateway:ui-update') {
      this.emit('uiUpdate', payload.payload)
      return
    }

    if (payload.type === 'gateway:event') {
      this.emit('gatewayEvent', payload.payload)
      return
    }

    if (payload.type === 'gateway:raw') {
      this.emit('raw', payload.channel, payload.payload)
    }
  }

  private async coerceToText(raw: unknown): Promise<string> {
    if (typeof raw === 'string') return raw
    if (raw instanceof Blob) return await raw.text()
    if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw))
    if (ArrayBuffer.isView(raw)) {
      return new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    }
    return String(raw)
  }
}
