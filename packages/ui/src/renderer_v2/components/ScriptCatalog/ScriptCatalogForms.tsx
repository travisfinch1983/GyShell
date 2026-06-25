import React, { useEffect, useMemo, useState } from 'react'
import { X, Copy, Check, Play, Save, Loader2 } from 'lucide-react'
import {
  scriptCatalogStore as store,
  buildInstallCommand,
  buildTemplateInstall,
  type CatalogScript,
  type SchemaField,
  type ClusterData,
  type NodeTemplate,
} from '../../stores/ScriptCatalogStore'
import styles from './ScriptCatalog.module.scss'

type Vals = Record<string, string>
const opt = (o: string | { value: string; label: string }) => (typeof o === 'string' ? { value: o, label: o } : o)

/** Seed the form value map from app||global defaults (per-node keys included). */
function seedValues(schema: SchemaField[], defaults: { global: Vals; app: Vals }, cd: ClusterData): Vals {
  const v: Vals = {}
  const pick = (k: string) => defaults.app[k] ?? defaults.global[k] ?? ''
  for (const f of schema) {
    if (f.type === 'readonly') continue
    if (f.type === 'node-storage') {
      for (const node of Object.keys(cd.storagesByNode ?? {})) {
        const pk = `${f.key}__${node}`
        const val = defaults.app[pk] ?? defaults.global[pk] ?? ''
        if (val) v[pk] = val
      }
      continue
    }
    const e = pick(f.key)
    if (f.type === 'checkbox') v[f.key] = e || f.default || f.falseVal || 'no'
    else if (e) v[f.key] = e
  }
  return v
}

