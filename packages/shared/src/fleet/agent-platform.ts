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
 *
 * STATUS: v0.1 DRAFT — proposed by claude1 2026-07-03, pending fable's architecture
 * review before freezing. Shapes fit the existing proxy.js seams (external-services
 * list + aliasOverride catalog rename) and the captured ACP contract
 * (/claude/plans/hermes-artifacts/).
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
  /** catalog model id (tag-prefixed) this agent runs on — routed through the proxy. */
  model: z.string().min(1),
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
  enabled: z.boolean().default(true),
})
export type HermesAgentSpec = z.infer<typeof hermesAgentSpecSchema>
