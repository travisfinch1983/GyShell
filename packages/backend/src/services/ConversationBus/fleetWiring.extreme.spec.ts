/**
 * Integration smoke over the REAL fleet HTTP router (fleetHttp.ts) + bridge:
 * send/relay-inbound (incl. broadcast), cursor feed, agents, status, register,
 * malformed-payload 400s, identity pinning, record fan-out parity.
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// @ts-expect-error — express ships untyped in this repo (same pre-existing gap as UniversalProxyService)
import express from 'express'
import { ConversationBus, JsonlBusStore, AgentRegistry } from './index'
import { createFleetBridge } from './fleetBridge'
import { createFleetRouter } from './fleetHttp'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'fleet-wire-'))
const bus = new ConversationBus(
  new JsonlBusStore(join(dir, 'bus.jsonl')),
  new AgentRegistry(join(dir, 'registry.json')),
  join(dir, 'config.json'),
  null,
)
bus.registry.upsert({ agentId: 'ops', displayName: 'Ops', kind: 'local', enabled: true })
const bridge = createFleetBridge(bus)
const records: unknown[] = []
bus.on('record', (r) => records.push(r))

const app = express()
app.use(createFleetRouter(bus))

const server = app.listen(0, async () => {
  const addr = server.address() as { port: number }
  const base = `http://127.0.0.1:${addr.port}`
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: (await r.json()) as any }
  }
  const get = async (path: string) => (await fetch(`${base}${path}`)).json() as any

  try {
    // 1. send via BOTH paths (new + legacy relay-inbound)
    const r1 = await post('/api/fleet/send', { sender: 'claude1', recipient: 'fable-builder', message: 'via /send' })
    assertEqual(r1.json.ok && r1.json.envelope.from === 'claude1', true, 'send path works')
    const r2 = await post('/api/fleet/relay-inbound', { sender: 'claude1', recipient: 'user', message: 'via legacy path' })
    assertEqual(r2.json.ok, true, 'legacy relay-inbound path still works')
    console.log('PASS send via /api/fleet/send + legacy /relay-inbound')

    // 2. broadcast recipient fans out (per-recipient delivery updates incl. local agent)
    const r3 = await post('/api/fleet/send', { sender: 'openclaw', recipient: 'broadcast', message: 'hello everyone' })
    assertEqual(r3.json.envelope.kind, 'broadcast', 'broadcast kind set')
    const feed = await get('/api/fleet/feed?afterSeq=-1&limit=500')
    const bcastDeliveries = feed.records.filter(
      (r: any) => r.type === 'delivery' && r.update.refSeq === r3.json.envelope.busSeq,
    )
    assertEqual(bcastDeliveries.length >= 2, true, 'broadcast delivered to multiple recipients')
    console.log('PASS broadcast via relay shape:', bcastDeliveries.length, 'recipients')

    // 3. malformed payloads -> 400 structured
    const bad1 = await post('/api/fleet/send', { nope: true })
    const bad2 = await post('/api/fleet/register', { agentId: 'Bad Name!', displayName: 'x', kind: 'local' })
    assertEqual(bad1.status === 400 && bad2.status === 400, true, 'malformed payloads rejected with 400')
    console.log('PASS malformed send + register rejected')

    // 4. cursor feed pagination
    const page1 = await get('/api/fleet/feed?afterSeq=-1&limit=3')
    assertEqual(page1.records.length, 3, 'limit respected')
    const page2 = await get(`/api/fleet/feed?afterSeq=${page1.nextAfterSeq}&limit=500`)
    assertEqual(page1.records.length + page2.records.length >= feed.records.length, true, 'pagination completes')
    console.log('PASS cursor feed pagination')

    // 5. agents + register + status
    const reg = await post('/api/fleet/register', {
      agentId: 'openclaw',
      displayName: 'OpenClaw',
      kind: 'relay',
      relayRecipient: 'openclaw',
      enabled: true,
    })
    assertEqual(reg.json.ok, true, 'register upserts')
    const agents = await get('/api/fleet/agents')
    assertEqual(agents.agents.some((a: any) => a.agentId === 'openclaw' && a.displayName === 'OpenClaw'), true, 'registered agent listed')
    assertEqual(agents.statuses.length > 0, true, 'statuses present')
    const status = await get('/api/fleet/status')
    assertEqual(status.guardConfig.autonomousRoutingEnabled, false, 'kill switch off in status')
    assertEqual(typeof status.latestSeq, 'number', 'latestSeq present')
    console.log('PASS agents/register/status')

    // 6. UI bridge identity pinning + fan-out parity (unchanged behavior)
    const env = bridge.send({ id: 'ui-1', from: 'spoofed', to: 'ops', kind: 'dm', body: 'from ui' }) as any
    assertEqual(env.from, 'user', 'bridge pins user identity')
    const finalFeed = await get('/api/fleet/feed?afterSeq=-1&limit=500')
    assertEqual(records.length, finalFeed.records.length, 'fan-out events match log records')
    console.log('PASS identity pinning + fan-out parity:', records.length)

    console.log('ALL PASS')
  } catch (e) {
    console.error('FAIL:', e)
    process.exitCode = 1
  } finally {
    server.close()
  }
})
