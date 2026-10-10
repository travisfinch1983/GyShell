/**
 * Where Dataset Forge (samd) is running right now.
 *
 * It used to be a hand-made systemd unit at a hard-coded 10.0.0.234:8791. Since 2026-10-08 it is an
 * AI-Lab service (provider 'dataset-forge') that can be relaunched on another GPU, port or node, so
 * callers resolve it from the active-services registry on every use instead of baking in an address.
 * Falls back to FORGE_SAMD / the historical address when no such service is registered, so nothing
 * breaks while it is being migrated.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ACTIVE = join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'active-services.json');
const FALLBACK = process.env.FORGE_SAMD || 'http://10.0.0.234:8791';

// Since 2026-10-09 Dataset Forge runs INSIDE the Image Model Service as a plugin (claude1's
// infra/dataset-forge/plugin_forge.py -> /opt/ailab-modelsvc/plugins/forge.py), serving the same routes
// under /forge on that service's port. Preference: an imagegen-models service on FORGE_NODE (default
// px-epyc, where the datasets were built), then any imagegen-models service, then the legacy standalone
// dataset-forge service, then FORGE_SAMD. Only the job-status path changed shape (/job/<id> -> /job?id=).
const FORGE_NODE = process.env.FORGE_NODE || 'px-epyc';

export function forgeTarget() {
  try {
    if (existsSync(ACTIVE)) {
      const svcs = Object.values(JSON.parse(readFileSync(ACTIVE, 'utf-8')).services || {})
        .filter((x) => x && x.containerIp && x.port && !x.suspended);
      const models = svcs.filter((x) => x.providerId === 'imagegen-models');
      const m = models.find((x) => x.node === FORGE_NODE) || models[0];
      if (m) return { base: `http://${m.containerIp}:${m.port}/forge`, legacy: false, service: m.id };
      const s = svcs.find((x) => x.providerId === 'dataset-forge');
      if (s) return { base: `http://${s.containerIp}:${s.port}`, legacy: true, service: s.id };
    }
  } catch (e) {
    console.warn(`[forge-endpoint] could not read ${ACTIVE}: ${e.message}; using ${FALLBACK}`);
  }
  return { base: FALLBACK, legacy: true, service: null };
}

export function forgeEndpoint() {
  return forgeTarget().base;
}

/** Status URL for an ingest job: /forge/job?id= on the plugin, /job/<id> on the legacy service. */
export function forgeJobUrl(id) {
  const t = forgeTarget();
  return t.legacy ? `${t.base}/job/${encodeURIComponent(id)}` : `${t.base}/job?id=${encodeURIComponent(id)}`;
}
