/**
 * Agent-platform contracts (AI-Lab × Hermes integration) — see
 * /claude/plans/ailab-hermes-integration.md.
 *
 * Three things the control plane + UI both need typed:
 *  - ExternalModelSource: a "model endpoint" — API model provider registered behind the
 *    ONE AI-Lab universal proxy. These live in a DEDICATED store (the model-API section of
 *    the credential vault, separate from general credentials so the backend never has to
 *    parse them out) and are the SOURCE OF TRUTH for the proxy: endpoint + key present ⇒
 *    all its models are auto-discovered and added to the catalog (tagged). Primary UI is
 *    Settings › Models; also surfaced by the credentials MCP.
 *  - CatalogModel: a `/v1/models` entry with its `[TAG]` so duplicate models across
 *    providers (OpenRouter vs direct vs local) stay distinct + route deterministically.
 *  - HermesAgentSpec: the agent definition mirrored between the AI-Lab registry and a
 *    Hermes profile (`hermes -p <agentId>`). This is what the builder UI edits and the
 *    Hermes management adapter writes.
 *  - HermesStreamEvent: the normalized ACP event union the acp-bridge emits and the SSE
 *    route fans out — what the chat surface renders.
 *
 * STATUS: v0.1 DRAFT — proposed by claude1 2026-07-03, amended by fable 2026-07-03
 * (stream-event union added, verified against the deployed acp-bridge). Shapes fit the
 * existing proxy.js seams (external-services list + aliasOverride catalog rename) and
 * the captured ACP contract (/claude/plans/hermes-artifacts/).
 */
import { z } from 'zod'

// ─── Model-source tags (catalog disambiguation) ──────────────────────────────
// [AI-LAB] local vLLM/llama.cpp · [MAX] Claude Max sub · [AN] Anthropic API ·
// [DS] DeepSeek API · [OC] OpenRouter · …extensible per source.
export const KNOWN_SOURCE_TAGS = ['AI-LAB', 'MAX', 'AN', 'DS', 'OC'] as const
export const sourceTagSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,9}$/, 'tag: 2-10 uppercase chars, e.g. AI-LAB / MAX / OC')
export type SourceTag = z.infer<typeof sourceTagSchema>

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug: lowercase a-z0-9-_')

// ─── External model source ───────────────────────────────────────────────────
/**
 * An API model provider fronted by the AI-Lab universal proxy. Its models appear in
 * the unified `/v1/models` catalog tag-prefixed with `tag`; the proxy strips the tag
 * and forwards to `baseUrl` (injecting the vaulted key). This is how "all my API
 * models through one proxy w/ metrics" AND "AI-Lab manages Hermes model settings"
 * become one feature — Hermes only ever points at the proxy.
 */
export const externalModelSourceSchema = z.object({
  id: slugSchema,
  /** `[TAG]` prefixed onto this source's model ids in the unified catalog. */
  tag: sourceTagSchema,
  displayName: z.string().min(1),
  /** upstream API dialect the proxy speaks. */
  transport: z.enum(['openai_chat', 'anthropic']),
  /** upstream base URL, e.g. https://api.deepseek.com/v1 or an OAuth-backed proxy base. */
  baseUrl: z.string().url(),
  /**
   * API key for this endpoint. Stored in the dedicated model-endpoints vault section
   * (not the general credential vault), so it's a first-class field here rather than a
   * parsed-out reference. Optional (some upstreams — incl. LAN-open proxies — need none).
   */
  apiKey: z.string().optional(),
  /** Optional alternative: reference a general-vault credential id instead of an inline key. */
  apiKeyRef: z.string().optional(),
  /** Optional SEPARATE admin/usage key for providers whose balance/usage reporting needs a
   *  different credential than the chat key (e.g. Anthropic's Admin API key `sk-ant-admin…`
   *  for org cost/usage reports). Masked like apiKey; used only for the credit/usage tracker. */
  adminApiKey: z.string().optional(),
  /** 'auto' = discover via `{baseUrl}/models`; 'list' = use `models` verbatim. */
  discovery: z.enum(['auto', 'list']).default('auto'),
  /** explicit model ids (discovery:'list') or an allow-filter over discovered ids (discovery:'auto'). */
  models: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
})
export type ExternalModelSource = z.infer<typeof externalModelSourceSchema>

