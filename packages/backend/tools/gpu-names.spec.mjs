import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'gpunames-'))
process.env.AILAB_PROXY_DATA_DIR = dir
const U = { A: 'GPU-aaaaaaaa-0000-0000-0000-000000000000', B: 'GPU-bbbbbbbb-0000-0000-0000-000000000000', C: 'GPU-cccccccc-0000-0000-0000-000000000000' }
const cfg0 = {
  'n1:0000:02:00.0': { friendlyName: '#1', pciId: '0000:02:00.0', node: 'n1', uuid: U.A, showInFleet: true },
  'n1:0000:43:00.0': { friendlyName: '#3', pciId: '0000:43:00.0', node: 'n1', uuid: U.B, showInFleet: false },
  'n1:0000:01:00.0': { friendlyName: '#0', pciId: '0000:01:00.0', node: 'n1' },                 // no uuid yet
  'n1:0000:c3:00.0': { friendlyName: 'Arc', pciId: '0000:c3:00.0', node: 'n1' },                // intel, slot-keyed
}
writeFileSync(join(dir, 'gpu-config.json'), JSON.stringify(cfg0))
writeFileSync(join(dir, 'ai-config.json'), JSON.stringify({ agents: { n1: { vmid: 176 }, n2: { vmid: 177 }, n3: { vmid: 177 } } }))
writeFileSync(join(dir, 'active-services.json'), JSON.stringify({ services: {
  s1: { node: 'n1', port: 1, gpuPciIds: ['0000:02:00.0'] }, s2: { node: 'n1', port: 2, gpuPciIds: ['0000:43:00.0', '0000:01:00.0'] },
  s3: { node: 'n9', port: 3, gpuPciIds: ['0000:02:00.0'] } } }))
writeFileSync(join(dir, 'gpu-assignments.json'), JSON.stringify({ '176': { gpus: ['0000:01:00.0', '0000:02:00.0', '0000:43:00.0'] }, '177': { gpus: ['0000:43:00.0'] } }))
const { GpuMonitor } = await import('/opt/ai-lab/packages/backend/src/services/Cluster/proxy/llm/services/gpu-monitor.js')
const m = new GpuMonitor({}, null, null, { interval: 999999 })
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1 }
// 1) UUID query failed -> nothing moves
m.reconcileConfigByUuid({ n1: { uuidMap: {} } })
ok(m.getFriendlyName('n1', '0000:02:00.0') === '#1', 'failed UUID query moves nothing')
// 2) swap A<->B, stamp #0, Arc untouched
m.reconcileConfigByUuid({ n1: { uuidMap: { '0000:02:00.0': U.B, '0000:43:00.0': U.A, '0000:01:00.0': U.C } } })
ok(m.getFriendlyName('n1', '0000:43:00.0') === '#1' && m.getFriendlyName('n1', '0000:02:00.0') === '#3', 'swap: names follow the cards')
ok(m.getConfig()['n1:0000:02:00.0'].showInFleet === false, 'swap: other settings travel with the name')
{ const sv = JSON.parse(readFileSync(join(dir, 'active-services.json'))).services
  ok(sv.s1.gpuPciIds.join() === '0000:43:00.0' && sv.s2.gpuPciIds.join() === '0000:02:00.0,0000:01:00.0', 'swap: service records follow their cards (applied once, not twice)')
  ok(sv.s3.gpuPciIds.join() === '0000:02:00.0', 'service on another node untouched') }
ok(m.getConfig()['n1:0000:01:00.0'].uuid === U.C, 'first sight stamps uuid on an unstamped entry')
ok(m.getFriendlyName('n1', '0000:c3:00.0') === 'Arc', 'non-NVIDIA entry stays slot-keyed')
ok(JSON.stringify(JSON.parse(readFileSync(join(dir, 'gpu-assignments.json'))).gpus) === undefined
   && JSON.parse(readFileSync(join(dir, 'gpu-assignments.json')))['176'].gpus.join() === '0000:01:00.0,0000:02:00.0,0000:43:00.0', 'swap inside the assignment list leaves it unchanged')
// 3) card A moves to a NEW slot 23 outside the list -> assignment follows
m.reconcileConfigByUuid({ n1: { uuidMap: { '0000:02:00.0': U.B, '0000:23:00.0': U.A, '0000:01:00.0': U.C } } })
ok(m.getFriendlyName('n1', '0000:23:00.0') === '#1' && !m.getConfig()['n1:0000:43:00.0'], 'move to a new slot re-keys the entry')
ok(JSON.parse(readFileSync(join(dir, 'gpu-assignments.json')))['176'].gpus.join() === '0000:01:00.0,0000:02:00.0,0000:23:00.0', 'assignment follows a card to a slot outside the list')
// 4) card absent this round -> entry stays put
m.reconcileConfigByUuid({ n1: { uuidMap: { '0000:02:00.0': U.B, '0000:01:00.0': U.C } } })
ok(m.getFriendlyName('n1', '0000:23:00.0') === '#1', 'absent card: entry is not moved or dropped')
ok(JSON.parse(readFileSync(join(dir, 'gpu-assignments.json')))['177'].gpus.join() === '0000:43:00.0', 'ambiguous vmid (on 2 nodes) is NOT remapped')
