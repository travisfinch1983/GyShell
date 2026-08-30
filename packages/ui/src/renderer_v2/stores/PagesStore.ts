import { makeAutoObservable, runInAction } from 'mobx'
import {
  pageListResponseSchema,
  pageReadResponseSchema,
  type JournalEntry,
  type PageContentType,
  type PageListEntry,
  type PageReadResponse,
  type ReportMeta,
  type ReportType,
} from '@gyshell/shared'

function bridge(): { request: (method: string, path: string, body?: unknown) => Promise<any> } | undefined {
  return (window as any).gyshell?.cluster
}

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const b = bridge()
  if (!b) throw new Error('cluster bridge unavailable')
  return b.request(method, path, body)
}

/**
 * Pages tab store — versioned documents from /api/pages/*. Responses are
 * zod-parsed live (the fleet-contract pattern) so a backend shape drift
 * surfaces as a loud error instead of quietly-wrong rendering.
 */
class PagesStore {
  pages: PageListEntry[] = []
  selectedId: string | null = null
  current: PageReadResponse | null = null
  /** Version being viewed; null = latest. */
  viewVersion: number | null = null
  loading = false
  loaded = false
  available = true
  error: string | null = null

  /** Documents | Reports — the tab's two sub-surfaces. */
  view: 'documents' | 'reports' | 'journal' = 'documents'
  /** Reports are their OWN surface (/api/reports), not pages with a flag. */
  reportTypes: ReportType[] = []
  reportList: Array<ReportMeta & { versionCount: number }> = []
  typeFilter: string | null = null
  currentReport: { meta: ReportMeta; version: number; html: string; source: string } | null = null
  journal: JournalEntry[] = []
  searchQuery = ''
  searchResults: Array<{ category: string; pageId?: string; score?: number; text?: string; error?: string }> | null = null
  searching = false

