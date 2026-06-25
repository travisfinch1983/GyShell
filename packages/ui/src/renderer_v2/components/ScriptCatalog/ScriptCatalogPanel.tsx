import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Package, Search, X, ExternalLink, Copy, Check } from 'lucide-react'
import { scriptCatalogStore as store, type CatalogScript } from '../../stores/ScriptCatalogStore'
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

function installCommand(s: CatalogScript): string {
  return s.installUrl ? `bash -c "$(curl -fsSL ${s.installUrl})"` : ''
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

const DetailModal: React.FC<{ s: CatalogScript; onClose: () => void }> = ({ s, onClose }) => {
  const [copied, setCopied] = useState(false)
  const cmd = installCommand(s)
  const copy = () => {
    if (cmd) {
      navigator.clipboard?.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
  }
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <Logo s={s} size={32} />
          <div className={styles.modalTitleWrap}>
            <div className={styles.modalTitle}>{s.name}</div>
            <span className={`${styles.srcBadge} ${s.source === 'proxlab' ? styles.proxlab : styles.community}`}>{s.source}</span>
          </div>
          <button className={styles.iconBtn} onClick={onClose}><X size={16} /></button>
        </div>
        {s.description && <div className={styles.modalDesc}>{s.description}</div>}
        <div className={styles.modalMeta}>
          {fmtRes(s.resources) && <span>{fmtRes(s.resources)}</span>}
          {s.interfacePort ? <span>port {s.interfacePort}</span> : null}
          {s.privileged ? <span className={styles.privTag}>privileged</span> : null}
        </div>
        {(s.tags ?? []).length > 0 && (
          <div className={styles.tagRow}>
            {s.tags!.map((t) => <span key={t} className={styles.tag}>{t}</span>)}
          </div>
        )}
        {(s.notes ?? []).map((n, i) => (
          <div key={i} className={`${styles.note} ${styles['note_' + (n.type || 'info')] ?? ''}`}>{n.text}</div>
        ))}
        <div className={styles.links}>
          {s.website && <a href={s.website} target="_blank" rel="noreferrer">Website <ExternalLink size={11} /></a>}
          {s.documentation && <a href={s.documentation} target="_blank" rel="noreferrer">Docs <ExternalLink size={11} /></a>}
          {s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noreferrer">Source <ExternalLink size={11} /></a>}
        </div>
        {cmd && (
          <div className={styles.cmdBlock}>
            <div className={styles.cmdLabel}>Install command (run as root on a Proxmox node)</div>
            <div className={styles.cmdRow}>
              <code className={styles.cmd}>{cmd}</code>
              <button className={styles.copyBtn} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}</button>
            </div>
            <div className={styles.cmdNote}>In-app one-click install lands with the native terminal stream (finalization).</div>
          </div>
        )}
      </div>
    </div>
  )
}

export const ScriptCatalogPanel: React.FC = observer(() => {
  const [detail, setDetail] = useState<CatalogScript | null>(null)
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

      {detail && <DetailModal s={detail} onClose={() => setDetail(null)} />}
    </div>
  )
})
