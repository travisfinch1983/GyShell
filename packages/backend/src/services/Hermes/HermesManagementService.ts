import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { HermesAgentSpec, ProviderService } from '@gyshell/shared'
import { PROVIDER_SERVICE_CAPS } from '@gyshell/shared'

const execFileAsync = promisify(execFile)

/**
 * HermesManagementService (AI-Lab × Hermes, control plane) — applies a HermesAgentSpec
 * to the Hermes install on CT158 by driving the `hermes` CLIs over SSH. Each agent is a
 * Hermes PROFILE (`hermes -p <agentId>`); its model always points at the `ailab` provider
 * (the AI-Lab universal proxy) so every agent routes through one endpoint with metrics.
 *
 * Recipe (validated manually — "scout" agent, see /claude/plans/ailab-hermes-integration.md):
 *   1. hermes profile create <id> --clone [--description <desc>]   (idempotent; clones the
 *      active profile so the ailab provider + auth are inherited). Home = <base>/<id>/.
 *   2. hermes -p <id> config set model.provider ailab
 *      hermes -p <id> config set model.default <spec.model>   (proxy-catalog id, tag included
 *      for external sources; the proxy routes by that name).
 *   3. write SOUL.md (persona) into <base>/<id>/SOUL.md.
 */

export interface HermesManagementConfig {
  host: string // e.g. 10.0.0.236 (CT158)
  sshKeyPath: string // AI-Lab's key authorized on CT158 (AILAB_SSH_KEY / dataDir/ssh/id_ed25519)
  user?: string // default root
  hermesBin?: string // default /usr/local/bin/hermes
  profileHomeBase?: string // default /root/.hermes/profiles
  connectTimeoutSec?: number // default 8
  /** JSON file (on the AI-Lab backend) where applied HermesAgentSpecs are persisted for
   *  read-back / edit (reconstructing a spec from Hermes profile YAML is lossy). */
  specsFile?: string
  /** JSON file where Provider Services entries (ElevenLabs etc. — keyed non-model providers)
   *  are persisted. Keys are stored here; the effective secret is pushed to Hermes .env. */
  providerServicesFile?: string
}

/** Single-quote a string for safe embedding in a remote shell command. */
function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

export class HermesManagementService {
  private readonly user: string
  private readonly hermesBin: string
  private readonly profileHomeBase: string

  constructor(private readonly cfg: HermesManagementConfig) {
    this.user = cfg.user ?? 'root'
    this.hermesBin = cfg.hermesBin ?? '/usr/local/bin/hermes'
    this.profileHomeBase = cfg.profileHomeBase ?? '/root/.hermes/profiles'
  }

  // ── Persisted spec store (read-back / edit) ──────────────────────────────
  private loadSpecs(): Record<string, HermesAgentSpec> {
    if (!this.cfg.specsFile || !existsSync(this.cfg.specsFile)) return {}
    try {
      return JSON.parse(readFileSync(this.cfg.specsFile, 'utf8')) as Record<string, HermesAgentSpec>
    } catch {
      return {}
    }
  }

  private saveSpecs(specs: Record<string, HermesAgentSpec>): void {
    if (!this.cfg.specsFile) return
    mkdirSync(dirname(this.cfg.specsFile), { recursive: true })
    writeFileSync(this.cfg.specsFile, JSON.stringify(specs, null, 2))
  }

  /** The persisted HermesAgentSpec for an agent, or undefined (never applied via AI-Lab). */
  getSpec(agentId: string): HermesAgentSpec | undefined {
    return this.loadSpecs()[agentId]
  }

  // ── Provider Services registry (keyed non-model providers → Hermes .env) ──────
  private loadProviderServices(): ProviderService[] {
    if (!this.cfg.providerServicesFile) return []
    try {
      const arr = JSON.parse(readFileSync(this.cfg.providerServicesFile, 'utf8'))
      return Array.isArray(arr) ? (arr as ProviderService[]) : []
    } catch {
      return []
    }
  }

  private saveProviderServicesFile(list: ProviderService[]): void {
    if (!this.cfg.providerServicesFile) return
    mkdirSync(dirname(this.cfg.providerServicesFile), { recursive: true })
    writeFileSync(this.cfg.providerServicesFile, JSON.stringify(list, null, 2))
  }

  /** All stored Provider Services entries, RAW (keys included). Caller masks for the wire. */
  getProviderServices(): ProviderService[] {
    return this.loadProviderServices()
  }

