import { makeAutoObservable, runInAction } from 'mobx'

/**
 * BulkRenamerStore — Files tab -> Bulk Renamer sub-tab.
 *
 * The preview shown here is NOT the mapping that gets executed: /apply recomputes the plan
 * server-side from the same rules and refuses anything unsafe. So this store can render an
 * optimistic preview without that preview becoming the source of truth for a destructive op.
 */
export interface FsFile { name: string; path: string; size: number; mtime: number; ext: string }
export interface FsDir { name: string; path: string }
export interface FileMeta {
  kind?: string; task?: string; head?: string; arch?: string; proto?: boolean
  nc?: number; imgsz?: string; tensors?: number; dtypes?: string[]
  top_tag?: string; size?: number; warn?: string; error?: string; preview?: string
  w?: number; h?: number; dim?: string; mp?: number; ar?: string
  orient?: 'sq' | 'land' | 'port'; fmt?: string; ext_mismatch?: boolean
}
export type Rule =
  | { type: 'replace'; enabled?: boolean; find: string; to: string; regex?: boolean; ci?: boolean; all?: boolean }
  | { type: 'prefix'; enabled?: boolean; text: string }
  | { type: 'suffix'; enabled?: boolean; text: string }
  | { type: 'template'; enabled?: boolean; pattern: string }
  | { type: 'case'; enabled?: boolean; mode: 'lower' | 'upper' | 'title' | 'snake' | 'kebab' }
  | { type: 'spaces'; enabled?: boolean; to: string }
  | { type: 'strip'; enabled?: boolean; chars: string; collapse?: boolean }
  | { type: 'number'; enabled?: boolean; start?: number; pad?: number; sep?: string; position: 'prefix' | 'suffix' }
  | { type: 'extension'; enabled?: boolean; to: string }
  | { type: 'trim'; enabled?: boolean; from: 'start' | 'end'; count: number }

export interface PlanRow {
  from: string; dir: string; oldName: string; newName?: string; to?: string
  changed?: boolean; error?: string; sidecars?: { from: string; to: string }[]
}

export class BulkRenamerStore {
  roots: string[] = []
  cwd = ''
  dirs: FsDir[] = []
  files: FsFile[] = []
  parent: string | null = null
  loading = false
  error = ''

  selected = new Set<string>()
  meta: Record<string, FileMeta> = {}
  metaLoading = false

  rules: Rule[] = []
  includeSidecars = true
  rows: PlanRow[] = []
  planning = false
  applying = false
  result: { renamed: number; failed: number; msg?: string } | null = null

  filter = ''

  templates: { name: string; rules: Rule[]; note?: string; saved?: number }[] = []
  varGroups: { group: string; needsMeta?: boolean; items: { t: string; d: string }[] }[] = []
  tplName = ''

  constructor() { makeAutoObservable(this) }

  get visibleFiles(): FsFile[] {
    const f = this.filter.trim().toLowerCase()
    return f ? this.files.filter((x) => x.name.toLowerCase().includes(f)) : this.files
  }
  get selCount() { return this.selected.size }
  get errorRows() { return this.rows.filter((r) => r.error) }
  get changedRows() { return this.rows.filter((r) => r.changed && !r.error) }

