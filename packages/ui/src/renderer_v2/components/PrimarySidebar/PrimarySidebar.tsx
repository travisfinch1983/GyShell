import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  Terminal,
  LayoutDashboard,
  Workflow,
  FolderOpen,
  Map as MapIcon,
  Server,
  Radar,
  Package,
  Radio,
  BrainCircuit,
  Bot,
  MessageSquare,
  Blocks,
  Image as ImageIcon,
  AudioLines,
  Download,
  ScrollText,
  Settings,
  Wrench,
  Sparkles,
  MoreVertical,
  Check,
  X,
  GripVertical,
  type LucideIcon,
} from 'lucide-react'
import { uiPrefsStore } from '../../stores/uiPrefsStore'
import styles from './PrimarySidebar.module.scss'

export type PrimaryTab = 'home' | 'terminal' | 'claude' | 'cluster' | 'services' | 'ai-services' | 'ai-llm' | 'ai-image' | 'ai-tts-stt' | 'ai-tools' | 'helper-scripts' | 'model-downloads' | 'flowchart' | 'files' | 'logs' | 'roadmap' | 'fleet' | 'addons' | 'chat'

interface TabDef {
  id: PrimaryTab
  label: string
  Icon: LucideIcon
}

const TABS: TabDef[] = [
  { id: 'home',      label: 'Home',      Icon: LayoutDashboard },
  { id: 'chat',      label: 'Chat',      Icon: MessageSquare },
  { id: 'terminal',  label: 'Terminal',  Icon: Terminal },
  { id: 'claude',    label: 'Claude',    Icon: Sparkles },
  { id: 'fleet',     label: 'Fleet Feed', Icon: Radio },
  { id: 'addons',    label: 'Addons',    Icon: Blocks },
  { id: 'cluster',   label: 'Cluster',   Icon: Server },
  { id: 'services',  label: 'Services',  Icon: Radar },
  { id: 'ai-services', label: 'AI Metrics', Icon: BrainCircuit },
  { id: 'ai-llm', label: 'AI · LLM', Icon: Bot },
  { id: 'ai-image', label: 'AI · Image Gen', Icon: ImageIcon },
  { id: 'ai-tts-stt', label: 'AI · TTS & STT', Icon: AudioLines },
  { id: 'ai-tools', label: 'AI · Tools', Icon: Wrench },
  { id: 'helper-scripts', label: 'Helper Scripts', Icon: Package },
  { id: 'model-downloads', label: 'Model Downloads', Icon: Download },
  { id: 'flowchart', label: 'Flowchart', Icon: Workflow },
  { id: 'files',     label: 'Files',     Icon: FolderOpen },
  { id: 'logs',      label: 'Logs',      Icon: ScrollText },
  { id: 'roadmap',   label: 'Roadmap',   Icon: MapIcon },
]

interface Props {
  activeTab: PrimaryTab
  onTabChange: (id: PrimaryTab) => void
  onSettingsClick: () => void
}

/** Order the static TABS by a saved id-order; unknown ids dropped, missing tabs appended (handles add/remove). */
function applyOrder(order: string[]): TabDef[] {
  const byId = new Map(TABS.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const out: TabDef[] = []
  for (const id of order) { const t = byId.get(id as PrimaryTab); if (t && !seen.has(id)) { out.push(t); seen.add(id) } }
  for (const t of TABS) if (!seen.has(t.id)) out.push(t)
  return out
}

export const PrimarySidebar: React.FC<Props> = observer(({ activeTab, onTabChange, onSettingsClick }) => {
  useEffect(() => { void uiPrefsStore.ensureLoaded() }, [])
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const dragId = useRef<string | null>(null)

  const savedOrder = (uiPrefsStore.get('sidebarTabOrder', []) as string[]) || []
  const tabs = editing ? applyOrder(draft) : applyOrder(savedOrder)

  const startEdit = () => { setMenuOpen(false); setDraft(applyOrder(savedOrder).map((t) => t.id)); setEditing(true) }
  const cancelEdit = () => setEditing(false)
  const saveEdit = () => { uiPrefsStore.set('sidebarTabOrder', draft); setEditing(false) }
  const dropOn = (targetId: string) => {
    const from = dragId.current; dragId.current = null
    if (!from || from === targetId) return
    setDraft((prev) => {
      const arr = [...prev]; const fi = arr.indexOf(from)
      if (fi < 0 || arr.indexOf(targetId) < 0) return prev
      arr.splice(fi, 1)
      const ti = arr.indexOf(targetId) // recompute after removal so we land before the target
      arr.splice(ti, 0, from); return arr
    })
  }

  return (
    <nav className={`${styles.sidebar} ${editing ? styles.editing : ''}`}>
      <div className={styles.tabs}>
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`${styles.tab} ${activeTab === id && !editing ? styles.active : ''} ${editing ? styles.draggable : ''}`}
            onClick={() => { if (!editing) onTabChange(id) }}
            title={label}
            type="button"
            draggable={editing}
            onDragStart={editing ? () => { dragId.current = id } : undefined}
            onDragOver={editing ? (e) => e.preventDefault() : undefined}
            onDrop={editing ? () => dropOn(id) : undefined}
          >
            {editing && <GripVertical size={14} className={styles.grip} />}
            <Icon size={20} strokeWidth={1.75} />
            <span className={styles.label}>{label}</span>
          </button>
        ))}
      </div>
      <div className={styles.bottom}>
        {editing ? (
          <div className={styles.editActions}>
            <button className={`${styles.tab} ${styles.saveBtn}`} onClick={saveEdit} title="Save tab order" type="button">
              <Check size={20} strokeWidth={2} /><span className={styles.label}>Save Order</span>
            </button>
            <button className={`${styles.tab} ${styles.cancelBtn}`} onClick={cancelEdit} title="Cancel" type="button">
              <X size={20} strokeWidth={2} /><span className={styles.label}>Cancel</span>
            </button>
          </div>
        ) : (
          <div className={styles.bottomRow}>
            <button className={styles.tab} onClick={onSettingsClick} title="Settings" type="button">
              <Settings size={20} strokeWidth={1.75} /><span className={styles.label}>Settings</span>
            </button>
            <div className={styles.menuWrap}>
              <button className={`${styles.tab} ${styles.moreBtn}`} onClick={() => setMenuOpen((o) => !o)} title="Sidebar options" type="button">
                <MoreVertical size={20} strokeWidth={1.75} />
              </button>
              {menuOpen && (
                <>
                  <div className={styles.menuBackdrop} onClick={() => setMenuOpen(false)} />
                  <div className={styles.menu}>
                    <button className={styles.menuItem} onClick={startEdit} type="button">Edit Sidebar</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </nav>
  )
})
