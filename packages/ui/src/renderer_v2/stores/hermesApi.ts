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
  /** GET /api/hermes/agents → profile ids. */
  async listAgents(): Promise<string[]> {
    const r = await bridge().request('GET', '/api/hermes/agents')
    return (r?.agents ?? []) as string[]
  },

  /**
   * GET /api/hermes/agents/:id → the stored HermesAgentSpec (spec read-back,
   * claude1 landing it). Returns null while the route doesn't exist yet — the
   * edit flow falls back to a blank form pre-filled with just the id.
   */
  async getSpec(id: string): Promise<HermesAgentSpec | null> {
    try {
      const r = await bridge().request('GET', `/api/hermes/agents/${encodeURIComponent(id)}`)
      return (r?.spec ?? r?.agent ?? null) as HermesAgentSpec | null
    } catch {
      return null
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

  /** DELETE /api/hermes/agents/:id — removes the Hermes profile. */
  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('DELETE', `/api/hermes/agents/${encodeURIComponent(id)}`)
      return { ok: r?.ok !== false, error: r?.error ? String(r.error) : undefined }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** POST /api/hermes/agents/:id/prompt — one full turn, resolves with the reply. */
  async prompt(id: string, text: string): Promise<HermesPromptResult> {
    try {
      const r = await bridge().request('POST', `/api/hermes/agents/${encodeURIComponent(id)}/prompt`, { text })
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: r?.ok !== false, reply: r?.reply, stopReason: r?.stopReason }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** SSE observer path (same-origin EventSource; disconnect only detaches). */
  streamPath(id: string): string {
    return `/api/hermes/agents/${encodeURIComponent(id)}/stream`
  },

  /**
   * Unified model catalog for the picker. Prefers the typed catalog endpoint;
   * falls back to mapping the raw OpenAI models list to untagged local entries
   * (local canonical ids stay untagged by design — metadata carries the tag).
   */
  async listCatalog(): Promise<CatalogModel[]> {
    try {
      const r = await bridge().request('GET', '/api/proxy/llm/catalog')
      const models = (Array.isArray(r) ? r : r?.data ?? r?.models ?? r?.catalog) as CatalogModel[] | undefined
      if (Array.isArray(models) && models.length) return models
    } catch {
      /* catalog route not landed yet — fall through */
    }
    const raw = await bridge().request('GET', '/api/proxy/llm/v1/models')
    const data: Array<{ id?: string }> = raw?.data ?? []
    return data
      .filter((m): m is { id: string } => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        tag: 'AI-LAB',
        sourceId: 'ai-lab',
        upstreamModel: m.id,
        displayName: m.id,
        kind: 'local' as const,
      }))
  },
}
