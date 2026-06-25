import { makeAutoObservable, runInAction } from 'mobx'

/**
 * ScriptsStore — Scripts tab (migrated from ProxLab scripts.js).
 *
 * Lists shell scripts from the server's /scripts dir and runs one on a target guest via
 * `pct exec` (one-shot output). Bridged through `cluster:request` for now (the native
 * SSH/pct-exec port comes in the finalization pass; rule #1 keeps it backend-side).
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

export class ScriptsStore {
  scripts: ScriptDef[] = []
  targets: Target[] = []
  selectedTarget = ''
  loading = false
  error: string | null = null
  outputs: Record<string, RunResult> = {}

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
