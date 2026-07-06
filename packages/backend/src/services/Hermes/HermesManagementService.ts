import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
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

/** Write JSON atomically: tmp file + rename, so a crash mid-write can't truncate the store and
 *  concurrent readers never see a partial file (M5). Same-filesystem rename is atomic. */
function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
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
    atomicWriteJson(this.cfg.specsFile, specs)
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
    atomicWriteJson(this.cfg.providerServicesFile, list)
  }

  /** The effective secret for an envVar across the whole registry: the key of the first ENABLED
   *  entry (with a key) whose provider maps to that envVar, or '' to clear. Because the .env var
   *  is provider-keyed but entries are id-keyed, deleting/disabling one entry must NOT wipe an
   *  envVar another enabled entry still supplies (M2). */
  private effectiveSecretFor(list: ProviderService[], envVar: string): string {
    const hit = list.find(
      (e) => e.enabled !== false && e.apiKey && PROVIDER_SERVICE_CAPS[e.provider]?.envVar === envVar,
    )
    return hit?.apiKey ?? ''
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
    const prev = list.find((e) => e.id === entry.id)
    const idx = list.findIndex((e) => e.id === entry.id)
    const next = idx >= 0 ? list.map((e, i) => (i === idx ? entry : e)) : [...list, entry]
    // Reconcile every envVar this change could touch — the new entry's, plus the previous entry's
    // if the provider changed (which would otherwise orphan the old var). Effective value accounts
    // for OTHER entries sharing the same var (M2).
    const envVars = new Set<string>()
    const capNew = PROVIDER_SERVICE_CAPS[entry.provider]
    if (capNew) envVars.add(capNew.envVar)
    if (prev) {
      const capOld = PROVIDER_SERVICE_CAPS[prev.provider]
      if (capOld) envVars.add(capOld.envVar)
    }
    // Push to Hermes .env FIRST; only persist the JSON if that succeeds, so a failed push can't
    // leave the registry claiming hasKey:true while .env lacks the secret (M4).
    for (const ev of envVars) await this.setProviderSecret(ev, this.effectiveSecretFor(next, ev))
    this.saveProviderServicesFile(next)
  }

  /** Delete a Provider Services entry. Its envVar is cleared ONLY if no other enabled entry still
   *  supplies it (M2); otherwise the surviving entry's key is re-pushed. .env before JSON (M4). */
  async deleteProviderService(id: string): Promise<void> {
    const list = this.loadProviderServices()
    const entry = list.find((e) => e.id === id)
    const next = list.filter((e) => e.id !== id)
    const caps = entry && PROVIDER_SERVICE_CAPS[entry.provider]
    if (caps) await this.setProviderSecret(caps.envVar, this.effectiveSecretFor(next, caps.envVar))
    this.saveProviderServicesFile(next)
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
    try {
      const { stdout } = await execFileAsync('ssh', args, {
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      return stdout
    } catch (e) {
      // SECURITY: execFile's error message embeds the full argv, which for a secret-carrying
      // remote command (e.g. setProviderSecret's base64'd API key) would leak the decodable
      // secret to any caller that surfaces the error (hermesHttp returns e.message in the body).
      // Surface ONLY the remote stderr + exit code, never the command line.
      const err = e as { stderr?: string; stdout?: string; code?: unknown; signal?: unknown }
      const stderr = String(err?.stderr ?? '').trim()
      const code = err?.code ?? err?.signal ?? '?'
      throw new Error(`ssh command failed (exit ${code})${stderr ? `: ${stderr.slice(0, 400)}` : ''}`)
    }
  }

  /** hermes <args...> as a properly-quoted remote command. */
  private hermes(parts: string[]): Promise<string> {
    return this.ssh([this.hermesBin, ...parts.map(shq)].join(' '))
  }

  /** Like hermes(), but feeds stdin (base64-safe) to answer non-interactive prompts.
   *  `hermes mcp add` prompts auth? [Y/n] then enable-all? [Y/n/select] — pipe n then Y. */
  private hermesInput(stdin: string, parts: string[]): Promise<string> {
    const b64 = Buffer.from(stdin, 'utf8').toString('base64')
    return this.ssh(`printf %s ${shq(b64)} | base64 -d | ${[this.hermesBin, ...parts.map(shq)].join(' ')}`)
  }

  /** Repoint the agent's gateway MCP server to `url` in ONE ssh call: remove any server under
   *  our known names (explicit Y to the [Y/n] confirm), then add pointing at `url` (n = no auth,
   *  Y = enable all tools). Single connection + explicit stdin per command avoids the
   *  execFileAsync-stdin hangs the separate calls hit, and the pre-remove avoids the
   *  "Overwrite? [y/N]" prompt on an existing server. */
  private async repointGatewayServer(agentId: string, url: string): Promise<void> {
    const bin = this.hermesBin
    const p = shq(agentId)
    const removes = HermesManagementService.GATEWAY_SERVER_ALIASES
      .map((a) => `printf 'Y\\n' | ${bin} -p ${p} mcp remove ${shq(a)} >/dev/null 2>&1 || true`)
      .join('; ')
    const add = `printf 'n\\nY\\n' | ${bin} -p ${p} mcp add ${shq(HermesManagementService.GATEWAY_SERVER)} --url ${shq(url)}`
    await this.ssh(`${removes}; ${add}`)
  }

  /** Read the live SOUL.md persona file for an agent off the Hermes host. '' if none exists. */
  async readSoul(agentId: string): Promise<string> {
    const path = `${this.profileHome(agentId)}/SOUL.md`
    const b64 = (await this.ssh(`base64 -w0 ${shq(path)} 2>/dev/null || true`)).trim()
    if (!b64) return ''
    try { return Buffer.from(b64, 'base64').toString('utf8') } catch { return '' }
  }

  /** Write the SOUL.md persona file for an agent on the Hermes host. */
  async writeSoul(agentId: string, content: string): Promise<void> {
    await this.writeRemoteFile(`${this.profileHome(agentId)}/SOUL.md`, content)
  }

  /** Write a text file on the remote host. Base64-encoded into the command so no stdin
   *  piping is needed (async execFile can't supply stdin) and content can't break quoting. */
  private writeRemoteFile(path: string, content: string): Promise<string> {
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    return this.ssh(`printf %s ${shq(b64)} | base64 -d > ${shq(path)}`)
  }

  /** Write an on-demand screenshot (base64 from the browser; data URL or bare) into the agent's
   *  workspace on CT158, where its `vision_analyze` tool can read the local file — an internal
   *  URL would be SSRF-blocked, a local path is not. Returns the absolute path the agent reads. */
  async writeAgentScreenshot(agentId: string, image: string): Promise<string> {
    const b64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image
    const ext = /^data:image\/png/i.test(image) ? 'png' : 'jpg'
    const path = `${this.profileHome(agentId)}/workspace/.screen.${ext}`
    await this.ssh(`printf %s ${shq(b64)} | base64 -d > ${shq(path)}`)
    return path
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
  /** Parse a profile's live config.yaml into JSON via the remote system python (PyYAML present
   *  on the Hermes host — same tool applyFallback uses). {} if the file is missing/unparseable. */
  private async readConfigJson(agentId: string): Promise<Record<string, any>> {
    const cfgPath = `${this.profileHome(agentId)}/config.yaml`
    const script = [
      'import sys, yaml, json',
      'try:',
      '    with open(sys.argv[1]) as f:',
      '        cfg = yaml.safe_load(f) or {}',
      'except Exception:',
      '    cfg = {}',
      'print(json.dumps(cfg if isinstance(cfg, dict) else {}))',
    ].join('\n')
    const b64 = Buffer.from(script, 'utf8').toString('base64')
    try {
      const out = await this.ssh(`printf %s ${shq(b64)} | base64 -d | python3 - ${shq(cfgPath)}`)
      return JSON.parse(out.trim() || '{}')
    } catch {
      return {}
    }
  }

  /** Best-effort reconstruction of a HermesAgentSpec from the LIVE profile on the host, for
   *  agents that have no AI-Lab spec (created directly in OpenClaw/Hermes). Reads the fields we
   *  can faithfully recover from config.yaml + SOUL.md (model, fallback, tts, delegation, persona)
   *  so the editor shows real values instead of a blank form. Toolsets are intentionally omitted
   *  (the gateway-group picker owns those). Returns null if the profile does not exist. */
  async reconstructSpec(agentId: string): Promise<Record<string, any> | null> {
    if (!(await this.agentExists(agentId))) return null
    const cfg = await this.readConfigJson(agentId)
    const soul = await this.readSoul(agentId)
    const model = (cfg?.model?.default as string) || ''
    const fallback = Array.isArray(cfg?.fallback_providers)
      ? (cfg.fallback_providers as any[]).map((x) => (typeof x === 'string' ? x : x?.model)).filter(Boolean)
      : []
    const personality = cfg?.agent?.personality as string | undefined
    const persona = (soul && soul.trim()) || personality
      ? { soul: soul || undefined, personality: personality || undefined }
      : undefined
    const tts = cfg?.tts?.provider
      ? { provider: cfg.tts.provider as string, voiceId: cfg.tts.voice_id ?? cfg.tts.voiceId, modelId: cfg.tts.model_id ?? cfg.tts.modelId }
      : undefined
    const spec: Record<string, any> = { agentId, displayName: agentId, model, fallback, toolsets: [] }
    if (persona) spec.persona = persona
    if (tts) spec.tts = tts
    return spec
  }

  /** The standard/default docs every agent has — protected from deletion (basename match). */
  private static readonly PROTECTED_DOC_BASENAMES = new Set([
    'SOUL.md', 'AGENTS.md', 'BOOT.md', 'BOOTSTRAP.md', 'EXECUTION.md',
    'HEARTBEAT.md', 'IDENTITY.md', 'TOOLS.md', 'USER.md', 'MEMORY.md',
  ])
  private isProtectedDoc(rel: string): boolean {
    const base = rel.split('/').pop() || rel
    return HermesManagementService.PROTECTED_DOC_BASENAMES.has(base)
  }

  /** Validate a caller-supplied relative doc path: a `.md` file inside the profile, no traversal,
   *  never a bundled skill. Returns the cleaned rel path or null. */
  private safeDocRel(relpath: unknown): string | null {
    if (typeof relpath !== 'string' || !relpath) return null
    if (relpath.includes('..') || relpath.startsWith('/') || relpath.includes('\0')) return null
    if (!relpath.endsWith('.md')) return null
    if (relpath.startsWith('skills/') || relpath.includes('/skills/')) return null
    return relpath
  }

  /** List the editable config markdown docs for an agent — SOUL.md + workspace/*.md (excludes
   *  bundled skills). Returns rel paths + byte sizes. */
  async listDocs(agentId: string): Promise<Array<{ path: string; bytes: number; protected: boolean }>> {
    const home = this.profileHome(agentId)
    const cmd = `cd ${shq(home)} 2>/dev/null && find -L . -maxdepth 3 -type f -name '*.md' -not -path '*/skills/*' -not -path '*/memory/*' -not -path '*/library/*' -printf '%s\t%P\n' 2>/dev/null | sort -t/ -k1`
    let out = ''
    try { out = await this.ssh(cmd) } catch { return [] }
    const docs: Array<{ path: string; bytes: number; protected: boolean }> = []
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const bytes = parseInt(line.slice(0, tab), 10) || 0
      const rel = line.slice(tab + 1).trim()
      if (this.safeDocRel(rel)) docs.push({ path: rel, bytes, protected: this.isProtectedDoc(rel) })
    }
    return docs
  }

  /** Read one config doc off the host. Empty string if missing. Throws on an invalid path. */
  async readDoc(agentId: string, relpath: string): Promise<string> {
    const rel = this.safeDocRel(relpath)
    if (!rel) throw new Error('invalid doc path')
    const full = `${this.profileHome(agentId)}/${rel}`
    const b64 = (await this.ssh(`base64 -w0 ${shq(full)} 2>/dev/null || true`)).trim()
    if (!b64) return ''
    try { return Buffer.from(b64, 'base64').toString('utf8') } catch { return '' }
  }

  /** Write one config doc on the host. Throws on an invalid path. */
  async writeDoc(agentId: string, relpath: string, content: string): Promise<void> {
    const rel = this.safeDocRel(relpath)
    if (!rel) throw new Error('invalid doc path')
    await this.writeRemoteFile(`${this.profileHome(agentId)}/${rel}`, content)
  }

  /** The gateway MCP server name each agent uses (currently the full gateway; we repoint its URL
   *  to a per-agent group to scope tools, keeping the NAME stable so tool-name prefixes don't move). */
  private static readonly GATEWAY_SERVER = 'ai-lab' // AI-Lab-managed gateway MCP server (convergent name)
  private static readonly GATEWAY_SERVER_ALIASES = ['ai-lab', 'mcpjungle'] // remove any of these before re-adding
  private gatewayBase(): string {
    return (process.env.MCPJUNGLE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  }

  /** Read an agent's curated tool selection from its gateway group. `scoped:false` means the agent
   *  has no group yet (it points at the FULL gateway = all tools). */
  async getAgentTools(agentId: string): Promise<{ selected: string[]; scoped: boolean; endpoint: string | null }> {
    const gw = this.gatewayBase()
    try {
      const r = await fetch(`${gw}/api/v0/tool-groups/agent-${agentId}`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) return { selected: [], scoped: false, endpoint: null }
      const g = (await r.json()) as any
      return {
        selected: Array.isArray(g?.included_tools) ? g.included_tools : [],
        scoped: true,
        endpoint: `${gw}/v0/groups/agent-${agentId}/mcp`,
      }
    } catch {
      return { selected: [], scoped: false, endpoint: null }
    }
  }

  /** Scope an agent to a curated tool set: upsert its gateway group, then repoint the agent's
   *  native MCP server at the group endpoint (idempotent remove+add, same server name). */
  async syncAgentTools(agentId: string, treeNames: string[]): Promise<{ endpoint: string; toolCount: number }> {
    const gw = this.gatewayBase()
    const group = `agent-${agentId}`
    const payload = { name: group, description: `AI-Lab tool set for ${agentId}`, included_servers: [], included_tools: treeNames, excluded_tools: [] }
    // POST is create-only (UNIQUE constraint), so delete-then-create = true upsert on re-scope.
    await fetch(`${gw}/api/v0/tool-groups/${group}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) }).catch(() => undefined)
    const r = await fetch(`${gw}/api/v0/tool-groups`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) throw new Error(`group upsert -> ${r.status}: ${await r.text().catch(() => '')}`)
    const endpoint = `${gw}/v0/groups/${group}/mcp`
    await this.repointGatewayServer(agentId, endpoint)
    return { endpoint, toolCount: treeNames.length }
  }

  /** Revert an agent to the FULL gateway (remove its group + repoint the MCP server at /mcp). */
  async resetAgentTools(agentId: string): Promise<void> {
    const gw = this.gatewayBase()
    await this.repointGatewayServer(agentId, `${gw}/mcp`)
    await fetch(`${gw}/api/v0/tool-groups/agent-${agentId}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) }).catch(() => undefined)
  }

  /** Seed a newly-created agent's workspace with the template operating docs from the
   *  `default` profile (AGENTS/EXECUTION/TOOLS/HEARTBEAT/BOOT + blank IDENTITY/USER stubs).
   *  cp -n = no-clobber, so anything --clone or Hermes bootstrap already placed is preserved.
   *  SOUL.md is NOT here (it lives at the profile root, seeded by --clone from default). */
  private async copyTemplateDocs(agentId: string): Promise<void> {
    const src = `${this.profileHomeBase}/default/workspace`
    const dst = `${this.profileHome(agentId)}/workspace`
    await this.ssh(`mkdir -p ${shq(dst)} && cp -Pn ${shq(src)}/*.md ${shq(dst)}/ 2>/dev/null || true`)
  }

  /** Copy a doc from the `default` template store into an agent's workspace (the per-agent
   *  "add from template" action). Overwrites if present (explicit user action). Returns the
   *  rel path. Throws if the template path is invalid or the template doesn't exist. */
  async addDocFromTemplate(agentId: string, templateRel: string): Promise<string> {
    const rel = this.safeDocRel(templateRel)
    if (!rel) throw new Error('invalid template path')
    const src = `${this.profileHomeBase}/default/${rel}`
    const dst = `${this.profileHome(agentId)}/${rel}`
    const dir = dst.replace(/\/[^/]+$/, '')
    await this.ssh(`test -f ${shq(src)} && mkdir -p ${shq(dir)} && cp -f ${shq(src)} ${shq(dst)}`)
    return rel
  }

  /** Delete a non-default doc from an agent workspace. Refuses the standard/default docs and
   *  invalid paths. */
  async deleteDoc(agentId: string, relpath: string): Promise<void> {
    const rel = this.safeDocRel(relpath)
    if (!rel) throw new Error('invalid doc path')
    if (this.isProtectedDoc(rel)) throw new Error('cannot delete a default doc')
    await this.ssh(`rm -f ${shq(`${this.profileHome(agentId)}/${rel}`)}`)
  }

  /** List the agent's memory docs for the Memory tab: workspace/MEMORY.md (the durable
   *  memory) + the workspace/memory/*.md daily logs. Same rel-path shape as listDocs, so the
   *  existing GET/PUT/DELETE /doc endpoints edit + delete them (MEMORY.md is protected). */
  async listMemoryDocs(agentId: string): Promise<Array<{ path: string; bytes: number; protected: boolean }>> {
    const home = this.profileHome(agentId)
    const cmd = `cd ${shq(home)} 2>/dev/null && find -L workspace/memory -maxdepth 2 -type f -name '*.md' -printf 'workspace/memory/%f\t%s\n' 2>/dev/null`
    let out = ''
    try { out = await this.ssh(cmd) } catch { return [] }
    const docs: Array<{ path: string; bytes: number; protected: boolean }> = []
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const rel = line.slice(0, tab).trim()
      const bytes = parseInt(line.slice(tab + 1), 10) || 0
      if (this.safeDocRel(rel)) docs.push({ path: rel, bytes, protected: this.isProtectedDoc(rel) })
    }
    docs.sort((a, b) => a.path.localeCompare(b.path))
    return docs
  }

  private static readonly SKILLS_DIR = '/root/.hermes/skills'

  /** Validate a skill ref (relative dir path under the skills lib): N safe segments, no traversal. */
  private safeSkillRef(ref: unknown): string | null {
    if (typeof ref !== 'string' || !ref) return null
    const segs = ref.split('/')
    if (!segs.length || segs.some((x) => x === '..' || !/^[A-Za-z0-9._-]+$/.test(x))) return null
    return ref
  }

  /** List every skill in the Hermes library (any dir containing SKILL.md, at any depth) with its
   *  frontmatter name/description. ref = dir path relative to the lib; source=local for `custom`. */
  async listLibrarySkills(): Promise<Array<{ ref: string; name: string; dir: string; category: string; description: string; source: string }>> {
    const py = [
      'import os, re, json',
      `BASE = ${JSON.stringify(HermesManagementService.SKILLS_DIR)}`,
      'out = []',
      'for root, dirs, files in os.walk(BASE):',
      '    if "SKILL.md" not in files: continue',
      '    ref = os.path.relpath(root, BASE)',
      '    if ref == ".": continue',
      '    dirs[:] = []',
      '    try: t = open(os.path.join(root, "SKILL.md"), errors="replace").read()',
      '    except Exception: t = ""',
      '    m = re.match(r"^---\\n(.*?)\\n---", t, re.S)',
      '    fm = m.group(1) if m else ""',
      '    nm = re.search(r"^name:\\s*(.+)", fm, re.M)',
      '    dm = re.search(r"^description:\\s*(.*)", fm, re.M)',
      '    desc = (dm.group(1).strip() if dm else "")',
      '    if desc in ("", "|", ">", "|-", ">-"):',
      '        after = fm[dm.end():] if dm else ""',
      '        for ln in after.splitlines():',
      '            if ln.strip(): desc = ln.strip(); break',
      '    segs = ref.split(os.sep)',
      '    out.append({"ref": ref.replace(os.sep, "/"), "name": (nm.group(1).strip() if nm else segs[-1]), "dir": segs[-1], "category": segs[0], "description": desc[:280], "source": "local" if segs[0] == "custom" else "builtin"})',
      'out.sort(key=lambda x: (x["category"], x["name"]))',
      'print(json.dumps(out))',
    ].join('\n')
    const b64 = Buffer.from(py, 'utf8').toString('base64')
    try {
      const out = await this.ssh(`printf %s ${shq(b64)} | base64 -d | python3 -`)
      return JSON.parse(out.trim() || '[]')
    } catch {
      return []
    }
  }

  async readLibrarySkill(ref: string): Promise<string> {
    const r = this.safeSkillRef(ref)
    if (!r) throw new Error('invalid skill ref')
    const b64 = (await this.ssh(`base64 -w0 ${shq(`${HermesManagementService.SKILLS_DIR}/${r}/SKILL.md`)} 2>/dev/null || true`)).trim()
    if (!b64) return ''
    try { return Buffer.from(b64, 'base64').toString('utf8') } catch { return '' }
  }

  /** Create or edit a skill's SKILL.md in the library (mkdir -p for a new skill). */
  async writeLibrarySkill(ref: string, content: string): Promise<void> {
    const r = this.safeSkillRef(ref)
    if (!r) throw new Error('invalid skill ref')
    const dir = `${HermesManagementService.SKILLS_DIR}/${r}`
    await this.ssh(`mkdir -p ${shq(dir)}`)
    await this.writeRemoteFile(`${dir}/SKILL.md`, content)
  }

  /** The set of skill refs currently assigned to an agent (present in its profile/skills/). */
  private async assignedSkillRefs(agentId: string): Promise<Set<string>> {
    const skillsRoot = `${this.profileHome(agentId)}/skills`
    let out = ''
    try { out = await this.ssh(`cd ${shq(skillsRoot)} 2>/dev/null && find . -name SKILL.md -printf '%h\\n' 2>/dev/null | sed 's|^\\./||'`) } catch { return new Set() }
    return new Set(out.split('\n').map((x) => x.trim()).filter(Boolean))
  }

  /** Library skills annotated with whether each is assigned to the agent. */
  async listAgentSkills(agentId: string): Promise<Array<{ ref: string; name: string; category: string; description: string; source: string; assigned: boolean }>> {
    const [lib, assigned] = await Promise.all([this.listLibrarySkills(), this.assignedSkillRefs(agentId)])
    return lib.map((sk) => ({ ref: sk.ref, name: sk.name, category: sk.category, description: sk.description, source: sk.source, assigned: assigned.has(sk.ref) }))
  }

  /** Assign a library skill to an agent (copy the skill dir into profile/skills/). */
  async assignSkill(agentId: string, ref: string): Promise<void> {
    const r = this.safeSkillRef(ref)
    if (!r) throw new Error('invalid skill ref')
    const src = `${HermesManagementService.SKILLS_DIR}/${r}`
    const dst = `${this.profileHome(agentId)}/skills/${r}`
    const parent = dst.replace(/\/[^/]+$/, '')
    await this.ssh(`test -d ${shq(src)} && mkdir -p ${shq(parent)} && cp -a ${shq(src)} ${shq(parent)}/`)
    const bonded = await this.bondedDocFor(r)
    if (bonded) await this.updateAgentToc(agentId, [bonded], [])
  }

  /** Unassign a skill from an agent (remove its dir from profile/skills/). */
  async unassignSkill(agentId: string, ref: string): Promise<void> {
    const r = this.safeSkillRef(ref)
    if (!r) throw new Error('invalid skill ref')
    await this.ssh(`rm -rf ${shq(`${this.profileHome(agentId)}/skills/${r}`)}`)
    const bonded = await this.bondedDocFor(r)
    if (bonded) await this.updateAgentToc(agentId, [], [bonded])
  }

  private static readonly LIBRARY_DIR = '/root/.hermes/library'

  private safeLibDocName(name: unknown): string | null {
    if (typeof name !== 'string' || !name) return null
    return /^[A-Za-z0-9._-]+\.md$/.test(name) ? name : null
  }

  /** List central library docs. skill = the bonded skill name for `skill-<name>.md`, else null. */
  async listLibraryDocs(): Promise<Array<{ name: string; title: string; skill: string | null }>> {
    const py = [
      'import os, re, json',
      `D = ${JSON.stringify(HermesManagementService.LIBRARY_DIR)}`,
      'out = []',
      'for f in sorted(os.listdir(D)) if os.path.isdir(D) else []:',
      '    if not f.endswith(".md"): continue',
      '    title = f',
      '    try:',
      '        for ln in open(os.path.join(D, f), errors="replace"):',
      '            if ln.strip().startswith("# "): title = ln.strip()[2:].strip(); break',
      '    except Exception: pass',
      '    skill = f[6:-3] if f.startswith("skill-") else None',
      '    out.append({"name": f, "title": title, "skill": skill})',
      'print(json.dumps(out))',
    ].join('\n')
    const b64 = Buffer.from(py, 'utf8').toString('base64')
    try { return JSON.parse((await this.ssh(`printf %s ${shq(b64)} | base64 -d | python3 -`)).trim() || '[]') } catch { return [] }
  }

  async readLibraryDoc(name: string): Promise<string> {
    const n = this.safeLibDocName(name)
    if (!n) throw new Error('invalid library doc name')
    const b64 = (await this.ssh(`base64 -w0 ${shq(`${HermesManagementService.LIBRARY_DIR}/${n}`)} 2>/dev/null || true`)).trim()
    return b64 ? Buffer.from(b64, 'base64').toString('utf8') : ''
  }

  async writeLibraryDoc(name: string, content: string): Promise<void> {
    const n = this.safeLibDocName(name)
    if (!n) throw new Error('invalid library doc name')
    await this.ssh(`mkdir -p ${shq(HermesManagementService.LIBRARY_DIR)}`)
    await this.writeRemoteFile(`${HermesManagementService.LIBRARY_DIR}/${n}`, content)
  }

  /** Add/remove LIBRARY-TOC entries in an agent's TOOLS.md (the skill->doc pointer). */
  private async updateAgentToc(agentId: string, addDocs: string[], removeDocs: string[]): Promise<void> {
    const toolsPath = `${this.profileHome(agentId)}/workspace/TOOLS.md`
    const py = [
      'import sys, os, re, json, base64',
      'tools_path, libdir = sys.argv[1], sys.argv[2]',
      'add = json.loads(base64.b64decode(sys.argv[3]))',
      'rem = json.loads(base64.b64decode(sys.argv[4]))',
      'def title_of(doc):',
      '    p = os.path.join(libdir, doc)',
      '    try:',
      '        for ln in open(p, errors="replace"):',
      '            ln = ln.strip()',
      '            if ln.startswith("# "): return ln[2:].strip()',
      '    except Exception: pass',
      '    return doc',
      'txt = open(tools_path).read() if os.path.exists(tools_path) else ""',
      'START, END = "<!-- LIBRARY-TOC:START -->", "<!-- LIBRARY-TOC:END -->"',
      'if START in txt and END in txt:',
      '    pre, rest = txt.split(START, 1)',
      '    block, post = rest.split(END, 1)',
      '    lines = [l for l in block.splitlines() if l.strip().startswith("- `library/")]',
      'else:',
      '    pre, post, lines = txt.rstrip() + "\\n\\n## Reference library\\n\\nRead these on demand; each is a `library/<doc>.md` pointer.\\n\\n", "\\n", []',
      'def doc_of(line):',
      '    m = re.search(r"`library/([^`]+)`", line)',
      '    return m.group(1) if m else None',
      'kept = [l for l in lines if doc_of(l) not in rem and doc_of(l) not in add]',
      'present = {doc_of(l) for l in lines}',
      'for doc in add:',
      '    kept.append(f"- `library/{doc}` — **{title_of(doc)}**")',
      'seen, out = set(), []',
      'for l in kept:',
      '    d = doc_of(l)',
      '    if d and d not in seen:',
      '        seen.add(d); out.append(l)',
      'out.sort()',
      'newblock = START + "\\n" + ("\\n".join(out) if out else "") + "\\n" + END',
      'open(tools_path, "w").write(pre + newblock + post)',
      'print(json.dumps({"count": len(out)}))'
    ].join('\n')
    const b64 = Buffer.from(py, 'utf8').toString('base64')
    const addB64 = Buffer.from(JSON.stringify(addDocs), 'utf8').toString('base64')
    const remB64 = Buffer.from(JSON.stringify(removeDocs), 'utf8').toString('base64')
    await this.ssh(`printf %s ${shq(b64)} | base64 -d | python3 - ${shq(toolsPath)} ${shq(HermesManagementService.LIBRARY_DIR)} ${shq(addB64)} ${shq(remB64)}`)
  }

  /** The bonded library doc for a skill ref (skill-<dirname>.md) if it exists in the library. */
  private async bondedDocFor(ref: string): Promise<string | null> {
    const dir = ref.split('/').pop() || ref
    const doc = `skill-${dir}.md`
    const found = (await this.ssh(`test -f ${shq(`${HermesManagementService.LIBRARY_DIR}/${doc}`)} && echo y || true`)).trim()
    return found === 'y' ? doc : null
  }

  /** Add/remove a library doc pointer on an agent manually (independent of skills). */
  async setAgentLibraryDoc(agentId: string, name: string, assigned: boolean): Promise<void> {
    const n = this.safeLibDocName(name)
    if (!n) throw new Error('invalid library doc name')
    await this.updateAgentToc(agentId, assigned ? [n] : [], assigned ? [] : [n])
  }

  /** The set of library doc names currently pointed in an agent's TOOLS.md LIBRARY-TOC. */
  private async pointedLibDocs(agentId: string): Promise<Set<string>> {
    const tp = `${this.profileHome(agentId)}/workspace/TOOLS.md`
    let out = ''
    try { out = await this.ssh(`sed -n '/LIBRARY-TOC:START/,/LIBRARY-TOC:END/p' ${shq(tp)} 2>/dev/null | grep -oE 'library/[A-Za-z0-9._-]+\\.md' | sed 's|library/||' || true`) } catch { return new Set() }
    return new Set(out.split('\n').map((x) => x.trim()).filter(Boolean))
  }

  /** Central library docs annotated with whether each is pointed on the given agent (for stateful toggles). */
  async listAgentLibraryDocs(agentId: string): Promise<Array<{ name: string; title: string; skill: string | null; pointed: boolean }>> {
    const [docs, pointed] = await Promise.all([this.listLibraryDocs(), this.pointedLibDocs(agentId)])
    return docs.map((d) => ({ ...d, pointed: pointed.has(d.name) }))
  }

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

  /** Reconcile per-agent TTS. Present → set provider + voice/model + enable the tts toolset;
   *  absent → reset tts.provider so a previously-configured voice stops (idempotent removal).
   *  `config set` handles these scalar dot-keys directly (verified type coercion). */
  private async applyTts(agentId: string, tts?: { provider: string; voiceId?: string; modelId?: string }): Promise<void> {
    if (tts?.provider) {
      const p = tts.provider
      await this.hermes(['-p', agentId, 'config', 'set', 'tts.provider', p])
      if (tts.voiceId) await this.hermes(['-p', agentId, 'config', 'set', `tts.${p}.voice_id`, tts.voiceId])
      if (tts.modelId) await this.hermes(['-p', agentId, 'config', 'set', `tts.${p}.model_id`, tts.modelId])
      await this.hermes(['-p', agentId, 'tools', 'enable', 'tts'])
    } else {
      await this.hermes(['-p', agentId, 'config', 'set', 'tts.provider', ''])
    }
  }

  /** Reconcile sub-agent delegation (native delegation.* config). Sub-agents run the SAME profile;
   *  `model` overrides only their model (via the ailab proxy) so they can be cheaper/faster.
   *  Absent (or no model) → clear the override so sub-agents inherit the parent again. */
  private async applyDelegation(
    agentId: string,
    sa?: { model?: string; reasoningEffort?: string; maxConcurrent?: number; maxSpawnDepth?: number; autoApproveDangerous?: boolean },
  ): Promise<void> {
    if (sa?.model) {
      await this.hermes(['-p', agentId, 'config', 'set', 'delegation.provider', 'ailab'])
      await this.hermes(['-p', agentId, 'config', 'set', 'delegation.model', sa.model])
    } else {
      await this.hermes(['-p', agentId, 'config', 'set', 'delegation.model', ''])
      await this.hermes(['-p', agentId, 'config', 'set', 'delegation.provider', ''])
    }
    if (sa) {
      if (sa.reasoningEffort) await this.hermes(['-p', agentId, 'config', 'set', 'delegation.reasoning_effort', sa.reasoningEffort])
      if (sa.maxConcurrent) await this.hermes(['-p', agentId, 'config', 'set', 'delegation.max_concurrent_children', String(sa.maxConcurrent)])
      if (sa.maxSpawnDepth) await this.hermes(['-p', agentId, 'config', 'set', 'delegation.max_spawn_depth', String(sa.maxSpawnDepth)])
      if (sa.autoApproveDangerous != null) await this.hermes(['-p', agentId, 'config', 'set', 'delegation.subagent_auto_approve', String(sa.autoApproveDangerous)])
      await this.hermes(['-p', agentId, 'tools', 'enable', 'delegation'])
    }
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

    // Seed the new agent's workspace from the doc templates (default/workspace).
    if (created) await this.copyTemplateDocs(id)

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

    // Per-agent TTS + sub-agent delegation — ALWAYS reconciled (like fallback), so removing a
    // block from the spec and re-applying resets it rather than leaving stale config behind.
    await this.applyTts(id, spec.tts)
    await this.applyDelegation(id, spec.subAgents)

    // Enabled toolsets — additive: enable what the spec requests. (Does not disable others; a
    // full enable/disable sync would risk stripping Hermes defaults the profile relies on.)
    if (spec.toolsets?.length) {
      await this.hermes(['-p', id, 'tools', 'enable', ...spec.toolsets])
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
