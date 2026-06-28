/**
 * shared-folders.js — Shared Folder Configuration Helpers
 *
 * Provides utility functions for working with the shared-folders.json config.
 * Used by hookscript-deploy.js to generate container vars and mount entries.
 *
 * @module shared-folders
 */

const DEFAULT_SHARED_FOLDERS = {
  version: 1,
  containerMountParent: '/mnt/shared',
  groupBasePaths: {
    'media':     { enabled: true, basePath: '' },
    'nas':       { enabled: true, basePath: '' },
    'system':    { enabled: true, basePath: '' },
    'llm':       { enabled: true, basePath: '' },
    'tts':       { enabled: true, basePath: '' },
    'image-gen': { enabled: true, basePath: '' },
  },
  categories: {
    // Media
    'movies':          { group: 'media',     label: 'Movies',              hostPath: '' },
    'tv-shows':        { group: 'media',     label: 'TV Shows',            hostPath: '' },
    'cartoons':        { group: 'media',     label: 'Cartoons',            hostPath: '' },
    'anime':           { group: 'media',     label: 'Anime',               hostPath: '' },
    'music':           { group: 'media',     label: 'Music',               hostPath: '' },
    'audiobooks':      { group: 'media',     label: 'Audiobooks',          hostPath: '' },
    // NAS
    'personal':        { group: 'nas',       label: 'Personal',            hostPath: '' },
    'work':            { group: 'nas',       label: 'Work',                hostPath: '' },
    'shared':          { group: 'nas',       label: 'Shared',              hostPath: '' },
    'datasets':        { group: 'nas',       label: 'Datasets',            hostPath: '' },
    // System
    'docker-volumes':  { group: 'system',    label: 'Docker Volumes',      hostPath: '' },
    'service-configs': { group: 'system',    label: 'Service Configs',     hostPath: '' },
    // LLM
    'llm-models':      { group: 'llm',       label: 'LLM Models',          hostPath: '' },
    'ollama-models':   { group: 'llm',       label: 'Ollama Models',       hostPath: '' },
    // TTS / STT
    'rvc-models':      { group: 'tts',       label: 'RVC Models',          hostPath: '' },
    'rvc-outputs':     { group: 'tts',       label: 'RVC Outputs',         hostPath: '' },
    'xtts-models':     { group: 'tts',       label: 'XTTS Models',         hostPath: '' },
    'xtts-outputs':    { group: 'tts',       label: 'XTTS Outputs',        hostPath: '' },
    'whisper-models':  { group: 'tts',       label: 'Whisper Models',      hostPath: '' },
    'whisper-outputs': { group: 'tts',       label: 'Whisper Outputs',     hostPath: '' },
    'tts-outputs':     { group: 'tts',       label: 'TTS Outputs',         hostPath: '' },
    // Image Generation
    'checkpoints':     { group: 'image-gen', label: 'Checkpoints',         hostPath: '' },
    'loras':           { group: 'image-gen', label: 'LoRAs',               hostPath: '' },
    'embeddings':      { group: 'image-gen', label: 'Embeddings',          hostPath: '' },
    'controlnet':      { group: 'image-gen', label: 'ControlNet',          hostPath: '' },
    'vae':             { group: 'image-gen', label: 'VAE Models',          hostPath: '' },
  },
  containerBindings: {},
};

/**
 * Return the default shared folders config (deep clone).
 */
export function getDefaultSharedFolders() {
  return JSON.parse(JSON.stringify(DEFAULT_SHARED_FOLDERS));
}

/**
 * Merge saved config with defaults to ensure new categories are present.
 * @param {Object} saved - Saved shared-folders.json content
 * @returns {Object} Merged config
 */
export function mergeWithDefaults(saved) {
  const defaults = getDefaultSharedFolders();
  if (!saved) return defaults;

  const merged = {
    ...defaults,
    ...saved,
    categories: { ...defaults.categories },
    groupBasePaths: { ...defaults.groupBasePaths },
    containerBindings: { ...(saved.containerBindings || {}) },
  };

  // Merge saved group base paths
  if (saved.groupBasePaths) {
    for (const [key, val] of Object.entries(saved.groupBasePaths)) {
      if (merged.groupBasePaths[key]) {
        merged.groupBasePaths[key] = { ...merged.groupBasePaths[key], ...val };
      } else {
        merged.groupBasePaths[key] = val;
      }
    }
  }

  // Merge saved category hostPaths into defaults
  if (saved.categories) {
    for (const [key, val] of Object.entries(saved.categories)) {
      if (merged.categories[key]) {
        merged.categories[key] = { ...merged.categories[key], ...val };
      } else {
        merged.categories[key] = val;
      }
    }
  }

  return merged;
}

/**
 * Resolve the full host path for a category, applying group base path if enabled.
 * Normalizes slashes: strips trailing slash from base, strips leading slash from relative.
 *
 * @param {Object} sfConfig - Full shared-folders.json content
 * @param {string} catKey - Category key (e.g., 'movies')
 * @returns {string} Resolved host path, or empty string if not configured
 */
export function resolveHostPath(sfConfig, catKey) {
  const cat = (sfConfig.categories || {})[catKey];
  if (!cat?.hostPath) return '';

  const rawPath = cat.hostPath.trim();
  if (!rawPath) return '';

  const group = cat.group;
  const groupBase = (sfConfig.groupBasePaths || {})[group];

  // If group base path is enabled and has a value, join base + relative
  if (groupBase?.enabled && groupBase.basePath?.trim()) {
    const base = groupBase.basePath.trim().replace(/\/+$/, '');  // strip trailing slashes
    const rel = rawPath.replace(/^\/+/, '');                      // strip leading slashes
    return `${base}/${rel}`;
  }

  // Otherwise, hostPath is treated as a full absolute path
  return rawPath;
}

/**
 * Get the list of enabled shared folders for a specific container (by vmid).
 * Returns folders that have a hostPath configured AND are bound to the container.
 *
 * @param {Object} sfConfig - Full shared-folders.json content
 * @param {string|number} vmid - Container VMID
 * @returns {Array<{ key: string, hostPath: string, containerPath: string }>}
 */
export function getEnabledFoldersForVmid(sfConfig, vmid) {
  const mountParent = sfConfig.containerMountParent || '/mnt/shared';
  const bindings = sfConfig.containerBindings?.[String(vmid)] || [];

  const folders = [];
  for (const catKey of bindings) {
    const resolved = resolveHostPath(sfConfig, catKey);
    if (!resolved) continue; // Not configured
    folders.push({
      key: catKey,
      hostPath: resolved,
      containerPath: `${mountParent}/${catKey}`,
    });
  }
  return folders;
}

/**
 * Get the list of enabled shared folders for a node.
 * Returns ALL categories that have a hostPath configured — bindings are per-container.
 * For hookscript vars generation, we want per-container (vmid) filtering.
 *
 * @param {Object} sfConfig - Full shared-folders.json content
 * @param {string} nodeName - PVE node name (unused but kept for future node-specific paths)
 * @returns {Array<{ key: string, hostPath: string, containerPath: string }>}
 */
export function getEnabledFoldersForNode(sfConfig, nodeName) {
  const mountParent = sfConfig.containerMountParent || '/mnt/shared';
  const categories = sfConfig.categories || {};

  const folders = [];
  for (const key of Object.keys(categories)) {
    const resolved = resolveHostPath(sfConfig, key);
    if (!resolved) continue;
    folders.push({
      key,
      hostPath: resolved,
      containerPath: `${mountParent}/${key}`,
    });
  }
  return folders;
}
