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

  /** DELETE /session?conversationId — END + WIPE: kills the backend session and
   *  drops its transcript, so a same-agent reopen is brand new. Call on tab close. */
  async endConversation(id: string, conversationId: string): Promise<void> {
    try {
      await bridge().request('DELETE', `/api/hermes/agents/${encodeURIComponent(id)}/session?conversationId=${encodeURIComponent(conversationId)}`)
    } catch { /* best-effort — a dead backend session just ages out */ }
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
