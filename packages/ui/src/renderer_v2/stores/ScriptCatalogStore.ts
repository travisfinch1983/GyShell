import { makeAutoObservable, runInAction } from 'mobx'

/**
 * ScriptCatalogStore — Helper Scripts (community + ProxLab installer catalog).
 *
 * Catalog data is read via the `cluster:request` bridge to ProxLab's /api/script-catalog
 * (which git-syncs the community-scripts repo). v1 = browse / search / categories / detail /
 * copy install command. The in-app streamed INSTALL run (ProxLab's WS terminal) + the big
 * options/defaults form are deferred to the native terminal port (finalization).
 */
export interface CatalogScript {
  name: string
  slug: string
  description?: string
  logo?: string
  source?: 'community' | 'proxlab' | string
  sourceUrl?: string
  tags?: string[]
  categories?: string[]
  resources?: { cpu?: number; ram?: number; disk?: number; os?: string; version?: string }
  privileged?: boolean
  installUrl?: string
  website?: string
  documentation?: string
  interfacePort?: number
  notes?: Array<{ type?: string; text: string }>
}
export interface Catalog {
  scripts: CatalogScript[]
  categories: Array<{ name: string; count: number }>
  totalScripts?: number
  lastSync?: string
}

export class ScriptCatalogStore {
  catalog: Catalog | null = null
  loading = false
  error: string | null = null
  syncing = false
  syncStep = ''
  syncProgress = 0
  activeCategory = 'all' // 'all' | 'proxlab' | 'community' | <category name>
  search = ''
  loaded = false

  constructor() {
    makeAutoObservable(this)
  }

  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loading = true
    try {
      const cat = (await this.cluster().request('GET', '/api/script-catalog')) as Catalog
      runInAction(() => {
        this.catalog = cat
        this.error = null
        this.loaded = true
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }

  /** Force a re-sync from GitHub, polling status until done, then reload the catalog. */
  async sync(): Promise<void> {
    this.syncing = true
    this.syncProgress = 0
    this.syncStep = 'Starting…'
    try {
      const api = this.cluster()
      await api.request('POST', '/api/script-catalog/sync')
      const deadline = Date.now() + 120000
      // eslint-disable-next-line no-constant-condition
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1200))
        const st = (await api.request('GET', '/api/script-catalog/sync/status')) as any
        runInAction(() => {
          this.syncStep = st?.step ?? ''
          this.syncProgress = st?.progress ?? 0
        })
        if (!st?.running) break
      }
      const cat = (await api.request('GET', '/api/script-catalog')) as Catalog
      runInAction(() => {
        this.catalog = cat
        this.loaded = true
        this.error = null
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.syncing = false
      })
    }
  }

  setCategory(c: string): void {
    this.activeCategory = c
  }
  setSearch(s: string): void {
    this.search = s
  }

  get filteredScripts(): CatalogScript[] {
    const all = this.catalog?.scripts ?? []
    const cat = this.activeCategory
    let list = all
    if (cat === 'proxlab') list = all.filter((s) => s.source === 'proxlab')
    else if (cat === 'community') list = all.filter((s) => s.source === 'community')
    else if (cat !== 'all') list = all.filter((s) => (s.categories ?? []).includes(cat))
    const f = this.search.trim().toLowerCase()
    if (f) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(f) ||
          (s.slug || '').toLowerCase().includes(f) ||
          (s.description || '').toLowerCase().includes(f) ||
          (s.tags ?? []).some((t) => t.toLowerCase().includes(f)),
      )
    }
    return list
  }

  get counts(): { all: number; proxlab: number; community: number } {
    const all = this.catalog?.scripts ?? []
    return {
      all: all.length,
      proxlab: all.filter((s) => s.source === 'proxlab').length,
      community: all.filter((s) => s.source === 'community').length,
    }
  }
}

export const scriptCatalogStore = new ScriptCatalogStore()
