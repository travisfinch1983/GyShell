/**
 * ConversationBus extreme spec — run with tsx. Covers: store append/replay
 * cursor + crash recovery, identity enforcement, dedup, guards (kill switch,
 * hop TTL, pair rate, budget, queue caps), single-flight batching, broadcast
 * delivery tracking (targetAgentId), relay inbound, and system notices.
 */
import { mkdtempSync, appendFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BROADCAST_ADDRESS,
  USER_AGENT_ID,
  type BusEnvelope,
  type BusRecord,
} from '@gyshell/shared'
import { ConversationBus, type AgentInvoker } from './ConversationBus'
import { JsonlBusStore } from './BusStore'
import { AgentRegistry } from './AgentRegistry'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

let clock = 1_000_000
const now = () => clock

interface Harness {
  bus: ConversationBus
  dir: string
  invoked: Array<{ agentId: string; batch: BusEnvelope[] }>
  resolveTurn: () => void
  settle: () => Promise<void>
}

function makeHarness(opts: { manualTurns?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'bus-spec-'))
  const registry = new AgentRegistry(join(dir, 'registry.json'))
  registry.upsert({ agentId: 'ops', displayName: 'Ops', kind: 'local', enabled: true })
  registry.upsert({ agentId: 'researcher', displayName: 'Researcher', kind: 'local', enabled: true, limits: { maxQueueDepth: 2 } })

  const invoked: Harness['invoked'] = []
  let release: (() => void) | null = null
  const invoker: AgentInvoker = {
    async runTurn(agent, batch) {
      invoked.push({ agentId: agent.agentId, batch })
      if (opts.manualTurns) {
        await new Promise<void>((r) => {
          release = r
        })
      }
      return { sessionMessageIds: Object.fromEntries(batch.map((e) => [e.busSeq, `msg-${e.busSeq}`])) }
    },
  }

  const store = new JsonlBusStore(join(dir, 'bus.jsonl'))
  const bus = new ConversationBus(store, registry, join(dir, 'config.json'), invoker, now)
  return {
    bus,
    dir,
    invoked,
    resolveTurn: () => {
      const r = release
      release = null
      r?.()
    },
    settle: () => new Promise((r) => setTimeout(r, 10)),
  }
}

const dm = (id: string, to: string, body = 'hello') => ({
  id,
  from: USER_AGENT_ID,
  to,
  kind: 'dm' as const,
  body,
})

const statesFor = (h: Harness, busSeq: number) =>
  h.bus
    .replay({ afterSeq: -1, limit: 500 })
    .records.filter((r): r is Extract<BusRecord, { type: 'delivery' }> => r.type === 'delivery')
    .filter((r) => r.update.refSeq === busSeq)
    .map((r) => `${r.update.targetAgentId ?? ''}:${r.update.state}${r.update.reason ? `(${r.update.reason})` : ''}`)

