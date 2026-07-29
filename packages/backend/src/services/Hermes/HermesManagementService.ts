import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'fs'
import { dirname } from 'path'
import type { HermesAgentSpec, ProviderService } from '@gyshell/shared'
import { PROVIDER_SERVICE_CAPS } from '@gyshell/shared'
// @ts-expect-error — proxy capability resolver ships as untyped JS (same pattern as the other proxy/*.js imports)
import { resolveModelCapabilities } from '../Cluster/proxy/model-capabilities.js'
import { clusterSettingsService } from '../Cluster/ClusterSettingsService'
import { loadToolRegistry, resolveSelection, unknownToolsError, readToolGroup, writeToolGroup } from '../mcp/toolGroups.js'

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
  /** JSON file where global Support-Models roles (Vision Description describer, etc.) persist. */
  supportModelsFile?: string
}

/** One Support-Models assignment (a model wired to a Hermes `auxiliary.<key>` role).
 *  `description`/`recommendation` are AI-Lab-side UI metadata (NOT sent to Hermes). */
export interface SupportModelRole { provider?: string; model?: string; description?: string; recommendation?: string; timeout?: number; noThink?: boolean }
/** Global "Support Models" assignments keyed by Hermes auxiliary task key (vision, compression,
 *  web_extract, ...). Legacy visionDescription/compaction keys are migrated on read. */
export type SupportModelRoles = Record<string, SupportModelRole>

/** Roles usable beyond Hermes → NO "Hermes-specific" badge in the UI. */
export const SHARED_SUPPORT_ROLES = new Set<string>(['vision', 'compression', 'tts_audio_tags'])
/** Roles whose consumer is NOT Hermes. UI-controlled and persisted to the shared
 *  support-models file (external services read it), but NEVER written into an agent's
 *  `auxiliary.<key>`. They need ONE concrete model name — `auto` ("the agent's own
 *  model") is meaningless to an external service. */
export const EXTERNAL_SUPPORT_ROLES = new Set<string>(['memory_extraction', 'memory_vlm'])

/** Roles whose per-agent value is DERIVED from that agent's own model rather than set
 *  globally. applyRoleConfig recomputes these per agent (vision-capable model -> auto,
 *  text-only -> external describer), so agents legitimately differ. Never report that
 *  as drift: it cannot be reconciled and the warning would be permanent. */
export const CAPABILITY_MANAGED_ROLES = new Set<string>(['vision'])

/** Profile dirs that are TEMPLATES, not addressable agents. `hermes -p default` means "no
 *  profile" and writes the GLOBAL config, so a template's own config.yaml never receives an
 *  apply — it would sit at Auto forever and manufacture permanent, unfixable "drift". */
export const TEMPLATE_PROFILES = new Set<string>(['default', 'zztmpl', 'zzglob'])

