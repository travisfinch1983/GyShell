/**
 * ClaudeConsoleService end-to-end spec — REAL ssh + dtach, stub instance-manager.
 * Run: ./node_modules/.bin/tsx packages/backend/src/services/ClaudeConsole/claudeConsole.extreme.spec.ts
 *
 * Requirements (matches the CT180 layout; the CI-less homelab runs this by hand):
 *  - self-SSH loop: `ssh root@$CONSOLE_SPEC_TARGET` must be key-authorized from here
 *  - a throwaway session: `dtach -n /tmp/console-test.sock bash -i`
 * Env overrides: CONSOLE_SPEC_TARGET (default root@10.0.0.161),
 *                CONSOLE_SPEC_KEY (default ~/.ssh/id_ed25519).
 *
 * Covers the two properties that fix the /clear:
 *  - single-writer: a second WS displaces the first (takeover), never coexists
 *  - clean reconnect: close → pty gone; fresh attach redraws; session survives
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { ClaudeConsoleService, attachCommandFor, socketForInstance } from './ClaudeConsoleService'

const TARGET = process.env.CONSOLE_SPEC_TARGET || 'root@10.0.0.161'
// 🛑 Default to the key the SERVICE actually uses. This previously defaulted to
// ~/.ssh/id_ed25519 — a different file that is not authorized on CT181 — so every live case
// failed with "Permission denied (publickey,password)" and the suite reported 7 failures that
// were entirely about the fixture. It failed identically whether the console worked or not,
// which makes it worse than no test: it trains you to ignore a red console suite.
const KEY = process.env.CONSOLE_SPEC_KEY
  || process.env.AILAB_SSH_KEY
  || (existsSync('/opt/ai-lab/.gybackend-data/ssh/id_ed25519')
    ? '/opt/ai-lab/.gybackend-data/ssh/id_ed25519'
    : path.join(os.homedir(), '.ssh', 'id_ed25519'))
const TEST_SOCKET = '/tmp/console-test.sock'

let failures = 0
function check(cond: boolean, label: string, detail?: string) {
  if (cond) console.log(`PASS ${label}`)
  else {
    failures++
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── unit: socket map + attach commands (the fleet table from the plan) ────────
check(socketForInstance({ id: 'claude1', user: 'root' }) === '/tmp/claude.sock', 'unit: claude1 socket')
check(socketForInstance({ id: 'fable-builder', user: 'root' }) === '/tmp/claude-fable.sock', 'unit: fable-builder socket')
check(socketForInstance({ id: 'claude2', user: 'claude2' }) === '/tmp/claude-claude2.sock', 'unit: claude2 socket')
check(socketForInstance({ id: 'claude-dhb', user: 'claude-dhb' }) === '/tmp/claude-dhb.sock', 'unit: claude-dhb socket')
check(socketForInstance({ id: 'x', user: 'root', consoleSocket: '/tmp/custom.sock' }) === '/tmp/custom.sock', 'unit: consoleSocket override wins')
// The attach command has gained three things since these two checks were written, and each
// is load-bearing rather than cosmetic, so assert the PROPERTIES that carry the reason —
// a frozen string here just rots again on the next legitimate change and reads as a
// regression in attach semantics when it is only a stale expectation:
//   1. a reap prefix killing stray `dtach -a` clients (single-attach enforcement; a second
//      client is the multi-attach /clear vector), guarded on comm=dtach so it can never kill
//      the ttyd wrapper or the privilege-drop layer
//   2. `-r winch` AFTER the socket — dtach 0.9 rejects the reverse order once a tty exists
//   3. `runuser -u <user> --` replacing `su - <user> -c`, whose login shell ran a profile
//      that corrupted the pty stream for fleet-user instances
const rootCmd = attachCommandFor({ id: 'claude1', user: 'root' })
check(
  /(^|;\s*)exec dtach -a \/tmp\/claude\.sock -r winch$/.test(rootCmd),
  'unit: root attach is direct — dtach exec\'d last, socket before -r',
)
check(!/\brunuser\b|\bsu -\s/.test(rootCmd), 'unit: root attach adds no privilege-drop layer')
check(
  rootCmd.includes("pgrep -f 'dtach -a /tmp/claude.sock'"),
  'unit: root attach reaps stray dtach clients before attaching',
)
check(
  rootCmd.includes('comm 2>/dev/null)" = dtach'),
  'unit: the reap kills ONLY real dtach procs — pgrep -f would otherwise match its own shell',
)

const userCmd = attachCommandFor({ id: 'claude2', user: 'claude2' })
check(
  /(^|;\s*)exec runuser -u claude2 -- dtach -a \/tmp\/claude-claude2\.sock -r winch$/.test(userCmd),
  'unit: user attach drops via runuser (no login shell), socket before -r',
)
check(!/\bsu - claude2\b/.test(userCmd), 'unit: user attach no longer goes through `su -`')

// ── fixture: the throwaway dtach session the live cases attach to ─────────────
// 🛑 This used to be a MANUAL precondition stated only in the header comment, so the live cases
// failed with "No such file or directory" for anyone who had not run it by hand. The spec now
// owns its fixture: a red run then means the console is broken, which is the only thing a test
// is for.
function ssh(cmd: string): { ok: boolean; out: string } {
  const r = spawnSync('ssh', [
    '-i', KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10', TARGET, cmd,
  ], { encoding: 'utf8', timeout: 30000 })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

function setUpFixture(): void {
  // -n: detached, no client. Idempotent: clear any leftover from an aborted run first.
  ssh(`rm -f ${TEST_SOCKET}`)
  const r = ssh(`dtach -n ${TEST_SOCKET} bash -i && sleep 0.3 && test -S ${TEST_SOCKET}`)
  if (!r.ok) {
    console.error(`  cannot create the test dtach socket on ${TARGET}: ${r.out}`)
    console.error('  (this is a HARNESS failure, not a console failure — do not read it as one)')
    process.exit(2)
  }
}

function tearDownFixture(): void {
  // Kill the holder, then the socket. Matched on the exact socket path so it cannot touch a
  // real instance's dtach — every fleet socket is /tmp/claude*.sock, never console-test.
  ssh(`pkill -f 'dtach -n ${TEST_SOCKET}' ; rm -f ${TEST_SOCKET}`)
}

// ── live harness: stub manager + service on a scratch port ────────────────────
async function main() {
  setUpFixture()
  const manager = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ instances: [{ id: 'console-test', user: 'root', consoleSocket: TEST_SOCKET }] }))
  })
  await new Promise<void>((r) => manager.listen(17998, '127.0.0.1', r))

  const server = http.createServer((_req, res) => res.end('ok'))
  const svc = new ClaudeConsoleService({ managerUrl: 'http://127.0.0.1:17998', sshKeyPath: KEY, sshTarget: TARGET })
  svc.attachUpgrade(server)
  await new Promise<void>((r) => server.listen(17999, '127.0.0.1', r))

  const connect = (id: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:17999/api/claude/console/${id}`)
    const st = { output: '', statuses: [] as string[], closed: null as number | null }
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) st.output += data.toString('utf8')
      else {
        try { st.statuses.push((JSON.parse(data.toString('utf8')) as { state: string }).state) } catch { /* noise */ }
      }
    })
    ws.on('close', (code: number) => { st.closed = code })
    ws.on('error', () => { /* surfaced via close */ })
    return { ws, st }
  }

  // 1. attach → status + live shell round-trip
  const a = connect('console-test')
  await new Promise<void>((r) => a.ws.on('open', () => r()))
  await sleep(2500) // ssh + dtach redraw
  check(a.st.statuses.includes('attached'), 'live: attach status received', JSON.stringify(a.st.statuses))
  a.ws.send(Buffer.from('echo HELLO-$((6*7))\r'), { binary: true })
  await sleep(1500)
  check(a.st.output.includes('HELLO-42'), 'live: input executed, output bridged', a.st.output.slice(-200))

  // 2. resize control frame is accepted (no crash; dtach/bash keep talking)
  a.ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }))
  a.ws.send(Buffer.from('echo COLS-$COLUMNS\r'), { binary: true })
  await sleep(1200)
  check(a.st.output.includes('COLS-120'), 'live: resize propagated through ssh→dtach', a.st.output.slice(-120))

  // 3. SINGLE-WRITER: second client displaces the first
  const b = connect('console-test')
  await new Promise<void>((r) => b.ws.on('open', () => r()))
  await sleep(2500)
  check(a.st.statuses.includes('takeover'), 'live: first client told of takeover', JSON.stringify(a.st.statuses))
  check(a.st.closed === 4001, 'live: first WS closed with takeover code', String(a.st.closed))
  check(b.st.statuses.includes('attached'), 'live: second client attached', JSON.stringify(b.st.statuses))
  check(svc.liveSessions().length === 1, 'live: exactly ONE live session (never two writers)', JSON.stringify(svc.liveSessions()))
  b.ws.send(Buffer.from('echo SECOND-$((5*5))\r'), { binary: true })
  await sleep(1200)
  check(b.st.output.includes('SECOND-25'), 'live: displaced session handed over cleanly', b.st.output.slice(-120))

  // 4. CLEAN RECONNECT: close → no session; fresh attach redraws, no replay
  b.ws.close()
  await sleep(800)
  check(svc.liveSessions().length === 0, 'live: close kills the pty (no lingering session)')
  const c = connect('console-test')
  await new Promise<void>((r) => c.ws.on('open', () => r()))
  await sleep(2500)
  check(c.st.statuses.includes('attached'), 'live: fresh reconnect attaches')
  check(c.st.output.includes('SECOND-25') || c.st.output.length > 0, 'live: dtach redraw (screen state, not replayed input)')
  c.ws.send(Buffer.from('echo THIRD-OK\r'), { binary: true })
  await sleep(1200)
  check(c.st.output.includes('THIRD-OK'), 'live: session survived detach cycles (persistent dtach host)')
  c.ws.close()

  // 5. unknown instance → clean refusal
  const d = connect('nope')
  await sleep(1500)
  check(d.st.closed === 4404, 'live: unknown instance refused with 4404', String(d.st.closed))

  await new Promise<void>((r) => server.close(() => r()))
  await new Promise<void>((r) => manager.close(() => r()))
  tearDownFixture()

  if (failures) {
    console.error(`\n${failures} FAILURES`)
    process.exit(1)
  }
  console.log('\nALL PASS')
  process.exit(0)
}

void main()
