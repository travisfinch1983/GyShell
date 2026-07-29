/**
 * AI-Lab audio backend registry — TTS, STT and post-processing (RVC).
 *
 * Single source of truth for "which running services can serve audio work, and
 * which one should this request go to". Replaces three ad-hoc finder functions
 * in proxy.js that each had their own provider-ID filter and their own hardcoded
 * fallback.
 *
 * WHY THIS EXISTS — the fallback bug
 * ----------------------------------
 * The finders used to end with, in effect:
 *
 *     if (registered.length > 0) return registered;
 *     return ALWAYS_ON_PORTS.map(port => ({ containerIp: '10.0.0.235', port }));
 *
 * That is a silent lie. When a filter stopped matching — because a providerId was
 * renamed, or services moved hosts — the function did not report "nothing found",
 * it reported a hardcoded guess. Two real incidents came from exactly this:
 *
 *   - findAllRvcServices() filtered providerId === 'proxlab-rvc' while every row
 *     was written as 'rvc'. It never matched, so it always answered with the
 *     ai-gpu fallback. After RVC was migrated to ai-epyc the endpoints still
 *     reported ai-gpu, which read as stale data rather than a broken filter.
 *   - findRvcService() had the same filter and was never fixed, so all four
 *     /rvc/* routes ran on the fallback 100% of the time. It "worked" only
 *     because the fallback host happened to match where RVC actually ran.
 *
 * So: this module has NO fallbacks. If nothing matches, callers get an empty list
 * and a reason string they can put in a 503. A loud failure is recoverable; a
 * confident wrong answer is not.
 */

// ─── Pool membership ────────────────────────────────────────────────────────
//
// Only voice-CLIP-style providers join the universal TTS pool (decided 2026-07-29).
// Clip-style engines resolve voices from the same shared NAS library, so a voice
// name means the same thing on every pooled backend and /tts/v1/voices can stay a
// single flat namespace. Admitting fixed-voice engines (kokoro et al) would make
// voice IDs collide across providers and force provider/voice compounding
// everywhere. Non-pooled providers are NOT dropped — they remain reachable on
// their individual slot endpoints, they just never receive balanced traffic.
//
// Phase 2 will derive this from a `clipVoice` flag on TTS_PROVIDER_CAPS instead of
// a literal set. Kept explicit for now so Phase 1 changes no routing behaviour.
export const TTS_POOL_PROVIDERS = new Set(['proxlab-tts']);

// RVC is a POST-PROCESSOR, not a TTS provider: separate lane, its own model
// namespace (speaker .pth checkpoints), never selectable as a TTS model.
// Both IDs accepted — rows are written as 'rvc', but 'proxlab-rvc' appears in
// older data and in code written before the rename.
export const POST_PROVIDERS = new Set(['rvc', 'proxlab-rvc']);

export const STT_POOL_PROVIDERS = new Set(['faster-whisper']);

const KIND_PROVIDERS = {
  tts: TTS_POOL_PROVIDERS,
  stt: STT_POOL_PROVIDERS,
  post: POST_PROVIDERS,
};

/**
 * All registered backends of a kind, slot-ordered. No fallback: an empty array
 * means nothing is registered, and that is the truth.
 *
 * @param {Object} services - the `services` map from active-services.json
 * @param {'tts'|'stt'|'post'} kind
 */
export function listBackends(services, kind) {
  const allow = KIND_PROVIDERS[kind];
  if (!allow) throw new Error(`unknown audio kind: ${kind}`);
  return Object.values(services || {})
    .filter((svc) => allow.has(svc.providerId) && svc.containerIp && svc.port)
    .sort((a, b) => (a.proxySlot || 999) - (b.proxySlot || 999));
}

/**
 * Explain an empty/unhealthy result well enough to debug from the 503 alone.
 * "No healthy TTS" tells you nothing; "3 registered, 0 healthy" vs "0 registered"
 * are completely different problems.
 */
export function emptyReason(kind, { registered = 0, healthy = 0, selector } = {}) {
  const what = selector ? `${kind} '${selector}'` : kind;
  if (registered === 0) {
    const allow = [...(KIND_PROVIDERS[kind] || [])].join(', ');
    return `no ${what} backends registered (accepted providerIds: ${allow})`;
  }
  if (healthy === 0) return `${registered} ${what} backend(s) registered, 0 healthy`;
  return `no ${what} backend available`;
}

// ─── Balancing ──────────────────────────────────────────────────────────────
//
// Per-SELECTOR counters, not one global. The old code kept a single module-level
// _rrTtsIndex shared by every model, so with two models running it interleaved
// them against a mismatched base. Keying by selector means 3 copies of model A
// balance among themselves and 2 copies of model B among themselves — the same
// rule proxy_notes specifies for embeddings/rerankers.
//
// Counters are monotonic and modulo'd at read time. The old code stored the
// already-wrapped value, so when the healthy-instance count changed between
// requests the next index wrapped against a different base and the rotation
// skipped.
const _counters = new Map();

/** Next index into a `length`-sized candidate list for this selector. */
export function nextIndex(selectorKey, length) {
  if (!length || length < 1) return 0;
  const n = _counters.get(selectorKey) || 0;
  _counters.set(selectorKey, (n + 1) % Number.MAX_SAFE_INTEGER);
  return n % length;
}

/** Round-robin pick. Returns null (never a guess) when there are no candidates. */
export function pickRoundRobin(selectorKey, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return candidates[nextIndex(selectorKey, candidates.length)];
}

/** Test/debug helper — drop all balancer state. */
export function resetBalancer() {
  _counters.clear();
}

// ─── Health caching ─────────────────────────────────────────────────────────
//
// buildHealthyPipelines() probed every instance on every request. With one
// provider that was tolerable; with a pool it is a per-request fan-out of HTTP
// calls on the hot path. Cache with a short TTL — long enough to collapse the
// burst of probes a single synthesis triggers, short enough that a dead backend
// is noticed within a few seconds.
const DEFAULT_TTL_MS = 3000;

/**
 * @param {(host: string, port: number) => Promise<boolean>} probe
 */
export function createHealthCache(probe, ttlMs = DEFAULT_TTL_MS) {
  const cache = new Map(); // key -> { healthy, at, inflight }

  async function isHealthy(host, port) {
    const key = `${host}:${port}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.healthy;
    // Collapse concurrent probes of the same backend into one request.
    if (hit?.inflight) return hit.inflight;

    const inflight = probe(host, port).then(
      (healthy) => {
        cache.set(key, { healthy, at: Date.now() });
        return healthy;
      },
      () => {
        cache.set(key, { healthy: false, at: Date.now() });
        return false;
      },
    );
    cache.set(key, { ...(hit || {}), inflight });
    return inflight;
  }

  /** Annotate a backend list with health, concurrently. */
  async function withHealth(backends) {
    return Promise.all(
      backends.map(async (svc) => ({
        svc,
        healthy: await isHealthy(svc.containerIp, svc.port),
      })),
    );
  }

  /** Force a re-probe (e.g. after a launch/teardown). */
  function invalidate(host, port) {
    if (host && port) cache.delete(`${host}:${port}`);
    else cache.clear();
  }

  return { isHealthy, withHealth, invalidate };
}