// ─── Unified catalog entry ───────────────────────────────────────────────────
/** One entry in the proxy's aggregated `/v1/models`. `id` is the tag-prefixed canonical
 *  the agent/client uses; the proxy maps (tag→source, upstreamModel) to route. */
export const catalogModelSchema = z.object({
  /** canonical, tag-prefixed: e.g. "[MAX] claude-opus-4-8". */
  id: z.string().min(1),
  tag: sourceTagSchema,
  /** source that serves it: an ExternalModelSource.id, or 'ai-lab' for local. */
  sourceId: z.string().min(1),
  /** the real upstream model id the proxy forwards (tag stripped). */
  upstreamModel: z.string().min(1),
  displayName: z.string().min(1),
  kind: z.enum(['local', 'external']),
})
export type CatalogModel = z.infer<typeof catalogModelSchema>

// ─── Hermes agent spec ───────────────────────────────────────────────────────
/** Per-agent persona docs (map to Hermes SOUL.md / personality / context files). */
export const hermesPersonaSchema = z.object({
  /** SOUL.md body — the deep persona/operating rules. */
  soul: z.string().optional(),
  /** a Hermes personality preset id (helpful/technical/…) OR an inline one-liner. */
  personality: z.string().optional(),
  /** extra named context docs written into the profile. */
  contextFiles: z.record(z.string(), z.string()).optional(),
})
export type HermesPersona = z.infer<typeof hermesPersonaSchema>

/**
 * The agent definition, mirrored between the AI-Lab registry and a Hermes profile
 * (`agentId` == `hermes -p <agentId>`). Builder UI edits this; the management adapter
 * applies it to CT158 via `hermes` CLIs. `model` is a tagged CatalogModel.id.
 */
export const hermesAgentSpecSchema = z.object({
  agentId: slugSchema,
  displayName: z.string().min(1),
  /** One-liner shown in lists + mapped to `hermes profile create --description`. */
  description: z.string().optional(),
  /** catalog model id (tag-prefixed) this agent runs on — routed through the proxy. */
  model: z.string().min(1),
  /** Max output tokens per turn -> Hermes `model.max_tokens`. Bounds a runaway generation;
   *  omit for the model default. */
  maxTokens: z.number().int().positive().max(1000000).optional(),
  /** Ordered fallback model chain — catalog ids tried, in order, when the primary model fails
   *  with rate-limit/overload/connection errors (Hermes-native failover via `hermes fallback`,
   *  NOT quality switching). Each routes through the `ailab` proxy, same as `model`; persisted to
   *  Hermes's `fallback_providers`. Empty = no fallback. */
  fallback: z.array(z.string()).default([]),
  persona: hermesPersonaSchema.optional(),
  /** enabled Hermes toolsets. */
  toolsets: z.array(z.string()).default([]),
  /** ACP permission mode: 'default' asks before edits; 'accept_edits' auto-allows workspace/tmp. */
  mode: z.enum(['default', 'accept_edits']).default('default'),
  /** Sub-agent delegation. The parent's native `delegation` toolset spawns child agents of the
   *  SAME profile (spawning distinct sub-agent PROFILES is shelved — not natively supported
   *  without ACP-transport plumbing). Maps to Hermes-native `delegation.*`. The key lever is
   *  `model`: run sub-agents on a different (cheaper/faster) catalog model via the `ailab` proxy
   *  while the parent keeps its own; empty = inherit the parent's model. */
  subAgents: z
    .object({
      /** sub-agent model override — a catalog id (routed via the ailab proxy); empty = inherit parent. */
      model: z.string().optional(),
      /** sub-agent reasoning effort; omitted = inherit parent. */
      reasoningEffort: z.enum(['xhigh', 'high', 'medium', 'low', 'minimal', 'none']).optional(),
      /** max parallel children per batch (delegation.max_concurrent_children). 0/omitted = Hermes default. */
      maxConcurrent: z.number().int().nonnegative().optional(),
      /** spawn depth: 1 = flat, 2 = orchestrator→leaf, 3+ deeper (delegation.max_spawn_depth). */
      maxSpawnDepth: z.number().int().nonnegative().optional(),
      /** auto-approve dangerous commands in sub-agent threads (delegation.subagent_auto_approve; default deny). */
      autoApproveDangerous: z.boolean().optional(),
    })
    .optional(),
  /** Optional per-agent voice.
   *
   *  provider 'ailab' = the local AI-Lab TTS pool behind the universal proxy. This is
   *  UI-SIDE ONLY: the chat resolves it at playback time and it is never written into
   *  Hermes config, because TTS inside Hermes is deliberately disabled (voice lives at
   *  the UI level, where we are not bound by Hermes' constraints). Only 'ailab' supports
   *  voices, RVC and presets.
   *
   *  Any other provider is a native Hermes TTS provider (elevenlabs, edge, openai,
   *  minimax, gemini, mistral), applied via `config set tts.*` + the `tts` toolset. Its
   *  API key is configured ONCE under Provider Services (→ Hermes .env), never per
   *  agent — the "one entry drives both" split. */
  tts: z
    .object({
      provider: z.string().min(1),
      voiceId: z.string().optional(),
      modelId: z.string().optional(),
      /** ailab only: run the reply through RVC after synthesis. Still subject to the
       *  GLOBAL allow gate (Support Models › RVC) — per-agent on cannot override a
       *  global off, so one switch can always stop all voice conversion. */
      rvcEnabled: z.boolean().optional(),
      rvcModel: z.string().optional(),
      /** ailab only: a saved voice preset (voice + model + sampling params). When set it
       *  SUPERSEDES voiceId/modelId — a preset is a complete recipe, and silently mixing
       *  half a preset with a stray voice id would be unexplainable from the UI. */
      preset: z.string().optional(),
    })
    .optional(),
  enabled: z.boolean().default(true),
})
export type HermesAgentSpec = z.infer<typeof hermesAgentSpecSchema>

