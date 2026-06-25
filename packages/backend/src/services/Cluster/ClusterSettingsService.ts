import fs from 'node:fs'
import path from 'node:path'

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
export interface ClusterSettings {
  pve: PveSettings
  tokens: { hfToken: string; civitaiToken: string }
  ui: ClusterUiSettings
  labName: string
}

const DEFAULTS: ClusterSettings = {
  pve: { host: '10.0.0.101', port: 8006, tokenId: '', tokenSecret: '', node: '', verifySsl: false },
  tokens: { hfToken: '', civitaiToken: '' },
  ui: { ramIncrementMB: 1024, swapIncrementMB: 512, cpuIncrement: 1, metricsRefreshMs: 10000, pveRefreshMs: 10000 },
  labName: 'DeeveeyantLab',
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
    }
    return this.cache
  }

  /** Raw settings incl. secrets — backend-internal only (PVE client uses this). */
  getRaw(): ClusterSettings {
    return this.load()
  }

  /** UI-safe view: secrets replaced with `<field>Set` booleans. */
  get(): unknown {
    const s = this.load()
    return {
      pve: { host: s.pve.host, port: s.pve.port, tokenId: s.pve.tokenId, tokenSecretSet: !!s.pve.tokenSecret, node: s.pve.node, verifySsl: s.pve.verifySsl },
      tokens: { hfTokenSet: !!s.tokens.hfToken, civitaiTokenSet: !!s.tokens.civitaiToken },
      ui: s.ui,
      labName: s.labName,
    }
  }

  /** Deep-merge a partial update; blank secret values are ignored (keep existing). */
  set(patch: any): unknown {
    const cur = this.load()
    const next: ClusterSettings = {
      pve: { ...cur.pve, ...(patch?.pve ?? {}) },
      tokens: { ...cur.tokens, ...(patch?.tokens ?? {}) },
      ui: { ...cur.ui, ...(patch?.ui ?? {}) },
      labName: patch?.labName ?? cur.labName,
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
