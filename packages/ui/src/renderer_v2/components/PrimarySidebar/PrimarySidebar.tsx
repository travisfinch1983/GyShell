import React from 'react'
import {
  Terminal,
  Workflow,
  FolderOpen,
  Activity,
  Server,
  Radar,
  FileCode,
  Package,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import styles from './PrimarySidebar.module.scss'

export type PrimaryTab = 'terminal' | 'cluster' | 'services' | 'scripts' | 'helper-scripts' | 'flowchart' | 'files' | 'monitor'

interface TabDef {
  id: PrimaryTab
  label: string
  Icon: LucideIcon
}

const TABS: TabDef[] = [
  { id: 'terminal',  label: 'Terminal',  Icon: Terminal },
  { id: 'cluster',   label: 'Cluster',   Icon: Server },
  { id: 'services',  label: 'Services',  Icon: Radar },
  { id: 'scripts',   label: 'Scripts',   Icon: FileCode },
  { id: 'helper-scripts', label: 'Helper Scripts', Icon: Package },
  { id: 'flowchart', label: 'Flowchart', Icon: Workflow },
  { id: 'files',     label: 'Files',     Icon: FolderOpen },
  { id: 'monitor',   label: 'Monitor',   Icon: Activity },
]

interface Props {
  activeTab: PrimaryTab
  onTabChange: (id: PrimaryTab) => void
  onSettingsClick: () => void
}

export const PrimarySidebar: React.FC<Props> = ({
  activeTab,
  onTabChange,
  onSettingsClick,
}) => {
  return (
    <nav className={styles.sidebar}>
      <div className={styles.tabs}>
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