  async loadRoots() {
    try {
      const r = await fetch('/api/files/roots')
      const d = await r.json()
      runInAction(() => { this.roots = d.roots || [] })
      if (!this.cwd && this.roots.length) await this.open(this.roots[0])
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
  }

  async open(path: string) {
    runInAction(() => { this.loading = true; this.error = '' })
    try {
      const r = await fetch('/api/files/list?path=' + encodeURIComponent(path))
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'list failed')
      runInAction(() => {
        this.cwd = d.path; this.dirs = d.dirs || []; this.files = d.files || []
        this.parent = d.parent; this.selected.clear(); this.rows = []; this.result = null
      })
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
    finally { runInAction(() => { this.loading = false }) }
  }

  toggle(path: string) {
    const s = new Set(this.selected)
    s.has(path) ? s.delete(path) : s.add(path)
    runInAction(() => { this.selected = s; this.result = null })
    void this.plan()
  }
  selectAllVisible() {
    const s = new Set(this.selected)
    for (const f of this.visibleFiles) s.add(f.path)
    runInAction(() => { this.selected = s; this.result = null }); void this.plan()
  }
  clearSelection() { runInAction(() => { this.selected = new Set(); this.rows = []; this.result = null }) }

  /** Metadata is opt-in per selection — probing 500 checkpoints is not free. */
  async loadMeta() {
    const paths = [...this.selected]
    if (!paths.length) return
    runInAction(() => { this.metaLoading = true })
    try {
      const r = await fetch('/api/files/metadata', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      })
      const d = await r.json()
      runInAction(() => { this.meta = { ...this.meta, ...(d.meta || {}) } })
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
    finally { runInAction(() => { this.metaLoading = false }) }
    void this.plan()
  }

  addRule(type: Rule['type']) {
    const defaults: Record<string, Rule> = {
      replace: { type: 'replace', find: '', to: '', regex: false, ci: false, all: true },
      prefix: { type: 'prefix', text: '' },
      suffix: { type: 'suffix', text: '' },
      template: { type: 'template', pattern: '[{task}.{arch}] {name}' },
      case: { type: 'case', mode: 'lower' },
      spaces: { type: 'spaces', to: '_' },
      strip: { type: 'strip', chars: '()[]', collapse: true },
      number: { type: 'number', pad: 2, sep: '_', position: 'suffix' },
      extension: { type: 'extension', to: '' },
      trim: { type: 'trim', from: 'start', count: 1 },
    }
    runInAction(() => { this.rules = [...this.rules, defaults[type]] })
    void this.plan()
  }
  updateRule(i: number, patch: any) {
    runInAction(() => { this.rules = this.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
    void this.plan()
  }
  removeRule(i: number) {
    runInAction(() => { this.rules = this.rules.filter((_, j) => j !== i) }); void this.plan()
  }
  moveRule(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= this.rules.length) return
    const next = [...this.rules]
    ;[next[i], next[j]] = [next[j], next[i]]
    runInAction(() => { this.rules = next }); void this.plan()
  }

  async plan() {
    const paths = [...this.selected]
    if (!paths.length || !this.rules.length) { runInAction(() => { this.rows = [] }); return }
    runInAction(() => { this.planning = true })
    try {
      const r = await fetch('/api/files/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, rules: this.rules, includeSidecars: this.includeSidecars }),
      })
      const d = await r.json()
      runInAction(() => { this.rows = d.rows || [] })
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
    finally { runInAction(() => { this.planning = false }) }
  }

  async loadVariables() {
    try {
      const r = await fetch('/api/files/variables')
      const d = await r.json()
      runInAction(() => { this.varGroups = d.groups || [] })
    } catch { /* the reference panel simply stays empty */ }
  }

  async loadTemplates() {
    try {
      const r = await fetch('/api/files/templates')
      const d = await r.json()
      runInAction(() => { this.templates = d.templates || [] })
    } catch { /* non-fatal */ }
  }

  async saveTemplate(name: string, note = '') {
    if (!name.trim() || !this.rules.length) return
    try {
      const r = await fetch('/api/files/templates', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), rules: this.rules, note }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'save failed')
      runInAction(() => { this.templates = d.templates || []; this.tplName = name.trim() })
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
  }

  /** Loading a template REPLACES the stack — merging two rule stacks silently would
   *  produce an order nobody chose. */
  loadTemplate(name: string) {
    const t = this.templates.find((x) => x.name === name)
    if (!t) return
    runInAction(() => { this.rules = t.rules.map((r) => ({ ...r })); this.tplName = t.name })
    void this.plan()
  }

  async deleteTemplate(name: string) {
    try {
      const r = await fetch('/api/files/templates/' + encodeURIComponent(name), { method: 'DELETE' })
      const d = await r.json()
      if (r.ok) runInAction(() => { this.templates = d.templates || []; if (this.tplName === name) this.tplName = '' })
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
  }

  async apply() {
    const paths = [...this.selected]
    if (!paths.length) return
    runInAction(() => { this.applying = true; this.result = null; this.error = '' })
    try {
      const r = await fetch('/api/files/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, rules: this.rules, includeSidecars: this.includeSidecars, confirm: true }),
      })
      const d = await r.json()
      if (!r.ok) {
        runInAction(() => { this.error = d?.error || 'apply failed'; if (d?.rows) this.rows = d.rows })
        return
      }
      runInAction(() => { this.result = { renamed: d.renamed || 0, failed: (d.failed || []).length } })
      await this.open(this.cwd)
    } catch (e: any) { runInAction(() => { this.error = String(e?.message || e) }) }
    finally { runInAction(() => { this.applying = false }) }
  }
}

export const bulkRenamerStore = new BulkRenamerStore()
