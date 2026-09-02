/**
 * Task Progress registry — the one place a running long task in AI-Lab is visible from
 * any page (Travis, 2026-09-02). Sources report here (in-process hook or POST
 * /api/notifications/task) instead of each page growing its own progress strip; the
 * notifications panel renders the registry and the bell carries a running-count pip.
 *
 * Three rules:
 *  - EPHEMERAL, deliberately: a task is a live process, and a restart of this backend
 *    kills or orphans what it was watching. Pollers re-discover their tasks; nothing
 *    here pretends to remember progress it can no longer verify.
 *  - A finished task lingers 30s at its final state, then clears itself. Failures
 *    linger the same way — the panel's Warnings section is where a failure that needs
 *    ACTION goes (the reporter decides); this registry is a progress meter, not an
 *    alarm channel.
 *  - Broadcasts are throttled (1/s), updates are not: a GPU tagger reporting per-image
 *    at 10 img/s must not turn the gateway into a firehose, but the stored state is
 *    always current for anyone who polls.
 */

export interface TaskEntry {
  /** Stable key, '<source>:<jobId>'. Re-reporting an id updates the row. */
  id: string
  source: string
  label: string
  state: 'running' | 'done' | 'failed'
  done: number
  total: number
  /** Derived from done/total when total > 0, or reported directly; null = indeterminate. */
  percent: number | null
  detail?: string
  /** Who wrote the row last: 'reporter' (something that KNOWS — a launcher, an in-process
   *  hook) or 'poller' (something that INFERS from artifacts). A knower's fresh row must
   *  not be overwritten by an inferrer — see loraRunsPoller. */
  origin?: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
}

export interface TaskReportInput {
  id: string
  source?: string
  label?: string
  state?: 'running' | 'done' | 'failed'
  done?: number
  total?: number
  percent?: number
  detail?: string
  origin?: string
}

const FINISHED_LINGER_MS = 30_000
const BROADCAST_MIN_INTERVAL_MS = 1_000
const TASK_CAP = 50 // a registry this size means a reporter is leaking ids, not working

export class TaskProgress {
  private tasks = new Map<string, TaskEntry>()
  private clearTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastBroadcast = 0
  private trailing: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly broadcast: (channel: string, data?: unknown) => void) {}

  report(input: TaskReportInput): TaskEntry | null {
    const id = String(input.id || '').slice(0, 200)
    if (!id) return null
    const now = new Date().toISOString()
    let t = this.tasks.get(id)
    if (!t) {
      if (this.tasks.size >= TASK_CAP) {
        // Evict the oldest FINISHED task first; if all 50 are running, refuse — a wall
        // of running tasks is a reporter bug and silently dropping the newest hides it
        // least badly (the reporter still has its own state).
        const finished = [...this.tasks.values()].find((e) => e.state !== 'running')
        if (finished) this.remove(finished.id)
        else return null
      }
      t = {
        id, source: 'unknown', label: id, state: 'running',
        done: 0, total: 0, percent: null, startedAt: now, updatedAt: now,
      }
      this.tasks.set(id, t)
    }
    t.origin = input.origin === undefined ? 'reporter' : String(input.origin).slice(0, 20)
    if (input.source !== undefined) t.source = String(input.source).slice(0, 60)
    if (input.label !== undefined) t.label = String(input.label).slice(0, 160)
    if (input.detail !== undefined) t.detail = String(input.detail).slice(0, 400)
    if (input.done !== undefined && Number.isFinite(Number(input.done))) t.done = Math.max(0, Number(input.done))
    if (input.total !== undefined && Number.isFinite(Number(input.total))) t.total = Math.max(0, Number(input.total))
    if (input.percent !== undefined && Number.isFinite(Number(input.percent))) {
      t.percent = Math.min(100, Math.max(0, Number(input.percent)))
    } else if (t.total > 0) {
      t.percent = Math.min(100, Math.round((t.done / t.total) * 100))
    }
    const nextState = input.state && ['running', 'done', 'failed'].includes(input.state) ? input.state : t.state
    if (nextState !== 'running' && t.state === 'running') {
      t.finishedAt = now
      if (nextState === 'done' && t.percent !== null) t.percent = 100
      this.scheduleClear(id)
    } else if (nextState === 'running' && t.state !== 'running') {
      // The same id came back to life (a retried job): cancel the pending clear.
      t.finishedAt = undefined
      const timer = this.clearTimers.get(id)
      if (timer) { clearTimeout(timer); this.clearTimers.delete(id) }
    }
    t.state = nextState
    t.updatedAt = now
    this.broadcastThrottled()
    return t
  }

  /** Drop a task immediately (poller saw its subject vanish, or linger expired). */
  remove(id: string): void {
    const timer = this.clearTimers.get(id)
    if (timer) { clearTimeout(timer); this.clearTimers.delete(id) }
    if (this.tasks.delete(id)) this.broadcastThrottled()
  }

  state(): { tasks: TaskEntry[]; running: number } {
    const tasks = [...this.tasks.values()]
    return { tasks, running: tasks.filter((t) => t.state === 'running').length }
  }

  private scheduleClear(id: string): void {
    const old = this.clearTimers.get(id)
    if (old) clearTimeout(old)
    const timer = setTimeout(() => { this.clearTimers.delete(id); this.remove(id) }, FINISHED_LINGER_MS)
    timer.unref?.()
    this.clearTimers.set(id, timer)
  }

  private broadcastThrottled(): void {
    const since = Date.now() - this.lastBroadcast
    if (since >= BROADCAST_MIN_INTERVAL_MS) {
      this.lastBroadcast = Date.now()
      this.broadcast('notify:tasks', this.state())
    } else if (!this.trailing) {
      // Trailing edge: the LAST update in a burst must always ship, or a task could
      // finish inside the throttle window and the panel would show 96% forever.
      this.trailing = setTimeout(() => {
        this.trailing = null
        this.lastBroadcast = Date.now()
        this.broadcast('notify:tasks', this.state())
      }, BROADCAST_MIN_INTERVAL_MS - since)
      this.trailing.unref?.()
    }
  }
}
