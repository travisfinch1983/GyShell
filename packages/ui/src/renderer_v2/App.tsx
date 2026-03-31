import React from 'react'
import { observer } from 'mobx-react-lite'
import { AppStore } from './stores/AppStore'
import { MinionStore } from './stores/MinionStore'
import { TopBar } from './components/TopBar/TopBar'
import { SettingsView } from './components/Settings/SettingsView'
import { ConnectionsView } from './components/Connections/ConnectionsView'
import { ConfirmDialog } from './components/Common/ConfirmDialog'
import { LayoutWorkspace } from './components/Layout/LayoutWorkspace'
import { MinionCards } from './components/Minions/MinionCards'
import './styles/app.scss'

const store = new AppStore()
const minionStore = new MinionStore()

// Expose minionStore globally for debugging and external access
;(window as any).__minionStore = minionStore

export const App: React.FC = observer(() => {
  React.useEffect(() => {
    store.bootstrap().then(() => {
      // Initialize minion cards from active profile
      initMinionsFromProfile()
    })
  }, [])

  function initMinionsFromProfile() {
    const settings = store.settings
    if (!settings?.models) return
    const profile = settings.models.profiles.find(
      (p: any) => p.id === settings.models.activeProfileId
    )
    if (!profile) return
    const items = settings.models.items

    const roleMap: Array<{ roleKey: string; role: any; label: string }> = [
      { roleKey: 'globalModelId', role: 'orchestrator', label: 'Orchestrator' },
      { roleKey: 'actionModelId', role: 'action', label: 'Action' },
      { roleKey: 'thinkingModelId', role: 'thinking', label: 'Thinking' },
      { roleKey: 'compactionModelId', role: 'compaction', label: 'Compaction' },
      { roleKey: 'coderModelId', role: 'coder', label: 'Coder' },
      { roleKey: 'creativeModelId', role: 'creative', label: 'Creative' },
      { roleKey: 'architectModelId', role: 'architect', label: 'Architect' },
      { roleKey: 'scoutModelId', role: 'scout', label: 'Scout' },
    ]

    const seen = new Set<string>()
    for (const { roleKey, role, label } of roleMap) {
      const modelId = (profile as any)[roleKey]
      if (!modelId || seen.has(modelId + role)) continue
      seen.add(modelId + role)
      const item = items.find((m: any) => m.id === modelId)
      if (!item) continue
      minionStore.registerMinion({
        id: `${modelId}-${role}`,
        role,
        friendlyName: label,
        modelName: item.name || item.model || modelId,
        status: item.profile?.ok ? 'idle' : 'disconnected',
        connected: item.profile?.ok === true,
      })
    }
  }

  React.useEffect(() => {
    const canHandleNativeFileDrop = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null
      if (!element || typeof element.closest !== 'function') {
        return false
      }
      return Boolean(
        element.closest('.xterm-host, .filesystem-list, .rich-input-editor')
      )
    }

    const isNativeFileDrag = (event: DragEvent): boolean => {
      const types = Array.from(event.dataTransfer?.types || [])
      return types.includes('Files')
    }

    const handleDragOver = (event: DragEvent) => {
      if (!isNativeFileDrag(event)) return
      if (canHandleNativeFileDrop(event.target)) return
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none'
      }
    }

    const handleDrop = (event: DragEvent) => {
      if (!isNativeFileDrag(event)) return
      if (canHandleNativeFileDrop(event.target)) return
      event.preventDefault()
    }

    window.addEventListener('dragover', handleDragOver, true)
    window.addEventListener('drop', handleDrop, true)
    return () => {
      window.removeEventListener('dragover', handleDragOver, true)
      window.removeEventListener('drop', handleDrop, true)
    }
  }, [])

  const platform = (window as any)?.gyshell?.system?.platform
  const t = store.i18n.t
  const versionInfo = store.versionInfo
  const hasVersionDifference =
    !!versionInfo &&
    versionInfo.status !== 'error' &&
    typeof versionInfo.latestVersion === 'string' &&
    versionInfo.latestVersion.length > 0 &&
    versionInfo.latestVersion !== versionInfo.currentVersion
  const platformClass =
    platform === 'win32'
      ? 'platform-windows'
      : platform === 'darwin'
      ? 'platform-darwin'
      : platform === 'linux'
      ? 'platform-linux'
      : navigator.userAgent.toLowerCase().includes('windows')
      ? 'platform-windows'
      : 'platform-darwin'

  return (
    <div className={`gyshell ${platformClass}`}>
      <ConfirmDialog
        open={store.showVersionUpdateDialog && hasVersionDifference}
        title={t.settings.versionUpdateTitle}
        message={`${versionInfo?.status === 'update-available'
          ? t.settings.versionUpdateMessage(versionInfo?.currentVersion || '-', versionInfo?.latestVersion || '-')
          : t.settings.versionDifferentMessage(versionInfo?.currentVersion || '-', versionInfo?.latestVersion || '-')
        }\n\n${t.settings.versionCheckNote}`}
        confirmText={t.settings.goToDownload}
        cancelText={t.common.close}
        onCancel={() => store.closeVersionUpdateDialog()}
        onConfirm={() => {
          void store.openVersionDownload()
          store.closeVersionUpdateDialog()
        }}
      />

      <TopBar store={store} />

      <div className="gyshell-body">
        <div className="gyshell-minion-sidebar">
          <MinionCards store={minionStore} />
        </div>
        <div className="gyshell-main">
          <LayoutWorkspace store={store} />
        </div>

        {/* Settings is an overlay so we don't unmount terminals (xterm state stays alive) */}
        <div
          className={`gyshell-overlay settings-overlay${store.view === 'settings' ? ' is-open' : ''}`}
        >
          <SettingsView store={store} />
        </div>

        <div
          className={`gyshell-overlay connections-overlay${store.view === 'connections' ? ' is-open' : ''}`}
        >
          <ConnectionsView store={store} />
        </div>
      </div>
    </div>
  )
})