/** Full options form — mirrors ProxLab buildOptionsForm field types. */
const OptionsForm: React.FC<{
  schema: SchemaField[]
  cd: ClusterData
  scriptDefs?: Vals
  vals: Vals
  set: (k: string, v: string) => void
}> = ({ schema, cd, scriptDefs = {}, vals, set }) => {
  const groups = useMemo(() => {
    const g: Record<string, SchemaField[]> = {}
    for (const f of schema) (g[f.group] ??= []).push(f)
    return g
  }, [schema])

  return (
    <>
      {Object.entries(groups).map(([group, fields]) => (
        <div key={group} className={styles.optGroup}>
          <div className={styles.optGroupLabel}>{group}</div>
          {fields.map((f) => {
            const v = vals[f.key] ?? ''
            const ph = scriptDefs[f.key] || f.default || ''
            const labelEl = <label className={styles.optLabel}>{f.label}</label>
            switch (f.type) {
              case 'readonly':
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <input className={styles.optInput} value={scriptDefs[f.key] || f.default || ''} readOnly title="Set by the script" />
                  </div>
                )
              case 'checkbox':
                return (
                  <div key={f.key} className={styles.optField}>
                    <label className={styles.optCheck}>
                      <input
                        type="checkbox"
                        checked={(v || f.default) === (f.trueVal || 'yes')}
                        onChange={(e) => set(f.key, e.target.checked ? f.trueVal || 'yes' : f.falseVal || 'no')}
                      />
                      {f.label}
                    </label>
                  </div>
                )
              case 'radio':
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <div className={styles.optRadioRow}>
                      {(f.options ?? []).map(opt).map((o) => (
                        <label key={o.value} className={styles.optRadio}>
                          <input type="radio" name={f.key} checked={(v || f.default) === o.value} onChange={() => set(f.key, o.value)} /> {o.label}
                        </label>
                      ))}
                    </div>
                  </div>
                )
              case 'slider': {
                const min = (f.min ?? 1) - (f.step ?? 1)
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <div className={styles.optSliderWrap}>
                      <input
                        type="range"
                        min={min}
                        max={f.max}
                        step={f.step}
                        value={v === '' ? min : v}
                        onChange={(e) => set(f.key, Number(e.target.value) <= min ? '' : e.target.value)}
                      />
                      <input
                        className={styles.optNum}
                        value={v}
                        placeholder="Default"
                        onChange={(e) => set(f.key, e.target.value.trim())}
                      />
                    </div>
                  </div>
                )
              }
              case 'select':
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <select className={styles.optInput} value={v} onChange={(e) => set(f.key, e.target.value)}>
                      <option value="">— default —</option>
                      {(f.options ?? []).map(opt).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                )
              case 'timezone':
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <select className={styles.optInput} value={v} onChange={(e) => set(f.key, e.target.value)}>
                      <option value="">— host timezone —</option>
                      {(cd.timezones ?? []).map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                    </select>
                  </div>
                )
              case 'multicheck': {
                const sel = v.split(',').map((s) => s.trim()).filter(Boolean)
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <div className={styles.optMulti}>
                      {(f.options ?? []).map(opt).map((o) => (
                        <label key={o.value} className={styles.optCheckInline}>
                          <input
                            type="checkbox"
                            checked={sel.includes(o.value)}
                            onChange={(e) => {
                              const next = e.target.checked ? [...sel, o.value] : sel.filter((x) => x !== o.value)
                              set(f.key, next.join(', '))
                            }}
                          /> {o.label}
                        </label>
                      ))}
                    </div>
                  </div>
                )
              }
              case 'sshkeys': {
                const keys = cd.sshKeys ?? []
                const lines = v.split('\n').filter(Boolean)
                const manual = lines.find((l) => !keys.some((k) => k.full === l)) ?? ''
                const setKeys = (checkedFulls: string[], man: string) => set(f.key, [...checkedFulls, ...(man.trim() ? [man.trim()] : [])].join('\n'))
                const checked = lines.filter((l) => keys.some((k) => k.full === l))
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <div className={styles.optMulti}>
                      {keys.map((k) => (
                        <label key={k.full} className={styles.optCheckInline}>
                          <input
                            type="checkbox"
                            checked={checked.includes(k.full)}
                            onChange={(e) => setKeys(e.target.checked ? [...checked, k.full] : checked.filter((x) => x !== k.full), manual)}
                          /> {k.comment} <span className={styles.optMuted}>({k.type})</span>
                        </label>
                      ))}
                      <input className={styles.optInput} placeholder="Or paste additional key…" value={manual} onChange={(e) => setKeys(checked, e.target.value)} />
                    </div>
                  </div>
                )
              }
              case 'node-storage': {
                const byNode = cd.storagesByNode ?? {}
                const cf = f.contentFilter || ''
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <div className={styles.optNodeStorages}>
                      {Object.entries(byNode).map(([node, storages]) => {
                        const filtered = storages.filter((s) => !cf || (s.content || '').toLowerCase().includes(cf))
                        const pk = `${f.key}__${node}`
                        return (
                          <div key={node} className={styles.optNodeRow}>
                            <span className={styles.optNodeName}>{node}</span>
                            {filtered.length === 0 ? (
                              <span className={styles.optMuted}>No eligible storage</span>
                            ) : (
                              <select className={styles.optInput} value={vals[pk] ?? ''} onChange={(e) => set(pk, e.target.value)}>
                                <option value="">— auto —</option>
                                {filtered.map((s) => <option key={s.storage} value={s.storage}>{s.storage} ({s.type}{s.shared ? ', shared' : ''})</option>)}
                              </select>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              }
              case 'password':
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <input type="password" className={styles.optInput} value={v} placeholder={ph} onChange={(e) => set(f.key, e.target.value)} />
                  </div>
                )
              default:
                return (
                  <div key={f.key} className={styles.optField}>
                    {labelEl}
                    <input className={styles.optInput} value={v} placeholder={ph} onChange={(e) => set(f.key, e.target.value)} />
                  </div>
                )
            }
          })}
        </div>
      ))}
    </>
  )
}

