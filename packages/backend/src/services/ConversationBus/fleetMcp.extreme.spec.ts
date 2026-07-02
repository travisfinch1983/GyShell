/**
 * FULL-LOOP smoke: MCP JSON-RPC (stdio) → packages/mcp-fleet server →
 * /api/fleet HTTP → real ConversationBus. Requires packages/mcp-fleet/dist
 * (built by `tsc -p packages/mcp-fleet/tsconfig.json`).
 */
import { spawn } from 'child_process'
import { mkdtempSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
// @ts-expect-error — express ships untyped in this repo (same pre-existing gap as UniversalProxyService)
import express from 'express'
import { ConversationBus, JsonlBusStore, AgentRegistry } from './index'
import { createFleetRouter } from './fleetHttp'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const MCP_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../mcp-fleet/dist/index.js')

async function main(): Promise<void> {
  if (!existsSync(MCP_DIST)) {
    console.error(`SKIP: ${MCP_DIST} not built — run tsc -p packages/mcp-fleet/tsconfig.json first`)
    process.exit(1)
  }
  const dir = mkdtempSync(join(tmpdir(), 'fleet-mcp-'))
  const bus = new ConversationBus(
    new JsonlBusStore(join(dir, 'bus.jsonl')),
    new AgentRegistry(join(dir, 'registry.json')),
    join(dir, 'config.json'),
    null,
  )
  bus.registry.upsert({ agentId: 'ops', displayName: 'Ops', kind: 'local', enabled: true })

  const app = express()
  app.use(createFleetRouter(bus))
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port

  const child = spawn('node', [MCP_DIST], {
    env: { ...process.env, AILAB_API_URL: `http://127.0.0.1:${port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, (v: any) => void>()
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg)
          pending.delete(msg.id)
        }
      } catch {
        /* non-JSON noise */
      }
    }
  })
  let nextId = 0
  const rpc = (method: string, params?: unknown): Promise<any> => {
    const id = ++nextId
    const p = new Promise<any>((resolvePromise, reject) => {
      pending.set(id, resolvePromise)
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`rpc timeout: ${method}`))
      }, 10_000)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return p
  }
  const notify = (method: string): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const r = await rpc('tools/call', { name, arguments: args })
    if (r.error) throw new Error(`tool ${name} rpc error: ${JSON.stringify(r.error)}`)
    const parsed = JSON.parse(r.result.content[0].text)
    return { parsed, isError: r.result.isError === true }
  }

  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'fleet-smoke', version: '0' },
    })
    notify('notifications/initialized')

    const tools = await rpc('tools/list')
    const names = tools.result.tools.map((t: any) => t.name).sort()
    assertEqual(names.join(','), 'fleet_agents,fleet_read,fleet_register,fleet_send,fleet_status', 'all 5 tools listed')
    console.log('PASS tools/list')

    const send = await call('fleet_send', { sender: 'claude1', recipient: 'fable-builder', message: 'mcp says hi' })
    assertEqual(send.parsed.ok, true, 'fleet_send ok')
    assertEqual(send.parsed.envelope.from, 'claude1', 'sender mapped')
    console.log('PASS fleet_send (dm), busSeq', send.parsed.envelope.busSeq)

    const bcast = await call('fleet_send', { sender: 'claude1', recipient: 'broadcast', message: 'all hands from mcp' })
    assertEqual(bcast.parsed.envelope.kind, 'broadcast', 'broadcast kind')
    console.log('PASS fleet_send (broadcast)')

    const reg = await call('fleet_register', { agentId: 'openclaw', displayName: 'OpenClaw', kind: 'relay' })
    assertEqual(reg.parsed.ok, true, 'fleet_register ok')
    const agents = await call('fleet_agents')
    assertEqual(agents.parsed.agents.some((a: any) => a.agentId === 'openclaw'), true, 'registered agent listed')
    console.log('PASS fleet_register + fleet_agents')

    const status = await call('fleet_status')
    assertEqual(status.parsed.guardConfig.autonomousRoutingEnabled, false, 'kill switch visible + off')
    console.log('PASS fleet_status')

    const read = await call('fleet_read', { afterSeq: -1, for: 'fable-builder' })
    assertEqual(read.parsed.messages.length, 2, 'dm + broadcast visible to fable-builder')
    assertEqual(typeof read.parsed.nextAfterSeq, 'number', 'cursor returned')
    const read2 = await call('fleet_read', { afterSeq: read.parsed.latestSeq })
    assertEqual(read2.parsed.messages.length, 0, 'caught-up cursor returns nothing new')
    console.log('PASS fleet_read cursor + for-filter')

    const badSend = await call('fleet_send', { sender: 'x', recipient: 'y', message: '' }).catch((e) => ({ rpcError: String(e) }))
    assertEqual('rpcError' in badSend || badSend.isError === true, true, 'empty message rejected')
    console.log('PASS validation rejects empty message')

    console.log('ALL PASS')
  } finally {
    child.kill()
    server.close()
  }
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
