/**
 * Fleet Feed wire adapter — the fleetd-backed messaging-v2 surface (see
 * fleet-channel docs/FEED_CONTRACT.md + shared/fleet/feed-contracts.ts).
 * Same pattern as hermesApi.ts: ALL endpoint knowledge lives here.
 *
 * Route names avoid the ConversationBus router's claims (it is mounted first
 * and Express shadows silently): threads NOT feed, message NOT send,
 * directory NOT agents, delivery-guard NOT guard.
 *
 * JSON rides the cluster bridge (standard #1 — the browser never talks to
 * fleetd or any 10.0.0.x address). Attachment BYTES are the one
 * relative-fetch exception: the bridge RPC is JSON-only and the backend
 * streams `/api/fleet/attachment/:id`.
 *
 * TYPES mirror packages/shared/src/fleet/feed-contracts.ts (snake_case =
 * fleetd's JSON, timestamps are epoch ms numbers). Local copies until
 * claude1's shared file is pushed — then import from @gyshell/shared and
 * delete these.
 */

export type FeedVisibility = 'private' | 'public'
export type FeedThreadKind = 'dm' | 'post'
export type FeedAttachmentKind = 'image' | 'flowchart' | 'document'
export type FeedScope = 'public' | 'mine' | 'all'
export type FeedReceiptState = 'queued' | 'delivered' | 'woke' | 'acked' | 'failed'

export interface FeedAttachmentRef {
  attachment_id: string
  filename: string | null
  media_type: string
  kind: FeedAttachmentKind
  byte_size: number
  sha256: string | null
  created_at: number
}

export interface FeedReceipt {
  recipient: string
  state: FeedReceiptState
  attempts: number
  queued_at: number | null
  delivered_at: number | null
  woke_at: number | null
  acked_at: number | null
  failure_stage: string | null
  failure_detail: string | null
}

export interface FeedMessage {
  message_id: string
  thread_id: string
  seq: number
  parent_id: string | null
  sender: string
  body: string
  kind: string
  created_at: number
  attachments: FeedAttachmentRef[]
  receipts?: FeedReceipt[]
}

export interface FeedThread {
  thread_id: string
  subject: string | null
  kind: FeedThreadKind
  category: string | null
  visibility: FeedVisibility
  participants: string[]
  message_count: number
  unread_count?: number
  last_sender: string | null
  last_snippet: string | null
  created_at: number
  updated_at: number
}

export interface FeedList {
  threads: FeedThread[]
  has_more: boolean
  next_cursor: string | null
}

export interface FeedThreadRead {
  thread: FeedThread
  messages: FeedMessage[]
  has_more: boolean
  before_seq: number | null
}

export interface FeedDirectoryEntry {
  agent_id: string
  display_name: string
  kind: string
  endpoint: string | null
  enabled: boolean
  can_broadcast: boolean
  can_focused: boolean
  status: string | null
  presence_at: number | null
  turn_count: number | null
}

export interface FeedCategory {
  name: string
  description: string | null
  created_by: string | null
  created_at: number
  thread_count: number
}

export interface FeedSearchHit {
  message_id: string
  thread_id: string
  seq: number
  subject: string | null
  category: string | null
  sender: string
  body: string
  created_at: number
}

export interface FeedGuard {
  enabled: boolean
  reason: string | null
  updated_by: string | null
  updated_at: number | null
}

/** Outbound attachment riding inline on message/post (no post-hoc race). */
export interface FeedAttachmentInput {
  filename?: string
  media_type: string
  kind: FeedAttachmentKind
  content_b64?: string
  structured?: unknown
}

/** Canonical viewer identity for Travis/the UI — registered in the directory as kind:user. */
export const FLEET_VIEWER = 'user'

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
      `/api/fleet/threads${q({
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
    return post('/api/fleet/message', { sender: FLEET_VIEWER, ...input })
  },

  async setVisibility(threadId: string, visibility: FeedVisibility): Promise<any> {
    return post(`/api/fleet/thread/${encodeURIComponent(threadId)}/visibility`, {
      actor: FLEET_VIEWER,
      visibility,
    })
  },

  async categories(): Promise<FeedCategory[]> {
    const r = await get('/api/fleet/categories')
    return (r?.categories ?? r ?? []) as FeedCategory[]
  },

  /** PUBLIC content only — enforced in fleetd's query, not by a caller flag. */
  async search(query: string): Promise<FeedSearchHit[]> {
    const r = await get(`/api/fleet/search${q({ q: query })}`)
    return (r?.hits ?? r?.results ?? r ?? []) as FeedSearchHit[]
  },

  async directory(): Promise<FeedDirectoryEntry[]> {
    const r = await get('/api/fleet/directory')
    return (r?.agents ?? r?.directory ?? r ?? []) as FeedDirectoryEntry[]
  },

  async guard(): Promise<FeedGuard> {
    return get('/api/fleet/delivery-guard')
  },

  async setGuard(enabled: boolean, reason?: string): Promise<FeedGuard> {
    return post('/api/fleet/delivery-guard', { enabled, actor: FLEET_VIEWER, reason })
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

/** Max attachment size the composer will base64 (matches the backend's 1mb json cap headroom). */
export const MAX_ATTACHMENT_BYTES = 700 * 1024

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
