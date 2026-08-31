import React, { useState, useCallback } from 'react'
import { reaction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { AppStore } from './stores/AppStore'
import { startDiscovery } from './services/ProxlabDiscovery'
import { TranscriptService } from './services/TranscriptService'
import { TopBar } from './components/TopBar/TopBar'
import { SettingsView } from './components/Settings/SettingsView'
import { ConnectionsView } from './components/Connections/ConnectionsView'
import { ConfirmDialog } from './components/Common/ConfirmDialog'
import { ConfirmHost } from './components/Common/ConfirmHost'
import { PromptHost } from './components/Common/PromptHost'
import { TerminalWorkspace } from './components/Terminal/TerminalWorkspace'
import { AgentRail } from './components/AgentRail/AgentRail'
import { PrimarySidebar, type PrimaryTab } from './components/PrimarySidebar/PrimarySidebar'
import { GlobalChat } from './components/Chat/GlobalChat'
import { AgentChatPanel } from './components/AgentChat/AgentChatPanel'
import { FlowchartPanel } from './components/Flowchart/FlowchartPanel'
import { PagesPanel } from './components/Pages/PagesPanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SvgPanel } from './components/Svg/SvgPanel'
import { FleetPanel } from './components/Fleet/FleetPanel'
import { AddonsPanel } from './components/Addons/AddonsPanel'
import { ContextMenuOverlay } from './components/Common/ContextMenuOverlay'
import { ClusterPanel } from './components/Cluster/ClusterPanel'
import { ServicesPanel } from './components/Services/ServicesPanel'
import { ScriptsTabPanel } from './components/Scripts/ScriptsTabPanel'
import { HomePanel } from './components/Home/HomePanel'
import { FilesPanel } from './components/FileManager/FilesPanel'
import { RoadmapPanel } from './components/Roadmap/RoadmapPanel'
import { AiServicesPanel } from './components/AiServices/AiServicesPanel'
import { ServicesDrawer } from './components/AiServices/ServicesDrawer'
import { GpuFleetPanel } from './components/GpuFleet/GpuFleetPanel'
import { ModelDownloadsPanel } from './components/ModelDownloads/ModelDownloadsPanel'
import { LogsPanel } from './components/Logs/LogsPanel'
import { AiLlmPanel, AiImagePanel, AiTtsSttPanel, AiToolsPanel } from './components/AiModality/AiModalityPanels'
import { ClaudePanel } from './components/Claude/ClaudePanel'
import { liveConsoleStore } from './stores/LiveConsoleStore'
import './styles/app.scss'

const store = new AppStore()
const transcriptService = new TranscriptService()
transcriptService.runRetentionCleanup()

// Expose globally for debugging and external access
;(window as any).__appStore = store
;(window as any).__transcriptService = transcriptService

export const App: React.FC = observer(() => {
  // The model/agent sidebar is permanently collapsed to its icon strip — its
  // expand affordance was removed in favor of always-on icons (model + agent
  // shortcuts with status badges). The chat overlay's visibility is now its
  // own state so opening the chat doesn't expand the sidebar and vice versa.
  // Chat-open is PER-BROWSER-TAB (sessionStorage) — a reload restores this
  // tab's own state instead of whichever tab toggled last (the old shared
  // localStorage key made every reloading tab pop the chat open). localStorage
  // stays as the write-through seed for brand-new tabs only.
  const [chatOpen, setChatOpen] = useState(() => {
    try {
      const perTab = sessionStorage.getItem('ai-lab-chat-open')
      if (perTab != null) return perTab === 'true'
    } catch { /* private mode */ }
    return localStorage.getItem('ai-lab-chat-open') === 'true'
  })
  // Always start collapsed on page load (don't restore a previously-open state).
  const [servicesDrawerOpen, setServicesDrawerOpen] = useState(false)
  const toggleServicesDrawer = useCallback(() => {
    setServicesDrawerOpen(prev => {
      const next = !prev
      localStorage.setItem('ai-lab-services-drawer-open', String(next))
      return next
    })
  }, [])
  const toggleChat = useCallback(() => {
    setChatOpen(prev => {
      const next = !prev
      try { sessionStorage.setItem('ai-lab-chat-open', String(next)) } catch { /* private mode */ }
      localStorage.setItem('ai-lab-chat-open', String(next)) // seeds NEW tabs only
      return next
    })
  }, [])

  // CURRENT POSITION is per-browser-tab (sessionStorage, same mechanism as
  // windowing.ts) so multiple AI-Lab browser tabs each refresh back to their
  // OWN place. localStorage stays as the write-through fallback: it seeds
  // brand-new tabs (and first load after this deploy) with the last position,
  // but a refresh never snaps existing tabs to it.
  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>(
    () => {
      const stored =
        sessionStorage.getItem('ai-lab-primary-tab') ||
        localStorage.getItem('ai-lab-primary-tab') ||
        'terminal'
      // 2026-07-14: the 'monitor' primary tab became 'roadmap' — migrate
      // persisted positions so old tabs don't land on a nonexistent id.
      return (stored === 'monitor' ? 'roadmap' : stored) as PrimaryTab
    }
  )
  const handlePrimaryTabChange = useCallback((id: PrimaryTab) => {
    setPrimaryTab(id)
    try { sessionStorage.setItem('ai-lab-primary-tab', id) } catch { /* private mode */ }
    localStorage.setItem('ai-lab-primary-tab', id)
  }, [])

  // Service "Logs" buttons + provider install/update bump liveConsoleStore.focusSeq → surface the
  // Terminal tab, whose right pane is the Live Console.
  React.useEffect(() => {
    return reaction(() => liveConsoleStore.focusSeq, () => handlePrimaryTabChange('terminal'))
  }, [handlePrimaryTabChange])

  React.useEffect(() => {
    store.bootstrap().then(() => {
      // Start ProxLab model discovery (auto-registers models from LLM proxy)
      startDiscovery()
      setTimeout(() => {
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
      <ConfirmHost />
      <PromptHost />
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

      <TopBar store={store} servicesOpen={servicesDrawerOpen} onServicesToggle={toggleServicesDrawer} />

      <div className="gyshell-body">
        <PrimarySidebar
          activeTab={primaryTab}
          onTabChange={handlePrimaryTabChange}
          onSettingsClick={() => store.toggleSettings()}
        />

        {/* Model/agent sidebar is permanently collapsed to its icon strip.
            The chat-overlay toggle lives at the top of this strip (rather
            than the auto-collapsing PrimarySidebar) so clicking it doesn't
            cause the cascading expand/collapse jitter the auto-pinned
            sidebar produces on mouseover. */}
        <div className="gyshell-agent-rail is-collapsed">
          <AgentRail
            appStore={store}
            chatOpen={chatOpen}
            onChatToggle={toggleChat}
          />
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
            <ErrorBoundary label="The terminal workspace">
              <TerminalWorkspace store={store} />
            </ErrorBoundary>
          </div>

          {primaryTab === 'home' && (
            <ErrorBoundary label="The home tab">
              <HomePanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'chat' && (
            <ErrorBoundary label="The chat tab">
              <AgentChatPanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'claude' && (
            <ErrorBoundary label="The claude tab">
              <ClaudePanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'cluster' && (
            <ErrorBoundary label="The cluster tab">
              <ClusterPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'services' && (
            <ErrorBoundary label="The services tab">
              <ServicesPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'helper-scripts' && (
            <ErrorBoundary label="The helper-scripts tab">
              <ScriptsTabPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'ai-services' && (
            <ErrorBoundary label="The ai-services tab">
              <AiServicesPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'ai-llm' && (
            <ErrorBoundary label="The ai-llm tab">
              <AiLlmPanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'ai-image' && (
            <ErrorBoundary label="The ai-image tab">
              <AiImagePanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'ai-tts-stt' && (
            <ErrorBoundary label="The ai-tts-stt tab">
              <AiTtsSttPanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'ai-tools' && (
            <ErrorBoundary label="The ai-tools tab">
              <AiToolsPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'model-downloads' && (
            <ErrorBoundary label="The model-downloads tab">
              <ModelDownloadsPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'logs' && (
            <ErrorBoundary label="The logs tab">
              <LogsPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'fleet' && (
            <ErrorBoundary label="The fleet tab">
              <FleetPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'addons' && (
            <ErrorBoundary label="The addons tab">
              <AddonsPanel />
            </ErrorBoundary>
          )}

          {primaryTab === 'flowchart' && (
            <ErrorBoundary label="The flowchart tab">
              <FlowchartPanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'pages' && (
            <ErrorBoundary label="The pages tab">
              <PagesPanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'svg' && (
            <ErrorBoundary label="The svg tab">
              <SvgPanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'files' && (
            <ErrorBoundary label="The files tab">
              <FilesPanel />
            </ErrorBoundary>
          )}
          {primaryTab === 'roadmap' && (
            <ErrorBoundary label="The roadmap tab">
              <RoadmapPanel />
            </ErrorBoundary>
          )}

          {/* Global chat overlay — toggled independently from the model sidebar. */}
          <ErrorBoundary label="The global chat overlay">
            <GlobalChat store={store} visible={chatOpen} />
          </ErrorBoundary>
        </div>

        {/* Settings is an overlay so we don't unmount terminals (xterm state stays alive) */}
        <div
          className={`gyshell-overlay settings-overlay${store.view === 'settings' ? ' is-open' : ''}`}
        >
          <ErrorBoundary label="The settings view">
            <SettingsView store={store} />
          </ErrorBoundary>
        </div>

        <div
          className={`gyshell-overlay connections-overlay${store.view === 'connections' ? ' is-open' : ''}`}
        >
          <ErrorBoundary label="The connections view">
            <ConnectionsView store={store} />
          </ErrorBoundary>
        </div>

        {/* Global running-services drawer — floats on the right over any tab while open. */}
        <ErrorBoundary label="The services drawer">
          <ServicesDrawer visible={servicesDrawerOpen} onClose={() => setServicesDrawerOpen(false)} />
        </ErrorBoundary>
      </div>
      {/* Global GPU fleet monitor — bottom-docked, collapsible; live metrics from Prometheus.
          ALWAYS MOUNTED, which is exactly why it is wrapped: one bad field from a
          Prometheus shape change used to be able to unmount the entire React tree
          from the bottom dock — the Support-Models incident's shape, app-wide. */}
      <ErrorBoundary label="The GPU fleet dock">
        <GpuFleetPanel />
      </ErrorBoundary>
      <ContextMenuOverlay />
    </div>
  )
})

