/**
 * AI-Lab audio pipeline configuration — persisted post-processing defaults.
 *
 * Until now RVC was per-request only: a caller either passed `rvc_model` or it did
 * not happen. There was no way to say "re-voice everything through this speaker by
 * default", and no UI for it at all, so the only way to turn RVC on was to know the
 * magic body field.
 *
 * This holds the DEFAULTS. Per-request fields still win — a caller that names its
 * own rvc_model, or passes `rvc: false` to force the pipeline off for one request,
 * always beats the stored config. Defaults should never take control away from an
 * explicit request.
 *
 * Structured as `post: { rvc: {...} }` rather than a flat rvc block so a second
 * post-processor (denoise, loudness normalisation, a different converter) can be
 * added without reshaping the file or migrating anyone's saved settings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const DATA_DIR = process.env.AILAB_PROXY_DATA_DIR
  || '/opt/ai-lab/.gybackend-data';
const FILE = join(DATA_DIR, 'ailab-audio-pipeline.json');

/**
 * RVC tunables mirror what the RVC backend accepts. Values match the hardcoded
 * defaults the speech routes used before this file existed, so introducing it
 * changes nothing until someone actually edits a setting.
 */
export const PIPELINE_DEFAULTS = {
  post: {
    rvc: {
      enabled: false,        // off by default — matches prior behaviour exactly
      model: null,           // speaker checkpoint; null = none chosen yet
      f0_method: 'rmvpe',
      f0_up_key: 0,
      index_rate: 0.75,
      filter_radius: 3,
      rms_mix_rate: 0.25,
      protect: 0.33,
      resample_sr: 48000,
    },
  },
};

let _cache = null;

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** Deep-merge stored values over defaults so a partial/older file still loads. */
function mergeDefaults(stored) {
  const out = clone(PIPELINE_DEFAULTS);
  if (!stored || typeof stored !== 'object') return out;
  for (const [group, entries] of Object.entries(stored.post || {})) {
    if (!out.post[group]) out.post[group] = {};
    Object.assign(out.post[group], entries || {});
  }
  return out;
}

export function getPipelineConfig() {
  if (_cache) return clone(_cache);
  let stored = null;
  try {
    if (existsSync(FILE)) stored = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (err) {
    // A corrupt file must not take the proxy down, but it must not be silent
    // either — falling back to defaults while pretending nothing happened is how
    // a wrong config survives for weeks.
    console.error(`[audio-pipeline] ${FILE} unreadable, using defaults: ${err.message}`);
  }
  _cache = mergeDefaults(stored);
  return clone(_cache);
}

export function savePipelineConfig(patch) {
  const cur = getPipelineConfig();
  for (const [group, entries] of Object.entries(patch?.post || {})) {
    if (!cur.post[group]) cur.post[group] = {};
    Object.assign(cur.post[group], entries || {});
  }
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(cur, null, 2));
  _cache = cur;
  return clone(cur);
}

/**
 * Fill a speech request body with the configured defaults.
 *
 * Precedence, strongest first:
 *   1. `rvc: false` in the request  -> pipeline OFF for this request, full stop
 *   2. `rvc_model` in the request   -> that model, plus any params the request set
 *   3. stored config, if enabled    -> its model and params
 *   4. nothing                      -> TTS only
 *
 * Mutates and returns `body`, so callers downstream see one shape whether the
 * values came from the request or the config.
 */
export function applyPipelineDefaults(body) {
  const cfg = getPipelineConfig();
  const rvc = cfg.post.rvc || {};

  // Explicit opt-out beats everything. Without this there is no way to get a
  // plain TTS response once a default speaker is configured.
  if (body.rvc === false) {
    delete body.rvc_model;
    return body;
  }

  if (!body.rvc_model && rvc.enabled && rvc.model) {
    body.rvc_model = rvc.model;
  }

  // Only fill params when the pipeline is actually going to run, and only where
  // the request left them out.
  if (body.rvc_model) {
    for (const k of ['f0_method', 'f0_up_key', 'index_rate', 'filter_radius',
                     'rms_mix_rate', 'protect', 'resample_sr']) {
      if (body[k] == null && rvc[k] != null) body[k] = rvc[k];
    }
  }
  return body;
}

/** Test/debug helper — drop the cached config. */
export function invalidatePipelineCache() {
  _cache = null;
}
