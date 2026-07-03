declare module 'ws' {
  // Minimal hand-rolled surface (this file shadows @types/ws for the backend
  // tsconfig) — extend as consumers need. WebSocket is the per-connection
  // socket handed to 'connection' / handleUpgrade callbacks.
  export class WebSocket {
    /** client mode (specs/tools); server-side sockets come from handleUpgrade */
    constructor(address?: string)
    readonly readyState: number
    readonly OPEN: number
    send(data: string | Buffer, options?: { binary?: boolean }): void
    close(code?: number, reason?: string): void
    on(event: 'open', listener: () => void): void
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void
    on(event: 'close', listener: (code: number, reason: Buffer) => void): void
    on(event: 'error', listener: (err: Error) => void): void
  }
  export class WebSocketServer {
    constructor(options: { host?: string; port?: number; noServer?: boolean })
    on(event: 'connection', listener: (socket: any, request?: any) => void): void
    handleUpgrade(
      request: any,
      socket: any,
      head: Buffer,
      callback: (ws: WebSocket, request: any) => void,
    ): void
    close(callback?: (error?: Error) => void): void
  }
}
