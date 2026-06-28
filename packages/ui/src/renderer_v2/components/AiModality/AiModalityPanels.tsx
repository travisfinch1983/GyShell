import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { PackagePlus, BrainCircuit, Image as ImageIcon, AudioLines } from 'lucide-react'
import { ProviderInstall } from './ProviderInstall'
import { LlmLaunchPanel } from '../AiLlm/LlmLaunchPanel'
import { ServiceLaunchPanel } from './ServiceLaunchPanel'
import { ttsLaunchStore, imageLaunchStore } from '../../stores/ServiceLaunchStore'
import styles from './AiModality.module.scss'

interface SubTab {
  id: string
  label: string
  render: () => React.ReactNode
}

const Shell: React.FC<{ title: string; Icon: React.ComponentType<any>; tabs: SubTab[] }> = ({ title, Icon, tabs }) => {
  const [active, setActive] = useState(tabs[0]?.id)
  const cur = tabs.find((t) => t.id === active) ?? tabs[0]
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Icon size={16} className={styles.headerIcon} />
        <span className={styles.title}>{title}</span>
        <div className={styles.subTabs}>
          {tabs.map((t) => (
            <button key={t.id} className={`${styles.subTab} ${active === t.id ? styles.subTabActive : ''}`} onClick={() => setActive(t.id)}>{t.label}</button>
          ))}
        </div>
      </div>
      <div className={styles.body}>{cur?.render()}</div>
    </div>
  )
}


export const AiLlmPanel: React.FC = observer(() => (
  <Shell title="AI · LLM" Icon={BrainCircuit} tabs={[
    { id: 'launch', label: 'LLM Launch', render: () => <LlmLaunchPanel /> },
    { id: 'providers', label: 'Provider Install', render: () => <ProviderInstall categories={['llm']} /> },
  ]} />
))

export const AiImagePanel: React.FC = observer(() => (
  <Shell title="AI · Image Gen" Icon={ImageIcon} tabs={[
    { id: 'launch', label: 'Imagegen Launch', render: () => <ServiceLaunchPanel store={imageLaunchStore} emptyLabel="image-generation" /> },
    { id: 'providers', label: 'Provider Install', render: () => <ProviderInstall categories={['image', 'training']} /> },
  ]} />
))

export const AiTtsSttPanel: React.FC = observer(() => (
  <Shell title="AI · TTS & STT" Icon={AudioLines} tabs={[
    { id: 'launch', label: 'TTS Launch', render: () => <ServiceLaunchPanel store={ttsLaunchStore} emptyLabel="TTS" /> },
    { id: 'providers', label: 'Provider Install', render: () => <ProviderInstall categories={['tts']} /> },
  ]} />
))

// keep PackagePlus referenced (used as the conceptual provider-install glyph elsewhere)
void PackagePlus
