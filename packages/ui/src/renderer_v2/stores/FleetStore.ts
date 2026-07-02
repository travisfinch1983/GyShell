import { makeAutoObservable, runInAction } from 'mobx'
import type {
  AgentRegistryEntry,
  AgentStatus,
  AutonomyBudgetStatus,
  BusDeliveryUpdate,
  BusEnvelope,
  BusRecord,
  FleetGuardConfig,
} from '@gyshell/shared'

function bridge(): any {
  return (window as any).gyshell?.fleet
}

/** Keep at most this many records in memory; older ones stay on the backend log. */
const MAX_RECORDS = 1500

/**
 * Renderer store for the ConversationBus: cursor-replays the log on load,
 * live-tails fleet:record broadcasts, and exposes fleet status (agents,
 * presence, guard config, autonomy budget) for the Fleet Feed panel.
 */
class FleetStore {
  envelopes: BusEnvelope[] = []
  deliveriesByRef = new Map<number, BusDeliveryUpdate[]>()
  agents: AgentRegistryEntry[] = []
  statuses: AgentStatus[] = []
  guardConfig: FleetGuardConfig | null = null
  budget: AutonomyBudgetStatus | null = null
  loaded = false
  available = true
  filter: 'all' | 'agents' | 'system' = 'all'

  private cursor = -1
  private loading: Promise<void> | null = null
  private unsubscribe: (() => void) | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    makeAutoObservable(this)
  }

  get visibleEnvelopes(): BusEnvelope[] {
    switch (this.filter) {
      case 'agents':
        return this.envelopes.filter((e) => e.from !== 'user' && e.kind !== 'system')
      case 'system':
        return this.envelopes.filter((e) => e.kind === 'system')
      default:
        return this.envelopes
    }
  }

  latestDelivery(busSeq: number): BusDeliveryUpdate[] {
    // Latest state per target (a broadcast has one lifecycle per recipient).
    const updates = this.deliveriesByRef.get(busSeq) ?? []
    const byTarget = new Map<string, BusDeliveryUpdate>()
    for (const u of updates) byTarget.set(u.targetAgentId ?? '', u)
    return [...byTarget.values()]
  }

  /** Idempotent — subscribe first so records arriving during replay are not lost. */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (!this.loading) {
      this.loading = (async () => {
        const fleet = bridge()
        if (!fleet) {
          runInAction(() => {
            this.available = false
            this.loaded = true
          })
          return
        }
        const buffered: BusRecord[] = []
        let replaying = true
        this.unsubscribe = fleet.onRecord((record: BusRecord) => {
          if (replaying) buffered.push(record)
          else this.ingest(record)
        })
        try {
          // Page from the start (feed is small at homelab scale; MAX_RECORDS bounds memory).
          let afterSeq = -1
          for (;;) {
            const page = await fleet.replay(afterSeq, 500)
            runInAction(() => page.records.forEach((r: BusRecord) => this.ingest(r)))
            if (page.nextAfterSeq === afterSeq || page.records.length === 0) break
            afterSeq = page.nextAfterSeq
            if (afterSeq >= page.latestSeq) break
          }
          await this.refreshStatus()
        } catch (err) {
          console.warn('[FleetStore] load failed:', err)
          runInAction(() => {
            this.available = false
          })
        } finally {
          replaying = false
          runInAction(() => {
            buffered.forEach((r) => this.ingest(r))
            this.loaded = true
          })
          this.statusTimer = setInterval(() => void this.refreshStatus(), 30_000)
        }
      })()
    }
    return this.loading
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null
  }

  private ingest(record: BusRecord): void {
    if (record.type === 'envelope') {
      const seq = record.envelope.busSeq
      if (seq <= this.cursor) return // replay/live overlap dedup
      this.cursor = Math.max(this.cursor, seq)
      this.envelopes.push(record.envelope)
      if (this.envelopes.length > MAX_RECORDS) this.envelopes.splice(0, this.envelopes.length - MAX_RECORDS)
    } else {
      const u = record.update
      if (u.seq <= this.cursor) return
      this.cursor = Math.max(this.cursor, u.seq)
      const list = this.deliveriesByRef.get(u.refSeq)
      if (list) list.push(u)
      else this.deliveriesByRef.set(u.refSeq, [u])
      // Delivery lifecycle changes presence/queue depth — refresh opportunistically.
      void this.refreshStatus()
    }
  }

  async refreshStatus(): Promise<void> {
    const fleet = bridge()
    if (!fleet) return
    try {
      const status = await fleet.status()
      runInAction(() => {
        this.agents = status.agents ?? []
        this.statuses = status.statuses ?? []
        this.guardConfig = status.guardConfig ?? null
        this.budget = status.budget ?? null
      })
    } catch {
      /* transient — next poll retries */
    }
  }

  setFilter(filter: 'all' | 'agents' | 'system'): void {
    this.filter = filter
  }

  async send(to: string, body: string): Promise<void> {
    const fleet = bridge()
    if (!fleet || !body.trim()) return
    const kind = to === 'broadcast' ? 'broadcast' : 'dm'
    await fleet.send({ id: crypto.randomUUID(), from: 'user', to, kind, body: body.trim() })
    await this.refreshStatus()
  }

  /** F1 kill switch — flips delivery-triggered inference fleet-wide. */
  async setAutonomousRouting(enabled: boolean): Promise<void> {
    const fleet = bridge()
    if (!fleet) return
    const config = await fleet.setGuardConfig({ autonomousRoutingEnabled: enabled })
    runInAction(() => {
      this.guardConfig = config
    })
  }
}

export const fleetStore = new FleetStore()
