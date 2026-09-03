import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Folder, FolderOpen, ArrowUp, RefreshCw, Info, Save, Trash2, Copy } from 'lucide-react'
import { bulkRenamerStore as store, type Rule } from '../../stores/BulkRenamerStore'
import styles from './Files.module.scss'

const fmtSize = (n: number) =>
  n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(0) + ' MB'
  : n > 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B'

const RULE_LABELS: Record<Rule['type'], string> = {
  replace: 'Find & replace', trim: 'Trim characters', prefix: 'Add prefix', suffix: 'Add suffix',
  template: 'Rebuild from template', case: 'Change case', spaces: 'Replace spaces',
  strip: 'Strip characters', number: 'Sequential number', extension: 'Change extension',
}

const MetaBadge: React.FC<{ path: string }> = observer(({ path }) => {
  const m = store.meta[path]
  if (!m) return null
  const cls = m.task === 'segm' ? styles.badgeSegm : m.task === 'bbox' ? styles.badgeBbox : ''
  return (
    <>
      {m.task && <span className={`${styles.badge} ${cls}`}>{m.task}</span>}
      {m.arch && <span className={styles.badge}>{m.arch}</span>}
      {m.dim && <span className={styles.badge}>{m.dim}</span>}
      {m.ext_mismatch && <span className={`${styles.badge} ${styles.badgeWarn}`} title={m.warn}>.{m.fmt}</span>}
    </>
  )
})

const RuleEditor: React.FC<{ rule: any; i: number }> = observer(({ rule, i }) => {
  const up = (patch: any) => store.updateRule(i, patch)
  return (
    <div className={styles.rule}>
      <div className={styles.ruleHead}>
        <input type="checkbox" checked={rule.enabled !== false} onChange={(e) => up({ enabled: e.target.checked })} />
        <span className={styles.ruleName}>{RULE_LABELS[rule.type as Rule['type']] || rule.type}</span>
        <button className={styles.iconBtn} title="Move up" onClick={() => store.moveRule(i, -1)}>↑</button>
        <button className={styles.iconBtn} title="Move down" onClick={() => store.moveRule(i, 1)}>↓</button>
        <button className={styles.iconBtn} title="Remove" onClick={() => store.removeRule(i)}>×</button>
      </div>
      <div className={styles.ruleGrid}>
        {rule.type === 'replace' && (<>
          <span>Find</span><input className={styles.input} value={rule.find} onChange={(e) => up({ find: e.target.value })} placeholder="text or regex" />
          <span>Replace</span><input className={styles.input} value={rule.to} onChange={(e) => up({ to: e.target.value })} placeholder="(blank to delete)" />
          <span />
          <div className={styles.chkRow}>
            <label className={styles.chk}><input type="checkbox" checked={!!rule.regex} onChange={(e) => up({ regex: e.target.checked })} />regex</label>
            <label className={styles.chk}><input type="checkbox" checked={!!rule.ci} onChange={(e) => up({ ci: e.target.checked })} />ignore case</label>
            <label className={styles.chk}><input type="checkbox" checked={rule.all !== false} onChange={(e) => up({ all: e.target.checked })} />all</label>
          </div>
        </>)}
        {rule.type === 'trim' && (<>
          <span>Remove from</span>
          <select className={styles.input} value={rule.from} onChange={(e) => up({ from: e.target.value })}>
            <option value="start">start of name</option><option value="end">end of name</option>
          </select>
          <span>Characters</span>
          <input className={styles.input} type="number" min={0} max={200} value={rule.count}
            onChange={(e) => up({ count: Number(e.target.value) })} />
          <span />
          <span className={styles.hintInline}>counts the name only — never the extension</span>
        </>)}
        {(rule.type === 'prefix' || rule.type === 'suffix') && (<>
          <span>Text</span><input className={styles.input} value={rule.text} onChange={(e) => up({ text: e.target.value })} placeholder="[{task}.{arch}] " />
        </>)}
        {rule.type === 'template' && (<>
          <span>Pattern</span><input className={styles.input} value={rule.pattern} onChange={(e) => up({ pattern: e.target.value })} />
        </>)}
        {rule.type === 'case' && (<>
          <span>Mode</span>
          <select className={styles.input} value={rule.mode} onChange={(e) => up({ mode: e.target.value })}>
            <option value="lower">lower</option><option value="upper">UPPER</option><option value="title">Title</option>
            <option value="snake">snake_case</option><option value="kebab">kebab-case</option>
          </select>
        </>)}
        {rule.type === 'spaces' && (<>
          <span>Replace with</span><input className={styles.input} value={rule.to} onChange={(e) => up({ to: e.target.value })} placeholder="_" />
        </>)}
        {rule.type === 'strip' && (<>
          <span>Characters</span><input className={styles.input} value={rule.chars} onChange={(e) => up({ chars: e.target.value })} placeholder="()[]" />
          <span />
          <label className={styles.chk}><input type="checkbox" checked={rule.collapse !== false} onChange={(e) => up({ collapse: e.target.checked })} />collapse repeats of _ - .</label>
        </>)}
        {rule.type === 'number' && (<>
          <span>Pad</span><input className={styles.input} type="number" min={1} max={6} value={rule.pad} onChange={(e) => up({ pad: Number(e.target.value) })} />
          <span>Separator</span><input className={styles.input} value={rule.sep} onChange={(e) => up({ sep: e.target.value })} />
          <span>Position</span>
          <select className={styles.input} value={rule.position} onChange={(e) => up({ position: e.target.value })}>
            <option value="suffix">suffix</option><option value="prefix">prefix</option>
          </select>
        </>)}
        {rule.type === 'extension' && (<>
          <span>New extension</span><input className={styles.input} value={rule.to} onChange={(e) => up({ to: e.target.value })} placeholder="pt or {fmt}" />
        </>)}
      </div>
    </div>
  )
})

