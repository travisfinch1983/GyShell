import React from 'react'
import {
  Terminal,
  Workflow,
  FolderOpen,
  Activity,
  Settings,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react'
import styles from './PrimarySidebar.module.scss'

export type PrimaryTab = 'terminal' | 'flowchart' | 'files' | 'monitor'

interface TabDef {
  id: PrimaryTab
  label: string
  Icon: LucideIcon
}

const TABS: TabDef[] = [
  { id: 'terminal',  label: 'Terminal',  Icon: Terminal },
  { id: 'flowchart', label: 'Flowchart', Icon: Workflow },
  { id: 'files',     label: 'Files',     Icon: FolderOpen },
  { id: 'monitor',   label: 'Monitor',   Icon: Activity },
]

interface Props {
  activeTab: PrimaryTab
  onTabChange: (id: PrimaryTab) => void
  onSettingsClick: () => void
  /** Whether the global chat overlay is currently visible */
  chatOpen: boolean
  /** Toggle the chat overlay open/closed (independent from any tab change) */
  onChatToggle: () => void
}

export const PrimarySidebar: React.FC<Props> = ({
  activeTab,
  onTabChange,
  onSettingsClick,
  chatOpen,
  onChatToggle,
}) => {
  return (
    <nav className={styles.sidebar}>
      <div className={styles.tabs}>
        {/* Chat toggle — sits above the tab group since opening it doesn't
            switch tabs, just overlays the chat panel onto whatever tab is
            currently active. */}
        <button
          className={`${styles.tab} ${chatOpen ? styles.active : ''}`}
          onClick={onChatToggle}
          title={chatOpen ? 'Close chat' : 'Open chat'}
          type="button"
        >
          <MessageSquare size={20} strokeWidth={1.75} />
          <span className={styles.label}>Chat</span>
        </button>

        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`${styles.tab} ${activeTab === id ? styles.active : ''}`}
            onClick={() => onTabChange(id)}
            title={label}
            type="button"
          >
            <Icon size={20} strokeWidth={1.75} />
            <span className={styles.label}>{label}</span>
          </button>
        ))}
      </div>
      <div className={styles.bottom}>
        <button
          className={styles.tab}
          onClick={onSettingsClick}
          title="Settings"
          type="button"
        >
          <Settings size={20} strokeWidth={1.75} />
          <span className={styles.label}>Settings</span>
        </button>
      </div>
    </nav>
  )
}
