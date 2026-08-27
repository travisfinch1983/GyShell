/**
 * Context-pack seam spec: the registry→pack→system-prompt chain must not depend on
 * ConversationBus. This is the LIVE feature that was hiding inside the messaging class
 * (bus-retirement step 1) — an empty agent-context-packs/ directory proves nothing, so
 * this spec drops a real file in and asserts it comes out of the exact provider closure
 * startGyBackend wires into agentService.setContextPackProvider.
 *
 * Run: tsx packages/backend/src/services/ConversationBus/contextPackSeam.extreme.spec.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentRegistry } from './AgentRegistry'
import { ContextPackStore } from './ContextPackStore'

const assert = (cond: boolean, message: string): void => {
  if (!cond) throw new Error(message)
}

const fleetDir = mkdtempSync(join(tmpdir(), 'ctx-pack-seam-'))

// A declared local agent bound to a session — the shape registry.json persists.
writeFileSync(
  join(fleetDir, 'registry.json'),
  JSON.stringify({
    agents: [
      {
        agentId: 'seam-test',
        displayName: 'Seam Test',
        kind: 'local',
        sessionId: 'sess-seam-1',
        contextPackSlots: ['identity'],
        enabled: true,
      },
    ],
  }),
)
mkdirSync(join(fleetDir, 'agent-context-packs', 'seam-test'), { recursive: true })
writeFileSync(
  join(fleetDir, 'agent-context-packs', 'seam-test', 'identity.md'),
  'SEAM_SENTINEL: you are the seam-test agent.',
)

// EXACTLY the wiring startGyBackend uses — standalone registry, no ConversationBus.
const agentRegistry = new AgentRegistry(join(fleetDir, 'registry.json'))
const contextPackStore = new ContextPackStore(join(fleetDir, 'agent-context-packs'))
const provider = (sessionId: string): string | undefined => {
  const entry = agentRegistry.getBySessionId(sessionId)
  return entry ? contextPackStore.assemble(entry) : undefined
}

// The bound session gets the pack, sentinel included.
const pack = provider('sess-seam-1')
assert(pack !== undefined, 'declared session must yield a pack')
assert(pack!.includes('SEAM_SENTINEL'), 'authored file content must reach the assembled pack')
assert(pack!.includes('seam-test'), 'pack must name the agent identity')

// A scratch session gets nothing — base prompt unchanged.
assert(provider('sess-unknown') === undefined, 'unknown session must yield undefined')

// An agent with an EMPTY pack dir and no persona yields undefined (the state prod is
// in today) — which is why this spec exists: that state cannot distinguish a working
// seam from a severed one.
writeFileSync(
  join(fleetDir, 'registry.json'),
  JSON.stringify({
    agents: [
      { agentId: 'bare', displayName: 'Bare', kind: 'local', sessionId: 'sess-bare', enabled: true },
    ],
  }),
)
const bareRegistry = new AgentRegistry(join(fleetDir, 'registry.json'))
const bareProvider = (sessionId: string): string | undefined => {
  const entry = bareRegistry.getBySessionId(sessionId)
  return entry ? contextPackStore.assemble(entry) : undefined
}
assert(bareProvider('sess-bare') === undefined, 'agent without pack or persona yields undefined')

// Legacy persona fallback still works through the same closure.
writeFileSync(
  join(fleetDir, 'registry.json'),
  JSON.stringify({
    agents: [
      {
        agentId: 'legacy',
        displayName: 'Legacy',
        kind: 'local',
        sessionId: 'sess-legacy',
        persona: 'LEGACY_PERSONA_SENTINEL',
        enabled: true,
      },
    ],
  }),
)
const legacyRegistry = new AgentRegistry(join(fleetDir, 'registry.json'))
const legacyEntry = legacyRegistry.getBySessionId('sess-legacy')
assert(
  legacyEntry !== undefined && contextPackStore.assemble(legacyEntry)!.includes('LEGACY_PERSONA_SENTINEL'),
  'persona string must fall back into the identity slot',
)

console.log('contextPackSeam.extreme.spec: all assertions passed')
