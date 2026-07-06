import React, { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { ADDONS, ADDON_ICONS, NATIVE_VIEWS, type AddonManifest } from './addonRegistry'
import styles from './Addons.module.scss'

/**
 * Addons primary tab — TWO addon sources side by side (claude1 2af5783):
 *
 *  - COMPILED addons (addonRegistry.ts): manifest + NATIVE_VIEWS components,
 *    bundled with the app (upscaler…). Unchanged; they port to self-served
 *    later.
 *  - RUNTIME addons (GET /api/addons): registered at request time, zero
 *    rebuild — each renders as ONE iframe at /addons/<id>/?theme=<mode>,
 *    reverse-proxied to the addon's own service. Theme sync: initial ?theme=
 *    on the src plus postMessage({type:'theme',value}) on toggle (the addon
 *    sets <html data-theme> and links /addons/_shared/theme.css).
 *
 * Views stay mounted once visited (display swap) so addon state survives
 * tab switches.
 */

interface RuntimeAddon {
  id: string
  label: string
  icon?: string
  backend?: string
  ui?: string
  healthPath?: string
  enabled?: boolean
  order?: number
}

function bridge(): any {
  return (window as any).gyshell?.cluster
}

/** 'dark' | 'light' from the LIVE --app-bg token (themes are applied as CSS
 *  custom properties on <html>, no data-theme attribute to read) — with a
 *  MutationObserver on the style attribute so theme toggles propagate. */
function useThemeMode(): 'dark' | 'light' {
  const compute = (): 'dark' | 'light' => {
    try {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim()
      const m = bg.match(/^#([0-9a-f]{6})$/i)
      if (m) {
        const n = parseInt(m[1], 16)
        const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
        return lum < 0.5 ? 'dark' : 'light'
      }
      const rgb = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
      if (rgb) {
        const lum = (0.2126 * +rgb[1] + 0.7152 * +rgb[2] + 0.0722 * +rgb[3]) / 255
        return lum < 0.5 ? 'dark' : 'light'
      }
    } catch { /* default below */ }
    return 'dark'
  }
  const [mode, setMode] = useState<'dark' | 'light'>(compute)
  useEffect(() => {
    const obs = new MutationObserver(() => setMode(compute()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => obs.disconnect()
  }, [])
  return mode
}

const AddonView: React.FC<{ addon: AddonManifest; visible: boolean }> = ({ addon, visible }) => {
  const [inner, setInner] = useState(addon.views[0]?.id ?? '')
  const [visitedViews, setVisitedViews] = useState<Set<string>>(new Set(inner ? [inner] : []))
  const pickView = (id: string) => {
    setInner(id)
    setVisitedViews((v) => (v.has(id) ? v : new Set(v).add(id)))
  }

  const renderView = (viewId: string) => {
    const view = addon.views.find((v) => v.id === viewId)
    if (!view) return null
    if (view.kind === 'native') {
      const Component = NATIVE_VIEWS[`${addon.id}.${view.id}`]
      return Component ? (
        <div className={styles.native}><Component /></div>
      ) : (
        <div className={styles.dim} style={{ padding: 16 }}>
          {addon.label} · {view.label}: native view pending (component not registered yet).
        </div>
      )
    }
    const src = view.path?.startsWith('/') ? view.path : `${addon.basePath}/${view.path ?? ''}`
    return <iframe className={styles.frame} src={src} title={`${addon.label} ${view.label}`} />
  }

  return (
    <div className={styles.addonView} style={{ display: visible ? 'flex' : 'none' }}>
      {addon.views.length > 1 && (
        <div className={styles.innerTabs}>
          {addon.views.map((v) => (
            <button key={v.id} className={`${styles.tab} ${inner === v.id ? styles.tabActive : ''}`} onClick={() => pickView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      )}
      <div className={styles.body}>
        {addon.views.filter((v) => visitedViews.has(v.id)).map((v) => (
          <div key={v.id} className={styles.addonView} style={{ display: inner === v.id ? 'flex' : 'none' }}>
            {renderView(v.id)}
          </div>
        ))}
      </div>
    </div>
  )
}

/** A runtime addon = one themed iframe over the backend's reverse proxy. */
const RuntimeAddonView: React.FC<{ addon: RuntimeAddon; visible: boolean; theme: 'dark' | 'light' }> = ({ addon, visible, theme }) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  // initial theme rides the src; later toggles go over postMessage so the
  // addon doesn't reload (it swaps <html data-theme> itself)
  const initialTheme = useRef(theme)
  useEffect(() => {
    if (theme !== initialTheme.current) {
      frameRef.current?.contentWindow?.postMessage({ type: 'theme', value: theme }, '*')
    }
  }, [theme])
  return (
    <div className={styles.addonView} style={{ display: visible ? 'flex' : 'none' }}>
      <iframe
        ref={frameRef}
        className={styles.frame}
        src={`/addons/${encodeURIComponent(addon.id)}/?theme=${initialTheme.current}`}
        title={addon.label}
      />
    </div>
  )
}

export const AddonsPanel: React.FC = () => {
  const theme = useThemeMode()
  const [runtime, setRuntime] = useState<RuntimeAddon[]>([])
  const [health, setHealth] = useState<Record<string, boolean>>({})
  const [active, setActive] = useState<string>(ADDONS[0]?.id ?? '')
  const [visited, setVisited] = useState<Set<string>>(new Set(active ? [active] : []))

  const loadRuntime = async () => {
    try {
      const r = await bridge().request('GET', '/api/addons')
      const addons = (Array.isArray(r?.addons) ? r.addons : []) as RuntimeAddon[]
      const list = addons.filter((a) => a.enabled !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      setRuntime(list)
      // best-effort health dots via the same-origin proxy
      for (const a of list) {
        if (!a.healthPath) continue
        void fetch(`/addons/${encodeURIComponent(a.id)}${a.healthPath.startsWith('/') ? a.healthPath : `/${a.healthPath}`}`, { method: 'GET' })
          .then((res) => setHealth((h) => ({ ...h, [a.id]: res.ok })))
          .catch(() => setHealth((h) => ({ ...h, [a.id]: false })))
      }
    } catch { /* endpoint unreachable — compiled addons still render */ }
  }
  useEffect(() => { void loadRuntime() }, [])

  const pick = (id: string) => {
    setActive(id)
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)))
  }

  const total = ADDONS.length + runtime.length

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {ADDONS.map((a) => {
          const Icon = ADDON_ICONS[a.icon ?? 'default'] ?? ADDON_ICONS.default
          return (
            <button key={a.id} className={`${styles.tab} ${active === a.id ? styles.tabActive : ''}`} onClick={() => pick(a.id)}>
              <Icon size={13} /> {a.label}
            </button>
          )
        })}
        {runtime.map((a) => {
          const Icon = ADDON_ICONS[a.icon ?? 'default'] ?? ADDON_ICONS.default
          const h = health[a.id]
          return (
            <button key={a.id} className={`${styles.tab} ${active === a.id ? styles.tabActive : ''}`} onClick={() => pick(a.id)}>
              <Icon size={13} /> {a.label}
              {h !== undefined && (
                <span
                  className={styles.healthDot}
                  style={{ background: h ? 'var(--success)' : 'var(--danger)' }}
                  title={h ? 'Addon service healthy' : 'Addon service unreachable'}
                />
              )}
            </button>
          )
        })}
        {total === 0 && <span className={styles.dim}>No addons registered.</span>}
        <span className={styles.spacer} />
        <button className={styles.tab} title="Re-read the runtime addon registry (new addons appear without a rebuild)" onClick={() => void loadRuntime()}>
          <RefreshCw size={12} />
        </button>
      </div>
      <div className={styles.body}>
        {ADDONS.filter((a) => visited.has(a.id)).map((a) => (
          <AddonView key={a.id} addon={a} visible={active === a.id} />
        ))}
        {runtime.filter((a) => visited.has(a.id)).map((a) => (
          <RuntimeAddonView key={a.id} addon={a} visible={active === a.id} theme={theme} />
        ))}
      </div>
    </div>
  )
}
