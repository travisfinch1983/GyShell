import { makeAutoObservable, runInAction } from 'mobx'
import {
  feedSecondsToDate,
  fleetFeedApi,
  type FeedAttachmentInput,
  type FeedCategory,
  type FeedDirectoryEntry,
  type FeedGuard,
  type FeedList,
  type FeedMessage,
  type FeedScope,
  type FeedSearchHit,
  type FeedThread,
  type FeedThreadKind,
  type FeedVisibility,
} from './fleetFeedApi'

// claude1's call (contract review item 2): polling stays for now, but cheap —
// cursor + unread ride the feed request; revisit SSE once the tab's shape settles.
/** One sidebar entry per exact participant set, its threads newest-first. */
export interface FeedThreadGroup {
  key: string
  participants: string[]
  threads: FeedThread[]
  latest: FeedThread
  unread: number
}

const FEED_POLL_MS = 20_000
const THREAD_POLL_MS = 10_000
const THREAD_PAGE = 80

/** Presence is heartbeat age at read time (standard #5) — never a stored boolean. */
const PRESENCE_FRESH_MS = 120_000

/**
 * Renderer store for the phase-2 Fleet Feed: a bulletin board of threads
 * (DMs + category posts) served by the AI-Lab backend's fleetd-backed
 * /api/fleet/* v2 routes (threads/message/directory — the old ConversationBus
 * router still owns feed/send/agents and is mounted first).
 */
class FleetStore {
  threads: FeedThread[] = []
  feedHasMore = false
  private feedCursor: string | null = null

  categories: FeedCategory[] = []
  agents: FeedDirectoryEntry[] = []
  guard: FeedGuard | null = null

  scope: FeedScope = 'all'
  kindFilter: 'all' | FeedThreadKind = 'all'
  categoryFilter: string | null = null

  searchQuery = ''
  searchResults: FeedSearchHit[] | null = null
  searching = false

  selectedThreadId: string | null = null
  thread: FeedThread | null = null
  messages: FeedMessage[] = []
  threadHasMore = false
  threadBeforeSeq: number | null = null
  threadLoading = false
  loadingOlder = false

  loaded = false
  available = true
  /** Last feed/thread error — rendered in-page, cleared on next success. */
  error: string | null = null

  private feedTimer: ReturnType<typeof setInterval> | null = null
  private threadTimer: ReturnType<typeof setInterval> | null = null
  private loading: Promise<void> | null = null

  constructor() {
    makeAutoObservable(this)
  }

  get visibleThreads(): FeedThread[] {
    // scope/kind/category are server-side filters; this is just the local echo
    // so a filter change repaints instantly while the refetch is in flight.
    return this.threads.filter(
      (t) =>
        (this.kindFilter === 'all' || t.kind === this.kindFilter) &&
        (this.categoryFilter === null || t.category === this.categoryFilter),
    )
  }

  /**
   * Sidebar grouping (Travis): ONE entry per exact participant SET — a
   * three-way focused-broadcast thread is its own group, never collapsed into
   * either pair. Grouping runs over the ACCUMULATED thread list, not per page,
   * so cursor paging can never split a group into two rendered entries; and
   * because the feed arrives newest-first, every group's newest thread is
   * always loaded, so group ordering (max updated_at desc) stays correct
   * mid-pagination.
   */
  get groupedThreads(): FeedThreadGroup[] {
    const map = new Map<string, FeedThread[]>()
    for (const t of this.visibleThreads) {
      const key = [...t.participants].sort().join('|') || '(unaddressed)'
      const list = map.get(key)
      if (list) list.push(t)
      else map.set(key, [t])
    }
    const groups: FeedThreadGroup[] = []
    for (const [key, threads] of map) {
      threads.sort((a, b) => b.updated_at - a.updated_at)
      groups.push({
        key,
        participants: [...threads[0].participants].sort(),
        threads,
        latest: threads[0],
        unread: threads.reduce((n, t) => n + this.unreadOf(t), 0),
      })
    }
    groups.sort((a, b) => b.latest.updated_at - a.latest.updated_at)
    return groups
  }

  unreadOf(t: FeedThread): number {
    return t.unread_count ?? 0
  }

  get unreadTotal(): number {
    return this.threads.reduce((n, t) => n + this.unreadOf(t), 0)
  }

  displayName(agentId: string): string {
    return this.agents.find((a) => a.agent_id === agentId)?.display_name || agentId
  }