// ─── Provider Services (keyed non-model provider registry: TTS etc.) ─────────
/**
 * Per-provider descriptor for the Provider Services registry. `envVar` = the Hermes .env key
 * the API key is written to (so agents using the provider pick it up); `kind` groups it. This
 * is the extensible map — add one entry per provider; keyed by the provider slug used in both
 * ProviderService.provider and HermesAgentSpec.tts.provider. (Same pattern as TRANSPORT_CAPS.)
 */
export const PROVIDER_SERVICE_CAPS: Record<string, { label: string; envVar: string; kind: 'tts' | 'other' }> = {
  elevenlabs: { label: 'ElevenLabs', envVar: 'ELEVENLABS_API_KEY', kind: 'tts' },
}

/**
 * A configured external provider service (e.g. ElevenLabs TTS). One entry holds the account API
 * key ONCE; the backend pushes it into Hermes .env (per PROVIDER_SERVICE_CAPS) and it's then
 * available for AI-Lab's own use — the "one entry drives both" split. Distinct from
 * ExternalModelSource (chat/completions models behind the proxy); these are non-model creds.
 */
export const providerServiceSchema = z.object({
  id: slugSchema,
  /** provider slug — a key in PROVIDER_SERVICE_CAPS (e.g. 'elevenlabs'). */
  provider: z.string().min(1),
  displayName: z.string().min(1),
  /** API key. Masked end-to-end like model sources: GET returns `***<last4>` + hasKey; a blank
   *  or still-masked value on save preserves the stored key. */
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
})
export type ProviderService = z.infer<typeof providerServiceSchema>
/** GET shape: contract fields with the key masked + a hasKey flag. */
export type ProviderServiceWire = ProviderService & { hasKey?: boolean }

// ─── Normalized ACP stream events ────────────────────────────────────────────
/**
 * The event union emitted by the acp-bridge (CT158 /opt/acp-bridge/acp-bridge.py)
 * and fanned out verbatim by `GET /api/hermes/agents/:id/stream` (SSE `data:` lines).
 * Drafted by fable 2026-07-03 against the DEPLOYED bridge — every variant verified
 * from the emit() call sites, not the header comment (which says `usage`; the code
 * actually emits camelCase `usageUpdate` etc. via its ACP-variant fallback).
 *
 * `raw` fields carry the model-dumped ACP payload untouched — typed as unknown here;
 * consumers narrow what they need and stay forward-compatible with Hermes upgrades.
 */
export const hermesSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** ACP: { hint } for commands that take an argument. */
  input: z.object({ hint: z.string().optional() }).passthrough().optional(),
})
export type HermesSlashCommand = z.infer<typeof hermesSlashCommandSchema>

