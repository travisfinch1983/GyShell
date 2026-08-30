import { NotificationsService } from '../NotificationsService.js'

// Instantiating this class arms REAL outbound routing: notify() calls routeToMaintainer(),
// which fleet-DMs the maintenance agent. A test that exercises the real class also exercises
// its real side effects -- this harness woke maintenance-claude with a synthetic "Test dep is
// DOWN" before this line existed. Opt in explicitly, never by default.
if (process.env.ALLOW_ROUTE !== '1') process.env.AILAB_MAINTAINER_AGENT = 'off'

const DEAD = 'http://127.0.0.1:9'                                    // refused fast
const LIVE = 'http://127.0.0.1:17890/api/proxy/llm/v1/models'

const svc: any = new NotificationsService('/tmp/probe-test-data', () => {}, 999_999)
svc.checks = [{ id: 'testdead', label: 'Test dep', kind: 'http', target: DEAD, expect: '2xx3xx', confirmations: 3, downSeverity: 'error' }]
svc.events = []

const healthEvents = () => svc.events.filter((e: any) => e.source === 'health')
const show = (tag: string) => {
  const ev = healthEvents()
  console.log(`  ${tag.padEnd(34)} events=${ev.length}  ${ev.map((e: any) => `[${e.severity}] ${e.message}`).join(' | ') || '(silent)'}`)
}

let fail = 0
const expect = (tag: string, got: number, want: number) => {
  if (got !== want) { console.log(`  ✗ FAIL ${tag}: got ${got}, want ${want}`); fail++ }
}

async function main() {
  console.log('=== a dependency failing, confirmations=3 ===')
  await svc.probeAll(); show('probe 1 (streak 1/3)'); expect('probe1', healthEvents().length, 0)
  await svc.probeAll(); show('probe 2 (streak 2/3)'); expect('probe2', healthEvents().length, 0)
  await svc.probeAll(); show('probe 3 (streak 3/3)'); expect('probe3', healthEvents().length, 1)

  console.log('=== still failing: must LATCH, not re-raise every cycle ===')
  await svc.probeAll(); show('probe 4'); expect('latch', healthEvents().length, 1)
  await svc.probeAll(); show('probe 5'); expect('latch', healthEvents().length, 1)

  console.log('=== recovers ===')
  svc.checks[0].target = LIVE
  await svc.probeAll(); show('probe 6 (recovered)'); expect('recover', healthEvents().length, 2)

  console.log('=== a NEW single blip must stay silent (streak was reset) ===')
  svc.checks[0].target = DEAD
  await svc.probeAll(); show('probe 7 (blip 1/3)'); expect('blip', healthEvents().length, 2)
  svc.checks[0].target = LIVE
  await svc.probeAll(); show('probe 8 (ok again)'); expect('blip-recover-silent', healthEvents().length, 2)

  console.log(fail === 0 ? '\nALL PASS — one blip is silent, three in a row alarms once.' : `\n${fail} FAILURE(S)`)
  process.exit(fail === 0 ? 0 : 1)

}
main()