/* ─── Detail modal (full parity) ─── */
export const DetailModal: React.FC<{
  s: CatalogScript
  onClose: () => void
  onRun: (nodeIp: string, nodeName: string, command: string, setup?: { path: string; content: string }) => void
}> = ({ s, onClose, onRun }) => {
  const [defaults, setDefaults] = useState<{ global: Vals; app: Vals; hasGlobal: boolean; hasApp: boolean } | null>(null)
  const [vals, setVals] = useState<Vals>({})
  const [optsOpen, setOptsOpen] = useState(false)
  const [node, setNode] = useState('') // ip
  const [copied, setCopied] = useState(false)
  const [savedApp, setSavedApp] = useState(false)
  const [templates, setTemplates] = useState<NodeTemplate[]>([])
  const [tplLoading, setTplLoading] = useState(false)
  const [selectedTpl, setSelectedTpl] = useState('') // volid, '' = script default (auto)

  useEffect(() => {
    void (async () => {
      await store.loadFormDeps()
      const d = await store.getDefaults(s.slug)
      setDefaults(d)
      setVals(seedValues(store.schema, d, store.clusterData))
    })()
  }, [s.slug])

  // Load templates for the chosen node (native pveam over SSH), reset selection on node change.
  useEffect(() => {
    setSelectedTpl('')
    setTemplates([])
    if (!node) return
    setTplLoading(true)
    void store
      .listNodeTemplates(node)
      .then(setTemplates)
      .finally(() => setTplLoading(false))
  }, [node])

  const scriptDefs: Vals = {
    var_cpu: String(s.resources?.cpu ?? ''),
    var_ram: String(s.resources?.ram ?? ''),
    var_disk: String(s.resources?.disk ?? ''),
    var_os: s.resources?.os ?? '',
    var_version: s.resources?.version ?? '',
    var_unprivileged: s.privileged ? '0' : '1',
    var_hostname: s.slug,
  }
  const set = (k: string, v: string) => setVals((prev) => ({ ...prev, [k]: v }))
  const nodeName = store.nodes.find((n) => n.ip === node)?.node
  const cmd = s.installUrl ? buildInstallCommand(s.installUrl, vals, nodeName) : ''

  const copy = () => {
    if (cmd) {
      navigator.clipboard?.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
  }
  const saveApp = async () => {
    await store.saveAppDefaults(s.slug, vals)
    setSavedApp(true)
    setTimeout(() => setSavedApp(false), 2000)
  }
  const doRun = () => {
    if (!node || !s.installUrl) return
    const tpl = templates.find((t) => t.volid === selectedTpl)
    if (tpl) {
      // custom template: point template storage at it + force CUSTOM_TEMPLATE via the wrapper
      const runVals = { ...vals, var_template_storage: tpl.storage }
      const { command, setup } = buildTemplateInstall(s.installUrl, runVals, nodeName, tpl.name)
      onRun(node, nodeName || node, command, setup)
    } else {
      onRun(node, nodeName || node, buildInstallCommand(s.installUrl, vals, nodeName))
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalWide} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <div className={styles.modalTitle}>{s.name}</div>
          <span className={`${styles.srcBadge} ${s.source === 'proxlab' ? styles.proxlab : styles.community}`}>{s.source}</span>
          {defaults?.hasGlobal && <span className={styles.dfBadge}>Global Defaults</span>}
          {defaults?.hasApp && <span className={styles.dfBadge}>App Defaults</span>}
          <div style={{ flex: 1 }} />
          <button className={styles.iconBtn} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={styles.modalBody}>
          {s.description && <div className={styles.modalDesc}>{s.description}</div>}
          <div className={styles.modalMeta}>
            <span>{s.resources?.cpu}C / {s.resources?.ram ? Math.round(s.resources.ram / 1024) + 'G' : '?'} / {s.resources?.disk}G</span>
            {s.interfacePort ? <span>port {s.interfacePort}</span> : null}
          </div>
          {(s.notes ?? []).map((n, i) => (
            <div key={i} className={`${styles.note} ${styles['note_' + (n.type || 'info')] ?? ''}`}>{n.text}</div>
          ))}

          {/* Run on node */}
          <div className={styles.runRow}>
            <select className={styles.nodeSelect} value={node} onChange={(e) => setNode(e.target.value)}>
              <option value="">Select a node…</option>
              {store.nodes.map((n) => <option key={n.ip} value={n.ip}>{n.node} ({n.ip})</option>)}
            </select>
            <button className={styles.runBtn} disabled={!node} onClick={() => doRun()}>
              <Play size={13} /> Run Script
            </button>
          </div>

          {/* OS template picker (custom Debian base, etc.) */}
          <div className={styles.runRow}>
            <select
              className={styles.nodeSelect}
              value={selectedTpl}
              disabled={!node || tplLoading}
              onChange={(e) => setSelectedTpl(e.target.value)}
              title="OS template — defaults to the script's auto-selected template"
            >
              <option value="">{!node ? 'Select a node first' : tplLoading ? 'Loading templates…' : 'OS template: script default (auto)'}</option>
              {templates.map((t) => (
                <option key={t.volid} value={t.volid}>{t.storage}: {t.name}</option>
              ))}
            </select>
          </div>
          {selectedTpl && (
            <div className={styles.note}>
              Using custom template <b>{templates.find((t) => t.volid === selectedTpl)?.name}</b> — applied on Run via AI-Lab's patched build.func (not reflected in the copyable command below).
            </div>
          )}

          {/* Live command (standard auto-template form, for copy/paste) */}
          <div className={styles.cmdRow}>
            <code className={styles.cmd}>{cmd}</code>
            <button className={styles.copyBtn} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
          </div>

          {/* Options */}
          <button className={styles.optToggle} onClick={() => setOptsOpen((o) => !o)}>
            {optsOpen ? '▼' : '▶'} Install Options
            <span className={styles.optHint}>{defaults?.hasApp ? '(app defaults)' : defaults?.hasGlobal ? '(global defaults)' : '(script defaults)'}</span>
          </button>
          {optsOpen && (
            <div className={styles.optPane}>
              {defaults ? (
                <>
                  <OptionsForm schema={store.schema} cd={store.clusterData} scriptDefs={scriptDefs} vals={vals} set={set} />
                  <div className={styles.optActions}>
                    <button className={styles.saveBtn} onClick={() => void saveApp()}>{savedApp ? <Check size={13} /> : <Save size={13} />} {savedApp ? 'Saved' : 'Save as App Defaults'}</button>
                  </div>
                </>
              ) : (
                <div className={styles.optLoading}><Loader2 size={14} className={styles.spin} /> Loading options…</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Global defaults modal (the top-right config button) ─── */
export const GlobalDefaultsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [vals, setVals] = useState<Vals>({})
  const [ready, setReady] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void (async () => {
      await store.loadFormDeps()
      const cur = await store.getGlobalDefaults()
      setVals(seedValues(store.schema.filter((f) => f.type !== 'readonly'), { global: cur, app: {} }, store.clusterData))
      setReady(true)
    })()
  }, [])

  const set = (k: string, v: string) => setVals((prev) => ({ ...prev, [k]: v }))
  const save = async () => {
    await store.saveGlobalDefaults(vals)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }
  const clear = async () => {
    await store.saveGlobalDefaults({})
    setVals({})
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalWide} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <div className={styles.modalTitle}>Global Install Defaults</div>
          <div style={{ flex: 1 }} />
          <button className={styles.iconBtn} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalDesc}>These apply to ALL scripts — set your APT cacher, SSH key, timezone, storage, etc. once and they pre-fill every install. Per-script overrides live on each script.</div>
          {ready ? (
            <div className={styles.optPane}>
              <OptionsForm schema={store.schema.filter((f) => f.type !== 'readonly')} cd={store.clusterData} vals={vals} set={set} />
            </div>
          ) : (
            <div className={styles.optLoading}><Loader2 size={14} className={styles.spin} /> Loading…</div>
          )}
        </div>
        <div className={styles.modalFooter}>
          <button className={styles.ghostBtn} onClick={() => void clear()}>Clear All</button>
          <button className={styles.saveBtn} onClick={() => void save()}>{saved ? <Check size={13} /> : <Save size={13} />} {saved ? 'Saved' : 'Save Global Defaults'}</button>
        </div>
      </div>
    </div>
  )
}
