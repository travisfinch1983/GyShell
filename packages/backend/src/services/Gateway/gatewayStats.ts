/**
 * Byte/message counters for the WebSocket gateway, keyed by RPC method or push channel.
 *
 * Exists because /gateway was measured serving 1.35 GB (85% of all AI-Lab egress) with no
 * way to see WHICH method or channel was responsible.
 *
 * Deliberately a plain in-memory map with NO timer: the thing under investigation is
 * background traffic, so the instrument must not add any. Counts are since process start
 * or the last explicit reset, and are lost on restart — that is fine for diagnosis and
 * avoids another file to keep consistent.
 */

export interface GatewayStatEntry {
  /** 'rpc' = a response to a client request; 'push' = server-initiated broadcast. */
  kind: 'rpc' | 'push'
  key: string
  messages: number
  bytes: number
}

const entries = new Map<string, GatewayStatEntry>()
let since = Date.now()

/** Record one message leaving the gateway. `bytes` is the serialized payload length. */
export function recordGatewaySend(kind: 'rpc' | 'push', key: string, bytes: number): void {
  const id = `${kind}:${key}`
  let e = entries.get(id)
  if (!e) { e = { kind, key, messages: 0, bytes: 0 }; entries.set(id, e) }
  e.messages += 1
  e.bytes += bytes
}

export function getGatewayStats(): {
  since: number
  elapsedSec: number
  totalBytes: number
  totalMessages: number
  /** Sustained egress implied by these counters — the number to compare against a link. */
  avgMbitPerSec: number
  entries: Array<GatewayStatEntry & { mbitPerSec: number; avgBytes: number }>
} {
  const elapsedSec = Math.max(1, (Date.now() - since) / 1000)
  const list = [...entries.values()]
    .map((e) => ({
      ...e,
      // Per-entry rate, so a single fat channel is obvious next to many thin ones.
      mbitPerSec: (e.bytes * 8) / elapsedSec / 1_000_000,
      avgBytes: Math.round(e.bytes / Math.max(1, e.messages)),
    }))
    .sort((a, b) => b.bytes - a.bytes)
  const totalBytes = list.reduce((n, e) => n + e.bytes, 0)
  return {
    since,
    elapsedSec: Math.round(elapsedSec),
    totalBytes,
    totalMessages: list.reduce((n, e) => n + e.messages, 0),
    avgMbitPerSec: (totalBytes * 8) / elapsedSec / 1_000_000,
    entries: list,
  }
}

export function resetGatewayStats(): void {
  entries.clear()
  since = Date.now()
}
