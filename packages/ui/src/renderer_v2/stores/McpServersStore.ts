import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

/** MCPJungle gateway management — servers, tools, health, tool-proxy settings. */
export class McpServersStore {
  health: any = null
  servers: any[] = []
  tools: any[] = []
  settings: any = { maxToolRounds: 20, toolInjection: true }
  loading = false
  loaded = false
  err = ''

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    this.loading = true; this.err = ''
    try {
      const [h, s, t, cfg] = await Promise.all([
        bridge().request('GET', '/api/mcp/health').catch(() => ({ status: 'unreachable' })),
        bridge().request('GET', '/api/mcp/servers').catch(() => []),
        bridge().request('GET', '/api/mcp/tools').catch(() => []),
        bridge().request('GET', '/api/mcp/settings').catch(() => ({ maxToolRounds: 20, toolInjection: true })),
      ])
      runInAction(() => {
        this.health = h
        this.servers = Array.isArray(s) ? s : []
        this.tools = Array.isArray(t) ? t : []
        this.settings = cfg || this.settings
        this.loaded = true
      })
    } catch (e: any) {
      runInAction(() => { this.err = e?.message || 'Failed to load MCP data' })
    } finally {
      runInAction(() => { this.loading = false })
    }
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
    await bridge().request('DELETE', `/api/mcp/servers/${encodeURIComponent(name)}`).catch(() => undefined)
    await this.load()
  }
  async toggleTool(fullName: string, enabled: boolean): Promise<void> {
    try {
      await bridge().request('POST', `/api/mcp/tools/${encodeURIComponent(fullName)}/${enabled ? 'enable' : 'disable'}`)
      runInAction(() => { this.tools = this.tools.map((t) => (t.fullName === fullName ? { ...t, enabled } : t)) })
    } catch { await this.load() }
  }
  setSetting(k: string, v: any): void { this.settings = { ...this.settings, [k]: v } }
  async saveSettings(): Promise<void> {
    await bridge().request('PUT', '/api/mcp/settings', {
      toolInjection: this.settings.toolInjection !== false,
      maxToolRounds: Number(this.settings.maxToolRounds) || 20,
    })
  }
}

export const mcpServersStore = new McpServersStore()
