/**
 * shared-folder-mappings.js — Provider Symlink Mappings
 *
 * Static map of provider → shared folder category → relative path inside /opt/{provider}/.
 * Used by shared-symlinks.sh at install time to create symlinks from provider-internal
 * paths to shared mount points.
 *
 * @module shared-folder-mappings
 */

export const PROVIDER_SYMLINK_MAP = {
  // TTS / STT providers
  alltalk: {
    'rvc-models':    'models/rvc_voices',
    'xtts-models':   'models/xtts',
    'tts-outputs':   'outputs',
  },
  'tts-webui': {
    'rvc-models':    'data/models/rvc/checkpoints',
    'whisper-models':'data/models/whisper/cache',
    'tts-outputs':   'outputs',
    'rvc-outputs':   'outputs-rvc',
  },
  // piper: Piper uses .onnx voice models — no shared category yet
  'openedai-speech':  { 'xtts-models': 'voices' },
  kokoro:             { 'tts-outputs': 'output' },
  'faster-whisper':   { 'whisper-models': 'models' },
  // LLM providers
  koboldcpp:          { 'llm-models': 'models' },
  vllm:               { 'llm-models': 'models' },
  tabbyapi:           { 'llm-models': 'models' },
  lmdeploy:           { 'llm-models': 'models' },
  sglang:             { 'llm-models': 'models' },
  aphrodite:          { 'llm-models': 'models' },
  ollama:             { 'ollama-models': 'models' },
};

/**
 * Get the symlink mappings for a specific provider.
 * @param {string} providerId - Provider ID
 * @returns {Object|null} Map of category → relative path, or null
 */
export function getProviderSymlinks(providerId) {
  return PROVIDER_SYMLINK_MAP[providerId] || null;
}
