import type { LucideIcon } from 'lucide-react'
import { Activity, FolderTree, MessageSquare, SquareTerminal } from 'lucide-react'
import { PANEL_KINDS_WITH_RAIL } from '../../layout'
import type { AppStore } from '../../stores/AppStore'

type LayoutPanelKindLabelKey = 'chatKind' | 'terminalKind' | 'filesystemKind' | 'monitorKind'
export type RailClickIntent = 'open-panel-only' | 'create-new-tab'
export type RailPanelKind = (typeof PANEL_KINDS_WITH_RAIL)[number]

export interface RailClickContext {
  panelCount: number
  ownerTabCount: number
}

export const resolveDefaultRailClickIntent = (context: RailClickContext): RailClickIntent => {
  if (context.panelCount === 0 && context.ownerTabCount > 0) {
    return 'open-panel-only'
  }
  return 'create-new-tab'
}

export interface PanelKindUiRegistryItem {
  kind: RailPanelKind
  icon: LucideIcon
  labelKey: LayoutPanelKindLabelKey
  resolveRailClickIntent: (context: RailClickContext) => RailClickIntent
  getOwnerTabCount: (store: AppStore) => number
  createDefaultTab: (store: AppStore, panelId: string) => void
}

const createPanelKindUiItem = (item: PanelKindUiRegistryItem): PanelKindUiRegistryItem => item

export const PANEL_KIND_UI_REGISTRY: Record<RailPanelKind, PanelKindUiRegistryItem> = {
  chat: createPanelKindUiItem({
    kind: 'chat',
    icon: MessageSquare,
    labelKey: 'chatKind',
    resolveRailClickIntent: resolveDefaultRailClickIntent,
    getOwnerTabCount: (store) => store.chat.sessions.length,
    createDefaultTab: (store, panelId) => {
      const sessionId = store.chat.createSession()
      store.layout.attachTabToPanel('chat', sessionId, panelId)
    }
  }),
  terminal: createPanelKindUiItem({
    kind: 'terminal',
    icon: SquareTerminal,
    labelKey: 'terminalKind',
    resolveRailClickIntent: resolveDefaultRailClickIntent,
    getOwnerTabCount: (store) => store.terminalTabs.length,
    createDefaultTab: (store, panelId) => {
      store.createLocalTab(panelId)
    }
  }),
  filesystem: createPanelKindUiItem({
    kind: 'filesystem',
    icon: FolderTree,
    labelKey: 'filesystemKind',
    resolveRailClickIntent: () => 'open-panel-only',
    getOwnerTabCount: (store) => store.fileSystemTabs.length,
    createDefaultTab: () => {
      // Filesystem tabs are attached to terminal tabs and cannot be created independently.
    }
  }),
  monitor: createPanelKindUiItem({
    kind: 'monitor',
    icon: Activity,
    labelKey: 'monitorKind',
    resolveRailClickIntent: () => 'open-panel-only',
    getOwnerTabCount: (store) => store.monitorTabs.length,
    createDefaultTab: () => {
      // Monitor tabs are derived from terminal tabs and cannot be created independently.
    }
  })
}

export const PANEL_KIND_UI_ORDER: readonly RailPanelKind[] = PANEL_KINDS_WITH_RAIL

export const getPanelKindUiItem = (kind: RailPanelKind): PanelKindUiRegistryItem =>
  PANEL_KIND_UI_REGISTRY[kind]
