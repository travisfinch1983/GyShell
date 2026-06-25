import { makeAutoObservable, runInAction } from 'mobx'

/**
 * FileManagerStore — model-file browser (migrated from ProxLab file-manager.js).
 *
 * Browses the 4 configured roots (imagegen/llm/tts/downloads) via the cluster:request
 * bridge to ProxLab's /api/file-manager (SSH/pct-exec + model scan/classify; native
 * port later). MVP: browse + nav + mkdir/rename/delete + click-to-scan. Deferred:
 * HF/CivitAI download sub-tabs, drag-drop, multi-select, integrity UI.
 */
export interface FmScan {
  type?: string
  label?: string
  folder?: string
  color?: string
  misplaced?: boolean
  reason?: string
}
export interface FmFile {
  name: string
  path: string
  size?: number
  ext?: string
  scan?: FmScan
}
export interface FmDir {
  name: string
  path: string
}
export interface TabCfg {
  hostIp?: string
  vmid?: number | null
  basePath?: string
}

function joinRel(rel: string, name: string): string {
  return rel === '/' ? `/${name}` : `${rel}/${name}`
}

export class FileManagerStore {
  tabs: Record<string, TabCfg> = {}
  tabKeys: string[] = []
  activeTab = ''
  relDir = '/'
  fullDir = ''
  dirs: FmDir[] = []
  files: FmFile[] = []
  loading = false
  error: string | null = null
  busy = false
  scanning: Record<string, boolean> = {}
  loadedConfig = false

  constructor() {
    makeAutoObservable(this)
  }

  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }

  async loadConfig(): Promise<void> {
    if (this.loadedConfig) {
      void this.browse()
      return
    }
    this.loading = true
    try {
      const cfg = (await this.cluster().request('GET', '/api/file-manager/config')) as any
      const tabs = cfg?.tabs ?? {}
      // Only filesystem-browse roots — the download sub-tabs (hf-downloader/civitai/dl-queue)
      // are deferred to the native downloader port, not browseable here.
      const DOWNLOAD_TABS = new Set(['hf-downloader', 'civitai', 'dl-queue'])
      const keys = Object.keys(tabs).filter((k) => !DOWNLOAD_TABS.has(k) && tabs[k]?.basePath)
      runInAction(() => {
        this.tabs = tabs
        this.tabKeys = keys
        this.activeTab = this.activeTab || keys[0] || ''
        this.loadedConfig = true
      })
      await this.browse()
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
        this.loading = false
      })
    }
  }

  async browse(): Promise<void> {
    if (!this.activeTab) return
    this.loading = true
    try {
      const r = (await this.cluster().request(
        'GET',
        `/api/file-manager/browse?tab=${encodeURIComponent(this.activeTab)}&dir=${encodeURIComponent(this.relDir)}`,
      )) as any
      runInAction(() => {
        this.fullDir = r?.dir ?? ''
        this.dirs = (r?.dirs ?? []).sort((a: FmDir, b: FmDir) => a.name.localeCompare(b.name))
        this.files = (r?.files ?? []).sort((a: FmFile, b: FmFile) => a.name.localeCompare(b.name))
        this.error = null
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
        this.dirs = []
        this.files = []
      })
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }

  setTab(k: string): void {
    this.activeTab = k
    this.relDir = '/'
    void this.browse()
  }
  enter(name: string): void {
    this.relDir = joinRel(this.relDir, name)
    void this.browse()
  }
  up(): void {
    if (this.relDir === '/') return
    const parts = this.relDir.split('/').filter(Boolean)
    parts.pop()
    this.relDir = '/' + parts.join('/')
    void this.browse()
  }
  goToCrumb(index: number): void {
    const parts = this.relDir.split('/').filter(Boolean)
    this.relDir = '/' + parts.slice(0, index + 1).join('/')
    void this.browse()
  }
  get crumbs(): string[] {
    return this.relDir.split('/').filter(Boolean)
  }

  private async op(fn: () => Promise<unknown>): Promise<void> {
    this.busy = true
    try {
      await fn()
      await this.browse()
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.busy = false
      })
    }
  }

  mkdir(name: string): Promise<void> {
    const dirPath = this.fullDir ? `${this.fullDir.replace(/\/$/, '')}/${name}` : name
    return this.op(() => this.cluster().request('POST', '/api/file-manager/mkdir', { dirPath, tab: this.activeTab }))
  }
  rename(filePath: string, newName: string): Promise<void> {
    return this.op(() => this.cluster().request('POST', '/api/file-manager/rename', { filePath, newName, tab: this.activeTab }))
  }
  del(filePath: string): Promise<void> {
    return this.op(() => this.cluster().request('POST', '/api/file-manager/delete', { filePath, tab: this.activeTab }))
  }

  async scanFile(filePath: string): Promise<void> {
    runInAction(() => {
      this.scanning[filePath] = true
    })
    try {
      const r = (await this.cluster().request('POST', '/api/file-manager/scan', { files: [filePath], tab: this.activeTab })) as any
      const result = r?.results?.[filePath]
      runInAction(() => {
        if (result && !result.error) {
          this.files = this.files.map((f) => (f.path === filePath ? { ...f, scan: result } : f))
        }
      })
    } catch {
      /* ignore */
    } finally {
      runInAction(() => {
        delete this.scanning[filePath]
      })
    }
  }
}

export const fileManagerStore = new FileManagerStore()
