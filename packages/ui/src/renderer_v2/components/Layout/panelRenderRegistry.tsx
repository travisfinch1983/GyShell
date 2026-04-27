import React from 'react'
import type { AppStore } from '../../stores/AppStore'
import { ChatPanel } from '../Chat/ChatPanel'
import { TerminalPanel } from '../Terminal/TerminalPanel'
import { FileSystemPanel } from '../FileSystem/FileSystemPanel'
import { FileEditorPanel } from '../FileSystem/FileEditorPanel'
import { MonitorPanel } from '../Monitor/MonitorPanel'
import type { PanelKind } from '../../layout'

export interface LayoutPanelRenderProps {
  store: AppStore
  panelId: string
  tabIds: string[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onRequestCloseTabs?: (tabIds: string[]) => void
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
}

type LayoutPanelRenderer = React.FC<LayoutPanelRenderProps>

const TerminalPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  tabIds,
  activeTabId,
  onSelectTab,
  onRequestCloseTabs,
  onLayoutHeaderContextMenu
}) => (
  <TerminalPanel
    store={store}
    panelId={panelId}
    tabs={tabIds
      .map((tabId) => store.terminalTabs.find((tab) => tab.id === tabId))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab)}
    activeTabId={activeTabId}
    onSelectTab={onSelectTab}
    onRequestCloseTabs={onRequestCloseTabs}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

// Chat panels in the multi-panel layout are deprecated — the chat now lives
// in the always-visible global overlay (see components/Chat/GlobalChat.tsx).
// Existing chat panels in saved layout state render this stub so the user can
// close them manually; new chat panels can no longer be created from the
// removed PanelTypeRail.
const ChatPanelRenderer: LayoutPanelRenderer = () => (
  <div style={{
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: 24,
    gap: 8,
    color: 'var(--fg-muted)',
    textAlign: 'center',
  }}>
    <div style={{ color: 'var(--fg)', fontWeight: 500 }}>Chat moved to global panel</div>
    <div style={{ fontSize: 11, maxWidth: 360 }}>
      The chat interface is now pinned to the right of the model sidebar and
      shown whenever the sidebar is expanded. You can close this panel.
    </div>
  </div>
)

const FileSystemPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  tabIds,
  activeTabId,
  onSelectTab,
  onLayoutHeaderContextMenu
}) => (
  <FileSystemPanel
    store={store}
    panelId={panelId}
    tabs={tabIds
      .map((tabId) => store.fileSystemTabs.find((tab) => tab.id === tabId))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab)}
    activeTabId={activeTabId}
    onSelectTab={onSelectTab}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const FileEditorPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  onLayoutHeaderContextMenu
}) => (
  <FileEditorPanel
    store={store}
    panelId={panelId}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const MonitorPanelRenderer: LayoutPanelRenderer = ({
  store,
  panelId,
  tabIds,
  activeTabId,
  onSelectTab,
  onLayoutHeaderContextMenu
}) => (
  <MonitorPanel
    store={store}
    panelId={panelId}
    tabs={tabIds
      .map((tabId) => store.monitorTabs.find((tab) => tab.id === tabId))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab)}
    activeTabId={activeTabId}
    onSelectTab={onSelectTab}
    onLayoutHeaderContextMenu={onLayoutHeaderContextMenu}
  />
)

const PANEL_RENDERERS: Record<PanelKind, LayoutPanelRenderer> = {
  terminal: TerminalPanelRenderer,
  chat: ChatPanelRenderer,
  filesystem: FileSystemPanelRenderer,
  fileEditor: FileEditorPanelRenderer,
  monitor: MonitorPanelRenderer
}

export const renderPanelByKind = (
  kind: PanelKind,
  props: LayoutPanelRenderProps
): React.ReactElement => {
  const Renderer = PANEL_RENDERERS[kind]
  return <Renderer {...props} />
}
