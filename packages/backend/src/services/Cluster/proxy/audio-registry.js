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
// Membership is derived from TTS_PROVIDER_CAPS via isPooledTtsProvider() below.
// This set is populated at startup by setProviderCaps() so listBackends() stays a
// cheap synchronous lookup.
export const TTS_POOL_PROVIDERS = new Set();

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


// ─── Provider capabilities + pool membership ────────────────────────────────
//
// proxy.js owns TTS_PROVIDER_CAPS and hands it over once at startup, so there is
// exactly one description of what each provider can do.
let _caps = {};

export function setProviderCaps(caps) {
  _caps = caps || {};
  // Recompute pool membership so listBackends() stays a synchronous Set lookup
  // instead of re-deriving from caps on every call.
  TTS_POOL_PROVIDERS.clear();
  for (const id of Object.keys(_caps)) {
    if (isPooledTtsProvider(id)) TTS_POOL_PROVIDERS.add(id);
  }
}

export function getProviderCaps() {
  return _caps;
}

/**
 * A provider joins the balanced TTS pool iff it synthesises from a reference
 * voice CLIP and speaks the OpenAI speech API.
 *
 * clipVoice is the load-bearing half. Clip engines resolve voices from the same
 * shared NAS library, so a voice name means the same thing on every pooled
 * backend and /tts/v1/voices can stay one flat namespace. Admitting fixed-voice
 * engines (kokoro's baked-in speakers, piper) would collide voice IDs across
 * providers and force provider/voice compounding through the whole surface.
 *
 * Non-pooled providers are NOT dropped — they keep their individual slot
 * endpoints (/api/proxy/tts/N/v1/...). They just never receive balanced traffic
 * and never appear in /tts/v1/models.
 */
export function isPooledTtsProvider(providerId) {
  const c = _caps[providerId];
  return Boolean(c && c.clipVoice === true && c.openai === true);
}

// ─── Composite provider/model IDs ───────────────────────────────────────────
//
// /tts/v1/models advertises `<providerId>/<modelId>` so one endpoint can expose
// several providers at once and the caller picks both from a single dropdown.
//
// Accepted selectors, in order of specificity:
//   "chatterbox/chatterbox-turbo"  exact provider + model
//   "chatterbox-turbo"             model on ANY pooled provider that serves it
//   undefined                      caller's default
//
// Bare IDs must keep working: every existing consumer sends one.

export function parseModelSelector(raw) {
  if (!raw || typeof raw !== 'string') return { providerId: null, model: null, raw: raw || '' };
  const i = raw.indexOf('/');
  if (i === -1) return { providerId: null, model: raw, raw };
  return { providerId: raw.slice(0, i), model: raw.slice(i + 1), raw };
}

export function compositeId(providerId, model) {
  return `${providerId}/${model}`;
}

/**
 * Build the catalog of composite models across a set of backends.
 *
 * Providers that expose a models endpoint are asked what they serve. Providers
 * that do not (caps.models === null) get one synthetic entry named after
 * themselves, so they are still addressable rather than invisible.
 *
 * NO hardcoded model list. The old /multi-tts/v1/models asked only the FIRST
 * healthy instance and fell back to a literal chatterbox list, so a pool serving
 * something else would still advertise chatterbox and a totally empty pool would
 * advertise models that do not exist.
 *
 * @param {(url: string) => Promise<any>} fetchJson
 */
export async function buildModelCatalog(backends, fetchJson) {
  const byComposite = new Map();
  const errors = [];

  await Promise.all(backends.map(async (svc) => {
    const caps = _caps[svc.providerId] || {};
    const base = `http://${svc.containerIp}:${svc.port}`;

    if (!caps.models) {
      const id = compositeId(svc.providerId, svc.providerId);
      if (!byComposite.has(id)) {
        byComposite.set(id, { compositeId: id, providerId: svc.providerId, model: svc.providerId, backends: [] });
      }
      byComposite.get(id).backends.push(svc);
      return;
    }

    try {
      const data = await fetchJson(base + caps.models);
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      for (const m of list) {
        const modelId = typeof m === 'string' ? m : m?.id;
        if (!modelId) continue;
        const id = compositeId(svc.providerId, modelId);
        if (!byComposite.has(id)) {
          byComposite.set(id, {
            compositeId: id,
            providerId: svc.providerId,
            model: modelId,
            ownedBy: (typeof m === 'object' && m?.owned_by) || svc.providerId,
            backends: [],
          });
        }
        byComposite.get(id).backends.push(svc);
      }
    } catch (err) {
      // Surface it. A backend that cannot be asked what it serves is a real
      // condition the caller should see, not something to paper over.
      errors.push(`${svc.providerId}@${svc.containerIp}:${svc.port}: ${err.message}`);
    }
  }));

  return { models: [...byComposite.values()], errors };
}

/**
 * Candidate backends for a selector. Returns [] rather than guessing, plus a
 * reason precise enough to debug from the 503 alone.
 */
export function selectBackends(catalog, selectorRaw) {
  const sel = parseModelSelector(selectorRaw);

  if (sel.providerId) {
    const hit = catalog.find((e) => e.compositeId === sel.raw);
    if (hit) return { backends: hit.backends, matched: hit.compositeId };
    return {
      backends: [],
      matched: null,
      reason: `no pooled backend serves '${sel.raw}'`,
    };
  }

  if (sel.model) {
    const hits = catalog.filter((e) => e.model === sel.model);
    if (hits.length) {
      return { backends: hits.flatMap((h) => h.backends), matched: hits.map((h) => h.compositeId).join(', ') };
    }
    return {
      backends: [],
      matched: null,
      reason: `no pooled backend serves model '${sel.model}' (available: ${catalog.map((e) => e.compositeId).join(', ') || 'none'})`,
    };
  }

  return { backends: catalog.flatMap((e) => e.backends), matched: 'any' };
}

// ─── Catalog cache ──────────────────────────────────────────────────────────
// Model lists change only when a service is launched or swapped, so a short TTL
// is plenty and keeps /models off the per-request fan-out path.
let _catalogCache = { at: 0, key: '', value: null };
const CATALOG_TTL_MS = 10000;

export async function getModelCatalog(backends, fetchJson, ttlMs = CATALOG_TTL_MS) {
  const key = backends.map((b) => `${b.providerId}@${b.containerIp}:${b.port}`).sort().join('|');
  const now = Date.now();
  if (_catalogCache.value && _catalogCache.key === key && now - _catalogCache.at < ttlMs) {
    return _catalogCache.value;
  }
  const built = await buildModelCatalog(backends, fetchJson);
  _catalogCache = { at: now, key, value: built };
  return built;
}

export function invalidateModelCatalog() {
  _catalogCache = { at: 0, key: '', value: null };
}
