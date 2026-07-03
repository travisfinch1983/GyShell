/**
 * External model-sources registry adapter — Settings › Models rework (P0 item 2).
 *
 * Wire adapter over the proxy's dedicated model-endpoints registry
 * (/api/proxy/external-sources — see proxy.js + the ExternalModelSource contract
 * in packages/shared/src/fleet/agent-platform.ts). Key handling is masked
 * end-to-end: GET returns `***<last4>` + `hasKey`; sending a blank or still-
 * masked apiKey on save preserves the stored key server-side. The raw key is
 * never readable back out of the registry.
 */
import type { ExternalModelSource } from '@gyshell/shared'

/** GET shape: contract fields with the key(s) masked + presence flags. */
export type ExternalModelSourceWire = ExternalModelSource & { hasKey?: boolean; hasAdminKey?: boolean }

/** One upstream model with metadata + its per-source enabled flag (from GET .../available). */
export interface AvailableModel {
  id: string
  name?: string
  contextLength?: number | null
  pricing?: {
    inputPerM?: number | null
    outputPerM?: number | null
    cacheReadPerM?: number | null
    cacheWritePerM?: number | null
    currency?: string
  }
  enabled: boolean
}
export interface AvailableModelsResult {
  sourceId: string
  tag: string
  /** true ⇒ the source's allow-list is empty, so every model is enabled. */
  allowAll: boolean
  count: number
  models: AvailableModel[]
}

/** Normalized account credit/balance for a source (GET .../balance | .../-balances). */
export interface SourceBalance {
  sourceId: string
  tag?: string
  displayName?: string
  supported: boolean
  /** 'balance' = credit remaining (OpenRouter/DeepSeek); 'spend' = period cost (Anthropic). */
  kind?: 'balance' | 'spend'
  currency?: string
  balance?: number | null
  /** current-month spend (Anthropic cost report). */
  spendMonth?: number | null
  totalCredits?: number
  totalUsage?: number
  granted?: number
  toppedUp?: number
  available?: boolean
  usage?: { total?: number; daily?: number; weekly?: number; monthly?: number }
  reason?: string
  checkedAt?: number
}

function bridge(): any {
  return (window as any).gyshell?.cluster
}

export const modelSourcesApi = {
  async list(): Promise<ExternalModelSourceWire[]> {
    const r = await bridge().request('GET', '/api/proxy/external-sources')
    return (Array.isArray(r) ? r : r?.sources ?? []) as ExternalModelSourceWire[]
  },

  /** Create/update (upsert by id). Masked/blank apiKey ⇒ server keeps the stored key. */
  async save(src: ExternalModelSource): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('POST', '/api/proxy/external-sources', src)
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('DELETE', `/api/proxy/external-sources/${encodeURIComponent(id)}`)
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },

  /** Full upstream model list for a source (metadata + per-model enabled) for the curation UI. */
  async available(id: string): Promise<AvailableModelsResult> {
    const r = await bridge().request('GET', `/api/proxy/external-sources/${encodeURIComponent(id)}/available`)
    return (r ?? { sourceId: id, tag: '', allowAll: true, count: 0, models: [] }) as AvailableModelsResult
  },

  /** Live account credit/balance for all sources (OpenRouter/DeepSeek supported). */
  async balances(): Promise<SourceBalance[]> {
    const r = await bridge().request('GET', '/api/proxy/external-sources-balances')
    return (r?.balances ?? []) as SourceBalance[]
  },
}
