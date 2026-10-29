/**
 * The CivitAI Review screen on its own, for the "CivitAI to AI-Lab" browser extension.
 *
 * The extension's side panel frames the web UI at `/?embed=civitai-review`; index.tsx renders
 * this instead of <App/>, so none of the rest of the app boots. It is the SAME ReviewBrowser and
 * store the Model Downloads tab uses, so version/file selection, the Folder/Filename boxes and the
 * live name preview all come from the server's own templates. Nothing is copied into the extension.
 *
 * Protocol (window.postMessage, only from a chrome-extension:// parent):
 *   parent -> embed  { source: 'ailab-civitai-ext', type: 'load', url }   load a model page URL
 *   embed  -> parent { source: 'ailab-civitai-review', type: 'ready' }
 *   embed  -> parent { source: 'ailab-civitai-review', type: 'loaded', modelId, modelName }
 *   embed  -> parent { source: 'ailab-civitai-review', type: 'downloaded', modelName, versions }
 * `?url=` on the embed URL loads a model at startup as well.
 */
import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { reaction } from 'mobx'
import { modelDownloadsStore as store } from '../../stores/ModelDownloadsStore'
import { ReviewBrowser } from './ModelDownloadsPanel'
import { ConfirmHost } from '../Common/ConfirmHost'
import { resolveTheme } from '../../theme/themes'
import { applyAppThemeFromTerminalScheme } from '../../theme/appTheme'

const parentOrigin = (() => {
  try { return document.referrer ? new URL(document.referrer).origin : '' } catch { return '' }
})()

function toParent(msg: Record<string, unknown>): void {
  if (window.parent === window) return
  // The referrer is the extension page; fall back to '*' only when it is missing (the
  // payload carries model names, nothing sensitive).
  window.parent.postMessage({ source: 'ailab-civitai-review', ...msg }, parentOrigin || '*')
}

async function applyTheme(): Promise<void> {
  try {
    const ui = await (window as any).gyshell?.uiSettings?.get?.()
    let custom: any[] = []
    try { custom = (await (window as any).gyshell?.themes?.reloadCustom?.()) || [] } catch (e) {
      console.warn('[civitai-embed] custom themes unavailable:', e)
    }
    applyAppThemeFromTerminalScheme(resolveTheme(ui?.themeId, custom).terminal)
  } catch (e) {
    console.warn('[civitai-embed] theme not applied, using defaults:', e)
  }
}

function load(url: string): void {
  if (!url) return
  store.civUrl = url
  void store.reviewLoad(url)
}

export const CivitaiReviewEmbed: React.FC = observer(() => {
  useEffect(() => {
    void applyTheme()
    void store.loadCivConfig()
    void store.loadCivExtras()
    void store.loadHistories()

    const onMessage = (e: MessageEvent) => {
      if (!String(e.origin).startsWith('chrome-extension://')) return
      const d = e.data
      if (!d || d.source !== 'ailab-civitai-ext') return
      if (d.type === 'load' && typeof d.url === 'string') load(d.url)
    }
    window.addEventListener('message', onMessage)

    const initial = new URLSearchParams(window.location.search).get('url')
    if (initial) load(initial)

    const stopLoaded = reaction(
      () => store.civModel?.id,
      (id) => { if (id) toParent({ type: 'loaded', modelId: String(id), modelName: store.civModel?.name || '' }) },
    )
    const stopDownloaded = reaction(
      () => store.reviewDownloadSeq,
      () => toParent({ type: 'downloaded', ...(store.lastReviewDownload || {}) }),
    )
    toParent({ type: 'ready' })
    return () => { window.removeEventListener('message', onMessage); stopLoaded(); stopDownloaded() }
  }, [])

  return (
    <div style={{ height: '100vh', overflow: 'auto', background: 'var(--app-bg)', color: 'var(--fg)', padding: 10, boxSizing: 'border-box' }}>
      <ReviewBrowser />
      <ConfirmHost />
    </div>
  )
})