  /**
   * Upsert a Provider Services entry (by id) and reconcile its secret in Hermes .env per
   * PROVIDER_SERVICE_CAPS: push the key when enabled + present, else clear it (disable removes
   * the secret; re-enable re-pushes from the stored key). Providers not in the caps map are
   * stored but have no .env side-effect.
   */
  async upsertProviderService(entry: ProviderService): Promise<void> {
    const list = this.loadProviderServices()
    const idx = list.findIndex((e) => e.id === entry.id)
    if (idx >= 0) list[idx] = entry
    else list.push(entry)
    this.saveProviderServicesFile(list)
    const caps = PROVIDER_SERVICE_CAPS[entry.provider]
    if (caps) {
      const value = entry.enabled !== false && entry.apiKey ? entry.apiKey : ''
      await this.setProviderSecret(caps.envVar, value)
    }
  }

  /** Delete a Provider Services entry and clear its secret from Hermes .env. */
  async deleteProviderService(id: string): Promise<void> {
    const list = this.loadProviderServices()
    const entry = list.find((e) => e.id === id)
    this.saveProviderServicesFile(list.filter((e) => e.id !== id))
    const caps = entry && PROVIDER_SERVICE_CAPS[entry.provider]
    if (caps) await this.setProviderSecret(caps.envVar, '')
  }

