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
import { execFile } from 'child_process'
import path from 'path'
import type { TaskProgress } from './TaskProgress'

const RUNS_ROOT = process.env.LORA_RUNS_ROOT || '/imagegen/lora_runs'
/** AI Toolkit output tree: one SUBDIR per run, carrying config.yaml (kohya writes flat
 *  files here, never subdirs with config.yaml — that difference IS the discovery test). */
const TRAINED_ROOT = process.env.LORA_TRAINED_ROOT || '/imagegen/loras/trained'
/** Hosts scanned for LIVE ai-toolkit consoles (per-step resolution between checkpoint saves). */
const CONSOLE_HOSTS = (process.env.LORA_CONSOLE_HOSTS || 'root@10.0.0.234,root@10.0.0.235')
  .split(',').map((s) => s.trim()).filter(Boolean)
const SSH_KEY = process.env.AILAB_SSH_KEY || '/opt/ai-lab/.gybackend-data/ssh/id_ed25519'
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

interface ConsoleRun { step: number; total: number; perf: string }

/**
 * Live-console scan: find every running ai-toolkit process on the training hosts and read
 * its ACTUAL stdout, wherever it went. AI Toolkit prints a tqdm line per step, prefixed
 * with the job name (`<name>:  30%|███| 750/2500 [.. 2.67s/it, lr .. loss ..]`), so between
 * checkpoint saves — 12 quiet minutes on disk — the console is the only per-step truth.
 * No launch convention required: /proc/<pid>/fd/1 says where stdout points; if it is a
 * regular file we tail it, and a pts/pipe/dev-null simply yields nothing (the directory
 * pass keeps covering those at checkpoint resolution). Best-effort by construction: an
 * unreachable host or keyless backend degrades to the dir pass, never to a dead task.
 */
function consoleScan(): Promise<Map<string, ConsoleRun>> {
  // The ===TAILCUT=== sentinel marks where each tail -c begins: the segment right after
  // it may START MID-LINE, and a truncated tqdm line parses as a run with a truncated
  // NAME (`...ea2_v1: 30%|..` matched as run "ea2_v1" — observed live, 2026-09-02).
  const script =
    `for pid in $(pgrep -f 'ai-toolkit/bin/python run.py' 2>/dev/null); do ` +
    `f=$(readlink /proc/$pid/fd/1 2>/dev/null); ` +
    `case "$f" in /*) [ -f "$f" ] && printf '\\n===TAILCUT===\\n' && tail -c 6000 "$f" && echo; esac; done; true`
  const runs = new Map<string, ConsoleRun>()
  const one = (host: string): Promise<void> => new Promise((resolve) => {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=6', '-i', SSH_KEY, host, script]
    execFile('ssh', args, { timeout: 15_000, maxBuffer: 256 * 1024 }, (_err, stdout) => {
      const segs = String(stdout || '').split(/[\r\n]+/)
      let skipNext = false
      for (const line of segs) {
        if (line.includes('===TAILCUT===')) { skipNext = true; continue }
        if (skipNext) { skipNext = false; continue }   // possibly cut mid-line — never parse it
        const m = /^([\w.-]+):\s+\d+%\|[^|]*\|\s*(\d+)\/(\d+)\s*\[([^\]]*)\]/.exec(line.trim())
        if (!m) continue
        const [, name, step, total, bracket] = m
        const prev = runs.get(name)
        if (!prev || Number(step) >= prev.step) {
          const loss = /loss:\s*([\d.eE+-]+)/.exec(bracket)
          const sit = /([\d.]+)s\/it/.exec(bracket)
          runs.set(name, { step: Number(step), total: Number(total),
                           perf: [loss ? `loss ${loss[1]}` : '', sit ? `${sit[1]}s/it` : ''].filter(Boolean).join(' · ') })
        }
      }
      resolve()
    })
  })
  return Promise.all(CONSOLE_HOSTS.map(one)).then(() => runs)
}

