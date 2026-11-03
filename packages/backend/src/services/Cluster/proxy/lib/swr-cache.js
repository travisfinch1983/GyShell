// Single-flight, stale-while-revalidate wrapper for an expensive cache rebuild (claude1, 2026-11-03).
//
// Why: on 2026-11-03 10:04–10:27Z every model-catalog refresh took >12 s. Each cache miss started
// its OWN full rebuild, and /llm/v1/completions, /v1/models and /catalog all AWAITED it, so real
// chat traffic stalled behind a catalog probe and the "AI-Lab proxy DOWN" alert fired.
//
// Contract:
//   - fresh (age < ttlMs)                        → the cache, no work
//   - stale but usable (0 < age < staleMaxMs)    → the cache NOW; one background rebuild is started
//   - never built / invalidated / too old / force → await the (shared) rebuild
//   - at most one rebuild runs at a time; a rebuild that throws keeps the previous cache
//   - invalidate() makes the next call await a rebuild that STARTED after the invalidation, so a
//     rebuild already in flight (which may predate the change) is not taken as the answer.
export function createSwrRefresher({ name, ttlMs, staleMaxMs, getCache, build, slowMs = 5000, now = Date.now, log = console }) {
  let gen = 0;            // bumped by invalidate()
  let inflight = null;    // the running rebuild
  let inflightGen = -1;   // gen the running rebuild started under
  let followup = null;    // one queued rebuild for callers that need a post-invalidate answer

  function start() {
    if (inflight && inflightGen === gen) return inflight;
    if (inflight) {
      if (!followup) followup = inflight.then(() => { followup = null; return start(); });
      return followup;
    }
    const t0 = now();
    inflightGen = gen;
    inflight = Promise.resolve()
      .then(build)
      .catch((e) => {
        log.warn(`[${name}] refresh failed after ${now() - t0}ms: ${e?.message || e} — serving the previous cache`);
        return getCache();
      })
      .finally(() => {
        const ms = now() - t0;
        if (ms >= slowMs) log.warn(`[${name}] slow refresh: ${ms}ms (callers were served the stale cache where one existed)`);
        inflight = null;
      });
    return inflight;
  }

  async function refresh({ force = false } = {}) {
    const cache = getCache();
    const updatedAt = cache?.updatedAt || 0;
    const age = now() - updatedAt;
    if (!force && updatedAt > 0 && age < ttlMs) return cache;
    const p = start();
    if (!force && updatedAt > 0 && age < staleMaxMs) return cache;
    return p;
  }

  refresh.invalidate = () => { gen++; };
  refresh.inflight = () => inflight;
  return refresh;
}

// Per-source timing for a cache rebuild, so a slow refresh NAMES its culprit. A slow source is
// always logged; a failing one at most once per errEveryMs per source (down services fail fast
// every 30 s and would otherwise flood the journal).
export function createSourceTimer({ name, slowMs = 2000, errEveryMs = 10 * 60_000, now = Date.now, log = console }) {
  const lastErr = new Map();
  return async function timed(label, fn) {
    const t0 = now();
    try {
      const out = await fn();
      const ms = now() - t0;
      if (ms >= slowMs) log.warn(`[${name}] slow source ${label}: ${ms}ms (returned)`);
      return out;
    } catch (e) {
      const ms = now() - t0;
      const msg = e?.name === 'TimeoutError' ? `timed out after ${ms}ms` : (e?.message || String(e));
      const t = now();
      if (ms >= slowMs || !lastErr.has(label) || t - lastErr.get(label) >= errEveryMs) {
        lastErr.set(label, t);
        log.warn(`[${name}] source ${label} failed in ${ms}ms: ${msg}`);
      }
      throw e;
    }
  };
}
