/**
 * Tool-health sweep + strict enumeration — batch 20.
 * Run: tsx packages/backend/src/services/Hermes/toolHealthSweep.extreme.spec.ts
 *
 * getToolHealth existed and detected "Hermes gave up — running with no tools";
 * NOTHING polled it, so the condition was permanent until a human opened the
 * right panel. The sweep latches per agent (one error on gave-up, silence
 * while latched, one info on recovery). And listAgentsStrict closes the
 * catch→[] family: a failed enumeration used to become a successful
 * fleet-wide no-op — worst as applyEffectiveModel's "failed over to X" notify
 * about an action applied to NOBODY. All stubs; no ssh, no live fleet.
 */
import { HermesManagementService } from './HermesManagementService'

let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}

async function main(): Promise<void> {
  const emitted: Array<{ severity: string; source: string; message: string }> = []
  const svc: any = new HermesManagementService({ user: 'spec', notify: (e: any) => emitted.push(e) } as any)

  // ── sweep latch ───────────────────────────────────────────────────────────
  svc.listAgentsStrict = async () => ['alpha', 'beta']
  const health: Record<string, any> = {
    alpha: { groupTools: 5, registeredTools: null, gaveUp: true, gatewayActive: true, healthy: false, detail: 'gave up' },
    beta: { groupTools: 5, registeredTools: 5, gaveUp: false, gatewayActive: true, healthy: true, detail: 'ok' },
  }
  svc.getToolHealth = async (id: string) => health[id]

  await svc.sweepToolHealth()
  ok(emitted.length === 1 && emitted[0].severity === 'error' && emitted[0].message.includes("'alpha'"),
    'a gave-up agent raises ONE error naming it; the healthy agent raises nothing')
  await svc.sweepToolHealth()
  ok(emitted.length === 1, 'latched — the permanent condition does not re-fire every 10 minutes')
  health.alpha = { ...health.alpha, gaveUp: false, healthy: true, detail: 'recovered' }
  await svc.sweepToolHealth()
  ok(emitted.length === 2 && emitted[1].severity === 'info', 'recovery raises one info and re-arms')
  health.alpha = { ...health.alpha, gaveUp: true, healthy: false }
  await svc.sweepToolHealth()
  ok(emitted.length === 3, 'a NEW give-up after recovery fires again')

  // gateway-less agents are not watched (no unit = nothing to be down)
  health.gamma = { groupTools: 0, registeredTools: null, gaveUp: true, gatewayActive: false, healthy: false, detail: 'x' }
  svc.listAgentsStrict = async () => ['gamma']
  const before = emitted.length
  await svc.sweepToolHealth()
  ok(emitted.length === before, 'an agent with no gateway unit never alarms — absence of a gateway is not a fault')

  // enumeration failure: the sweep skips silently (cannot-check ≠ failed)
  svc.listAgentsStrict = async () => { throw new Error('ssh down') }
  await svc.sweepToolHealth()
  ok(emitted.length === before, 'an unlistable fleet skips the pass — no alarm manufactured from a blind check')

  // ── strict enumeration: the failover no-op family ─────────────────────────
  const svc2: any = new HermesManagementService({ user: 'spec', notify: (e: any) => emitted.push(e), supportModelsFile: undefined } as any)
  svc2.loadSupportModels = () => ({ tts: { model: 'primary-x', primaryModel: 'primary-x' } })
  svc2.listAgentsStrict = async () => { throw new Error('enumeration down') }
  const b2 = emitted.length
  await svc2.applyEffectiveModel('tts', 'backup-y', "primary 'primary-x' unreachable")
  ok(emitted.length === b2,
    'applyEffectiveModel with a dead enumeration emits NO failover notify — no alarm asserting an action that did not happen')
  ok(svc2.loadSupportModels().tts.model === 'primary-x',
    'and the role file is untouched — the failover genuinely did not happen')

  let threw = false
  try { await svc2.setGlobalNativeTools([]) } catch { threw = true }
  ok(threw, 'setGlobalNativeTools with a dead enumeration THROWS instead of returning agents:0 ok')

  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
