/**
 * FleetFeedService — the AI-Lab backend's proxy to fleetd (the fleet message router).
 *
 * WHY A PROXY AT ALL: AI-Lab coding standard #1 — every outbound connection is made by the
 * BACKEND, never the browser. AI-Lab is reached over both the LAN IP and the Cloudflare tunnel,
 * and from the tunnel a browser cannot reach 10.0.0.x at all. So the UI calls /api/fleet/*, and
 * only this service talks to fleetd.
 *
 * Standard #6: the fleetd URL is env-derived with an override, never hardcoded.
 * Standard #5: presence is whatever fleetd reports at read time — we never cache an `online` flag.
 */

export type FleetFeedConfig = { baseUrl?: string; timeoutMs?: number }

export class FleetFeedError extends Error {
  constructor(message: string, readonly status: number, readonly stage?: string) {
    super(message)
  }
}

export class FleetFeedService {
  private readonly base: string
  private readonly timeoutMs: number

  constructor(cfg: FleetFeedConfig = {}) {
    // env first, then explicit config, then a derived default — see standard #6.
    // fleetd moved into this container on 2026-08-27 — it used to live in claude1's own
    // container, which made one agent's box a dependency for the whole fleet's messaging.
    const host = process.env.FLEETD_HOST ?? '127.0.0.1'
    const port = process.env.FLEETD_PORT ?? '17900'
    this.base = (process.env.FLEETD_URL ?? cfg.baseUrl ?? `http://${host}:${port}`).replace(/\/+$/, '')
    this.timeoutMs = cfg.timeoutMs ?? 20000
  }

  get endpoint(): string { return this.base }

