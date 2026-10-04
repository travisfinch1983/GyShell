import { makeAutoObservable, runInAction } from 'mobx'

export interface ClipDrop {
  id: string
  ts: string
  text: string
  title?: string
  from?: string
  sensitive?: boolean
}

export interface ClipHistoryEntry extends ClipDrop {
  /** Still in the drawer (vs. deleted/cleared from it). */
  inClipboard: boolean
}

function cluster(): { request: (m: string, p: string, b?: unknown) => Promise<any> } | undefined {
  return (window as any).gyshell?.cluster
}

function liveChannels(): any {
  return (window as any).gyshell?.clipboard
}

/**
 * Clipboard drops: text an agent posted for Travis to copy (backend ClipboardDrops). A new drop
 * OPENS the drawer — the whole point is that it appears without anyone going looking for it.
 */
class ClipboardStore {
  items: ClipDrop[] = []
  open = false
  /** id of the drop that just arrived, briefly highlighted. */
  freshId: string | null = null
  loaded = false
  error: string | null = null
  /** Drawer is showing History (every drop ever posted) instead of the current clipboard. */
  view: 'clipboard' | 'history' = 'clipboard'
  history: ClipHistoryEntry[] = []
  historyLoading = false
  historyFilter = ''
  private started = false
  private freshTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    makeAutoObservable(this)
  }

  async ensureLoaded(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.refresh()
    const live = liveChannels()
    if (live?.onPosted) {
      live.onPosted((data: { item?: ClipDrop }) => {
        if (!data?.item) return
        runInAction(() => {
          if (!this.items.some((i) => i.id === data.item!.id)) this.items = [data.item!, ...this.items]
          this.open = true
          // A new drop is what Travis wants to see — jump back from History to the clipboard.
          this.view = 'clipboard'
          this.flagFresh(data.item!.id)
        })
      })
      live.onChanged((data: { items?: ClipDrop[] }) => {
        runInAction(() => { this.items = data?.items ?? [] })
      })
    } else {
      // Older shim without the clipboard channel: poll so drops still show up, just later.
      setInterval(() => void this.refresh(true), 5_000)
    }
  }

  async refresh(openOnNew = false): Promise<void> {
    const c = cluster()
    if (!c) return
    try {
      const r = await c.request('GET', '/api/clipboard')
      runInAction(() => {
        const next: ClipDrop[] = r?.items ?? []
        const newest = next[0]
        const isNew = openOnNew && newest && !this.items.some((i) => i.id === newest.id)
        this.items = next
        this.loaded = true
        this.error = null
        if (isNew) { this.open = true; this.flagFresh(newest.id) }
      })
    } catch (e: any) {
      runInAction(() => { this.error = `Could not load clipboard: ${e?.message || e}` })
    }
  }

  private flagFresh(id: string): void {
    this.freshId = id
    if (this.freshTimer) clearTimeout(this.freshTimer)
    this.freshTimer = setTimeout(() => runInAction(() => { this.freshId = null }), 4_000)
  }

  get filteredHistory(): ClipHistoryEntry[] {
    const q = this.historyFilter.trim().toLowerCase()
    if (!q) return this.history
    return this.history.filter((h) =>
      (h.title || '').toLowerCase().includes(q)
      || (h.from || '').toLowerCase().includes(q)
      || (!h.sensitive && h.text.toLowerCase().includes(q)))
  }

  setView(v: 'clipboard' | 'history'): void {
    this.view = v
    if (v === 'history') void this.loadHistory()
  }

  setHistoryFilter(q: string): void { this.historyFilter = q }

  async loadHistory(): Promise<void> {
    const c = cluster()
    if (!c) return
    runInAction(() => { this.historyLoading = true })
    try {
      const r = await c.request('GET', '/api/clipboard/history')
      runInAction(() => { this.history = r?.items ?? []; this.error = null })
    } catch (e: any) {
      runInAction(() => { this.error = `Could not load history: ${e?.message || e}` })
    } finally {
      runInAction(() => { this.historyLoading = false })
    }
  }

  async restore(id: string): Promise<void> {
    try {
      await cluster()?.request('POST', `/api/clipboard/history/${encodeURIComponent(id)}/restore`)
      await this.loadHistory()
    } catch (e: any) {
      runInAction(() => { this.error = `Restore failed: ${e?.message || e}` })
    }
  }

  async removeFromHistory(id: string): Promise<void> {
    runInAction(() => { this.history = this.history.filter((h) => h.id !== id) })
    try { await cluster()?.request('DELETE', `/api/clipboard/history/${encodeURIComponent(id)}`) }
    catch (e: any) { runInAction(() => { this.error = `Delete failed: ${e?.message || e}` }); void this.loadHistory() }
  }

  async clearHistory(): Promise<void> {
    runInAction(() => { this.history = [] })
    try { await cluster()?.request('DELETE', '/api/clipboard/history') }
    catch (e: any) { runInAction(() => { this.error = `Clear history failed: ${e?.message || e}` }); void this.loadHistory() }
  }

  toggle(): void { this.open = !this.open }
  close(): void { this.open = false }

  async remove(id: string): Promise<void> {
    runInAction(() => { this.items = this.items.filter((i) => i.id !== id) })
    try { await cluster()?.request('DELETE', `/api/clipboard/${encodeURIComponent(id)}`) }
    catch (e: any) { runInAction(() => { this.error = `Delete failed: ${e?.message || e}` }); void this.refresh() }
  }

  async clear(): Promise<void> {
    runInAction(() => { this.items = [] })
    try { await cluster()?.request('DELETE', '/api/clipboard') }
    catch (e: any) { runInAction(() => { this.error = `Clear failed: ${e?.message || e}` }); void this.refresh() }
  }
}

export const clipboardStore = new ClipboardStore()

/**
 * Copy text to the system clipboard. navigator.clipboard only exists in a SECURE context
 * (https or localhost); AI-Lab is also opened over plain http on the LAN, where it is undefined,
 * so fall back to the old textarea + execCommand path rather than silently doing nothing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
