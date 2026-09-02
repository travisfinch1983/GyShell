/**
 * LoRA training → Task Progress. Watches the run registry the MCP train_lora tool
 * maintains (/imagegen/lora_runs/<run_id>/{run.json,train.log}) — both trainers
 * (kohya, ai-toolkit) record here, and the shared mount makes progress readable from
 * CT152 with NO ssh: run.json for identity, the tqdm log tail for steps/loss.
 *
 * Two truths this poller must not blur:
 *  - run.json's `state: "running"` is a CLAIM, not evidence: it flips only when
 *    someone calls train_lora_status. The log is the evidence — steps at total plus a
 *    saved checkpoint is DONE regardless of what the meta says; a log idle for an hour
 *    under a "running" meta is presumed dead and reported as such, never left as a
 *    frozen 97% that reads like progress.
 *  - History is not a task. A run already terminal when this backend first sees it
 *    (finished long before boot, or a stale meta) is settled silently — otherwise
 *    every restart would parade hours-old completions through the panel, and the
 *    30s linger would loop them forever as each poll re-discovered the same run.
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import path from 'path'
import type { TaskProgress } from './TaskProgress'

const RUNS_ROOT = process.env.LORA_RUNS_ROOT || '/imagegen/lora_runs'
const POLL_MS = 30_000
const TAIL_BYTES = 8_000
/** A run first seen with a log already idle this long is history, not a task. */
const FRESH_WINDOW_MS = 15 * 60_000
/** A tracked "running" run whose log goes idle this long is presumed dead. */
const DEAD_IDLE_MS = 60 * 60_000

function tailOf(file: string): { tail: string; mtimeMs: number } | null {
  try {
    const fd = openSync(file, 'r')
    try {
      const st = fstatSync(fd)
      const start = Math.max(0, st.size - TAIL_BYTES)
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, st.size))
      readSync(fd, buf, 0, buf.length, start)
      return { tail: buf.toString('utf8'), mtimeMs: st.mtimeMs }
    } finally { closeSync(fd) }
  } catch { return null }
}

export function startLoraRunsWatch(tasks: TaskProgress): void {
  /** Runs whose final state has been reported (or deliberately skipped as history). */
  const settled = new Set<string>()
  let warnedUnreadable = false

  const pass = (): void => {
    let ids: string[]
    try {
      ids = readdirSync(RUNS_ROOT).filter((d) => {
        try { return statSync(path.join(RUNS_ROOT, d)).isDirectory() } catch { return false }
      })
      warnedUnreadable = false
    } catch (e) {
      // Mount outage ≠ no runs: existing task rows stay (the panel's staleness note
      // takes over), and nothing is invented or cleared from a blind pass.
      if (!warnedUnreadable) {
        warnedUnreadable = true
        console.warn('[lora-tasks] runs root unreadable, holding state:', (e as Error)?.message || e)
      }
      return
    }
    for (const rid of ids) {
      if (settled.has(rid)) continue
      let meta: Record<string, unknown>
      try { meta = JSON.parse(readFileSync(path.join(RUNS_ROOT, rid, 'run.json'), 'utf8')) } catch { continue }
      const taskId = `lora:${rid}`
      const trainer = String(meta.trainer || 'kohya')
      const label = `LoRA · ${String(meta.output_name || rid)} (${trainer})`

      if (meta.state && meta.state !== 'running') {
        // Something (the MCP status tool) already ruled on this run. Report the ruling
        // once if we were tracking it live; otherwise it is history.
        if (tasks.state().tasks.some((t) => t.id === taskId)) {
          const ok = meta.state === 'finished'
          tasks.report({ id: taskId, state: ok ? 'done' : 'failed', detail: String(meta.state) })
        }
        settled.add(rid)
        continue
      }

      const log = tailOf(String(meta.log || path.join(RUNS_ROOT, rid, 'train.log')))
      if (!log) continue   // no log yet (launch window) — next pass
      const idleMs = Date.now() - log.mtimeMs
      const steps = [...log.tail.matchAll(/(\d+)\/(\d+)\s*\[/g)].pop()
      const loss = [...log.tail.matchAll(/(?:avr_)?loss[=:]\s*([0-9.]+)/gi)].pop()
      const done = steps ? Number(steps[1]) : 0
      const total = steps ? Number(steps[2]) : 0
      const finishedByLog = total > 0 && done >= total && /model saved|saving checkpoint/i.test(log.tail)
      const tracking = tasks.state().tasks.some((t) => t.id === taskId)

      if (!tracking && idleMs > FRESH_WINDOW_MS) { settled.add(rid); continue }   // stale history

      const detail = [
        loss ? `loss ${loss[1]}` : '',
        meta.gpu_index !== undefined ? `gpu ${meta.gpu_index}` : '',
        trainer,
      ].filter(Boolean).join(' · ')

      if (finishedByLog) {
        tasks.report({ id: taskId, source: `lora-${trainer}`, label, state: 'done', done, total,
                       detail: `checkpoint saved · ${detail}` })
        settled.add(rid)
      } else if (idleMs > DEAD_IDLE_MS) {
        tasks.report({ id: taskId, source: `lora-${trainer}`, label, state: 'failed', done, total,
                       detail: `log idle ${Math.round(idleMs / 60_000)}m under a "running" meta — presumed dead` })
        settled.add(rid)
      } else {
        tasks.report({ id: taskId, source: `lora-${trainer}`, label, state: 'running', done, total, detail })
      }
    }
  }

  pass()
  const timer = setInterval(pass, POLL_MS)
  timer.unref?.()
  console.log(`[lora-tasks] watching ${RUNS_ROOT} every ${POLL_MS / 1000}s`)
}