export const hermesStreamEventSchema = z.discriminatedUnion('t', [
  /** First event of a session (and re-sent to each SSE attacher). */
  z.object({
    t: z.literal('ready'),
    session_id: z.string().nullish(),
    /** ACP available_models: [{ model_id, name, description }]. */
    models: z.array(z.object({ model_id: z.string(), name: z.string().optional(), description: z.string().nullish() }).passthrough()).nullish(),
    current_model: z.string().nullish(),
    /** ACP available_modes (default / accept_edits …). */
    modes: z.array(z.unknown()).nullish(),
  }),
  /** User turn — emitted into CONVERSATION HISTORY by the prompt route (not by
   *  the live bridge): lets a /history replay rebuild the user's own bubbles. */
  z.object({ t: z.literal('user'), text: z.string() }),
  // Resumed-session replay (bridge session persistence, claude1 57cce93):
  // the bridge replays the prior transcript BEFORE `ready` on a resumed
  // session — complete turns, not streamed chunks. Absent on fresh sessions.
  z.object({ t: z.literal('history'), role: z.enum(['user', 'assistant']), text: z.string() }),
  z.object({ t: z.literal('history_thought'), text: z.string() }),
  z.object({ t: z.literal('history_tool'), id: z.string().nullish(), title: z.string().nullish(), kind: z.string().nullish(), raw: z.unknown() }),
  /** Assistant text chunk — append to the current bubble. */
  z.object({ t: z.literal('message'), text: z.string() }),
  /** Reasoning chunk — append to the collapsible thought block. */
  z.object({ t: z.literal('thought'), text: z.string() }),
  z.object({ t: z.literal('tool_start'), id: z.string().nullish(), title: z.string().nullish(), kind: z.string().nullish(), raw: z.unknown() }),
  z.object({ t: z.literal('tool_progress'), id: z.string().nullish(), status: z.string().nullish(), raw: z.unknown() }),
  /** Slash-command catalog for this session. */
  z.object({ t: z.literal('commands'), commands: z.array(hermesSlashCommandSchema) }),
  // ACP variants passed through with their model-dumped payload (camelCase = the
  // bridge's `name[0].lower()+name[1:]` fallback over known ACP update classes):
  z.object({ t: z.literal('usageUpdate'), raw: z.unknown() }),
  z.object({ t: z.literal('agentPlanUpdate'), raw: z.unknown() }),
  z.object({ t: z.literal('plan'), raw: z.unknown() }),
  z.object({ t: z.literal('currentModeUpdate'), raw: z.unknown() }),
  z.object({ t: z.literal('sessionInfoUpdate'), raw: z.unknown() }),
  /** Catch-all for ACP update classes the bridge doesn't know; kind = class name. */
  z.object({ t: z.literal('update'), kind: z.string(), raw: z.unknown() }),
  /** Backend signal (NOT a transcript message): the agent's view_screen tool
   *  fired — the UI runs a panel-hidden capture and POSTs it back with this id. */
  z.object({ t: z.literal('capture_request'), requestId: z.string() }),
  /** Bridge auto-approved a permission request (mode-driven). */
  z.object({ t: z.literal('permission_auto_allow'), option_id: z.string().nullish() }),
  z.object({ t: z.literal('status'), status: z.enum(['idle', 'busy']) }),
  z.object({ t: z.literal('turn_done'), stop_reason: z.string().nullish() }),
  /** Hermes acked a /steer into the RUNNING turn. The bridge diverts the ack here so it is
   *  not appended into the streaming assistant bubble. MUST be listed: an unregistered
   *  variant is dropped by safeParse and reported as a bug — which is exactly what I did
   *  when I added steer without touching this union. */
  z.object({ t: z.literal('steer_ack'), text: z.string() }),
  z.object({ t: z.literal('error'), where: z.string().optional(), message: z.string(), tb: z.string().optional() }),
  /** HARD failure in the bridge's read loop — the turn is over and nothing else is coming.
   *  Was missing from this union until 2026-07-28, so `safeParse` dropped it and a dead
   *  bridge rendered as absolutely nothing in chat (silent hang). MUST stay renderable. */
  z.object({ t: z.literal('fatal'), reason: z.string().optional(), recoverable: z.boolean().optional(), message: z.string().optional(), tb: z.string().optional() }),
  /** Emitted after ACP session/set_model succeeds. */
  z.object({ t: z.literal('model_set'), model_id: z.string().optional() }),
])
export type HermesStreamEvent = z.infer<typeof hermesStreamEventSchema>
