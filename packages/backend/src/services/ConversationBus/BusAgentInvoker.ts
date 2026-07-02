import type { AgentRegistryEntry, BusEnvelope } from '@gyshell/shared'
import type { AgentInvoker } from './ConversationBus'
import type { AgentRegistry } from './AgentRegistry'

/**
 * The slice of GatewayService the invoker needs (kept structural so the spec
 * can fake it). dispatchFromBus resolves when the turn COMPLETES.
 */
export interface BusGateway {
  createSession(): Promise<string>
  getSession(sessionId: string): { status: string } | undefined
  waitForRunCompletion(sessionId: string): Promise<unknown>
  dispatchFromBus(sessionId: string, input: string): Promise<void>
}

/** Format a delivery batch as one user turn on the agent's session. */
export function composeBatchInput(batch: BusEnvelope[]): string {
  const header =
    batch.length === 1
      ? '[ConversationBus] You received a fleet message. Reply normally — your response is routed back to the sender.'
      : `[ConversationBus] You received ${batch.length} fleet messages while busy. Reply normally — your response is routed back to the most recent sender.`
  const lines = batch.map((e) => `— from @${e.from} (#${e.busSeq}, ${e.ts}):\n${e.body}`)
  return `${header}\n\n${lines.join('\n\n')}`
}

/**
 * Real AgentInvoker: bridges the bus's pump to GatewayService.dispatchFromBus
 * (claude1's seam, resolves at turn completion). Provisions the agent's stable
 * session lazily, and — because dispatchTask ABORTS a non-idle session's run —
 * waits for idle before dispatching so a bus delivery can never cancel a
 * human's in-flight turn on that session.
 */
export function createBusAgentInvoker(deps: {
  gateway: BusGateway
  registry: AgentRegistry
  /** Read the last assistant message text of a session's transcript (for the reply envelope). */
  loadLastAssistantText: (sessionId: string) => string | null
}): AgentInvoker {
  const { gateway, registry, loadLastAssistantText } = deps

  return {
    async runTurn(agent: AgentRegistryEntry, batch: BusEnvelope[]) {
      let sessionId = agent.sessionId
      if (!sessionId) {
        sessionId = await gateway.createSession()
        registry.setSessionId(agent.agentId, sessionId)
      }

      // Never preempt: dispatchTask aborts non-idle sessions, so wait until the
      // session is genuinely idle (bounded — a wedged run should not wedge the bus).
      const deadline = Date.now() + 10 * 60 * 1000
      while (gateway.getSession(sessionId) && gateway.getSession(sessionId)!.status !== 'idle') {
        if (Date.now() > deadline) throw new Error(`session ${sessionId} busy for >10min, giving up`)
        await gateway.waitForRunCompletion(sessionId)
      }

      await gateway.dispatchFromBus(sessionId, composeBatchInput(batch))

      const replyBody = loadLastAssistantText(sessionId)
      return { replyBody: replyBody ?? undefined }
    },
  }
}