  isOnline(a: FeedDirectoryEntry): boolean {
    if (a.status === 'idle' || a.status === 'busy' || a.status === 'thinking') return true
    if (a.presence_at === null) return false
    return Date.now() - feedSecondsToDate(a.presence_at).getTime() < PRESENCE_FRESH_MS
  }

  /** Whether the UI viewer may flip visibility (participant-only rule — no operator override, by design). */
  get viewerIsParticipant(): boolean {
    return this.thread?.participants.includes('user') ?? false
  }

  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (!this.loading) {
      this.loading = (async () => {
        if (!fleetFeedApi.available()) {
          runInAction(() => {
            this.available = false
            this.loaded = true
          })
          return
        }
        await this.refreshFeed()
        await Promise.all([this.refreshCategories(), this.refreshDirectory(), this.refreshGuard()])
        runInAction(() => {
          this.loaded = true
        })
        this.feedTimer = setInterval(() => {
          if (document.hidden) return // hidden tab: don't burn polls (claude1's old-store fix, carried over)
          void this.refreshFeed()
          void this.refreshDirectory()
          void this.refreshGuard()
        }, FEED_POLL_MS)
      })()
    }
    return this.loading
  }

  dispose(): void {
    if (this.feedTimer) clearInterval(this.feedTimer)
    this.feedTimer = null
    this.stopThreadPoll()
  }

  async refreshFeed(): Promise<void> {
    try {
      const list: FeedList = await fleetFeedApi.feed({
        scope: this.scope,
        kind: this.kindFilter === 'all' ? undefined : this.kindFilter,
        category: this.categoryFilter ?? undefined,
      })
      runInAction(() => {
        this.threads = list.threads
        this.feedHasMore = list.has_more
        this.feedCursor = list.next_cursor
        this.error = null
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  /** Page older threads onto the end of the list (opaque cursor round-trip). */
  async loadMoreThreads(): Promise<void> {
    if (!this.feedHasMore || !this.feedCursor) return
    const cursor = this.feedCursor
    try {
      const list: FeedList = await fleetFeedApi.feed({
        scope: this.scope,
        kind: this.kindFilter === 'all' ? undefined : this.kindFilter,
        category: this.categoryFilter ?? undefined,
        cursor,
      })
      runInAction(() => {
        const known = new Set(this.threads.map((t) => t.thread_id))
        this.threads.push(...list.threads.filter((t) => !known.has(t.thread_id)))
        this.feedHasMore = list.has_more
        this.feedCursor = list.next_cursor
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  async refreshCategories(): Promise<void> {
    try {
      const categories = await fleetFeedApi.categories()
      runInAction(() => {
        this.categories = categories
      })
    } catch {
      /* transient — categories are decorative until next poll */
    }
  }

  async refreshDirectory(): Promise<void> {
    try {
      const agents = await fleetFeedApi.directory()
      runInAction(() => {
        this.agents = agents
      })
    } catch {
      /* transient */
    }
  }

  async refreshGuard(): Promise<void> {
    try {
      const guard = await fleetFeedApi.guard()
      runInAction(() => {
        this.guard = guard
      })
    } catch {
      /* transient — header control greys out via guard===null */
    }
  }

  /** Delivery kill switch (fleetd, DB-backed — survives restarts on purpose). */
  async setGuard(enabled: boolean, reason?: string): Promise<void> {
    const guard = await fleetFeedApi.setGuard(enabled, reason)
    runInAction(() => {
      this.guard = guard
    })
  }

  setScope(scope: FeedScope): void {
    this.scope = scope
    void this.refreshFeed()
  }

  setKindFilter(kind: 'all' | FeedThreadKind): void {
    this.kindFilter = kind
    void this.refreshFeed()
  }

  setCategoryFilter(category: string | null): void {
    this.categoryFilter = category
    void this.refreshFeed()
  }

  async openThread(threadId: string): Promise<void> {
    this.selectedThreadId = threadId
    this.threadLoading = true
    this.stopThreadPoll()
    await this.refreshThread()
    runInAction(() => {
      this.threadLoading = false
    })
    this.threadTimer = setInterval(() => {
      if (!document.hidden) void this.refreshThread()
    }, THREAD_POLL_MS)
  }

  closeThread(): void {
    this.selectedThreadId = null
    this.thread = null
    this.messages = []
    this.threadHasMore = false
    this.threadBeforeSeq = null
    this.stopThreadPoll()
  }

  private stopThreadPoll(): void {
    if (this.threadTimer) clearInterval(this.threadTimer)
    this.threadTimer = null
  }

  private async refreshThread(): Promise<void> {
    const id = this.selectedThreadId
    if (!id) return
    try {
      const r = await fleetFeedApi.thread(id, { limit: THREAD_PAGE })
      runInAction(() => {
        // Ignore a late response for a thread we've since navigated away from.
        if (this.selectedThreadId !== id) return
        this.thread = r.thread
        // Keep any older pages the user already scrolled back to.
        const oldestLoaded = this.messages[0]?.seq
        const older =
          oldestLoaded !== undefined && this.messages[0].thread_id === id
            ? this.messages.filter((m) => m.seq < (r.messages[0]?.seq ?? Infinity))
            : []
        this.messages = [...older, ...r.messages]
        if (older.length === 0) {
          this.threadHasMore = r.has_more
          this.threadBeforeSeq = r.before_seq
        }
        this.error = null
      })
      const maxSeq = r.messages[r.messages.length - 1]?.seq
      if (maxSeq !== undefined) await this.markRead(id, maxSeq)
    } catch (e) {
      runInAction(() => {
        if (this.selectedThreadId === id) this.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  /** Scrollback: prepend the previous window (ascending seq preserved). */
  async loadOlderMessages(): Promise<void> {
    const id = this.selectedThreadId
    if (!id || !this.threadHasMore || this.threadBeforeSeq === null || this.loadingOlder) return
    this.loadingOlder = true
    try {
      const r = await fleetFeedApi.thread(id, { limit: THREAD_PAGE, before_seq: this.threadBeforeSeq })
      runInAction(() => {
        if (this.selectedThreadId !== id) return
        const known = new Set(this.messages.map((m) => m.message_id))
        this.messages = [...r.messages.filter((m) => !known.has(m.message_id)), ...this.messages]
        this.threadHasMore = r.has_more
        this.threadBeforeSeq = r.before_seq
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.loadingOlder = false
      })
    }
  }

  private async markRead(threadId: string, upToSeq: number): Promise<void> {
    try {
      await fleetFeedApi.markRead(threadId, upToSeq)
      runInAction(() => {
        const row = this.threads.find((t) => t.thread_id === threadId)
        if (row) row.unread_count = 0
      })
    } catch {
      /* non-fatal — the dot survives one more poll */
    }
  }

  async sendReply(body: string, parentId?: string, attachments?: FeedAttachmentInput[]): Promise<void> {
    const t = this.thread
    if (!t || !body.trim()) return
    // thread_id present → to[] is ignored server-side; participants rule.
    await fleetFeedApi.send({
      to: [],
      body: body.trim(),
      thread_id: t.thread_id,
      parent_id: parentId,
      attachments: attachments?.length ? attachments : undefined,
    })
    await this.refreshThread()
    void this.refreshFeed()
  }

  async createPost(input: {
    category?: string
    subject: string
    body: string
    visibility?: FeedVisibility
    attachments?: FeedAttachmentInput[]
  }): Promise<void> {
    const r = await fleetFeedApi.createPost(input)
    await this.refreshFeed()
    void this.refreshCategories()
    const id = r?.thread_id ?? r?.thread?.thread_id
    if (id) await this.openThread(id)
  }

  async createDm(to: string[], body: string, attachments?: FeedAttachmentInput[]): Promise<void> {
    const r = await fleetFeedApi.send({ to, body, attachments: attachments?.length ? attachments : undefined })
    await this.refreshFeed()
    const id = r?.thread_id ?? r?.thread?.thread_id
    if (id) await this.openThread(id)
  }

  /** Slash-command compat (/dm, /broadcast): fire-and-forget DM by agent id. */
  async send(to: string, body: string): Promise<void> {
    if (!body.trim()) return
    await fleetFeedApi.send({ to: [to], body: body.trim() })
    void this.refreshFeed()
  }

  async setVisibility(visibility: FeedVisibility): Promise<void> {
    const t = this.thread
    if (!t) return
    await fleetFeedApi.setVisibility(t.thread_id, visibility)
    await this.refreshThread()
    void this.refreshFeed()
  }

  async runSearch(query: string): Promise<void> {
    this.searchQuery = query
    if (!query.trim()) {
      this.searchResults = null
      return
    }
    this.searching = true
    try {
      const results = await fleetFeedApi.search(query.trim())
      runInAction(() => {
        // Ignore a stale response after the query moved on.
        if (this.searchQuery === query) this.searchResults = results
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.searching = false
      })
    }
  }

  clearSearch(): void {
    this.searchQuery = ''
    this.searchResults = null
  }
}

export const fleetStore = new FleetStore()
