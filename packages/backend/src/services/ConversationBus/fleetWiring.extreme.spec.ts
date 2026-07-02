/** Integration smoke: bus + fleetBridge + the relay-inbound HTTP route shape. */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// @ts-expect-error — express ships untyped in this repo (same pre-existing gap as UniversalProxyService)
import express from 'express'
import { ConversationBus, JsonlBusStore, AgentRegistry } from './index'
import { createFleetBridge } from './fleetBridge'

const dir = mkdtempSync(join(tmpdir(), 'fleet-wire-'))
const bus = new ConversationBus(
  new JsonlBusStore(join(dir, 'bus.jsonl')),
  new AgentRegistry(join(dir, 'registry.json')),
  join(dir, 'config.json'),
  null,
)
const bridge = createFleetBridge(bus)
const records: unknown[] = []
bus.on('record', (r) => records.push(r))

// Same handler shape as UniversalProxyService
const app = express()
app.post('/api/fleet/relay-inbound', express.json({ limit: '1mb' }), (req: { body: unknown }, res: any) => {
  try {
    res.json({ ok: true, envelope: bus.handleRelayInbound(req.body) })
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

const server = app.listen(0, async () => {
  const addr = server.address() as { port: number }
  const base = `http://127.0.0.1:${addr.port}`

  // 1. relay inbound over real HTTP
  const r1 = await fetch(`${base}/api/fleet/relay-inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender: 'claude1', recipient: 'fable-builder', message: 'integration hello' }),
  })
  const j1 = (await r1.json()) as any
  if (!j1.ok || j1.envelope.from !== 'claude1') throw new Error('relay inbound failed: ' + JSON.stringify(j1))
  console.log('PASS relay inbound over HTTP:', j1.envelope.busSeq)

  // 2. malformed payload → 400, structured error
  const r2 = await fetch(`${base}/api/fleet/relay-inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nope: true }),
  })
  if (r2.status !== 400) throw new Error('expected 400 for malformed payload')
  console.log('PASS malformed payload rejected with 400')

  // 3. bridge send (UI identity pinned) + replay + status
  const env = bridge.send({ id: 'ui-1', from: 'spoofed', to: 'claude1', kind: 'dm', body: 'from ui' }) as any
  if (env.from !== 'user') throw new Error('bridge did not pin UI identity')
  console.log('PASS bridge.send pins user identity')
  const replay = bridge.replay({ afterSeq: -1, limit: 100 }) as any
  if (replay.records.length < 3) throw new Error('replay too short')
  console.log('PASS bridge.replay returns records:', replay.records.length)
  const status = bridge.status() as any
  if (!status.guardConfig || status.guardConfig.autonomousRoutingEnabled !== false) throw new Error('guard config wrong')
  if (!status.agents.some((a: any) => a.agentId === 'claude1' && a.kind === 'relay')) throw new Error('relay agent missing from status')
  console.log('PASS bridge.status: kill switch off, relay agents present')

  // 4. record fan-out fired for every append
  if (records.length !== replay.records.length) throw new Error(`fan-out mismatch: ${records.length} events vs ${replay.records.length} records`)
  console.log('PASS record fan-out matches log:', records.length)

  console.log('ALL PASS')
  server.close()
})
