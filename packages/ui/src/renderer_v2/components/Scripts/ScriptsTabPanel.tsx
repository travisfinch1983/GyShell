import React from 'react'
import { Package } from 'lucide-react'
import { Shell } from '../AiModality/AiModalityPanels'
import { ScriptsPanel } from './ScriptsPanel'
import { ScriptCatalogPanel } from '../ScriptCatalog/ScriptCatalogPanel'

/** Helper Scripts tab: the Helper Scripts catalog + the original Scripts content under a "System Scripts" sub-tab. */
export const ScriptsTabPanel: React.FC = () => (
  <Shell title="Helper Scripts" Icon={Package} tabs={[
    { id: 'helper', label: 'Helper Scripts', render: () => <ScriptCatalogPanel /> },
    { id: 'system', label: 'System Scripts', render: () => <ScriptsPanel /> },
  ]} />
)
