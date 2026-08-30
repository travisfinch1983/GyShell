// ─────────────────────────────────────────────────────────────────────────────
// Optane KV cache status — one view over BOTH engines, for the AI Metrics tab.
// ─────────────────────────────────────────────────────────────────────────────
// The Optane cache was silently broken for months and nothing in the UI could have shown it.
// This endpoint exists to make "is it working right now" answerable at a glance, so it reports
// what is actually TRUE of the running system rather than what the config intends:
//
//   * wiring is read from live process cmdlines on the GPU node (/proc), not from launcher
//     scripts. A launcher on disk can disagree with the running process: ai.js regenerates it on
//     every UI launch, and a service can have been started from an older copy.
//   * llama.cpp snapshots come from the KV index DBs, which carry real hit_count / created_at /
//     last_used per snapshot — that is what "ranked by restore frequency" is built on.
//   * vLLM has no per-snapshot concept to rank: its tier is content-addressed BLOCKS, shared
//     across conversations by construction. The honest equivalent is the hotness sidecar, which
//     records lookups per block, so vLLM pools report block-level reuse instead of pretending
//     to have snapshots.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { KvIndex } from './index-store.js';

const KV_DATA_DIR = process.env.AILAB_KV_DATA_DIR || '/opt/ai-lab/.gybackend-data/kvcache';
const VLLM_OPTANE_BASE = process.env.AILAB_VLLM_OPTANE_BASE || '/optane-sock1/vllm-kv';

