// Native service-discovery API (replaces the ProxLab-bridged /api/discovery).
//
// Reads the ground-truth cluster probe output (<dataDir>/cluster-services.json, refreshed every 10 min by
// the dynacat-config timer running /opt/ai-lab/cluster-probe/cluster-probe.py — pct exec ss per LXC, direct
// ss per PVE node, TCP-scan for VMs). Shapes it into the { hostId: DiscoveryHost } object the Services tab
// expects, enriched with app/category/icon/url/status from the community-scripts catalog. POST /scan re-runs
// the probe on demand. Nothing here touches ProxLab.
import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';

const PROBE = process.env.CLUSTER_PROBE || '/opt/ai-lab/cluster-probe/cluster-probe.py';

export function createDiscoveryRouter({ dataDir }) {
  const FILE = join(dataDir, 'cluster-services.json');
  const router = Router();

  const read = () => {
    try {
      return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf-8')) : { hosts: [] };
    } catch {
      return { hosts: [] };
    }
  };

  // probe service -> Services-tab DiscoveredService (name drives resolveName; rich fields drive the UI).
  const mapSvc = (s) => ({
    port: s.port,
    process: s.process || '',
    name: s.app || s.process || `:${s.port}`,
    proto: s.proto,
    status: s.status ?? null,
    url: s.url || null,
    category: s.category || 'app',
    icon: s.icon || null,
    knownScript: !!s.knownScript,
    title: s.title || '',
  });

  // probe host -> DiscoveryHost (reachable/ext-bound services only — loopback isn't actionable).
  const mapHost = (h, ts) => ({
    hostId: h.hostId,
    hostName: h.hostName,
    hostIp: h.hostIp,
    vmid: h.vmid ?? null,
    guestType: h.guestType,
    node: h.node ?? null,
    timestamp: ts,
    services: (h.services || []).filter((s) => s.bind === 'ext').map(mapSvc),
  });

  const snapshot = () => {
    const d = read();
    const ts = (d.generatedAt || 0) * 1000;
    const out = {};
    for (const h of d.hosts || []) out[h.hostId] = mapHost(h, ts);
    return out;
  };

  const runProbe = () =>
    new Promise((resolve) => {
      execFile('python3', [PROBE], { timeout: 180000 }, (err, _stdout, stderr) => {
        // Discarding err meant a missing/crashing probe returned HTTP 200 with
        // the PREVIOUS snapshot — the Services tab showed aged data as fresh.
        if (err) console.warn(`[discovery] probe failed — serving the previous snapshot: ${err.message}${stderr ? ` — ${String(stderr).slice(0, 300)}` : ''}`);
        resolve();
      });
    });

  // GET /api/discovery — current snapshot (≤10 min fresh from the timer).
  router.get('/', (_req, res) => res.json(snapshot()));

  // POST /api/discovery/scan — re-run the probe now, then return the full snapshot.
  router.post('/scan', async (_req, res) => {
    await runProbe();
    res.json(snapshot());
  });

  // POST /api/discovery/scan/:hostId — re-run the probe, return just that host.
  router.post('/scan/:hostId', async (req, res) => {
    await runProbe();
    const snap = snapshot();
    res.json(snap[req.params.hostId] || { hostId: req.params.hostId, services: [], error: 'host not found' });
  });

  return router;
}
