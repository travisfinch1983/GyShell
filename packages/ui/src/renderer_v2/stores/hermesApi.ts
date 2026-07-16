/**
 * Hermes control-plane adapter — AI-Lab × Hermes integration (fable workstream 3).
 *
 * Thin wire adapter over the backend's /api/hermes/* + catalog routes (see
 * packages/backend/src/services/Hermes/hermesHttp.ts and
 * packages/shared/src/fleet/agent-platform.ts). Same pattern as
 * instanceManager.ts: all endpoint knowledge lives HERE; the store + UI consume
 * this interface only.
 *
 * Catalog: `GET /api/proxy/llm/catalog` (CatalogModel[], claude1 landing it) with a
 * fallback that maps the OpenAI-pure `/llm/v1/models` list to local entries, so the
 * builder's model picker works either way.
 */
import type { CatalogModel, HermesAgentSpec } from '@gyshell/shared'

export interface ModelCapabilities { text?: boolean; vision?: boolean; audio?: boolean }
/** Catalog entry + the per-model capability enrichment (rides on /llm/v1/models). */
export type CatalogModelWithCaps = CatalogModel & { capabilities?: ModelCapabilities }

function bridge(): any {
  return (window as any).gyshell?.cluster
}

export interface HermesApplyResult {
  ok: boolean
  created?: boolean
  error?: string
}

/** One global support-model role assignment (Support Models tab). */
export interface SupportModelRole { provider: string; model: string; description?: string; recommendation?: string }
export type SupportModels = Record<string, SupportModelRole | undefined>
/** A Hermes auxiliary role from the self-populating catalog (GET /api/hermes/aux-tasks). */
export interface AuxTask { key: string; label: string; description: string; recommendation: string; shared: boolean }

export interface HermesPromptResult {
  ok: boolean
  reply?: string
  stopReason?: string
  error?: string
}