async function main(): Promise<void> {
  await runCase('kill switch default: envelope appends, delivery stays queued, no inference', async () => {
    const h = makeHarness()
    const env = h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops'))
    await h.settle()
    assertEqual(h.invoked.length, 0, 'no invoker call while routing disabled')
    assertEqual(statesFor(h, env.busSeq).join(','), 'ops:queued', 'delivery queued only')
  })

  await runCase('flipping kill switch on pumps queued deliveries + emits system notices', async () => {
    const h = makeHarness()
    const env = h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops'))
    h.bus.setGuardConfig({ autonomousRoutingEnabled: true })
    await h.settle()
    assertEqual(h.invoked.length, 1, 'one turn ran')
    assertEqual(h.invoked[0].batch[0].busSeq, env.busSeq, 'right envelope delivered')
    const states = statesFor(h, env.busSeq)
    assertEqual(states.includes('ops:inference_started'), true, 'inference_started recorded')
    assertEqual(states.includes('ops:delivered'), true, 'delivered recorded')
    const notices = h.bus
      .replay({ afterSeq: -1, limit: 500 })
      .records.filter((r) => r.type === 'envelope' && r.envelope.kind === 'system')
    assertEqual(notices.length, 1, 'kill-switch flip emitted one system notice')
  })

  await runCase('identity enforcement: trustedFrom overrides claimed from', async () => {
    const h = makeHarness()
    const env = h.bus.send('ui', USER_AGENT_ID, { ...dm('m1', 'ops'), from: 'ops' })
    assertEqual(env.from, USER_AGENT_ID, 'broker used trusted identity')
  })

  await runCase('dedup: same (from,id) returns the original envelope', async () => {
    const h = makeHarness()
    const a = h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops'))
    const b = h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops', 'different body'))
    assertEqual(a.busSeq, b.busSeq, 'idempotent send')
  })

  await runCase('single-flight + batching: sends during a running turn batch into the next turn', async () => {
    const h = makeHarness({ manualTurns: true })
    h.bus.setGuardConfig({ autonomousRoutingEnabled: true })
    h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops'))
    await h.settle()
    assertEqual(h.invoked.length, 1, 'first turn started')
    h.bus.send('ui', USER_AGENT_ID, dm('m2', 'ops'))
    h.bus.send('ui', USER_AGENT_ID, dm('m3', 'ops'))
    await h.settle()
    assertEqual(h.invoked.length, 1, 'no second turn while busy')
    h.resolveTurn()
    await h.settle()
    assertEqual(h.invoked.length, 2, 'queued messages ran after turn ended')
    assertEqual(h.invoked[1].batch.length, 2, 'both queued messages batched into ONE turn')
    h.resolveTurn()
    await h.settle()
  })

  await runCase('different agents run concurrently (per-agent single-flight only)', async () => {
    const h = makeHarness({ manualTurns: true })
    h.bus.setGuardConfig({ autonomousRoutingEnabled: true })
    h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops'))
    await h.settle()
    h.bus.send('ui', USER_AGENT_ID, dm('m2', 'researcher'))
    await h.settle()
    assertEqual(h.invoked.length, 2, 'ops turn did not block researcher turn')
    h.resolveTurn()
    await h.settle()
    h.resolveTurn()
    await h.settle()
  })

  await runCase('hop TTL: agent-to-agent chain dies at 0 with feed-visible drop', async () => {
    const h = makeHarness()
    h.bus.setGuardConfig({ autonomousRoutingEnabled: true, defaultHopTtl: 2 })
    const e1 = h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops')) // hop 2
    const e2 = h.bus.send('agent', 'ops', { id: 'r1', from: 'ops', to: 'researcher', kind: 'dm', body: 'fwd' }, { parentSeq: e1.busSeq }) // hop 1
    const e3 = h.bus.send('agent', 'researcher', { id: 'r2', from: 'researcher', to: 'ops', kind: 'dm', body: 'fwd' }, { parentSeq: e2.busSeq }) // hop 0
    await h.settle()
    assertEqual(e2.hopCount, 1, 'hop decremented')
    assertEqual(e3.hopCount, 0, 'hop exhausted')
    assertEqual(statesFor(h, e3.busSeq).join(','), ':dropped(hop_ttl)', 'ttl drop recorded')
  })

  await runCase('pair rate limit: 11th message in 5min between same pair drops', async () => {
    const h = makeHarness()
    let last: BusEnvelope | null = null
    for (let i = 0; i < 11; i++) last = h.bus.send('ui', USER_AGENT_ID, dm(`m${i}`, 'ops'))
    assertEqual(statesFor(h, last!.busSeq).join(','), ':dropped(pair_rate_limit)', 'rate-limit drop recorded')
    clock += 5 * 60 * 1000 + 1
    const after = h.bus.send('ui', USER_AGENT_ID, dm('m11', 'ops'))
    assertEqual(statesFor(h, after.busSeq).join(','), 'ops:queued', 'window rolled, send allowed')
  })

  await runCase('autonomy budget: autonomous deliveries pause at cap, human-triggered still run, notice emitted once', async () => {
    const h = makeHarness()
    h.bus.setGuardConfig({ autonomousRoutingEnabled: true, autonomyBudgetPerHour: 1, perPairPerFiveMin: 100 })
    h.bus.send('agent', 'researcher', { id: 'a1', from: 'researcher', to: 'ops', kind: 'dm', body: 'x' })
    await h.settle()
    assertEqual(h.invoked.length, 1, 'first autonomous run allowed')
    h.bus.send('agent', 'researcher', { id: 'a2', from: 'researcher', to: 'ops', kind: 'dm', body: 'y' })
    await h.settle()
    assertEqual(h.invoked.length, 1, 'second autonomous run held (budget)')
    h.bus.send('ui', USER_AGENT_ID, dm('h1', 'researcher'))
    await h.settle()
    assertEqual(h.invoked.length, 2, 'human-triggered run unaffected by budget')
    const notices = h.bus
      .replay({ afterSeq: -1, limit: 500 })
      .records.filter((r) => r.type === 'envelope' && r.envelope.kind === 'system' && r.envelope.body.includes('budget'))
    assertEqual(notices.length, 1, 'budget exhaustion notice emitted exactly once')
    assertEqual(h.bus.guards.budgetStatus().usedThisHour, 1, 'budget accounting correct')
  })

  await runCase('queue cap: researcher maxQueueDepth=2 drops the 3rd queued message', async () => {
    const h = makeHarness() // routing off => everything queues
    h.bus.send('ui', USER_AGENT_ID, dm('m1', 'researcher'))
    h.bus.send('ui', USER_AGENT_ID, dm('m2', 'researcher'))
    const third = h.bus.send('ui', USER_AGENT_ID, dm('m3', 'researcher'))
    assertEqual(statesFor(h, third.busSeq).join(','), 'researcher:dropped(queue_full)', 'cap enforced')
  })

  await runCase('broadcast: per-recipient delivery updates carry targetAgentId', async () => {
    const h = makeHarness()
    const env = h.bus.send('ui', USER_AGENT_ID, { id: 'b1', from: USER_AGENT_ID, to: BROADCAST_ADDRESS, kind: 'broadcast', body: 'all hands' })
    const states = statesFor(h, env.busSeq).sort()
    assertEqual(states.join(','), 'ops:queued,researcher:queued', 'both recipients tracked separately')
  })

  await runCase('unknown agent: dropped(unknown_agent)', async () => {
    const h = makeHarness()
    const env = h.bus.send('ui', USER_AGENT_ID, dm('m1', 'nobody'))
    assertEqual(statesFor(h, env.busSeq).join(','), ':dropped(unknown_agent)', 'unknown target recorded')
  })

  await runCase('relay inbound: auto-registers sender, envelope lands, relay recipient drop is feed-visible', async () => {
    const h = makeHarness()
    const env = h.bus.handleRelayInbound({ sender: 'claude1', recipient: 'fable-builder', message: 'status?' })
    assertEqual(env.from, 'claude1', 'sender mapped to agentId')
    assertEqual(h.bus.registry.get('claude1')?.kind, 'relay', 'sender auto-registered')
    assertEqual(h.bus.registry.get('fable-builder')?.kind, 'relay', 'recipient auto-registered')
    assertEqual(statesFor(h, env.busSeq).join(','), 'fable-builder:dropped(relay_outbound_unwired)', 'outbound-unwired is explicit, not silent')
  })

  await runCase('reply linkage: parentSeq marks parent replied + inherits thread', async () => {
    const h = makeHarness()
    const parent = h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops'))
    const reply = h.bus.send('agent', 'ops', { id: 'r1', from: 'ops', to: USER_AGENT_ID, kind: 'dm', body: 'done' }, { parentSeq: parent.busSeq, triggeredByHuman: true })
    assertEqual(reply.replyToSeq, parent.busSeq, 'thread link set')
    assertEqual(statesFor(h, parent.busSeq).some((s) => s === 'ops:replied'), true, 'parent marked replied')
    assertEqual(reply.autonomous, false, 'human-triggered reply not counted autonomous')
  })

  await runCase('cursor replay: pagination is complete, ordered, and includes late deliveries', async () => {
    const h = makeHarness()
    for (let i = 0; i < 5; i++) h.bus.send('ui', USER_AGENT_ID, dm(`m${i}`, 'ops', `msg ${i}`))
    const page1 = h.bus.replay({ afterSeq: -1, limit: 4 })
    assertEqual(page1.records.length, 4, 'first page limited')
    const page2 = h.bus.replay({ afterSeq: page1.nextAfterSeq, limit: 500 })
    const total = page1.records.length + page2.records.length
    assertEqual(total, 10, 'all records paged exactly once (5 envelopes + 5 queued updates)')
    assertEqual(page2.latestSeq, 9, 'latestSeq exposed')
    // Late delivery for an OLD envelope must be visible to a caught-up cursor (the seq-field fix).
    const cursor = page2.nextAfterSeq
    h.bus.setGuardConfig({ autonomousRoutingEnabled: true })
    await h.settle()
    const late = h.bus.replay({ afterSeq: cursor, limit: 500 })
    assertEqual(
      late.records.some((r) => r.type === 'delivery' && r.update.refSeq <= cursor),
      true,
      'late updates for old envelopes visible after cursor',
    )
    assertEqual(
      late.records.every((r) => r.type !== 'envelope' || r.envelope.busSeq > cursor),
      true,
      'no envelopes duplicated (new ones after cursor are fine)',
    )
  })

  await runCase('crash recovery: torn final jsonl line is skipped, seq continues correctly', async () => {
    const h = makeHarness()
    h.bus.send('ui', USER_AGENT_ID, dm('m1', 'ops'))
    h.bus.send('ui', USER_AGENT_ID, dm('m2', 'ops'))
    const file = join(h.dir, 'bus.jsonl')
    appendFileSync(file, '{"type":"envelope","envelope":{"busSeq":99,"tr') // torn write
    const reopened = new JsonlBusStore(file)
    assertEqual(reopened.latestSeq(), 3, 'index rebuilt from intact lines only')
    assertEqual(reopened.nextSeq(), 4, 'seq continues after the last intact record')
    assertEqual(readFileSync(file, 'utf8').includes('"busSeq":99'), true, 'torn bytes untouched (no rewrite)')
  })

  await runCase('config persists across bus restarts', async () => {
    const h = makeHarness()
    h.bus.setGuardConfig({ autonomousRoutingEnabled: true, autonomyBudgetPerHour: 5 })
    const store2 = new JsonlBusStore(join(h.dir, 'bus.jsonl'))
    const registry2 = new AgentRegistry(join(h.dir, 'registry.json'))
    const bus2 = new ConversationBus(store2, registry2, join(h.dir, 'config.json'), null, now)
    assertEqual(bus2.getGuardConfig().autonomyBudgetPerHour, 5, 'config reloaded')
    assertEqual(registry2.get('ops')?.displayName, 'Ops', 'registry reloaded')
  })

  console.log('ALL PASS')
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
