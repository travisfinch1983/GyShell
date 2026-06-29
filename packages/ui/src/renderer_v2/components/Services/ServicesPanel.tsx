import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Radar, Pencil, ExternalLink } from 'lucide-react'
import { servicesStore, iconUrl, type DiscoveryHost, type DiscoveredService } from '../../stores/ServicesStore'
import styles from './Services.module.scss'

const TYPE_BADGE: Record<string, string> = { lxc: 'CT', qemu: 'VM', node: 'NODE', static: 'HOST' }

const ServiceRow: React.FC<{ host: DiscoveryHost; svc: DiscoveredService }> = observer(({ host, svc }) => {
  const { name, reliable } = servicesStore.resolveName(host.hostId, svc)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const startEdit = () => {
    setDraft(name === 'Unknown' ? '' : name)
    setEditing(true)
  }
  const commit = () => {
    void servicesStore.setCustomName(host.hostId, svc.port, draft)
    setEditing(false)
  }

  return (
    <div className={`${styles.svc} ${reliable ? '' : styles.svcUnknown}`}>
      <span className={`${styles.dot} ${reliable ? styles.on : styles.off}`} />
      {editing ? (
        <input
          className={styles.svcEdit}
          autoFocus
          value={draft}
          placeholder="custom name (blank = clear)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commit}
        />
      ) : (
        (() => {
          const ico = iconUrl(svc.icon)
          const inner = (
            <>
              {ico && <img className={styles.svcIco} src={ico} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
              <span className={styles.svcName}>{name}</span>
              <span className={styles.svcPort}>:{svc.port}</span>
              {svc.knownScript && <span className={styles.svcTag} title="community-scripts app">CS</span>}
              {svc.url && <ExternalLink size={11} className={styles.extIcon} />}
            </>
          )
          // web service → open its real URL (proto-aware); raw tcp port → no link
          return svc.url ? (
            <a className={styles.svcLink} href={svc.url} target="_blank" rel="noreferrer" title={`${svc.process || ''} · ${svc.proto} ${svc.status ?? ''} · open`}>
              {inner}
            </a>
          ) : (
            <span className={`${styles.svcLink} ${styles.svcNoLink}`} title={`${svc.process || ''} · ${svc.proto || 'tcp'}`}>{inner}</span>
          )
        })()
      )}
      <button className={styles.editBtn} title="Rename" onClick={startEdit}>
        <Pencil size={12} />
      </button>
    </div>
  )
})

const HostCard: React.FC<{ host: DiscoveryHost }> = observer(({ host }) => {
  const scanning = servicesStore.scanningHost === host.hostId
  return (
    <div className={`${styles.card} ${host.error ? styles.cardError : ''}`}>
      <div className={styles.cardHead}>
        <span className={styles.typeBadge}>{TYPE_BADGE[host.guestType] ?? '?'}</span>
        <span className={styles.hostName}>{host.hostName}</span>
        <span className={styles.svcCount}>{host.error ? 'error' : `${host.services.length} svc`}</span>
        <button className={styles.rescanBtn} title="Rescan host" disabled={scanning} onClick={() => void servicesStore.rescanHost(host.hostId)}>
          <RefreshCw size={12} className={scanning ? styles.spin : ''} />
        </button>
      </div>
      <div className={styles.cardSub}>
        {host.hostIp}
        {host.node ? ` · ${host.node}` : ''}
        {host.vmid != null ? ` · ${host.vmid}` : ''}
      </div>
      {host.error ? (
        <div className={styles.cardErr}>{host.error}</div>
      ) : host.services.length === 0 ? (
        <div className={styles.cardEmpty}>no listening services</div>
      ) : (
        <div className={styles.svcList}>
          {host.services.map((s) => (
            <ServiceRow key={s.port} host={host} svc={s} />
          ))}
        </div>
      )}
    </div>
  )
})

export const ServicesPanel: React.FC = observer(() => {
  useEffect(() => {
    servicesStore.startPolling(30000)
    return () => servicesStore.stopPolling()
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Radar size={16} className={styles.headerIcon} />
        <span className={styles.title}>Services</span>
        <span className={styles.counts}>
          {servicesStore.hosts.length} hosts · {servicesStore.serviceCount} services
        </span>
        <input
          className={styles.filter}
          placeholder="Filter host / ip / port / process…"
          value={servicesStore.filter}
          onChange={(e) => servicesStore.setFilter(e.target.value)}
        />
        <div className={styles.spacer} />
        {servicesStore.lastUpdated && (
          <span className={styles.updated}>updated {new Date(servicesStore.lastUpdated).toLocaleTimeString()}</span>
        )}
        <button className={styles.scanBtn} disabled={servicesStore.scanningAll} onClick={() => void servicesStore.rescanAll()}>
          <RefreshCw size={13} className={servicesStore.scanningAll ? styles.spin : ''} /> Rescan all
        </button>
      </div>

      {servicesStore.error && <div className={styles.errorBar}>Discovery error — {servicesStore.error}</div>}
      {!servicesStore.lastUpdated && !servicesStore.error && <div className={styles.loading}>Loading discovery…</div>}

      <div className={styles.body}>
        <div className={styles.grid}>
          {servicesStore.filteredHosts.map((h) => (
            <HostCard key={h.hostId} host={h} />
          ))}
        </div>
      </div>
    </div>
  )
})
