import { makeAutoObservable, runInAction } from 'mobx'

/**
 * ScriptsStore — Scripts tab (migrated from ProxLab scripts.js).
 *
 * Lists shell scripts from the server's /scripts dir and runs one on a target guest via
 * `pct exec` (one-shot output). Bridged through `cluster:request` for now (the native
 * SSH/pct-exec port comes in the finalization pass; rule #1 keeps it backend-side).
 *
 * Also drives a filesystem folder-picker (GET /api/scripts/browse) so path arguments can
 * be selected by browsing the AI-Lab container's mounts instead of typed by hand.
 */
export interface ScriptDef {
  name: string
  size?: number
  modified?: string
  description?: string
}
export interface RunResult {
  running?: boolean
  stdout?: string
  stderr?: string
  code?: number
  error?: string
}
interface Target {
  vmid: number
  name: string
  node?: string
}
interface DirEntry {
  name: string
  path: string
}
interface PickerState {
  open: boolean
  scriptName: string
  path: string
  parent: string | null
  dirs: DirEntry[]
  ebookCount: number
  loading: boolean
  error: string | null
}

export class ScriptsStore {
  scripts: ScriptDef[] = []
  targets: Target[] = []
  selectedTarget = ''
  loading = false
  error: string | null = null
  outputs: Record<string, RunResult> = {}
  // Per-script argument text (lifted from the card so the folder-picker can fill it).
  argsByScript: Record<string, string> = {}
  picker: PickerState = {
    open: false, scriptName: '', path: '/nas', parent: null,
    dirs: [], ebookCount: 0, loading: false, error: null,
  }

  constructor() {
    makeAutoObservable(this)
  }

  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }

  async load(): Promise<void> {
    this.loading = true
    try {
      const api = this.cluster()
      const [scripts, status] = await Promise.all([
        api.request('GET', '/api/scripts'),
        api.request('GET', '/api/pve/status'),
      ])
      const targets: Target[] = ((status?.containers ?? []) as any[])
        .filter((c) => c.status === 'running')
        .map((c) => ({ vmid: c.vmid, name: c.name, node: c.node }))
        .sort((a, b) => a.vmid - b.vmid)
      runInAction(() => {
        this.scripts = Array.isArray(scripts) ? scripts : []
        this.targets = targets
        if (!this.selectedTarget && targets[0]) this.selectedTarget = String(targets[0].vmid)
        this.error = null
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }

  setTarget(vmid: string): void {
    this.selectedTarget = vmid
  }

  setArgs(name: string, value: string): void {
    this.argsByScript[name] = value
  }

  // ─── Folder picker ─────────────────────────────────────────────────────────
  openPicker(scriptName: string): void {
    runInAction(() => {
      this.picker.open = true
      this.picker.scriptName = scriptName
      this.picker.error = null
    })
    const start = this.argsByScript[scriptName]?.trim() || this.picker.path || '/nas'
    void this.browseTo(start)
  }

  closePicker(): void {
    this.picker.open = false
  }

  async browseTo(path: string): Promise<void> {
    runInAction(() => {
      this.picker.loading = true
      this.picker.error = null
    })
    try {
      const d = await this.cluster().request('GET', `/api/scripts/browse?path=${encodeURIComponent(path)}`)
      runInAction(() => {
        if (d?.error) {
          this.picker.error = d.error
        } else {
          this.picker.path = d.path
          this.picker.parent = d.parent ?? null
          this.picker.dirs = Array.isArray(d.dirs) ? d.dirs : []
          this.picker.ebookCount = d.ebookCount ?? 0
          // Auto-select the container whose filesystem we're browsing as the run target.
          if (d.localVmid != null && String(this.selectedTarget) !== String(d.localVmid)) {
            this.selectedTarget = String(d.localVmid)
          }
        }
      })
    } catch (e) {
      runInAction(() => {
        this.picker.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.picker.loading = false
      })
    }
  }

  chooseCurrentFolder(): void {
    runInAction(() => {
      this.argsByScript[this.picker.scriptName] = this.picker.path
      this.picker.open = false
    })
  }

  async run(name: string, args: string): Promise<void> {
    if (!this.selectedTarget) {
      runInAction(() => {
        this.outputs[name] = { error: 'Select a target first' }
      })
      return
    }
    runInAction(() => {
      this.outputs[name] = { running: true }
    })
    try {
      const r = (await this.cluster().request('POST', `/api/scripts/${encodeURIComponent(name)}/run`, {
        target: this.selectedTarget,
        args,
      })) as RunResult
      runInAction(() => {
        this.outputs[name] = { stdout: r.stdout, stderr: r.stderr, code: r.code }
      })
    } catch (e) {
      runInAction(() => {
        this.outputs[name] = { error: e instanceof Error ? e.message : String(e) }
      })
    }
  }
}

export const scriptsStore = new ScriptsStore()
