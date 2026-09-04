import { makeAutoObservable, runInAction } from 'mobx'

/**
 * DatasetReviewStore — AI · Image Gen -> Dataset Review.
 *
 * Reviewing ~700 auto-annotations is a speed problem, so the model here is: show the overlays
 * that are still undecided ("auto"), and let a keypress decide each one. Decisions post
 * immediately rather than batching — a review session that loses work on a refresh is worse
 * than one that is slightly chattier.
 */
export interface TileRec {
  tile: string; status: 'auto' | 'approved' | 'rejected' | 'negative'
  polys: number; sam: number | null; src: string; y: number
}
export interface SetRec {
  name: string; tiles: number; sources: number; polygons: number
  status: Record<string, number>; terms: string[]; modified: number
}

export class DatasetReviewStore {
  sets: SetRec[] = []
  active = ''
  tiles: TileRec[] = []
  total = 0
  offset = 0
  limit = 120
  counts: Record<string, number> = {}
  filter: string = 'auto'
  loading = false
  error = ''
  cursor = 0
  busy = new Set<string>()

  constructor() { makeAutoObservable(this) }

  get current(): TileRec | undefined { return this.tiles[this.cursor] }
  get reviewed() { return (this.counts.approved || 0) + (this.counts.rejected || 0) }
  get pending() { return this.counts.auto || 0 }
  imgUrl(t: TileRec, kind: 'overlays' | 'tiles' = 'overlays') {
    return `/api/dataset/${encodeURIComponent(this.active)}/image/${kind}/${encodeURIComponent(t.tile)}`
  }

  async loadSets() {
    try {
      const r = await fetch('/api/dataset/sets'); const d = await r.json()
      runInAction(() => { this.sets = d.sets || [] })
      if (!this.active && this.sets.length) await this.open(this.sets[0].name)
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
  }

  async open(name: string) {
    runInAction(() => { this.active = name; this.offset = 0; this.cursor = 0 })
    await this.loadTiles()
  }

  async loadTiles() {
    if (!this.active) return
    runInAction(() => { this.loading = true; this.error = '' })
    try {
      const q = new URLSearchParams({ offset: String(this.offset), limit: String(this.limit) })
      if (this.filter) q.set('status', this.filter)
      // only tiles that actually carry a mask are reviewable; negatives need no decision
      if (this.filter === 'auto') q.set('masked', 'true')
      const r = await fetch(`/api/dataset/${encodeURIComponent(this.active)}/tiles?${q}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'load failed')
      runInAction(() => {
        this.tiles = d.tiles || []; this.total = d.total || 0; this.counts = d.status || {}
        if (this.cursor >= this.tiles.length) this.cursor = Math.max(0, this.tiles.length - 1)
      })
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
    finally { runInAction(() => { this.loading = false }) }
  }

  setFilter(f: string) { runInAction(() => { this.filter = f; this.offset = 0; this.cursor = 0 }); void this.loadTiles() }
  move(d: number) {
    runInAction(() => { this.cursor = Math.min(Math.max(0, this.cursor + d), Math.max(0, this.tiles.length - 1)) })
  }

  /** Decide one tile. Optimistic locally, authoritative server-side. */
  async decide(tile: string, status: 'approved' | 'rejected') {
    if (this.busy.has(tile)) return
    runInAction(() => { this.busy.add(tile) })
    const rec = this.tiles.find((t) => t.tile === tile)
    const was = rec?.status
    if (rec) runInAction(() => { rec.status = status })
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(this.active)}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiles: [tile], status }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'update failed')
      runInAction(() => { this.counts = d.status || this.counts })
    } catch (e: any) {
      if (rec && was) runInAction(() => { rec.status = was })   // put it back, don't lie
      runInAction(() => { this.error = String(e?.message || e) })
    } finally { runInAction(() => { this.busy.delete(tile) }) }
  }

  async decideCurrent(status: 'approved' | 'rejected') {
    const c = this.current
    if (!c) return
    await this.decide(c.tile, status)
    this.move(1)
  }

  /** Approve everything still undecided in the CURRENT page — not the whole set. */
  async approveVisible() {
    const names = this.tiles.filter((t) => t.status === 'auto').map((t) => t.tile)
    if (!names.length) return
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(this.active)}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiles: names, status: 'approved' }),
      })
      const d = await r.json()
      runInAction(() => { this.counts = d.status || this.counts })
      await this.loadTiles()
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
  }
}

export const datasetReviewStore = new DatasetReviewStore()
