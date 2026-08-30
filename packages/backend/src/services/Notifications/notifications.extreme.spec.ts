/**
 * NotificationsService spec: event persistence + cap, ack, emit/debug routes,
 * ai-event ingest, and the health prober's honest three-state model — down
 * needs a reason, and a check that cannot RUN is unknown, never down.
 * Run: tsx packages/backend/src/services/Notifications/notifications.extreme.spec.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
// @ts-expect-error — express ships untyped in this repo
import express from 'express'
import { NotificationsService } from './NotificationsService'
import { createNotificationsRouter } from './notificationsHttp'

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'notif-spec-'))

  // A tiny target the prober can hit: /ok → 200, /flaky → 500.
  const target = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200); res.end('ok') }
    else { res.writeHead(500); res.end('boom') }
  })
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  const tPort = (target.address() as { port: number }).port

  // Health config seeded BEFORE construction: one healthy, one down, one
  // unreachable port, one malformed (unknown).
  writeFileSync(join(dataDir, 'notifications-health.json'), JSON.stringify({
    checks: [
      { id: 'good', label: 'Good', kind: 'http', target: `http://127.0.0.1:${tPort}/ok`, expect: '2xx3xx', downSeverity: 'error' },
      { id: 'bad', label: 'Bad', kind: 'http', target: `http://127.0.0.1:${tPort}/flaky`, expect: '2xx3xx', downSeverity: 'critical' },
      { id: 'gone', label: 'Gone', kind: 'http', target: 'http://127.0.0.1:1/none', expect: '2xx3xx', downSeverity: 'warning', timeoutMs: 500 },
      { id: 'weird', label: 'Weird', kind: 'bogus-kind' as never, target: 'x', downSeverity: 'error' },
    ],
  }))

  const broadcasts: Array<{ channel: string; data: unknown }> = []
  const svc = new NotificationsService(dataDir, (channel, data) => broadcasts.push({ channel, data }), 60_000)

  // events + persistence
  svc.notify({ severity: 'warning', source: 'spec', message: 'w1' })
  svc.notify({ severity: 'error', source: 'spec', message: 'e1', detail: 'boom' })
  svc.debug('spec', 'd1')
  assert(broadcasts.filter((b) => b.channel === 'notify:event').length === 2, 'events broadcast')
  assert(broadcasts.some((b) => b.channel === 'notify:debug'), 'debug broadcast')

  // ai.js ingest mapping
  svc.ingestAiEvent({ type: 'watchdog-never-healthy', serviceId: 's1', name: 'llm-5003' })
  svc.ingestAiEvent({ type: 'watchdog-restart', serviceId: 's1', name: 'llm-5003' })
  svc.ingestAiEvent({ type: 'something-else', x: 1 })
  const st = svc.state()
  assert(st.events.some((e) => e.severity === 'error' && e.source === 'watchdog'), 'never-healthy → error')
  assert(st.events.some((e) => e.severity === 'warning' && e.message.includes('restarted')), 'restart → warning')
  assert(st.debug.some((d) => d.message.startsWith('something-else')), 'unknown ai event → debug, not an alarm')

  // ack
  const ackable = st.events.filter((e) => !e.acked && e.severity !== 'info')
  assert(svc.ack([ackable[0].id]) === 1, 'single ack')
  assert(svc.ack('all') === ackable.length - 1, 'ack all acks the rest')

  // persistence survives a new instance (debounced write — wait for it)
  await new Promise((r) => setTimeout(r, 700))
  const reloaded = new NotificationsService(dataDir, () => {}, 60_000)
  assert(reloaded.state().events.some((e) => e.message === 'e1' && e.acked), 'events + acks persist across restart')

  // health probe: run one cycle via start/stop
  svc.start()
  await new Promise((r) => setTimeout(r, 1200))
  svc.stop()
  const health = Object.fromEntries(svc.state().health.map((h) => [h.id, h]))
  assert(health.good?.status === 'ok', `good is ok (${JSON.stringify(health.good)})`)
  assert(health.bad?.status === 'down' && String(health.bad.reason).includes('500'), 'bad is down with HTTP reason')
  assert(health.gone?.status === 'down', 'unreachable port is down (local: refusal IS evidence)')
  assert(health.weird?.status === 'unknown', 'malformed check is UNKNOWN, never down')

  // HTTP surface
  const app = express()
  app.use(createNotificationsRouter(svc))
  const server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  }
  let r = await call('GET', '/api/notifications/state')
  assert(Array.isArray(r.json.events) && Array.isArray(r.json.health), 'state shape')
  r = await call('POST', '/api/notifications/emit', { severity: 'critical', source: 'timer', message: 'pruner skipped' })
  assert(r.status === 200 && r.json.ok, 'emit accepts a valid event')
  r = await call('POST', '/api/notifications/emit', { severity: 'nope', source: 'x', message: 'y' })
  assert(r.status === 400, 'emit refuses bad severity')
  r = await call('POST', '/api/notifications/debug', { source: 'timer', message: 'tick' })
  assert(r.status === 200, 'debug route accepts')
  r = await call('POST', '/api/notifications/ack', { ids: 'all' })
  assert(r.status === 200, 'ack route accepts')

  // event cap
  for (let i = 0; i < 1100; i++) svc.notify({ severity: 'info', source: 'cap', message: `m${i}` })
  assert(svc.state().events.length <= 200, 'state returns capped slice')

  server.close()
  target.close()
  console.log('notifications.extreme.spec: all assertions passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
