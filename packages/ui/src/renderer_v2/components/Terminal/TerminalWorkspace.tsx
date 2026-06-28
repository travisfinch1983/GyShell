import React from 'react'
import { observer } from 'mobx-react-lite'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { AppStore } from '../../stores/AppStore'
import { TerminalPanel } from './TerminalPanel'
import { LiveConsoleMultiPanel } from '../LiveConsole/LiveConsoleMultiPanel'
import styles from './TerminalWorkspace.module.scss'

// Our Terminal tab owns exactly ONE terminal pane, so we deliberately bypass the gyshell layout
// store's panel tree (getPrimaryPanelId / getPanelTabIds / panel bindings). That tree is fragile and
// has corrupted repeatedly (duplicate node ids, multiple terminal panels, ghost panels from
// ensurePrimaryPanelForKind), which routed newly-created tabs to a panel id we weren't rendering. So
// instead we feed TerminalPanel ALL terminal sessions directly and track the active one via
// store.activeTerminalId — no tree dependency, nothing to corrupt. The panelId below is just an opaque
// handle TerminalPanel passes back into createLocalTab; the session still lands in store.terminalTabs.
const TERMINAL_PANE_ID = 'ailab-terminal-pane'

export const TerminalWorkspace: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const tabs = store.terminalTabs
  const activeTabId = store.activeTerminalId

  return (
    <PanelGroup direction="horizontal" autoSaveId="ailab-terminal-split" className={styles.group}>
      <Panel defaultSize={55} minSize={25} className={styles.pane}>
        <TerminalPanel
          store={store}
          panelId={TERMINAL_PANE_ID}
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={(id) => store.setActiveTerminal(id)}
          onRequestCloseTabs={(ids) => ids.forEach((id) => void store.closeTab(id))}
          onReorderTabs={(ids) => store.reorderTerminalTabs(ids)}
        />
      </Panel>
      <PanelResizeHandle className={styles.handle} />
      <Panel defaultSize={45} minSize={25} className={styles.pane}>
        <LiveConsoleMultiPanel />
      </Panel>
    </PanelGroup>
  )
})
