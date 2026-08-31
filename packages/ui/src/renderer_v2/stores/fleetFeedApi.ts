/**
 * Fleet Feed wire adapter — the fleetd-backed messaging-v2 surface (see
 * fleet-channel docs/FEED_CONTRACT.md + shared/fleet/feed-contracts.ts).
 * Same pattern as hermesApi.ts: ALL endpoint knowledge lives here.
 *
 * Canonical route names ONLY (/feed, /send, /agents, /guard). The launch-era
 * aliases (threads/message/directory/delivery-guard) were DROPPED in 1bcd13e —
 * this header claimed they remained for a while after, which is the
 * doc-outlives-artifact shape that kept the contract validator calling dead
 * routes.
 *
 * JSON rides the cluster bridge (standard #1 — the browser never talks to
 * fleetd or any 10.0.0.x address). Attachment BYTES are the one
 * relative-fetch exception: the bridge RPC is JSON-only and the backend
 * streams `/api/fleet/attachment/:id`.
 *
 * TYPES come from @gyshell/shared fleet/feed-contracts.ts (snake_case =
 * fleetd's JSON; timestamps are epoch SECONDS floats — use feedSecondsToDate).
 * Re-exported here so the store/panel have a single import seam.
 */
import { FEED_VIEWER_ID, type FeedAttachmentKind, type FeedVisibility } from '@gyshell/shared'
import type {

  FeedAttachmentRef,
  FeedCategory,
  FeedDirectoryEntry,
  FeedGuard,
  FeedList,
  FeedSearchHit,
  FeedThreadKind,
  FeedThreadRead,
} from '@gyshell/shared'

export type {
  FeedAttachmentRef,
  FeedCategory,
  FeedDirectoryEntry,
  FeedGuard,
  FeedList,
  FeedMessage,
  FeedReceipt,
  FeedReceiptState,
  FeedSearchHit,
  FeedThread,
  FeedThreadKind,
  FeedThreadRead,
  FeedVisibility,
} from '@gyshell/shared'

/**
 * Unwrap a list envelope, LOUDLY. The old `r?.key ?? r ?? []` triple-fallback
 * turned a backend key rename into a silent [] (or worse, returned the raw
 * envelope object as the "array") — the writer-wrote-a-different-shape-than-
 * the-reader-read class from the Pages incident. A drifted shape now returns
 * [] but names itself once per key in the console, so drift is findable.
 */
const warnedShapes = new Set<string>()
export function unwrapList<T>(r: unknown, what: string, ...keys: string[]): T[] {
  const obj = r as Record<string, unknown> | null
  for (const k of keys) {
    const v = obj?.[k]
    if (Array.isArray(v)) return v as T[]
  }
  if (Array.isArray(r)) return r as T[]
  if (r != null && !warnedShapes.has(what)) {
    warnedShapes.add(what)
    console.warn(`[fleet-feed] ${what}: response matched none of [${keys.join(', ')}] and is not an array — backend shape drift? keys seen: ${obj ? Object.keys(obj).join(',') : typeof r}`)
  }
  return []
}

export { feedSecondsToDate } from '@gyshell/shared'

/** Feed list scope — a query concept of the /feed route, not a stored shape. */
export type FeedScope = 'public' | 'mine' | 'all'

/** Outbound attachment riding inline on message/post (FeedAttachmentRequest minus message_id — no post-hoc race). */
export interface FeedAttachmentInput {
  filename?: string
  media_type: string
  kind: FeedAttachmentKind
  content_b64?: string
  structured?: unknown
}

/** Canonical viewer identity for Travis/the UI — registered in the directory as kind:user. */
export const FLEET_VIEWER = FEED_VIEWER_ID

function bridge(): { request: (method: string, path: string, body?: unknown) => Promise<any> } | undefined {
  return (window as any).gyshell?.cluster
}

async function get(path: string): Promise<any> {
  const b = bridge()
  if (!b) throw new Error('cluster bridge unavailable')
  return b.request('GET', path)
}

async function post(path: string, body: unknown): Promise<any> {
  const b = bridge()
  if (!b) throw new Error('cluster bridge unavailable')
  return b.request('POST', path, body)
}

const q = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

