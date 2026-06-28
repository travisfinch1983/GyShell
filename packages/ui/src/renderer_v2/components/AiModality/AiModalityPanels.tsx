import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Rocket, PackagePlus, BrainCircuit, Image as ImageIcon, AudioLines } from 'lucide-react'
import { ProviderInstall } from './ProviderInstall'
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

const LaunchPlaceholder: React.FC<{ what: string }> = ({ what }) => (
  <div className={styles.placeholder}>
    <Rocket size={28} />
    <div className={styles.phTitle}>{what} — migration in progress</div>
    <div className={styles.phSub}>The full launcher (model picker, GPU/VRAM planning, per-provider settings, command preview, launch as service/template) is the next migration phase. Provider Install is available now.</div>
  </div>
)

export const AiLlmPanel: React.FC = observer(() => (
  <Shell title="AI · LLM" Icon={BrainCircuit} tabs={[
    { id: 'launch', label: 'LLM Launch', render: () => <LaunchPlaceholder what="LLM Launch" /> },
    { id: 'providers', label: 'Provider Install', render: () => <ProviderInstall categories={['llm']} /> },
  ]} />
))

export const AiImagePanel: React.FC = observer(() => (
  <Shell title="AI · Image Gen" Icon={ImageIcon} tabs={[
    { id: 'providers', label: 'Provider Install', render: () => <ProviderInstall categories={['image', 'training']} /> },
  ]} />
))

export const AiTtsSttPanel: React.FC = observer(() => (
  <Shell title="AI · TTS & STT" Icon={AudioLines} tabs={[
    { id: 'providers', label: 'Provider Install', render: () => <ProviderInstall categories={['tts']} /> },
  ]} />
))

// keep PackagePlus referenced (used as the conceptual provider-install glyph elsewhere)
void PackagePlus