  /** Raw call. Surfaces fleetd's own status + stage rather than flattening everything to 500 —
   *  a validation refusal ("you are not a participant") must not look like a server fault. */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      // Name the stage: "fleet is broken" is not actionable, "cannot reach fleetd" is.
      throw new FleetFeedError(
        `cannot reach fleetd at ${this.base}: ${(e as Error).message}`, 503, 'transport')
    }
    const text = await res.text()
    let data: any = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
    if (!res.ok) {
      throw new FleetFeedError(data.error ?? data.detail ?? `fleetd HTTP ${res.status}`,
                               res.status, data.stage)
    }
    return data as T
  }

  async health(): Promise<boolean> {
    try { await this.call('GET', '/health'); return true } catch { return false }
  }

  // ── feed / threads ────────────────────────────────────────────────────────
  /** `cursor` is OPAQUE — round-trip `next_cursor`, never construct one. A bare timestamp
   *  cursor duplicated or skipped threads whose updated_at tied. */
  listFeed(q: { viewer?: string; scope?: string; category?: string; kind?: string;
                limit?: number; before?: number; cursor?: string; unread?: boolean } = {}) {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === '') continue
      p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
    }
    return this.call<{ threads: unknown[]; has_more: boolean; next_cursor: string | null }>(
      'GET', `/feed?${p}`)
  }

  /** Paging here is a TAIL window: omit `limit` for the whole thread, or pass limit and walk
   *  `before_seq` backwards. Receipts ride along by default — losing them would be a silent
   *  downgrade from the delivery observability the old ConversationBus tab had. */
  readThread(threadId: string, opts: { limit?: number; before_seq?: number; receipts?: boolean;
                                       viewer?: string } = {}) {
    const p = new URLSearchParams()
    // fleetd is FAIL-CLOSED on private threads: reading one requires naming a viewer who
    // participates. The UI acts as the canonical 'user' identity, so it sees public threads
    // plus the ones Travis is actually in — deliberately NOT everything. There is no operator
    // override anywhere in this system, and adding one here would be exactly that.
    p.set('viewer', opts.viewer ?? 'user')
    if (opts.limit) p.set('limit', String(opts.limit))
    if (opts.before_seq !== undefined) p.set('before_seq', String(opts.before_seq))
    if (opts.receipts === false) p.set('receipts', '0')
    const qs = p.toString()
    return this.call<{ thread: unknown; messages: unknown[]; has_more: boolean;
                       before_seq: number | null }>(
      'GET', `/thread/${encodeURIComponent(threadId)}${qs ? `?${qs}` : ''}`)
  }

  /** Watermark, not a boolean — replaying "read up to 12" can never lose a later 15. */
  markRead(threadId: string, viewer: string, upToSeq: number) {
    return this.call<{ thread_id: string; viewer: string; up_to_seq: number }>(
      'POST', `/thread/${encodeURIComponent(threadId)}/read`, { viewer, up_to_seq: upToSeq })
  }

  unread(viewer: string) {
    return this.call<{ unread: unknown[] }>('GET', `/unread?viewer=${encodeURIComponent(viewer)}`)
  }

  /**
   * Kill switch for FLEETD DELIVERY. DB-backed in fleetd, so a restart cannot silently un-flip
   * it and leave you believing traffic was stopped.
   *
   * 🛑 SCOPE: this does NOT stop everything. ConversationBus runs a SEPARATE autonomous path
   * (HermesBusSubscriber: Hermes agents auto-replying to each other) which never touches fleetd
   * and is governed by its own `autonomousRoutingEnabled` flag at /api/fleet/status + /guard.
   * Two switches, two paths. Flipping this one off while believing it stopped all agent traffic
   * is precisely the "a control that lies" failure this guard exists to prevent, so the limit is
   * documented here rather than discovered later.
   */
  getGuard() {
    return this.call<{ enabled: boolean; reason: string | null; updated_by: string | null;
                       updated_at: number | null }>('GET', '/guard')
  }

  setGuard(enabled: boolean, actor: string, reason?: string) {
    return this.call('POST', '/guard', { enabled, actor, reason })
  }

  post(body: { sender: string; category: string; subject?: string; body: string;
               visibility?: string; attachments?: unknown[] }) {
    return this.call('POST', '/post', body)
  }

  /** `attachments` ride WITH the send: recipients wake on send, so attaching afterwards
   *  races the wake and a reader can find the message with nothing on it. */
  send(body: { sender: string; to: string[]; body: string; thread_id?: string;
               parent_id?: string; kind?: string; reason?: string; session?: string;
               attachments?: unknown[] }) {
    return this.call('POST', '/send', body)
  }

  setVisibility(threadId: string, actor: string, visibility: 'private' | 'public') {
    return this.call('POST', `/thread/${encodeURIComponent(threadId)}/visibility`,
                     { actor, visibility })
  }

  /** Counts are VIEWER-SCOPED — an unscoped count discloses how many private threads exist in
   *  a category to someone who cannot open any of them. */
  categories(viewer?: string) {
    const p = new URLSearchParams()
    p.set('viewer', viewer ?? 'user')
    return this.call<{ categories: unknown[] }>('GET', `/categories?${p}`)
  }

  /** PUBLIC content only — enforced by fleetd's query, and there is deliberately no parameter
   *  here that could widen it. */
  search(q: string, opts: { limit?: number; category?: string;
                            mode?: 'literal' | 'semantic' | 'hybrid' } = {}) {
    const p = new URLSearchParams({ q })
    if (opts.limit) p.set('limit', String(opts.limit))
    if (opts.category) p.set('category', opts.category)
    if (opts.mode) p.set('mode', opts.mode)
    return this.call<{ results: unknown[]; mode?: string }>('GET', `/search?${p}`)
  }

  /** Build the semantic index over public content. Safe to call repeatedly — it only embeds
   *  what is missing or stale, and prunes vectors whose thread is no longer public. */
  reindex(limit?: number) {
    return this.call<{ indexed: number; already_current: number; model: string; pruned: number }>(
      'POST', '/reindex', limit ? { limit } : {})
  }

  /** Live presence — standard #5: computed by fleetd at read time, never a cached boolean. */
  directory() { return this.call<{ agents: unknown[] }>('GET', '/directory') }

  // ── attachments ───────────────────────────────────────────────────────────
  addAttachment(a: { message_id: string; filename: string; media_type: string;
                     content_b64: string; kind?: string; structured?: unknown }) {
    return this.call('POST', '/attachment', a)
  }

  /** A flowchart is useless to another agent as pixels; this returns its structured graph. */
  getStructured(id: string) {
    return this.call<{ attachment_id: string; kind: string; structured: unknown }>(
      'GET', `/attachment/${encodeURIComponent(id)}?format=json`)
  }

  /** Streams bytes back to the caller. The UI never fetches an attachment from fleetd directly;
   *  images in particular are refs until someone deliberately asks for them. */
  async getAttachment(id: string): Promise<{ body: Buffer; mediaType: string; kind: string }> {
    let res: Response
    try {
      res = await fetch(`${this.base}/attachment/${encodeURIComponent(id)}`,
                        { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (e) {
      throw new FleetFeedError(`cannot reach fleetd at ${this.base}: ${(e as Error).message}`,
                               503, 'transport')
    }
    if (!res.ok) {
      const t = await res.text()
      throw new FleetFeedError(t || `fleetd HTTP ${res.status}`, res.status, 'attachment')
    }
    return {
      body: Buffer.from(await res.arrayBuffer()),
      mediaType: res.headers.get('Content-Type') ?? 'application/octet-stream',
      kind: res.headers.get('X-Fleet-Attachment-Kind') ?? 'document',
    }
  }
}
