import { makeAutoObservable, runInAction } from 'mobx'

/**
 * ScriptCatalogStore — Helper Scripts (community + ProxLab installer catalog).
 *
 * Catalog data is read via the `cluster:request` bridge to ProxLab's /api/script-catalog
 * (which git-syncs the community-scripts repo). v1 = browse / search / categories / detail /
 * copy install command. The in-app streamed INSTALL run (ProxLab's WS terminal) + the big
 * options/defaults form are deferred to the native terminal port (finalization).
 */
export interface CatalogScript {
  name: string
  slug: string
  description?: string
  logo?: string
  source?: 'community' | 'proxlab' | string
  sourceUrl?: string
  tags?: string[]
  categories?: string[]
  resources?: { cpu?: number; ram?: number; disk?: number; os?: string; version?: string }
  privileged?: boolean
  installUrl?: string
  website?: string
  documentation?: string
  interfacePort?: number
  notes?: Array<{ type?: string; text: string }>
}
export interface Catalog {
  scripts: CatalogScript[]
  categories: Array<{ name: string; count: number }>
  totalScripts?: number
  lastSync?: string
}
export interface SchemaField {
  key: string
  label: string
  type: string
  group: string
  default?: string
  min?: number
  max?: number
  step?: number
  trueVal?: string
  falseVal?: string
  options?: Array<string | { value: string; label: string }>
  contentFilter?: string
}
export interface ClusterData {
  nodes?: Array<{ name: string; ip: string }>
  storagesByNode?: Record<string, Array<{ storage: string; type: string; content?: string; shared?: boolean }>>
  sshKeys?: Array<{ type: string; fingerprint: string; comment: string; full: string }>
  timezones?: string[]
}
export interface ScriptDefaults {
  global: Record<string, string>
  app: Record<string, string>
  hasGlobal: boolean
  hasApp: boolean
}
export interface PveNode {
  node: string
  ip: string
}

export interface NodeTemplate {
  volid: string
  storage: string
  name: string
}

/** The `mode=generated var_x='..' ` env prefix shared by both run paths. */
export function buildVarPrefix(vals: Record<string, string>, forNode?: string): string {
  const parts: string[] = []
  for (const [key, val] of Object.entries(vals)) {
    if (!val) continue
    if (key.includes('__')) {
      const [base, node] = key.split('__')
      if (forNode && node === forNode) parts.push(`${base}='${val.replace(/'/g, "'\\''")}'`)
      continue
    }
    if (key === 'var_ssh_authorized_key') {
      const first = val.split('\n').find((k) => k.trim().startsWith('ssh-'))
      if (first) parts.push(`${key}='${first.replace(/'/g, "'\\''")}'`)
      continue
    }
    if (key.startsWith('var_')) parts.push(`${key}='${val.replace(/'/g, "'\\''")}'`)
  }
  return parts.length ? `mode=generated ${parts.join(' ')} ` : ''
}

/** Standard install command (auto-selected OS template). */
export function buildInstallCommand(installUrl: string, vals: Record<string, string>, forNode?: string): string {
  return `${buildVarPrefix(vals, forNode)}bash -c "$(curl -fsSL ${installUrl})"`
}

