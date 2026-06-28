import React from 'react'
import { observer } from 'mobx-react-lite'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import type { AppStore, TerminalTabModel } from '../../stores/AppStore'
import { TerminalPanel } from './TerminalPanel'
import { LiveConsoleMultiPanel } from '../LiveConsole/LiveConsoleMultiPanel'
import styles from './TerminalWorkspace.module.scss'

/**
 * Our own Terminal tab — a fixed, resizable two-pane split that replaces the gyshell
 * LayoutWorkspace (and its panel-tree/chat-binding fragility). We REUSE gyshell's
 * TerminalPanel verbatim on the left (keeps local shells, saved SSH connections, the
 * native tab bar + "manage connections" menu) and our Live Console on the right.
 * The split size persists locally via react-resizable-panels' autoSaveId.
 */
export const TerminalWorkspace: React.FC<{ store: AppStore }> = observer(({ store }) => {
  // Stable terminal panel id — the same one createLocalTab/createSshTab bind tabs to.
  const [panelId, setPanelId] = React.useState<string | null>(() =>
    store.layout.getPrimaryPanelId('terminal'),
  )
  React.useEffect(() => {
    if (!panelId) {
      const id = store.layout.ensurePrimaryPanelForKind('terminal')
      if (id) setPanelId(id)
    }
  }, [panelId, store])

  const tabIds = panelId ? store.layout.getPanelTabIds(panelId) : []
  const tabs = tabIds
    .map((id) => store.terminalTabs.find((t) => t.id === id))
    .filter((t): t is TerminalTabModel => !!t)
  const activeTabId = panelId ? store.layout.getPanelActiveTabId(panelId) : null

  return (
    <PanelGroup direction="horizontal" autoSaveId="ailab-terminal-split" className={styles.group}>
      <Panel defaultSize={55} minSize={25} className={styles.pane}>
        {panelId && (
          <TerminalPanel
            store={store}
            panelId={panelId}
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={(id) => store.layout.setPanelActiveTab(panelId, id)}
            onRequestCloseTabs={(ids) => ids.forEach((id) => store.closeTab(id))}
          />
        )}
      </Panel>
      <PanelResizeHandle className={styles.handle} />
      <Panel defaultSize={45} minSize={25} className={styles.pane}>
        <LiveConsoleMultiPanel />
      </Panel>
    </PanelGroup>
  )
})
