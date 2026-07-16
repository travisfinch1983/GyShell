import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * ClusterSettingsService — NATIVE settings storage for the ProxLab-replacement domain
 * (AI-Lab is becoming the new ProxLab; data lives on CT 152, not proxied). Persists to
 * a JSON file under the gybackend data dir. Secrets (PVE token, HF/CivitAI tokens) are
 * stored here and MASKED on read — `get()` returns `*Set` booleans, never the secret;
 * `set()` leaves a secret unchanged when the incoming value is blank/undefined.
 *
 * Kept as an isolated store (not folded into AI-Lab's core BackendSettings) to avoid
 * touching the app's settings migrations; can be merged later in the rebuild.
 */
export interface PveSettings {
  host: string
  port: number
  tokenId: string
  tokenSecret: string
  node: string
  verifySsl: boolean
}
export interface ClusterUiSettings {
  ramIncrementMB: number
  swapIncrementMB: number
  cpuIncrement: number
  metricsRefreshMs: number
  pveRefreshMs: number
}
export interface ExternalService {
  name: string
  type: string // llm | embeddings | reranker | tts | stt
  url: string
  model?: string
  description?: string
}
export interface VectorDb {
  name: string
  type: string // milvus | weaviate | chromadb | qdrant | hippocampai
  host: string
  port: number
  description?: string
}
export interface ServiceNames {
  common: Record<string, string> // "port:process" -> display name
  custom: Record<string, string> // "host:port" -> display name
}
export interface GpuConfigEntry {
  friendlyName?: string
  showInFleet?: boolean
  poolMode?: 'reserved' | 'ai-pool'
}
export interface SharedFolderCategory {
  name: string
  hostPath: string
}
export interface SharedFolderGroup {
  name: string
  enabled: boolean
  basePath: string
  categories: SharedFolderCategory[]
}
export interface SharedFolders {
  containerMountParent: string
  groups: SharedFolderGroup[]
}
export interface SelfIdentityOverrides { ipOverride: string; hostnameOverride: string }
export interface SelfIdentityResolved {
  detectedIp: string; detectedHostname: string
  ipOverride: string; hostnameOverride: string
  ip: string; hostname: string; port: number; baseUrl: string
}
/** The container's own LAN IP, detected at runtime — first non-internal 10.x, else first non-internal. */
function detectLanIp(): string {
  const ifaces = os.networkInterfaces()
  let firstNonInternal = '127.0.0.1'
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        if (ni.address.startsWith('10.')) return ni.address
        if (firstNonInternal === '127.0.0.1') firstNonInternal = ni.address
      }
    }
  }
  return firstNonInternal
}

export interface ClusterSettings {
  pve: PveSettings
  tokens: { hfToken: string; civitaiToken: string }
  ui: ClusterUiSettings
  labName: string
  externalServices: ExternalService[]
  vectorDbs: VectorDb[]
  serviceNames: ServiceNames
  gpuConfig: Record<string, GpuConfigEntry> // keyed "node:pciId"
  agents: Record<string, number> // node -> vmid
  sharedFolders: SharedFolders
  selfIdentity: SelfIdentityOverrides
}

const DEFAULTS: ClusterSettings = {
  pve: { host: '10.0.0.101', port: 8006, tokenId: '', tokenSecret: '', node: '', verifySsl: false },
  tokens: { hfToken: '', civitaiToken: '' },
  ui: { ramIncrementMB: 1024, swapIncrementMB: 512, cpuIncrement: 1, metricsRefreshMs: 10000, pveRefreshMs: 10000 },
  labName: 'DeeveeyantLab',
  externalServices: [],
  vectorDbs: [],
  serviceNames: { common: {}, custom: {} },
  gpuConfig: {},
  agents: {},
  sharedFolders: {
    containerMountParent: '/mnt/shared',
    groups: [
      { name: 'media', enabled: false, basePath: '', categories: [] },
      { name: 'nas', enabled: false, basePath: '', categories: [] },
      { name: 'system', enabled: false, basePath: '', categories: [] },
      { name: 'llm', enabled: false, basePath: '', categories: [] },
      { name: 'tts', enabled: false, basePath: '', categories: [] },
      { name: 'image-gen', enabled: false, basePath: '', categories: [] },
    ],
  },
  selfIdentity: { ipOverride: '', hostnameOverride: '' },
}

const SECRET_PATHS = ['pve.tokenSecret', 'tokens.hfToken', 'tokens.civitaiToken']

export class ClusterSettingsService {
  private readonly file: string
  private cache: ClusterSettings | null = null

  constructor(dataDir?: string) {
    const dir = dataDir || process.env.GYBACKEND_DATA_DIR || path.join(process.cwd(), '.gybackend-data')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    this.file = path.join(dir, 'cluster-settings.json')
  }

