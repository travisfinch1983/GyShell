import React from 'react'
import type { AppStore } from '../../stores/AppStore'
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

// Chat moved to the global sidebar overlay (components/Chat/GlobalChat.tsx). The legacy chat panel is
// defunct + just takes space, so auto-remove it from the layout on mount (removePanel no-ops if it's
// the only panel). Live consoles live in their own primary tab.
const ChatPanelRenderer: LayoutPanelRenderer = ({ store, panelId }) => {
  React.useEffect(() => {
    const t = setTimeout(() => { try { store.layout.removePanel(panelId) } catch { /* ignore */ } }, 0)
    return () => clearTimeout(t)
  }, [store, panelId])
  return null
}

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