const COLLECTOR = String.raw`
# Runs ON a GPU node. Emits ONE JSON blob describing the Optane KV state.
#
# Wiring is read from LIVE PROCESS CMDLINES, not from config files or launcher scripts: the
# question the dashboard has to answer is "is the cache actually attached to what is running
# right now", and a launcher on disk can disagree with the running process (it is regenerated on
# every UI launch, and a service can be started from an older copy). /proc is the ground truth.
import json, os, re, sys

def read(p):
    try:
        with open(p, 'rb') as f: return f.read()
    except Exception: return b''

def engines():
    out = []
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        raw = read('/proc/%s/cmdline' % pid)
        if not raw: continue
        args = [a for a in raw.split(b'\0') if a]
        try: args = [a.decode('utf-8', 'replace') for a in args]
        except Exception: continue
        joined = ' '.join(args)
        rec = None
        if 'vllm' in joined and 'serve' in args:
            rec = {'pid': int(pid), 'engine': 'vllm', 'kvDir': None, 'port': None, 'model': None}
            for i, a in enumerate(args):
                if a == 'serve' and i + 1 < len(args): rec['model'] = args[i + 1]
                if a == '--port' and i + 1 < len(args): rec['port'] = args[i + 1]
                if a == '--kv-transfer-config' and i + 1 < len(args):
                    try:
                        cfg = json.loads(args[i + 1])
                        tiers = (cfg.get('kv_connector_extra_config') or {}).get('secondary_tiers') or []
                        rec['specName'] = (cfg.get('kv_connector_extra_config') or {}).get('spec_name')
                        rec['cpuBytes'] = (cfg.get('kv_connector_extra_config') or {}).get('cpu_bytes_to_use')
                        if tiers: rec['kvDir'] = tiers[0].get('root_dir')
                    except Exception as e:
                        rec['configError'] = str(e)
        elif 'llama-server' in joined:
            rec = {'pid': int(pid), 'engine': 'llama.cpp', 'kvDir': None, 'port': None, 'model': None}
            for i, a in enumerate(args):
                if a == '--port' and i + 1 < len(args): rec['port'] = args[i + 1]
                if a == '--model' and i + 1 < len(args): rec['model'] = args[i + 1]
                if a == '--slot-save-path' and i + 1 < len(args): rec['kvDir'] = args[i + 1]
        if rec:
            rec['kvEnabled'] = bool(rec.get('kvDir'))
            out.append(rec)
    return out

def dirstat(d, top=8):
    n = 0; b = 0; oldest = None; newest = None
    for root, _, files in os.walk(d):
        for f in files:
            if f == 'hotness.json': continue
            try:
                st = os.stat(os.path.join(root, f))
            except OSError:
                continue
            b += st.st_size; n += 1
            if oldest is None or st.st_mtime < oldest: oldest = st.st_mtime
            if newest is None or st.st_mtime > newest: newest = st.st_mtime
    rec = {'path': d, 'name': os.path.basename(d.rstrip('/')), 'files': n, 'bytes': b,
           'oldest': oldest, 'newest': newest, 'hotness': None}
    hp = os.path.join(d, 'hotness.json')
    if os.path.exists(hp):
        try:
            h = json.loads(read(hp).decode('utf-8'))
            # {block_hash: [hits, last_hit_epoch]}
            items = [(k, v[0], v[1]) for k, v in h.items() if isinstance(v, (list, tuple)) and len(v) >= 2]
            items.sort(key=lambda t: (-t[1], -t[2]))
            rec['hotness'] = {
                'tracked': len(items),
                'totalHits': sum(t[1] for t in items),
                'reusedBlocks': sum(1 for t in items if t[1] > 1),
                'lastHit': max([t[2] for t in items]) if items else None,
                'top': [{'block': t[0][:16], 'hits': t[1], 'lastHit': t[2]} for t in items[:top]],
            }
        except Exception as e:
            rec['hotnessError'] = str(e)
    return rec

def df(path):
    try:
        s = os.statvfs(path)
        return {'mount': path, 'sizeBytes': s.f_blocks * s.f_frsize,
                'availBytes': s.f_bavail * s.f_frsize,
                'usedBytes': (s.f_blocks - s.f_bfree) * s.f_frsize}
    except Exception:
        return None

def scrape(port):
    """Pull the offload counters from the engine itself.

    This is what makes the dashboard able to answer "is it working" rather than "is it
    configured": storedBytes climbs as soon as the connector is attached at all, but
    restoredBytes climbs ONLY on a real hit. Stored rising while restored stays at 0 is the
    signature of a cache that is present but dead."""
    import urllib.request
    out = {}
    try:
        with urllib.request.urlopen('http://127.0.0.1:%s/metrics' % port, timeout=6) as r:
            for line in r.read().decode('utf-8', 'replace').split('\n'):
                if line.startswith('#') or ' ' not in line: continue
                name, val = line.rsplit(' ', 1)
                try: v = float(val)
                except ValueError: continue
                if name.startswith('vllm:kv_offload_total_bytes_total'):
                    k = 'storedBytes' if 'GPU_to_CPU' in name else 'restoredBytes'
                    out[k] = out.get(k, 0.0) + v
                elif name.startswith('vllm:kv_offload_total_time_total'):
                    k = 'storedSec' if 'GPU_to_CPU' in name else 'restoredSec'
                    out[k] = out.get(k, 0.0) + v
                elif name.startswith('vllm:external_prefix_cache_hits_total'):
                    out['extHits'] = out.get('extHits', 0.0) + v
                elif name.startswith('vllm:external_prefix_cache_queries_total'):
                    out['extQueries'] = out.get('extQueries', 0.0) + v
    except Exception as e:
        out['error'] = str(e)
    return out

base = sys.argv[1] if len(sys.argv) > 1 else '/optane-sock1/vllm-kv'
procs = engines()
for p in procs:
    if p['engine'] == 'vllm' and p.get('port'):
        p['metrics'] = scrape(p['port'])

# Pools: every directory under the configured base, PLUS any directory a live engine points at
# outside it (so a hand-configured service still shows up rather than silently missing).
dirs = []
if os.path.isdir(base):
    dirs += [os.path.join(base, e) for e in sorted(os.listdir(base)) if os.path.isdir(os.path.join(base, e))]
for p in procs:
    d = p.get('kvDir')
    if d and p['engine'] == 'vllm' and os.path.isdir(d) and d not in dirs:
        dirs.append(d)

pools = [dirstat(d) for d in dirs]
for p in pools:
    p['usedBy'] = [{'pid': e['pid'], 'port': e['port'], 'engine': e['engine']}
                   for e in procs if e.get('kvDir') and os.path.normpath(e['kvDir']) == os.path.normpath(p['path'])]

# One entry per FILESYSTEM. Keyed on st_dev: every pool dir lives on the same device as its
# base, so keying on the probed path would report the same filesystem once per pool and make the
# dashboard look like there is far more capacity than exists.
mounts = []
seen = set()
for cand in ([base] + [p['path'] for p in pools] + ['/dev/shm']):
    try:
        mp = os.path.realpath(cand)
        dev = os.stat(mp).st_dev
    except Exception: continue
    if dev in seen: continue
    d = df(mp)
    if d:
        seen.add(dev); mounts.append(d)

shm = [f for f in os.listdir('/dev/shm') if f.startswith('vllm_offload_')] if os.path.isdir('/dev/shm') else []
shm_bytes = 0
for f in shm:
    try: shm_bytes += os.stat(os.path.join('/dev/shm', f)).st_size
    except OSError: pass

print(json.dumps({'engines': procs, 'pools': pools, 'filesystems': mounts,
                  'shmRegions': {'count': len(shm), 'bytes': shm_bytes}}))
`;

