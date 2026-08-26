/**
 * Fleet Feed wire adapter — phase-2 fleetd-backed /api/fleet/* routes (see
 * fleet-channel docs/FEED_CONTRACT.md). Same pattern as hermesApi.ts /
 * instanceManager.ts: ALL endpoint knowledge lives here; the store + UI
 * consume this interface only.
 *
 * JSON rides the cluster bridge (standard #1 — the browser never talks to
 * fleetd or any 10.0.0.x address; the backend proxies). Attachment BYTES are
 * the one relative-fetch exception, because the bridge RPC is JSON-only and
 * the backend streams `/api/fleet/attachment/:id` for exactly this purpose.
 *
 * TYPES: these interfaces mirror FEED_CONTRACT.md and are TEMPORARY — swap to
 * the zod-inferred types from @gyshell/shared (fleet/contracts.ts) once
 * claude1's backend contracts land, then delete the local copies.
 */

export type FleetVisibility = 'private' | 'public'
export type FleetThreadKind = 'dm' | 'post'
export type FleetFeedScope = 'public' | 'mine' | 'all'
export type FleetAttachmentKind = 'image' | 'flowchart' | 'document'

export interface FleetThread {
  thread_id: string
  subject: string | null
  category: string | null
  visibility: FleetVisibility
  kind: FleetThreadKind
  participants: string[]
  created_at: string
  updated_at: string
  message_count: number
  last_sender?: string
  last_snippet?: string
}

export interface FleetAttachmentRef {
  attachment_id: string
  filename: string
  media_type: string
  byte_size: number
  sha256: string
  kind: FleetAttachmentKind
}

export interface FleetMessage {
  message_id: string
  thread_id: string
  seq: number
  parent_id: string | null
  sender: string
  body: string
  kind?: string // 'system' rows (visibility flips) render distinctly
  created_at: string
  attachments: FleetAttachmentRef[]
  /** Receipt lifecycle (queued→delivered→woke→acked) — rendered when present. */
  receipts?: Array<{ agent_id?: string; state: string; ts?: string }>
}

export interface FleetCategory {
  name: string
  count: number
}

/** Directory + live presence row. Shape is fleetd's; parsed defensively. */
export interface FleetAgentEntry {
  agent_id: string
  display_name?: string
  kind?: string
  online?: boolean
  status?: string
  last_heartbeat?: string
}

/**
 * The UI's sender/viewer identity on the fleet channel. 'user' matches the
 * bus-era USER_AGENT_ID; fleetd needs a canonical id for Travis (flagged to
 * claude1 in the contract review).
 */
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
    scope: FleetFeedScope
    category?: string
    kind?: FleetThreadKind
    limit?: number
    before?: string
  }): Promise<FleetThread[]> {
    const r = await get(
      `/api/fleet/feed${q({
        scope: opts.scope,
        category: opts.category,
        kind: opts.kind,
        viewer: FLEET_VIEWER,
        limit: opts.limit ?? 100,
        before: opts.before,
      })}`,
    )
    return (r?.threads ?? r ?? []) as FleetThread[]
  },

  async thread(id: string): Promise<{ thread: FleetThread; messages: FleetMessage[] }> {
    const r = await get(`/api/fleet/thread/${encodeURIComponent(id)}`)
    return { thread: r?.thread, messages: (r?.messages ?? []) as FleetMessage[] }
  },

  async createPost(input: { category: string; subject: string; body: string }): Promise<any> {
    return post('/api/fleet/post', { sender: FLEET_VIEWER, ...input })
  },

  async send(input: { to: string[]; body: string; thread_id?: string; parent_id?: string }): Promise<any> {
    return post('/api/fleet/send', { sender: FLEET_VIEWER, ...input })
  },

  async setVisibility(threadId: string, visibility: FleetVisibility): Promise<any> {
    return post(`/api/fleet/thread/${encodeURIComponent(threadId)}/visibility`, {
      actor: FLEET_VIEWER,
      visibility,
    })
  },

  async categories(): Promise<FleetCategory[]> {
    const r = await get('/api/fleet/categories')
    const raw = r?.categories ?? r ?? []
    // Tolerate ["name", ...] or [{category|name, count|thread_count}, ...].
    return (raw as any[]).map((c) =>
      typeof c === 'string'
        ? { name: c, count: 0 }
        : { name: c.name ?? c.category ?? '', count: c.count ?? c.thread_count ?? 0 },
    )
  },

  /** PUBLIC content only (structural — private threads are never indexed). */
  async search(query: string): Promise<Array<{ thread_id: string; message?: FleetMessage; snippet?: string }>> {
    const r = await get(`/api/fleet/search${q({ q: query })}`)
    return (r?.results ?? r ?? []) as Array<{ thread_id: string; message?: FleetMessage; snippet?: string }>
  },

  async agents(): Promise<FleetAgentEntry[]> {
    const r = await get('/api/fleet/agents')
    const raw = r?.agents ?? r ?? []
    return (raw as any[]).map((a) => ({
      agent_id: a.agent_id ?? a.agentId ?? a.id ?? a.name ?? '',
      display_name: a.display_name ?? a.displayName,
      kind: a.kind,
      online: a.online,
      status: a.status,
      last_heartbeat: a.last_heartbeat ?? a.lastHeartbeat,
    }))
  },

  /**
   * Attachment bytes — deliberate, explicit fetch (UI rule 3: never inline
   * unbidden). Returns an object URL for binary content or text for
   * JSON/text payloads (flowchart structured form). Caller owns revoke().
   */
  async fetchAttachment(ref: FleetAttachmentRef): Promise<{ url?: string; text?: string }> {
    const r = await fetch(`/api/fleet/attachment/${encodeURIComponent(ref.attachment_id)}`)
    if (!r.ok) throw new Error(`attachment fetch failed: HTTP ${r.status}`)
    const isText = /json|text\/|xml/.test(ref.media_type) || /json|text\/|xml/.test(r.headers.get('content-type') ?? '')
    if (isText) return { text: await r.text() }
    return { url: URL.createObjectURL(await r.blob()) }
  },
}
