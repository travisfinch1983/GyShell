/**
 * Where Dataset Forge runs right now - chosen PER REQUEST, never pinned to a host.
 *
 * Since 2026-10-09 Forge is a plugin inside every Image Model Service (imagegen-models; claude1's
 * infra/dataset-forge/plugin_forge.py), serving /forge/* on the service port, and detectors / SAM are
 * ordinary model kinds there. So any imagegen-models service can do the work. Travis: "not hard coded to
 * one service on a specific host" - detectors may move to the V100s, and copies on several services
 * should load-balance batch work. Order, for a request that needs (kind, name):
 *   1. a service where that model is RESIDENT and idle (shortest queue first)
 *   2. a service where it is resident (shortest queue)
 *   3. a service with a placement rule reserving a GPU for that kind (it will load it there)
 *   4. any healthy imagegen-models service
 * then the legacy standalone dataset-forge service, then FORGE_SAMD.
 * Ingest jobs live in the service that started them, so AI-Lab hands out "<serviceId>~<job>" ids and
 * forgeJobUrl() sends status checks back to that service.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ACTIVE = join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'active-services.json');
const FALLBACK = process.env.FORGE_SAMD || 'http://10.0.0.234:8791';
export const DEFAULT_SAM = process.env.FORGE_SAM_NAME || 'sam_vit_h_4b8939.pth';

function services() {
  try {
    if (!existsSync(ACTIVE)) return [];
    return Object.values(JSON.parse(readFileSync(ACTIVE, 'utf-8')).services || {})
      .filter((x) => x && x.containerIp && x.port && !x.suspended);
  } catch (e) {
    console.warn(`[forge-endpoint] could not read ${ACTIVE}: ${e.message}`);
    return [];
  }
}
const baseOf = (s) => `http://${s.containerIp}:${s.port}/forge`;

// GET /models per service, cached briefly: one pick per request must not cost a round trip each time.
const modelsCache = new Map();   // id -> { at, data | null }
async function modelsOf(s) {
  const c = modelsCache.get(s.id);
  if (c && Date.now() - c.at < 3000) return c.data;
  let data = null;
  try {
    const r = await fetch(`http://${s.containerIp}:${s.port}/models`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) data = await r.json();
  } catch { /* unreachable = not a candidate */ }
  modelsCache.set(s.id, { at: Date.now(), data });
  return data;
}
const normDet = (n) => String(n || '').replace(/^\/?(ai-assets\/)?imagegen\//, '').replace(/^ultralytics\//, '');

/** Pick a service for work that needs model (kind, name). -> { base, service, reason } */
export async function pickForge(kind, name) {
  const svcs = services().filter((s) => s.providerId === 'imagegen-models');
  const want = kind === 'detector' ? normDet(name) : String(name || '');
  const infos = (await Promise.all(svcs.map(async (s) => ({ s, m: await modelsOf(s) })))).filter((x) => x.m);
  const copies = [];
  for (const { s, m } of infos) {
    for (const r of m.resident || []) {
      if (r.kind === kind && (kind === 'detector' ? normDet(r.name) : r.name) === want) {
        copies.push({ s, busy: !!r.busy, waiting: Number(r.waiting) || 0 });
      }
    }
  }
  const idle = copies.filter((c) => !c.busy).sort((a, b) => a.waiting - b.waiting)[0];
  if (idle) return { base: baseOf(idle.s), service: idle.s.id, reason: `${kind} resident and idle` };
  const busy = copies.sort((a, b) => a.waiting - b.waiting)[0];
  if (busy) return { base: baseOf(busy.s), service: busy.s.id, reason: `${kind} resident (busy, shortest queue)` };
  const ruled = infos.find(({ m }) => Array.isArray(m.service?.placement?.[kind]) && m.service.placement[kind].length);
  if (ruled) return { base: baseOf(ruled.s), service: ruled.s.id, reason: `GPU reserved for ${kind}` };
  if (infos[0]) return { base: baseOf(infos[0].s), service: infos[0].s.id, reason: 'any healthy service' };
  return legacy();
}

function legacy() {
  const s = services().find((x) => x.providerId === 'dataset-forge');
  if (s) return { base: `http://${s.containerIp}:${s.port}`, service: s.id, legacy: true, reason: 'legacy dataset-forge service' };
  return { base: FALLBACK, service: null, legacy: true, reason: 'FORGE_SAMD fallback' };
}

/** For host-bound work (detector TRAINING runs on that host's GPUs): the service with a GPU reserved for
 *  detectors, else any imagegen-models service. Synchronous: uses the last cached /models answers. */
export function forgeEndpoint() {
  const svcs = services().filter((s) => s.providerId === 'imagegen-models');
  const ruled = svcs.find((s) => (modelsCache.get(s.id)?.data?.service?.placement?.detector || []).length);
  const s = ruled || svcs[0];
  if (s) { void modelsOf(s); return baseOf(s); }
  return legacy().base;
}
/** Warm the cache so forgeEndpoint() sees placement rules (call before host-bound work). */
export async function refreshForge() { await Promise.all(services().filter((s) => s.providerId === 'imagegen-models').map(modelsOf)); }

/** AI-Lab job id for an ingest started on `service`. */
export const forgeJobId = (service, job) => (service ? `${service}~${job}` : String(job));
/** Status URL for a job id from forgeJobId (or a bare legacy id). */
export function forgeJobUrl(id) {
  const [svcId, job] = String(id).includes('~') ? String(id).split('~') : [null, String(id)];
  const s = svcId ? services().find((x) => x.id === svcId) : null;
  if (s) return s.providerId === 'imagegen-models' ? `${baseOf(s)}/job?id=${encodeURIComponent(job)}` : `http://${s.containerIp}:${s.port}/job/${encodeURIComponent(job)}`;
  const l = legacy();
  return l.legacy ? `${l.base}/job/${encodeURIComponent(job)}` : `${l.base}/job?id=${encodeURIComponent(job)}`;
}
