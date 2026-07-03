import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { HermesAgentSpec } from '@gyshell/shared'

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
      if (spec.displayName) createArgs.push('--description', spec.displayName)
      await this.hermes(createArgs)
      created = true
    }

    // Model → always via the ailab provider (the AI-Lab universal proxy).
    await this.hermes(['-p', id, 'config', 'set', 'model.provider', 'ailab'])
    await this.hermes(['-p', id, 'config', 'set', 'model.default', spec.model])

    // Persona (SOUL.md) written base64-encoded (no stdin / quoting issues).
    if (spec.persona?.soul && spec.persona.soul.trim()) {
      await this.writeRemoteFile(`${home}/SOUL.md`, spec.persona.soul)
    }

    // Named personality preset (optional).
    if (spec.persona?.personality) {
      await this.hermes(['-p', id, 'config', 'set', 'agent.personality', spec.persona.personality])
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
