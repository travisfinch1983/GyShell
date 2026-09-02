import React from 'react'
import { observer } from 'mobx-react-lite'
import { Bell, Server, Settings, Square } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { aiServicesStore } from '../../stores/AiServicesStore'
import { notificationsStore } from '../../stores/NotificationsStore'
import { NotificationsPanel } from '../Notifications/NotificationsPanel'
import { isLinux } from '../../platform/platform'
import './topbar.scss'

const gyshell = () => (window as any)?.gyshell

export const TopBar: React.FC<{
  store: AppStore
  servicesOpen: boolean
  onServicesToggle: () => void
}> = observer(({ store, servicesOpen, onServicesToggle }) => {
  const linux = isLinux()

  React.useEffect(() => {
    if (!aiServicesStore.loaded) void aiServicesStore.load()
  }, [])

  const serviceCount = aiServicesStore.services.length
  const handleMaximize = () => gyshell()?.windowControls?.maximize?.()

  const [notifOpen, setNotifOpen] = React.useState(false)
  React.useEffect(() => {
    // Badge must be live without opening the panel — that's its whole job.
    void notificationsStore.ensureLoaded()
  }, [])
  const worst = notificationsStore.worstSeverity
  const badgeCount = notificationsStore.badgeCount

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-title">AI-Lab</div>
      </div>

      {/* Running-services toggle — centered in the header so it's an easy target
          (it used to live in the collapsed model sidebar, too small + easy to
          mis-click into the chat overlay). */}
      <div className="topbar-center">
      {/* Notifications — immediately LEFT of Services (Travis's spec). Badge colour
          IS the severity scale: yellow=warning, orange=error, red=critical. */}
      <button
        className={`topbar-services-btn${notifOpen ? ' active' : ''}`}
        onClick={() => setNotifOpen((o) => !o)}
        title="Notifications: health, warnings & errors, debug console"
      >
        <Bell size={14} strokeWidth={2} />
        <span>Notifications</span>
        {badgeCount > 0 && worst && (
          <span className={`topbar-notif-badge topbar-notif-${worst}`}>{badgeCount}</span>
        )}
        {badgeCount === 0 && notificationsStore.hasUnknown && (
          <span className="topbar-notif-badge topbar-notif-unknown" title="Some health checks cannot run">?</span>
        )}
        {notificationsStore.runningTaskCount > 0 && (
          <span className="topbar-notif-badge topbar-notif-tasks" title={`${notificationsStore.runningTaskCount} tracked task(s) running`}>
            {notificationsStore.runningTaskCount}
          </span>
        )}
      </button>
      <button
        className={`topbar-services-btn${servicesOpen ? ' active' : ''}`}
        onClick={onServicesToggle}
        title={servicesOpen ? 'Close running services' : 'Open running services'}
      >
        <Server size={14} strokeWidth={2} />
        <span>Services</span>
        {serviceCount > 0 && <span className="topbar-services-badge">{serviceCount}</span>}
      </button>

      {/* Settings in the header too — the sidebar-bottom button is unreachable on
          mobile (viewport cuts the sidebar before its footer), so the phone had NO
          way into Settings at all. Same overlay, second door. */}
      <button
        className="topbar-services-btn"
        onClick={() => store.toggleSettings()}
        title="Open settings"
      >
        <Settings size={14} strokeWidth={2} />
        <span>Settings</span>
      </button>
      </div>

      {notifOpen && <NotificationsPanel onClose={() => setNotifOpen(false)} />}

      {linux ? (
        <div className="linux-wc">
          {/* Minimize + Close removed — desktop holdovers, irrelevant in the web build. */}
          <button className="linux-wc-btn" title="Maximize" onClick={handleMaximize}>
            <Square size={11} strokeWidth={2} />
          </button>
        </div>
      ) : null}
    </div>
  )
})
