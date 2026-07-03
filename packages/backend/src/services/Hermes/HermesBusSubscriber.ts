import type { ConversationBus } from '../ConversationBus/ConversationBus'
import type { HermesService } from './HermesService'

/**
 * HermesBusSubscriber — makes Hermes agents first-class, HEADLESS participants on the
 * AI-Lab ConversationBus (the autonomous inter-agent path). Mirrors how the Claude fleet
 * works (relay agents delivered out-of-band), but the "delivery" is: run the ACP turn and
 * post the reply back to the bus. Entirely server-side — no UI involved.
 *
 * Gating: only runs when the fleet kill switch `autonomousRoutingEnabled` is ON (same gate
 * the bus applies to local-agent delivery-triggered inference). Loop-safe via the bus's own
 * hopCount TTL (passed `parentSeq` → reply hopCount decrements) + per-pair rate guards + a
 * processed-seq dedup set. Humans drive Hermes agents directly via /api/hermes/*, regardless
 * of this switch.
 *
 * MVP scope: direct messages (`to` == a Hermes agent). Broadcasts to Hermes agents are
 * deferred (would fan out N turns).
 */
export class HermesBusSubscriber {
  private agentSet = new Set<string>()
  private readonly handled = new Set<number>()
  private syncTimer?: NodeJS.Timeout

  constructor(
    private readonly hermes: HermesService,
    private readonly bus: ConversationBus,
    private readonly opts: { syncIntervalMs?: number } = {},
  ) {}

  start(): void {
    void this.syncAgents()
    // The bus is an EventEmitter that fires 'record' on every appended record.
    ;(this.bus as unknown as { on: (e: string, cb: (rec: unknown) => void) => void }).on('record', (rec) => {
      const r = rec as { type?: string; envelope?: BusEnvelopeLike }
      if (r?.type === 'envelope' && r.envelope) void this.onEnvelope(r.envelope)
    })
    this.syncTimer = setInterval(() => void this.syncAgents(), this.opts.syncIntervalMs ?? 30_000)
    this.syncTimer.unref?.()
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer)
  }

  /** Refresh the Hermes profile set and register any new ones on the bus registry (relay kind). */
  private async syncAgents(): Promise<void> {
    let agents: string[]
    try {
      agents = await this.hermes.listAgents()
    } catch {
      return
    }
    this.agentSet = new Set(agents)
    const registry = (this.bus as unknown as { registry?: BusRegistryLike }).registry
    if (!registry) return
    for (const id of agents) {
      try {
        if (!registry.get(id)) {
          registry.upsert({ agentId: id, displayName: id, kind: 'relay', relayRecipient: id, enabled: true })
        }
      } catch {
        /* invalid id / already exists — non-fatal */
      }
    }
  }

  private async onEnvelope(env: BusEnvelopeLike): Promise<void> {
    if (env.kind === 'system') return
    if (!this.agentSet.has(env.to)) return // not a Hermes agent (also skips 'broadcast')
    if (env.from === env.to) return
    if (this.handled.has(env.busSeq)) return
    // Kill switch: autonomous cross-agent inference only runs when explicitly enabled.
    try {
      if (!this.bus.getGuardConfig().autonomousRoutingEnabled) return
    } catch {
      return
    }
    this.handled.add(env.busSeq)

    const reply = await this.runSafe(env.to, env.body)
    try {
      this.bus.send(
        'agent',
        env.to,
        {
          id: `hermes-${env.busSeq}-${Date.now()}`,
          from: env.to,
          to: env.from,
          kind: 'dm',
          body: reply,
          replyToSeq: env.busSeq,
        },
        { parentSeq: env.busSeq },
      )
    } catch (e) {
      console.warn('[HermesBusSubscriber] reply send failed:', (e as Error).message)
    }
  }

  private async runSafe(agentId: string, text: string): Promise<string> {
    try {
      const { reply } = await this.hermes.runTurn(agentId, text)
      return reply || '(no reply)'
    } catch (e) {
      return `[hermes error: ${(e as Error).message}]`
    }
  }
}

interface BusEnvelopeLike {
  busSeq: number
  from: string
  to: string
  kind: string
  body: string
}

interface BusRegistryLike {
  get(agentId: string): unknown
  upsert(entry: unknown): unknown
}
