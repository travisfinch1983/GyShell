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

/** GET shape: contract fields with the key masked + a hasKey flag. */
export type ExternalModelSourceWire = ExternalModelSource & { hasKey?: boolean }

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
}
