import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

export const CLAUDE_FILES = ['CLAUDE.md', 'RULES.md', 'MEMORY.md', 'TOOLS.md']

export class ClaudeStore {
  connections: any[] = []
  directives: any = null
  lxc: { vmid: any; name: string; ip: string; node: string }[] = []
  loaded = false
  err = ''

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const [conns, lxc] = await Promise.all([
        bridge().request('GET', '/api/claude/connections').catch(() => ({ connections: [] })),
        bridge().request('GET', '/api/claude/lxc').catch(() => ({ entries: [] })),
      ])
      runInAction(() => {
        this.connections = (conns as any)?.connections ?? []
        this.directives = (conns as any)?.directives ?? null
        this.lxc = (lxc as any)?.entries ?? []
        this.loaded = true
      })
    } catch (e: any) { runInAction(() => { this.err = e?.message || 'load failed' }) }
  }

  async addConnection(body: any): Promise<any> {
    const r = await bridge().request('POST', '/api/claude/connections', body)
    await this.load()
    return r
  }
  async deleteConnection(id: string): Promise<void> {
    await bridge().request('DELETE', `/api/claude/connections/${encodeURIComponent(id)}`).catch(() => undefined)
    await this.load()
  }
  async detectWorkspace(node: string, vmid: any): Promise<any> {
    return bridge().request('GET', `/api/claude/detect-workspace?node=${encodeURIComponent(node || '')}&vmid=${encodeURIComponent(String(vmid))}`)
      .catch((e: any) => ({ error: e?.message || String(e), candidates: [], cwds: [] }))
  }
  async setup(id: string): Promise<any> {
    return bridge().request('POST', `/api/claude/connections/${encodeURIComponent(id)}/setup`).catch((e: any) => ({ error: e?.message || String(e) }))
  }
  termUrl(id: string): string { return `/api/claude/term/${encodeURIComponent(id)}/` }
  async restart(id: string): Promise<any> {
    return bridge().request('POST', `/api/claude/connections/${encodeURIComponent(id)}/restart`).catch((e: any) => ({ error: e?.message || String(e) }))
  }

  async getFile(id: string, name: string): Promise<any> {
    return bridge().request('GET', `/api/claude/connections/${encodeURIComponent(id)}/file?name=${encodeURIComponent(name)}`).catch((e: any) => ({ content: '', error: e?.message || String(e) }))
  }
  async saveFile(id: string, name: string, content: string): Promise<any> {
    return bridge().request('PUT', `/api/claude/connections/${encodeURIComponent(id)}/file?name=${encodeURIComponent(name)}`, { content })
  }
  async getDirectives(): Promise<any> {
    return bridge().request('GET', '/api/claude/directives').catch((e: any) => ({ content: '', error: e?.message || String(e) }))
  }
  async saveDirectives(content: string): Promise<any> {
    return bridge().request('PUT', '/api/claude/directives', { content })
  }
}

export const claudeStore = new ClaudeStore()
