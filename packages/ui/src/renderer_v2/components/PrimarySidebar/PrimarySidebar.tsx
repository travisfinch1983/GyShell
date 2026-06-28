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
  BrainCircuit,
  Bot,
  Image as ImageIcon,
  AudioLines,
  Download,
  ScrollText,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import styles from './PrimarySidebar.module.scss'

export type PrimaryTab = 'terminal' | 'cluster' | 'services' | 'ai-services' | 'ai-llm' | 'ai-image' | 'ai-tts-stt' | 'scripts' | 'helper-scripts' | 'model-downloads' | 'flowchart' | 'files' | 'logs' | 'monitor'

interface TabDef {
  id: PrimaryTab
  label: string
  Icon: LucideIcon
}

const TABS: TabDef[] = [
  { id: 'terminal',  label: 'Terminal',  Icon: Terminal },
  { id: 'cluster',   label: 'Cluster',   Icon: Server },
  { id: 'services',  label: 'Services',  Icon: Radar },
  { id: 'ai-services', label: 'AI Services', Icon: BrainCircuit },
  { id: 'ai-llm', label: 'AI · LLM', Icon: Bot },
  { id: 'ai-image', label: 'AI · Image Gen', Icon: ImageIcon },
  { id: 'ai-tts-stt', label: 'AI · TTS & STT', Icon: AudioLines },
  { id: 'scripts',   label: 'Scripts',   Icon: FileCode },
  { id: 'helper-scripts', label: 'Helper Scripts', Icon: Package },
  { id: 'model-downloads', label: 'Model Downloads', Icon: Download },
  { id: 'flowchart', label: 'Flowchart', Icon: Workflow },
  { id: 'files',     label: 'Files',     Icon: FolderOpen },
  { id: 'logs',      label: 'Logs',      Icon: ScrollText },
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