  private load(): ClusterSettings {
    if (this.cache) return this.cache
    let parsed: any = {}
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      parsed = {}
    }
    this.cache = {
      pve: { ...DEFAULTS.pve, ...(parsed.pve ?? {}) },
      tokens: { ...DEFAULTS.tokens, ...(parsed.tokens ?? {}) },
      ui: { ...DEFAULTS.ui, ...(parsed.ui ?? {}) },
      labName: parsed.labName ?? DEFAULTS.labName,
      externalServices: Array.isArray(parsed.externalServices) ? parsed.externalServices : [],
      vectorDbs: Array.isArray(parsed.vectorDbs) ? parsed.vectorDbs : [],
      serviceNames: { common: parsed.serviceNames?.common ?? {}, custom: parsed.serviceNames?.custom ?? {} },
      gpuConfig: parsed.gpuConfig ?? {},
      agents: parsed.agents ?? {},
      sharedFolders: parsed.sharedFolders ?? DEFAULTS.sharedFolders,
      selfIdentity: { ...DEFAULTS.selfIdentity, ...(parsed.selfIdentity ?? {}) },
    }
    return this.cache
  }

  /** Raw settings incl. secrets — backend-internal only (PVE client uses this). */
  getRaw(): ClusterSettings {
    return this.load()
  }

  /** Actual secret values, for the UI's reveal/eyeball affordance. Goes browser-ward
   *  only over the trusted WS gateway (rule #1), on explicit request from the settings UI. */
  reveal(): { pve: { tokenSecret: string }; tokens: { hfToken: string; civitaiToken: string } } {
    const s = this.load()
    return {
      pve: { tokenSecret: s.pve.tokenSecret },
      tokens: { hfToken: s.tokens.hfToken, civitaiToken: s.tokens.civitaiToken },
    }
  }

  /** UI-safe view: secrets replaced with `<field>Set` booleans. */
  get(): unknown {
    const s = this.load()
    return {
      pve: { host: s.pve.host, port: s.pve.port, tokenId: s.pve.tokenId, tokenSecretSet: !!s.pve.tokenSecret, node: s.pve.node, verifySsl: s.pve.verifySsl },
      tokens: { hfTokenSet: !!s.tokens.hfToken, civitaiTokenSet: !!s.tokens.civitaiToken },
      ui: s.ui,
      labName: s.labName,
      externalServices: s.externalServices,
      vectorDbs: s.vectorDbs,
      serviceNames: s.serviceNames,
      gpuConfig: s.gpuConfig,
      agents: s.agents,
      sharedFolders: s.sharedFolders,
      selfIdentity: s.selfIdentity,
      selfIdentityResolved: this.getSelfIdentity(),
    }
  }

  /** The AI-Lab container's OWN identity for building addresses — detected at runtime (os), with
   *  Settings overrides winning. Everything referencing AI-Lab's address should resolve through this
   *  so an IP/VLAN migration (or a fresh open-source install on any host/IP) just works (rule #6). */
  getSelfIdentity(): SelfIdentityResolved {
    const s = this.load()
    const ov = s.selfIdentity || { ipOverride: '', hostnameOverride: '' }
    const detectedIp = detectLanIp()
    const detectedHostname = os.hostname()
    const ipOverride = (ov.ipOverride || '').trim()
    const hostnameOverride = (ov.hostnameOverride || '').trim()
    const ip = ipOverride || detectedIp
    const hostname = hostnameOverride || detectedHostname
    const port = Number(process.env.AILAB_PROXY_PORT || 17890)
    return { detectedIp, detectedHostname, ipOverride, hostnameOverride, ip, hostname, port, baseUrl: `http://${ip}:${port}` }
  }

  /** Deep-merge a partial update; blank secret values are ignored (keep existing). */
  set(patch: any): unknown {
    const cur = this.load()
    const next: ClusterSettings = {
      pve: { ...cur.pve, ...(patch?.pve ?? {}) },
      tokens: { ...cur.tokens, ...(patch?.tokens ?? {}) },
      ui: { ...cur.ui, ...(patch?.ui ?? {}) },
      labName: patch?.labName ?? cur.labName,
      // Arrays/maps replaced wholesale when present in the patch.
      externalServices: Array.isArray(patch?.externalServices) ? patch.externalServices : cur.externalServices,
      vectorDbs: Array.isArray(patch?.vectorDbs) ? patch.vectorDbs : cur.vectorDbs,
      serviceNames: patch?.serviceNames ? { common: patch.serviceNames.common ?? {}, custom: patch.serviceNames.custom ?? {} } : cur.serviceNames,
      gpuConfig: patch?.gpuConfig ?? cur.gpuConfig,
      agents: patch?.agents ?? cur.agents,
      sharedFolders: patch?.sharedFolders ?? cur.sharedFolders,
      selfIdentity: patch?.selfIdentity ? { ...cur.selfIdentity, ...patch.selfIdentity } : cur.selfIdentity,
    }
    // Don't wipe secrets when the caller sends blank/undefined.
    for (const p of SECRET_PATHS) {
      const [a, b] = p.split('.') as [keyof ClusterSettings, string]
      const incoming = patch?.[a]?.[b]
      if (incoming === undefined || incoming === '') {
        ;(next[a] as any)[b] = (cur[a] as any)[b]
      }
    }
    this.cache = next
    try {
      fs.writeFileSync(this.file, JSON.stringify(next, null, 2), { mode: 0o600 })
    } catch {
      /* ignore write errors */
    }
    return this.get()
  }
}

export const clusterSettingsService = new ClusterSettingsService()