  /** Run a single remote command string over SSH (async execFile has no stdin — see writeRemoteFile). */
  private async ssh(remoteCmd: string): Promise<string> {
    const args = [
      '-i', this.cfg.sshKeyPath,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${this.cfg.connectTimeoutSec ?? 8}`,
      `${this.user}@${this.cfg.host}`,
      remoteCmd,
    ]
    const { stdout } = await execFileAsync('ssh', args, {
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  }

  /** hermes <args...> as a properly-quoted remote command. */
  private hermes(parts: string[]): Promise<string> {
    return this.ssh([this.hermesBin, ...parts.map(shq)].join(' '))
  }

  /** Write a text file on the remote host. Base64-encoded into the command so no stdin
   *  piping is needed (async execFile can't supply stdin) and content can't break quoting. */
  private writeRemoteFile(path: string, content: string): Promise<string> {
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    return this.ssh(`printf %s ${shq(b64)} | base64 -d > ${shq(path)}`)
  }

  private profileHome(agentId: string): string {
    return `${this.profileHomeBase}/${agentId}`
  }

  /**
   * Upsert (or clear) a secret in Hermes's GLOBAL .env — the account-wide secret store every
   * profile inherits (e.g. `ELEVENLABS_API_KEY` for the ElevenLabs TTS provider). This is the
   * backend of the "Provider Services" section: a provider key is configured ONCE here, not per
   * agent. Idempotent — replaces an existing `KEY=` line, appends if absent; an empty value
   * removes the line. Env-path resolved via `hermes config env-path` (authoritative, global — no
   * `-p`). A native secret-store write, exactly what `hermes` writes there itself — not a source
   * patch. File is re-chmod'd 600. Value is base64'd through the command so no quoting can break.
   */
  async setProviderSecret(envVar: string, value: string): Promise<void> {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(envVar)) throw new Error(`invalid env var name: ${envVar}`)
    const envPath = (await this.hermes(['config', 'env-path'])).trim()
    if (!envPath) throw new Error('could not resolve Hermes global .env path')
    const valB64 = Buffer.from(value ?? '', 'utf8').toString('base64')
    const script = [
      'import sys, base64, os',
      'path, key = sys.argv[1], sys.argv[2]',
      'val = base64.b64decode(sys.argv[3]).decode()',
      'lines = open(path).read().splitlines() if os.path.exists(path) else []',
      "out = [l for l in lines if l.split('=', 1)[0].strip() != key]",
      "if val != '':",
      "    out.append(key + '=' + val)",
      "data = ('\\n'.join(out) + '\\n') if out else ''",
      "with open(path, 'w') as f:",
      '    f.write(data)',
      'os.chmod(path, 0o600)',
    ].join('\n')
    const scriptB64 = Buffer.from(script, 'utf8').toString('base64')
    await this.ssh(`printf %s ${shq(scriptB64)} | base64 -d | python3 - ${shq(envPath)} ${shq(envVar)} ${shq(valB64)}`)
  }

  /**
   * Write the ordered fallback chain into the profile's config.yaml as Hermes's native
   * `fallback_providers` list (tried in order when the primary model fails with rate-limit/
   * overload/connection errors). Every AI-Lab agent routes through the `ailab` proxy provider,
   * so each entry is {provider:'ailab', model:<catalog-id>} — mirroring how `model` is set.
   * An empty list clears the chain (idempotent re-apply).
   *
   * Why a direct config.yaml write and not a CLI: `hermes config set` stores a list-of-dicts as
   * a literal STRING (verified — `fallback list` then ignores it), and `hermes fallback add` is
   * an interactive picker with no flags. So we merge the single `fallback_providers` key via the
   * remote system python (PyYAML present on CT158), preserving every other config key. This is a
   * native user-config write — exactly what the CLI does internally — not a Hermes-source patch.
   */
  private async applyFallback(agentId: string, fallback: string[]): Promise<void> {
    const chain = fallback.filter((m) => m && m.trim()).map((model) => ({ provider: 'ailab', model }))
    const cfgPath = `${this.profileHome(agentId)}/config.yaml`
    const chainB64 = Buffer.from(JSON.stringify(chain), 'utf8').toString('base64')
    const script = [
      'import sys, yaml, json, base64',
      'path = sys.argv[1]',
      'chain = json.loads(base64.b64decode(sys.argv[2]))',
      'try:',
      '    with open(path) as f:',
      '        cfg = yaml.safe_load(f) or {}',
      'except FileNotFoundError:',
      '    cfg = {}',
      'if not isinstance(cfg, dict):',
      '    cfg = {}',
      'if chain:',
      "    cfg['fallback_providers'] = chain",
      'else:',
      "    cfg.pop('fallback_providers', None)",
      "cfg.pop('fallback_model', None)",
      "with open(path, 'w') as f:",
      '    yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=False, allow_unicode=True)',
    ].join('\n')
    const scriptB64 = Buffer.from(script, 'utf8').toString('base64')
    await this.ssh(`printf %s ${shq(scriptB64)} | base64 -d | python3 - ${shq(cfgPath)} ${shq(chainB64)}`)
  }

  /** List existing agent profiles (directory names under the profile home base). */
  async listAgents(): Promise<string[]> {
    try {
      const out = await this.ssh(`ls -1 ${shq(this.profileHomeBase)} 2>/dev/null || true`)
      return out.split('\n').map((s) => s.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  async agentExists(agentId: string): Promise<boolean> {
    return (await this.listAgents()).includes(agentId)
  }

  /**
   * Create (if needed) + configure a Hermes profile from a spec. Idempotent: safe to
   * re-apply to update model/persona on an existing agent.
   */
  async applySpec(spec: HermesAgentSpec): Promise<{ created: boolean; home: string }> {
    const id = spec.agentId // slug-validated by the zod schema
    const home = this.profileHome(id)

    const exists = await this.agentExists(id)
    let created = false
    if (!exists) {
      const createArgs = ['profile', 'create', id, '--clone']
      const desc = spec.description ?? spec.displayName
      if (desc) createArgs.push('--description', desc)
      await this.hermes(createArgs)
      created = true
    }

    // Model → always via the ailab provider (the AI-Lab universal proxy).
    await this.hermes(['-p', id, 'config', 'set', 'model.provider', 'ailab'])
    await this.hermes(['-p', id, 'config', 'set', 'model.default', spec.model])

    // Fallback chain → Hermes-native `fallback_providers` (failover on rate-limit/overload/
    // connection errors). Written into config.yaml directly (see applyFallback for why).
    await this.applyFallback(id, spec.fallback)

    // Persona (SOUL.md) written base64-encoded (no stdin / quoting issues).
    if (spec.persona?.soul && spec.persona.soul.trim()) {
      await this.writeRemoteFile(`${home}/SOUL.md`, spec.persona.soul)
    }

    // Named personality preset (optional).
    if (spec.persona?.personality) {
      await this.hermes(['-p', id, 'config', 'set', 'agent.personality', spec.persona.personality])
    }

    // Per-agent TTS voice. `config set` handles these scalar dot-keys directly (unlike the
    // fallback list). The provider's API key is set once globally under Provider Services
    // (Hermes .env), not here. Enable the `tts` toolset so the agent actually speaks.
    if (spec.tts?.provider) {
      const p = spec.tts.provider
      await this.hermes(['-p', id, 'config', 'set', 'tts.provider', p])
      if (spec.tts.voiceId) await this.hermes(['-p', id, 'config', 'set', `tts.${p}.voice_id`, spec.tts.voiceId])
      if (spec.tts.modelId) await this.hermes(['-p', id, 'config', 'set', `tts.${p}.model_id`, spec.tts.modelId])
      await this.hermes(['-p', id, 'tools', 'enable', 'tts'])
    }

    // Persist the applied spec (source of truth for read-back / edit; Hermes YAML is lossy).
    if (this.cfg.specsFile) {
      const specs = this.loadSpecs()
      specs[id] = spec
      this.saveSpecs(specs)
    }

    return { created, home }
  }

  /** Delete an agent profile (and its per-profile state). */
  async deleteAgent(agentId: string): Promise<void> {
    await this.hermes(['profile', 'delete', agentId, '--yes'])
    if (this.cfg.specsFile) {
      const specs = this.loadSpecs()
      if (agentId in specs) {
        delete specs[agentId]
        this.saveSpecs(specs)
      }
    }
  }

  /** Raw `hermes -p <id> config show` for inspection. */
  async describeAgent(agentId: string): Promise<string> {
    return this.hermes(['-p', agentId, 'config', 'show'])
  }
}
