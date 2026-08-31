import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

/** MCPJungle gateway management — servers, tools, health, tool-proxy settings. */
export class McpServersStore {
  health: any = null
  servers: any[] = []
  tools: any[] = []
  settings: any = { maxToolRounds: 20 }
  loading = false
  loaded = false
  err = ''

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    this.loading = true; this.err = ''
    // 🛑 The per-call .catch(()=>[]) idiom made every failure invisible: a dead
    // /servers route rendered "No MCP servers registered" while the health
    // badge said Connected, and the outer catch (and this.err) were
    // unreachable because everything was absorbed inside. Now each fetch
    // keeps its OWN failure, the lists only overwrite on success (a stale
    // list beats a wrong "empty"), and err aggregates what actually failed.
    const failures: string[] = []
    const grab = async <T>(path: string, label: string): Promise<T | undefined> => {
      try { return await bridge().request('GET', path) } catch (e: any) {
        failures.push(`${label}: ${e?.message || 'failed'}`)
        return undefined
      }
    }
    const [h, s, t, cfg] = await Promise.all([
      grab<any>('/api/mcp/health', 'health'),
      grab<any>('/api/mcp/servers', 'servers'),
      grab<any>('/api/mcp/tools', 'tools'),
      grab<any>('/api/mcp/settings', 'settings'),
    ])
    runInAction(() => {
      this.health = h ?? { status: 'unreachable' }
      if (s !== undefined) this.servers = Array.isArray(s) ? s : []
      if (t !== undefined) this.tools = Array.isArray(t) ? t : []
      if (cfg !== undefined) this.settings = cfg || this.settings
      this.err = failures.join(' · ')
      this.loaded = true
      this.loading = false
    })
  }

  get connected(): boolean { return this.health?.status === 'ok' }
  get toolsByServer(): Record<string, any[]> {
    const m: Record<string, any[]> = {}
    for (const t of this.tools) (m[t.server] = m[t.server] || []).push(t)
    return m
  }
  toolCount(name: string): { total: number; enabled: number } {
    const ts = this.tools.filter((t) => t.server === name)
    return { total: ts.length, enabled: ts.filter((t) => t.enabled).length }
  }

  async deleteServer(name: string): Promise<void> {
    try {
      await bridge().request('DELETE', `/api/mcp/servers/${encodeURIComponent(name)}`)
    } catch (e: any) {
      // A failed delete used to be indistinguishable from success except the
      // row reappearing — say why instead.
      runInAction(() => { this.err = `delete '${name}' failed: ${e?.message || e}` })
    }
    await this.load()
  }
  async toggleTool(fullName: string, enabled: boolean): Promise<void> {
    try {
      await bridge().request('POST', `/api/mcp/tools/${encodeURIComponent(fullName)}/${enabled ? 'enable' : 'disable'}`)
      runInAction(() => { this.tools = this.tools.map((t) => (t.fullName === fullName ? { ...t, enabled } : t)) })
    } catch { await this.load() }
  }
  setSetting(k: string, v: any): void { this.settings = { ...this.settings, [k]: v } }
  /** Throws on failure — the caller owns showing saved-vs-failed. */
  async saveSettings(): Promise<void> {
    try {
      await bridge().request('PUT', '/api/mcp/settings', {
        maxToolRounds: Number(this.settings.maxToolRounds) || 20,
      })
      runInAction(() => { if (this.err.startsWith('save settings')) this.err = '' })
    } catch (e: any) {
      runInAction(() => { this.err = `save settings failed: ${e?.message || e}` })
      throw e
    }
  }
}

export const mcpServersStore = new McpServersStore()
