import type { AgentRegistryEntry, AutonomyBudgetStatus, FleetGuardConfig } from '@gyshell/shared'

export type GuardVerdict = { allow: true } | { allow: false; reason: string }

const HOUR_MS = 60 * 60 * 1000
const FIVE_MIN_MS = 5 * 60 * 1000

/**
 * Broker-enforced loop guards (doc R1.2 — MANDATORY): hop TTL, per-pair rate
 * limit, and the rolling-hour autonomy budget. Pure in-memory state with an
 * injectable clock so every guard is unit-testable. Guard state deliberately
 * does NOT persist across restarts — a restart resets rate windows, which is
 * the safe direction (never under-counts within a running process).
 */
export class GuardEngine {
  private pairSends = new Map<string, number[]>() // "from->to" -> send timestamps
  private autonomousRuns: Array<{ agentId: string; ts: number }> = []

  constructor(
    private readonly getConfig: () => FleetGuardConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Send-time guard: hop TTL (0 = exhausted) + per-pair rolling rate limit. */
  checkSend(from: string, to: string, hopCount: number): GuardVerdict {
    if (hopCount <= 0) return { allow: false, reason: 'hop_ttl' }
    const key = `${from}->${to}`
    const cutoff = this.now() - FIVE_MIN_MS
    const recent = (this.pairSends.get(key) ?? []).filter((t) => t > cutoff)
    this.pairSends.set(key, recent)
    if (recent.length >= this.getConfig().perPairPerFiveMin) {
      return { allow: false, reason: 'pair_rate_limit' }
    }
    return { allow: true }
  }

  notePairSend(from: string, to: string): void {
    const key = `${from}->${to}`
    const list = this.pairSends.get(key)
    if (list) list.push(this.now())
    else this.pairSends.set(key, [this.now()])
  }

  /** Delivery-time guard: kill switch + fleet/per-agent autonomy budget. */
  checkAutonomousDelivery(agent: AgentRegistryEntry): GuardVerdict {
    const config = this.getConfig()
    if (!config.autonomousRoutingEnabled) return { allow: false, reason: 'kill_switch' }
    this.pruneRuns()
    if (this.autonomousRuns.length >= config.autonomyBudgetPerHour) {
      return { allow: false, reason: 'autonomy_budget' }
    }
    const perAgentCap = agent.limits?.maxAutonomousPerHour
    if (perAgentCap !== undefined) {
      const agentRuns = this.autonomousRuns.filter((r) => r.agentId === agent.agentId).length
      if (agentRuns >= perAgentCap) return { allow: false, reason: 'autonomy_budget' }
    }
    return { allow: true }
  }

  noteAutonomousRun(agentId: string): void {
    this.autonomousRuns.push({ agentId, ts: this.now() })
  }

  budgetStatus(): AutonomyBudgetStatus {
    this.pruneRuns()
    const config = this.getConfig()
    const oldest = this.autonomousRuns[0]
    return {
      usedThisHour: this.autonomousRuns.length,
      budgetPerHour: config.autonomyBudgetPerHour,
      windowResetsAt: oldest ? new Date(oldest.ts + HOUR_MS).toISOString() : undefined,
    }
  }

  private pruneRuns(): void {
    const cutoff = this.now() - HOUR_MS
    this.autonomousRuns = this.autonomousRuns.filter((r) => r.ts > cutoff)
  }
}
