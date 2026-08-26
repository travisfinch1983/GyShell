import { makeAutoObservable, runInAction } from 'mobx'
import {
  FLEET_VIEWER,
  fleetFeedApi,
  type FleetAgentEntry,
  type FleetCategory,
  type FleetFeedScope,
  type FleetMessage,
  type FleetThread,
  type FleetThreadKind,
  type FleetVisibility,
} from './fleetFeedApi'

const FEED_POLL_MS = 15_000
const THREAD_POLL_MS = 6_000
const LAST_SEEN_KEY = 'fleet-feed-last-seen'

/**
 * Renderer store for the phase-2 Fleet Feed: a bulletin board of threads
 * (DMs + category posts) served by the AI-Lab backend's fleetd-backed
 * /api/fleet/* routes. Replaces the ConversationBus live-tail store.
 *
 * No push transport exists in the phase-2 contract (flagged to claude1), so
 * the store polls: feed while the tab is mounted, the open thread faster.
 * Unread state is client-side (localStorage updated_at watermarks) until the
 * backend grows a read-mark story.
 */
class FleetStore {
  threads: FleetThread[] = []
  categories: FleetCategory[] = []
  agents: FleetAgentEntry[] = []

  scope: FleetFeedScope = 'all'
  kindFilter: 'all' | FleetThreadKind = 'all'
  categoryFilter: string | null = null

  searchQuery = ''
  searchResults: Array<{ thread_id: string; message?: FleetMessage; snippet?: string }> | null = null
  searching = false

  selectedThreadId: string | null = null
  thread: FleetThread | null = null
  messages: FleetMessage[] = []
  threadLoading = false

  loaded = false
  available = true
  /** Last feed/thread error — rendered in-page, cleared on next success. */
  error: string | null = null

  private lastSeen: Record<string, string> = {}
  private feedTimer: ReturnType<typeof setInterval> | null = null
  private threadTimer: ReturnType<typeof setInterval> | null = null
  private loading: Promise<void> | null = null

  constructor() {
    makeAutoObservable(this)
    try {
      this.lastSeen = JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? '{}')
    } catch {
      this.lastSeen = {}
    }
  }

  get visibleThreads(): FleetThread[] {
    return this.threads.filter(
      (t) =>
        (this.kindFilter === 'all' || t.kind === this.kindFilter) &&
        (this.categoryFilter === null || t.category === this.categoryFilter),
    )
  }

  isUnread(t: FleetThread): boolean {
    const seen = this.lastSeen[t.thread_id]
    return !seen || t.updated_at > seen
  }

  get unreadCount(): number {
    return this.threads.reduce((n, t) => n + (this.isUnread(t) ? 1 : 0), 0)
  }

  /** Whether the UI viewer may flip visibility (participant-only rule). */
  get viewerIsParticipant(): boolean {
    return this.thread?.participants.includes(FLEET_VIEWER) ?? false
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
        await Promise.all([this.refreshCategories(), this.refreshAgents()])
        runInAction(() => {
          this.loaded = true
        })
        this.feedTimer = setInterval(() => {
          void this.refreshFeed()
          void this.refreshAgents()
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
      const threads = await fleetFeedApi.feed({
        scope: this.scope,
        kind: this.kindFilter === 'all' ? undefined : this.kindFilter,
        category: this.categoryFilter ?? undefined,
      })
      runInAction(() => {
        this.threads = threads
        this.error = null
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

  async refreshAgents(): Promise<void> {
    try {
      const agents = await fleetFeedApi.agents()
      runInAction(() => {
        this.agents = agents
      })
    } catch {
      /* transient */
    }
  }

  setScope(scope: FleetFeedScope): void {
    this.scope = scope
    void this.refreshFeed()
  }

  setKindFilter(kind: 'all' | FleetThreadKind): void {
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
    this.threadTimer = setInterval(() => void this.refreshThread(), THREAD_POLL_MS)
  }

  closeThread(): void {
    this.selectedThreadId = null
    this.thread = null
    this.messages = []
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
      const { thread, messages } = await fleetFeedApi.thread(id)
      runInAction(() => {
        // Ignore a late response for a thread we've since navigated away from.
        if (this.selectedThreadId !== id) return
        this.thread = thread
        this.messages = messages
        this.error = null
        if (thread) this.markSeen(thread)
      })
    } catch (e) {
      runInAction(() => {
        if (this.selectedThreadId === id) this.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  private markSeen(t: FleetThread): void {
    if (this.lastSeen[t.thread_id] === t.updated_at) return
    this.lastSeen[t.thread_id] = t.updated_at
    try {
      localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(this.lastSeen))
    } catch {
      /* private mode etc. — unread dots just stay */
    }
  }

  async sendReply(body: string, parentId?: string): Promise<void> {
    const t = this.thread
    if (!t || !body.trim()) return
    await fleetFeedApi.send({
      // Address the other participants; thread_id keeps it in-thread either way.
      to: t.participants.filter((p) => p !== FLEET_VIEWER),
      body: body.trim(),
      thread_id: t.thread_id,
      parent_id: parentId,
    })
    await this.refreshThread()
    void this.refreshFeed()
  }

  async createPost(input: { category: string; subject: string; body: string }): Promise<void> {
    const r = await fleetFeedApi.createPost(input)
    await this.refreshFeed()
    void this.refreshCategories()
    const id = r?.thread_id ?? r?.thread?.thread_id
    if (id) await this.openThread(id)
  }

  async createDm(to: string[], body: string): Promise<void> {
    const r = await fleetFeedApi.send({ to, body })
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

  async setVisibility(visibility: FleetVisibility): Promise<void> {
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
