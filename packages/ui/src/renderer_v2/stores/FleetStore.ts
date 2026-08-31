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
  type FleetWakeStats,
} from './fleetFeedApi'

/** What a directory chip may claim about an agent's wake reliability. */
export type WakeHealth =
  | { state: 'latched'; stage: string }
  | { state: 'flaky'; ok: number; total: number }
  | { state: 'clean'; ok: number; total: number }

/**
 * Wake health for one agent, or NULL when nothing may be claimed.
 *
 * Null when there are no stats at all AND when the agent is absent from them —
 * fleetd omits agents with no traffic in the window, and "no evidence" must
 * render as nothing, never as a passing check (cannot-check ≠ healthy).
 * `latched` (a live, sustained alarm) takes precedence over counters: it is
 * the panel STATE; the ratio is context. Ratios, not totals — 11/56 says
 * something 11 alone does not.
 */
export function wakeHealthFor(stats: FleetWakeStats | null, agentId: string): WakeHealth | null {
  if (!stats) return null
  const latchedStage = stats.latched?.[agentId]
  if (latchedStage) return { state: 'latched', stage: latchedStage }
  const a = stats.agents?.[agentId]
  if (!a) return null
  const failed = (a.wake_timeout ?? 0) + (a.wake_stalled ?? 0)
  const total = (a.woke ?? 0) + failed
  if (total === 0) return null
  return failed > 0 ? { state: 'flaky', ok: a.woke, total } : { state: 'clean', ok: a.woke, total }
}

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
const EXPANDED_KEY = 'fleet-feed-expanded-groups'

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
  wakeStats: FleetWakeStats | null = null

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
  /** Quiet one-line note (muted, not an error) — e.g. a thread deleted under the tab. */
  notice: string | null = null

  /**
   * Sidebar expansion state (Travis): every group defaults COLLAPSED, and what
   * he sets persists in both directions — stored state wins, the default only
   * applies to a group never touched. Nothing auto-expands: a stable sidebar
   * that never re-opens what he closed beats saving a click.
   */
  expandedGroups = new Set<string>()

  private feedTimer: ReturnType<typeof setInterval> | null = null
  private threadTimer: ReturnType<typeof setInterval> | null = null
  private loading: Promise<void> | null = null

  constructor() {
    makeAutoObservable(this)
    try {
      const raw = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]')
      if (Array.isArray(raw)) this.expandedGroups = new Set(raw.filter((k) => typeof k === 'string'))
    } catch {
      /* corrupted state — everything simply starts collapsed */
    }
  }

  isExpanded(key: string): boolean {
    return this.expandedGroups.has(key)
  }

  toggleGroup(key: string): void {
    if (this.expandedGroups.has(key)) this.expandedGroups.delete(key)
    else this.expandedGroups.add(key)
    this.persistExpanded()
  }

  private persistExpanded(): void {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...this.expandedGroups]))
    } catch {
      /* private mode etc. — expansion just won't survive reload */
    }
  }

  /**
   * Keys for groups that no longer exist must not accumulate forever — but
   * prune only when the feed is COMPLETE: with more pages unloaded, a stored
   * key may belong to a group further down, and dropping it would silently
   * discard the user's choice.
   */
  private pruneExpanded(): void {
    if (this.feedHasMore) return
    const live = new Set(this.groupedThreads.map((g) => g.key))
    const keep = [...this.expandedGroups].filter((k) => live.has(k))
    if (keep.length !== this.expandedGroups.size) {
      this.expandedGroups = new Set(keep)
      this.persistExpanded()
    }
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
        this.pruneExpanded()
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
    // Separate try: wake stats failing must not take the directory down with it.
    // A failed fetch KEEPS the previous stats (stale beats a silent all-clear);
    // the chips make no claim for agents absent from the data either way.
    try {
      const ws = await fleetFeedApi.wakeStats()
      runInAction(() => {
        if (ws) this.wakeStats = ws
      })
    } catch {
      /* transient — previous stats stand */
    }
  }

  /** Wake health for one agent chip — see wakeHealthFor. */
  wakeHealth(agentId: string): WakeHealth | null {
    return wakeHealthFor(this.wakeStats, agentId)
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

  clearNotice(): void {
    this.notice = null
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
    this.notice = null
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

  /**
   * A thread disappearing underneath the tab is a normal outcome (someone
   * deleted it), not a fault: drop it, clear the selection, quiet note —
   * never an INTERNAL_ERROR banner. Detection rides the "HTTP 404 — …"
   * prefix ClusterService now stamps on request errors, so this never
   * string-matches fleetd's wording.
   */
  private handleThreadGone(id: string): void {
    this.threads = this.threads.filter((t) => t.thread_id !== id)
    if (this.selectedThreadId === id) {
      this.closeThread()
      this.notice = 'That conversation no longer exists — removed from the list.'
    }
  }

  private static isGone(e: unknown): boolean {
    return e instanceof Error && /^HTTP 404\b/.test(e.message)
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
        if (FleetStore.isGone(e)) this.handleThreadGone(id)
        else if (this.selectedThreadId === id) this.error = e instanceof Error ? e.message : String(e)
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
        if (FleetStore.isGone(e)) this.handleThreadGone(id)
        else this.error = e instanceof Error ? e.message : String(e)
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
