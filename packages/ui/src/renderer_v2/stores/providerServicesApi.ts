/**
 * Provider Services adapter — keyed non-model providers (ElevenLabs TTS etc.).
 * Masked-key discipline identical to modelSourcesApi: GET returns ***<last4> +
 * hasKey; blank/masked apiKey on save preserves the stored key. One entry holds
 * the account key ONCE; the backend pushes it into Hermes .env.
 */
import type { ProviderService, ProviderServiceWire } from '@gyshell/shared'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

export const providerServicesApi = {
  async list(): Promise<ProviderServiceWire[]> {
    const r = await bridge().request('GET', '/api/hermes/provider-services')
    return (Array.isArray(r) ? r : r?.services ?? []) as ProviderServiceWire[]
  },
  async save(svc: ProviderService): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('POST', '/api/hermes/provider-services', svc)
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },
  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('DELETE', `/api/hermes/provider-services/${encodeURIComponent(id)}`)
      if (r?.error) return { ok: false, error: String(r.error) }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  },
}
