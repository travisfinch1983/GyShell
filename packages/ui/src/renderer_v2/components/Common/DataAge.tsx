import React, { useEffect, useState } from 'react'

/**
 * "updated 14:23:07 (2m ago)" — the age a frozen chart is missing.
 *
 * 🛑 Every metric panel renders its error banner correctly and NONE rendered
 * an age, so a chart whose store kept last-good data through a dead poll
 * looked LIVE — frozen at 09:00 and indistinguishable from now (Observability
 * Sweep, UI staleness family). The age is the one signal that cannot be
 * faked by cached data: it grows on its own.
 *
 * Stale styling kicks in past `staleAfterMs` (default 90s — generous against
 * the slowest poller so a healthy panel never flickers orange). Renders
 * nothing until the first successful load: "never loaded" is the empty/error
 * state's job, not an age of the epoch.
 */
export const DataAge: React.FC<{ ts: number | null | undefined; staleAfterMs?: number }> = ({ ts, staleAfterMs = 90_000 }) => {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000)
    return () => clearInterval(t)
  }, [])
  if (!ts) return null
  const age = Date.now() - ts
  const rel = age < 60_000 ? `${Math.max(1, Math.round(age / 1000))}s ago`
    : age < 3_600_000 ? `${Math.round(age / 60_000)}m ago`
    : `${(age / 3_600_000).toFixed(1)}h ago`
  const stale = age > staleAfterMs
  return (
    <span
      title={stale ? 'No successful refresh recently — this data is OLD, not live' : 'Time of the last successful refresh'}
      style={{
        fontSize: 10.5,
        color: stale ? 'var(--danger, #e05555)' : 'var(--fg-muted)',
        fontWeight: stale ? 700 : 400,
        whiteSpace: 'nowrap',
      }}
    >
      {stale ? '⚠ stale — ' : 'updated '}{new Date(ts).toLocaleTimeString()} ({rel})
    </span>
  )
}
