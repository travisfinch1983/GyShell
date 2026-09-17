import { makeAutoObservable, runInAction } from 'mobx'

/**
 * Model library manager state.
 *
 * Every move and rename goes through /api/model-library, which routes them through the SAME
 * function POST /api/civitai/rename uses — so reorganising here keeps civitai-history.json
 * pointing at the files and the downloader still recognises them. Nothing in this store
 * touches the filesystem directly for that reason.
 */
const API = '/api/model-library'
const IMG = '/api/imagegen'

export interface TreeNode {
  name: string
  path: string
  ownModels: number
  totalModels: number
  children: TreeNode[]
}

export interface LibItem {
  name: string
  base: string
  path: string
  dir: string
  size: number
  mtime: number
  preview: string | null
  imageCount: number
  tracked: boolean
  modelId: string | null
  versionId: string | null
  modelName: string | null
  versionName: string | null
  modelType: string | null
  baseModel: string | null
  creator: string | null
  downloadedAt: string | null
  pageUrl: string | null
}

export interface LibDetail {
  path: string
  dir: string
  name: string
  base: string
  size: number
  mtime: number
  media: Array<{ name: string; path: string; kind: 'image' | 'video' }>
  sidecars: string[]
  history: Record<string, any> | null
  version: Record<string, any> | null
  model: Record<string, any> | null
}

export interface RenameRow {
  path: string
  name?: string
  newName?: string
  unchanged?: boolean
  error?: string
  collision?: string
  modelName?: string | null
  versionName?: string | null
}

