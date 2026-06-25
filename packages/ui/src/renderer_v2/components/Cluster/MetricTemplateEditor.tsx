import React, { useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, RotateCcw } from 'lucide-react'
import { clusterStore } from '../../stores/ClusterStore'
import {
  defaultTemplate,
  type MetricCategory,
  type MetricChartDef,
  type MetricTemplate,
  type MetricUnit,
  type GearEdit,
} from '../../stores/metricTemplates'
import styles from './Cluster.module.scss'

const UNITS: MetricUnit[] = ['percent', 'bytes', 'raw']
const GEARS: GearEdit[] = ['none', 'cores', 'memory', 'disk', 'order']

let seq = 0
const newId = () => `c${Date.now().toString(36)}${seq++}`

/**
 * In-page editor (coding std #2) for a category's metric template. Every entry in
 * the category renders from this template. `$id` in a query is replaced with the
 * guest id (lxc/NNN or qemu/NNN) at render time.
 */
export const MetricTemplateEditor: React.FC<{ category: MetricCategory; onClose: () => void }> = ({
  category,
  onClose,
}) => {
  const [tpl, setTpl] = useState<MetricTemplate>(() => structuredClone(clusterStore.getTemplate(category)))

  const setChart = (i: number, patch: Partial<MetricChartDef>) =>
    setTpl((t) => ({ ...t, charts: t.charts.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) }))
  const move = (i: number, dir: -1 | 1) =>
    setTpl((t) => {
      const charts = [...t.charts]
      const j = i + dir
      if (j < 0 || j >= charts.length) return t
      ;[charts[i], charts[j]] = [charts[j], charts[i]]
      return { ...t, charts }
    })
  const remove = (i: number) => setTpl((t) => ({ ...t, charts: t.charts.filter((_, idx) => idx !== i) }))
  const add = () =>
    setTpl((t) => ({
      ...t,
      charts: [...t.charts, { id: newId(), label: 'New metric', query: 'pve_cpu_usage_ratio{id="$id"} * 100', unit: 'percent', color: '#4ea1ff', gear: 'none' }],
    }))

  const save = () => {
    clusterStore.saveTemplate(category, tpl)
    onClose()
  }
  const reset = () => setTpl(defaultTemplate(category))

  const catLabel = category === 'lxc' ? 'LXC Containers' : 'Virtual Machines'

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>Metric template · {catLabel}</div>
        <div className={styles.modalNote}>
          Applies to every entry in this list. Use <code>$id</code> in a query (substituted with the guest id,
          e.g. <code>lxc/177</code>).
        </div>

        <div className={styles.tplRangeRow}>
          <label>
            Range (s)
            <input
              type="number"
              value={tpl.rangeSeconds}
              onChange={(e) => setTpl((t) => ({ ...t, rangeSeconds: Number(e.target.value) || 3600 }))}
            />
          </label>
          <label>
            Step (s)
            <input
              type="number"
              value={tpl.stepSeconds}
              onChange={(e) => setTpl((t) => ({ ...t, stepSeconds: Number(e.target.value) || 60 }))}
            />
          </label>
        </div>

        <div className={styles.tplCharts}>
          {tpl.charts.map((c, i) => (
            <div key={c.id} className={styles.tplChart}>
              <div className={styles.tplChartTop}>
                <input
                  className={styles.tplLabel}
                  value={c.label}
                  placeholder="Label"
                  onChange={(e) => setChart(i, { label: e.target.value })}
                />
                <input
                  type="color"
                  className={styles.tplColor}
                  value={c.color}
                  onChange={(e) => setChart(i, { color: e.target.value })}
                  title="Line color"
                />
                <select value={c.unit} onChange={(e) => setChart(i, { unit: e.target.value as MetricUnit })} title="Unit">
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
                <select value={c.gear} onChange={(e) => setChart(i, { gear: e.target.value as GearEdit })} title="Gear opens editor">
                  {GEARS.map((g) => (
                    <option key={g} value={g}>
                      ⚙ {g}
                    </option>
                  ))}
                </select>
                <button className={styles.iconBtn} title="Move up" onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </button>
                <button className={styles.iconBtn} title="Move down" onClick={() => move(i, 1)}>
                  <ArrowDown size={13} />
                </button>
                <button className={`${styles.iconBtn} ${styles.danger}`} title="Remove" onClick={() => remove(i)}>
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea
                className={styles.tplQuery}
                rows={2}
                value={c.query}
                placeholder='PromQL — use $id, e.g. pve_cpu_usage_ratio{id="$id"} * 100'
                onChange={(e) => setChart(i, { query: e.target.value })}
              />
            </div>
          ))}
        </div>

        <button className={styles.addChartBtn} onClick={add}>
          <Plus size={13} /> Add metric
        </button>

        <div className={styles.modalActions}>
          <button onClick={reset} title="Reset to defaults">
            <RotateCcw size={13} /> Reset
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button className={styles.primary} onClick={save}>
            Save template
          </button>
        </div>
      </div>
    </div>
  )
}
