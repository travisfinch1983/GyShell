/**
 * Health-board self-defeat family — the one place a bug disables the thing
 * that reports bugs, so no other emitter can catch it: the checker IS the
 * witness.
 * Run: tsx packages/backend/src/services/Notifications/healthBoardSelfDefeat.extreme.spec.ts
 *
 * 🛑 THE LOAD-BEARING ASSERTION SET IS THE SUSPENSION ONE. Travis is relying
 * on the routing switch to keep maintenance-claude quiet while the sweep
 * builds emitters; every failure path exercised here (corrupt events, corrupt
 * checks, empty checks, NaN interval) must leave the persisted suspension
 * intact and must not produce a single outbound fleetd call. The boot-report
 * queue exists precisely because a config problem found DURING construction
 * would otherwise race the routing load and could wake the agent through a
 * not-yet-loaded suspension.
 *
 * Everything runs against a scratch dataDir and a recorded fetch — no live
 * store, no live fleetd (the standing rule from the support-models incident).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotificationsService } from './NotificationsService'

let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Record every outbound fetch; never let one leave the process.
const outbound: string[] = []
;(globalThis as any).fetch = async (url: string) => {
  outbound.push(String(url))
  throw new Error('spec: outbound blocked')
}

async function main(): Promise<void> {
  // ── fixture: a suspended install with corrupt events + corrupt checks ─────
  const dataDir = mkdtempSync(join(tmpdir(), 'notif-'))
  const dir = join(dataDir, 'notifications')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'routing.json'), JSON.stringify({
    suspended: true, reason: 'sweep build', since: '2026-08-30T20:00:00Z', suppressed: 4, suppressedEvents: [],
  }))
  writeFileSync(join(dir, 'events.json'), '[{"id":"trunc')          // torn write
  writeFileSync(join(dataDir, 'notifications-health.json'), '{nope')    // corrupt config (lives at the dataDir ROOT, not in notifications/)

  process.env.AILAB_MAINTAINER_AGENT = 'maintenance-claude'         // routing ARMED by env
  const broadcasts: string[] = []
  const svc = new NotificationsService(dataDir, (ch) => { broadcasts.push(ch) }, Number('not-a-number'))

  // ── interval clamp ────────────────────────────────────────────────────────
  ok((svc.state().intervalMs === 30_000), 'NaN interval clamps to 30s — no probe storm, and state() reports a real number')

  // ── corrupt files: preserved aside, defaults served ───────────────────────
  ok(readdirSync(dir).some((f) => f.startsWith('events.json.corrupt-')),
    'corrupt events.json is COPIED ASIDE before starting empty — unacked history is recoverable')
  ok(readdirSync(dataDir).some((f) => f.startsWith('notifications-health.json.corrupt-')),
    'corrupt health config is copied aside too, then defaults serve')
  ok(svc.state().health.length === 0 || true, 'service constructed and answering')   // no probes started yet

  // ── boot reports arrive AFTER routing loaded, and are SUPPRESSED ──────────
  await wait(1_400)   // past the 1s boot-report flush
  const events = svc.state().events
  ok(events.some((e) => e.source === 'health-board' && e.message.includes('interval')),
    'the invalid-interval report was raised as a real event')
  ok(events.some((e) => e.message.includes('Event history was unreadable')),
    'the lost-history report was raised — an empty panel now says LOST, not quiet')
  ok(events.some((e) => e.message.includes('Health config was unreadable')),
    'the config-fallback report was raised — operator edits being ignored is stated')

  const routing = svc.routingState()
  ok(routing.suspended === true && routing.reason === 'sweep build',
    'THE SUSPENSION SURVIVED every failure path — reason and state intact')
  ok(routing.suppressed >= 4 + 3,
    'the boot reports were WITHHELD and counted, not forwarded (suppressed grew past the persisted 4)')
  ok(!outbound.some((u) => u.includes('/send')),
    'ZERO outbound fleetd /send calls — nothing woke the agent through the construction window')

  // ── empty checks array: valid, dead, and said ─────────────────────────────
  const dataDir2 = mkdtempSync(join(tmpdir(), 'notif2-'))
  const dir2 = join(dataDir2, 'notifications')
  mkdirSync(dir2, { recursive: true })
  writeFileSync(join(dir2, 'routing.json'), JSON.stringify({ suspended: true, reason: 'sweep', since: 'x', suppressed: 0, suppressedEvents: [] }))
  writeFileSync(join(dataDir2, 'notifications-health.json'), JSON.stringify({ checks: [] }))
  const svc2 = new NotificationsService(dataDir2, () => {})
  await wait(1_400)
  ok(svc2.state().events.some((e) => e.message.includes('ZERO checks')),
    'an empty checks array raises "nothing is being probed" instead of a silently dead board')
  ok(svc2.routingState().suspended, 'suspension intact on the second instance too')

  // ── missing defaults: seed-once drift is named ────────────────────────────
  const dataDir3 = mkdtempSync(join(tmpdir(), 'notif3-'))
  const dir3 = join(dataDir3, 'notifications')
  mkdirSync(dir3, { recursive: true })
  writeFileSync(join(dir3, 'routing.json'), JSON.stringify({ suspended: true, reason: 'sweep', since: 'x', suppressed: 0, suppressedEvents: [] }))
  writeFileSync(join(dataDir3, 'notifications-health.json'), JSON.stringify({
    checks: [{ id: 'qdrant', label: 'Qdrant', kind: 'http', target: 'http://127.0.0.1:6333/readyz', expect: '2xx3xx', downSeverity: 'error' }],
  }))
  const svc3 = new NotificationsService(dataDir3, () => {})
  await wait(1_400)
  const drift = svc3.state().events.find((e) => e.message.includes('absent from the configured set'))
  ok(!!drift, 'defaults absent from the on-disk config are reported at load (seed-once drift is visible)')
  ok(!!drift && (drift.detail ?? '').includes('mcpjungle'),
    'and the detail NAMES the unprobed checks')

  // ── maintainer validation: the REAL directory shape, pinned ───────────────
  // claude1's e1db49d: fleetd returns agent_id / display_name; the original
  // check compared id / name — fields ASSUMED, not observed — so every row
  // evaluated undefined and a 30-agent directory read as "recipient missing".
  // The emitter cried wolf on its first real boot, and only the suspension
  // kept the false alarm from delivering THROUGH the path it claimed broken.
  // These assertions pin the real field names so the guess cannot come back.
  ;(globalThis as any).fetch = async (url: string) => {
    if (String(url).includes('/directory')) {
      return { ok: true, json: async () => ({ agents: [
        { agent_id: 'maintenance-claude', display_name: 'Maintenance Claude' },
        { agent_id: 'claude1', display_name: 'claude1' },
      ] }) } as any
    }
    outbound.push(String(url)); throw new Error('spec: outbound blocked')
  }
  const evCount = svc.state().events.length
  await (svc as any).validateMaintainer()
  ok(svc.state().events.length === evCount,
    'a recipient present under agent_id/display_name raises NOTHING — the real fleetd shape resolves')
  ;(globalThis as any).fetch = async (url: string) => {
    if (String(url).includes('/directory')) {
      return { ok: true, json: async () => ({ agents: [{ agent_id: 'someone-else', display_name: 'X' }] }) } as any
    }
    outbound.push(String(url)); throw new Error('spec: outbound blocked')
  }
  await (svc as any).validateMaintainer()
  ok(svc.state().events.some((e) => e.message.includes("not in the fleet directory")),
    'a recipient GENUINELY absent from a non-empty directory still warns — the pair that proves the fix is not just quieter')

  // ── a healthy install stays quiet ─────────────────────────────────────────
  const dataDir4 = mkdtempSync(join(tmpdir(), 'notif4-'))
  const svc4 = new NotificationsService(dataDir4, () => {})   // seeds defaults itself
  await wait(1_400)
  ok(svc4.state().events.filter((e) => e.source === 'health-board').length === 0,
    'a healthy first boot raises NOTHING — no event on normal state')

  // ── identical-unacked dedup: a standing condition is one counted row ──────
  // Travis's report made it concrete: every deploy restarted the backend, each
  // restart re-raised the inventory-stub startup warning, ten rows for one
  // fact. emitOnce latches per process; the panel must dedupe across them.
  const svc5 = new NotificationsService(mkdtempSync(join(tmpdir(), 'notif5-')), () => {})
  const first = svc5.notify({ severity: 'warning', source: 'cluster-inventory', message: 'stub warning', detail: 'boot 1' })
  const second = svc5.notify({ severity: 'warning', source: 'cluster-inventory', message: 'stub warning', detail: 'boot 2' })
  ok(second.id === first.id && (second.occurrences ?? 0) === 2,
    'an identical unacked event BUMPS the existing row instead of stacking a new one')
  ok(svc5.state().events.filter((e) => e.message === 'stub warning').length === 1,
    'the panel holds ONE row for the standing condition')
  ok(second.detail === 'boot 2' && second.ts === first.ts && !!second.lastTs,
    'latest detail wins, first ts kept, lastTs records the recurrence')
  svc5.ack([first.id])
  const third = svc5.notify({ severity: 'warning', source: 'cluster-inventory', message: 'stub warning' })
  ok(third.id !== first.id,
    'after an ACK the next occurrence is a FRESH event — silence after acking means stopped, never hidden')
  ok(svc5.notify({ severity: 'warning', source: 'cluster-inventory', message: 'a different fact' }).id !== third.id,
    'a different message is never merged — dedup is identity, not proximity')

  console.log(`\n${n} assertions passed; outbound calls attempted: ${outbound.length} (all blocked)`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
