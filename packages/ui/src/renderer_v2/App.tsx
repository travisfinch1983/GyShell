import React, { useState, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { SlidersHorizontal, Plus } from 'lucide-react'
import { AppStore } from './stores/AppStore'
import { MinionStore } from './stores/MinionStore'
import { MinionProvider } from './stores/MinionContext'
import { MinionRouter, rehydrateMinionMessages } from './services/MinionRouter'
import { startDiscovery } from './services/ProxlabDiscovery'
import { TranscriptService } from './services/TranscriptService'
import { TopBar } from './components/TopBar/TopBar'
import { SettingsView } from './components/Settings/SettingsView'
import { ConnectionsView } from './components/Connections/ConnectionsView'
import { ConfirmDialog } from './components/Common/ConfirmDialog'
import { LayoutWorkspace } from './components/Layout/LayoutWorkspace'
import { MinionSidebar } from './components/Minions/MinionSidebar'
import { PrimarySidebar, type PrimaryTab } from './components/PrimarySidebar/PrimarySidebar'
import { GlobalChat } from './components/Chat/GlobalChat'
import './styles/app.scss'

const store = new AppStore()
const minionStore = new MinionStore()

const minionRouter = new MinionRouter(minionStore)
const transcriptService = new TranscriptService()
transcriptService.runRetentionCleanup()

// Expose globally for debugging and external access
;(window as any).__appStore = store
;(window as any).__minionStore = minionStore
;(window as any).__minionRouter = minionRouter
;(window as any).__transcriptService = transcriptService

export const App: React.FC = observer(() => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('minion-sidebar-collapsed') === 'true'
  )
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev
      localStorage.setItem('minion-sidebar-collapsed', String(next))
      return next
    })
  }, [])

  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>(
    () => (localStorage.getItem('ai-lab-primary-tab') as PrimaryTab) || 'terminal'
  )
  const handlePrimaryTabChange = useCallback((id: PrimaryTab) => {
    setPrimaryTab(id)
    localStorage.setItem('ai-lab-primary-tab', id)
  }, [])

  React.useEffect(() => {
    store.bootstrap().then(() => {
      // Initialize minion cards from active profile
      initMinionsFromProfile()
      // Hook into UI updates to drive minion status
      setupMinionStatusListener()
      // Start ProxLab model discovery (auto-registers models from LLM proxy)
      startDiscovery()
      // Re-init minion cards after discovery completes (models may have been synced)
      setTimeout(() => initMinionsFromProfile(), 5000)
      // Re-inject persisted minion messages after a short delay
      // (ChatStore needs time to hydrate sessions first)
      setTimeout(() => {
        rehydrateMinionMessages()
        // Clear any lingering busy/thinking state from previous sessions
        // This prevents the red stop button from appearing on page load
        if (store.chat?.sessions) {
          for (const session of store.chat.sessions) {
            store.chat.setThinking(false, session.id)
            store.chat.setSessionBusy(false, session.id)
          }
        }
      }, 2000)
    })
  }, [])

  function setupMinionStatusListener() {
    // Listen for agent UI updates to track model activity
    window.gyshell.agent.onUiUpdate((action: any) => {
      if (!action) return
      const { type } = action

      // Get the orchestrator minion (global model drives the main session)
      const orchestrator = minionStore.getMinionByRole('orchestrator')
      if (!orchestrator) return

      if (type === 'ADD_MESSAGE') {
        const msg = action.message
        if (!msg) return

        // Map message types to minion status
        if (msg.role === 'assistant') {
          switch (msg.type) {
            case 'reasoning':
              minionStore.updateMinionStatus(orchestrator.id, 'thinking')
              break
            case 'command': {
              const cmd = msg.metadata?.command || msg.content?.substring(0, 40)
              minionStore.updateMinionStatus(orchestrator.id, 'running-command', cmd)
              break
            }
            case 'tool_call': {
              const toolName = msg.metadata?.toolName || 'tool'
              const { status, detail } = MinionStore.toolToStatus(toolName)
              minionStore.updateMinionStatus(orchestrator.id, status, detail)
              break
            }
            case 'file_edit': {
              const action = msg.metadata?.action
              const file = msg.metadata?.filePath || ''
              if (action === 'created') {
                minionStore.updateMinionStatus(orchestrator.id, 'writing-file', file)
              } else {
                minionStore.updateMinionStatus(orchestrator.id, 'editing-file', file)
              }
              break
            }
            case 'sub_tool': {
              const hint = msg.metadata?.subToolHint || msg.metadata?.subToolTitle || ''
              minionStore.updateMinionStatus(orchestrator.id, 'using-tool', hint)
              break
            }
            case 'compaction':
              minionStore.updateMinionStatus(orchestrator.id, 'compacting')
              break
            case 'text':
              minionStore.updateMinionStatus(orchestrator.id, 'generating')
              break
            case 'error':
              minionStore.updateMinionStatus(orchestrator.id, 'error', msg.content?.substring(0, 50))
              break
          }
        } else if (msg.role === 'user') {
          // User sent a message — model will start thinking
          minionStore.updateMinionStatus(orchestrator.id, 'thinking')
        }
      } else if (type === 'DONE') {
        minionStore.updateMinionStatus(orchestrator.id, 'idle')
      } else if (type === 'APPEND_CONTENT' || type === 'APPEND_OUTPUT') {
        // Model is actively generating
        if (orchestrator.status === 'thinking') {
          minionStore.updateMinionStatus(orchestrator.id, 'generating')
        }
      }
    })
  }

  function initMinionsFromProfile() {
    const settings = store.settings
    if (!settings?.models) return
    const profile = settings.models.profiles.find(
      (p: any) => p.id === settings.models.activeProfileId
    )
    if (!profile) return
    const items = settings.models.items

    // Order matches sidebar: selectable roles first, then internal
    const roleMap: Array<{ roleKey: string; role: any; label: string }> = [
      { roleKey: 'chatModelId', role: 'chat', label: 'Chat' },
      { roleKey: 'coderModelId', role: 'coder', label: 'Coder' },
      { roleKey: 'creativeModelId', role: 'creative', label: 'Creative' },
      { roleKey: 'architectModelId', role: 'architect', label: 'Architect' },
      { roleKey: 'scoutModelId', role: 'scout', label: 'Scout' },
      { roleKey: 'globalModelId', role: 'orchestrator', label: 'Orchestrator' },
      { roleKey: 'actionModelId', role: 'action', label: 'Action' },
      { roleKey: 'thinkingModelId', role: 'thinking', label: 'Thinking' },
      { roleKey: 'compactionModelId', role: 'compaction', label: 'Compaction' },
    ]

    const seen = new Set<string>()
    for (const { roleKey, role, label } of roleMap) {
      const modelId = (profile as any)[roleKey]
      if (!modelId || seen.has(modelId + role)) continue
      seen.add(modelId + role)
      const item = items.find((m: any) => m.id === modelId)
      if (!item) continue
      // ProxLab auto-discovered models are available by definition
      const isProxlab = item._proxlabAutoDiscovered === true
      const isActive = isProxlab || item.profile?.ok === true
      minionStore.registerMinion({
        id: `${modelId}-${role}`,
        role,
        friendlyName: label,
        modelName: item.name || item.model || modelId,
        status: isActive ? 'idle' : 'disconnected',
        connected: isActive,
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
    <MinionProvider value={minionStore}>
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
        <PrimarySidebar
          activeTab={primaryTab}
          onTabChange={handlePrimaryTabChange}
          onSettingsClick={() => store.toggleSettings()}
        />

        {/* Model sidebar is now ALWAYS visible, regardless of active tab. */}
        <div className={`gyshell-minion-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
          <MinionSidebar store={minionStore} collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />
        </div>

        {/*
          Tab content area. Each tab fills the area absolutely so we don't have
          to fight flex sizing. LayoutWorkspace stays mounted across tab
          switches (just hidden) so xterm sessions don't unmount.
          The GlobalChat overlay sits on top of this whole area when the model
          sidebar is expanded.
        */}
        <div className="gyshell-main" style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: primaryTab === 'terminal' ? 'block' : 'none',
              position: 'absolute',
              inset: 0,
            }}
          >
            <LayoutWorkspace store={store} />
          </div>

          {primaryTab === 'flowchart' && (
            <PlaceholderPanel
              title="Flowchart"
              body="Visual structure builder coming in Phase 2 — port of the xyflow-based diagram tool from claude-dhb, generalized for rect / circle / group shapes with nesting + a saved diagram library."
            />
          )}
          {primaryTab === 'files' && (
            <PlaceholderPanel
              title="Files"
              body="The Files panel will be extracted from the multi-panel terminal layout and rendered here as a top-level workspace tab."
            />
          )}
          {primaryTab === 'monitor' && (
            <PlaceholderPanel
              title="Monitor"
              body="The Monitor panel will be extracted from the multi-panel terminal layout and rendered here as a top-level workspace tab."
            />
          )}

          {/* Terminal-scoped action buttons — only visible on the Terminal tab.
              Always present even when no terminal tabs are open, so the user
              can always spawn a new one. */}
          {primaryTab === 'terminal' && (
            <div
              style={{
                position: 'absolute',
                top: 6,
                right: 8,
                zIndex: 5,
                display: 'flex',
                gap: 4,
              }}
            >
              <button
                className="icon-btn"
                title="New terminal tab"
                onClick={() => store.createLocalTab(undefined, { ensurePanel: true })}
              >
                <Plus size={16} strokeWidth={2} />
              </button>
              <button
                className="icon-btn"
                title={store.i18n.t.connections.title}
                onClick={() => store.openConnections()}
              >
                <SlidersHorizontal size={16} strokeWidth={2} />
              </button>
            </div>
          )}

          {/* Global chat overlay — visible whenever the model sidebar is expanded. */}
          <GlobalChat store={store} visible={!sidebarCollapsed} />
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
    </MinionProvider>
  )
})

const PlaceholderPanel: React.FC<{ title: string; body: string }> = ({ title, body }) => (
  <div style={{
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--fg-muted)',
    gap: 12,
    padding: 32,
    textAlign: 'center',
  }}>
    <h2 style={{ margin: 0, color: 'var(--fg)', fontWeight: 500 }}>{title}</h2>
    <p style={{ margin: 0, maxWidth: 480, lineHeight: 1.5 }}>{body}</p>
  </div>
)
