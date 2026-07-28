import type { ConversationBus } from '../ConversationBus/ConversationBus'
import type { HermesAcpBridge } from './HermesAcpBridge'

/**
 * HermesActivityReporter — the Hermes half of fleet activity ("is this agent
 * actually working?"), counterpart to the transcript tailer that reports for
 * Claude Code instances on CT180.
 *
 * This one is in-process rather than a daemon, because the ACP bridge lives
 * here and already holds everything needed: server-authoritative per-session
 * `status` (busy on prompt, idle on turn_done/exit) and a seq-stamped event
 * ring. So unlike the Claude Code side — which infers from a transcript whose
 * writes LAG during a long turn — this side can answer precisely.
 *
 * Reports only agents with a LIVE session. An agent with no session is left
 * absent so the bus reports `unknown` (nothing observed) rather than inventing
 * `idle`, which would read as "fine" when it means "no idea".
 */
export class HermesActivityReporter {
  private timer?: NodeJS.Timeout

  /** The ACP ring is in-memory, so it is empty after an ai-lab restart until the
   *  agent next acts. Treat a session with no describable events as unknown. */
  constructor(
    private readonly bridge: HermesAcpBridge,
    private readonly bus: ConversationBus,
    private readonly opts: { intervalMs?: number; midTurnGraceMs?: number } = {},
  ) {}

  start(): void {
    const every = this.opts.intervalMs ?? 5_000
    this.tick()
    this.timer = setInterval(() => this.tick(), every)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private tick(): void {
    let rows: ReturnType<HermesAcpBridge['listAgentActivity']>
    try {
      rows = this.bridge.listAgentActivity()
    } catch (e) {
      console.warn('[HermesActivityReporter] listAgentActivity failed:', (e as Error).message)
      return
    }

    const now = Date.now()
    const grace = this.opts.midTurnGraceMs ?? 45_000
    for (const r of rows) {
      const idleMs = Math.max(0, now - (r.lastActivity || now))
      const last = r.lastEvent

      // `busy` is authoritative: the bridge sets it on prompt and clears it on
      // turn_done, so a long tool call reads as working rather than stalled.
      // Only call it stalled when the bridge still thinks a turn is running but
      // nothing has happened for far longer than a turn should take.
      let state: 'working' | 'idle-awaiting-input' | 'stalled' | 'unknown'
      if (!last) state = 'unknown'
      else if (r.status === 'busy') state = idleMs < grace ? 'working' : 'stalled'
      else state = 'idle-awaiting-input'

      try {
        this.bus.recordActivity({
          agentId: r.agentId,
          kind: 'hermes',
          state,
          idleSeconds: Math.round(idleMs / 100) / 10,
          lastEventKind:
            last?.t === 'tool_start' ? 'tool'
            : last?.t === 'message' ? 'text'
            : last?.t === 'turn_done' ? 'turn_end'
            : last ? 'text' : 'none',
          lastEventSummary: last?.summary ?? 'no describable events yet (ring empty since restart)',
          lastEventAt: new Date(r.lastActivity || now).toISOString(),
          ref: last?.seq != null ? `acp:${r.agentId}#${last.seq}` : `acp:${r.agentId}`,
          observedAt: new Date(now).toISOString(),
          ...(r.recent.length ? { recent: r.recent } : {}),
        })
      } catch (e) {
        console.warn(`[HermesActivityReporter] recordActivity failed for ${r.agentId}:`, (e as Error).message)
      }
    }
  }
}
