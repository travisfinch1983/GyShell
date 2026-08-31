/**
 * Wake-health chip contract (fleet-channel 9831a94 consumer side).
 * Run: tsx packages/ui/src/renderer_v2/stores/wakeHealth.extreme.spec.ts
 *
 * The family's rule, restated for wakes: an agent ABSENT from the stats had no
 * traffic in the window — that is no evidence, and no evidence must render as
 * NOTHING, never as a passing check. `latched` is the panel state (a live,
 * sustained alarm); counters are context and always shown as a RATIO.
 */
let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}

;(globalThis as any).window = { gyshell: { cluster: { request: async () => ({}) } } }

async function main(): Promise<void> {
  const { wakeHealthFor } = await import('./FleetStore') as any
  const stats = {
    window_s: 86400, alert_min: 2,
    latched: { claude1: 'wake_timeout' },
    agents: {
      claude1: { woke: 45, wake_timeout: 11, wake_stalled: 0, last_woke_at: 1, last_failed_at: 2 },
      'fable-builder': { woke: 46, wake_timeout: 1, wake_stalled: 0, last_woke_at: 1, last_failed_at: 2 },
      'maintenance-claude': { woke: 20, wake_timeout: 0, wake_stalled: 0, last_woke_at: 1, last_failed_at: null },
      'idle-counter': { woke: 0, wake_timeout: 0, wake_stalled: 0, last_woke_at: null, last_failed_at: null },
    },
  }

  ok(wakeHealthFor(null, 'claude1') === null, 'no stats at all → NULL (fetch failed ≠ everyone healthy)')
  ok(wakeHealthFor(stats, 'ghost-agent') === null, 'agent ABSENT from stats → NULL — no traffic is no evidence, never a green check')
  ok(wakeHealthFor(stats, 'idle-counter') === null, 'all-zero counters → NULL too (present but zero traffic makes no claim either)')

  const latched = wakeHealthFor(stats, 'claude1')
  ok(latched?.state === 'latched' && latched.stage === 'wake_timeout',
    'latched wins over counters — a live sustained alarm IS the state, the ratio is context')

  const flaky = wakeHealthFor(stats, 'fable-builder')
  ok(flaky?.state === 'flaky' && flaky.ok === 46 && flaky.total === 47,
    'one missed wake un-latched → flaky with the RATIO 46/47 (11 alone says less than 11/56)')

  const clean = wakeHealthFor(stats, 'maintenance-claude')
  ok(clean?.state === 'clean' && clean.ok === 20 && clean.total === 20,
    'zero failures with real traffic → clean, still carrying the ratio')

  // Drift guard: a stats object missing `latched` (older fleetd) must not throw
  // and must still serve counters.
  const noLatch = wakeHealthFor({ ...stats, latched: undefined } as any, 'fable-builder')
  ok(noLatch?.state === 'flaky', 'missing latched map (older fleetd) degrades to counters, not a crash')

  console.log(`\n${n} assertions passed`)
}

void main()