export function startLoraRunsWatch(tasks: TaskProgress): void {
  /** Runs whose final state has been reported (or deliberately skipped as history). */
  const settled = new Set<string>()
  /**
   * A reporter that KNOWS beats an observer that INFERS (claude1, 2026-09-02): when a
   * launcher is posting facts about a run, this poller's filename-and-tqdm inference
   * must not overwrite them. 60s (2 pass intervals) so one slow pass cannot slip an
   * inferred write under a live knower; the moment the knower goes quiet, the poller
   * resumes the row within a pass — a dead launcher freezes nothing.
   */
  const KNOWER_FRESH_MS = 60_000
  const knowerFresh = (id: string): boolean => {
    const t = tasks.state().tasks.find((x) => x.id === id)
    return !!t && t.origin !== 'poller' && Date.now() - Date.parse(t.updatedAt) < KNOWER_FRESH_MS
  }
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

      if (knowerFresh(taskId)) continue   // a live launcher owns this row right now
      if (meta.state && meta.state !== 'running') {
        // Something (the MCP status tool) already ruled on this run. Report the ruling
        // once if we were tracking it live; otherwise it is history.
        if (tasks.state().tasks.some((t) => t.id === taskId)) {
          const ok = meta.state === 'finished'
          tasks.report({ origin: 'poller', id: taskId, state: ok ? 'done' : 'failed', detail: String(meta.state) })
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
        tasks.report({ origin: 'poller', id: taskId, source: `lora-${trainer}`, label, state: 'done', done, total,
                       detail: `checkpoint saved · ${detail}` })
        settled.add(rid)
      } else if (idleMs > DEAD_IDLE_MS) {
        tasks.report({ origin: 'poller', id: taskId, source: `lora-${trainer}`, label, state: 'failed', done, total,
                       detail: `log idle ${Math.round(idleMs / 60_000)}m under a "running" meta — presumed dead` })
        settled.add(rid)
      } else {
        tasks.report({ origin: 'poller', id: taskId, source: `lora-${trainer}`, label, state: 'running', done, total, detail })
      }
    }
  }

  /**
   * AI Toolkit runs have NO run.json, NO state field, NO log in the output dir — the
   * directory is the only evidence (claude1's ground truth, 2026-09-02, read off a live
   * Krea 2 run): total steps from config.yaml `steps:`; current step from the highest
   * zero-padded `*_<step>.safetensors`, refined by `samples/<ts>__<step>_<n>.jpg` (samples
   * land AFTER the checkpoint at the same step); liveness = newest mtime in the dir.
   *
   * 🛑 The idle threshold must stay LARGE: with save_every 250 at ~3s/step nothing in the
   * directory changes for ~12 minutes between saves — a healthy run looks dead in any
   * small window. If this is ever tightened, compute save_every × observed s/step and
   * allow a generous multiple; a confident "training died" about a healthy job is worse
   * than showing nothing. The same hour also serves as the first-seen freshness test,
   * because a 15-minute window would misfile a LIVE run as history whenever the backend
   * restarts inside a save gap.
   */
  const passAitoolkit = (live: Map<string, ConsoleRun>): void => {
    let dirs: string[]
    try {
      dirs = readdirSync(TRAINED_ROOT).filter((d) => {
        try { return statSync(path.join(TRAINED_ROOT, d, 'config.yaml')).isFile() } catch { return false }
      })
    } catch { return }   // tree unreadable = hold state, invent nothing (same as kohya pass)
    for (const dir of dirs) {
      const settleKey = `atk:${dir}`
      if (settled.has(settleKey)) continue
      const base = path.join(TRAINED_ROOT, dir)
      let cfg = ''
      try { cfg = readFileSync(path.join(base, 'config.yaml'), 'utf8') } catch { continue }
      // Anchored: the same file carries sample_steps — a loose /steps:/ grabs the wrong number.
      const total = Number((/^\s*steps:\s*(\d+)\s*$/m.exec(cfg) || [])[1] || 0)
      const name = ((/^\s*name:\s*(\S+)/m.exec(cfg) || [])[1] || dir)
      if (!total) { settled.add(settleKey); continue }   // not a meterable run config

      let step = 0
      let lastMtime = 0
      const look = (d: string, re: RegExp): void => {
        let ents: string[]
        try { ents = readdirSync(d) } catch { return }
        for (const f of ents) {
          let st
          try { st = statSync(path.join(d, f)) } catch { continue }
          if (st.mtimeMs > lastMtime) lastMtime = st.mtimeMs
          const m = re.exec(f)
          if (m && Number(m[1]) > step) step = Number(m[1])
        }
      }
      look(base, /_(\d{6,})\.safetensors$/)
      look(path.join(base, 'samples'), /__(\d+)_\d+\.\w+$/)

      const taskId = `lora:aitoolkit:${dir}`
      // Console truth beats checkpoint truth: per-step vs per-save_every resolution.
      // A live console line is also LIVENESS — the process exists and is stepping.
      if (knowerFresh(taskId)) { live.delete(name); continue }   // knower owns the row
      const con = live.get(name)
      if (con && con.step > step) step = con.step
      const idleMs = con ? 0 : Date.now() - lastMtime
      const tracking = tasks.state().tasks.some((t) => t.id === taskId)
      const label = `LoRA · ${name} (ai-toolkit)`

      if (step >= total) {
        if (tracking) tasks.report({ origin: 'poller', id: taskId, source: 'lora-aitoolkit', label, state: 'done', done: step, total, detail: 'final checkpoint saved' })
        settled.add(settleKey)   // finished dirs live in this tree forever — history, not a task
      } else if (idleMs > DEAD_IDLE_MS) {
        if (tracking) {
          tasks.report({ origin: 'poller', id: taskId, source: 'lora-aitoolkit', label, state: 'failed', done: step, total,
                         detail: `no directory activity for ${Math.round(idleMs / 60_000)}m at step ${step}/${total} — presumed dead` })
        }
        settled.add(settleKey)   // first seen already-idle = abandoned history, silently
      } else {
        tasks.report({ origin: 'poller', id: taskId, source: 'lora-aitoolkit', label, state: 'running', done: step, total,
                       detail: con
                         ? `step ${step}/${total} · ${con.perf || 'live console'}`
                         : `step ${step}/${total} · checkpoint resolution — saves land in bursts, quiet between them is normal` })
      }
      live.delete(name)   // consumed — what remains has no output dir yet
    }
    // Console-only runs (stdout found, no output dir yet — the pre-first-checkpoint
    // window, or a custom output root). Same id scheme, so when the dir appears the
    // two views converge on one task instead of forking.
    const knownNames = new Set(dirs)
    for (const name of live.keys()) knownNames.add(name)
    for (const [name, con] of live) {
      if (settled.has(`atk:${name}`)) continue
      if (con.step >= con.total) continue
      // A name that is a strict SUFFIX of another known run is a torn-line fragment,
      // never a real second run (second guard behind the TAILCUT sentinel).
      if ([...knownNames].some((o) => o !== name && o.endsWith(name))) continue
      if (knowerFresh(`lora:aitoolkit:${name}`)) continue
      tasks.report({ origin: 'poller', id: `lora:aitoolkit:${name}`, source: 'lora-aitoolkit',
                     label: `LoRA · ${name} (ai-toolkit)`, state: 'running',
                     done: con.step, total: con.total,
                     detail: `step ${con.step}/${con.total} · ${con.perf || 'live console'}` })
    }
    // Subject-gone cleanup: a console-only task whose process vanished has no dir to
    // ever resolve it — remove it rather than leaving a forever-"running" ghost.
    for (const t of tasks.state().tasks) {
      if (!t.id.startsWith('lora:aitoolkit:') || t.state !== 'running') continue
      // Only reap what the POLLER wrote: a launcher may be reporting a run this poller
      // cannot see at all (custom output root, stdout on a pts) — deleting the knower's
      // row from a blind spot would be the sweep's own aperture bug.
      if (t.origin !== 'poller') continue
      const name = t.id.slice('lora:aitoolkit:'.length)
      if (!dirs.includes(name) && !live.has(name)) tasks.remove(t.id)
    }
  }

  let inFlight = false
  const passBoth = async (): Promise<void> => {
    if (inFlight) return   // an ssh hang must queue nothing behind it
    inFlight = true
    try {
      pass()
      passAitoolkit(await consoleScan())
    } finally { inFlight = false }
  }
  void passBoth()
  const timer = setInterval(() => void passBoth(), POLL_MS)
  timer.unref?.()
  console.log(`[lora-tasks] watching ${RUNS_ROOT} + ${TRAINED_ROOT} (+ live consoles on ${CONSOLE_HOSTS.length} hosts) every ${POLL_MS / 1000}s`)
}
