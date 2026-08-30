import { makeAutoObservable, runInAction } from 'mobx'
import {
  pageListResponseSchema,
  pageReadResponseSchema,
  type PageContentType,
  type PageListEntry,
  type PageReadResponse,
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
    runInAction(() => {
      this.loaded = true
    })
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
