/**
 * ViewSnapshot — the serializable "what is the user looking at right now" the
 * agent gets so it can resolve context-dependent asks ("do these settings look
 * right?") without the user spelling out the tab. Cross-vertical contract
 * (claude1's ViewContext vertical): renderer captures it → rides the startTask
 * payload → AgentService injects a cheap summary into the turn → an optional
 * reverse-RPC (get_view_details) pulls the full state on demand.
 *
 * Design rules these types encode (doc §Fable's review R2, ratified):
 * - R2.1  Captured at SEND TIME in the renderer and attached to the message —
 *         never backend-fetched at run time (user may switch tabs mid-run;
 *         multiple clients can be connected — the sender's view wins).
 * - R2.2  get_view_details is an explicit backend→renderer reverse-RPC with a
 *         correlationId, a timeout, and DEFINED answers for no-client /
 *         many-clients / panel-closed so the tool degrades to text, never hangs.
 * - R2.3  `hash` is a stable digest of the semantic fields so the backend can
 *         skip re-injecting an unchanged view (inject a one-liner instead).
 *         Describe adapters MUST emit stable output (no timestamps/counters in
 *         summary/details) or the hash never matches.
 * - R2.4  Panels without a describe adapter degrade to {panelKind, tabTitle};
 *         a missing adapter must never block a turn.
 */
import { z } from 'zod'

/** Canonical panel kinds an adapter can describe. Extend as panels gain adapters. */
export const panelKindSchema = z.enum([
  'chat',
  'terminal',
  'fileEditor',
  'filesystem',
  'monitor',
  'llmLauncher',
  'imagegen',
  'tts',
  'settings',
  'fleetFeed',
  'unknown',
])
export type PanelKind = z.infer<typeof panelKindSchema>

export const viewSnapshotSchema = z.object({
  /** ISO-8601 capture time (renderer clock). NOT part of the dedup hash. */
  capturedAt: z.string(),
  /** Which client produced this view (R2.1 — resolves whose-view-wins + reverse-RPC target). */
  clientId: z.string().optional(),
  /** The focused panel's kind. */
  activePanelKind: panelKindSchema,
  /** Focused panel id + active tab within it (from LayoutStore.tree.focusedPanelId / activeTabId). */
  focusedPanelId: z.string().optional(),
  activeTabId: z.string().optional(),
  activeTabTitle: z.string().optional(),
  /**
   * One-line, agent-readable description from the panelKind describe adapter,
   * e.g. "LLM Launcher: configuring vLLM to launch Qwen3-32B-AWQ on px-gpu
   * GPUs 0-3, TP=4, 256K ctx". Adapter-produced, STABLE (no volatile fields).
   * Falls back to "<panelKind> / <tabTitle>" when no adapter exists (R2.4).
   */
  summary: z.string(),
  /**
   * Structured panel state (form values, current selection, etc.) for the
   * agent to pull on demand via get_view_details. Adapter-produced + stable.
   * Omitted from the always-injected summary to keep turns cheap.
   */
  details: z.record(z.string(), z.unknown()).optional(),
  /** Stable digest over {activePanelKind, summary, details} for R2.3 dedup. */
  hash: z.string(),
})
export type ViewSnapshot = z.infer<typeof viewSnapshotSchema>

// ─── get_view_details reverse-RPC (R2.2 — backend → renderer) ────────────────

export const viewDetailsRequestSchema = z.object({
  /** Correlates the async renderer response back to the awaiting tool call. */
  correlationId: z.string(),
  /** Prefer this client (the one that sent the current turn's message). */
  forClientId: z.string().optional(),
  /** Optionally target a specific panel; default = the currently focused one. */
  requestedPanelId: z.string().optional(),
  /** Backend gives up after this and returns a degraded 'timeout' answer. */
  timeoutMs: z.number().int().positive().default(4000),
})
export type ViewDetailsRequest = z.infer<typeof viewDetailsRequestSchema>

/** Defined failure modes so the tool degrades into text the model can act on. */
export const viewDetailsErrorSchema = z.enum([
  'no_client', // no browser connected
  'panel_closed', // the panel/tab is no longer open
  'timeout', // client didn't answer in time
  'unknown',
])
export type ViewDetailsError = z.infer<typeof viewDetailsErrorSchema>

export const viewDetailsResponseSchema = z.object({
  correlationId: z.string(),
  ok: z.boolean(),
  /** Present when ok — the fresh snapshot (with details) from the live panel. */
  snapshot: viewSnapshotSchema.optional(),
  /** Present when !ok. */
  error: viewDetailsErrorSchema.optional(),
  /** Which client answered (diagnostics + many-clients disambiguation). */
  answeredByClientId: z.string().optional(),
})
export type ViewDetailsResponse = z.infer<typeof viewDetailsResponseSchema>
