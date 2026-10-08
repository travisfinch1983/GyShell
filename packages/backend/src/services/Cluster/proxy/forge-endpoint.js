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

export function forgeEndpoint() {
  try {
    if (existsSync(ACTIVE)) {
      const svcs = Object.values(JSON.parse(readFileSync(ACTIVE, 'utf-8')).services || {});
      const s = svcs.find((x) => x && x.providerId === 'dataset-forge' && x.containerIp && x.port && !x.suspended);
      if (s) return `http://${s.containerIp}:${s.port}`;
    }
  } catch (e) {
    console.warn(`[forge-endpoint] could not read ${ACTIVE}: ${e.message}; using ${FALLBACK}`);
  }
  return FALLBACK;
}