const sq = (s: string) => s.replace(/'/g, '')

/**
 * Custom-OS-template install: returns a command + a setup wrapper to SFTP onto the node.
 * The wrapper fetches upstream build.func, patches its template-selection to honor
 * CUSTOM_TEMPLATE, rewrites the script's build.func source line to the patched copy, and runs it.
 */
export function buildTemplateInstall(
  installUrl: string,
  vals: Record<string, string>,
  forNode: string | undefined,
  templateName: string,
): { command: string; setup: { path: string; content: string } } {
  const prefix = buildVarPrefix(vals, forNode)
  const path = `/tmp/ailab-install-${Date.now()}.sh`
  const content = [
    '#!/usr/bin/env bash',
    'set -e',
    `export CUSTOM_TEMPLATE='${sq(templateName)}'`,
    'BF="$(mktemp)"',
    "curl -fsSL 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func' \\",
    "  | sed -E 's/\\bTEMPLATE=\"(\\$\\{LOCAL_TEMPLATES\\[-1\\]\\}|\\$ONLINE_TEMPLATE|\\$\\{ONLINE_TEMPLATES\\[-1\\]\\}|\\$fallback_template)\"/TEMPLATE=\"${CUSTOM_TEMPLATE:-\\1}\"/g' > \"$BF\"",
    `CT="$(curl -fsSL '${sq(installUrl)}')"`,
    'CT="$(printf \'%s\' "$CT" | sed -E "s#source <\\(curl -fsSL [^)]*/misc/build\\.func\\)#source $BF#")"',
    'eval "$CT"',
    '',
  ].join('\n')
  return { command: `${prefix}bash ${path}`, setup: { path, content } }
}

export class ScriptCatalogStore {
  // form deps (cached after first load)
  schema: SchemaField[] = []
  clusterData: ClusterData = {}
  nodes: PveNode[] = []
  formDepsLoaded = false
  nodeTemplates: Record<string, NodeTemplate[]> = {} // keyed by node IP
  catalog: Catalog | null = null
  loading = false
  error: string | null = null
  syncing = false
  syncStep = ''
  syncProgress = 0
  activeCategory = 'all' // 'all' | 'proxlab' | 'community' | <category name>
  search = ''
  loaded = false

  constructor() {
    makeAutoObservable(this)
  }

  private cluster() {
    const api = (window as any).gyshell?.cluster
    if (!api?.request) throw new Error('cluster gateway RPC not available')
    return api
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loading = true
    try {
      const cat = (await this.cluster().request('GET', '/api/script-catalog')) as Catalog
      runInAction(() => {
        this.catalog = cat
        this.error = null
        this.loaded = true
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

  /** Force a re-sync from GitHub, polling status until done, then reload the catalog. */
  async sync(): Promise<void> {
    this.syncing = true
    this.syncProgress = 0
    this.syncStep = 'Starting…'
    try {
      const api = this.cluster()
      await api.request('POST', '/api/script-catalog/sync')
      const deadline = Date.now() + 120000
      // eslint-disable-next-line no-constant-condition
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1200))
        const st = (await api.request('GET', '/api/script-catalog/sync/status')) as any
        runInAction(() => {
          this.syncStep = st?.step ?? ''
          this.syncProgress = st?.progress ?? 0
        })
        if (!st?.running) break
      }
      const cat = (await api.request('GET', '/api/script-catalog')) as Catalog
      runInAction(() => {
        this.catalog = cat
        this.loaded = true
        this.error = null
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : String(e)
      })
    } finally {
      runInAction(() => {
        this.syncing = false
      })
    }
  }

  setCategory(c: string): void {
    this.activeCategory = c
  }
  setSearch(s: string): void {
    this.search = s
  }

  /** Load the var_* schema, cluster data (storages/ssh-keys/timezones), and online nodes — cached. */
  async loadFormDeps(): Promise<void> {
    if (this.formDepsLoaded) return
    const api = this.cluster()
    const [schema, cd, status] = await Promise.all([
      api.request('GET', '/api/script-catalog/defaults/schema').catch(() => []),
      api.request('GET', '/api/script-catalog/cluster-data').catch(() => ({})),
      api.request('GET', '/api/pve/status').catch(() => ({})),
    ])
    const nodes: PveNode[] = ((status as any)?.nodes ?? [])
      .filter((n: any) => n.status === 'online' && n.ip)
      .map((n: any) => ({ node: n.node, ip: n.ip }))
    runInAction(() => {
      this.schema = Array.isArray(schema) ? (schema as SchemaField[]) : []
      this.clusterData = (cd as ClusterData) ?? {}
      this.nodes = nodes
      this.formDepsLoaded = true
    })
  }

  async getDefaults(slug: string): Promise<ScriptDefaults> {
    const d = (await this.cluster().request('GET', `/api/script-catalog/defaults/${encodeURIComponent(slug)}`)) as any
    return { global: d?.global ?? {}, app: d?.app ?? {}, hasGlobal: !!d?.hasGlobal, hasApp: !!d?.hasApp }
  }
  async getGlobalDefaults(): Promise<Record<string, string>> {
    return ((await this.cluster().request('GET', '/api/script-catalog/defaults')) as any) ?? {}
  }
  async saveGlobalDefaults(vals: Record<string, string>): Promise<void> {
    await this.cluster().request('PUT', '/api/script-catalog/defaults', vals)
  }
  async saveAppDefaults(slug: string, vals: Record<string, string>): Promise<void> {
    await this.cluster().request('PUT', `/api/script-catalog/defaults/${encodeURIComponent(slug)}`, vals)
  }

  /** LXC templates available on a node (native `pveam` over AI-Lab's SSH key), cached per node. */
  async listNodeTemplates(host: string): Promise<NodeTemplate[]> {
    if (this.nodeTemplates[host]) return this.nodeTemplates[host]
    const api = (window as any).gyshell?.catalogInstall
    if (!api?.listTemplates) return []
    const r = await api.listTemplates(host)
    const list: NodeTemplate[] = Array.isArray(r) ? r : (r?.templates ?? [])
    runInAction(() => {
      this.nodeTemplates[host] = list
    })
    return list
  }

  get filteredScripts(): CatalogScript[] {
    const all = this.catalog?.scripts ?? []
    const cat = this.activeCategory
    let list = all
    if (cat === 'proxlab') list = all.filter((s) => s.source === 'proxlab')
    else if (cat === 'community') list = all.filter((s) => s.source === 'community')
    else if (cat !== 'all') list = all.filter((s) => (s.categories ?? []).includes(cat))
    const f = this.search.trim().toLowerCase()
    if (f) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(f) ||
          (s.slug || '').toLowerCase().includes(f) ||
          (s.description || '').toLowerCase().includes(f) ||
          (s.tags ?? []).some((t) => t.toLowerCase().includes(f)),
      )
    }
    return list
  }

  get counts(): { all: number; proxlab: number; community: number } {
    const all = this.catalog?.scripts ?? []
    return {
      all: all.length,
      proxlab: all.filter((s) => s.source === 'proxlab').length,
      community: all.filter((s) => s.source === 'community').length,
    }
  }
}

export const scriptCatalogStore = new ScriptCatalogStore()
