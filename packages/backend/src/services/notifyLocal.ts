/**
 * Backend-side notification emitter — the same estate-wide cheap path the
 * proxy routers use (proxy/lib/notify.js), for TS services that live outside
 * the proxy's module graph (ResourceMonitorService, SSHBackend, terminal
 * stores). One POST to the local /emit route; no service handle threaded
 * through constructors.
 *
 * Rules, same as the JS twin:
 *  - NEVER throws, never blocks: reporting a fault must not cause one. A lost
 *    report leaves one NOTIFY LOST console line rather than vanishing.
 *  - Env is read PER CALL (module-load reads bake at import time and make
 *    tests impossible — the reportsRag lesson).
 *  - Interpolated values go in `detail`, never `message` (the $nosig lesson:
 *    the backend dedups and the journal keys on stable message text).
 */

export type LocalSeverity = 'info' | 'warning' | 'error' | 'critical'

export async function emitLocalNotification(
  severity: LocalSeverity, source: string, message: string, detail = '',
): Promise<void> {
  try {
    const port = process.env.AILAB_PROXY_PORT || 17890
    await fetch(`http://127.0.0.1:${port}/api/notifications/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity, source, message, detail }),
      signal: AbortSignal.timeout(3000),
    })
  } catch (e) {
    console.warn(`[notify] NOTIFY LOST (${(e as Error)?.message ?? e}): ${severity} ${source}: ${message}`)
  }
}

/**
 * Consecutive-failure latch, per subject: quiet below the threshold, ONE
 * warning on crossing it, quiet while latched, one recovery info + re-arm on
 * success. The shape every polled emitter in the sweep uses — a single failed
 * probe woke the maintenance agent for a 25-second blip once, which is why
 * nothing here fires per-blip.
 */
export class TransitionLatch {
  private readonly streaks = new Map<string, number>()

  constructor(
    private readonly threshold: number,
    private readonly source: string,
  ) {}

  /** Record one outcome. On the firing transition, emits with the given texts. */
  result(subject: string, ok: boolean, message: string, detail: string): void {
    const streak = this.streaks.get(subject) ?? 0
    if (ok) {
      if (streak >= this.threshold) {
        void emitLocalNotification('info', this.source, `${message} — recovered`,
          `Working again after ${streak} consecutive failures.`)
      }
      this.streaks.set(subject, 0)
      return
    }
    const next = streak + 1
    this.streaks.set(subject, next)
    if (next === this.threshold) {
      void emitLocalNotification('warning', this.source, message, detail)
    }
  }

  /** For subjects with no success signal (one-shot conditions): emit once ever. */
  private readonly onceKeys = new Set<string>()
  once(subject: string, severity: LocalSeverity, message: string, detail: string): void {
    if (this.onceKeys.has(subject)) return
    this.onceKeys.add(subject)
    void emitLocalNotification(severity, this.source, message, detail)
  }

  /** Re-arm a once-key when its condition demonstrably cleared, so a LATER
   *  recurrence reports again instead of hiding behind the first firing. */
  rearm(subject: string): void {
    this.onceKeys.delete(subject)
  }
}