/** Roles Hermes READS (auxiliary.<key>) but does NOT advertise via _all_aux_tasks() — supplied here. */
const AUX_TASK_SUPPLEMENT: Array<{ key: string; label: string; description: string }> = [
  { key: 'background_review', label: 'Background Review', description: 'Memory auto-extraction reviewer — every ~10 turns it reviews the conversation and saves worthwhile facts to MEMORY.md / USER.md.' },
  { key: 'goal_judge', label: 'Goal Judge', description: 'Judges progress in the /goal tracking loop.' },
  { key: 'session_search', label: 'Session Search', description: 'Searches and ranks your past sessions.' },
  { key: 'monitor', label: 'Monitor', description: 'Classifies items for cron monitors and alerts.' },
  { key: 'memory_extraction', label: 'Memory Extraction (HippocampAI)', description: 'EXTERNAL consumer: HippocampAI distills durable memories and runs conflict checks; reads this as LLM_MODEL. Not a Hermes aux role — needs a concrete model, never Auto.' },
  { key: 'memory_vlm', label: 'Memory VLM (OpenViking)', description: 'EXTERNAL consumer: OpenViking vision-language model (vlm.model). Not a Hermes aux role — needs a concrete model, never Auto.' },
]
/** AI-Lab-authored per-role defaults. Precedence: user override (stored) > this default > Hermes short desc. */
const AUX_ROLE_DEFAULTS: Record<string, { description?: string; recommendation?: string }> = {
  vision: { recommendation: 'Vision-capable model (or a strong describer). Context \u2265 32k. Only used by text-only agents that need images described.' },
  compression: { recommendation: 'Strong summarizer; long context ideal (\u2265 128k) since it reads large transcripts. A fast, always-warm local model works well.' },
  web_extract: { recommendation: 'Small\u2013mid, fast. Longer context helps for large pages (\u2265 32k).' },
  approval: { recommendation: 'Small, fast, low-latency. Context \u2265 16k.' },
  mcp: { recommendation: 'Small\u2013mid, fast. Context \u2265 32k.' },
  title_generation: { recommendation: 'Tiny, fast. Context \u2265 8k.' },
  tts_audio_tags: { recommendation: 'Small, fast. Context \u2265 8k.' },
  skills_hub: { recommendation: 'Small, fast. Context \u2265 32k.' },
  triage_specifier: { recommendation: 'Small\u2013mid. Context \u2265 32k.' },
  kanban_decomposer: { recommendation: 'Mid-size with good reasoning. Context \u2265 32k.' },
  profile_describer: { recommendation: 'Small\u2013mid. Context \u2265 16k.' },
  curator: { recommendation: 'Mid-size. Context \u2265 32k.' },
  background_review: { recommendation: 'Mid-size with good comprehension; long context (\u2265 128k). Leave on Auto to reuse the agent\u2019s own main model (warm cache = cheap).' },
  goal_judge: { recommendation: 'Tiny\u2013small, fast, cheap. Context \u2265 8k.' },
  session_search: { recommendation: 'Small, fast. Context \u2265 32k.' },
  monitor: { recommendation: 'Small, fast. Context \u2265 16k.' },
  memory_extraction: { recommendation: 'Small-to-mid, fast, always-on. Context >= 32k. Must be a CONCRETE model — HippocampAI cannot resolve Auto.' },
  memory_vlm: { recommendation: 'Vision-capable. Context >= 32k. Must be a CONCRETE model — OpenViking cannot resolve Auto.' },
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
  /** Cache of Hermes' live _all_aux_tasks() list — the expensive ssh+python pull. Keyed by the
   *  Hermes version so it only recomputes across a Hermes upgrade; 5-min TTL skips even the version
   *  check on rapid opens. (Stored description/recommendation overrides are merged fresh each call.) */
  private auxLiveCache: { version: string; live: Array<[string, string, string]>; checkedAt: number } | null = null

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

  // ── Support Models roles (global describer/TTS/STT model assignments) ───────────
  private loadSupportModels(): SupportModelRoles {
    if (!this.cfg.supportModelsFile || !existsSync(this.cfg.supportModelsFile)) return {}
    try {
      const o = JSON.parse(readFileSync(this.cfg.supportModelsFile, 'utf8'))
      if (!o || typeof o !== 'object') return {}
      const roles = o as SupportModelRoles
      // Migrate legacy keys → aux keys (visionDescription→vision, compaction→compression).
      if (roles.visionDescription && !roles.vision) { roles.vision = roles.visionDescription; delete roles.visionDescription }
      if (roles.compaction && !roles.compression) { roles.compression = roles.compaction; delete roles.compaction }
      return roles
    } catch {
      return {}
    }
  }

  getSupportModels(): SupportModelRoles {
    return this.loadSupportModels()
  }

  /** Persist the global Support-Models roles and re-apply vision routing to EVERY agent, so a
   *  describer change propagates to all text-only agents at once (vision agents are unaffected). */
  /** The merged Support-Models role catalog for the UI: Hermes' live _all_aux_tasks() (built-in +
   *  plugin) + the un-advertised supplement, each with an effective description (user override >
   *  authored default > Hermes short desc) + recommendation (user override > authored default). */
  async getAuxTasks(): Promise<Array<{ key: string; label: string; description: string; recommendation: string; shared: boolean; external: boolean; capabilityManaged: boolean; current: string; drift: boolean; perAgent: Record<string, string> }>> {
    let live: Array<[string, string, string]> = []
    const now = Date.now()
    if (this.auxLiveCache && now - this.auxLiveCache.checkedAt < 300_000) {
      live = this.auxLiveCache.live // fresh enough — skip even the version check
    } else {
      const version = await this.hermesVersion()
      if (this.auxLiveCache && this.auxLiveCache.version === version) {
        this.auxLiveCache.checkedAt = now // same Hermes version → keep the cached list
        live = this.auxLiveCache.live
      } else {
        try {
          const py = "import sys;sys.path.insert(0,'/usr/local/lib/hermes-agent');from hermes_cli.main import _all_aux_tasks;import json;print(json.dumps(_all_aux_tasks()))"
          const out = await this.ssh(`/usr/local/lib/hermes-agent/venv/bin/python -c ${shq(py)}`)
          const parsed = JSON.parse(out.trim())
          if (Array.isArray(parsed)) live = parsed as Array<[string, string, string]>
        } catch { /* Hermes unreachable → supplement only */ }
        this.auxLiveCache = { version, live, checkedAt: now }
      }
    }
    const stored = this.loadSupportModels()
    const seen = new Set<string>()
    const assignments = await this.getAuxAssignments()
    const agentIds = Object.keys(assignments)
    // Effective value = what the agents ACTUALLY have. '' means Auto (the agent's own model).
    // drift = agents disagree, which the overlay-only view structurally could not reveal.
    const liveFor = (key: string): { current: string; drift: boolean; perAgent: Record<string, string> } => {
      const perAgent: Record<string, string> = {}
      for (const a of agentIds) perAgent[a] = assignments[a]?.[key]?.model || ''
      // Drift is judged on REAL agents only — a template can never be applied to, so including
      // it would make the "agents disagree" banner permanent and unclearable.
      const distinct = new Set(agentIds.filter((a) => !TEMPLATE_PROFILES.has(a)).map((a) => perAgent[a]))
      return { current: distinct.size === 1 ? [...distinct][0] : '', drift: distinct.size > 1, perAgent }
    }
    const rows: Array<{ key: string; label: string; description: string; recommendation: string; shared: boolean; external: boolean; capabilityManaged: boolean; current: string; drift: boolean; perAgent: Record<string, string> }> = []
    const add = (key: string, label: string, hermesDesc: string) => {
      if (seen.has(key)) return
      seen.add(key)
      const def = AUX_ROLE_DEFAULTS[key] || {}
      const s = stored[key] || {}
      const external = EXTERNAL_SUPPORT_ROLES.has(key)
      const capabilityManaged = CAPABILITY_MANAGED_ROLES.has(key)
      // External roles have no per-agent Hermes config; the stored overlay IS their truth.
      const live = external
        ? { current: s.model || '', drift: false, perAgent: {} as Record<string, string> }
        : liveFor(key)
      rows.push({
        key, label,
        description: (s.description || def.description || hermesDesc || '').trim(),
        recommendation: (s.recommendation || def.recommendation || '').trim(),
        shared: SHARED_SUPPORT_ROLES.has(key),
        external,
        capabilityManaged,
        current: live.current,
        // Capability-managed roles are SUPPOSED to differ per agent — not drift.
        drift: capabilityManaged ? false : live.drift,
        perAgent: live.perAgent,
      })
    }
    for (const [key, label, desc] of live) add(key, label, desc)
    for (const s of AUX_TASK_SUPPLEMENT) add(s.key, s.label, s.description)
    return rows
  }

  /** Persist the full role map; apply the MODEL routing for `applyKeys` (changed model-bearing
   *  roles) to every agent. description/recommendation are UI-only (never pushed to Hermes). */
  async setSupportModels(roles: SupportModelRoles, applyKeys?: string[]): Promise<{ agentsUpdated: number }> {
    const clean: SupportModelRoles = {}
    for (const [key, r] of Object.entries(roles)) {
      if (!r) continue
      const entry: SupportModelRole = {}
      if (r.model) { entry.provider = r.provider || 'ailab'; entry.model = r.model }
      if (r.description) entry.description = r.description
      if (r.recommendation) entry.recommendation = r.recommendation
      if (typeof r.timeout === 'number' && r.timeout > 0) entry.timeout = r.timeout
      if (r.noThink !== undefined) entry.noThink = !!r.noThink
      if (Object.keys(entry).length) clean[key] = entry
    }
    if (this.cfg.supportModelsFile) atomicWriteJson(this.cfg.supportModelsFile, clean)
    const keys = (applyKeys && applyKeys.length ? applyKeys : Object.keys(clean))
    if (!keys.length) return { agentsUpdated: 0 }
    const agents = await this.listAgents()
    // Reconcile agents CONCURRENTLY — this used to be serial (8 agents x up to 3 `hermes
    // config set` calls each = ~24 sequential round-trips) and felt broken in the UI.
    // Per-agent writes stay ordered; different agents touch different profile files.
    const results = await Promise.all(agents.map(async (id) => {
      try {
        for (const key of keys) await this.applyRoleConfig(id, key, clean[key])
        return true
      } catch (e) {
        console.warn(`[support-models] apply failed for agent ${id}:`, (e as Error)?.message || e)
        return false
      }
    }))
    const n = results.filter(Boolean).length
    return { agentsUpdated: n }
  }

  /** Apply one support-model role to one agent. `vision` keeps its capability-aware special apply;
   *  every other role is a plain `auxiliary.<key>` route through the AI-Lab proxy (provider=ailab),
   *  or `auto` (→ the agent's own main model) when unassigned. This also clears any dead base_url. */
  private async applyRoleConfig(agentId: string, key: string, role?: SupportModelRole): Promise<void> {
    // External-consumer roles (HippocampAI / OpenViking) are NOT Hermes aux tasks. Writing
    // them into auxiliary.<key> would invent a phantom role on every agent. The stored
    // support-models file is their only channel.
    if (EXTERNAL_SUPPORT_ROLES.has(key)) return
    // Aux timeout (scalar -> config set) + no-think (dict extra_body -> yaml write). Orthogonal to routing.
    if (role && typeof role.timeout === 'number' && role.timeout > 0) {
      await this.hermes(['-p', agentId, 'config', 'set', `auxiliary.${key}.timeout`, String(role.timeout)])
    }
    if (role && role.noThink !== undefined) {
      await this.setAuxExtraBody(agentId, key, !!role.noThink)
    }
    if (key === 'vision') {
      const model = this.getSpec(agentId)?.model
      if (model) await this.applyVisionConfig(agentId, model)
      return
    }
    if (role?.model) {
      await this.hermes(['-p', agentId, 'config', 'set', `auxiliary.${key}.provider`, role.provider || 'ailab'])
      await this.hermes(['-p', agentId, 'config', 'set', `auxiliary.${key}.model`, role.model])
      await this.hermes(['-p', agentId, 'config', 'set', `auxiliary.${key}.base_url`, ''])
    } else {
      await this.hermes(['-p', agentId, 'config', 'set', `auxiliary.${key}.provider`, 'auto'])
      await this.hermes(['-p', agentId, 'config', 'set', `auxiliary.${key}.model`, ''])
    }
  }

  /** Set (or clear) an aux role's `extra_body` as a real DICT via a PyYAML config.yaml write.
   *  `hermes config set` stores a dict as a literal STRING (see applyFallback), which Hermes can't
   *  use — so we edit the yaml directly. noThink=true writes
   *  {chat_template_kwargs:{enable_thinking:false}} (the request-body equivalent of /no_think for
   *  local llama.cpp Qwen support models); false clears it to {}. Local op (Hermes is co-located). */
  private async setAuxExtraBody(agentId: string, key: string, noThink: boolean): Promise<void> {
    const home = this.profileHome(agentId)
    const eb = noThink ? '{"chat_template_kwargs": {"enable_thinking": false}}' : '{}'
    const ebB64 = Buffer.from(eb, 'utf8').toString('base64')
    const script = [
      'import sys, yaml, base64',
      'p, key = sys.argv[1], sys.argv[2]',
      'eb = yaml.safe_load(base64.b64decode(sys.argv[3]).decode()) or {}',
      'try:',
      '    with open(p) as f: cfg = yaml.safe_load(f) or {}',
      'except FileNotFoundError:',
      '    cfg = {}',
      'aux = cfg.setdefault("auxiliary", {})',
      'if not isinstance(aux, dict): aux = cfg["auxiliary"] = {}',
      'role = aux.setdefault(key, {})',
      'if not isinstance(role, dict): role = aux[key] = {}',
      'role["extra_body"] = eb',
      'with open(p, "w") as f:',
      '    yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=False, allow_unicode=True)',
    ].join('\n')
    const scriptB64 = Buffer.from(script, 'utf8').toString('base64')
    await this.ssh(`printf %s ${shq(scriptB64)} | base64 -d | python3 - ${shq(`${home}/config.yaml`)} ${shq(key)} ${shq(ebB64)}`)
  }

  /** Reconcile native-vision routing for an agent, keyed on its model's vision capability.
   *  VISION model → declare `model.supports_vision: true` — the escape hatch a custom/local
   *  provider needs (models.dev can't resolve a local Qwen id, so without this Hermes silently
   *  routes to the DESCRIBE pipeline). That makes the gateway attach images NATIVELY and
   *  `vision_analyze` use its native fast-path (pixels straight to context, no separate model).
   *  Keep `auxiliary.vision.provider: auto` — an explicit aux-vision backend would force describe
   *  mode (decide_image_input_mode rule 1). TEXT-ONLY model → `supports_vision: false` + pin the
   *  global Vision Description describer so its (needed) describe path uses a known-good model. */
  private async applyVisionConfig(agentId: string, model: string): Promise<void> {
    const caps = resolveModelCapabilities(model)
    if (caps?.vision) {
      await this.hermes(['-p', agentId, 'config', 'set', 'model.supports_vision', 'true'])
      await this.hermes(['-p', agentId, 'config', 'set', 'auxiliary.vision.provider', 'auto'])
      await this.hermes(['-p', agentId, 'config', 'set', 'auxiliary.vision.model', ''])
    } else {
      await this.hermes(['-p', agentId, 'config', 'set', 'model.supports_vision', 'false'])
      const d = this.loadSupportModels().vision
      if (d?.model) {
        await this.hermes(['-p', agentId, 'config', 'set', 'auxiliary.vision.provider', d.provider || 'ailab'])
        await this.hermes(['-p', agentId, 'config', 'set', 'auxiliary.vision.model', d.model])
      }
    }
  }

  /** Route the agent's context-compaction (trajectory summarization) to the global Compaction
   *  model via `auxiliary.compression`. Unset → `auto` (falls back to the agent's own main model,
   *  see auxiliary_client main-agent fallback). Model-agnostic — applied to every agent. */
  private async applyCompactionConfig(agentId: string): Promise<void> {
    const c = this.loadSupportModels().compaction
    if (c?.model) {
      await this.hermes(['-p', agentId, 'config', 'set', 'auxiliary.compression.provider', c.provider || 'ailab'])
      await this.hermes(['-p', agentId, 'config', 'set', 'auxiliary.compression.model', c.model])
    } else {
      await this.hermes(['-p', agentId, 'config', 'set', 'auxiliary.compression.provider', 'auto'])
      await this.hermes(['-p', agentId, 'config', 'set', 'auxiliary.compression.model', ''])
    }
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
    // Hermes is co-located in THIS container — run the command LOCALLY instead of over SSH.
    // (Method name kept as `ssh` so the ~60 call sites that build a shell-command string are untouched.)
    try {
      const { stdout } = await execFileAsync('bash', ['-c', remoteCmd], {
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, HOME: '/root' },
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
      throw new Error(`hermes command failed (exit ${code})${stderr ? `: ${stderr.slice(0, 400)}` : ''}`)
    }
  }

  /** hermes <args...> as a properly-quoted remote command. */
  private hermes(parts: string[]): Promise<string> {
    return this.ssh([this.hermesBin, ...parts.map(shq)].join(' '))
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

  // ── Global USER doc ("About Travis") — shared; inlined into every agent's AGENTS.md ──
  private static readonly GLOBAL_USER_PATH = '/root/.hermes/global/USER.md'

  /** The canonical shared USER doc (markdown). '' if none. */
  async getUserDoc(): Promise<string> {
    return (await this.ssh(`cat ${shq(HermesManagementService.GLOBAL_USER_PATH)} 2>/dev/null || true`))
  }

  private static readonly USER_DOC_MARKER = '<!-- doc:user -->'

  /** Write the canonical USER doc + re-propagate its content into every agent's AGENTS.md
   *  "About Your Human" section (everything from the USER_DOC_MARKER to EOF; appended if absent).
   *  Returns how many agents were rewritten. (No regex/backslashes in the embedded python — uses a
   *  plain marker + chr(10) so it survives the SSH/TS layers cleanly.) */
  async setUserDoc(markdown: string): Promise<{ agentsUpdated: number }> {
    await this.writeRemoteFile(HermesManagementService.GLOBAL_USER_PATH, markdown)
    const py = [
      'import os, glob, base64',
      'user = base64.b64decode(os.environ["USER_B64"]).decode("utf-8").strip()',
      'base = "' + this.profileHomeBase + '"',
      'M = "' + HermesManagementService.USER_DOC_MARKER + '"',
      'nl = chr(10)',
      'n = 0',
      'for ag in glob.glob(base + "/*/workspace/AGENTS.md"):',
      '    try:',
      '        t = open(ag, encoding="utf-8").read()',
      '    except Exception:',
      '        continue',
      '    idx = t.find(M)',
      '    head = (t[:idx].rstrip() if idx >= 0 else t.rstrip())',
      '    new = head + nl + nl + M + nl + user + nl',
      '    if new != t:',
      '        open(ag, "w", encoding="utf-8").write(new); n += 1',
      'print(n)',
    ].join('\n')
    const b64 = Buffer.from(py, 'utf8').toString('base64')
    const userB64 = Buffer.from(markdown, 'utf8').toString('base64')
    const out = await this.ssh(`printf %s ${shq(b64)} | base64 -d | USER_B64=${shq(userB64)} ${HermesManagementService.HERMES_PY} -`)
    return { agentsUpdated: parseInt(out.trim(), 10) || 0 }
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

  /** Read Hermes' __version__ cheaply (no python startup) so the aux-task cache invalidates on upgrade. */
  private async hermesVersion(): Promise<string> {
    try {
      const out = await this.ssh("grep -m1 __version__ /usr/local/lib/hermes-agent/hermes_cli/__init__.py 2>/dev/null || true")
      const m = out.match(/["']([^"']+)["']/)
      return m ? m[1] : 'unknown'
    } catch { return 'unknown' }
  }

  /** Read the LIVE `auxiliary.<key>.{provider,model}` for every agent straight from the
   *  profile config.yaml files. THIS is the source of truth the UI must display: the stored
   *  overlay only records what was set THROUGH the UI, so a value set by any other path (or
   *  predating this feature) is invisible to it — which is exactly how four roles sat on a
   *  dead 9B while the UI showed "Auto". One python pass over all profiles. */
  async getAuxAssignments(): Promise<Record<string, Record<string, { provider?: string; model?: string }>>> {
    const script = [
      'import os, sys, json, glob',
      'try:',
      '    import yaml',
      'except Exception:',
      '    print("{}"); raise SystemExit(0)',
      'out = {}',
      'base = sys.argv[1] if len(sys.argv) > 1 else ""',
      'for p in sorted(glob.glob(os.path.join(base, "*", "config.yaml"))):',
      '    agent = os.path.basename(os.path.dirname(p))',
      '    try:',
      '        with open(p) as f: cfg = yaml.safe_load(f) or {}',
      '    except Exception:',
      '        continue',
      '    aux = cfg.get("auxiliary") or {}',
      '    if not isinstance(aux, dict): continue',
      '    roles = {}',
      '    for k, v in aux.items():',
      '        if isinstance(v, dict):',
      '            roles[k] = {"provider": v.get("provider") or "", "model": v.get("model") or ""}',
      '    out[agent] = roles',
      'print(json.dumps(out))',
    ].join('\n')
    const b64 = Buffer.from(script, 'utf8').toString('base64')
    try {
      const out = await this.ssh(`printf %s ${shq(b64)} | base64 -d | python3 - ${shq(this.profileHomeBase)}`)
      const parsed = JSON.parse(out.trim() || '{}')
      return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, Record<string, { provider?: string; model?: string }>>
    } catch (e) {
      // NEVER swallow this silently: an empty result makes every role render as "auto",
      // which is indistinguishable from a genuinely unassigned role.
      console.warn('[support-models] getAuxAssignments failed; UI will fall back to the stored overlay:', (e as Error)?.message || e)
      return {}
    }
  }

  private profileHome(agentId: string): string {
    return `${this.profileHomeBase}/${agentId}`
  }

  // ---- Native tool overrides (ACP chat agent) — backs the acp-tool-override Hermes plugin ----
  // ACP hardcodes enabled_toolsets=["hermes-acp"] at agent creation and ignores
  // agent.disabled_toolsets, so native tools (browser automation etc.) can't be toggled via
  // config. The acp-tool-override plugin redefines the hermes-acp toolset from a per-agent
  // state.json; these methods read the catalog and read/write that desired-state.
  private _nativeCatalog: Array<{ name: string; category: string }> | null = null
  private static readonly NATIVE_PLUGIN = 'acp-tool-override'
  private static readonly HERMES_PY = '/usr/local/lib/hermes-agent/venv/bin/python'

  private nativePluginDir(agentId: string): string {
    return `${this.profileHome(agentId)}/plugins/${HermesManagementService.NATIVE_PLUGIN}`
  }

  /** PRISTINE hermes-acp native tool catalog (name + source-toolset category). A bare
   *  `import toolsets` does NOT load hermes plugins, so this reflects the un-overridden full set
   *  the UI can toggle. Static per Hermes version, so cached. */
  async nativeToolCatalog(): Promise<Array<{ name: string; category: string }>> {
    if (this._nativeCatalog) return this._nativeCatalog
    const py = [
      'import json',
      'from toolsets import get_toolset_info, TOOLSETS',
      'info = get_toolset_info("hermes-acp") or {}',
      'tools = info.get("resolved_tools") or info.get("direct_tools") or []',
      'def cat(t):',
      '    for n, ts in TOOLSETS.items():',
      '        if n in ("hermes-acp", "hermes-api-server"): continue',
      '        if t in (ts.get("tools") or []): return n',
      '    return "other"',
      'print(json.dumps([{"name": t, "category": cat(t)} for t in sorted(tools)]))',
    ].join('\n')
    const b64 = Buffer.from(py, 'utf8').toString('base64')
    const out = await this.ssh(`printf %s ${shq(b64)} | base64 -d | ${HermesManagementService.HERMES_PY} -`)
    this._nativeCatalog = JSON.parse(out.trim())
    return this._nativeCatalog!
  }

  private async readNativeState(agentId: string): Promise<{ disabled_tools: string[]; disabled_toolsets: string[] }> {
    const p = `${this.nativePluginDir(agentId)}/state.json`
    const b64 = (await this.ssh(`base64 -w0 ${shq(p)} 2>/dev/null || true`)).trim()
    if (!b64) return { disabled_tools: [], disabled_toolsets: [] }
    try {
      const d = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { disabled_tools?: unknown; disabled_toolsets?: unknown }
      return {
        disabled_tools: Array.isArray(d.disabled_tools) ? (d.disabled_tools as string[]) : [],
        disabled_toolsets: Array.isArray(d.disabled_toolsets) ? (d.disabled_toolsets as string[]) : [],
      }
    } catch { return { disabled_tools: [], disabled_toolsets: [] } }
  }

  /** Native tools for an agent with current on/off state (enabled=false = removed from the chat
   *  agent by the plugin). */
  async getAgentNativeTools(agentId: string): Promise<{ tools: Array<{ name: string; category: string; enabled: boolean }>; pluginInstalled: boolean }> {
    const [catalog, state, installed] = await Promise.all([
      this.nativeToolCatalog(),
      this.readNativeState(agentId),
      this.nativePluginInstalled(agentId),
    ])
    const off = new Set(state.disabled_tools)
    const offSets = new Set(state.disabled_toolsets)
    const tools = catalog.map((t) => ({ name: t.name, category: t.category, enabled: !(off.has(t.name) || offSets.has(t.category)) }))
    return { tools, pluginInstalled: installed }
  }

  /** Set an agent's disabled native tools by exact name (per-tool model: `disabled` is the full
   *  OFF list). Writes the plugin state.json and ensures the plugin is enabled. */
  async setAgentNativeTools(agentId: string, disabled: string[]): Promise<{ applied: number; disabled: string[] }> {
    const catalog = await this.nativeToolCatalog()
    const valid = new Set(catalog.map((t) => t.name))
    const clean = [...new Set((disabled || []).filter((t) => typeof t === 'string' && valid.has(t)))].sort()
    await this.ensureNativePluginEnabled(agentId)
    const state = { disabled_toolsets: [] as string[], disabled_tools: clean }
    await this.writeRemoteFile(`${this.nativePluginDir(agentId)}/state.json`, JSON.stringify(state, null, 1) + '\n')
    return { applied: clean.length, disabled: clean }
  }

  /** Apply the same disabled-tool set to EVERY agent (global default). */
  async setGlobalNativeTools(disabled: string[]): Promise<{ agents: number }> {
    const agents = await this.listAgents()
    for (const id of agents) {
      try { await this.setAgentNativeTools(id, disabled) } catch { /* skip agents missing the plugin */ }
    }
    return { agents: agents.length }
  }

  private async nativePluginInstalled(agentId: string): Promise<boolean> {
    const p = `${this.nativePluginDir(agentId)}/__init__.py`
    return (await this.ssh(`test -f ${shq(p)} && echo yes || echo no`)).trim() === 'yes'
  }

  /** Ensure `acp-tool-override` is in the profile's plugins.enabled (idempotent). No-op if already
   *  listed; appends a plugins block if the key is absent. Plugin files ship with the profile. */
  private async ensureNativePluginEnabled(agentId: string): Promise<void> {
    const cfg = `${this.profileHome(agentId)}/config.yaml`
    const name = HermesManagementService.NATIVE_PLUGIN
    await this.ssh(`grep -q ${shq(name)} ${shq(cfg)} || printf '\\nplugins:\\n  enabled:\\n  - %s\\n' ${shq(name)} >> ${shq(cfg)}`)
  }

  // Canonical source profile for the composite memory plugin files (composite router + hippocampai
  // lane). Kept in the `default` profile so a new agent inherits whatever version default ships.
  private static readonly MEMORY_TEMPLATE_PROFILE = 'default'

  /** Ensure the composite memory stack on a profile (idempotent, ALWAYS reconciled). Copies the
   *  composite router + hippocampai lane plugin files from the canonical `default` profile and
   *  sets `memory.provider: composite` — de-duping any shadowing empty `provider:` key, or adding a
   *  memory block if none exists. The openviking lane is bundled in Hermes; the shared OpenViking
   *  key lives in the global `.env` every profile inherits. This is what makes composite the
   *  default for NEW agents, since `hermes profile create --clone` carries neither the plugins nor
   *  a non-empty provider. Native user-config + plugin-file writes — not a Hermes-source patch. */
  private async ensureCompositeMemory(agentId: string): Promise<void> {
    if (agentId === HermesManagementService.MEMORY_TEMPLATE_PROFILE) return
    const home = this.profileHome(agentId)
    const tmpl = `${this.profileHomeBase}/${HermesManagementService.MEMORY_TEMPLATE_PROFILE}/plugins`
    // 1. Plugin files (composite + hippocampai). openviking lane is bundled in Hermes.
    await this.ssh(
      `for n in composite hippocampai; do mkdir -p ${shq(home)}/plugins/"$n" && ` +
        `cp -f ${shq(tmpl)}/"$n"/__init__.py ${shq(home)}/plugins/"$n"/__init__.py 2>/dev/null || true; done`,
    )
    // 1b. Fleet skill: ask-claude — lets the agent report bugs / permission issues / blockers
    // to claude1 (the maintainer) over the fleet bus. Copied from the `default` profile so every
    // new agent gets the escalation channel by default.
    const skillSrc = `${this.profileHomeBase}/${HermesManagementService.MEMORY_TEMPLATE_PROFILE}/skills/custom/ask-claude`
    await this.ssh(
      `test -d ${shq(skillSrc)} && mkdir -p ${shq(home)}/skills/custom && ` +
        `cp -rf ${shq(skillSrc)} ${shq(home)}/skills/custom/ 2>/dev/null || true`,
    )
    // 2. memory.provider = composite (dedupe shadowing provider keys; add a memory block if absent).
    const script = [
      'import sys',
      'p = sys.argv[1]',
      'lines = open(p).read().split("\\n")',
      'out, inm, seen, saw = [], False, False, False',
      'for line in lines:',
      '    if line.startswith("memory:"):',
      '        inm, seen, saw = True, False, True; out.append(line); continue',
      '    if inm:',
      '        if line and not line[0].isspace():',
      '            if not seen: out.append("  provider: composite")',
      '            inm = False; out.append(line); continue',
      '        if line.strip().startswith("provider:"):',
      '            if not seen: seen = True; out.append("  provider: composite")',
      '            continue',
      '        out.append(line); continue',
      '    out.append(line)',
      'if inm and not seen: out.append("  provider: composite")',
      'if not saw:',
      '    out += ["memory:", "  provider: composite", "  memory_enabled: true",',
      '            "  user_profile_enabled: true", "  write_approval: false"]',
      'open(p, "w").write("\\n".join(out))',
    ].join('\n')
    const b64 = Buffer.from(script, 'utf8').toString('base64')
    await this.ssh(`printf %s ${shq(b64)} | base64 -d | python3 - ${shq(`${home}/config.yaml`)}`)
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
    // Consolidated (2026-07): SOUL + AGENTS are the two Hermes-injected docs; MEMORY is dynamic;
    // HEARTBEAT/BOOT are functional. IDENTITY/EXECUTION/TOOLS/USER/BOOTSTRAP were folded in + retired.
    'SOUL.md', 'AGENTS.md', 'MEMORY.md', 'USER.md', 'HEARTBEAT.md', 'BOOT.md',
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

  /** AI-Lab's OWN resolved LAN IP (self-identity resolver + Settings override). This is the address
   *  the fleet on OTHER hosts (CT158) must use to reach AI-Lab; loopback is WRONG cross-host. */
  private selfIp(): string {
    return clusterSettingsService.getSelfIdentity().ip
  }

  /** The gateway base as an agent on the Hermes host must dial it (resolved LAN IP, never loopback).
   *  Distinct from gatewayBase(), which is loopback for AI-Lab-side same-host gateway calls. */
  private agentGatewayBase(): string {
    return `http://${this.selfIp()}:8080`
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
        endpoint: `${this.agentGatewayBase()}/v0/groups/agent-${agentId}/mcp`,
      }
    } catch {
      return { selected: [], scoped: false, endpoint: null }
    }
  }

  /** Scope an agent to a curated tool set: upsert its gateway group, then repoint the agent's
   *  native MCP server at the group endpoint (idempotent remove+add, same server name).
   *
   *  DESTRUCTIVE-SAVE GUARD (2026-07-25): MCPJungle's POST /tool-groups is create-only, so a
   *  re-scope must delete first — which made this path capable of destroying the agent's tools.
   *  MCPJungle rejects the ENTIRE request if any single included_tools entry is not a live,
   *  ENABLED tool ("tool X does not exist or is disabled"), and a whole-toolset selection (which
   *  sends a bare server name) or a momentarily-down server is enough to trigger it. Observed:
   *  DELETE 204 -> POST 400 left Wren with no group and no tools, and her Hermes agent then gave
   *  up reconnecting entirely. So now: validate first, expand server names, and roll back. */
  async syncAgentTools(agentId: string, treeNames: string[]): Promise<{ endpoint: string; toolCount: number; gatewayRestarted?: boolean }> {
    const gw = this.gatewayBase()
    const group = `agent-${agentId}`

    // Validate + expand + write via the SHARED helper (services/mcp/toolGroups.ts), the single
    // implementation both this and the AI-Lab-agent path use. It refuses if the gateway is
    // unreachable, expands a bare server name (a whole-toolset selection) into its tools, rejects
    // unknown names before anything is written, and PUTs in place — MCPJungle's PUT is atomic, so
    // a rejected payload leaves the previous membership intact. No DELETE is involved: the old
    // delete-then-create is what destroyed Wren's entire toolset on 2026-07-25.
    const reg = await loadToolRegistry(gw)
    const { included, unknown } = resolveSelection(treeNames, reg)
    if (unknown.length) throw unknownToolsError(group, unknown)

    // Snapshot the previous membership to disk first. Recovering Wren's group was only possible
    // because Hermes happens to log its registration line — luck, not design. This fixes that.
    const previous = await readToolGroup(gw, group)
    if (previous && previous.length) this.backupToolGroup(agentId, previous)

    await writeToolGroup(gw, group, `AI-Lab tool set for ${agentId}`, included)

    const endpoint = `${this.agentGatewayBase()}/v0/groups/${group}/mcp`
    await this.repointGatewayServer(agentId, endpoint)
    // ACP chat sessions reload themselves (HermesAcpBridge.reloadAgentSessions respawns them with
    // --resume). The messaging gateway does NOT — it is a long-lived process that read its MCP
    // config at startup, so without this the Chat tab and Telegram disagree about which tools the
    // agent has until someone restarts the unit by hand.
    const gatewayRestarted = await this.restartAgentGateway(agentId)
    return { endpoint, toolCount: included.length, gatewayRestarted }
  }

  /** Where this agent's tool-group snapshots live. */
  private toolBackupDir(): string | null {
    return this.cfg.specsFile ? `${dirname(this.cfg.specsFile)}/agent-tool-backups` : null
  }

  /** Is the agent actually SERVING the tools its group says it has?
   *
   *  Hermes gives up permanently after 5 failed MCP reconnects ("failed after N reconnection
   *  attempts, giving up") and then runs with no tools until its gateway is restarted — even
   *  after the group is healthy again. That is invisible from the group alone, so compare the
   *  group against the agent's own last registration and look for a give-up AFTER it. */
  async getToolHealth(agentId: string): Promise<{
    groupTools: number; registeredTools: number | null; gaveUp: boolean
    gatewayActive: boolean; healthy: boolean; detail: string
  }> {
    const group = `agent-${agentId}`
    const tools = (await readToolGroup(this.gatewayBase(), group)) ?? []
    const groupTools = tools.length

    const log = `${this.profileHome(agentId)}/logs/agent.log`
    // Last registration line, and anything after it, in one hop.
    const raw = await this.ssh(
      `tail -n 4000 ${shq(log)} 2>/dev/null | grep -aE 'registered [0-9]+ tool\\(s\\) from|reconnection attempts, giving up' | tail -n 20 || true`,
    ).catch(() => '')
    let registeredTools: number | null = null
    let gaveUp = false
    for (const line of raw.split('\n')) {
      const m = line.match(/registered (\d+) tool\(s\) from/)
      if (m) { registeredTools = parseInt(m[1], 10); gaveUp = false; continue }
      if (/reconnection attempts, giving up/.test(line)) gaveUp = true
    }

    const unit = `hermes-gateway-${agentId}`
    const gatewayActive = (await this.ssh(`systemctl is-active ${shq(unit)} 2>/dev/null || true`).catch(() => '')).trim() === 'active'

    // The agent's registration count includes MCP protocol built-ins (list_resources,
    // read_resource, list_prompts, get_prompt) on top of the group's tools, so compare with
    // that allowance rather than demanding equality.
    const PROTOCOL_EXTRAS = 4
    const matches = registeredTools !== null && registeredTools >= groupTools && registeredTools <= groupTools + PROTOCOL_EXTRAS
    const healthy = !gaveUp && (registeredTools === null || matches)
    const detail = gaveUp
      ? 'Hermes stopped retrying its MCP connection and is running with no tools. Reconnect to restore them.'
      : registeredTools === null
        ? 'No registration seen in the agent log yet.'
        : matches
          ? `Serving ${registeredTools} tools for a group of ${groupTools}.`
          : `Group has ${groupTools} tools but the agent last registered ${registeredTools} — it is out of date. Reconnect to resync.`
    return { groupTools, registeredTools, gaveUp, gatewayActive, healthy, detail }
  }

  /** Restart the agent's messaging gateway so it re-reads config and reconnects its MCP link.
   *  This is the ONLY way back from Hermes' permanent give-up without patching Hermes. */
  async reconnectAgentTools(agentId: string): Promise<{ restarted: boolean }> {
    return { restarted: await this.restartAgentGateway(agentId) }
  }

  /** Snapshots of this agent's tool group, newest first. */
  async listToolBackups(agentId: string): Promise<Array<{ file: string; savedAt: string; toolCount: number }>> {
    const dir = this.toolBackupDir()
    if (!dir || !existsSync(dir)) return []
    const out: Array<{ file: string; savedAt: string; toolCount: number }> = []
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${agentId}-`) || !f.endsWith('.json')) continue
      try {
        const d = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { savedAt?: string; included_tools?: string[] }
        out.push({ file: f, savedAt: d.savedAt ?? '', toolCount: (d.included_tools ?? []).length })
      } catch { /* skip an unreadable snapshot */ }
    }
    return out.sort((a, b) => b.file.localeCompare(a.file))
  }

  /** Restore a snapshot: rewrite the group, repoint, and reconnect the gateway. */
  async restoreToolBackup(agentId: string, file: string): Promise<{ toolCount: number; gatewayRestarted: boolean }> {
    if (!/^[A-Za-z0-9._-]+\.json$/.test(file)) throw new Error('bad snapshot name')
    const dir = this.toolBackupDir()
    if (!dir) throw new Error('no snapshot directory configured')
    const path = `${dir}/${file}`
    if (!existsSync(path)) throw new Error(`snapshot not found: ${file}`)
    const snap = JSON.parse(readFileSync(path, 'utf8')) as { included_tools?: string[] }
    const tools = snap.included_tools ?? []
    if (!tools.length) throw new Error('snapshot is empty')
    // Route through the same validated writer: a tool that has since been removed or disabled
    // must not silently poison the restore.
    const { included } = await (async () => {
      const reg = await loadToolRegistry(this.gatewayBase())
      const res = resolveSelection(tools, reg)
      if (res.unknown.length) throw unknownToolsError(`agent-${agentId}`, res.unknown)
      return res
    })()
    await writeToolGroup(this.gatewayBase(), `agent-${agentId}`, `AI-Lab tool set for ${agentId}`, included)
    await this.repointGatewayServer(agentId, `${this.agentGatewayBase()}/v0/groups/agent-${agentId}/mcp`)
    const gatewayRestarted = await this.restartAgentGateway(agentId)
    return { toolCount: included.length, gatewayRestarted }
  }

  /** Persist an agent's tool-group membership before we change it, so a botched save is always
   *  recoverable from disk. Keeps the last 10 snapshots per agent. Best-effort: never throws. */
  private backupToolGroup(agentId: string, tools: string[]): void {
    try {
      if (!this.cfg.specsFile) return // no persistence root configured -> nothing to write beside
      const dir = `${dirname(this.cfg.specsFile)}/agent-tool-backups`
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeFileSync(`${dir}/${agentId}-${stamp}.json`,
        JSON.stringify({ agentId, savedAt: new Date().toISOString(), included_tools: tools }, null, 2))
      const mine = readdirSync(dir).filter((f) => f.startsWith(`${agentId}-`) && f.endsWith('.json')).sort()
      for (const old of mine.slice(0, Math.max(0, mine.length - 10))) {
        try { rmSync(`${dir}/${old}`) } catch { /* noop */ }
      }
    } catch { /* backups must never block a legitimate save */ }
  }

  /** Restart an agent's messaging gateway so it picks up a toolset change, but only if it is
   *  actually running. Returns true if a restart was issued. Never throws — a failed restart
   *  must not fail the save, it just means Telegram lags until the unit cycles. */
  private async restartAgentGateway(agentId: string): Promise<boolean> {
    const unit = `hermes-gateway-${agentId}`
    try {
      const active = (await this.ssh(`systemctl is-active ${shq(unit)} 2>/dev/null || true`)).trim()
      if (active !== 'active') return false
      await this.ssh(`systemctl restart ${shq(unit)} >/dev/null 2>&1 || true`)
      return true
    } catch {
      return false
    }
  }

  /** Revert an agent to the FULL gateway (remove its group + repoint the MCP server at /mcp). */
  async resetAgentTools(agentId: string): Promise<void> {
    const gw = this.gatewayBase()
    await this.repointGatewayServer(agentId, `${this.agentGatewayBase()}/mcp`)
    await fetch(`${gw}/api/v0/tool-groups/agent-${agentId}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) }).catch(() => undefined)
  }

  /** Rewrite the AI-Lab-facing `api:` (LLM proxy) and `url:` (MCP group) hosts in EVERY Hermes
   *  profile + the global config to AI-Lab's current resolved LAN IP, so the fleet follows AI-Lab
   *  across an IP/VLAN migration OR a Settings override edit. Host-only (port/path preserved),
   *  idempotent (no-op when already correct). Backs up each file (.bak-reconcile). Never touches
   *  Hermes source — only the user config YAML Hermes owns. Returns which files changed + which
   *  per-profile gateways are running (they loaded config at start -> need a restart to pick it up). */
  async reconcileFleetAddresses(): Promise<{ ip: string; changed: string[]; unchanged: string[]; runningGateways: string[] }> {
    const ip = this.selfIp()
    if (!/^[0-9A-Za-z._:-]+$/.test(ip)) throw new Error(`refusing to reconcile with suspicious ip '${ip}'`)
    const profGlob = `${this.profileHomeBase}/*/config.yaml`
    const globalCfg = this.profileHomeBase.replace(/\/profiles\/?$/, '') + '/config.yaml'
    const script = [
      `IP=${shq(ip)}`,
      `CH=""; UN=""`,
      `for f in ${shq(globalCfg)} ${profGlob}; do`,
      `  [ -f "$f" ] || continue`,
      `  b=$(md5sum "$f" | cut -d' ' -f1)`,
      `  sed -E -i".bak-reconcile" \\`,
      `    -e "s#(https?://)[^:/]+(:17890/api/proxy/llm/v1)#\\1$IP\\2#g" \\`,
      `    -e "s#(https?://)[^:/]+(:8080/v0/groups/)#\\1$IP\\2#g" "$f"`,
      `  a=$(md5sum "$f" | cut -d' ' -f1)`,
      `  if [ "$b" = "$a" ]; then UN="$UN $f"; else CH="$CH $f"; fi`,
      `done`,
      `echo "CHANGED:$CH"`,
      `echo "UNCHANGED:$UN"`,
      `echo "GATEWAYS:$(pgrep -af '[h]ermes_cli.main --profile' 2>/dev/null | grep -oE -- '--profile [^ ]+' | awk '{print $2}' | sort -u | tr '\n' ' ')"`,
    ].join('\n')
    const out = await this.ssh(script)
    const pick = (k: string) => { const l = out.split('\n').find((x) => x.startsWith(k)); return l ? l.slice(k.length).trim() : '' }
    const toList = (s: string) => s.split(/\s+/).map((x) => x.trim()).filter(Boolean)
    return { ip, changed: toList(pick('CHANGED:')), unchanged: toList(pick('UNCHANGED:')), runningGateways: toList(pick('GATEWAYS:')) }
  }

  /** Read-only preview for the UI: each config file's current AI-Lab-facing host(s) + whether it
   *  already matches the resolved ip, plus which per-profile gateways are live. No changes made. */
  async previewFleetAddresses(): Promise<{ ip: string; files: Array<{ profile: string; path: string; hosts: string[]; matches: boolean }>; runningGateways: string[] }> {
    const ip = this.selfIp()
    const profGlob = `${this.profileHomeBase}/*/config.yaml`
    const globalCfg = this.profileHomeBase.replace(/\/profiles\/?$/, '') + '/config.yaml'
    const script = [
      `for f in ${shq(globalCfg)} ${profGlob}; do`,
      `  [ -f "$f" ] || continue`,
      `  h=$(grep -oE 'https?://[^:/]+:(17890|8080)' "$f" | sed -E 's#https?://##; s#:(17890|8080)##' | sort -u | tr '\n' ',')`,
      `  echo "F|$f|$h"`,
      `done`,
      `echo "GATEWAYS:$(pgrep -af '[h]ermes_cli.main --profile' 2>/dev/null | grep -oE -- '--profile [^ ]+' | awk '{print $2}' | sort -u | tr '\n' ' ')"`,
    ].join('\n')
    const out = await this.ssh(script)
    const files = out.split('\n').filter((l) => l.startsWith('F|')).map((l) => {
      const parts = l.split('|')
      const path = parts[1] || ''
      const hosts = (parts[2] || '').split(',').map((x) => x.trim()).filter(Boolean)
      const m = path.match(/profiles\/([^/]+)\/config\.yaml$/)
      const profile = m ? m[1] : (path.endsWith('/config.yaml') ? 'global' : path)
      return { profile, path, hosts, matches: hosts.length === 0 || hosts.every((x) => x === ip) }
    })
    const gwl = out.split('\n').find((l) => l.startsWith('GATEWAYS:'))
    const runningGateways = (gwl ? gwl.slice('GATEWAYS:'.length) : '').trim().split(/\s+/).filter(Boolean)
    return { ip, files, runningGateways }
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

  /** List EXTRA memory docs for the Memory tab — any memories/*.md beyond MEMORY.md + USER.md
   *  (which are shown inline). Hermes' built-in memory lives in memories/, not workspace/. Same
   *  rel-path shape as listDocs, so GET/PUT/DELETE /doc edit + delete them (MEMORY.md protected). */
  async listMemoryDocs(agentId: string): Promise<Array<{ path: string; bytes: number; protected: boolean }>> {
    const home = this.profileHome(agentId)
    const cmd = `cd ${shq(home)} 2>/dev/null && find -L memories -maxdepth 2 -type f -name '*.md' ! -name 'MEMORY.md' ! -name 'USER.md' -printf 'memories/%f\t%s\n' 2>/dev/null`
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
  private static readonly TAGS_FILE = '/root/.hermes/skill-tags.json'

  /** Validate a skill ref (relative dir path under the skills lib): N safe segments, no traversal. */
  private safeSkillRef(ref: unknown): string | null {
    if (typeof ref !== 'string' || !ref) return null
    const segs = ref.split('/')
    if (!segs.length || segs.some((x) => x === '..' || !/^[A-Za-z0-9._-]+$/.test(x))) return null
    return ref
  }

  /** List every skill in the Hermes library (any dir containing SKILL.md, at any depth) with its
   *  frontmatter name/description. ref = dir path relative to the lib; source=local for `custom`. */
  async listLibrarySkills(): Promise<Array<{ ref: string; name: string; dir: string; category: string; description: string; source: string; tags: string[] }>> {
    const py = [
      'import os, re, json',
      `BASE = ${JSON.stringify(HermesManagementService.SKILLS_DIR)}`,
      'out = []',
      'try:',
      `    _T = json.load(open(${JSON.stringify(HermesManagementService.TAGS_FILE)}))`,
      '    _T = _T if isinstance(_T, dict) else {}',
      'except Exception:',
      '    _T = {}',
      'for root, dirs, files in os.walk(BASE):',
      '    if "SKILL.md" not in files: continue',
      '    ref = os.path.relpath(root, BASE)',
      '    if ref == ".": continue',
      '    segs0 = ref.split(os.sep)',
      '    if any(x in ("template","templates","examples","example") for x in segs0): continue',
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
      '    rref = ref.replace(os.sep, "/")',
      '    _tg = _T.get(rref, [])',
      '    _tg = _tg if isinstance(_tg, list) else []',
      '    out.append({"ref": rref, "name": (nm.group(1).strip() if nm else segs[-1]), "dir": segs[-1], "category": segs[0], "description": desc[:280], "source": "local" if segs[0] == "custom" else "builtin", "tags": _tg})',
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

  /** Set (replace) the curated tag list for a skill; empty array clears it. Sidecar JSON. */
  async setSkillTags(ref: string, tags: string[]): Promise<void> {
    const r = this.safeSkillRef(ref)
    if (!r) throw new Error('invalid skill ref')
    const clean = Array.from(new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))).slice(0, 32)
    const py = [
      'import json',
      `F = ${JSON.stringify(HermesManagementService.TAGS_FILE)}`,
      `ref = ${JSON.stringify(r)}`,
      `tags = json.loads(${JSON.stringify(JSON.stringify(clean))})`,
      'try:',
      '    d = json.load(open(F))',
      '    d = d if isinstance(d, dict) else {}',
      'except Exception:',
      '    d = {}',
      'if tags: d[ref] = tags',
      'else: d.pop(ref, None)',
      'json.dump(d, open(F, "w"))',
      'print("ok")',
    ].join('\n')
    const b64 = Buffer.from(py, 'utf8').toString('base64')
    await this.ssh(`printf %s ${shq(b64)} | base64 -d | python3 -`)
  }

  /** Distinct tags across the library with usage counts (for filter badges). */
  async listSkillTags(): Promise<Array<{ tag: string; count: number }>> {
    const skills = await this.listLibrarySkills()
    const c = new Map<string, number>()
    for (const s of skills) for (const t of (s.tags || [])) c.set(t, (c.get(t) || 0) + 1)
    return Array.from(c, ([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  /** Search skills by metadata (name/description/ref/tags) + SKILL.md body (content grep). */
  async searchSkills(q: string): Promise<Array<{ ref: string; name: string; dir: string; category: string; description: string; source: string; tags: string[] }>> {
    const skills = await this.listLibrarySkills()
    const ql = String(q || '').toLowerCase().trim()
    if (!ql) return skills
    let contentRefs = new Set<string>()
    try {
      const prefix = HermesManagementService.SKILLS_DIR + '/'
      const grep = await this.ssh(`grep -rilF ${shq(ql)} ${shq(HermesManagementService.SKILLS_DIR)} --include=SKILL.md 2>/dev/null || true`)
      contentRefs = new Set(grep.split('\n').map((x) => x.trim()).filter(Boolean)
        .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length).replace(/\/SKILL\.md$/, '') : ''))
        .filter(Boolean))
    } catch { /* grep best-effort */ }
    return skills.filter((s) =>
      s.name.toLowerCase().includes(ql) ||
      s.description.toLowerCase().includes(ql) ||
      s.ref.toLowerCase().includes(ql) ||
      (s.tags || []).some((t) => t.includes(ql)) ||
      contentRefs.has(s.ref))
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
    const bonded = await this.bondedDocsFor(r.split('/').pop() || r)
    if (bonded.length) await this.updateAgentToc(agentId, bonded, [])
  }

  /** Unassign a skill from an agent (remove its dir from profile/skills/). */
  async unassignSkill(agentId: string, ref: string): Promise<void> {
    const r = this.safeSkillRef(ref)
    if (!r) throw new Error('invalid skill ref')
    await this.ssh(`rm -rf ${shq(`${this.profileHome(agentId)}/skills/${r}`)}`)
    const bonded = await this.bondedDocsFor(r.split('/').pop() || r)
    if (bonded.length) await this.updateAgentToc(agentId, [], bonded)
  }

  private static readonly LIBRARY_DIR = '/root/.hermes/library'

  private safeLibDocName(name: unknown): string | null {
    if (typeof name !== 'string' || !name) return null
    return /^[A-Za-z0-9._-]+\.md$/.test(name) ? name : null
  }

  /** List central library docs. skill = the bonded skill name for `skill-<name>.md`, else null. */
  async listLibraryDocs(): Promise<Array<{ name: string; title: string; skills: string[] }>> {
    const py = [
      'import os, re, json',
      `D = ${JSON.stringify(HermesManagementService.LIBRARY_DIR)}`,
      'out = []',
      'import json as _j',
      '_bf = os.path.join(D, "bonds.json")',
      'B = _j.load(open(_bf)) if os.path.exists(_bf) else {}',
      'for f in sorted(os.listdir(D)) if os.path.isdir(D) else []:',
      '    if not f.endswith(".md"): continue',
      '    title = f',
      '    try:',
      '        for ln in open(os.path.join(D, f), errors="replace"):',
      '            if ln.strip().startswith("# "): title = ln.strip()[2:].strip(); break',
      '    except Exception: pass',
      '    out.append({"name": f, "title": title, "skills": B.get(f, [])})',
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

  private async readBonds(): Promise<Record<string, string[]>> {
    const b64 = (await this.ssh(`base64 -w0 ${shq(`${HermesManagementService.LIBRARY_DIR}/bonds.json`)} 2>/dev/null || true`)).trim()
    if (!b64) return {}
    try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) } catch { return {} }
  }
  private async writeBonds(bonds: Record<string, string[]>): Promise<void> {
    await this.writeRemoteFile(`${HermesManagementService.LIBRARY_DIR}/bonds.json`, JSON.stringify(bonds, null, 2))
  }
  /** All library docs bonded to a skill name. */
  private async bondedDocsFor(skillName: string): Promise<string[]> {
    const bonds = await this.readBonds()
    return Object.keys(bonds).filter((doc) => (bonds[doc] || []).includes(skillName)).sort()
  }
  /** Agent ids that currently have a skill (by dir name) assigned in their profile. */
  private async agentsWithSkill(skillName: string): Promise<string[]> {
    const out = await this.ssh(`find ${shq(this.profileHomeBase)}/*/skills -maxdepth 3 -type d -name ${shq(skillName)} 2>/dev/null | sed -E 's#${this.profileHomeBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/.*#\\1#' | sort -u`).catch(() => '')
    return out.split('\n').map((x) => x.trim()).filter(Boolean)
  }
  /** Add/remove a skill from a doc's bond list, and reflect it into every agent that has the skill. */
  async bondDoc(name: string, skill: string, bonded: boolean): Promise<void> {
    const n = this.safeLibDocName(name)
    if (!n) throw new Error('invalid library doc name')
    if (!/^[A-Za-z0-9._-]+$/.test(skill)) throw new Error('invalid skill name')
    const bonds = await this.readBonds()
    const cur = new Set(bonds[n] || [])
    if (bonded) cur.add(skill); else cur.delete(skill)
    bonds[n] = Array.from(cur).sort()
    await this.writeBonds(bonds)
    // Only ADD retroactively (reflect a new bond onto agents that already have the skill).
    // Never retroactively remove: a doc can be pointed via another assigned skill or a manual pin,
    // so an unbond must not yank a pointer that other reasons still hold. Removal happens on unassign.
    if (bonded) { for (const agentId of await this.agentsWithSkill(skill)) await this.updateAgentToc(agentId, [n], []) }
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
  async listAgentLibraryDocs(agentId: string): Promise<Array<{ name: string; title: string; skills: string[]; pointed: boolean }>> {
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

/**
 * Tokens that must never appear as LIVE instructions in an agent's docs.
 * Each entry is [label, matcher].
 *
 * Why this exists: the 2026-07-28 audit found every agent citing `TOOLS.md`
 * ABSOLUTE RULE #1/#2/#4 and being told to read `IDENTITY.md` at session start
 * — NEITHER FILE EXISTS for any agent. They were folded into SOUL.md + AGENTS.md
 * by an earlier consolidation that never updated the references. Worse, the
 * rot is in the profile TEMPLATE, so `hermes profile create --clone` gives every
 * NEW agent the same dead pointers (turing + default proved it). Cleaning the
 * artifacts is not enough; the provisioning path has to refuse to reproduce it.
 * Same shape as the skills bug where Hermes auto-assigned all 778 bundled skills
 * at profile creation.
 */
private static readonly FORBIDDEN_DOC_TOKENS: Array<[string, RegExp]> = [
  ['TOOLS.md (consolidated into AGENTS.md)', /\bTOOLS\.md\b/],
  ['IDENTITY.md (consolidated into SOUL.md)', /\bIDENTITY\.md\b/],
  ['EXECUTION.md (consolidated into AGENTS.md)', /\bEXECUTION\.md\b/],
  // Flagged by Fable's audit; verified 2026-07-28 to have ZERO references anywhere
  // (no profile, no hermes_cli/agent source, no live doc), so this is pure
  // insurance against it being reintroduced by a future doc merge.
  ['BOOTSTRAP.md (does not exist)', /\bBOOTSTRAP\.md\b/],
  ['OpenClaw (decommissioned 2026-07)', /openclaw/i],
  ['ask-claude (skill deleted; use fleet_send)', /\bask[-_]claude\b/i],
  ['CT 196 (OpenClaw container, gone)', /\bCT[ -]?196\b/i],
  ['claude-relay (service decommissioned)', /\bclaude-relay\b/i],
  ['10.0.0.161:6277 (dead relay endpoint)', /10\.0\.0\.161:6277/],
]

/**
 * A line that TELLS the agent something no longer exists is correct and must not
 * trip the lint — e.g. "(There is no separate `TOOLS.md`; don't go looking.)" or
 * a one-line "ask-claude is decommissioned" tombstone. Without this the lint
 * fires on every well-maintained doc and gets ignored, which is worse than no
 * lint at all. (I hit this exact false positive twice by hand before writing it.)
 */
private static readonly DOC_NEGATION_CONTEXT =
  /(\bno separate\b|\bdoes ?n[o']t exist\b|\bno longer\b|decommission\w*|deprecat\w*|\bremoved\b|\bretired\b|\bdon'?t go looking\b|\bthere is no\b|\bgone\b|\bdo not use\b|\bdead\b|\breplaces? the old\b|\breplaced the old\b|\bformerly\b|\bused to be\b|\bthe old\b)/i

/** Core docs only — dated memory notes are a historical record, not instructions. */
private static readonly LINTED_DOCS = [
  'SOUL.md',
  'workspace/AGENTS.md',
  'workspace/HEARTBEAT.md',
  'workspace/MEMORY.md',
  'memories/USER.md',
  'memories/MEMORY.md',
]

/**
 * Scan a profile's core docs for dead references. Reports; does NOT rewrite —
 * a generator that silently edits an agent's persona is worse than one that
 * complains. Never throws: a broken lint must not block agent creation.
 */
async lintProfileDocs(agentId: string): Promise<Array<{ file: string; line: number; token: string; text: string }>> {
  const findings: Array<{ file: string; line: number; token: string; text: string }> = []
  const home = this.profileHome(agentId)
  for (const rel of HermesManagementService.LINTED_DOCS) {
    let body = ''
    try {
      body = await this.ssh(`cat ${shq(`${home}/${rel}`)} 2>/dev/null || true`)
    } catch {
      continue
    }
    if (!body.trim()) continue
    body.split('\n').forEach((text, i) => {
      if (HermesManagementService.DOC_NEGATION_CONTEXT.test(text)) return
      for (const [token, re] of HermesManagementService.FORBIDDEN_DOC_TOKENS) {
        if (re.test(text)) findings.push({ file: rel, line: i + 1, token, text: text.trim().slice(0, 180) })
      }
    })
  }
  return findings
}

  async applySpec(spec: HermesAgentSpec): Promise<{
    created: boolean
    home: string
    docIssues?: Array<{ file: string; line: number; token: string; text: string }>
  }> {
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

    // A brand-new profile arrives with the ENTIRE bundled skills library seeded
    // into it (778 skills / ~2,690 md files) — that is how turing and mari ended
    // up fully loaded when Travis only created them and named them. Worse,
    // `hermes update` re-seeds EVERY profile (hermes_cli/main.py:9364), so
    // without the opt-out marker each agent gets the whole library dumped on top
    // of its curated set at the next Hermes upgrade.
    //
    // The marker CANNOT be inherited: verified 2026-07-28 that
    // `hermes profile create --clone` does NOT copy dotfiles (only .env came
    // across from a marked source), and `--no-skills` is mutually exclusive with
    // `--clone` (profiles.py:861) so it cannot be passed in createArgs either.
    // So: write the marker and clear what seeding just installed. New agents
    // start with NO skills and get them assigned deliberately via the UI.
    if (created) {
      try {
        const before = Number(
          (await this.ssh(`find ${shq(`${home}/skills`)} -name SKILL.md 2>/dev/null | wc -l`)).trim() || '0',
        )
        await this.writeRemoteFile(
          `${home}/.no-bundled-skills`,
          'Opted out of bundled-skill seeding (written by AI-Lab at agent creation).\n' +
            'Without this, `hermes update` re-seeds the entire bundled library into this profile.\n' +
            'Assign skills deliberately via the AI-Lab Skills tab. Delete this file to opt back in.\n',
        )
        await this.ssh(`find ${shq(`${home}/skills`)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true`)
        const after = Number(
          (await this.ssh(`find ${shq(`${home}/skills`)} -name SKILL.md 2>/dev/null | wc -l`)).trim() || '0',
        )
        console.warn(
          `[hermes] ${id}: cleared ${before - after} auto-seeded bundled skill(s) and wrote ` +
            `.no-bundled-skills (was ${before}, now ${after}). Assign skills deliberately.`,
        )
      } catch (e) {
        console.warn(
          `[hermes] ${id}: FAILED to opt out of bundled skills (${(e as Error).message}) — ` +
            `this agent will receive the full bundled library on the next \`hermes update\`.`,
        )
      }
    }

    // Model → always via the ailab provider (the AI-Lab universal proxy).
    await this.hermes(['-p', id, 'config', 'set', 'model.provider', 'ailab'])
    await this.hermes(['-p', id, 'config', 'set', 'model.default', spec.model])

    // Max output tokens per turn (bounds runaway generations). Unset -> model default.
    await this.hermes(['-p', id, 'config', 'set', 'model.max_tokens', spec.maxTokens ? String(spec.maxTokens) : ''])

    // Native-vision routing keyed on the model's capability (supports_vision + describe backend).
    await this.applyVisionConfig(id, spec.model)
    // Context-compaction model (global Compaction support-model role).
    await this.applyCompactionConfig(id)

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

    // Composite memory stack (unified-MCP consensus recall + native-lane capture) — ALWAYS
    // reconciled, so every agent (freshly created or edited) converges on the standard memory
    // provider. `hermes profile create --clone` doesn't carry plugins and leaves provider empty,
    // so this is what actually makes composite the default. Shared OpenViking key is global .env.
    await this.ensureCompositeMemory(id)
    // Per-agent OpenViking memory key (isolation): provision/rotate the agent's key, wire it into
    // the profile .env (capture) and the recall key-map (recall). No-op if OV admin creds unset.
    await this.ensureOpenVikingKey(id)

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

    // Doc-lint: refuse to SILENTLY reproduce the dead-reference rot. Runs on
    // create AND edit, because the template is the source (a fresh --clone
    // carries it in) and hand-edits can reintroduce it. Reported, never
    // auto-rewritten, and never fatal — a lint that blocks agent creation, or
    // that quietly edits someone's persona, would be worse than the bug.
    let docIssues: Array<{ file: string; line: number; token: string; text: string }> = []
    try {
      docIssues = await this.lintProfileDocs(id)
      if (docIssues.length) {
        console.warn(
          `[hermes] DOC-LINT: ${docIssues.length} dead reference(s) in ${id}'s core docs — ` +
            `this agent will be told to use things that do not exist:`,
        )
        for (const f of docIssues) console.warn(`  ${id}/${f.file}:${f.line}  [${f.token}]  ${f.text}`)
        if (created) {
          console.warn(
            `[hermes] ${id} was JUST CREATED with these — the profile TEMPLATE still carries them. ` +
              `Fix the template or every new agent inherits the same dead pointers.`,
          )
        }
      }
    } catch (e) {
      console.warn(`[hermes] doc-lint failed for ${id} (non-fatal):`, e)
    }

    return { created, home, docIssues }
  }

  // ── Per-agent OpenViking memory key (isolation) ──────────────────────────────
  private ovAdmin(): { url: string; rootKey: string; account: string } {
    return {
      url: (process.env.OPENVIKING_ADMIN_URL || process.env.OPENVIKING_ENDPOINT || '').replace(/\/+$/, ''),
      rootKey: process.env.OPENVIKING_ROOT_API_KEY || '',
      account: process.env.OPENVIKING_ACCOUNT || 'hermes',
    }
  }
  private ovRecallMapPath(): string {
    return process.env.OPENVIKING_AGENT_KEYS_FILE || '/opt/mcp-unified-memory/ov_agent_keys.json'
  }

  /** Provision (or rotate) the agent's OWN OpenViking memory key so its memories are isolated:
   *  mints a user under the OpenViking `hermes` account, writes the key into the profile .env (the
   *  capture lane uses it -> writes to viking://user/<agent>) and registers it in the recall key-map
   *  the unified memory MCP hot-reloads (-> recall scoped to the same space). No-ops when the admin
   *  creds aren't configured (agent falls back to the shared key — still works, just not isolated).
   *  `main` and the memory-template profile stay on the account's own scope. */
  private async ensureOpenVikingKey(agentId: string): Promise<void> {
    const { url, rootKey, account } = this.ovAdmin()
    if (!url || !rootKey) return
    if (agentId === 'main' || agentId === HermesManagementService.MEMORY_TEMPLATE_PROFILE) return
    let key = ''
    try {
      const post = async (path: string, body?: unknown): Promise<string> => {
        const r = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'X-API-Key': rootKey, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(8000),
        })
        const j = (await r.json().catch(() => ({}))) as any
        return j?.result?.user_key || ''
      }
      key = await post(`/api/v1/admin/accounts/${account}/users`, { user_id: agentId, role: 'user' })
      if (!key) key = await post(`/api/v1/admin/accounts/${account}/users/${encodeURIComponent(agentId)}/key`)
    } catch (e) {
      console.warn(`[hermes-mgmt] OpenViking key provisioning skipped for ${agentId}: ${String((e as Error)?.message ?? e)}`)
      return
    }
    if (!key) return
    // 1) capture: upsert OPENVIKING_API_KEY in the profile .env (base64'd python write -> no quoting)
    const py = [
      'import sys, re, base64',
      'p = sys.argv[1]; line = "OPENVIKING_API_KEY=" + base64.b64decode(sys.argv[2]).decode()',
      'try: t = open(p).read()',
      'except FileNotFoundError: t = ""',
      "if re.search(r'^OPENVIKING_API_KEY=', t, flags=re.M): t = re.sub(r'^OPENVIKING_API_KEY=.*$', line, t, flags=re.M)",
      'else: t = (t if (not t or t.endswith(chr(10))) else t + chr(10)) + line + chr(10)',
      'open(p, "w").write(t)',
    ].join('\n')
    const pyB64 = Buffer.from(py, 'utf8').toString('base64')
    const keyB64 = Buffer.from(key, 'utf8').toString('base64')
    await this.ssh(`printf %s ${shq(pyB64)} | base64 -d | python3 - ${shq(`${this.profileHome(agentId)}/.env`)} ${shq(keyB64)}`)
    // 2) recall: register agent -> key in the map the unified memory MCP hot-reloads (15s TTL)
    this.registerOpenVikingRecallKey(agentId, key)
  }

  private registerOpenVikingRecallKey(agentId: string, key: string): void {
    const path = this.ovRecallMapPath()
    try {
      let map: Record<string, string> = {}
      if (existsSync(path)) { try { map = JSON.parse(readFileSync(path, 'utf8')) || {} } catch { map = {} } }
      map[agentId] = key
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(map))
    } catch (e) {
      console.warn(`[hermes-mgmt] failed to register OpenViking recall key for ${agentId}: ${String((e as Error)?.message ?? e)}`)
    }
  }

  /** Best-effort teardown of an agent's OpenViking user + recall-map entry on delete. */
  private async deleteOpenVikingKey(agentId: string): Promise<void> {
    const { url, rootKey, account } = this.ovAdmin()
    if (url && rootKey && agentId !== 'main') {
      try {
        await fetch(`${url}/api/v1/admin/accounts/${account}/users/${encodeURIComponent(agentId)}`, {
          method: 'DELETE', headers: { 'X-API-Key': rootKey }, signal: AbortSignal.timeout(8000),
        })
      } catch { /* best-effort */ }
    }
    try {
      const path = this.ovRecallMapPath()
      if (existsSync(path)) {
        const map = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
        if (agentId in map) { delete map[agentId]; writeFileSync(path, JSON.stringify(map)) }
      }
    } catch { /* best-effort */ }
  }

  /** Delete an agent profile (and its per-profile state). */
  async deleteAgent(agentId: string): Promise<void> {
    await this.hermes(['profile', 'delete', agentId, '--yes'])
    await this.deleteOpenVikingKey(agentId)
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