/** Variable reference. Served from the backend so it cannot drift from the engine. */
const VariableRef: React.FC = observer(() => {
  const [copied, setCopied] = useState('')
  const copy = (t: string) => {
    const tok = '{' + t + '}'
    void navigator.clipboard?.writeText(tok).catch(() => {})
    setCopied(t); setTimeout(() => setCopied(''), 900)
  }
  const anyMeta = Object.keys(store.meta).length > 0
  return (
    <div className={styles.varRef}>
      {store.varGroups.map((g) => (
        <div key={g.group} className={styles.varGroup}>
          <div className={styles.varGroupName}>
            {g.group}
            {g.needsMeta && !anyMeta && <span className={styles.varNeedsMeta} title="These are empty until you press Read metadata">needs metadata</span>}
          </div>
          {g.items.map((it) => (
            <button key={it.t} className={styles.varRow} title="Click to copy" onClick={() => copy(it.t)}>
              <code className={styles.varTok}>{'{' + it.t + '}'}</code>
              <span className={styles.varDesc}>{it.d}</span>
              {copied === it.t ? <span className={styles.varCopied}>copied</span> : <Copy size={10} className={styles.varCopyIcon} />}
            </button>
          ))}
        </div>
      ))}
      {!store.varGroups.length && <div className={styles.empty}>variable list unavailable</div>}
    </div>
  )
})