/** llama.cpp snapshots, ranked by how often each has actually been restored. */
export function getKvSnapshots({ limit = 100 } = {}) {
  const out = [];
  let dbs = [];
  try { dbs = readdirSync(KV_DATA_DIR).filter((f) => f.endsWith('.db')); } catch { dbs = []; }
  for (const f of dbs) {
    // Read every DB on disk, not just the ones with a live orchestrator: a snapshot is still
    // stored (and still occupying Optane) while its service is stopped, and hiding it would make
    // the pool look smaller than it is.
    let idx;
    try { idx = new KvIndex(join(KV_DATA_DIR, f)); } catch (e) { out.push({ db: f, error: e?.message || String(e) }); continue; }
    try {
      for (const fp of idx.modelFps()) {
        for (const r of idx.topSnapshots(fp, limit)) {
          out.push({
            hash: r.hash, modelFp: r.model_fp, tokens: r.n_tokens, bytes: r.bytes,
            kind: r.kind, createdAt: r.created_at, lastRestoredAt: r.last_used,
            restoreCount: r.hit_count, engine: 'llama.cpp',
          });
        }
      }
    } catch (e) { out.push({ db: f, error: e?.message || String(e) }); }
    finally { try { idx.close?.(); } catch {} }
  }
  // most-restored first — the ranking the dashboard is specified around
  out.sort((a, b) => (b.restoreCount ?? -1) - (a.restoreCount ?? -1) || (b.lastRestoredAt ?? 0) - (a.lastRestoredAt ?? 0));
  return out.slice(0, limit);
}

/**
 * Gather Optane KV state from every node that currently hosts an LLM service.
 * Never throws: a node that cannot be reached is reported as an error entry rather than
 * failing the whole panel, because a broken cache and an unreachable node must not look alike.
 */
export async function collectOptaneStatus(sshService, services = []) {
  const hosts = [...new Set(services.map((s) => s.containerIp).filter(Boolean))];
  const b64 = Buffer.from(COLLECTOR, 'utf8').toString('base64');
  const nodes = await Promise.all(hosts.map(async (host) => {
    const svcOnHost = services.filter((s) => s.containerIp === host);
    const node = svcOnHost[0]?.node || null;
    try {
      const r = await sshService.exec(host, `echo ${b64} | base64 -d | python3 - ${VLLM_OPTANE_BASE}`, { timeout: 30000 });
      if (r.code !== 0) return { host, node, error: (r.stderr || r.stdout || `exit ${r.code}`).slice(0, 400) };
      return { host, node, ...JSON.parse(r.stdout) };
    } catch (e) {
      return { host, node, error: e?.message || String(e) };
    }
  }));

  // Attach the AI-Lab service identity to each engine the collector found, matching on port —
  // the collector only knows PIDs and ports, the service list only knows names.
  for (const n of nodes) {
    for (const e of n.engines || []) {
      const svc = services.find((s) => s.containerIp === n.host && String(s.port) === String(e.port));
      if (svc) {
        e.serviceId = svc.id;
        e.name = svc.aliasOverride || svc.model || svc.id;
        e.providerId = svc.providerId;
      }
    }
  }

  return {
    generatedAt: Date.now(),
    vllmOptaneBase: VLLM_OPTANE_BASE,
    nodes,
    snapshots: getKvSnapshots({ limit: 100 }),
  };
}
