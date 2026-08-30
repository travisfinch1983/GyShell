import { makeAutoObservable, runInAction } from 'mobx'
import {
  pageListResponseSchema,
  pageReadResponseSchema,
  type JournalEntry,
  type PageContentType,
  type PageListEntry,
  type PageReadResponse,
  type ReportCategory,
  type ReportSummary,
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
  categories: ReportCategory[] = []
  categoryFilter: string | null = null
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
    await this.loadCategories()
    runInAction(() => {
      this.loaded = true
    })
  }

  get documents(): PageListEntry[] {
    return this.pages.filter((p) => (p.kind ?? 'document') !== 'report')
  }

  get reports(): PageListEntry[] {
    return this.pages
      .filter((p) => p.kind === 'report')
      .filter((p) => !this.categoryFilter || p.category === this.categoryFilter)
  }

  setView(view: 'documents' | 'reports' | 'journal'): void {
    this.view = view
    if (view === 'journal') void this.loadJournal()
  }

  setCategoryFilter(id: string | null): void {
    this.categoryFilter = id
    if (this.view === 'journal') void this.loadJournal()
  }

  categoryLabel(id?: string): string {
    if (!id) return ''
    return this.categories.find((c) => c.id === id)?.label ?? id
  }

  async loadCategories(): Promise<void> {
    try {
      const r = await req('GET', '/api/pages/report-categories')
      runInAction(() => { this.categories = r?.categories ?? [] })
    } catch { /* categories are decorative until the next load */ }
  }

  async loadJournal(): Promise<void> {
    try {
      const r = await req('GET', `/api/pages/journal${this.categoryFilter ? `?category=${encodeURIComponent(this.categoryFilter)}` : ''}`)
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
      const r = await req('GET', `/api/pages/report-search?q=${encodeURIComponent(query)}${this.categoryFilter ? `&category=${encodeURIComponent(this.categoryFilter)}` : ''}`)
      const flat: Array<{ category: string; pageId?: string; score?: number; text?: string; error?: string }> = []
      for (const c of r?.collections ?? []) {
        if (c.error) { flat.push({ category: c.category, error: c.error }); continue }
        for (const hit of c.results ?? []) {
          flat.push({ category: c.category, pageId: hit.doc_id, score: hit.score, text: hit.text })
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

  async write(
    id: string,
    input: { title: string; contentType: PageContentType; body: string; kind?: 'document' | 'report'; category?: string; report?: ReportSummary },
  ): Promise<void> {
    await req('PUT', `/api/pages/${encodeURIComponent(id)}`, { ...input, author: 'user' })
    await this.refresh()
    if (this.view === 'journal') void this.loadJournal()
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
