import React from 'react'
import { FileCode } from 'lucide-react'
import { Shell } from '../AiModality/AiModalityPanels'
import { ScriptsPanel } from './ScriptsPanel'
import { ScriptCatalogPanel } from '../ScriptCatalog/ScriptCatalogPanel'

/** Merged Scripts tab: the original Scripts content under "System Scripts" + the Helper Scripts catalog. */
export const ScriptsTabPanel: React.FC = () => (
  <Shell title="Scripts" Icon={FileCode} tabs={[
    { id: 'system', label: 'System Scripts', render: () => <ScriptsPanel /> },
    { id: 'helper', label: 'Helper Scripts', render: () => <ScriptCatalogPanel /> },
  ]} />
)
