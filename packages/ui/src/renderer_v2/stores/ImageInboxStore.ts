import { makeAutoObservable, runInAction } from 'mobx'

export interface InboxImage {
  id: string
  ts: string
  title?: string
  caption?: string
  from?: string
  mime: string
  bytes: number
  origPath?: string
  seen: boolean
}

function cluster(): { request: (m: string, p: string, b?: unknown) => Promise<any> } | undefined {
  return (window as any).gyshell?.cluster
}

function liveChannels(): any {
  return (window as any).gyshell?.imageInbox
}

/**
 * Image inbox: images agents posted for Travis to SEE (backend ImageInbox). The deliberate
 * contrast with the clipboard: a new image NEVER opens anything — it only bumps the pip.
 * Travis opens the viewer himself, and opening marks everything seen (pip clears).
 */
class ImageInboxStore {
  items: InboxImage[] = []
  unseenCount = 0
  open = false
  /** Index into items of the image shown large in the viewer. */
  selected = 0
  loaded = false
  error: string | null = null
  private started = false

  constructor() {
    makeAutoObservable(this)
  }

  async ensureLoaded(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.refresh()
    const live = liveChannels()
    if (live?.onPosted) {
      live.onPosted((data: { item?: InboxImage }) => {
        if (!data?.item) return
        runInAction(() => {
          if (!this.items.some((i) => i.id === data.item!.id)) {
            this.items = [data.item!, ...this.items]
            // Keep the viewer on the image Travis was looking at.
            if (this.open && this.selected < this.items.length - 1) this.selected += 1
          }
          this.unseenCount = this.items.filter((i) => !i.seen).length
          // Viewer already open = he's looking; the arrival counts as seen right away.
          if (this.open) void this.markSeen()
        })
      })
      live.onChanged((data: { items?: InboxImage[]; unseen?: number }) => {
        runInAction(() => {
          this.items = data?.items ?? []
          this.unseenCount = data?.unseen ?? 0
          if (this.selected >= this.items.length) this.selected = Math.max(0, this.items.length - 1)
        })
      })
    } else {
      // Older shim without the channel: poll so the pip still works, just later.
      setInterval(() => void this.refresh(), 10_000)
    }
  }

  async refresh(): Promise<void> {
    const c = cluster()
    if (!c) return
    try {
      const r = await c.request('GET', '/api/image-inbox')
      runInAction(() => {
        this.items = r?.items ?? []
        this.unseenCount = r?.unseen ?? 0
        this.loaded = true
        this.error = null
        if (this.selected >= this.items.length) this.selected = Math.max(0, this.items.length - 1)
      })
    } catch (e: any) {
      runInAction(() => { this.error = `Could not load image inbox: ${e?.message || e}` })
    }
  }

  /** Same-origin URL for <img>. Rides the /api proxy like the imagegen panels do. */
  imageUrl(id: string): string {
    return `/api/image-inbox/${encodeURIComponent(id)}/image`
  }

  openViewer(): void {
    this.open = true
    this.selected = 0
    void this.markSeen()
  }

  close(): void { this.open = false }

  toggle(): void {
    if (this.open) this.close()
    else this.openViewer()
  }

  select(i: number): void {
    if (i >= 0 && i < this.items.length) this.selected = i
  }

  next(): void { this.select(this.selected + 1) }
  prev(): void { this.select(this.selected - 1) }

  private async markSeen(): Promise<void> {
    if (!this.items.some((i) => !i.seen)) { this.unseenCount = 0; return }
    runInAction(() => {
      this.items = this.items.map((i) => (i.seen ? i : { ...i, seen: true }))
      this.unseenCount = 0
    })
    try { await cluster()?.request('POST', '/api/image-inbox/seen') }
    catch (e: any) { runInAction(() => { this.error = `Could not mark seen: ${e?.message || e}` }) }
  }

  async remove(id: string): Promise<void> {
    runInAction(() => {
      this.items = this.items.filter((i) => i.id !== id)
      if (this.selected >= this.items.length) this.selected = Math.max(0, this.items.length - 1)
    })
    try { await cluster()?.request('DELETE', `/api/image-inbox/${encodeURIComponent(id)}`) }
    catch (e: any) { runInAction(() => { this.error = `Delete failed: ${e?.message || e}` }); void this.refresh() }
  }

  async clear(): Promise<void> {
    runInAction(() => { this.items = []; this.selected = 0; this.unseenCount = 0 })
    try { await cluster()?.request('DELETE', '/api/image-inbox') }
    catch (e: any) { runInAction(() => { this.error = `Clear failed: ${e?.message || e}` }); void this.refresh() }
  }
}

export const imageInboxStore = new ImageInboxStore()
