import type { GatewayEvent, IClientTransport } from './types'
import { recordGatewaySend } from './gatewayStats'

/**
 * TransportHub is a transport-only registry and broadcaster.
 * It keeps GatewayService orchestration logic decoupled from client fan-out details.
 */
export class TransportHub {
  private transports: Map<string, IClientTransport> = new Map()

  register(transport: IClientTransport): void {
    this.transports.set(transport.id, transport)
  }

  unregister(transportId: string): void {
    this.transports.delete(transportId)
  }

  emitEvent(event: GatewayEvent): void {
    this.transports.forEach((transport) => {
      transport.emitEvent(event)
    })
  }

  send(channel: string, data: any): void {
    // Counted PER RECIPIENT: a broadcast to N clients is N copies on the wire, so counting
    // one copy would understate real egress by exactly the client count. Serialized once
    // here purely to measure; each transport still does its own encoding.
    let bytes = 0
    try { bytes = JSON.stringify(data ?? null).length } catch { bytes = 0 }
    this.transports.forEach((transport) => {
      recordGatewaySend('push', channel, bytes)
      transport.send(channel, data)
    })
  }

  sendUIUpdate(action: any): void {
    this.transports.forEach((transport) => {
      transport.sendUIUpdate(action)
    })
  }

  forEach(fn: (transport: IClientTransport) => void): void {
    this.transports.forEach(fn)
  }

  size(): number {
    return this.transports.size
  }

  getIds(): string[] {
    return Array.from(this.transports.keys())
  }
}

