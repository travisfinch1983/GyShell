/**
 * Cross-tab single-winner election: when the same event reaches every open AI-Lab tab
 * (each tab has its own gateway WebSocket), exactly ONE tab should act on it visibly.
 *
 * Built for the clipboard drawer: a drop used to slide down in every open tab; now it
 * opens only where Travis is actually working, and the rest update quietly.
 *
 * Protocol (no coordinator): on elect(key) every tab broadcasts a candidacy
 * { key, tabId, score, lastActive } and collects the others' for CLAIM_WINDOW_MS.
 * All tabs then run the SAME deterministic comparison over the same set, so they
 * agree on one winner:
 *   1. score   — 2 = document has focus, 1 = visible, 0 = hidden
 *   2. lastActive — most recent user activity (focus/pointer/keys), so "no tab is
 *      focused" still picks the one Travis used last instead of dropping the open
 *   3. tabId   — lexicographic tie-break, purely for determinism
 *
 * Transport mirrors lib/windowing: BroadcastChannel, except on file:// (Electron
 * renderer — opaque origin makes BroadcastChannel unreliable) where it falls back to
 * localStorage + the storage event. If NEITHER transport exists, elect() fail-OPENS
 * (acts locally): a drop must never be lost to coordination plumbing.
 */

interface Candidacy {
  key: string
  tabId: string
  score: number
  lastActive: number
}

interface ElectionChannel {
  post(msg: Candidacy): void
  onMessage(cb: (msg: Candidacy) => void): void
  close(): void
}

const CHANNEL_NAME = 'ailab-tab-election'
const STORAGE_KEY = 'ailab-tab-election-msg'
export const CLAIM_WINDOW_MS = 250

function createChannel(): ElectionChannel | null {
  if (typeof window === 'undefined') return null
  const isFile = (() => { try { return window.location?.protocol === 'file:' } catch { return false } })()

  if (!isFile && typeof BroadcastChannel !== 'undefined') {
    try {
      const bc = new BroadcastChannel(CHANNEL_NAME)
      return {
        post: (msg) => bc.postMessage(msg),
        onMessage: (cb) => { bc.onmessage = (e) => { if (e?.data?.key) cb(e.data as Candidacy) } },
        close: () => bc.close(),
      }
    } catch (e) {
      console.warn('[tab-election] BroadcastChannel unavailable, trying storage:', (e as Error)?.message || e)
    }
  }

  // storage-event fallback: events fire in OTHER tabs only, which is exactly what we
  // need (our own candidacy is added locally). removeItem first so the same payload
  // twice still raises an event.
  try {
    const storage = window.localStorage
    storage.getItem(STORAGE_KEY) // probe: throws in some private modes
    let handler: ((msg: Candidacy) => void) | null = null
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return
      try {
        const msg = JSON.parse(e.newValue) as Candidacy
        if (msg?.key) handler?.(msg)
      } catch (err) {
        console.warn('[tab-election] malformed storage payload:', (err as Error)?.message || err)
      }
    }
    window.addEventListener('storage', onStorage)
    return {
      post: (msg) => {
        try {
          storage.removeItem(STORAGE_KEY)
          storage.setItem(STORAGE_KEY, JSON.stringify(msg))
        } catch (e) {
          console.warn('[tab-election] storage post failed:', (e as Error)?.message || e)
        }
      },
      onMessage: (cb) => { handler = cb },
      close: () => window.removeEventListener('storage', onStorage),
    }
  } catch (e) {
    console.warn('[tab-election] no cross-tab transport at all, elections fail-open:', (e as Error)?.message || e)
    return null
  }
}

/** Deterministic winner over an identical candidate set — every tab must agree. */
export function pickWinner(cands: Candidacy[]): Candidacy | null {
  if (cands.length === 0) return null
  return cands.reduce((best, c) => {
    if (c.score !== best.score) return c.score > best.score ? c : best
    if (c.lastActive !== best.lastActive) return c.lastActive > best.lastActive ? c : best
    return c.tabId > best.tabId ? c : best
  })
}

export class TabElection {
  private readonly tabId: string =
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  private channel: ElectionChannel | null
  private lastActive = Date.now()
  private pending = new Map<string, { cands: Candidacy[]; timer: ReturnType<typeof setTimeout>; onWin: () => void }>()
  /** Candidacies that arrived BEFORE our own election for that key started (WebSocket skew:
   *  another tab's clip:posted can land here first). Merged in at elect() so both tabs
   *  always compare the same set; without this, each would see only itself and both open. */
  private early = new Map<string, { cands: Candidacy[]; expires: number }>()

  constructor() {
    this.channel = createChannel()
    this.channel?.onMessage((msg) => {
      const p = this.pending.get(msg.key)
      if (p) {
        if (!p.cands.some((c) => c.tabId === msg.tabId)) p.cands.push(msg)
        return
      }
      const e = this.early.get(msg.key)
      if (e && Date.now() < e.expires) {
        if (!e.cands.some((c) => c.tabId === msg.tabId)) e.cands.push(msg)
      } else {
        this.early.set(msg.key, { cands: [msg], expires: Date.now() + 2_000 })
      }
      if (this.early.size > 50) {
        for (const [k, v] of this.early) if (Date.now() >= v.expires) this.early.delete(k)
      }
    })
    if (typeof window !== 'undefined') {
      const bump = () => { this.lastActive = Date.now() }
      window.addEventListener('focus', bump)
      window.addEventListener('pointerdown', bump, { passive: true })
      window.addEventListener('keydown', bump)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') bump()
      })
    }
  }

  private score(): number {
    try {
      if (document.hasFocus()) return 2
      if (document.visibilityState === 'visible') return 1
    } catch { /* non-DOM environment scores 0 */ }
    return 0
  }

  /**
   * Run (or join) the election for `key`; `onWin` fires in exactly one tab after the
   * claim window. Same key from several events joins one pending election.
   */
  elect(key: string, onWin: () => void): void {
    if (!this.channel) { onWin(); return }   // no transport: act locally, never lose the event
    if (this.pending.has(key)) return
    const mine: Candidacy = { key, tabId: this.tabId, score: this.score(), lastActive: this.lastActive }
    const earlier = this.early.get(key)
    this.early.delete(key)
    const seed = earlier && Date.now() < earlier.expires ? earlier.cands : []
    const entry = {
      cands: [mine, ...seed.filter((c) => c.tabId !== this.tabId)],
      onWin,
      timer: setTimeout(() => {
        const p = this.pending.get(key)
        this.pending.delete(key)
        if (!p) return
        const winner = pickWinner(p.cands)
        if (winner?.tabId === this.tabId) p.onWin()
      }, CLAIM_WINDOW_MS),
    }
    this.pending.set(key, entry)
    this.channel.post(mine)
  }
}

export const tabElection = new TabElection()
