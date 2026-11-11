import { useState } from 'react'
import { Workflow, CircuitBoard } from 'lucide-react'
import { FlowchartPanel } from '../Flowchart/FlowchartPanel'
import { CircuitPanel } from '../Circuits/CircuitPanel'
import styles from './Diagrams.module.css'

type Sub = 'flowchart' | 'circuit'
const KEY = 'ai-lab-diagrams-subtab'

/**
 * Diagrams tab (was "Flowchart"): Flowchart (draw.io) and Circuit Designer sub-tabs.
 * Both stay MOUNTED and the inactive one is hidden, so switching never drops the flowchart's
 * pending debounced save or reloads the draw.io iframe.
 */
export function DiagramsPanel() {
  const [sub, setSub] = useState<Sub>(() => { try { return localStorage.getItem(KEY) === 'circuit' ? 'circuit' : 'flowchart' } catch { return 'flowchart' } })
  const [seen, setSeen] = useState<Set<Sub>>(() => new Set([sub]))
  const pick = (s: Sub) => {
    setSub(s)
    setSeen((x) => (x.has(s) ? x : new Set([...x, s])))
    try { localStorage.setItem(KEY, s) } catch (e) { console.warn('[diagrams] could not remember sub-tab', e) }
  }
  return (
    <div className={styles.shell}>
      <div className={styles.head}>
        <span className={styles.title}>Diagrams</span>
        <div className={styles.subTabs}>
          <button className={`${styles.subTab} ${sub === 'flowchart' ? styles.subTabActive : ''}`} onClick={() => pick('flowchart')}><Workflow size={13} /> Flowchart</button>
          <button className={`${styles.subTab} ${sub === 'circuit' ? styles.subTabActive : ''}`} onClick={() => pick('circuit')}><CircuitBoard size={13} /> Circuit Designer</button>
        </div>
      </div>
      <div className={styles.body}>
        {/* mounted on first visit, then kept alive */}
        {seen.has('flowchart') && <div className={styles.pane} hidden={sub !== 'flowchart'}><FlowchartPanel /></div>}
        {seen.has('circuit') && <div className={styles.pane} hidden={sub !== 'circuit'}><CircuitPanel /></div>}
      </div>
    </div>
  )
}
