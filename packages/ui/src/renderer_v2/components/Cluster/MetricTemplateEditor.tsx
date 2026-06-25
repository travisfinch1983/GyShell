import React, { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, RotateCcw } from 'lucide-react'
import { clusterStore } from '../../stores/ClusterStore'
import { MetricChart } from './MetricChart'
import {
  defaultTemplate,
  resolveQuery,
  newSeries,
  newField,
  VIZ_TYPES,
  UNITS,
  type MetricCategory,
  type MetricChartDef,
  type MetricQuery,
  type MetricTemplate,
  type MetricUnit,
  type GearEdit,
  type VizType,
} from '../../stores/metricTemplates'
import styles from './Cluster.module.scss'

const GEARS: GearEdit[] = ['none', 'cores', 'memory', 'disk', 'order']

let seq = 0
const newChartId = () => `c${Date.now().toString(36)}${seq++}`

function useDebounced<T>(value: T, ms: number): T {
  const [d, setD] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setD(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return d
}

/**
 * In-page editor (coding std #2) for a category's metric template. Each entity can
 * carry multiple plotted `series` + scalar `fields` for higher info density. `$id` in
 * any query → guest id at render. Live preview against a sample guest below each chart.
 */
export const MetricTemplateEditor: React.FC<{ category: MetricCategory; onClose: () => void }> = ({ category, onClose }) => {
  const [tpl, setTpl] = useState<MetricTemplate>(() =>
    JSON.parse(JSON.stringify(clusterStore.getTemplate(category))) as MetricTemplate,
  )

  const sampleGuest = (category === 'lxc' ? clusterStore.containers : clusterStore.vms)[0]
  const sampleId = `${category === 'lxc' ? 'lxc' : 'qemu'}/${sampleGuest?.vmid ?? 100}`
  const dtpl = useDebounced(tpl, 500)
  const previewById = useMemo(() => Object.fromEntries(dtpl.charts.map((c) => [c.id, c])), [dtpl])

  const setChart = (ci: number, patch: Partial<MetricChartDef>) =>
    setTpl((t) => ({ ...t, charts: t.charts.map((c, i) => (i === ci ? { ...c, ...patch } : c)) }))
  const mutQueries = (ci: number, key: 'series' | 'fields', fn: (arr: MetricQuery[]) => MetricQuery[]) =>
    setTpl((t) => ({ ...t, charts: t.charts.map((c, i) => (i === ci ? { ...c, [key]: fn(c[key]) } : c)) }))
  const setQ = (ci: number, key: 'series' | 'fields', qi: number, patch: Partial<MetricQuery>) =>
    mutQueries(ci, key, (arr) => arr.map((q, i) => (i === qi ? { ...q, ...patch } : q)))

  const moveChart = (ci: number, dir: -1 | 1) =>
    setTpl((t) => {
      const charts = [...t.charts]
      const j = ci + dir
      if (j < 0 || j >= charts.length) return t
      ;[charts[ci], charts[j]] = [charts[j], charts[ci]]
      return { ...t, charts }
    })
  const removeChart = (ci: number) => setTpl((t) => ({ ...t, charts: t.charts.filter((_, i) => i !== ci) }))
  const addChart = () =>
    setTpl((t) => ({
      ...t,
      charts: [...t.charts, { id: newChartId(), label: 'New entity', viz: 'timeseries', unit: 'percent', gear: 'none', series: [newSeries()], fields: [] }],
    }))

  const save = () => {
    clusterStore.saveTemplate(category, tpl)
    onClose()
  }
  const catLabel = category === 'lxc' ? 'LXC Containers' : 'Virtual Machines'

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>Metric template · {catLabel}</div>
        <div className={styles.modalNote}>
          Each entity can plot multiple <b>series</b> and show extra scalar <b>fields</b> for density. Use <code>$id</code> in
          a query (→ guest id, e.g. <code>lxc/177</code>).
        </div>

        <div className={styles.tplRangeRow}>
          <label>
            Range (s)
            <input type="number" value={tpl.rangeSeconds} onChange={(e) => setTpl((t) => ({ ...t, rangeSeconds: Number(e.target.value) || 3600 }))} />
          </label>
          <label>
            Step (s)
            <input type="number" value={tpl.stepSeconds} onChange={(e) => setTpl((t) => ({ ...t, stepSeconds: Number(e.target.value) || 60 }))} />
          </label>
        </div>

        <div className={styles.tplCharts}>
          {tpl.charts.map((c, ci) => (
            <div key={c.id} className={styles.tplChart}>
              <div className={styles.tplChartTop}>
                <input className={styles.tplLabel} value={c.label} placeholder="Entity title" onChange={(e) => setChart(ci, { label: e.target.value })} />
                <select value={c.viz} onChange={(e) => setChart(ci, { viz: e.target.value as VizType })} title="Visualization">
                  {VIZ_TYPES.map((v) => (<option key={v} value={v}>{v}</option>))}
                </select>
                <select value={c.unit} onChange={(e) => setChart(ci, { unit: e.target.value as MetricUnit })} title="Primary unit">
                  {UNITS.map((u) => (<option key={u} value={u}>{u}</option>))}
                </select>
                <select value={c.gear} onChange={(e) => setChart(ci, { gear: e.target.value as GearEdit })} title="Gear opens editor">
                  {GEARS.map((g) => (<option key={g} value={g}>⚙ {g}</option>))}
                </select>
                <button className={styles.iconBtn} title="Move up" onClick={() => moveChart(ci, -1)}><ArrowUp size={13} /></button>
                <button className={styles.iconBtn} title="Move down" onClick={() => moveChart(ci, 1)}><ArrowDown size={13} /></button>
                <button className={`${styles.iconBtn} ${styles.danger}`} title="Remove entity" onClick={() => removeChart(ci)}><Trash2 size={13} /></button>
              </div>

              {/* Plotted series */}
              <div className={styles.qSection}>
                <div className={styles.qSectionHead}>
                  Series (plotted)
                  <button className={styles.miniAdd} onClick={() => mutQueries(ci, 'series', (a) => [...a, newSeries()])}><Plus size={11} /> series</button>
                </div>
                {c.series.map((s, si) => (
                  <div key={s.id} className={styles.qRow}>
                    <input className={styles.qLabel} value={s.label} placeholder="label" onChange={(e) => setQ(ci, 'series', si, { label: e.target.value })} />
                    <input type="color" className={styles.tplColor} value={s.color ?? '#4ea1ff'} onChange={(e) => setQ(ci, 'series', si, { color: e.target.value })} />
                    <input className={styles.qQuery} value={s.query} placeholder='PromQL — $id' onChange={(e) => setQ(ci, 'series', si, { query: e.target.value })} />
                    <button className={`${styles.iconBtn} ${styles.danger}`} disabled={c.series.length <= 1} title="Remove series" onClick={() => mutQueries(ci, 'series', (a) => a.filter((_, i) => i !== si))}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>

              {/* Scalar fields */}
              <div className={styles.qSection}>
                <div className={styles.qSectionHead}>
                  Fields (text read-outs)
                  <button className={styles.miniAdd} onClick={() => mutQueries(ci, 'fields', (a) => [...a, newField()])}><Plus size={11} /> field</button>
                </div>
                {c.fields.map((f, fi) => (
                  <div key={f.id} className={styles.qRow}>
                    <input className={styles.qLabel} value={f.label} placeholder="label" onChange={(e) => setQ(ci, 'fields', fi, { label: e.target.value })} />
                    <select className={styles.qUnit} value={f.unit ?? 'raw'} onChange={(e) => setQ(ci, 'fields', fi, { unit: e.target.value as MetricUnit })}>
                      {UNITS.map((u) => (<option key={u} value={u}>{u}</option>))}
                    </select>
                    <input className={styles.qQuery} value={f.query} placeholder='PromQL — $id' onChange={(e) => setQ(ci, 'fields', fi, { query: e.target.value })} />
                    <button className={`${styles.iconBtn} ${styles.danger}`} title="Remove field" onClick={() => mutQueries(ci, 'fields', (a) => a.filter((_, i) => i !== fi))}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>

              {/* Live preview */}
              <div className={styles.tplPreview}>
                <span className={styles.previewLabel}>preview · {sampleId}</span>
                {(() => {
                  const p = previewById[c.id]
                  if (!p) return <span className={styles.previewLabel}>…</span>
                  return (
                    <MetricChart
                      key={`${p.id}-${p.viz}-${p.series.length}-${p.fields.length}`}
                      title={p.label}
                      viz={p.viz}
                      unit={p.unit}
                      series={p.series.map((s) => ({ ...s, query: resolveQuery(s.query, sampleId) }))}
                      fields={p.fields.map((f) => ({ ...f, query: resolveQuery(f.query, sampleId) }))}
                      rangeSeconds={dtpl.rangeSeconds}
                      stepSeconds={dtpl.stepSeconds}
                      height={90}
                      refreshMs={30000}
                    />
                  )
                })()}
              </div>
            </div>
          ))}
        </div>

        <button className={styles.addChartBtn} onClick={addChart}><Plus size={13} /> Add entity</button>

        <div className={styles.modalActions}>
          <button onClick={() => setTpl(defaultTemplate(category))} title="Reset to defaults"><RotateCcw size={13} /> Reset</button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button className={styles.primary} onClick={save}>Save template</button>
        </div>
      </div>
    </div>
  )
}
