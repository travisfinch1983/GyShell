import { USER_AGENT_ID, type FleetGuardConfig } from '@gyshell/shared'
import type { ConversationBus } from './ConversationBus'

/**
 * RPC surface the WebSocket/IPC gateway exposes to renderers. UI sends are
 * pinned to the user identity here — the renderer cannot pick an arbitrary
 * `from` (broker-enforced identity, doc R1.1 guardrail).
 */
export interface FleetBridge {
  send(request: unknown): unknown
  replay(request: unknown): unknown
  status(): unknown
  setGuardConfig(patch: unknown): unknown
}

export function createFleetBridge(bus: ConversationBus): FleetBridge {
  return {
    send(request: unknown) {
      return bus.send('ui', USER_AGENT_ID, request, { triggeredByHuman: true })
    },
    replay(request: unknown) {
      return bus.replay(request)
    },
    status() {
      return {
        agents: bus.registry.list(),
        statuses: bus.agentStatuses(),
        guardConfig: bus.getGuardConfig(),
        budget: bus.guards.budgetStatus(),
        latestSeq: bus.replay({ afterSeq: -1, limit: 1 }).latestSeq,
      }
    },
    setGuardConfig(patch: unknown) {
      // Renderer patches are narrowed to known keys; schema-validated in setGuardConfig.
      return bus.setGuardConfig((patch ?? {}) as Partial<FleetGuardConfig>)
    },
  }
}
