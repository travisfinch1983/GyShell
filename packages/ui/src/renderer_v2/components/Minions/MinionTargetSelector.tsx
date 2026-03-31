/**
 * MinionTargetSelector — Dropdown to select which model receives the next message.
 */

import { observer } from 'mobx-react-lite'
import { MinionStore } from '../../stores/MinionStore'
import './MinionTargetSelector.scss'

interface MinionTargetSelectorProps {
  store: MinionStore
}

export const MinionTargetSelector = observer(({ store }: MinionTargetSelectorProps) => {
  const options = store.targetOptions

  if (options.length === 0) return null

  return (
    <div className="minion-target-selector">
      <select
        value={store.selectedTarget}
        onChange={(e) => store.setSelectedTarget(e.target.value)}
        title="Select message recipient"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
})
