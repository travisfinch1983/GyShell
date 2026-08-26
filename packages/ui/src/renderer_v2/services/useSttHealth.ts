import { useEffect, useState } from 'react'

/**
 * Is there a healthy speech-to-text provider right now?
 *
 * Exists so a microphone button can be disabled WITH A REASON. A mic that silently records
 * into a dead provider is worse than one that is visibly unavailable — you only find out
 * after you have finished talking, and the audio is gone.
 *
 * `why` is always populated when `ok` is false; render it as the button's title.
 */
export function useSttHealth(): { ok: boolean; why: string } {
  const [stt, setStt] = useState<{ ok: boolean; why: string }>({ ok: false, why: 'checking for an STT provider…' })

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/proxy/stt/v1/providers')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        const healthy = (d?.providers ?? []).filter((p: any) => p.status === 'healthy')
        if (!alive) return
        setStt(healthy.length
          ? { ok: true, why: '' }
          : { ok: false, why: (d?.providers?.length
              ? `STT provider is unhealthy (${d.providers.map((p: any) => `${p.providerId} on ${p.host}`).join(', ')}) — the host is likely down`
              : 'no STT provider is registered') })
      } catch (e: any) {
        if (alive) setStt({ ok: false, why: `could not reach the STT provider list: ${e?.message ?? e}` })
      }
    })()
    return () => { alive = false }
  }, [])

  return stt
}