export const hermesApi = {
  /** GET /api/hermes/agents → profile ids + per-agent capabilities (model, visionCapable). */
  async listAgents(): Promise<{ agents: string[]; capabilities: Record<string, { model?: string; visionCapable?: boolean }> }> {
    const r = await bridge().request('GET', '/api/hermes/agents')
    return { agents: (r?.agents ?? []) as string[], capabilities: (r?.capabilities ?? {}) as Record<string, { model?: string; visionCapable?: boolean }> }
  },

  /**
   * GET /api/hermes/agents/:id → { spec, source } (d747af5). source is
   * 'ailab-spec' (stored AI-Lab spec) or 'hermes-live' (reconstructed from
   * the live host profile — the formerly spec-less OpenClaw agents no longer
   * 404; saving adopts them into an AI-Lab spec, clobber-safe). SOUL.md is
   * NOT part of this — getSoul stays the persona source of truth.
   */
  async getSpec(id: string): Promise<{ spec: HermesAgentSpec | null; source?: 'ailab-spec' | 'hermes-live' }> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}`)
      return {
        spec: (r?.spec ?? r?.agent ?? null) as HermesAgentSpec | null,
        source: r?.source === 'hermes-live' || r?.source === 'ailab-spec' ? r.source : undefined,
      }
    } catch {
      return { spec: null }
    }
  },

  /** POST /api/hermes/agents — create/update from a spec (idempotent apply). */
  async apply(spec: HermesAgentSpec): Promise<HermesApplyResult> {
    try {
      const r = await bridge().request('POST', '/api/hermes/agents', spec)
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: r?.ok !== false, created: r?.created }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/agents/:id/soul — the agent's LIVE SOUL.md off the Hermes
   *  host ('' if none). The stored spec's persona.soul is empty for every
   *  agent (the real file was never read back), so the editor overrides its
   *  seed with this. Returns null on failure so callers keep their seed. */
  async getSoul(id: string): Promise<string | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/soul`)
      if (r?.error) return null
      return typeof r?.soul === 'string' ? r.soul : null
    } catch {
      return null
    }
  },

  /** PUT /api/hermes/agents/:id/soul — writes the real SOUL.md (works even for
   *  agents that have no stored spec). */
  async putSoul(id: string, soul: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('PUT', `/api/hermes/agents/${encodeURIComponent(id)}/soul`, { soul })
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/agents/:id/docs — the agent's config .md operating docs
   *  (path-validated server-side: .md only, no traversal, skills excluded).
   *  `protected` = standard docs (SOUL/IDENTITY/TOOLS/…) that must not be
   *  deleted (4e80db3). Null on failure so the section can show an error
   *  instead of an empty list. */
  async listDocs(id: string): Promise<Array<{ path: string; bytes: number; protected?: boolean }> | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/docs`)
      if (r?.error || !Array.isArray(r?.docs)) return null
      return r.docs as Array<{ path: string; bytes: number; protected?: boolean }>
    } catch {
      return null
    }
  },

  /** GET /api/hermes/agents/:id/memory-docs — the agent's daily-log memory
   *  files (workspace/memory/*.md; MEMORY.md itself is NOT in this list —
   *  it's the Memory tab's primary editor). Same read/write/delete as any
   *  doc via /doc?path=. */
  async listMemoryDocs(id: string): Promise<Array<{ path: string; bytes: number; protected?: boolean }> | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/memory-docs`)
      if (r?.error || !Array.isArray(r?.docs)) return null
      return r.docs as Array<{ path: string; bytes: number; protected?: boolean }>
    } catch {
      return null
    }
  },

  /** DELETE /api/hermes/agents/:id/doc?path= — removes a NON-protected doc
   *  (backend 400s on default docs / invalid paths). */
  async deleteDoc(id: string, path: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('DELETE', `/api/hermes/agents/${encodeURIComponent(id)}/doc?path=${encodeURIComponent(path)}`)
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/agents/:id/doc?path= — one doc's live content. Null on
   *  failure — callers must NOT open an editor on '' (a later save would wipe
   *  the real file; same reasoning as getSoul). */
  async getDoc(id: string, path: string): Promise<string | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/doc?path=${encodeURIComponent(path)}`)
      if (r?.error) return null
      return typeof r?.content === 'string' ? r.content : null
    } catch {
      return null
    }
  },

  /** POST /api/hermes/agents/:id/add-doc { templatePath } — copies a default
   *  template into the agent's workspace, returns the new doc's path (aabf3ba). */
  async addDoc(id: string, templatePath: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const r = await bridge().request('POST', `/api/hermes/agents/${encodeURIComponent(id)}/add-doc`, { templatePath })
      if (r?.error || r?.ok === false) return { ok: false, error: String(r?.error ?? 'add failed') }
      return { ok: true, path: r?.path }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** PUT /api/hermes/agents/:id/doc { path, content } — writes the real file. */
  async putDoc(id: string, path: string, content: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('PUT', `/api/hermes/agents/${encodeURIComponent(id)}/doc`, { path, content })
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/agents/:id/tools — the agent's gateway tool scoping
   *  (047cc8b). scoped:false = the agent points at the FULL gateway. Null on
   *  failure so the picker can render an error instead of a fake empty scope. */
  async getTools(id: string): Promise<{ selected: string[]; scoped: boolean; endpoint: string | null } | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/tools`)
      if (r?.error || !Array.isArray(r?.selected)) return null
      return { selected: r.selected as string[], scoped: !!r.scoped, endpoint: (r.endpoint ?? null) as string | null }
    } catch {
      return null
    }
  },

  /** PUT /api/hermes/agents/:id/tools { selected } — upserts the agent-<id>
   *  gateway group and repoints the agent's MCP server at it (idempotent;
   *  synchronous, ~1-3s — no client timeout, the picker shows a Syncing state). */
  async putTools(id: string, selected: string[]): Promise<{ ok: boolean; endpoint?: string; toolCount?: number; error?: string }> {
    try {
      const r = await bridge().request('PUT', `/api/hermes/agents/${encodeURIComponent(id)}/tools`, { selected })
      if (r?.error || r?.ok === false) return { ok: false, error: String(r?.error ?? 'scope failed') }
      return { ok: true, endpoint: r?.endpoint, toolCount: r?.toolCount }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** DELETE /api/hermes/agents/:id/tools — reverts to the full gateway AND
   *  deletes the agent-<id> group (no orphaned/stale external endpoints). */
  async deleteTools(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('DELETE', `/api/hermes/agents/${encodeURIComponent(id)}/tools`)
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/agents/:id/skills — the full library with per-agent
   *  `assigned` flags (9b44da7). Builtins are seeded into every agent and
   *  re-seed on update (unassign isn't durable); local/custom skills are the
   *  durably toggleable ones. */
  async listAgentSkills(id: string): Promise<Array<{ ref: string; name: string; category: string; description: string; source: 'builtin' | 'local'; assigned: boolean }> | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/skills`)
      if (r?.error || !Array.isArray(r?.skills)) return null
      return r.skills
    } catch {
      return null
    }
  },

  /** POST /api/hermes/agents/:id/skills { ref } — assign (copies the skill in). */
  async assignSkill(id: string, ref: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('POST', `/api/hermes/agents/${encodeURIComponent(id)}/skills`, { ref })
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** DELETE /api/hermes/agents/:id/skills?ref= — unassign. */
  async unassignSkill(id: string, ref: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('DELETE', `/api/hermes/agents/${encodeURIComponent(id)}/skills?ref=${encodeURIComponent(ref)}`)
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/library — the CENTRAL library docs. `skills` = the skill
   *  NAMES this doc is bonded to, 0..N (2597fb2 — explicit many-to-many
   *  bonds.json; empty = general reference doc). Central = shared by all
   *  agents; agents carry TOOLS.md pointers only. */
  async listLibrary(): Promise<Array<{ name: string; title: string; skills: string[] }> | null> {
    try {
      const r = await bridge().request('GET', '/api/hermes/library')
      if (r?.error || !Array.isArray(r?.docs)) return null
      return r.docs
    } catch {
      return null
    }
  },

  /** POST /api/hermes/library/bond { doc, skill, bonded } — edit a doc↔skill
   *  bond (bonding retro-points the doc onto agents that already carry the
   *  skill). */
  async bond(doc: string, skill: string, bonded: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('POST', '/api/hermes/library/bond', { doc, skill, bonded })
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/library/doc?name= — one central doc's content. */
  async getLibraryDoc(name: string): Promise<string | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/library/doc?name=${encodeURIComponent(name)}`)
      if (r?.error) return null
      return typeof r?.content === 'string' ? r.content : null
    } catch {
      return null
    }
  },

  /** PUT /api/hermes/library/doc?name= { content } — edit the CENTRAL doc
   *  (one edit, every agent sees it — they only hold pointers). */
  async putLibraryDoc(name: string, content: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('PUT', `/api/hermes/library/doc?name=${encodeURIComponent(name)}`, { content })
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/agents/:id/library-docs — the central docs with a
   *  per-agent `pointed` flag: is the doc currently in THIS agent's TOOLS.md
   *  LIBRARY-TOC (5a8da3d; `skills` many-to-many since 2597fb2). Powers the
   *  stateful pointer toggles. */
  async listAgentLibraryDocs(id: string): Promise<Array<{ name: string; title: string; skills: string[]; pointed: boolean }> | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/library-docs`)
      if (r?.error || !Array.isArray(r?.docs)) return null
      return r.docs
    } catch {
      return null
    }
  },

  /** POST /api/hermes/agents/:id/library-doc { name, assigned } — add/remove
   *  one doc's TOOLS.md pointer for one agent (the override path; skill
   *  assignment auto-injects bonded docs' pointers). */
  async setAgentLibraryDoc(id: string, name: string, assigned: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('POST', `/api/hermes/agents/${encodeURIComponent(id)}/library-doc`, { name, assigned })
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/agents/:id/native-tools — the agent's native (built-in
   *  Hermes) tools with per-tool enabled state, via the acp-tool-override
   *  plugin (claude1 88bbf79). Changes apply on the agent's NEXT session. */
  async agentNativeTools(id: string): Promise<{ tools: Array<{ name: string; category: string; enabled: boolean }>; pluginInstalled: boolean } | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/native-tools`)
      if (r?.error || !Array.isArray(r?.tools)) return null
      return { tools: r.tools, pluginInstalled: !!r.pluginInstalled }
    } catch {
      return null
    }
  },

  /** PUT /api/hermes/agents/:id/native-tools { disabled } — writes the
   *  plugin's state.json for ONE agent (full OFF list; ensures the plugin). */
  async putAgentNativeTools(id: string, disabled: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('PUT', `/api/hermes/agents/${encodeURIComponent(id)}/native-tools`, { disabled })
      return { ok: !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** PUT /api/hermes/native-tools { disabled } — same OFF list applied to ALL
   *  agents (the global default). */
  async putGlobalNativeTools(disabled: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('PUT', '/api/hermes/native-tools', { disabled })
      return { ok: !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/skills — the Hermes skills LIBRARY (2f264d2): all skills
   *  (builtin + Travis's local imports under category "custom"). `ref` is the
   *  lib-relative dir path (can be >2 segments, e.g. mlops/inference/vllm). */
  async listSkills(): Promise<Array<{ ref: string; name: string; dir: string; category: string; description: string; source: 'builtin' | 'local'; tags?: string[] }> | null> {
    try {
      const r = await bridge().request('GET', '/api/hermes/skills')
      if (r?.error || !Array.isArray(r?.skills)) return null
      return r.skills
    } catch {
      return null
    }
  },

  /** GET /api/hermes/skills/tags → distinct curated tags, count-desc (1a0f639;
   *  seeded from the local-model audit harvest — ~1133 tags). */
  async listSkillTags(): Promise<Array<{ tag: string; count: number }> | null> {
    try {
      const r = await bridge().request('GET', '/api/hermes/skills/tags')
      if (r?.error || !Array.isArray(r?.tags)) return null
      return r.tags
    } catch {
      return null
    }
  },

  /** PUT /api/hermes/skills/tags { ref, tags } — replaces a skill's curated
   *  tags (empty clears; server lowercases/dedupes/caps at 32). */
  async putSkillTags(ref: string, tags: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('PUT', '/api/hermes/skills/tags', { ref, tags })
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** GET /api/hermes/skills/search?q= — matches metadata (name/description/
   *  ref/tags) OR SKILL.md body content; same skill shape as /skills. */
  async searchSkills(q: string): Promise<Array<{ ref: string; name: string; dir: string; category: string; description: string; source: 'builtin' | 'local'; tags?: string[] }> | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/skills/search?q=${encodeURIComponent(q)}`)
      if (r?.error || !Array.isArray(r?.skills)) return null
      return r.skills
    } catch {
      return null
    }
  },

  /** GET /api/hermes/skills/item?ref= — a skill's SKILL.md. Null on failure. */
  async getSkill(ref: string): Promise<string | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/skills/item?ref=${encodeURIComponent(ref)}`)
      if (r?.error) return null
      return typeof r?.content === 'string' ? r.content : null
    } catch {
      return null
    }
  },

  /** PUT /api/hermes/skills/item?ref= { content } — edit OR create (a new ref
   *  like "custom/my-skill" creates the dir). */
  async putSkill(ref: string, content: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('PUT', `/api/hermes/skills/item?ref=${encodeURIComponent(ref)}`, { content })
      return { ok: r?.ok !== false && !r?.error, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** DELETE /api/hermes/agents/:id — removes the Hermes profile. */
  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('DELETE', `/api/hermes/agents/${encodeURIComponent(id)}`)
      return { ok: r?.ok !== false, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /**
   * POST /api/hermes/agents/:id/prompt — one full turn, resolves with the reply.
   * Feature A extras: `context` (structured page snapshot — backend injects it as a
   * "[Current view context]" block) and `screenshot` (data URL / base64 PNG — backend
   * writes it to the agent's cwd and tells the agent to read it with its vision tool).
   * Both augment only the agent's turn, never the displayed user message.
   */
  async prompt(id: string, text: string, extra?: { context?: string; screenshot?: string; conversationId?: string }): Promise<HermesPromptResult> {
    try {
      const r = await bridge().request('POST', `/api/hermes/agents/${encodeURIComponent(id)}/prompt`, { text, ...(extra?.context ? { context: extra.context } : {}), ...(extra?.screenshot ? { screenshot: extra.screenshot } : {}), ...(extra?.conversationId ? { conversationId: extra.conversationId } : {}) })
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: r?.ok !== false, reply: r?.reply, stopReason: r?.stopReason }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** POST /api/hermes/screen-capture — answer a capture_request signal (the
   *  backend hands the image to the agent's view_screen tool; 20s timeout its
   *  side, so on capture failure we simply don't POST). */
  async screenCapture(requestId: string, image: string): Promise<void> {
    await bridge().request('POST', '/api/hermes/screen-capture', { requestId, image })
  },

  /** SSE observer path (same-origin EventSource; disconnect only detaches).
   *  conversationId scopes to ONE conversation's session (omitted = legacy per-agent key). */
  streamPath(id: string, conversationId?: string): string {
    const q = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''
    return `/api/hermes/agents/${encodeURIComponent(id)}/stream${q}`
  },

  /** GET /history?conversationId — transcript read-back for a conversation. */
  async history(id: string, conversationId: string, since?: number): Promise<any> {
    return bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}/history?conversationId=${encodeURIComponent(conversationId)}${since != null ? `&since=${since}` : ''}`)
  },

  /** POST /rewind — Edit / Regenerate / Delete the tail turn (native SessionDB rewind). */
  async rewind(id: string, conversationId: string, mode: 'edit' | 'regenerate' | 'delete', text?: string): Promise<any> {
    return bridge().request('POST', `/api/hermes/agents/${encodeURIComponent(id)}/rewind`, { conversationId, mode, ...(text != null ? { text } : {}) })
  },

  /** POST /cancel — Stop button: cancel the in-flight turn (server forwards ACP session/cancel to
   *  the model). Fire-and-forget; the authoritative idle status arrives back over /stream. */
  async stop(agentId: string, conversationId: string): Promise<void> {
    await bridge().request('POST', `/api/hermes/agents/${encodeURIComponent(agentId)}/cancel?conversationId=${encodeURIComponent(conversationId)}`, {})
  },

  /** GET /api/hermes/conversations — server-side conversation registry (cross-device tab list). */
  async conversations(): Promise<Array<{ conversationId: string; agentId: string; title?: string; lastActive: number }>> {
    try { const r = await bridge().request('GET', '/api/hermes/conversations'); return Array.isArray((r as { conversations?: unknown })?.conversations) ? (r as { conversations: Array<{ conversationId: string; agentId: string; title?: string; lastActive: number }> }).conversations : [] } catch { return [] }
  },

  /** DELETE /session?conversationId — END + WIPE: kills the backend session and
   *  drops its transcript, so a same-agent reopen is brand new. Call on tab close. */
  async endConversation(id: string, conversationId: string): Promise<void> {
    try {
      await bridge().request('DELETE', `/api/hermes/agents/${encodeURIComponent(id)}/session?conversationId=${encodeURIComponent(conversationId)}`)
    } catch { /* best-effort — a dead backend session just ages out */ }
  },

  /**
   * POST /api/hermes/agents/:id/model {conversationId, modelId} — per-
   * conversation model swap (2ce0aa1): forwards ACP session/set_model to the
   * live bridge; Hermes recreates the session agent on the new model and
   * persists it. REQUIRES a live session — 500 "no live acp session" if the
   * conversation hasn't been warmed with a message yet. modelId is the raw
   * catalog id verbatim (keep "[DS] "/"[OR] " prefixes — Hermes resolves them).
   */
  async setConversationModel(agentId: string, conversationId: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('POST', `/api/hermes/agents/${encodeURIComponent(agentId)}/model`, { conversationId, modelId })
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: r?.ok === true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** Raw model id list (GET /api/proxy/llm/v1/models) — verbatim ids for the
   *  per-conversation swap dropdown, tagged prefixes intact. */
  async listRawModelIds(): Promise<string[]> {
    try {
      const r = await bridge().request('GET', '/api/proxy/llm/v1/models')
      return ((r?.data ?? []) as Array<{ id?: string }>).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
    } catch {
      return []
    }
  },

  /**
   * GET /api/hermes/doc-templates/user → the canonical shared USER doc
   * (/root/.hermes/global/USER.md — "About Your Human"). Null on failure so
   * the editor never opens empty over the real file.
   */
  async getUserTemplate(): Promise<string | null> {
    try {
      const r = await bridge().request('GET', '/api/hermes/doc-templates/user')
      return typeof r?.markdown === 'string' ? r.markdown : null
    } catch {
      return null
    }
  },

  /**
   * PUT /api/hermes/doc-templates/user — writes the canonical USER doc and
   * re-propagates its content into every agent's AGENTS.md "About Your Human"
   * section (doc consolidation 54a0c55). Returns agentsUpdated.
   */
  async putUserTemplate(markdown: string): Promise<{ ok: boolean; agentsUpdated?: number; error?: string }> {
    try {
      const r = await bridge().request('PUT', '/api/hermes/doc-templates/user', { markdown })
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: r?.ok !== false, agentsUpdated: typeof r?.agentsUpdated === 'number' ? r.agentsUpdated : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /**
   * GET /api/hermes/support-models → global role assignments. Returns null on
   * transport failure (distinct from a legitimately unset role) so the editor
   * can stay closed instead of blind-saving over live config.
   */
  async getSupportModels(): Promise<Record<string, SupportModelRole> | null> {
    try {
      const r = await bridge().request('GET', '/api/hermes/support-models')
      const roles = r?.roles
      if (!roles || typeof roles !== 'object') return null
      const out: Record<string, SupportModelRole> = {}
      for (const [k, v] of Object.entries(roles as Record<string, any>)) {
        if (v && typeof v === 'object') {
          out[k] = {
            provider: String(v.provider || 'ailab'),
            model: typeof v.model === 'string' ? v.model : '',
            ...(typeof v.description === 'string' ? { description: v.description } : {}),
            ...(typeof v.recommendation === 'string' ? { recommendation: v.recommendation } : {}),
          }
        }
      }
      return out
    } catch {
      return null
    }
  },

  /** GET /api/hermes/aux-tasks — self-populating catalog of Hermes auxiliary roles. */
  async getAuxTasks(): Promise<AuxTask[] | null> {
    try {
      const r = await bridge().request('GET', '/api/hermes/aux-tasks')
      return Array.isArray(r?.tasks) ? (r.tasks as AuxTask[]) : null
    } catch {
      return null
    }
  },

  /** GET /api/ai/rag/models — RAG embed/reranker selection + probe-classified service lists. */
  async getRagModels(): Promise<any | null> {
    try { return await bridge().request('GET', '/api/ai/rag/models') } catch { return null }
  },
  /** PUT /api/ai/rag/models — set the embed/reranker model selection (loopback route + model). */
  async setRagModels(patch: { embedModel?: string; embedUrl?: string; rerankModel?: string; rerankUrl?: string }): Promise<{ ok: boolean; error?: string }> {
    try { const r = await bridge().request('PUT', '/api/ai/rag/models', patch); return { ok: r?.ok !== false, error: r?.error ? String(r.error) : undefined } } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) } }
  },

  /**
   * PUT /api/hermes/support-models — MERGE semantics: only the keys present in
   * the patch are touched; a key set to null clears that role. Applies globally.
   */
  async setSupportModels(patch: Record<string, { model?: string; provider?: string; description?: string; recommendation?: string } | null>): Promise<{ ok: boolean; agentsUpdated?: number; error?: string }> {
    try {
      const r = await bridge().request('PUT', '/api/hermes/support-models', patch)
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: r?.ok !== false, agentsUpdated: typeof r?.agentsUpdated === 'number' ? r.agentsUpdated : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /**
   * Unified model catalog for the picker. Prefers the typed catalog endpoint;
   * falls back to mapping the raw OpenAI models list to untagged local entries
   * (local canonical ids stay untagged by design — metadata carries the tag).
   */
  async listCatalog(): Promise<CatalogModelWithCaps[]> {
    // Capabilities ride on /llm/v1/models (same canonical ids as the catalog) —
    // fetch both and join, so pickers can badge vision/audio per model.
    let caps = new Map<string, ModelCapabilities>()
    let rawData: Array<{ id?: string; capabilities?: ModelCapabilities }> = []
    try {
      const raw = await bridge().request('GET', '/api/proxy/llm/v1/models')
      rawData = raw?.data ?? []
      caps = new Map(rawData.filter((m) => m.id && m.capabilities).map((m) => [m.id as string, m.capabilities as ModelCapabilities]))
    } catch { /* capabilities are enrichment — never block the picker */ }
    try {
      const r = await bridge().request('GET', '/api/proxy/llm/catalog')
      const models = (Array.isArray(r) ? r : r?.data ?? r?.models ?? r?.catalog) as CatalogModelWithCaps[] | undefined
      if (Array.isArray(models) && models.length) {
        return models.map((m) => ({ ...m, capabilities: m.capabilities ?? caps.get(m.id) ?? caps.get(m.upstreamModel) }))
      }
    } catch {
      /* catalog route unreachable — fall through to the raw list */
    }
    return rawData
      .filter((m): m is { id: string; capabilities?: ModelCapabilities } => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        tag: 'AI-LAB',
        sourceId: 'ai-lab',
        upstreamModel: m.id,
        displayName: m.id,
        kind: 'local' as const,
        capabilities: m.capabilities,
      }))
  },
}