export const BulkRenamerPanel: React.FC = observer(() => {
  useEffect(() => {
    void store.loadRoots(); void store.loadVariables(); void store.loadTemplates()
  }, [])
  const [newTpl, setNewTpl] = useState('')

  const errs = store.errorRows.length
  const changed = store.changedRows.length

  return (
    <div className={styles.renamer}>
      {/* ── folders ── */}
      <div className={styles.col}>
        <div className={styles.colHead}><Folder size={13} />Folders</div>
        <div className={styles.crumb}>{store.cwd || '—'}</div>
        <div className={styles.colBody}>
          {store.roots.map((r) => (
            <button key={r} className={`${styles.treeRow} ${styles.rootRow}`} onClick={() => void store.open(r)}>
              <FolderOpen size={13} />{r}
            </button>
          ))}
          {store.parent && <button className={styles.treeRow} onClick={() => void store.open(store.parent!)}><ArrowUp size={13} />..</button>}
          {store.dirs.map((d) => (
            <button key={d.path} className={styles.treeRow} onClick={() => void store.open(d.path)}>
              <Folder size={13} />{d.name}
            </button>
          ))}
          {!store.loading && !store.dirs.length && !store.parent && <div className={styles.empty}>no subfolders</div>}
        </div>
      </div>

      {/* ── main workspace: preview on top, file list below ── */}
      <div className={styles.center}>
        <div className={styles.previewPane}>
          <div className={styles.colHead}>
            Preview
            <span className={styles.spacer} />
            {store.planning && <RefreshCw size={11} className={styles.spin} />}
            <span className={styles.fsize}>
              {changed} change{changed === 1 ? '' : 's'}{errs ? <span className={styles.errText}>, {errs} blocked</span> : ''}
            </span>
          </div>
          <div className={styles.previewBody}>
            {!store.selCount && <div className={styles.empty}>Check files below to preview a rename.</div>}
            {!!store.selCount && !store.rules.length && <div className={styles.empty}>Add a rule on the right to see the result here.</div>}
            {store.rows.map((r) => (
              <div key={r.from} className={`${styles.pvRow} ${r.error ? styles.pvRowErr : ''}`}>
                <span className={styles.pvOld} title={r.oldName}>{r.oldName}</span>
                <span className={styles.pvArrow}>→</span>
                {r.error ? <span className={styles.pvErrInline}>{r.error}</span>
                  : r.changed ? <span className={styles.pvNew} title={r.newName}>{r.newName}</span>
                              : <span className={styles.pvSame}>unchanged</span>}
                {!!r.sidecars?.length && <span className={styles.pvSideTag} title={r.sidecars.map((s) => s.to.split('/').pop()).join('\n')}>+{r.sidecars.length}</span>}
              </div>
            ))}
          </div>
        </div>

        <div className={styles.filePane}>
          <div className={styles.colHead}>
            Files
            <span className={styles.spacer} />
            <span className={styles.fsize}>{store.selCount} of {store.files.length} selected</span>
          </div>
          <div className={styles.toolbar}>
            <input className={styles.input} placeholder="filter…" value={store.filter} onChange={(e) => { store.filter = e.target.value }} />
            <button className={styles.btn} onClick={() => store.selectAllVisible()}>Select all</button>
            <button className={styles.btn} onClick={() => store.clearSelection()}>None</button>
            <button className={styles.btn} disabled={!store.selCount || store.metaLoading} onClick={() => void store.loadMeta()}>
              {store.metaLoading ? <RefreshCw size={11} className={styles.spin} /> : <Info size={11} />} Read metadata
            </button>
          </div>
          <div className={styles.fileBody}>
            {store.visibleFiles.map((f) => (
              <div key={f.path} className={`${styles.fileRow} ${store.selected.has(f.path) ? styles.fileRowSel : ''}`} onClick={() => store.toggle(f.path)}>
                <input type="checkbox" readOnly checked={store.selected.has(f.path)} />
                <span className={styles.fname} title={f.name}>{f.name}</span>
                <MetaBadge path={f.path} />
                <span className={styles.fsize}>{fmtSize(f.size)}</span>
              </div>
            ))}
            {!store.loading && !store.visibleFiles.length && <div className={styles.empty}>no files here</div>}
          </div>
        </div>
      </div>

      {/* ── rules on top, variable reference below ── */}
      <div className={`${styles.col} ${styles.colLast}`}>
        <div className={styles.rulesPane}>
          <div className={styles.colHead}>Rules{store.tplName && <span className={styles.tplTag}>{store.tplName}</span>}</div>

          <div className={styles.toolbar}>
            <select className={styles.input} value="" onChange={(e) => { if (e.target.value) store.loadTemplate(e.target.value) }}>
              <option value="">load template…</option>
              {store.templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            {!!store.templates.length && (
              <button className={styles.iconBtn} title="Delete the loaded template" disabled={!store.tplName}
                onClick={() => { if (store.tplName && confirm(`Delete template "${store.tplName}"?`)) void store.deleteTemplate(store.tplName) }}>
                <Trash2 size={11} />
              </button>
            )}
          </div>
          <div className={styles.toolbar}>
            <input className={styles.input} placeholder="save these rules as…" value={newTpl} onChange={(e) => setNewTpl(e.target.value)} />
            <button className={styles.btn} disabled={!newTpl.trim() || !store.rules.length}
              onClick={() => { void store.saveTemplate(newTpl); setNewTpl('') }}>
              <Save size={11} /> Save
            </button>
          </div>

          <div className={styles.toolbar}>
            <select className={styles.input} value="" onChange={(e) => { if (e.target.value) store.addRule(e.target.value as any) }}>
              <option value="">+ add rule…</option>
              {Object.entries(RULE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label className={styles.chk}>
              <input type="checkbox" checked={store.includeSidecars} onChange={(e) => { store.includeSidecars = e.target.checked; void store.plan() }} />
              sidecars
            </label>
          </div>

          <div className={styles.rulesBody}>
            {store.rules.map((r, i) => <RuleEditor key={i} rule={r} i={i} />)}
            {!store.rules.length && <div className={styles.hint}>No rules yet. Add one above, or load a saved template.</div>}
          </div>

          {store.error && <div className={styles.errorBar}>{store.error}</div>}
          {store.result && (
            <div className={store.result.failed ? styles.errorBar : styles.okBar}>
              Renamed {store.result.renamed} file(s){store.result.failed ? `, ${store.result.failed} failed` : ''}.
            </div>
          )}
          <div className={styles.applyBar}>
            <span className={styles.fsize}>
              {errs ? <span className={styles.errText}>{errs} blocked — will be skipped</span> : 'ready'}
            </span>
            <span className={styles.spacer} />
            <button className={`${styles.btn} ${errs ? styles.btnDanger : styles.btnPrimary}`}
              disabled={!changed || store.applying}
              onClick={() => { if (confirm(`Rename ${changed} file(s)?${errs ? `\n\n${errs} blocked row(s) will be SKIPPED.` : ''}`)) void store.apply() }}>
              {store.applying ? 'Renaming…' : `Rename ${changed} file${changed === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>

        <div className={styles.varPane}>
          <div className={styles.colHead}>Variables</div>
          <VariableRef />
        </div>
      </div>
    </div>
  )
})
