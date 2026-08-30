/**
 * Monitor/SSH emitter family — batch 12, spec checked in with the batch.
 * Run: tsx packages/backend/src/services/monitorSshEmitters.extreme.spec.ts
 *
 * The family's shared shape: stale-data-served-as-live. A broken nvidia-smi is
 * byte-identical to "no GPU"; a dead source keeps rendering its last frame; a
 * degraded SFTP path returns success; dropped terminal records become
 * permanent on the next save. Every emitter here is latched — the assertions
 * come in fire/must-not-fire pairs, with the must-not side carrying the real
 * risk (a host that never had a GPU alarming would get the panel ignored).
 *
 * All against a local recorder on a scratch port — no live board, no live
 * hosts (the standing rule).
 */
import http from 'node:http'
import { TransitionLatch } from './notifyLocal'

let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const received: Array<{ severity: string; source: string; message: string; detail?: string }> = []
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c))
  req.on('end', () => { received.push(JSON.parse(b)); res.end('{}') })
})

async function main(): Promise<void> {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  process.env.AILAB_PROXY_PORT = String((srv.address() as { port: number }).port)

  // ── TransitionLatch contract (the primitive every emitter here rides) ─────
  const latch = new TransitionLatch(3, 'spec-src')
  for (let i = 0; i < 2; i++) latch.result('a', false, 'a failing', 'd')
  await wait(80)
  ok(received.length === 0, 'below threshold: silence')
  latch.result('a', false, 'a failing', 'd')
  await wait(80)
  ok(received.length === 1 && received[0].severity === 'warning', 'third consecutive: ONE warning')
  latch.result('a', false, 'a failing', 'd')
  await wait(80)
  ok(received.length === 1, 'latched while failing')
  latch.result('a', true, 'a failing', '')
  await wait(80)
  ok(received.length === 2 && received[1].severity === 'info', 'recovery: one info, re-armed')
  latch.result('b', false, 'b failing', 'd')
  await wait(80)
  ok(received.length === 2, 'subjects are independent — b is on its own streak')
  // single blip: fail once then succeed — must be COMPLETELY silent
  latch.result('c', false, 'c failing', 'd'); latch.result('c', true, 'c failing', '')
  await wait(80)
  ok(received.length === 2, 'a single blip (fail→recover under threshold) emits NOTHING — no per-blip noise')
  // once/rearm
  latch.once('k', 'warning', 'one-shot', 'd'); latch.once('k', 'warning', 'one-shot', 'd')
  await wait(80)
  ok(received.length === 3, 'once() fires exactly once per key')
  latch.rearm('k'); latch.once('k', 'warning', 'one-shot', 'd')
  await wait(80)
  ok(received.length === 4, 'rearm() lets a genuinely recurring condition report again')

  // ── monitor vanished-section latch, driven through the real service ───────
  received.length = 0
  const { ResourceMonitorService } = await import('./ResourceMonitorService')
  const svc: any = new ResourceMonitorService({ execOnTerminal: async () => null } as any)
  const session: any = { sourceKey: 'spec-host' }
  const withGpu = { gpus: [{ name: 'V100' }], disks: [{ a: 1 }], network: [{ b: 1 }], processes: [{ c: 1 }] }
  const noGpu = { disks: [{ a: 1 }], network: [{ b: 1 }], processes: [{ c: 1 }] }

  svc.trackSnapshotHealth(session, withGpu)
  for (let i = 0; i < 2; i++) svc.trackSnapshotHealth(session, noGpu)
  await wait(80)
  ok(received.length === 0, 'a previously-populated section empty for TWO polls: still silent')
  svc.trackSnapshotHealth(session, noGpu)
  await wait(80)
  ok(received.length === 1 && received[0].message.includes("'gpus' vanished"),
    'the THIRD consecutive empty poll fires once, naming the section — broken nvidia-smi is no longer "no GPU"')
  svc.trackSnapshotHealth(session, noGpu)
  await wait(80)
  ok(received.length === 1, 'latched — the fourth empty poll does not repeat')
  svc.trackSnapshotHealth(session, withGpu)
  await wait(80)
  ok(received.length === 2 && received[1].severity === 'info', 'the section coming back emits one recovery info')

  // the must-not-fire side that carries the real risk:
  const gpuless: any = { sourceKey: 'no-gpu-host' }
  for (let i = 0; i < 6; i++) svc.trackSnapshotHealth(gpuless, noGpu)
  await wait(80)
  ok(received.length === 2, 'a host that NEVER had a GPU never alarms — absence is not loss')

  // dead source: 5 consecutive failed snapshots
  received.length = 0
  const dying: any = { sourceKey: 'dying-host' }
  for (let i = 0; i < 4; i++) svc.trackSnapshotHealth(dying, { error: 'Terminal not found' })
  await wait(80)
  ok(received.length === 0, 'four failed snapshots: still silent')
  svc.trackSnapshotHealth(dying, { error: 'Terminal not found' })
  await wait(80)
  ok(received.length === 1 && received[0].message.includes('stopped producing'),
    'the fifth fires once — a poller outliving its terminal is no longer invisible')

  srv.close()
  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
