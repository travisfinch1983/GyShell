import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

/** Backend-persisted UI preferences (single-user app — global across browsers/sessions).
 *  Load once at startup, read with get(key, default), write with set(key, value) (debounced PUT). */
class UiPrefsStore {
  prefs: Record<string, any> = {}
  loaded = false
  private loading: Promise<void> | null = null
  private timers: Record<string, any> = {}

  constructor() { makeAutoObservable(this) }

  /** Idempotent — safe to call from multiple components' mount effects. */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (!this.loading) {
      this.loading = (async () => {
        const r = await bridge()?.request('GET', '/api/ui-prefs').catch(() => ({}))
        runInAction(() => { this.prefs = r || {}; this.loaded = true })
      })()
    }
    return this.loading
  }

  get<T = any>(key: string, def: T): T {
    const v = this.prefs[key]
    return v === undefined || v === null ? def : v
  }

  /** Optimistic local update + debounced backend persist (shallow-merge on the server). */
  set(key: string, value: any): void {
    runInAction(() => { this.prefs = { ...this.prefs, [key]: value } })
    clearTimeout(this.timers[key])
    this.timers[key] = setTimeout(() => {
      void bridge()?.request('PUT', '/api/ui-prefs', { [key]: value }).catch(() => undefined)
    }, 400)
  }
}

export const uiPrefsStore = new UiPrefsStore()
