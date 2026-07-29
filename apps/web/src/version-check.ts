/**
 * version-check — defends against the "stuck on a stale client" failure mode
 * (open tab keeps running old code that can't reach the gateway WS; hard-refresh
 * doesn't always clear it, only incognito does).
 *
 * Two jobs:
 *  1. Unregister any LEGACY service worker. The current app ships none, but an older
 *     deploy may have registered one that survives a hard-refresh and either serves
 *     stale code or breaks the same-origin gateway WebSocket. Clear it on every load.
 *  2. Detect a newer deployed bundle (the hashed /assets/index-<hash>.js filename
 *     changes every build) and reload, so an open tab never keeps running old code.
 */

const CHECK_INTERVAL_MS = 60_000
const BUNDLE_RE = /\/assets\/(index-[A-Za-z0-9_]+\.js)/

function currentBundle(): string | null {
  const s = document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null
  const m = s?.getAttribute('src')?.match(BUNDLE_RE)
  return m ? m[1] : null
}

async function latestBundle(): Promise<string | null> {
  try {
    const r = await fetch('/', { cache: 'no-store', credentials: 'same-origin' })
    if (!r.ok) return null
    const m = (await r.text()).match(BUNDLE_RE)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function cleanupLegacyServiceWorkers(): void {
  try {
    navigator.serviceWorker?.getRegistrations?.()
      .then((regs) => {
        if (regs.length) console.warn(`[version-check] unregistering ${regs.length} stale service worker(s)`)
        for (const r of regs) void r.unregister()
      })
      .catch(() => {})
  } catch {
    /* no SW support / noop */
  }
}

function showReloadBanner(): void {
  if (document.getElementById('gy-version-banner') || !document.body) return
  const bar = document.createElement('div')
  bar.id = 'gy-version-banner'
  bar.style.cssText =
    'position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);' +
    'background:#1f6feb;color:#fff;padding:10px 16px;border-radius:8px;font:13px/1.3 system-ui,sans-serif;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer;display:flex;gap:10px;align-items:center'
  bar.innerHTML = 'A new version is available. <span style="text-decoration:underline;font-weight:600">Reload</span>'
  bar.onclick = () => location.reload()
  document.body.appendChild(bar)
}

export function startVersionCheck(): void {
  cleanupLegacyServiceWorkers()

  const loaded = currentBundle()
  if (!loaded) return

  let handled = false
  const check = async (autoReload: boolean): Promise<void> => {
    if (handled) return
    const latest = await latestBundle()
    if (latest && latest !== loaded) {
      handled = true
      console.warn(`[version-check] new build ${latest} (loaded ${loaded})`)
      if (autoReload) location.reload()
      else showReloadBanner()
    }
  }

  setInterval(() => void check(false), CHECK_INTERVAL_MS)
  // Banner only — never auto-reload out from under the user (surprise refreshes were disruptive
  // and interrupted work). A visible tab just re-checks and surfaces the banner sooner.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check(false)
  })
}
