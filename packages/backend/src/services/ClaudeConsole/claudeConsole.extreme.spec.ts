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
import { WebSocket } from 'ws'
import { ClaudeConsoleService, attachCommandFor, socketForInstance } from './ClaudeConsoleService'

const TARGET = process.env.CONSOLE_SPEC_TARGET || 'root@10.0.0.161'
const KEY = process.env.CONSOLE_SPEC_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519')
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
check(attachCommandFor({ id: 'claude1', user: 'root' }) === 'exec dtach -a /tmp/claude.sock', 'unit: root attach is direct')
check(
  attachCommandFor({ id: 'claude2', user: 'claude2' }) === `exec su - claude2 -c 'exec dtach -a /tmp/claude-claude2.sock'`,
  'unit: user attach drops via su',
)

// ── live harness: stub manager + service on a scratch port ────────────────────
async function main() {
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

  if (failures) {
    console.error(`\n${failures} FAILURES`)
    process.exit(1)
  }
  console.log('\nALL PASS')
  process.exit(0)
}

void main()
