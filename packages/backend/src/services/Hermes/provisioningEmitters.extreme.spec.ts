/**
 * Hermes provisioning emitters — batch-5 verification, rescued into the tree.
 * Run: tsx packages/backend/src/services/Hermes/provisioningEmitters.extreme.spec.ts
 *
 * Originally a session-scratch harness; checked in because an uncommitted
 * verification is a claim, not an artifact (claude1's batch-6 catch — nobody
 * else can re-run scratch). Everything fires against stubs: ssh/hermes are
 * monkey-patched (TS private is compile-time only), notify records locally,
 * the gateway is a local http server. No live host, no live config — the
 * standing rule from the support-models incident.
 *
 * The latch contract under test: one event per condition, silence on normal
 * state, per-subject latching, and readToolGroupStatus's 404-vs-failure
 * distinction (a first sync must not alarm; a gateway blip must).
 */
import http from 'node:http'
import { HermesManagementService } from './HermesManagementService'
import { readToolGroupStatus } from '../mcp/toolGroups'

async function main(): Promise<void> {
  let n = 0
  const ok = (c: boolean, m: string) => { if (!c) { console.error('FAILED:', m); process.exit(1) } n++; console.log('  ok —', m) }
  const emitted: any[] = []
  const svc: any = new HermesManagementService({
    user: 'spec', notify: (e: any) => emitted.push(e),
  } as any)

  // ── 1. Empty workspace after template copy ──────────────────────────────────
  const sshCalls: string[] = []
  svc.ssh = async (cmd: string) => { sshCalls.push(cmd); return cmd.includes('wc -l') ? '0' : '' }
  await svc.copyTemplateDocs('spec-agent')
  ok(emitted.length === 1 && emitted[0].source === 'agent-provision' && emitted[0].message.includes('empty workspace'),
    'zero .md files after template copy → ONE agent-provision warning')
  svc.ssh = async (cmd: string) => (cmd.includes('wc -l') ? '3' : '')
  await svc.copyTemplateDocs('spec-agent-2')
  ok(emitted.length === 1, 'a populated workspace emits nothing — no event on normal state')

  // ── 2. Vision skip on spec-less agent, latched per agent ────────────────────
  svc.getSpec = () => undefined
  svc.hermes = async () => ''
  await svc.applyRoleConfig('specless-agent', 'vision', { model: 'x' })
  ok(emitted.length === 2 && emitted[1].message.includes("Vision role not applied to agent 'specless-agent'"),
    'vision apply on a spec-less agent → warning naming the agent')
  await svc.applyRoleConfig('specless-agent', 'vision', { model: 'x' })
  ok(emitted.length === 2, 'second apply for the SAME agent is latched — one notification per agent per process')
  await svc.applyRoleConfig('other-specless', 'vision', { model: 'x' })
  ok(emitted.length === 3, 'a different spec-less agent fires its own — latch is per subject')

  // ── 3. OpenViking key provisioning failure ──────────────────────────────────
  svc.ovAdmin = () => ({ url: 'http://127.0.0.1:9', rootKey: 'k', account: 'a' })
  svc.ssh = async () => { throw new Error('ssh transport down') }
  await svc.ensureOpenVikingKey('ov-agent')
  const ov = emitted[emitted.length - 1]
  ok(emitted.length === 4 && ov.severity === 'error' && ov.message.includes("no OpenViking memory key"),
    'key provisioning failure → ERROR naming the agent (created:true would otherwise be the only signal)')
  ok(ov.detail.includes('NOT falling back'), 'and the detail states the deliberate no-inherited-key refusal')

  // ── 4. readToolGroupStatus: 404 ≠ read failure ──────────────────────────────
  const srv = http.createServer((req, res) => {
    if (req.url?.includes('missing-group')) { res.statusCode = 404; res.end() }
    else if (req.url?.includes('broken')) { res.statusCode = 500; res.end() }
    else res.end(JSON.stringify({ included_tools: ['a__b'] }))
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const gw = `http://127.0.0.1:${(srv.address() as any).port}`
  let st = await readToolGroupStatus(gw, 'missing-group')
  ok(st.missing === true && st.tools === null, "404 reads as MISSING — an agent's first sync must not alarm")
  st = await readToolGroupStatus(gw, 'broken')
  ok(st.missing === false && st.tools === null, 'a 500 reads as read-FAILURE, not missing — this is the alarm case')
  st = await readToolGroupStatus(gw, 'ok-group')
  ok(st.missing === false && st.tools?.length === 1, 'a healthy group reads its tools')
  srv.close()



  console.log(`\n${n} assertions passed; ${emitted.length} notifications total, all recorded locally`)
}

main().catch((e) => { console.error(e); process.exit(1) })
