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
  /** sub-agent governance (req 11 equivalent, now enforced by Hermes). */
  subAgents: z
    .object({
      maxConcurrent: z.number().int().nonnegative().default(0),
      allowedKinds: z.array(z.string()).default([]),
    })
    .optional(),
  /** Optional per-agent TTS voice. `provider` is a native Hermes TTS provider (elevenlabs,
   *  edge, openai, minimax, gemini, mistral); voiceId/modelId are provider-specific (ElevenLabs
   *  uses tts.<provider>.voice_id / .model_id). Applied via `config set tts.*` + enabling the
   *  `tts` toolset. The provider's API key is configured ONCE under Provider Services (→ Hermes
   *  .env), never per agent — the "one entry drives both" split. */
  tts: z
    .object({
      provider: z.string().min(1),
      voiceId: z.string().optional(),
      modelId: z.string().optional(),
    })
    .optional(),
  enabled: z.boolean().default(true),
})
export type HermesAgentSpec = z.infer<typeof hermesAgentSpecSchema>

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
  /** Bridge auto-approved a permission request (mode-driven). */
  z.object({ t: z.literal('permission_auto_allow'), option_id: z.string().nullish() }),
  z.object({ t: z.literal('turn_done'), stop_reason: z.string().nullish() }),
  z.object({ t: z.literal('error'), where: z.string().optional(), message: z.string(), tb: z.string().optional() }),
])
export type HermesStreamEvent = z.infer<typeof hermesStreamEventSchema>
