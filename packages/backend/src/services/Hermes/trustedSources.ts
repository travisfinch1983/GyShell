/**
 * Trusted-source gate for routes that can put words into an agent's mouth (claude1, 2026-10-16).
 *
 * POST /api/hermes/agents/:id/prompt injects arbitrary text into a live agent session. It was
 * reachable, unauthenticated, from anything on the LAN, on both the UI port (17889, vite preview
 * proxying to the backend) and the API port (17890). A fleet envelope is plain text inside that
 * body, so any LAN device could forge a "fleet message" an agent can't tell from a real one; the
 * fleet test suite actually did this to turing by accident (roadmap node-mtjikr3c1xy).
 *
 * Neither binding to loopback nor a shared token fits. Travis reaches the UI through cloudflared
 * and headscale (and from LAN devices), cluster services use 17890, and a token would have to sit in
 * the browser bundle that every UI visitor downloads. So the route accepts only known SOURCE
 * addresses:
 *   - loopback + CT152 itself (fleetd, the backend, the UI server)
 *   - CT181 (the Claude Code instances)
 *   - cloudflared (10.0.0.132), whose users Cloudflare Access already authenticated
 *   - headscale (10.0.0.67), which only routes authenticated tailnet devices
 *   - Travis's LAN devices, listed in the config file
 * Editable without a deploy: /opt/ai-lab/.gybackend-data/trusted-sources.json
 *   { "sources": [ { "cidr": "10.0.0.50/32", "label": "Travis laptop" }, ... ] }
 *   plus "mode": "report" | "enforce". In REPORT mode nothing is blocked: a request from an
 *   unlisted address is logged as WOULD-REFUSE with its address, so Travis's own devices show up
 *   in the log before enforcement can lock him out of AI-Lab chat (which uses this route). The
 *   default is report until the file says enforce.
 * Read on every check (cheap; 5 s cache), so an edit applies within 5 s.
 *
 * Client address: the socket peer. Only when the peer is LOOPBACK (the vite UI server proxying with
 * xfwd) is the LAST X-Forwarded-For entry trusted, i.e. the address that connected to the UI server.
 * A forged header from anywhere else is ignored.
 */
import { readFileSync } from 'fs'
import type express from 'express'

const CONFIG = process.env.AILAB_TRUSTED_SOURCES_FILE || '/opt/ai-lab/.gybackend-data/trusted-sources.json'
const DEFAULT_SOURCES: Array<{ cidr: string; label: string }> = [
  { cidr: '127.0.0.0/8', label: 'loopback' },
  { cidr: '10.0.0.219/32', label: 'CT152 (ai-lab: backend, UI server, fleetd)' },
  { cidr: '10.0.0.161/32', label: 'CT181 (Claude Code instances)' },
  { cidr: '10.0.0.132/32', label: 'cloudflared (Cloudflare Access-authenticated)' },
  { cidr: '10.0.0.67/32', label: 'headscale (authenticated tailnet devices)' },
]

let cache: { at: number; mode: 'report' | 'enforce'; list: Array<{ net: number; mask: number; label: string }> } | null = null

function ip4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const p = m.slice(1).map(Number)
  if (p.some((x) => x > 255)) return null
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
}

function compile(entries: Array<{ cidr: string; label?: string }>) {
  const out: Array<{ net: number; mask: number; label: string }> = []
  for (const e of entries) {
    const [addr, bitsRaw] = String(e.cidr || '').split('/')
    const n = ip4(addr)
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
    if (n === null || !(bits >= 0 && bits <= 32)) { console.warn(`[trusted-sources] ignoring bad entry ${JSON.stringify(e)}`); continue }
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0)
    out.push({ net: (n & mask) >>> 0, mask, label: e.label || e.cidr })
  }
  return out
}

function load() {
  if (cache && Date.now() - cache.at < 5000) return cache
  let extra: Array<{ cidr: string; label?: string }> = []
  let mode: 'report' | 'enforce' = 'report'
  try {
    const j = JSON.parse(readFileSync(CONFIG, 'utf8'))
    if (Array.isArray(j?.sources)) extra = j.sources
    if (j?.mode === 'enforce') mode = 'enforce'
  } catch (e: any) {
    if (e?.code !== 'ENOENT') console.error(`[trusted-sources] ${CONFIG} unreadable (${e?.message}); using defaults only, REPORT mode`)
  }
  cache = { at: Date.now(), mode, list: compile([...DEFAULT_SOURCES, ...extra]) }
  return cache
}
const trustedList = () => load().list

const norm = (a: string | undefined) => String(a || '').replace(/^::ffff:/, '')

/** The address that actually originated the request (see header comment for the XFF rule). */
export function clientAddress(req: express.Request): string {
  const peer = norm(req.socket?.remoteAddress)
  if (peer === '::1' || peer.startsWith('127.')) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (xff.length) return norm(xff[xff.length - 1])
    return '127.0.0.1'
  }
  return peer
}

export function trustedLabel(addr: string): string | null {
  const n = ip4(addr === '::1' ? '127.0.0.1' : addr)
  if (n === null) return null
  const hit = trustedList().find((t) => ((n & t.mask) >>> 0) === t.net)
  return hit ? hit.label : null
}

/** Express middleware: 403 unless the request comes from a trusted source. Every refusal is logged. */
export function requireTrustedSource(what: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const addr = clientAddress(req)
    if (trustedLabel(addr)) return next()
    if (load().mode !== 'enforce') {
      console.warn(`[trusted-sources] WOULD-REFUSE (report mode, allowed) ${what} from ${addr} (peer ${norm(req.socket?.remoteAddress)}). Add it to ${CONFIG} if legitimate, then set "mode":"enforce".`)
      return next()
    }
    console.warn(`[trusted-sources] REFUSED ${what} from ${addr} (peer ${norm(req.socket?.remoteAddress)}, xff "${req.headers['x-forwarded-for'] || ''}"). Add it to ${CONFIG} if this is a legitimate device.`)
    res.status(403).json({ error: `${what} is only accepted from trusted sources; ${addr} is not one.`,
      hint: `If this is your device, add it to ${CONFIG} on CT152.` })
  }
}
