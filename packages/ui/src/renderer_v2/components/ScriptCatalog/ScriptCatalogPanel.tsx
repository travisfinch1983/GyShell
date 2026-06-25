import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Package, Search, Settings } from 'lucide-react'
import { scriptCatalogStore as store, type CatalogScript } from '../../stores/ScriptCatalogStore'
import { DetailModal, GlobalDefaultsModal } from './ScriptCatalogForms'
import { InstallTerminal, type InstallSession } from './InstallTerminal'
import styles from './ScriptCatalog.module.scss'

function fmtRes(r?: CatalogScript['resources']): string {
  if (!r) return ''
  const parts: string[] = []
  if (r.cpu) parts.push(`${r.cpu}C`)
  if (r.ram) parts.push(`${Math.round(r.ram / 1024)}G`)
  if (r.disk) parts.push(`${r.disk}G`)
  const base = parts.join(' / ')
  const os = r.os ? `${r.os}${r.version ? ' ' + r.version : ''}` : ''
  return [base, os].filter(Boolean).join(' · ')
}

const Logo: React.FC<{ s: CatalogScript; size: number }> = ({ s, size }) => {
  const [err, setErr] = useState(false)
  if (s.logo && !err) {
    return <img src={s.logo} width={size} height={size} alt="" className={styles.logoImg} onError={() => setErr(true)} loading="lazy" />
  }
  return (
    <div className={styles.logoFallback} style={{ width: size, height: size, fontSize: size * 0.5 }}>
      {(s.name || '?').charAt(0).toUpperCase()}
    </div>
  )
}

export const ScriptCatalogPanel: React.FC = observer(() => {
  const [detail, setDetail] = useState<CatalogScript | null>(null)
  const [showDefaults, setShowDefaults] = useState(false)
  const [install, setInstall] = useState<InstallSession | null>(null)
  useEffect(() => {
    void store.load()
  }, [])

  const c = store.counts
  const cats = store.catalog?.categories ?? []

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Package size={16} className={styles.headerIcon} />
        <span className={styles.title}>Helper Scripts</span>
        <div className={styles.searchWrap}>
          <Search size={13} className={styles.searchIcon} />
          <input className={styles.search} placeholder="Search scripts…" value={store.search} onChange={(e) => store.setSearch(e.target.value)} />
        </div>
        <div className={styles.spacer} />
        {store.catalog?.lastSync && <span className={styles.updated}>synced {new Date(store.catalog.lastSync).toLocaleString()}</span>}
        <button className={styles.syncBtn} title="Global install defaults" onClick={() => setShowDefaults(true)}>
          <Settings size={13} /> Defaults
        </button>
        <button className={styles.syncBtn} disabled={store.syncing} onClick={() => void store.sync()}>
          <RefreshCw size={13} className={store.syncing ? styles.spin : ''} /> {store.syncing ? `${store.syncProgress}%` : 'Sync'}
        </button>
      </div>

      {store.syncing && <div className={styles.syncBar}>{store.syncStep} ({store.syncProgress}%)</div>}
      {store.error && <div className={styles.errorBar}>Catalog error — {store.error}</div>}
      {!store.loaded && !store.error && <div className={styles.loading}>Loading catalog…</div>}

      {store.loaded && (
        <div className={styles.body}>
          <div className={styles.sidebar}>
            <button className={`${styles.cat} ${store.activeCategory === 'all' ? styles.catActive : ''}`} onClick={() => store.setCategory('all')}>
              All Scripts <span className={styles.catCount}>{c.all}</span>
            </button>
            <button className={`${styles.cat} ${store.activeCategory === 'proxlab' ? styles.catActive : ''}`} onClick={() => store.setCategory('proxlab')}>
              ProxLab <span className={styles.catCount}>{c.proxlab}</span>
            </button>
            <button className={`${styles.cat} ${store.activeCategory === 'community' ? styles.catActive : ''}`} onClick={() => store.setCategory('community')}>
              Community <span className={styles.catCount}>{c.community}</span>
            </button>
            <div className={styles.catSep} />
            {cats.map((cat) => (
              <button key={cat.name} className={`${styles.cat} ${store.activeCategory === cat.name ? styles.catActive : ''}`} onClick={() => store.setCategory(cat.name)}>
                <span className={styles.catName}>{cat.name}</span> <span className={styles.catCount}>{cat.count}</span>
              </button>
            ))}
          </div>

          <div className={styles.gridWrap}>
            {install && <InstallTerminal session={install} onClose={() => setInstall(null)} />}
            <div className={styles.gridStats}>{store.filteredScripts.length} shown</div>
            <div className={styles.grid}>
              {store.filteredScripts.map((s) => (
                <button key={s.slug} className={styles.card} onClick={() => setDetail(s)}>
                  <Logo s={s} size={28} />
                  <div className={styles.cardInfo}>
                    <div className={styles.cardName}>{s.name}</div>
                    {fmtRes(s.resources) && <div className={styles.cardRes}>{fmtRes(s.resources)}</div>}
                    {s.description && <div className={styles.cardDesc}>{s.description}</div>}
                  </div>
                  {s.source === 'proxlab' && <span className={`${styles.srcBadge} ${styles.proxlab}`}>PL</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {detail && (
        <DetailModal
          s={detail}
          onClose={() => setDetail(null)}
          onRun={(hostIp, nodeName, command) => {
            const name = detail.name
            setDetail(null)
            setInstall({ scriptName: name, hostIp, nodeName, command })
          }}
        />
      )}
      {showDefaults && <GlobalDefaultsModal onClose={() => setShowDefaults(false)} />}
    </div>
  )
})
