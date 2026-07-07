/**
 * newUuid — crypto.randomUUID with an insecure-context fallback.
 *
 * crypto.randomUUID exists ONLY in secure contexts (https / localhost).
 * Opening AI-Lab via plain http://<lan-ip>:<port> made every unguarded call
 * THROW — live finding (2026-07-07): the chat agent picker silently did
 * nothing because openHermesTab crashed allocating a conversation id.
 * crypto.getRandomValues IS available everywhere, so the fallback is still a
 * real v4 UUID, not a Math.random cookie.
 */
export function newUuid(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
