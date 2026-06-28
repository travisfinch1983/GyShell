import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any { return (window as any).gyshell?.cluster }

/** Cluster Inventory (guests) + Hardware (PVE hosts) + Credential Vault. */
export class ClusterInfoStore {
  inventory: any[] = []
  hosts: any[] = []
  credentials: any[] = []
  revealed: Record<string, any> = {} // credId -> full entry (with secrets) after reveal
  invSearch = ''
  invType = ''
  loaded = false
  scanning = false
  err = ''

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    try {
      const [inv, hosts, creds] = await Promise.all([
        bridge().request('GET', '/api/ai/inventory').catch(() => ({ entries: [] })),
        bridge().request('GET', '/api/ai/hosts').catch(() => ({ entries: [] })),
        bridge().request('GET', '/api/ai/credentials').catch(() => ({ entries: [] })),
      ])
      runInAction(() => {
        this.inventory = (inv as any)?.entries ?? []
        this.hosts = (hosts as any)?.entries ?? []
        this.credentials = (creds as any)?.entries ?? []
        this.loaded = true
      })
    } catch (e: any) { runInAction(() => { this.err = e?.message || 'load failed' }) }
  }

  get filteredInventory(): any[] {
    const q = this.invSearch.toLowerCase()
    return this.inventory.filter((e) => {
      if (this.invType && e.type !== this.invType) return false
      if (!q) return true
      return (e.name || '').toLowerCase().includes(q) || (e.ip || '').includes(q) || String(e.vmid || '').includes(q) || (e.node || '').toLowerCase().includes(q)
    })
  }
  get invTypes(): string[] { return [...new Set(this.inventory.map((e) => e.type))].filter(Boolean) }

  async scan(): Promise<void> {
    this.scanning = true; this.err = ''
    try { await bridge().request('POST', '/api/ai/inventory/scan', {}); await this.load() }
    catch (e: any) { runInAction(() => { this.err = 'Scan failed: ' + (e?.message || e) }) }
    finally { runInAction(() => { this.scanning = false }) }
  }
  async rescanInventory(id: string): Promise<void> {
    await bridge().request('POST', `/api/ai/inventory/${encodeURIComponent(id)}/rescan`, {}).catch(() => undefined)
    await this.load()
  }
  async deleteInventory(id: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/inventory/${encodeURIComponent(id)}`).catch(() => undefined)
    await this.load()
  }
  async deleteHost(id: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/hosts/${encodeURIComponent(id)}`).catch(() => undefined)
    await this.load()
  }
  async deleteCredential(id: string): Promise<void> {
    await bridge().request('DELETE', `/api/ai/credentials/${encodeURIComponent(id)}`).catch(() => undefined)
    runInAction(() => { delete this.revealed[id] })
    await this.load()
  }
  async getHost(id: string): Promise<any> {
    return bridge().request('GET', `/api/ai/hosts/${encodeURIComponent(id)}`).catch(() => null)
  }
  async saveHost(body: any, id?: string): Promise<void> {
    if (id) await bridge().request('PUT', `/api/ai/hosts/${encodeURIComponent(id)}`, body)
    else await bridge().request('POST', '/api/ai/hosts', body)
    await this.load()
  }
  async getCredential(id: string): Promise<any> {
    return bridge().request('GET', `/api/ai/credentials/${encodeURIComponent(id)}`).catch(() => null)
  }
  async saveCredential(body: any, id?: string): Promise<void> {
    if (id) await bridge().request('PUT', `/api/ai/credentials/${encodeURIComponent(id)}`, body)
    else await bridge().request('POST', '/api/ai/credentials', body)
    await this.load()
  }

  /** Reveal toggles: fetch the full entry (with secrets) once, or hide it. */
  async toggleReveal(id: string): Promise<void> {
    if (this.revealed[id]) { runInAction(() => { delete this.revealed[id] }); return }
    const full = await bridge().request('GET', `/api/ai/credentials/${encodeURIComponent(id)}`).catch(() => null)
    if (full) runInAction(() => { this.revealed[id] = full })
  }
}

export const clusterInfoStore = new ClusterInfoStore()
