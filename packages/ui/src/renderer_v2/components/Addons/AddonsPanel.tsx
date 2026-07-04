import React, { useState } from 'react'
import { ADDONS, ADDON_ICONS, NATIVE_VIEWS, type AddonManifest } from './addonRegistry'
import styles from './Addons.module.scss'

/**
 * Addons primary tab — manifest-driven (see addonRegistry.ts for the ratified
 * schema). Addons tab → addon sub-tab → inner view tabs; each view is either a
 * native React component (NATIVE_VIEWS lookup) or a same-origin embed. Views
 * stay mounted once visited (display swap) so addon state survives switches.
 */
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

export const AddonsPanel: React.FC = () => {
  const [active, setActive] = useState<string>(ADDONS[0]?.id ?? '')
  const [visited, setVisited] = useState<Set<string>>(new Set(active ? [active] : []))

  const pick = (id: string) => {
    setActive(id)
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)))
  }

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
        {ADDONS.length === 0 && <span className={styles.dim}>No addons registered.</span>}
      </div>
      <div className={styles.body}>
        {ADDONS.filter((a) => visited.has(a.id)).map((a) => (
          <AddonView key={a.id} addon={a} visible={active === a.id} />
        ))}
      </div>
    </div>
  )
}
