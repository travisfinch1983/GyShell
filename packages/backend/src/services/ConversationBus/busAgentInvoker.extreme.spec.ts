/** BusAgentInvoker spec: lazy session provisioning, never-preempt busy wait, reply extraction. */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BusEnvelope } from '@gyshell/shared'
import { createBusAgentInvoker, composeBatchInput, type BusGateway } from './BusAgentInvoker'
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

const envelope = (busSeq: number, from: string, body: string): BusEnvelope => ({
  busSeq,
  id: `e${busSeq}`,
  ts: '2026-07-02T06:00:00Z',
  from,
  to: 'ops',
  kind: 'dm',
  body,
  hopCount: 3,
  autonomous: false,
  origin: 'ui',
})

function makeFakeGateway() {
  const calls: string[] = []
  let status = 'idle'
  let waiters: Array<() => void> = []
  const gateway: BusGateway = {
    async createSession() {
      calls.push('createSession')
      return 'sess-new'
    },
    getSession(_sessionId: string) {
      return { status }
    },
    async waitForRunCompletion(_sessionId: string) {
      calls.push('wait')
      await new Promise<void>((r) => waiters.push(r))
    },
    async dispatchFromBus(sessionId: string, input: string) {
      calls.push(`dispatch:${sessionId}:${input.slice(0, 20)}`)
    },
  }
  return {
    gateway,
    calls,
    setStatus: (s: string) => {
      status = s
    },
    releaseWaiters: () => {
      const w = waiters
      waiters = []
      w.forEach((r) => r())
    },
  }
}

async function main(): Promise<void> {
  await runCase('lazy session provisioning writes back to registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-'))
    const registry = new AgentRegistry(join(dir, 'registry.json'))
    registry.upsert({ agentId: 'ops', displayName: 'Ops', kind: 'local', enabled: true })
    const fake = makeFakeGateway()
    const invoker = createBusAgentInvoker({
      gateway: fake.gateway,
      registry,
      loadLastAssistantText: () => 'the reply',
    })
    const result = await invoker.runTurn(registry.get('ops')!, [envelope(0, 'user', 'hi')])
    assertEqual(registry.get('ops')?.sessionId, 'sess-new', 'sessionId persisted')
    assertEqual(fake.calls[0], 'createSession', 'session created first')
    assertEqual((result as { replyBody?: string }).replyBody, 'the reply', 'reply extracted')
    // Second run reuses the session
    await invoker.runTurn(registry.get('ops')!, [envelope(1, 'user', 'again')])
    assertEqual(fake.calls.filter((c) => c === 'createSession').length, 1, 'no re-provisioning')
  })

  await runCase('busy session: waits for idle, never preempts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-'))
    const registry = new AgentRegistry(join(dir, 'registry.json'))
    registry.upsert({ agentId: 'ops', displayName: 'Ops', kind: 'local', enabled: true, sessionId: 'sess-1' })
    const fake = makeFakeGateway()
    fake.setStatus('running')
    const invoker = createBusAgentInvoker({
      gateway: fake.gateway,
      registry,
      loadLastAssistantText: () => null,
    })
    const turn = invoker.runTurn(registry.get('ops')!, [envelope(0, 'user', 'hi')])
    await new Promise((r) => setTimeout(r, 10))
    assertEqual(fake.calls.includes('wait'), true, 'waited on busy session')
    assertEqual(fake.calls.some((c) => c.startsWith('dispatch')), false, 'did NOT dispatch while busy')
    fake.setStatus('idle')
    fake.releaseWaiters()
    await turn
    assertEqual(fake.calls.some((c) => c.startsWith('dispatch:sess-1')), true, 'dispatched after idle')
  })

  await runCase('batch composition mentions count and senders', () => {
    const text = composeBatchInput([envelope(0, 'user', 'first'), envelope(1, 'claude1', 'second')])
    assertEqual(text.includes('2 fleet messages'), true, 'count present')
    assertEqual(text.includes('@user') && text.includes('@claude1'), true, 'senders present')
    assertEqual(text.includes('first') && text.includes('second'), true, 'bodies present')
  })

  console.log('ALL PASS')
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
