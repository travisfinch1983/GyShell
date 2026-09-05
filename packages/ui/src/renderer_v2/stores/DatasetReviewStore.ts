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
  tile: string
  // 'manual'    = a hand-corrected mask (click-to-annotate); decided and POSITIVE
  // 'unlabelled'= the seed detector found nothing on an expected-positive image;
  //               held out of export rather than asserted to be background
  status: 'auto' | 'approved' | 'rejected' | 'negative' | 'manual' | 'unlabelled'
  polys: number; sam: number | null; src: string; y: number; rev?: number
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
  // 'auto'       = a seed mask to verify
  // 'unlabelled' = no mask at all; needs one drawn. BOTH need a human, so the default
  //                queue is both — filtering to 'auto' alone hid 160 freshly added
  //                tiles and made an ingest look like it had added nothing.
  filter: string = 'auto,unlabelled'
  loading = false
  error = ''
  cursor = 0
  busy = new Set<string>()

  constructor() { makeAutoObservable(this) }

  get current(): TileRec | undefined { return this.tiles[this.cursor] }
  get reviewed() { return (this.counts.approved || 0) + (this.counts.rejected || 0) }
  get pending() { return this.counts.auto || 0 }
  imgUrl(t: TileRec, kind: 'overlays' | 'tiles' = 'overlays') {
    // ?v= ALWAYS, not only when a mask was redrawn. Two reasons:
    //  - after a redraw it busts the max-age=3600 copy of the old overlay
    //  - and it changes the URL for tiles that 404'd BEFORE overlays fell back to the raw
    //    tile. Those 404s were heuristically cached by the browser, so an unchanged URL
    //    kept serving a cached failure and the thumbnails stayed broken even once the
    //    server had started returning 200.
    const v = `?v=${t.rev ?? 0}`
    return `/api/dataset/${encodeURIComponent(this.active)}/image/${kind}/${encodeURIComponent(t.tile)}${v}`
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
    runInAction(() => {
      this.cursor = Math.min(Math.max(0, this.cursor + d), Math.max(0, this.tiles.length - 1))
      this.draftPolys = []; this.points = []      // a draft belongs to ONE tile
    })
  }

  /** Decide one tile. Optimistic locally, authoritative server-side. */
  async decide(tile: string, status: 'approved' | 'rejected' | 'negative') {
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
      runInAction(() => {
        this.counts = d.status || this.counts
        if (status === 'negative' && rec) { rec.polys = 0; rec.rev = Date.now() }
      })
    } catch (e: any) {
      if (rec && was) runInAction(() => { rec.status = was })   // put it back, don't lie
      runInAction(() => { this.error = String(e?.message || e) })
    } finally { runInAction(() => { this.busy.delete(tile) }) }
  }

  async decideCurrent(status: 'approved' | 'rejected' | 'negative') {
    const c = this.current
    if (!c) return
    await this.decide(c.tile, status)
    this.move(1)
  }

  // ── click-to-annotate ─────────────────────────────────────────────────
  // A tile the detector missed has NO seed. Clicking the target sends the point to SAM and
  // turns it into a polygon — the only way to add failing images without lying about them.
  draftPolys: { pts: number[][]; score?: number }[] = []
  points: { x: number; y: number; label: number }[] = []
  segmenting = false

  clearDraft() { runInAction(() => { this.draftPolys = []; this.points = [] }) }

  /** x/y are normalised 0..1 within the tile. label 0 = "exclude this region". */
  async addPoint(x: number, y: number, label = 1) {
    const c = this.current
    if (!c || this.segmenting) return
    runInAction(() => { this.points.push({ x, y, label }); this.segmenting = true; this.error = '' })
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(this.active)}/segment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tile: c.tile, points: this.points }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'segment failed')
      runInAction(() => { this.draftPolys = d.polys || [] })
    } catch (e: any) {
      runInAction(() => { this.error = String(e?.message || e); this.points.pop() })
    } finally { runInAction(() => { this.segmenting = false }) }
  }

  /** Commit the draft to the manifest, replacing whatever the seed detector produced. */
  async saveDraft() {
    const c = this.current
    if (!c || !this.draftPolys.length) return
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(this.active)}/polys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tile: c.tile, polys: this.draftPolys }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'save failed')
      runInAction(() => {
        c.status = d.status; c.polys = d.polys; c.rev = d.rev
        this.counts = d.statusCounts || this.counts
      })
      this.clearDraft()
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
  }

  /** Clear a verdict and put the tile back in the queue — an accidental keypress must be
   *  recoverable without hand-editing JSON on disk. */
  async resetCurrent() {
    const c = this.current
    if (!c) return
    const back: TileRec['status'] = c.polys > 0 ? 'auto' : 'unlabelled'
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(this.active)}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiles: [c.tile], status: back }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'reset failed')
      runInAction(() => { c.status = back; this.counts = d.status || this.counts })
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
  }

  /** Drop a tile — or its whole source image — from the dataset. */
  async removeCurrent(bySource: boolean) {
    const c = this.current
    if (!c) return
    try {
      const r = await fetch(`/api/dataset/${encodeURIComponent(this.active)}/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiles: [c.tile], bySource }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'remove failed')
      runInAction(() => { this.counts = d.statusCounts || this.counts })
      await this.loadTiles()
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
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
