import React, { useState } from 'react'
import { Blocks } from 'lucide-react'
import { ADDONS, type AddonDef } from './addonRegistry'
import styles from './Addons.module.scss'

/**
 * Addons primary tab — hosts external webUIs as sub-tabs (registry-driven; see
 * addonRegistry.ts for how to add one). Addons tab → addon sub-tab → optional
 * inner sub-tabs when the addon UI is itself multi-page. Iframes stay mounted
 * once visited (display:none swap) so addon state survives tab switches.
 */
const AddonView: React.FC<{ addon: AddonDef; visible: boolean }> = ({ addon, visible }) => {
  const [inner, setInner] = useState(addon.subtabs?.[0]?.id ?? null)
  const src = addon.subtabs?.find((s) => s.id === inner)?.path ?? addon.path
  return (
    <div className={styles.addonView} style={{ display: visible ? 'flex' : 'none' }}>
      {addon.subtabs && addon.subtabs.length > 0 && (
        <div className={styles.innerTabs}>
          {addon.subtabs.map((s) => (
            <button key={s.id} className={`${styles.tab} ${inner === s.id ? styles.tabActive : ''}`} onClick={() => setInner(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      <iframe key={src} className={styles.frame} src={src} title={addon.label} />
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
          const Icon = a.Icon ?? Blocks
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
