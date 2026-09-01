import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/**
 * Which alarms are already announced — PERSISTED across process restarts.
 *
 * Every alarmed-set in this codebase started as an in-memory Set, which meant each
 * `ai-lab.service` restart re-announced every still-true condition. A dev day can produce ~28
 * restarts, each re-reporting faults that had not changed. Nothing new had happened; the
 * observer had simply forgotten. **A notification must describe a change in the WORLD, not a
 * change in the watcher.**
 *
 * Three rules, learned the hard way and enforced here so no caller has to remember them:
 *
 * 1. **Keyed on `subject:conditionClass`, never subject alone.** An agent whose stale-set clears
 *    but whose server is still parked has genuinely changed state; one latch per subject would
 *    either hide the new condition or re-fire the old one.
 * 2. **Cleared only on POSITIVE evidence of health.** Absence of evidence must never retract an
 *    alarm — an unreadable log once emitted "recovered" and un-warned the reader.
 * 3. **Re-announce after a window** so a long-standing fault does not go silent forever, and say
 *    plainly that it is a restatement — repetition presented as news is its own kind of lie.
 */
export interface AlarmRecord { firstSeen: number; lastNotified: number }

export const DEFAULT_REANNOUNCE_MS = 7 * 24 * 3600_000

export class AlarmLatch {
  private map: Record<string, AlarmRecord> = {}
  private dirty = false

  constructor(
    private readonly path: string,
    private readonly reannounceMs: number = DEFAULT_REANNOUNCE_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      this.map = (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, AlarmRecord>) || {}
    } catch {
      // An unreadable latch must never stop the sweep that uses it. Worst case is one
      // duplicate announcement, which is strictly better than a skipped check.
      this.map = {}
    }
  }

  private key(subject: string, cls: string): string { return `${subject}:${cls}` }

  has(subject: string, cls: string): boolean { return !!this.map[this.key(subject, cls)] }

  /** Any of `classes` currently latched for this subject. */
  anyOpen(subject: string, classes: string[]): boolean {
    return classes.some((c) => this.has(subject, c))
  }

  /**
   * Should this condition be announced now? Records the announcement if so.
   * @returns `null` when suppressed, otherwise a suffix to append to the detail — empty for a
   *          genuinely new condition, or a sentence marking it as a restatement.
   */
  claim(subject: string, cls: string): string | null {
    const k = this.key(subject, cls)
    const prev = this.map[k]
    const t = this.now()
    if (prev && t - prev.lastNotified < this.reannounceMs) return null
    this.map[k] = { firstSeen: prev?.firstSeen ?? t, lastNotified: t }
    this.dirty = true
    if (!prev) return ''
    const since = new Date(prev.firstSeen).toISOString().slice(0, 16).replace('T', ' ')
    return ` Unchanged since ${since} — re-stated because it is still true, not because it is new.`
  }

  /** Clear these classes for a subject. Call ONLY with positive evidence. @returns those cleared. */
  clear(subject: string, classes: string[]): string[] {
    const gone: string[] = []
    for (const c of classes) {
      const k = this.key(subject, c)
      if (this.map[k]) { delete this.map[k]; gone.push(c); this.dirty = true }
    }
    return gone
  }

  /**
   * Drop every entry whose subject is not in `keep`.
   *
   * This is NOT evidence of health. It is evidence that the SUBJECT NO LONGER EXISTS, which is a
   * third kind of fact and the reason a recreated subject must start clean: without it, an agent
   * deleted and recreated under the same id inherits the old one's latch, and a genuine FIRST
   * fault on the new agent is suppressed until the re-announce window expires.
   *
   * ⚠ CALLER CONTRACT: pass a roster you TRUST — one whose enumeration THREW on failure rather
   * than returning an empty list. Handed a best-effort roster, this would read a failed
   * enumeration as "every subject is gone" and silently wipe every open alarm, which is the
   * catch-to-empty-list family that strict enumeration exists to prevent.
   *
   * @returns the keys removed.
   */
  pruneSubjects(keep: string[]): string[] {
    const alive = new Set(keep)
    const removed: string[] = []
    for (const k of Object.keys(this.map)) {
      // Split on the LAST colon: subjects may legitimately contain one.
      const i = k.lastIndexOf(':')
      const subject = i < 0 ? k : k.slice(0, i)
      if (!alive.has(subject)) { delete this.map[k]; removed.push(k); this.dirty = true }
    }
    return removed
  }

  /** Persist if anything changed. Cheap no-op otherwise. */
  save(): void {
    if (!this.dirty) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.map, null, 2))
      this.dirty = false
    } catch (e) {
      console.warn(`[alarm-latch] could not persist ${this.path}: ${String((e as Error)?.message ?? e)}`)
    }
  }
}
