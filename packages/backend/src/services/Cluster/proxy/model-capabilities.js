// Model capability resolver — best-effort modality inference from a model id.
// Single source of truth for (a) the picker's capability badges (proxy.js enriches
// each /v1/models entry with `capabilities`) and (b) Feature-A vision gating
// (hermesHttp visionCapable). Name-based today; a follow-up can enrich with real
// per-provider modality (e.g. OpenRouter architecture.modality) where a source exposes it.
//
// Key rule (Travis, 2026-07): Qwen 3.5+ are NATIVELY multimodal (vision) — there is no
// longer a separate VL/mmproj variant required, so any Qwen >= 3.5 is vision-capable.

// Catalog-learned modalities, registered by proxy.js whenever it fetches an external
// source's catalog (OpenRouter reports architecture.input_modalities per model).
// CATALOG TRUTH BEATS NAME INFERENCE in both directions: z-ai/glm-5.3-flash is
// natively multimodal but matches no name pattern (caught live, 2026-09-02), and a
// model wearing "vision" in its name that lost its eyes upstream stops claiming them.
// The heuristics below remain the fallback for silent catalogs (Anthropic, DeepSeek)
// and for local vLLM models, which never pass through an external catalog.
const catalogModalities = new Map();

export function registerCatalogModalities(modelId, modalities) {
  if (!modelId || !Array.isArray(modalities)) return;
  catalogModalities.set(String(modelId).toLowerCase(), modalities.map((x) => String(x).toLowerCase()));
}

function catalogFor(s) {
  // ids arrive bare ("z-ai/glm-5.3-flash") or proxy-tagged ("(or) z-ai/glm-5.3-flash" /
  // legacy "[or] ..."); variant suffixes fall back to their base entry.
  const bare = s.replace(/^[([][a-z0-9_-]+[)\]]\s*/i, '');
  return catalogModalities.get(bare)
    ?? catalogModalities.get(bare.replace(/:(batch|free)$/, ''))
    ?? null;
}

/** @returns {{ text: boolean, vision: boolean, audio: boolean, video: boolean }} */
export function resolveModelCapabilities(id) {
  const s = String(id || '').toLowerCase();
  const caps = { text: true, vision: false, audio: false, video: false };
  if (!s) return caps;

  const fromCatalog = catalogFor(s);
  if (fromCatalog) {
    caps.vision = fromCatalog.includes('image');
    caps.audio = fromCatalog.includes('audio');
    caps.video = fromCatalog.includes('video');
    return caps;
  }

  // Qwen 3.5+ (native multimodal) — 3.5..3.9, or major 4+.
  if (/qwen[\s._-]*3\.?[5-9]/.test(s) || /qwen[\s._-]*[4-9]\b/.test(s)) caps.vision = true;
  // Explicit vision markers / known multimodal open models.
  if (/\b(vl|vision|omni|multimodal)\b|internvl|llava|minicpm-?v|pixtral|molmo/.test(s)) caps.vision = true;
  // Cloud vision families.
  if (/gpt-4o|gpt-4\.1|o[134]\b|claude-(3|4|opus|sonnet|haiku)|gemini|llama[\w.-]*vision/.test(s)) caps.vision = true;

  // Audio-in/out capable (omni / dedicated audio / voice models).
  if (/\bomni\b|\baudio\b|\bvoice\b|qwen[\w.-]*audio/.test(s)) caps.audio = true;

  return caps;
}
