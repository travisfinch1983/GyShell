import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { Folder, FolderOpen, ArrowUp, RefreshCw, Info } from 'lucide-react'
import { bulkRenamerStore as store, type Rule } from '../../stores/BulkRenamerStore'
import styles from './Files.module.scss'

const fmtSize = (n: number) =>
  n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(0) + ' MB'
  : n > 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B'

const RULE_LABELS: Record<Rule['type'], string> = {
  replace: 'Find & replace', prefix: 'Add prefix', suffix: 'Add suffix',
  template: 'Rebuild from template', case: 'Change case', spaces: 'Replace spaces',
  strip: 'Strip characters', number: 'Sequential number', extension: 'Change extension',
}

/** Metadata badge — the task tag is the whole point of the tool, so it is shown inline. */
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
      {m.warn && <span className={`${styles.badge} ${styles.badgeWarn}`} title={m.warn}>!</span>}
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
          <div style={{ display: 'flex', gap: 10 }}>
            <label className={styles.chk}><input type="checkbox" checked={!!rule.regex} onChange={(e) => up({ regex: e.target.checked })} />regex</label>
            <label className={styles.chk}><input type="checkbox" checked={!!rule.ci} onChange={(e) => up({ ci: e.target.checked })} />ignore case</label>
            <label className={styles.chk}><input type="checkbox" checked={rule.all !== false} onChange={(e) => up({ all: e.target.checked })} />all</label>
          </div>
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
          <span>New extension</span><input className={styles.input} value={rule.to} onChange={(e) => up({ to: e.target.value })} placeholder="pt" />
        </>)}
      </div>
    </div>
  )
})

export const BulkRenamerPanel: React.FC = observer(() => {
  useEffect(() => { void store.loadRoots() }, [])

  const errs = store.errorRows.length
  const changed = store.changedRows.length

  return (
    <div className={styles.renamer}>
      {/* ── tree ── */}
      <div className={styles.col}>
        <div className={styles.colHead}><Folder size={13} />Folders</div>
        <div className={styles.crumb}>{store.cwd || '—'}</div>
        <div className={styles.colBody}>
          {store.roots.map((r) => (
            <button key={r} className={`${styles.treeRow} ${styles.rootRow}`} onClick={() => void store.open(r)}>
              <FolderOpen size={13} />{r}
            </button>
          ))}
          {store.parent && (
            <button className={styles.treeRow} onClick={() => void store.open(store.parent!)}><ArrowUp size={13} />..</button>
          )}
          {store.dirs.map((d) => (
            <button key={d.path} className={styles.treeRow} onClick={() => void store.open(d.path)}>
              <Folder size={13} />{d.name}
            </button>
          ))}
          {!store.loading && !store.dirs.length && !store.parent && <div className={styles.empty}>no subfolders</div>}
        </div>
      </div>

      {/* ── files ── */}
      <div className={styles.col}>
        <div className={styles.colHead}>
          Files
          <span className={styles.spacer} />
          <span className={styles.fsize}>{store.selCount} of {store.files.length} selected</span>
        </div>
        <div className={styles.toolbar}>
          <input className={styles.input} placeholder="filter…" value={store.filter}
            onChange={(e) => { store.filter = e.target.value }} />
          <button className={styles.btn} onClick={() => store.selectAllVisible()}>Select all</button>
          <button className={styles.btn} onClick={() => store.clearSelection()}>None</button>
          <button className={styles.btn} disabled={!store.selCount || store.metaLoading} onClick={() => void store.loadMeta()}>
            {store.metaLoading ? <RefreshCw size={11} className={styles.spin} /> : <Info size={11} />} Read metadata
          </button>
        </div>
        <div className={styles.colBody}>
          {store.visibleFiles.map((f) => (
            <div key={f.path} className={`${styles.fileRow} ${store.selected.has(f.path) ? styles.fileRowSel : ''}`}
              onClick={() => store.toggle(f.path)}>
              <input type="checkbox" readOnly checked={store.selected.has(f.path)} />
              <span className={styles.fname} title={f.name}>{f.name}</span>
              <MetaBadge path={f.path} />
              <span className={styles.fsize}>{fmtSize(f.size)}</span>
            </div>
          ))}
          {!store.loading && !store.visibleFiles.length && <div className={styles.empty}>no files here</div>}
        </div>
      </div>

      {/* ── rules + preview ── */}
      <div className={`${styles.col} ${styles.colLast}`}>
        <div className={styles.colHead}>Rules</div>
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
        <div className={styles.colBody}>
          {store.rules.map((r, i) => <RuleEditor key={i} rule={r} i={i} />)}
          {!store.rules.length && (
            <div className={styles.hint}>
              Add a rule to see a preview. Tokens usable in prefix / suffix / template:
              <div className={styles.tokens}>{'{name} {ext} {parent} {i} {i:3} {n} {size}'}</div>
              Detectors / models: <span className={styles.tokens}>{'{task} {head} {arch} {proto} {nc} {imgsz} {top_tag}'}</span>
              <br />Images: <span className={styles.tokens}>{'{w} {h} {dim} {mp} {ar} {orient} {fmt}'}</span>
              {' '}— {'{fmt}'} is sniffed from magic bytes, so it is the REAL format even when the extension lies.
              Metadata tokens need <b>Read metadata</b> first. Sidecars renames matching
              <span className={styles.tokens}> .json / .jpeg / .civit.info</span> files alongside each model.
            </div>
          )}

          {!!store.rows.length && (<>
            <div className={styles.colHead} style={{ borderTop: '1px solid var(--border)', marginTop: 6 }}>
              Preview — {changed} change{changed === 1 ? '' : 's'}{errs ? `, ${errs} blocked` : ''}
            </div>
            <div className={styles.preview}>
              {store.rows.map((r) => (
                <div key={r.from} className={`${styles.pvRow} ${r.error ? styles.pvRowErr : ''}`}>
                  <span className={styles.pvOld} title={r.oldName}>{r.oldName}</span>
                  <span className={styles.pvArrow}>→</span>
                  {r.error ? <span className={styles.pvNew} /> :
                    r.changed ? <span className={styles.pvNew} title={r.newName}>{r.newName}</span>
                              : <span className={styles.pvSame}>unchanged</span>}
                  {r.error && <span className={styles.pvErr}>{r.error}</span>}
                  {!!r.sidecars?.length && <span className={styles.pvSide}>+{r.sidecars.length} sidecar file(s)</span>}
                </div>
              ))}
            </div>
          </>)}
        </div>

        {store.error && <div className={styles.errorBar}>{store.error}</div>}
        {store.result && (
          <div className={store.result.failed ? styles.errorBar : styles.okBar}>
            Renamed {store.result.renamed} file(s){store.result.failed ? `, ${store.result.failed} failed` : ''}.
          </div>
        )}
        <div className={styles.toolbar} style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
          <span className={styles.fsize}>
            {errs ? <span style={{ color: 'var(--danger)' }}>{errs} row(s) blocked — fix or they are skipped</span> : 'ready'}
          </span>
          <span className={styles.spacer} />
          <button className={`${styles.btn} ${errs ? styles.btnDanger : styles.btnPrimary}`}
            disabled={!changed || store.applying}
            onClick={() => { if (confirm(`Rename ${changed} file(s)?${errs ? `\n\n${errs} blocked row(s) will be SKIPPED.` : ''}`)) void store.apply() }}>
            {store.applying ? 'Renaming…' : `Rename ${changed} file${changed === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
})