  constructor() {
    makeAutoObservable(this)
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!bridge()) {
      this.available = false
      this.loaded = true
      return
    }
    await this.refresh()
    await this.loadReportTypes()
    runInAction(() => {
      this.loaded = true
    })
  }

  /** Pages are scoping documents only now — reports moved to their own store. */
  get documents(): PageListEntry[] {
    return this.pages
  }

  get reports(): Array<ReportMeta & { versionCount: number }> {
    return this.reportList.filter((r) => !this.typeFilter || r.type === this.typeFilter)
  }

  /**
   * Entry the journal body should scroll to and highlight — the per-entry
   * anchor. Set via openJournalEntry(), cleared by the panel once the flash
   * has played. Deliberately NOT a per-entry page: the continuous body is the
   * thing that made the journal readable, so an anchor brings you TO an entry
   * within it rather than isolating the entry from its neighbours.
   */
  anchorEntryId: string | null = null
  /** An id that was asked for but is not in the journal — surfaced, not swallowed. */
  anchorMissing: string | null = null

  setView(view: 'documents' | 'reports' | 'journal'): void {
    this.view = view
    if (view === 'journal') void this.loadJournal()
    // Reports also load the journal: the open-report view shows which journal
    // entries cite it, and those backlinks need the entries to exist locally.
    if (view === 'reports') { void this.loadReports(); void this.loadJournal() }
  }

  /**
   * Jump to one journal entry: switch to the Journal view, make sure the log
   * is loaded, then hand the id to the panel to scroll-and-highlight.
   *
   * This is THE consumer entry point for anything holding a citable id — a
   * report's "cited in journal" chip, a pasted id from a work order, a future
   * notification naming the entry it came from. The first real citation
   * (a work order referencing j-mtg5p44o-ti2s) arrived the same day the
   * continuous body shipped, which is why this exists.
   */
  async openJournalEntry(id: string): Promise<void> {
    const target = id.trim()
    if (!target) return
    this.view = 'journal'
    this.anchorMissing = null
    this.anchorEntryId = null
    await this.loadJournal()
    runInAction(() => {
      if (this.journal.some((e) => e.id === target)) {
        this.anchorEntryId = target
      } else {
        // An id that resolves to nothing must say so — a jump that silently
        // lands at the top of the log reads as "it scrolled somewhere",
        // which is worse than an honest miss.
        this.anchorMissing = target
      }
    })
  }

  clearJournalAnchor(): void {
    this.anchorEntryId = null
  }

  dismissAnchorMiss(): void {
    this.anchorMissing = null
  }

  /** Journal entries citing a report — the report→dismissal backlink. */
  entriesCiting(reportId: string): JournalEntry[] {
    return this.journal.filter((e) => e.reportIds?.includes(reportId))
  }

  setTypeFilter(id: string | null): void {
    this.typeFilter = id
    void this.loadReports()
  }

  typeLabel(id?: string): string {
    if (!id) return ''
    return this.reportTypes.find((t) => t.id === id)?.label ?? id
  }

  async loadReportTypes(): Promise<void> {
    try {
      const r = await req('GET', '/api/reports/types')
      runInAction(() => { this.reportTypes = r?.types ?? [] })
    } catch { /* decorative until the next load */ }
  }

  async loadReports(): Promise<void> {
    try {
      const r = await req('GET', `/api/reports${this.typeFilter ? `?type=${encodeURIComponent(this.typeFilter)}` : ''}`)
      runInAction(() => { this.reportList = r?.reports ?? [] })
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    }
  }

  async openReport(id: string, version?: number): Promise<void> {
    this.loading = true
    try {
      const r = await req('GET', `/api/reports/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`)
      runInAction(() => { this.currentReport = r; this.current = null; this.selectedId = id })
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  async loadJournal(): Promise<void> {
    try {
      const r = await req('GET', '/api/journal')
      runInAction(() => { this.journal = r?.entries ?? [] })
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    }
  }

  async searchReports(query: string): Promise<void> {
    this.searchQuery = query
    if (!query.trim()) { this.searchResults = null; return }
    this.searching = true
    try {
      const r = await req('GET', `/api/reports-search?q=${encodeURIComponent(query)}${this.typeFilter ? `&type=${encodeURIComponent(this.typeFilter)}` : ''}`)
      const flat: Array<{ category: string; pageId?: string; score?: number; text?: string; error?: string }> = []
      for (const c of r?.collections ?? []) {
        if (c.error) { flat.push({ category: c.type, error: c.error }); continue }
        for (const hit of c.results ?? []) {
          flat.push({ category: c.type, pageId: hit.doc_id, score: hit.score, text: hit.text })
        }
      }
      runInAction(() => { if (this.searchQuery === query) this.searchResults = flat })
    } catch (e) {
      runInAction(() => { this.error = e instanceof Error ? e.message : String(e) })
    } finally {
      runInAction(() => { this.searching = false })
    }
  }

  clearSearch(): void {
    this.searchQuery = ''
    this.searchResults = null
  }

  async refresh(): Promise<void> {
    try {
      const raw = await req('GET', '/api/pages')
      const parsed = pageListResponseSchema.parse(raw)
      runInAction(() => {
        this.pages = parsed.pages
        this.error = null
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  async open(id: string, version?: number): Promise<void> {
    this.selectedId = id
    this.viewVersion = version ?? null
    this.loading = true
    try {
      const raw = await req('GET', `/api/pages/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`)
      const parsed = pageReadResponseSchema.parse(raw)
      runInAction(() => {
        if (this.selectedId === id) {
          this.current = parsed
          this.error = null
        }
      })
    } catch (e) {
      runInAction(() => {
        if (this.selectedId === id) this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }

  close(): void {
    this.selectedId = null
    this.current = null
    this.viewVersion = null
  }

  async write(id: string, input: { title: string; contentType: PageContentType; body: string }): Promise<void> {
    await req('PUT', `/api/pages/${encodeURIComponent(id)}`, { ...input, author: 'user' })
    await this.refresh()
    await this.open(id)
  }

  async restore(version: number): Promise<void> {
    const id = this.selectedId
    if (!id) return
    await req('POST', `/api/pages/${encodeURIComponent(id)}/restore`, { version })
    await this.refresh()
    await this.open(id)
  }

  async remove(id: string): Promise<void> {
    await req('DELETE', `/api/pages/${encodeURIComponent(id)}`)
    if (this.selectedId === id) this.close()
    await this.refresh()
  }
}

export const pagesStore = new PagesStore()


/** One week of journal entries — the sidebar's unit for the Journal view. */
export interface JournalWeek {
  key: string
  label: string
  entries: JournalEntry[]
}

/**
 * Group journal entries into Monday-start weeks, newest first.
 *
 * The journal is read as a continuous log rather than as documents, so the
 * sidebar indexes TIME rather than listing entries: a truncated preview per
 * entry is a worse version of the body, while a date bracket is a place to jump
 * to (Travis, 2026-08-30). Entries stay in one scrollable body so reading
 * across a period never costs a click per entry.
 */
export function bucketJournalByWeek(entries: JournalEntry[]): JournalWeek[] {
  const weekStart = (iso: string): Date => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return new Date(0)
    const mondayOffset = (d.getDay() + 6) % 7   // Sun=0 → 6, so weeks start Monday
    const s = new Date(d)
    s.setDate(d.getDate() - mondayOffset)
    s.setHours(0, 0, 0, 0)
    return s
  }
  const md = (d: Date): string => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  const byKey = new Map<string, JournalWeek>()
  for (const e of [...entries].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))) {
    const start = weekStart(e.updatedAt ?? e.createdAt)
    const key = start.toISOString().slice(0, 10)
    let bucket = byKey.get(key)
    if (!bucket) {
      const end = new Date(start)
      end.setDate(start.getDate() + 6)
      const thisWeek = key === (() => {
        const n = new Date()
        n.setDate(n.getDate() - ((n.getDay() + 6) % 7))
        n.setHours(0, 0, 0, 0)
        return n.toISOString().slice(0, 10)
      })()
      bucket = { key, label: `${md(start)} – ${md(end)}${thisWeek ? ' · this week' : ''}`, entries: [] }
      byKey.set(key, bucket)
    }
    bucket.entries.push(e)
  }
  return [...byKey.values()].sort((a, b) => b.key.localeCompare(a.key))
}
