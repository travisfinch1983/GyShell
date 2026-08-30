/**
 * Skills-scan doc-lint — fired against REAL temp dirs.
 * Run: tsx packages/backend/src/services/Hermes/lintSkillsScan.extreme.spec.ts
 *
 * The ssh stub executes the actual shell pipeline via local bash, so the
 * find/marker/cat mechanics are proven rather than simulated. The fixture is
 * the ask-claude shape itself: a dead relay endpoint inside a skill .py — the
 * thing the docs-only scan could not see for weeks while its token list named
 * the exact IP:port. The scan SURFACE is asserted on as hard as the findings,
 * because "no findings" and "did not look there" being indistinguishable is
 * the gap that hid this class (claude1, 2026-08-30).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesManagementService } from './HermesManagementService'
const run = promisify(execFile)

async function main(): Promise<void> {
  let n = 0
  const ok = (c: boolean, m: string) => { if (!c) { console.error('FAILED:', m); process.exit(1) } n++; console.log('  ok —', m) }

  const root = mkdtempSync(join(tmpdir(), 'hermes-'))
  const profiles = join(root, 'profiles')
  const home = join(profiles, 'spec-agent')

  // Core doc: one live dead-token line + one tombstone (negation) line.
  mkdirSync(join(home, 'workspace'), { recursive: true })
  writeFileSync(join(home, 'SOUL.md'), 'You are spec-agent.\nEscalate via ask-claude when blocked.\n')
  writeFileSync(join(home, 'workspace', 'AGENTS.md'), 'ask-claude is decommissioned; use fleet_send.\n')

  // Profile skill: the ask-claude shape — the dead endpoint in a .py, not a doc.
  mkdirSync(join(home, 'skills', 'custom', 'escalate'), { recursive: true })
  writeFileSync(join(home, 'skills', 'custom', 'escalate', 'script.py'),
    'RELAY_URL = "http://10.0.0.161:6277"\nDEFAULT_TO = "openclaw-claude"\n')
  writeFileSync(join(home, 'skills', 'custom', 'escalate', 'SKILL.md'), 'Report blockers upstream.\n')

  // Global skills root with its own offender.
  mkdirSync(join(root, 'skills', 'legacy'), { recursive: true })
  writeFileSync(join(root, 'skills', 'legacy', 'notes.md'), 'See the OpenClaw docs for details.\n')

  const svc: any = new HermesManagementService({ user: 'spec', profileHomeBase: profiles } as any)
  svc.ssh = async (cmd: string) => (await run('bash', ['-c', cmd])).stdout   // REAL pipeline, local dirs

  const lint = await svc.lintProfileDocs('spec-agent')

  // findings
  ok(lint.findings.some((f: any) => f.file === 'SOUL.md' && f.token.includes('ask-claude')),
    'core-doc scanning still works (SOUL.md ask-claude reference found)')
  ok(!lint.findings.some((f: any) => f.file.includes('AGENTS.md')),
    'the tombstone line is still negation-suppressed — no false positive on well-maintained docs')
  ok(lint.findings.some((f: any) => f.file === 'skills/custom/escalate/script.py' && f.token.includes('dead relay endpoint')),
    'THE ask-claude SHAPE IS NOW CAUGHT: a dead endpoint inside a skill .py, invisible to the docs-only scan')
  ok(lint.findings.some((f: any) => f.file === 'skills/custom/escalate/script.py' && f.token.includes('OpenClaw')),
    'the dead default recipient in the same file is caught too (openclaw token)')
  ok(lint.findings.some((f: any) => f.file.startsWith('GLOBAL:') && f.file.includes('legacy/notes.md')),
    'the GLOBAL skills root is walked and labeled as such')

  // scan surface
  ok(lint.scannedRoots.length === 3, 'three roots reported: core docs, profile skills, global skills')
  ok(lint.scannedRoots.some((r: string) => r.includes('skills') && r.includes('2 file(s)')),
    'the profile skills root states HOW MANY files it scanned')
  ok(lint.scannedRoots.some((r: string) => r.includes('GLOBAL') && r.includes('1 file(s)')),
    'so does the global root — "no findings" is now distinguishable from "did not look"')

  // absent root says so
  const svc2: any = new HermesManagementService({ user: 'spec', profileHomeBase: profiles } as any)
  svc2.ssh = svc.ssh
  mkdirSync(join(profiles, 'bare-agent'), { recursive: true })
  const lint2 = await svc2.lintProfileDocs('bare-agent')
  ok(lint2.scannedRoots.some((r: string) => r.includes('ABSENT')),
    'an absent skills root is STATED, not silently skipped — narrowing the surface must be visible')

  // a failing root does not sink the rest
  const svc3: any = new HermesManagementService({ user: 'spec', profileHomeBase: profiles } as any)
  let calls = 0
  svc3.ssh = async (cmd: string) => {
    if (cmd.includes('test -d') && ++calls === 2) throw new Error('transport blip')
    return (await run('bash', ['-c', cmd])).stdout
  }
  const lint3 = await svc3.lintProfileDocs('spec-agent')
  ok(lint3.scannedRoots.some((r: string) => r.includes('SCAN FAILED')),
    'a root that cannot be walked reports SCAN FAILED in the surface')
  ok(lint3.findings.some((f: any) => f.file.startsWith('skills/')),
    'and the roots that DID walk still return their findings')



  console.log(`\n${n} assertions passed`)
}

main().catch((e) => { console.error(e); process.exit(1) })