async function api(path: string, init?: { method?: string; body?: any }) {
  const res = await fetch(API + path, {
    method: init?.method || 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

export class ModelLibraryStore {
  tree: TreeNode | null = null
  expanded = new Set<string>()
  dir = 'loras'
  items: LibItem[] = []
  subdirs: string[] = []
  selected = new Set<string>()
  detail: LibDetail | null = null
  detailLoading = false
  lightbox: number | null = null

  loading = false
  error = ''
  msg = ''
  filter = ''
  /** Folder currently under a drag, so the drop target is obvious. */
  dropTarget = ''

  // ── template rename dialog ──
  renameOpen = false
  template = '$PRIMARY_TAG-$MODEL_FILE_NAME'
  renameRows: RenameRow[] = []
  renamePreviewing = false
  renameApplying = false

  constructor() { makeAutoObservable(this) }

  get visible(): LibItem[] {
    const q = this.filter.trim().toLowerCase()
    if (!q) return this.items
    return this.items.filter((i) =>
      `${i.name} ${i.modelName ?? ''} ${i.versionName ?? ''} ${i.baseModel ?? ''} ${i.creator ?? ''}`
        .toLowerCase().includes(q))
  }

  get selectedItems(): LibItem[] { return this.items.filter((i) => this.selected.has(i.path)) }

  thumb(path: string) { return `${IMG}/thumb?path=${encodeURIComponent(path)}` }
  image(path: string) { return `${IMG}/image?path=${encodeURIComponent(path)}` }

  async loadTree() {
    try {
      const d = await api('/tree')
      runInAction(() => { this.tree = d.root })
    } catch (e: any) {
      runInAction(() => { this.error = String(e?.message || e) })
    }
  }

  async open(dir: string) {
    this.loading = true; this.error = ''; this.detail = null
    try {
      const d = await api(`/list?dir=${encodeURIComponent(dir)}`)
      runInAction(() => {
        this.dir = d.dir
        this.items = d.items
        this.subdirs = d.subdirs
        this.selected = new Set()
      })
    } catch (e: any) {
      runInAction(() => { this.error = String(e?.message || e) })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  toggleExpand(path: string) {
    if (this.expanded.has(path)) this.expanded.delete(path)
    else this.expanded.add(path)
    this.expanded = new Set(this.expanded)
  }

  toggleSelect(path: string, additive: boolean) {
    if (!additive) {
      const only = this.selected.size === 1 && this.selected.has(path)
      this.selected = only ? new Set() : new Set([path])
    } else {
      if (this.selected.has(path)) this.selected.delete(path)
      else this.selected.add(path)
      this.selected = new Set(this.selected)
    }
  }

  selectAll() { this.selected = new Set(this.visible.map((i) => i.path)) }
  clearSelection() { this.selected = new Set() }

  async showDetail(path: string) {
    this.detailLoading = true; this.lightbox = null
    try {
      const d = await api(`/detail?path=${encodeURIComponent(path)}`)
      runInAction(() => { this.detail = d })
    } catch (e: any) {
      runInAction(() => { this.error = String(e?.message || e); this.detail = null })
    } finally {
      runInAction(() => { this.detailLoading = false })
    }
  }

  closeDetail() { this.detail = null; this.lightbox = null }

  /** Drag-and-drop. Paths default to the current selection so dragging one of several
   *  selected cards moves the whole selection, which is what every file manager does. */
  async moveTo(destDir: string, paths?: string[]) {
    const list = paths && paths.length ? paths : [...this.selected]
    if (!list.length) return
    this.msg = `Moving ${list.length}…`
    try {
      const d = await api('/move', { method: 'POST', body: { paths: list, destDir } })
      const failed = (d.results || []).filter((r: any) => !r.ok)
      const untracked = (d.results || []).filter((r: any) => r.ok && !r.tracked).length
      runInAction(() => {
        this.msg = failed.length
          ? `Moved ${d.results.length - failed.length}, ${failed.length} failed: ${failed[0]?.error ?? ''}`
          : `Moved ${d.results.length} to ${destDir}${untracked ? ` (${untracked} not in download history)` : ''}.`
      })
      await this.open(this.dir)
      await this.loadTree()
    } catch (e: any) {
      runInAction(() => { this.msg = 'Move failed: ' + String(e?.message || e) })
    }
  }

  async mkdir(dir: string) {
    await api('/mkdir', { method: 'POST', body: { dir } })
    await this.loadTree()
  }

  // ── template rename ──
  openRename() {
    if (!this.selected.size) return
    this.renameOpen = true
    this.renameRows = []
    void this.previewRename()
  }

  closeRename() { this.renameOpen = false; this.renameRows = [] }

  async previewRename() {
    if (!this.selected.size || !this.template.trim()) return
    this.renamePreviewing = true
    try {
      const d = await api('/rename-preview', {
        method: 'POST', body: { paths: [...this.selected], template: this.template },
      })
      runInAction(() => { this.renameRows = d.rows })
    } catch (e: any) {
      runInAction(() => { this.msg = 'Preview failed: ' + String(e?.message || e) })
    } finally {
      runInAction(() => { this.renamePreviewing = false })
    }
  }

  get renameChanged(): RenameRow[] {
    return this.renameRows.filter((r) => r.newName && !r.unchanged && !r.error && !r.collision)
  }

  get renameProblems(): RenameRow[] {
    return this.renameRows.filter((r) => r.error || r.collision)
  }

  async applyRename() {
    const rows = this.renameChanged
    if (!rows.length) return
    this.renameApplying = true
    try {
      const d = await api('/rename-apply', {
        method: 'POST',
        body: { renames: rows.map((r) => ({ path: r.path, newName: r.newName })) },
      })
      const failed = (d.results || []).filter((r: any) => !r.ok)
      runInAction(() => {
        this.msg = failed.length
          ? `Renamed ${d.results.length - failed.length}, ${failed.length} failed: ${failed[0]?.error ?? ''}`
          : `Renamed ${d.results.length}.`
        this.renameOpen = false
        this.renameRows = []
      })
      await this.open(this.dir)
    } catch (e: any) {
      runInAction(() => { this.msg = 'Rename failed: ' + String(e?.message || e) })
    } finally {
      runInAction(() => { this.renameApplying = false })
    }
  }
}

export const modelLibraryStore = new ModelLibraryStore()