export const fleetFeedApi = {
  available(): boolean {
    return !!bridge()
  },

  async feed(opts: {
    scope: FeedScope
    category?: string
    kind?: FeedThreadKind
    limit?: number
    /** Opaque — pass a previous response's next_cursor straight back. */
    cursor?: string
  }): Promise<FeedList> {
    return get(
      `/api/fleet/feed${q({
        scope: opts.scope,
        category: opts.category,
        kind: opts.kind,
        viewer: FLEET_VIEWER,
        limit: opts.limit ?? 60,
        cursor: opts.cursor,
        unread: 1,
      })}`,
    )
  },

  /** Tail window, ascending by seq; walk back with before_seq. */
  async thread(id: string, opts?: { limit?: number; before_seq?: number }): Promise<FeedThreadRead> {
    return get(
      `/api/fleet/thread/${encodeURIComponent(id)}${q({
        limit: opts?.limit,
        before_seq: opts?.before_seq,
      })}`,
    )
  },

  async markRead(threadId: string, upToSeq: number): Promise<void> {
    await post(`/api/fleet/thread/${encodeURIComponent(threadId)}/read`, {
      viewer: FLEET_VIEWER,
      up_to_seq: upToSeq,
    })
  },

  async unreadTotal(): Promise<number> {
    const r = await get(`/api/fleet/unread${q({ viewer: FLEET_VIEWER })}`)
    return (r?.unread ?? []).reduce((n: number, u: { unread_count: number }) => n + (u.unread_count ?? 0), 0)
  },

  async createPost(input: {
    category?: string
    subject: string
    body: string
    visibility?: FeedVisibility
    attachments?: FeedAttachmentInput[]
  }): Promise<any> {
    return post('/api/fleet/post', { sender: FLEET_VIEWER, ...input })
  },

  async send(input: {
    to: string[]
    body: string
    subject?: string
    thread_id?: string
    parent_id?: string
    attachments?: FeedAttachmentInput[]
  }): Promise<any> {
    return post('/api/fleet/send', { sender: FLEET_VIEWER, ...input })
  },

  async setVisibility(threadId: string, visibility: FeedVisibility): Promise<any> {
    return post(`/api/fleet/thread/${encodeURIComponent(threadId)}/visibility`, {
      actor: FLEET_VIEWER,
      visibility,
    })
  },

  async categories(): Promise<FeedCategory[]> {
    const r = await get('/api/fleet/categories')
    return unwrapList<FeedCategory>(r, 'categories', 'categories')
  },

  /** PUBLIC content only — enforced in fleetd's query, not by a caller flag. */
  async search(query: string): Promise<FeedSearchHit[]> {
    const r = await get(`/api/fleet/search${q({ q: query })}`)
    return unwrapList<FeedSearchHit>(r, 'search', 'hits', 'results')
  },

  async directory(): Promise<FeedDirectoryEntry[]> {
    const r = await get('/api/fleet/agents')
    return unwrapList<FeedDirectoryEntry>(r, 'directory', 'agents', 'directory')
  },

  async guard(): Promise<FeedGuard> {
    return get('/api/fleet/guard')
  },

  async setGuard(enabled: boolean, reason?: string): Promise<FeedGuard> {
    return post('/api/fleet/guard', { enabled, actor: FLEET_VIEWER, reason })
  },

  /** Flowchart machine-readable form (pixels are useless to another agent). */
  async fetchStructured(ref: FeedAttachmentRef): Promise<string> {
    const r = await get(`/api/fleet/attachment/${encodeURIComponent(ref.attachment_id)}/structured`)
    return JSON.stringify(r?.structured ?? r, null, 2)
  },

  /**
   * Attachment bytes — deliberate, explicit fetch (UI rule 3: never inline
   * unbidden). Returns an object URL for binary content or text for
   * JSON/text payloads. Caller owns revoke().
   */
  async fetchAttachment(ref: FeedAttachmentRef): Promise<{ url?: string; text?: string }> {
    const r = await fetch(`/api/fleet/attachment/${encodeURIComponent(ref.attachment_id)}`)
    if (!r.ok) throw new Error(`attachment fetch failed: HTTP ${r.status}`)
    const isText = /json|text\/|xml/.test(ref.media_type) || /json|text\/|xml/.test(r.headers.get('content-type') ?? '')
    if (isText) return { text: await r.text() }
    return { url: URL.createObjectURL(await r.blob()) }
  },
}

/**
 * Client-side sanity cap: the write routes accept 25mb JSON bodies (measured by
 * claude1 through both 17890 and the web host), so ~18MB of raw file survives
 * base64 inflation. Oversize server refusals come back readable
 * ({ok:false, stage:'validation', limit:'25mb'}, HTTP 413) and are surfaced as-is.
 */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024

/** File → inline attachment input (base64, chunked so large files don't blow the stack). */
export async function fileToAttachment(f: File): Promise<FeedAttachmentInput> {
  if (f.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${f.name}: ${Math.round(f.size / 1024)} KB exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB attachment cap`)
  }
  const bytes = new Uint8Array(await f.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return {
    filename: f.name,
    media_type: f.type || 'application/octet-stream',
    kind: f.type.startsWith('image/') ? 'image' : 'document',
    content_b64: btoa(bin),
  }
}
