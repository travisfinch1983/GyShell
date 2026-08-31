/**
 * Roadmap store corruption contract — read-only-until-repaired.
 * Run: tsx packages/backend/src/services/Roadmap/roadmapStorePoison.extreme.spec.ts
 *
 * The T1: a corrupt roadmaps.json read as {projects:[]} and the NEXT mutation
 * saved that emptiness over the file — total silent loss of every project,
 * reported ok:true. This store now holds the Observability Sweep's own
 * tracking, so the fixture is not hypothetical. Pairs: corrupt poisons (reads
 * empty, saves REFUSE, one critical raised, bytes preserved); repair re-arms;
 * absent stays a normal silent first boot; writes are atomic.
 */
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { loadRoadmaps, saveRoadmaps } from './roadmapStore'

let n = 0
const ok = (c: boolean, m: string): void => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const received: any[] = []
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c)
  req.on('end', () => { received.push(JSON.parse(b)); res.end('{}') })
})

async function main(): Promise<void> {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  process.env.AILAB_PROXY_PORT = String((srv.address() as { port: number }).port)

  // absent = normal first boot: silent
  const fresh = mkdtempSync(join(tmpdir(), 'rm-'))
  ok(loadRoadmaps(fresh).projects.length === 0, 'absent file loads empty')
  await wait(120)
  ok(received.length === 0, 'and raises nothing — first boot is normal')
  saveRoadmaps(fresh, { projects: [{ id: 'p1', name: 'P', order: 0, updatedAt: 'x', nodes: [] }] } as any)
  ok(JSON.parse(readFileSync(join(fresh, 'roadmaps.json'), 'utf8')).projects.length === 1, 'a healthy save writes')
  ok(!existsSync(join(fresh, 'roadmaps.json.tmp')), 'atomically — no tmp residue')

  // corrupt = poisoned: reads empty, saves refuse, bytes preserved, one critical
  writeFileSync(join(fresh, 'roadmaps.json'), '{"projects": [{"id": "p1", "na')   // torn write
  ok(loadRoadmaps(fresh).projects.length === 0, 'a corrupt file reads empty (the surface stays up)')
  ok(readdirSync(fresh).some((f) => f.startsWith('roadmaps.json.corrupt-')),
    'the corrupt bytes are COPIED ASIDE before anything can destroy them')
  await wait(150)
  ok(received.length === 1 && received[0].severity === 'critical',
    'one CRITICAL raised — the store that tracks everything else must not fail quietly')
  let refused = false
  try { saveRoadmaps(fresh, { projects: [] } as any) } catch { refused = true }
  ok(refused, 'a save onto the poisoned store is REFUSED — the old path wrote the emptiness over the file')
  ok(readFileSync(join(fresh, 'roadmaps.json'), 'utf8').startsWith('{"projects": [{"id": "p1"'),
    'so the on-disk bytes are untouched')
  loadRoadmaps(fresh)
  await wait(120)
  ok(received.length === 1, 'a second corrupt read does not re-raise (latched per file)')

  // repair re-arms
  writeFileSync(join(fresh, 'roadmaps.json'), JSON.stringify({ projects: [] }))
  ok(loadRoadmaps(fresh).projects.length === 0, 'a repaired file loads')
  saveRoadmaps(fresh, { projects: [{ id: 'p2', name: 'Q', order: 0, updatedAt: 'x', nodes: [] }] } as any)
  ok(JSON.parse(readFileSync(join(fresh, 'roadmaps.json'), 'utf8')).projects[0].id === 'p2',
    'and saving works again — poison is per-condition, not permanent')

  srv.close()
  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
