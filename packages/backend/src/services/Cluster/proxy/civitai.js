/**
 * civitai.js — CivitAI download routes.
 *
 * Receives model IDs from the browser extension (or the CivitAI tab),
 * fetches metadata from CivitAI API, downloads model files + images
 * to the correct imagegen folder with normalized filenames.
 *
 * @module routes/civitai
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, renameSync } from 'fs';
import { join, basename } from 'path';
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { loadScheduler, saveScheduler, isDownloadAllowed } from './download-scheduler.js';
const DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || (process.cwd() + '/data');

const CONFIG_PATH = join(DATA_DIR, 'civitai-config.json');
const QUEUE_PATH = join(DATA_DIR, 'civitai-queue.json');
const RENAMER_PATH = join(DATA_DIR, 'civitai-renamer.json');
const HISTORY_PATH = join(DATA_DIR, 'civitai-history.json');
const DOWNLOADS_PATH = join(DATA_DIR, 'civitai-downloads.json');

// #3 Pause/resume the already-RUNNING curl processes for a source (SIGSTOP/SIGCONT).
// The scheduler only gates NEW starts; without this, hitting Pause left active downloads running.
function signalActiveDownloads(source, sig) {
  const file = source === 'hf' ? join(DATA_DIR, 'hf-downloads.json') : DOWNLOADS_PATH;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    for (const d of (m.downloads || [])) {
      if (d.status === 'downloading' && d.pid) { try { process.kill(d.pid, sig); } catch {} }
    }
  } catch {}
}

// ─── Durable JSON state ───────────────────────────────────────────────────
//
// These files (history is ~2 MB) were previously written with a plain writeFileSync, which
// TRUNCATES the target and then streams the new contents into it. A restart or an overlapping
// write during that window leaves invalid JSON on disk. The readers then swallowed the parse
// error and returned an EMPTY object — so the UI showed "no history" — and the very next
// addToHistory() loaded that emptiness, appended one item and saved it back, permanently
// destroying the real history. AI-Lab widened this window considerably versus ProxLab, because
// its reconciler now writes the downloads manifest every 5s instead of only when the UI polled.

/** Serialise to <path>.tmp then rename into place. rename(2) is atomic within a filesystem, so a
 *  crash mid-write can never leave a partially-written file where the real one used to be. */
function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/** Read JSON without ever degrading corruption into a silent empty result: preserve the bad file
 *  as <path>.corrupt-<ts> and say so loudly, so it stays recoverable and the next write starts a
 *  fresh file rather than quietly overwriting data that was merely unreadable. */
function readJsonSafe(path, fallback, label) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    const kept = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, kept); } catch { /* best effort — still must not return silently */ }
    console.error(`[civitai] ${label} at ${path} is CORRUPT (${e.message}). ` +
      `Preserved as ${kept}; continuing with an empty ${label}.`);
    return fallback;
  }
}

// ─── Download tracking (active downloads + temp session history) ──────────
function loadDownloads() {
  return readJsonSafe(DOWNLOADS_PATH, { downloads: [] }, 'downloads manifest');
}

function saveDownloads(data) {
  writeJsonAtomic(DOWNLOADS_PATH, data);
}

// All folder types used in imagegen — matches CivitAI model types
const FOLDER_TYPES = [
  'checkpoints', 'diffusion-models', 'diffusers', 'loras', 'lycoris',
  'dora', 'vae', 'text-encoders', 'controlnet', 'embeddings', 'upscale-models',
  'ipadapter', 'animatediff-models', 'style-models', 'hypernetworks',
  'detection', 'poses', 'wildcards', 'workflows', 'other',
];

const DEFAULT_CONFIG = {
  // Global default template — used for any type without its own template
  pathTemplate: '$BASE_MODEL_SHORT/$REPO_NAME/$VERSION_NAME/$MODEL_FILE_NAME',
  separator: '-',
  caseMode: 'standard',
  // Per-type template overrides
  typeTemplates: {},
  // User-defined categories for $USER_DEFINED variable
  userDefinedCategories: [],
  // Custom base model name mapping ($BASE_MODEL_SHORT -> $BASE_MODEL_LONG)
  baseModelMap: {},
  // Auto-update checking (0 = disabled)
  autoUpdateDays: 0,
  lastAutoUpdate: null,
  // General
  concurrent: 3,
  // Model
  downloadModel: true,
  saveMetadata: true,
  metadataSuffix: 'civitai',    // filename.civitai.json
  // Images
  downloadImages: true,
  imageCount: 10,
  imageSize: 'original',        // 'preview', 'original', 'both'
  imageSource: 'model-card-first', // 'model-card', 'gallery', 'model-card-first', 'gallery-first'
  previewSuffix: 'preview',
  originalSuffix: 'original',
  // Folder routing — CivitAI type → imagegen subfolder
  folderMap: {
    'Checkpoint': 'checkpoints',
    'LORA': 'loras',
    'LoCon': 'lycoris',
    'DoRA': 'dora',
    'TextualInversion': 'embeddings',
    'Controlnet': 'controlnet',
    'VAE': 'vae',
    'Upscaler': 'upscale-models',
    'Poses': 'poses',
    'Wildcards': 'wildcards',
    'Workflows': 'workflows',
    'AestheticGradient': 'other',
    'Hypernetwork': 'hypernetworks',
    'MotionModule': 'animatediff-models',
    'Detection': 'detection',
    'Other': 'other',
  },
};

/**
 * All available template variables, grouped by category.
 * Each entry: { desc, example, category }
 */
const TEMPLATE_VARS = {
  // ── Model Info ──
  '$REPO_NAME':          { desc: 'Model/repo display name', example: 'Hairstyles Collection', cat: 'Model' },
  '$MODEL_ID':           { desc: 'CivitAI model ID number', example: '76937', cat: 'Model' },
  '$MODEL_TYPE':         { desc: 'Model type as shown on CivitAI', example: 'LORA', cat: 'Model' },
  '$CREATOR_NAME':       { desc: 'Model creator username', example: 'antonio_riolo2610', cat: 'Model' },
  '$PRIMARY_TAG':        { desc: 'First tag on the model (usually the category)', example: 'clothing', cat: 'Model' },

  // ── Version Info ──
  '$VERSION_NAME':       { desc: 'Version name', example: 'Short Dreads', cat: 'Version' },
  '$VERSION_ID':         { desc: 'CivitAI version ID', example: '103767', cat: 'Version' },
  '$UPLOAD_DATE':        { desc: 'Upload date (YYYY-MM-DD)', example: '2023-06-25', cat: 'Version' },
  '$UPLOAD_YEAR':        { desc: 'Upload year only', example: '2023', cat: 'Version' },

  // ── Base Model ──
  '$BASE_MODEL_SHORT':   { desc: 'Base model name from CivitAI', example: 'SD 1.5', cat: 'Base Model' },
  '$BASE_MODEL_LONG':    { desc: 'Custom mapped base model name (configure in Variable Config)', example: 'Stable-Diffusion-1.5', cat: 'Base Model' },
  '$BASE_MODEL_TYPE':    { desc: 'Base model type (Standard, Inpainting, etc.)', example: 'Standard', cat: 'Base Model' },

  // ── File ──
  '$MODEL_FILE_NAME':    { desc: 'Original filename without extension', example: 'short_dreads_hairstyle', cat: 'File' },
  '$FILE_SIZE':          { desc: 'File size (human readable)', example: '144 MB', cat: 'File' },
  '$FILE_HASH':          { desc: 'AutoV2 hash (short)', example: '9AD55BD84D', cat: 'File' },

  // ── Quality ──
  '$QUANT_FORMAT':       { desc: 'File format (SafeTensor, PickleTensor, etc.)', example: 'SafeTensor', cat: 'Quality' },
  '$QUANT_LEVEL':        { desc: 'Precision/size (fp16, fp32, pruned, full)', example: 'fp16', cat: 'Quality' },
  '$QUANT_SIZE':         { desc: 'Size variant (pruned, full)', example: 'pruned', cat: 'Quality' },
  '$QUANT_FULL':         { desc: 'Format + precision combined', example: 'fp16 SafeTensor', cat: 'Quality' },

  // ── Special ──
  '$EXTENSION':          { desc: 'File extension (auto-added, marks filename boundary)', example: '.safetensors', cat: 'Special' },
  '$USER_DEFINED':       { desc: 'User-selected category (omitted if blank)', example: 'anime', cat: 'Special' },
  '$EXTENSION_OVERRIDE': { desc: 'Filename override from browser extension (omitted if blank)', example: 'my-custom-name', cat: 'Special' },
};

/**
 * Build the long base model name from the user's custom mapping.
 * $BASE_MODEL_SHORT = raw CivitAI value (e.g. "SD 1.5", "Pony")
 * $BASE_MODEL_LONG = user-configured expanded name (e.g. "Stable-Diffusion-1.5")
 */
function longBaseModel(baseModel, cfg) {
  const customMap = cfg?.baseModelMap || {};
  return customMap[baseModel] || baseModel || 'Unknown';
}

/**
 * Resolve all template variables for a given model/version/file.
 */
function resolveVars(model, version, file, cfg) {
  const baseModel = version?.baseModel || '';
  const fileName = file?.name || 'unknown.safetensors';
  const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
  const fileBase = fileName.replace(/\.[^.]+$/, '');

  // Detect quant info from file metadata
  const fp = file?.metadata?.fp || '';
  const size = file?.metadata?.size || '';
  const format = file?.metadata?.format || ext;
  const quantLevel = fp ? fp.toUpperCase() : (size || 'Full');
  const quantFull = `${quantLevel} ${format.charAt(0).toUpperCase() + format.slice(1)}`.trim();

  // Upload date
  const uploadDate = version?.createdAt ? version.createdAt.split('T')[0] : '';

  // Type folder
  const typeFolder = cfg.folderMap[model?.type] || 'other';

  const fileSizeKB = file?.sizeKB || 0;
  const fileSize = fileSizeKB > 1024*1024 ? `${(fileSizeKB/1024/1024).toFixed(1)} GB`
    : fileSizeKB > 1024 ? `${(fileSizeKB/1024).toFixed(0)} MB`
    : `${Math.round(fileSizeKB)} KB`;
  const fileHash = file?.hashes?.AutoV2 || '';

  return {
    // Routing (auto-detected, not user-selectable but used internally)
    '$TYPE_FOLDER': typeFolder,
    // Model
    '$REPO_NAME': model?.name || 'unknown',
    '$MODEL_ID': String(model?.id || ''),
    '$MODEL_TYPE': model?.type || 'Unknown',
    '$CREATOR_NAME': model?.creator?.username || 'unknown',
    '$PRIMARY_TAG': (model?.tags?.[0]) || '',
    // Version
    '$VERSION_NAME': version?.name || '',
    '$VERSION_ID': String(version?.id || ''),
    '$UPLOAD_DATE': uploadDate,
    '$UPLOAD_YEAR': uploadDate ? uploadDate.split('-')[0] : '',
    // Base Model
    '$BASE_MODEL_SHORT': baseModel || 'Unknown',
    '$BASE_MODEL_LONG': longBaseModel(baseModel, cfg),
    '$BASE_MODEL_TYPE': version?.baseModelType || '',
    // File
    '$MODEL_FILE_NAME': fileBase,  // filename without extension
    '$FILE_SIZE': fileSize,
    '$FILE_HASH': fileHash,
    '$EXTENSION': `.${ext}`,
    // Quality
    '$QUANT_FORMAT': format,
    '$QUANT_LEVEL': quantLevel,
    '$QUANT_SIZE': file?.metadata?.size || '',
    '$QUANT_FULL': quantFull,
    // User-defined (set per-item during review, empty by default)
    '$USER_DEFINED': '',
    // Extension override (set from browser extension confirm dialog)
    '$EXTENSION_OVERRIDE': '',
  };
}

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      // Deep merge folderMap and typeTemplates so defaults aren't lost
      return {
        ...DEFAULT_CONFIG,
        ...saved,
        folderMap: { ...DEFAULT_CONFIG.folderMap, ...(saved.folderMap || {}) },
        typeTemplates: { ...DEFAULT_CONFIG.typeTemplates, ...(saved.typeTemplates || {}) },
      };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_PATH, cfg);
}

// ─── Component Type Detection ───────────────────────────────────────────────
// Detect if a version's files are actually a sub-component (VAE, text encoder, etc.)
// rather than the model type declared by the CivitAI repo.
function detectComponentType(versionName, fileName) {
  const vn = (versionName || '').toLowerCase();
  const fn = (fileName || '').toLowerCase();
  const combined = `${vn} ${fn}`;

  // VAE detection
  if (/\bvae\b/.test(combined) || /\bdecoder\b/.test(combined) || /\bencoder.*decoder\b/.test(combined)) {
    if (!/\btext.?encoder\b/.test(combined)) return 'vae';
  }

  // Text encoder detection
  if (/\btext.?encoder\b/.test(combined) || /\bclip\b/.test(combined) ||
      /\bt5.?xxl\b/.test(combined) || /\bt5\b/.test(fn) || /\bte\d?\b/.test(fn)) {
    return 'text-encoders';
  }

  // Diffusion model / UNet / Transformer detection
  if (/\bdiffusion.?model\b/.test(combined) || /\bunet\b/.test(combined) ||
      /\btransformer\b/.test(fn) || /\bflux.*dev\b/.test(fn) || /\bflux.*schnell\b/.test(fn)) {
    // Only if it's NOT also a checkpoint (large full pipeline)
    return 'diffusion-models';
  }

  return null; // no override — use the repo's declared type
}

/**
 * Contextual detection: given ALL versions in a repo, determine if any
 * undetected versions should be reclassified based on sibling versions.
 * E.g., if repo has VAE + text encoder versions, the remaining large file
 * is likely a diffusion model, not a checkpoint.
 */
function detectComponentsInContext(versions) {
  // First pass: detect components individually
  const results = {};
  for (const v of versions) {
    const fileName = v.files?.[0]?.name || '';
    results[String(v.id)] = detectComponentType(v.name, fileName);
  }

  // Second pass: contextual inference
  const detected = Object.values(results);
  const hasVae = detected.includes('vae');
  const hasTextEncoder = detected.includes('text-encoders');
  const hasDiffModel = detected.includes('diffusion-models');

  // If repo has VAE and/or text encoder but no diffusion model detected,
  // reclassify undetected large versions as diffusion-models
  if ((hasVae || hasTextEncoder) && !hasDiffModel) {
    for (const v of versions) {
      const vid = String(v.id);
      if (results[vid] !== null) continue; // already detected
      const fileSizeKB = v.files?.[0]?.sizeKB || 0;
      // Diffusion models are typically > 1GB, checkpoints too
      // But if siblings are VAE/TE, this is a pipeline component
      if (fileSizeKB > 500 * 1024) { // > 500MB
        results[vid] = 'diffusion-models';
      }
    }
  }

  return results;
}

// ─── Shared Helpers ─────────────────────────────────────────────────────────

function getBasePath() {
  try {
    const fmCfg = JSON.parse(readFileSync(join(DATA_DIR, 'file-manager.json'), 'utf8'));
    return fmCfg.tabs?.['image-gen']?.basePath || '/ai-assets/imagegen';
  } catch {}
  return '/ai-assets/imagegen';
}

// ─── Download History ────────────────────────────────────────────────────────
// Each entry: { modelId, modelName, modelType, versionId, versionName, baseModel,
//               creator, downloadedAt, source ('proxlab'|'synced'), pageUrl }

function loadHistory() {
  return readJsonSafe(HISTORY_PATH, { items: [], lastSync: null }, 'download history');
}

function saveHistory(h) {
  writeJsonAtomic(HISTORY_PATH, h);
}

function addToHistory(model, version, source = 'proxlab', extra = {}) {
  const h = loadHistory();
  // Check for existing entry with same modelId + versionId
  const existingIdx = h.items.findIndex(i =>
    String(i.modelId) === String(model.id) && String(i.versionId) === String(version?.id)
  );

  // Build files array from version data (actual CivitAI metadata — source of truth for repo contents)
  const filesArray = version?.files?.map(f => ({
    // 🛑 id is the ONLY reliable identity. One version routinely ships several files
    // with the SAME name (fp8 / bf16 / GGUF quants): Lustify v10-Krea2 has FIVE
    // lustifyNSFWCheckpoint_v10Krea2.safetensors, two differing by 0.1 MB. Anything
    // keyed on name collapses them — the picker shows one row, selection toggles all,
    // and every download resolves to one path.
    id: f.id != null ? String(f.id) : '',
    name: f.name,
    sizeKB: f.sizeKB || 0,
    type: f.type || 'Model',
    fp: f.metadata?.fp || '',
    format: f.metadata?.format || '',
    downloadUrl: f.downloadUrl || '',
    hashes: f.hashes || {},
  })) || null;

  // Build locatedFiles — what's ACTUALLY on disk (may differ from files if renamed)
  let locatedFiles = null;
  if (extra.targetDir && filesArray) {
    const basePath = getBasePath();
    const override = extra.fileNameOverride;
    locatedFiles = filesArray.map(f => {
      let onDiskName = f.name;
      if (override) {
        const _dot = f.name.lastIndexOf('.');
        const ext = _dot > 0 ? f.name.substring(_dot) : '';
        onDiskName = override + ext;
      }
      return {
        name: onDiskName,
        currentPath: `${extra.targetDir}/${onDiskName}`,
        indexPath: `${extra.targetDir}/${onDiskName}`.replace(basePath, ''),
      };
    });
  }

  if (existingIdx >= 0) {
    // Move existing entry to top, update fields
    const existing = h.items.splice(existingIdx, 1)[0];
    if (extra.pathOverride) existing.pathOverride = extra.pathOverride;
    if (extra.targetDir) existing.targetDir = extra.targetDir;
    if (extra.fileNameOverride) existing.fileNameOverride = extra.fileNameOverride;
    if (filesArray) existing.files = filesArray;
    if (locatedFiles) existing.locatedFiles = locatedFiles;
    if (extra.targetDir) existing.currentDir = extra.targetDir;
    existing.downloadedAt = new Date().toISOString();
    existing.source = source;
    existing.modelName = model.name || existing.modelName;
    existing.versionName = version?.name || existing.versionName;
    existing.baseModel = version?.baseModel || existing.baseModel;
    // Track which versions have been downloaded
    if (!existing.downloadedVersions) existing.downloadedVersions = [];
    if (version?.id && !existing.downloadedVersions.includes(String(version.id))) {
      existing.downloadedVersions.push(String(version.id));
    }
    h.items.unshift(existing);
    saveHistory(h);
    return;
  }

  h.items.unshift({
    modelId: String(model.id),
    modelName: model.name || '',
    modelType: model.type || '',
    versionId: String(version?.id || ''),
    versionName: version?.name || '',
    baseModel: version?.baseModel || '',
    creator: model.creator?.username || '',
    primaryTag: model.tags?.[0] || '',
    downloadedAt: new Date().toISOString(),
    source,
    pageUrl: `https://civitai.red/models/${model.id}`,
    pathOverride: extra.pathOverride || null,
    targetDir: extra.targetDir || null,
    fileNameOverride: extra.fileNameOverride || null,
    files: filesArray,
    locatedFiles,
    currentDir: extra.targetDir || null,
    downloadedVersions: version?.id ? [String(version.id)] : [],
  });
  saveHistory(h);
}

/**
 * Look up any previous download of this model in history.
 * Returns { pathOverride, targetDir } if found, or null.
 * Matches by modelId (any version of the same model).
 */
function lookupHistoryOverride(modelId, versionId) {
  const h = loadHistory();
  // First try version-specific match, then any version of this model
  if (versionId) {
    const vMatch = h.items.find(i =>
      String(i.modelId) === String(modelId) && String(i.versionId) === String(versionId) &&
      (i.pathOverride || i.targetDir || i.fileNameOverride)
    );
    if (vMatch) return { pathOverride: vMatch.pathOverride, targetDir: vMatch.targetDir, fileNameOverride: vMatch.fileNameOverride, versionId: vMatch.versionId };
  }
  const match = h.items.find(i =>
    String(i.modelId) === String(modelId) && (i.pathOverride || i.targetDir || i.fileNameOverride)
  );
  return match ? { pathOverride: match.pathOverride, targetDir: match.targetDir, fileNameOverride: match.fileNameOverride, versionId: match.versionId } : null;
}

/**
 * Check for existing files at a target directory that would conflict with a download.
 * Returns array of { name, size } for files that already exist.
 */
function checkExistingFiles(targetDir, fileNames) {
  const conflicts = [];
  if (!existsSync(targetDir)) return conflicts;
  try {
    const existing = new Set(readdirSync(targetDir));
    for (const name of fileNames) {
      if (existing.has(name)) {
        try {
          const st = statSync(join(targetDir, name));
          conflicts.push({ name, size: st.size });
        } catch {
          conflicts.push({ name, size: 0 });
        }
      }
    }
  } catch {}
  return conflicts;
}

/**
 * Apply a path template using $VARIABLE syntax.
 * Replaces variables, applies separator for spaces, sanitizes.
 *
 * @param {string} template - Path template with $VAR placeholders
 * @param {Object} vars - Variable map from resolveVars()
 * @param {string} separator - Character to replace spaces (-, _, or .)
 * @returns {string} Resolved path
 */
function applyCaseMode(str, caseMode) {
  if (caseMode === 'lowercase') return str.toLowerCase();
  if (caseMode === 'uppercase') return str.toUpperCase();
  // Standard case: capitalize first letter of each word
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function applyTemplate(template, vars, separator = '-', caseMode = 'standard') {
  let result = template;

  // Handle $USER_DEFINED specially — if blank, remove it and any adjacent /
  const userDefined = vars['$USER_DEFINED'] || '';
  if (!userDefined) {
    result = result.replace(/\/?\$USER_DEFINED\/?/g, '/').replace(/\/+/g, '/');
  }

  // Handle $EXTENSION_OVERRIDE — if blank, remove it and any adjacent separators
  const extOverride = vars['$EXTENSION_OVERRIDE'] || '';
  if (!extOverride) {
    result = result.replace(/\/?\$EXTENSION_OVERRIDE\/?/g, '/').replace(/\/+/g, '/');
    // Also remove any literal separators adjacent to where the variable was
    result = result.replace(/[-_.](?=[-_.])/g, '');
  }

  // Replace all $VARIABLE references (longest match first to avoid partial matches)
  const sortedKeys = Object.keys(vars).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    let val = vars[key] || '';
    // Apply case transformation (skip $EXTENSION, $TYPE_FOLDER, $USER_DEFINED when empty)
    if (key !== '$EXTENSION' && key !== '$TYPE_FOLDER') {
      val = applyCaseMode(val, caseMode);
    }
    // Replace spaces and forward slashes with the chosen separator.
    // Template uses literal / for path segments; a / inside a variable
    // value (e.g. $REPO_NAME = "owner/model") would create phantom subdirs.
    const sanitized = val.replace(/\s+/g, separator).replace(/\//g, separator);
    result = result.replaceAll(key, sanitized);
  }

  // Clean up: remove filesystem-unsafe chars, collapse repeated separators, trim
  result = result.replace(/[:"|?*]/g, '');
  if (separator !== ' ') {
    const escapedSep = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`${escapedSep}{2,}`, 'g'), separator);
  }
  result = result.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');

  return result;
}

/**
 * Resolve the CivitAI API token. Module scope so BOTH the route handlers and spawnCurl can use it.
 *
 * AI-Lab's Settings UI writes to cluster-settings.json -> tokens.civitaiToken. The code ported from
 * ProxLab read settings.json -> ui.civitaiToken, which AI-Lab never populates, so this silently
 * returned '' and every download went out unauthenticated (CivitAI answers 401 with a 106-byte JSON
 * body). Read the real location first; keep the legacy path for ProxLab-era configs.
 */
let _tokenWarned = false;
function readCivitaiToken() {
  try {
    const cs = JSON.parse(readFileSync(join(DATA_DIR, 'cluster-settings.json'), 'utf8'));
    const t = cs.tokens?.civitaiToken || '';
    if (t) return t;
  } catch {}
  try {
    const settings = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8'));
    const t = settings.ui?.civitaiToken || '';
    if (t) return t;
  } catch {}
  // Never fail silently: no token degrades into a retry loop whose error says nothing useful.
  if (!_tokenWarned) {
    _tokenWarned = true;
    console.warn('[civitai] No API token found (cluster-settings.json -> tokens.civitaiToken, nor ' +
      'legacy settings.json -> ui.civitaiToken). Downloads requiring auth WILL fail with 401.');
  }
  return '';
}

/** Append the API token to a civitai download URL that lacks one. */
function withCivitaiToken(url) {
  if (!url || !/civitai\.com\/api\/download\//.test(url) || url.includes('token=')) return url;
  const t = readCivitaiToken();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + `token=${t}`;
}

/**
 * Download a file via curl to a target path. Returns the spawned PID.
 */
function spawnCurl(url, targetPath, token) {
  // Entries queued before the token fix have a token-less dlUrl persisted in the manifest, and the
  // retry paths call this with token=null. Re-attach it here so retries of existing queue items
  // authenticate too, instead of looping until "5 retries exhausted".
  url = withCivitaiToken(url);
  const dir = targetPath.substring(0, targetPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });

  // Download to a .part temp file. On success (exit 0), rename to final path.
  // This prevents partial files from being mistaken for complete downloads,
  // and avoids curl -C - resume issues with CDNs that drop Range headers
  // through redirect chains (e.g. CivitAI → B2/Cloudflare).
  const partPath = targetPath + '.part';
  // --fail is load-bearing: without it curl treats an HTTP 401/404 as success, writes the error
  // body to the .part file and exits 0, so the `&& mv` below renames a few KB of HTML into place
  // as if it were the model. The size check then rejects it and the reconciler requeues, which is
  // how an auth failure surfaced as "download keeps dying immediately" instead of "unauthorised".
  // --retry still covers transient 5xx/429; --fail makes 4xx abort loudly, which is what we want.
  const args = ['-L', '--fail', '-o', partPath, '--retry', '3', '--retry-delay', '5'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push(url);

  const curlCmd = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  // Chain: curl downloads to .part, and on success mv to final path
  const cmd = `umask 000 && curl ${curlCmd} && mv '${partPath.replace(/'/g, "'\\''")}' '${targetPath.replace(/'/g, "'\\''")}'`;

  // Use systemd-run --scope to launch curl in its own cgroup, so it survives
  // proxlab-ui service restarts. The scope unit is transient and auto-cleans.
  const logPath = `/tmp/civdl-${Date.now()}.log`;
  const scopeName = `civdl-${Date.now()}`;
  const fullCmd = `systemd-run --scope --unit=${scopeName} bash -c '${cmd.replace(/'/g, "'\\''")}' > '${logPath}' 2>&1`;

  const child = spawn('bash', ['-c', fullCmd], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // child.pid IS the right PID to track. `systemd-run --scope` runs the command in the
  // foreground of the calling process, so this bash stays alive for exactly as long as curl
  // does — which is precisely what the reconciler's `process.kill(pid, 0)` liveness check needs.
  //
  // This previously tried to look up the scope's MainPID inside a `try { ... } catch {}`, but the
  // first statement was `const { execSync } = require('child_process')` — and this module is ESM,
  // where `require` is not defined. So it threw ReferenceError on EVERY call, the empty catch
  // swallowed it, and none of that lookup ever ran. Removed rather than repaired: the fallback
  // branch used `pgrep -f <partPath>`, which also matches this very bash wrapper (its command line
  // contains that same path), so "fixing" it would have started storing an unrelated PID.
  const realPid = child.pid;

  console.log(`[civitai-dl] SPAWN: PID ${realPid} (scope ${scopeName}) → ${targetPath.split('/').pop()} (log: ${logPath})`);
  return realPid;
}

function countActiveDownloads() {
  const manifest = loadDownloads();
  return manifest.downloads.filter(d => d.status === 'downloading' && d.pid).length;
}

function downloadFile(url, targetPath, token, cfg) {
  if (!isDownloadAllowed('civ')) return null;
  const maxConcurrent = cfg?.concurrent || 3;
  if (countActiveDownloads() >= maxConcurrent) {
    return null;
  }
  return spawnCurl(url, targetPath, token);
}

function processPendingDownloads() {
  if (!isDownloadAllowed('civ')) return 0;
  const manifest = loadDownloads();
  const cfg = loadConfig();
  const maxConcurrent = cfg.concurrent || 3;
  const active = manifest.downloads.filter(d => d.status === 'downloading' && d.pid).length;
  let slots = maxConcurrent - active;
  let started = 0;

  for (const dl of manifest.downloads) {
    if (slots <= 0) break;
    if (dl.status !== 'pending') continue;
    // #4 Skip files that already exist AND match the expected size (parity with HF fix #1).
    if (dl.targetFile && existsSync(dl.targetFile) && dl.size > 0 && statSync(dl.targetFile).size === dl.size) {
      dl.status = 'complete'; dl.skipped = true; dl.completedAt = new Date().toISOString();
      console.log(`[civitai] Skip (already complete, ${dl.size}B): ${dl.targetFile}`);
      continue;
    }
    const pid = spawnCurl(dl.dlUrl, dl.targetFile, null);
    if (pid) {
      dl.pid = pid;
      dl.status = 'downloading';
      dl.startedAt = new Date().toISOString();
      slots--;
      started++;
    }
  }
  if (started) saveDownloads(manifest);
  return started;
}

/**
 * Download a file synchronously (for small files like metadata/images).
 */
async function downloadFileSync(url, targetPath, token) {
  const dir = targetPath.substring(0, targetPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });

  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(url, { headers, redirect: 'follow' });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(targetPath, buffer);
}

/**
 * Fix permissions via SSH to the ZFS host.
 */
function fixPermissions(targetDir, _sshService) {
  // AI-Lab runs inside CT 152 with /ai-assets rbind-mounted locally — chmod directly, no SSH.
  try {
    if (targetDir && targetDir.startsWith('/ai-assets/')) {
      execSync(`chmod -R 777 "${targetDir}" 2>/dev/null`, { timeout: 10000 });
    }
  } catch {}
}

export function createCivitaiRouter(config, sshService) {
  const router = Router();

  // Allow CORS from browser extension (content script runs on civitai.com origin)
  router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // ─── GET /variables — List all available template variables ────────────
  router.get('/variables', (req, res) => {
    res.json(TEMPLATE_VARS);
  });

  // ─── GET /base-models — List all known base model values from history ─
  router.get('/base-models', (req, res) => {
    const h = loadHistory();
    const cfg = loadConfig();
    const baseModels = new Set();
    for (const item of h.items) {
      if (item.baseModel) baseModels.add(item.baseModel);
    }
    const sorted = [...baseModels].sort();
    const result = sorted.map(bm => ({
      short: bm,
      long: cfg.baseModelMap?.[bm] || '',
    }));
    res.json(result);
  });

  // ─── GET /folder-types — List all imagegen folder types ──────────────
  router.get('/folder-types', (req, res) => {
    res.json(FOLDER_TYPES);
  });

  // ─── GET /config ──────────────────────────────────────────────────────
  router.get('/config', (req, res) => {
    res.json(loadConfig());
  });

  router.put('/config', (req, res) => {
    const existing = loadConfig();
    const cfg = { ...existing, ...req.body };
    // Deep merge nested objects so partial updates don't wipe siblings
    if (req.body.typeTemplates) {
      cfg.typeTemplates = { ...existing.typeTemplates, ...req.body.typeTemplates };
    }
    if (req.body.folderMap) {
      cfg.folderMap = { ...existing.folderMap, ...req.body.folderMap };
    }
    if (req.body.baseModelMap) {
      cfg.baseModelMap = { ...existing.baseModelMap, ...req.body.baseModelMap };
    }
    saveConfig(cfg);
    res.json({ ok: true });
  });

  // ─── Helper: get basePath from file-manager config ──────────────────
  // getBasePath is defined at module scope (see below router)

  // ─── Helper: get CivitAI API token ────────────────────────────────────
  // Single implementation lives at module scope (readCivitaiToken) so spawnCurl can use it too.
  const getCivitaiToken = readCivitaiToken;

  // ─── Helper: resolve target path for a model file ──────────────────────
  /** Final on-disk names for ALL files of one version, computed in ONE place so the live
 *  preview and the actual download cannot drift apart.
 *
 *  Order matters, and it is: EXPLICIT USER INTENT FIRST, automatic guard LAST.
 *    1. per-file "keep original name" — wins outright, nothing else is applied
 *    2. otherwise the template result, then the custom filename override
 *    3. + the per-file suffix, inserted before the extension
 *    4. + automatic disambiguation, but ONLY for names that STILL collide
 *
 *  Step 4 running last is the fix for a real bug: the guard used to run before the
 *  filename override, so setting a custom name overwrote the disambiguated base and every
 *  file in the version collapsed onto one path again — exactly the case it existed to
 *  prevent. It also means a user's own suffixes suppress the ugly `-<fileId>` entirely:
 *  name them r64/r128 yourself and no machine tag is added.
 *
 *  @param baseNameFor  (file) => templated name, supplied by the caller so this stays
 *                      independent of how the path template is resolved.
 */
function resolveVersionFileNames(files, baseNameFor, fnOverride, fileOpts) {
  const keyOf = (f) => String(f.id != null ? f.id : f.name);
  const names = new Map();

  for (const f of files || []) {
    const o = (fileOpts && (fileOpts[keyOf(f)] || fileOpts[String(f.name)])) || {};
    let name;
    if (o.noRename) {
      name = f.name;                                  // upstream name, verbatim
    } else {
      name = baseNameFor(f);
      if (fnOverride) {
        const d = name.lastIndexOf('.');
        name = fnOverride + (d > 0 ? name.substring(d) : '');
      }
    }
    if (o.suffix) {
      const d = name.lastIndexOf('.');
      const b = d > 0 ? name.substring(0, d) : name;
      const e = d > 0 ? name.substring(d) : '';
      const sfx = String(o.suffix).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
      if (sfx) name = `${b}-${sfx}${e}`;
    }
    names.set(keyOf(f), name);
  }

  const counts = {};
  for (const n of names.values()) counts[n] = (counts[n] || 0) + 1;
  for (const f of files || []) {
    const k = keyOf(f);
    const n = names.get(k);
    if (counts[n] > 1) {
      const d = n.lastIndexOf('.');
      const b = d > 0 ? n.substring(0, d) : n;
      const e = d > 0 ? n.substring(d) : '';
      const tag = [f.metadata?.fp, f.metadata?.size, f.metadata?.format]
        .filter(Boolean).join('-').replace(/[^A-Za-z0-9._-]/g, '');
      names.set(k, `${b}${tag ? '-' + tag : ''}-${f.id}${e}`);
    }
  }
  return names;
}

function resolveTargetPath(model, version, file, cfg, pathOverride, userDefined, extensionOverride, componentOverride) {
    const vars = resolveVars(model, version, file, cfg);
    if (userDefined) vars['$USER_DEFINED'] = userDefined;
    if (extensionOverride) vars['$EXTENSION_OVERRIDE'] = extensionOverride;
    // Use contextual component override if provided, else per-file detection
    const detectedComponent = componentOverride || detectComponentType(version?.name, file?.name);
    const typeFolder = detectedComponent || vars['$TYPE_FOLDER'] || 'other';
    vars['$TYPE_FOLDER'] = typeFolder; // update so template uses the correct folder
    const typeCfg = cfg.typeTemplates?.[typeFolder] || {};
    const hasCustomTpl = typeCfg.pathTemplate !== undefined && typeCfg.pathTemplate !== null;
    const tpl = hasCustomTpl ? typeCfg.pathTemplate : (cfg.pathTemplate || '');
    const sep = typeCfg.separator || cfg.separator || '-';
    const caseMode = typeCfg.caseMode || cfg.caseMode || 'standard';
    const resolvedPath = applyTemplate(tpl, vars, sep, caseMode);

    const lastSlash = resolvedPath.lastIndexOf('/');
    let folderPart = lastSlash >= 0 ? resolvedPath.substring(0, lastSlash) : '';
    const filePart = lastSlash >= 0 ? resolvedPath.substring(lastSlash + 1) : resolvedPath;

    if (pathOverride) {
      let overrideFolderPart = pathOverride.replace(/\/+$/, '');
      overrideFolderPart = overrideFolderPart.replace(/^\/[^/]+\/[^/]+\//, '');
      if (overrideFolderPart.startsWith(typeFolder + '/')) {
        overrideFolderPart = overrideFolderPart.substring(typeFolder.length + 1);
      }
      folderPart = overrideFolderPart;
    }

    const origExt = file.name?.split('.').pop() || 'safetensors';
    let fileName = filePart;
    // Clean up any leftover $EXTENSION tokens (applyTemplate should have handled it)
    fileName = fileName.replace(/\$EXTENSION/g, `.${origExt}`);
    // If the template had $EXTENSION, applyTemplate already inserted the real extension.
    // Only auto-append for legacy templates that don't have $EXTENSION at all.
    if (!tpl.includes('$EXTENSION')) {
      fileName = `${fileName}.${origExt}`;
    }

    const basePath = getBasePath();
    const targetDir = `${basePath}/${typeFolder}/${folderPart}`;
    return { targetDir, fileName, typeFolder, folderPart };
  }

  // ─── POST /check-conflicts — Check for existing files before download ──
  router.post('/check-conflicts', async (req, res) => {
    const { modelId, versionId } = req.body;
    if (!modelId) return res.status(400).json({ error: 'modelId required' });

    const cfg = loadConfig();
    const civitaiToken = getCivitaiToken();

    try {
      const headers = {};
      if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;
      const modelResp = await fetch(`https://civitai.com/api/v1/models/${modelId}`, { headers });
      if (!modelResp.ok) throw new Error(`CivitAI API: ${modelResp.status}`);
      const model = await modelResp.json();

      let version;
      if (versionId) {
        version = model.modelVersions?.find(v => String(v.id) === String(versionId));
      }
      if (!version) version = model.modelVersions?.[0];
      if (!version) throw new Error('No model versions found');

      // Check history for previous path overrides
      const historyOverride = lookupHistoryOverride(modelId);
      const effectiveOverride = historyOverride?.pathOverride || null;

      // Resolve paths and collect file names
      const fileNames = [];
      let targetDir = null;
      for (const file of (version.files || [])) {
        if (file.type === 'Training Data') continue;
        const resolved = resolveTargetPath(model, version, file, cfg, effectiveOverride, '');
        if (!targetDir) targetDir = resolved.targetDir;
        fileNames.push(resolved.fileName);
      }

      if (!targetDir) return res.json({ conflicts: [], historyOverride: effectiveOverride });

      const conflicts = checkExistingFiles(targetDir, fileNames);
      res.json({
        conflicts,
        targetDir,
        historyOverride: effectiveOverride,
        modelName: model.name,
        versionName: version.name,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /history-override/:modelId — Quick lookup for history overrides ─
  router.get('/history-override/:modelId', (req, res) => {
    const override = lookupHistoryOverride(req.params.modelId, req.query.versionId);
    res.json(override || { pathOverride: null, targetDir: null, fileNameOverride: null, versionId: null });
  });

  // ─── POST /resolve-paths — Resolve template paths for model files ───────
  // Used by the renamer to compute new paths from templates
  router.post('/resolve-paths', (req, res) => {
    const { modelId, versionId, modelType, modelName, versionName, baseModel, creatorName, primaryTag, tags, files, pathOverride, userDefined, fileNameOverride, fileOpts } = req.body;
    if (!files?.length) return res.status(400).json({ error: 'files required' });

    const cfg = loadConfig();
    const basePath = getBasePath();

    const model = { id: modelId, name: modelName || '', type: modelType || 'LORA', creator: { username: creatorName || '' }, tags: tags || (primaryTag ? [primaryTag] : []) };
    const version = { id: versionId, name: versionName || '', baseModel: baseModel || '' };

    // Version-specific history override only — never cross-pollute baseModel
    // paths between versions. Request field presence is authoritative:
    //   - absent      → look up history
    //   - present ''  → explicit reset, use template
    //   - present set → use as-is
    let effectiveOverride;
    if (Object.prototype.hasOwnProperty.call(req.body, 'pathOverride')) {
      effectiveOverride = pathOverride || null;
    } else if (versionId) {
      const histOverride = lookupHistoryOverride(modelId, versionId);
      effectiveOverride = (histOverride?.pathOverride && String(histOverride.versionId) === String(versionId))
        ? histOverride.pathOverride
        : null;
    } else {
      effectiveOverride = null;
    }

    // The custom filename gets the SAME treatment as the folder. It did not before:
    // fileNameOverride was read ONLY from the request, never from history — so a model
    // downloaded earlier under a custom name came back resolved from the bare template,
    // the Filename box seeded with the template result, and re-downloading produced a
    // SECOND copy under a different name. (The UI sends `undefined` before seeding, and
    // JSON.stringify drops undefined keys, so `absent` reaches us as intended.)
    let effectiveFnOverride;
    if (Object.prototype.hasOwnProperty.call(req.body, 'fileNameOverride')) {
      effectiveFnOverride = fileNameOverride || null;
    } else if (versionId) {
      const hFn = lookupHistoryOverride(modelId, versionId);
      effectiveFnOverride = (hFn?.fileNameOverride && String(hFn.versionId) === String(versionId))
        ? hFn.fileNameOverride
        : null;
    } else {
      effectiveFnOverride = null;
    }

    const resolved = [];
    // Captured from the LAST resolve pass so the client can seed its editable Folder/Filename
    // boxes with the values the template actually produced. Without these the UI can only show
    // the absolute targetDir, which is not what `pathOverride` expects (it wants just the folder
    // part beneath <basePath>/<typeFolder>), so the boxes had to be left blank.
    let lastTypeFolder = '';
    let lastFolderPart = '';
    // One naming pass for the whole version, shared with the download path.
    const _dirs = new Map();
    const _finalNames = resolveVersionFileNames(files, (f) => {
      const fake = { id: f.id, name: f.name, sizeKB: f.sizeKB || 0, metadata: f.metadata || {}, hashes: {} };
      const r = resolveTargetPath(model, version, fake, cfg, effectiveOverride, userDefined || '');
      lastTypeFolder = r.typeFolder || lastTypeFolder;
      lastFolderPart = r.folderPart || '';
      _dirs.set(String(f.id != null ? f.id : f.name), r.targetDir);
      return r.fileName;
    }, effectiveFnOverride, fileOpts);

    for (const file of files) {
      const k = String(file.id != null ? file.id : file.name);
      resolved.push({
        fileId: file.id != null ? String(file.id) : '',
        originalName: file.name,
        newName: _finalNames.get(k),
        targetDir: _dirs.get(k),
      });
    }

    const targetDir = resolved[0]?.targetDir || `${basePath}/other`;
    res.json({
      targetDir,
      files: resolved,
      override: effectiveOverride,
      // Seed values for the UI's editable Folder box. `pathOverride` replaces exactly folderPart
      // (final dir = basePath/typeFolder/folderPart), so folderPart — not targetDir — is what the
      // box should be pre-filled with and what it should send back.
      basePath,
      typeFolder: lastTypeFolder,
      folderPart: lastFolderPart,
      // The name actually in force, so the Filename box can be seeded with the custom
      // name this model was downloaded under rather than the template's guess.
      fileNameOverride: effectiveFnOverride || '',
    });
  });

  // ─── POST /check-files — Simple file existence check at a given path ────
  router.post('/check-files', (req, res) => {
    const { dir, files } = req.body;
    if (!dir || !files?.length) return res.status(400).json({ error: 'dir and files required' });

    const results = {};
    for (const name of files) {
      const fullPath = `${dir}/${name}`;
      try {
        if (existsSync(fullPath)) {
          const st = statSync(fullPath);
          results[name] = { exists: true, size: st.size };
        } else {
          results[name] = { exists: false };
        }
      } catch {
        results[name] = { exists: false };
      }
    }
    res.json({ results });
  });

  // ─── POST /check-existing — Check which versions have files on disk ────
  // Returns per-version existence info + per-repo download index
  router.post('/check-existing', (req, res) => {
    const { modelId, versions, modelType, modelName } = req.body;
    if (!modelId || !versions?.length) return res.status(400).json({ error: 'modelId and versions required' });

    const cfg = loadConfig();
    const h = loadHistory();
    const historyEntries = h.items.filter(i => String(i.modelId) === String(modelId));
    const downloadedVersionIds = new Set();
    for (const entry of historyEntries) {
      if (entry.versionId) downloadedVersionIds.add(String(entry.versionId));
      if (entry.downloadedVersions) {
        for (const vid of entry.downloadedVersions) downloadedVersionIds.add(String(vid));
      }
    }

    const result = {};
    for (const v of versions) {
      const vid = String(v.id);
      const inHistory = downloadedVersionIds.has(vid);
      const existingFiles = [];
      const missingFiles = [];

      // Check history for version-specific overrides
      const vHistOverride = lookupHistoryOverride(modelId, vid);
      const effectiveOverride = vHistOverride?.pathOverride || null;
      const fnOverride = vHistOverride?.fileNameOverride || null;

      if (v.files?.length) {
        const model = { id: modelId, type: modelType || 'LORA', name: modelName || '', creator: {} };
        const version = { id: v.id, name: v.name || '', baseModel: v.baseModel || '' };
        // Must mirror the DOWNLOADER's collision handling exactly. If this computes the
        // bare name while the downloader writes a disambiguated one, the file is on disk
        // and this reports it missing — the badge stays dark and the model gets fetched
        // again. Two functions deriving a path independently WILL drift; they agree here
        // because they apply the same rule to the same input.
        const _nameCounts = {};
        for (const f of v.files) _nameCounts[f.name] = (_nameCounts[f.name] || 0) + 1;

        for (const file of v.files) {
          try {
            let { targetDir, fileName } = resolveTargetPath(model, version, file, cfg, effectiveOverride, '', null);
            // Apply filename override if saved in history
            if (fnOverride) {
              const _dot = fileName.lastIndexOf('.');
        const ext = _dot > 0 ? fileName.substring(_dot) : '';
              fileName = fnOverride + ext;
            }
            if (_nameCounts[file.name] > 1) {
              const _d = fileName.lastIndexOf('.');
              const _b = _d > 0 ? fileName.substring(0, _d) : fileName;
              const _e = _d > 0 ? fileName.substring(_d) : '';
              const _t = [file.metadata?.fp, file.metadata?.size, file.metadata?.format]
                .filter(Boolean).join('-').replace(/[^A-Za-z0-9._-]/g, '');
              fileName = `${_b}${_t ? '-' + _t : ''}-${file.id}${_e}`;
            }
            const fullPath = `${targetDir}/${fileName}`;

            if (existsSync(fullPath)) {
              const st = statSync(fullPath);
              existingFiles.push({ name: fileName, path: fullPath, size: st.size });
            } else {
              // Also check if the original CivitAI filename exists in the same dir
              const origPath = `${targetDir}/${file.name}`;
              if (existsSync(origPath)) {
                const st = statSync(origPath);
                existingFiles.push({ name: file.name, path: origPath, size: st.size });
              } else {
                // Check history entries matching this exact version ID
                let foundViaHistory = false;
                const vHistEntry = historyEntries.find(e => String(e.versionId) === vid);
                if (vHistEntry?.locatedFiles?.length) {
                  for (const lf of vHistEntry.locatedFiles) {
                    if (existsSync(lf.currentPath)) {
                      const st = statSync(lf.currentPath);
                      existingFiles.push({ name: lf.name, path: lf.currentPath, size: st.size });
                      foundViaHistory = true;
                      break;
                    }
                  }
                }
                // Also check downloadedVersions arrays
                if (!foundViaHistory) {
                  for (const he of historyEntries) {
                    if (he.downloadedVersions?.includes(vid) && he.locatedFiles?.length) {
                      for (const lf of he.locatedFiles) {
                        if (existsSync(lf.currentPath)) {
                          const st = statSync(lf.currentPath);
                          existingFiles.push({ name: lf.name, path: lf.currentPath, size: st.size });
                          foundViaHistory = true;
                          break;
                        }
                      }
                    }
                    if (foundViaHistory) break;
                  }
                }
                if (!foundViaHistory) {
                  missingFiles.push({ name: fileName, path: fullPath });
                }
              }
            }
          } catch {}
        }
      }

      result[vid] = {
        inHistory,
        existingFiles,
        missingFiles,
        allExist: existingFiles.length > 0 && missingFiles.length === 0,
        someExist: existingFiles.length > 0 && missingFiles.length > 0,
        noneExist: existingFiles.length === 0,
        dir: existingFiles[0]?.path?.substring(0, existingFiles[0]?.path?.lastIndexOf('/')) || null,
      };
    }

    // Build repo download index
    const repoIndex = {
      modelId: String(modelId),
      totalVersions: versions.length,
      downloadedVersions: Object.entries(result).filter(([, v]) => v.inHistory).map(([vid]) => vid),
      existingVersions: Object.entries(result).filter(([, v]) => v.allExist).map(([vid]) => vid),
      partialVersions: Object.entries(result).filter(([, v]) => v.someExist).map(([vid]) => vid),
      missingVersions: Object.entries(result).filter(([, v]) => v.noneExist && v.inHistory).map(([vid]) => vid),
      override: lookupHistoryOverride(modelId)?.pathOverride || null,
    };

    res.json({ versions: result, repoIndex });
  });

  // ─── POST /download ───────────────────────────────────────────────────
  // Called by the browser extension or the CivitAI tab in ProxLab.
  // conflictMode: 'overwrite' | 'skip' | undefined (default: check and redirect to queue)
  router.post('/download', async (req, res) => {
    const { modelId, versionId, pageUrl, pathOverride, userDefined, conflictMode, fileNameOverride, extensionOverride, fileIds, fileOpts } = req.body;
    if (!modelId) return res.status(400).json({ error: 'modelId required' });

    const cfg = loadConfig();
    const civitaiToken = getCivitaiToken();

    try {
      const headers = {};
      if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;

      const modelResp = await fetch(`https://civitai.com/api/v1/models/${modelId}`, { headers });
      if (!modelResp.ok) throw new Error(`CivitAI API: ${modelResp.status}`);
      const model = await modelResp.json();

      let version;
      if (versionId) {
        version = model.modelVersions?.find(v => String(v.id) === String(versionId));
      }
      if (!version) version = model.modelVersions?.[0];
      if (!version) throw new Error('No model versions found');

      const basePath = getBasePath();

      // Resolve effective pathOverride. Request field presence is authoritative:
      //   - field absent      → look up version-specific history override
      //   - field present ''  → user explicitly reset → no override, use template
      //   - field present set → use as-is
      // We never cross-apply another version's override.
      let effectiveOverride;
      if (Object.prototype.hasOwnProperty.call(req.body, 'pathOverride')) {
        effectiveOverride = pathOverride || null;
      } else {
        const histOverride = lookupHistoryOverride(modelId, version.id);
        effectiveOverride = (histOverride?.pathOverride && String(histOverride.versionId) === String(version.id))
          ? histOverride.pathOverride
          : null;
      }

      // Contextual component detection across all versions
      const contextComponents = detectComponentsInContext(model.modelVersions || []);
      const versionComponent = contextComponents[String(version.id)] || null;

      const queued = [];

      // ── Download model file(s) ──
      if (cfg.downloadModel && version.files?.length) {
      // Count names WITHIN this version. Several files sharing a name is normal on
      // CivitAI and used to be destructive here: all of them resolved to the SAME
      // targetFile, so N concurrent downloads interleaved into ONE .part — and each
      // new file deleted the previous one's .part on the way in. Result: a corrupt
      // blob, and progress reading past 100% because it measured one shared .part
      // against a single file's expected size (a 19 GB file reaching 60 GB).
      // Same helper as the preview, so what the UI showed is what lands on disk.
      const _dlDirs = new Map();
      const _dlNames = resolveVersionFileNames(version.files, (f) => {
        const r = resolveTargetPath(model, version, f, cfg, effectiveOverride, userDefined, extensionOverride, versionComponent);
        _dlDirs.set(String(f.id != null ? f.id : f.name), r.targetDir);
        return r.fileName;
      }, fileNameOverride, fileOpts);

      for (const file of version.files) {
          // Honour an explicit file selection. Previously the UI's checkboxes never
          // reached here at all — the body carried only modelId/versionId, so EVERY file
          // in the version downloaded no matter what was ticked. Absent/empty = all files,
          // which keeps older callers and the browser extension working unchanged.
          if (Array.isArray(fileIds) && fileIds.length && !fileIds.map(String).includes(String(file.id))) continue;
          if (!file.downloadUrl) continue;
          if (file.type === 'Training Data') continue;

          const _k = String(file.id != null ? file.id : file.name);
          // Name and dir both come from the shared pass. The override and the per-file
          // options are already folded in, and the collision guard ran AFTER them —
          // previously the override was applied last and wiped the guard's work.
          let targetDir = _dlDirs.get(_k);
          let fileName = _dlNames.get(_k);
          const targetFile = `${targetDir}/${fileName}`;

          // Skip existing COMPLETE files unless explicitly overwriting.
          // A .part file means a prior download was interrupted — delete it
          // and re-download. A complete final file at >=95% expected size is skipped.
          const partFile = targetFile + '.part';
          if (existsSync(partFile)) {
            try { const { unlinkSync } = await import('fs'); unlinkSync(partFile); } catch {}
          }
          if (conflictMode !== 'overwrite' && existsSync(targetFile)) {
            const expectedBytes = (file.sizeKB || 0) * 1024;
            const actualBytes = statSync(targetFile).size;
            if (expectedBytes > 0 && actualBytes < expectedBytes * 0.95) {
              // Incomplete final file from legacy download — delete and re-download
              try { const { unlinkSync } = await import('fs'); unlinkSync(targetFile); } catch {}
            } else {
              queued.push({ type: 'model', fileName, targetDir, skipped: true });
              continue;
            }
          }

          mkdirSync(targetDir, { recursive: true });

          // Add token to download URL if needed
          let dlUrl = file.downloadUrl;
          if (civitaiToken && !dlUrl.includes('token=')) {
            dlUrl += (dlUrl.includes('?') ? '&' : '?') + `token=${civitaiToken}`;
          }

          const pid = downloadFile(dlUrl, targetFile, null, cfg);

          // Fix permissions for this file's directory
          fixPermissions(targetDir, sshService);

          // Track in download manifest for queue monitoring
          const dlManifest = loadDownloads();
          const dlEntry = {
            id: Math.random().toString(16).slice(2, 10),
            modelName: model.name || 'Unknown',
            modelType: model.type || 'Unknown',
            versionName: version.name || '',
            fileName,
            targetDir,
            targetFile,
            dlUrl,
            size: (file.sizeKB || 0) * 1024,
            progress: 0,
            pid: pid || null,
            status: pid ? 'downloading' : 'pending',
            startedAt: pid ? new Date().toISOString() : null,
            completedAt: null,
          };
          dlManifest.downloads.push(dlEntry);
          saveDownloads(dlManifest);

          queued.push({ type: 'model', fileName, targetDir, pid });
        }
      }

      // Resolve metadata directory (same logic as model files but for meta/images)
      const firstFile = (version.files || []).find(f => f.type !== 'Training Data') || version.files?.[0] || { name: 'model.safetensors' };
      const metaVars = resolveVars(model, version, firstFile, cfg);
      if (userDefined) metaVars['$USER_DEFINED'] = userDefined;
      const metaTypeFolder = metaVars['$TYPE_FOLDER'] || 'other';
      const metaTypeCfg = cfg.typeTemplates?.[metaTypeFolder] || {};
      const hasMetaCustomTpl = metaTypeCfg.pathTemplate !== undefined && metaTypeCfg.pathTemplate !== null;
      const metaTpl = hasMetaCustomTpl ? metaTypeCfg.pathTemplate : (cfg.pathTemplate || '');
      const metaSep = metaTypeCfg.separator || cfg.separator || '-';
      const metaCaseMode = metaTypeCfg.caseMode || cfg.caseMode || 'standard';
      const metaPath = applyTemplate(metaTpl, metaVars, metaSep, metaCaseMode);
      const metaLastSlash = metaPath.lastIndexOf('/');
      let metaFolder = metaLastSlash >= 0 ? metaPath.substring(0, metaLastSlash) : metaPath;
      if (effectiveOverride) {
        let overrideFolderPart = effectiveOverride.replace(/\/+$/, '');
        overrideFolderPart = overrideFolderPart.replace(/^\/[^/]+\/[^/]+\//, '');
        if (overrideFolderPart.startsWith(metaTypeFolder + '/')) {
          overrideFolderPart = overrideFolderPart.substring(metaTypeFolder.length + 1);
        }
        metaFolder = overrideFolderPart;
      }
      let metaBaseName = metaLastSlash >= 0 ? metaPath.substring(metaLastSlash + 1) : 'model';
      metaBaseName = metaBaseName.replace(/\$EXTENSION/g, '').replace(/\.[^.]+$/, '').replace(/\.$/, '');
      if (fileNameOverride) metaBaseName = fileNameOverride;
      const metaDir = `${basePath}/${metaTypeFolder}/${metaFolder}`;

      const modelType = model.type || 'Unknown';
      addToHistory(model, version, 'proxlab', {
        pathOverride: effectiveOverride,
        targetDir: metaDir,
        fileNameOverride: fileNameOverride || extensionOverride || null,
      });

      // Respond immediately — metadata and images download in background
      console.log(`[civitai] Downloaded ${model.name} (${modelType}) -> ${metaDir} (${queued.length} model files)`);
      res.json({
        ok: true,
        modelName: model.name,
        modelType,
        versionName: version.name,
        targetDir: metaDir,
        filesQueued: queued.length,
        files: queued,
      });

      // ── Background: metadata + images (non-blocking) ──
      (async () => {
        try {
          mkdirSync(metaDir, { recursive: true });

          // Metadata files
          if (cfg.downloadMetadata || cfg.saveMetadata) {
            try {
              writeFileSync(`${metaDir}/${metaBaseName}.civit.full.info`, JSON.stringify(model, null, 2));
              writeFileSync(`${metaDir}/${metaBaseName}.civit.info`, JSON.stringify(version, null, 2));
              // SDNext-compatible sidecar — same model JSON, just at the
              // <basename>.json path that ui_extra_networks.find_info() looks for.
              // Lets SDNext display description, trigger words, tags, version
              // info on the network browser cards.
              writeFileSync(`${metaDir}/${metaBaseName}.json`, JSON.stringify(model, null, 2));
            } catch (err) { console.error('[civitai] Metadata write failed:', err.message); }
          }

          // ── Download images using imageSource + imageCount settings ──
          const imageCount = cfg.imageCount || 10;
          const imageSource = cfg.imageSource || 'model-card-first';
          const versionImages = version.images || [];
          let downloaded = 0;

          // Collect images based on source preference
          let allImages = [];

          // Model card images (from version data)
          const modelCardImages = versionImages.filter(i => i.url);

          // Gallery images (from images API — includes NSFW)
          let galleryImages = [];
          try {
            const imgResp = await fetch(
              `https://civitai.com/api/v1/images?modelVersionId=${version.id}&limit=${imageCount}&nsfw=true`,
              { headers }
            );
            if (imgResp.ok) {
              const imgData = await imgResp.json();
              galleryImages = (imgData.items || []).filter(i => i.url);
            }
          } catch {}

          // Build final image list based on source preference
          if (imageSource === 'model-card' || imageSource === 'model-card-first') {
            allImages = [...modelCardImages];
            if (imageSource === 'model-card-first' && allImages.length < imageCount) {
              // Fill remaining from gallery, avoiding duplicates
              const mcUrls = new Set(allImages.map(i => i.url));
              for (const gi of galleryImages) {
                if (allImages.length >= imageCount) break;
                if (!mcUrls.has(gi.url)) allImages.push(gi);
              }
            }
          } else if (imageSource === 'gallery' || imageSource === 'gallery-first') {
            allImages = [...galleryImages];
            if (imageSource === 'gallery-first' && allImages.length < imageCount) {
              const gUrls = new Set(allImages.map(i => i.url));
              for (const mi of modelCardImages) {
                if (allImages.length >= imageCount) break;
                if (!gUrls.has(mi.url)) allImages.push(mi);
              }
            }
          }

          // Cap at imageCount
          allImages = allImages.slice(0, imageCount);
          console.log(`[civitai] Images: ${allImages.length} to download (source=${imageSource}, modelCard=${modelCardImages.length}, gallery=${galleryImages.length})`);

          // Download images — skip existing ones
          for (let i = 0; i < allImages.length; i++) {
            const img = allImages[i];
            const imgExt = img.type === 'video' ? 'mp4' : 'jpeg';
            const imgFileName = i === 0 ? `${metaBaseName}.${imgExt}` : `${metaBaseName}_${i}.${imgExt}`;
            const imgPath = `${metaDir}/${imgFileName}`;
            // Skip if image already exists (e.g. moved by renamer)
            if (existsSync(imgPath)) { downloaded++; continue; }
            try {
              await downloadFileSync(img.url, imgPath);
              downloaded++;
            } catch (err) { console.error(`[civitai] Image ${i} failed:`, err.message); }
          }
          console.log(`[civitai] Downloaded ${downloaded}/${allImages.length} images`);

          fixPermissions(metaDir, sshService);
          console.log(`[civitai] Background metadata/images complete for ${model.name}`);
        } catch (err) {
          console.error('[civitai] Background download error:', err.message);
        }
      })();
    } catch (err) {
      console.error(`[civitai] Download failed:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Processing Queue ──────────────────────────────────────────────────
  // Items sent via "Send to Review" from the browser extension.
  // Each entry: { id, modelId, versionId, pageUrl, addedAt, modelData (fetched) }

  function loadQueue() {
    try {
      if (existsSync(QUEUE_PATH)) return JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
    } catch {}
    return { items: [] };
  }

  function saveQueue(q) {
    writeJsonAtomic(QUEUE_PATH, q);
  }

  /** POST /queue/add — Add item to processing queue (from browser extension "Send to Review") */
  router.post('/queue/add', async (req, res) => {
    const { modelId, versionId, pageUrl, extensionOverride, fileNameOverride: reqFnOverride } = req.body;
    if (!modelId) return res.status(400).json({ error: 'modelId required' });

    const q = loadQueue();
    const id = Math.random().toString(16).slice(2, 10);

    // Fetch model data from CivitAI so it's ready for review
    let modelData = null;
    try {
      const civitaiToken = getCivitaiToken();
      const headers = {};
      if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;
      const resp = await fetch(`https://civitai.com/api/v1/models/${modelId}`, { headers });
      if (resp.ok) modelData = await resp.json();
    } catch {}

    // Check history for previous path overrides — only accept overrides stored
    // against THIS version. Another version's path would route the file into
    // the wrong baseModel folder.
    const histOverride = lookupHistoryOverride(modelId, versionId);
    const effectiveOverride = (histOverride?.pathOverride && String(histOverride.versionId) === String(versionId))
      ? histOverride.pathOverride
      : null;

    // Check for existing file conflicts
    let conflicts = [];
    let conflictDir = null;
    if (modelData) {
      const cfg = loadConfig();
      const version = versionId
        ? modelData.modelVersions?.find(v => String(v.id) === String(versionId))
        : modelData.modelVersions?.[0];
      if (version?.files?.length) {
        const fileNames = [];
        for (const file of version.files) {
          if (file.type === 'Training Data') continue;
          const resolved = resolveTargetPath(modelData, version, file, cfg, effectiveOverride, '');
          if (!conflictDir) conflictDir = resolved.targetDir;
          fileNames.push(resolved.fileName);
        }
        if (conflictDir) conflicts = checkExistingFiles(conflictDir, fileNames);
      }
    }

    q.items.push({
      id,
      modelId,
      versionId: versionId || null,
      pageUrl: pageUrl || '',
      addedAt: new Date().toISOString(),
      modelData,
      userDefined: '',
      extensionOverride: extensionOverride || reqFnOverride
        || ((histOverride?.fileNameOverride && String(histOverride.versionId) === String(versionId))
          ? histOverride.fileNameOverride : null),
      pathOverride: effectiveOverride,
      conflicts: conflicts.length > 0 ? conflicts : null,
      conflictDir: conflicts.length > 0 ? conflictDir : null,
    });
    saveQueue(q);

    console.log(`[civitai] Added to review queue: ${modelData?.name || modelId}${conflicts.length ? ` (${conflicts.length} conflicts)` : ''} (${q.items.length} in queue)`);
    res.json({ ok: true, id, queueLength: q.items.length, modelName: modelData?.name, conflicts: conflicts.length > 0 ? conflicts : null });
  });

  /** GET /queue — Get all queue items */
  router.get('/queue', (req, res) => {
    res.json(loadQueue());
  });

  /** DELETE /queue/:id — Remove item from queue */
  router.delete('/queue/:id', (req, res) => {
    const q = loadQueue();
    q.items = q.items.filter(i => i.id !== req.params.id);
    saveQueue(q);
    res.json({ ok: true });
  });

  /** PUT /queue/:id — Update queue item (e.g., set userDefined) */
  router.put('/queue/:id', (req, res) => {
    const q = loadQueue();
    const item = q.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Queue item not found' });
    if (req.body.userDefined !== undefined) item.userDefined = req.body.userDefined;
    if (req.body.versionId !== undefined) item.versionId = req.body.versionId;
    if (req.body.versionOverrides !== undefined) item.versionOverrides = req.body.versionOverrides;
    saveQueue(q);
    res.json({ ok: true });
  });

  /** POST /queue/clear — Clear entire queue */
  router.post('/queue/clear', (req, res) => {
    saveQueue({ items: [] });
    res.json({ ok: true });
  });

  // ─── Renamer queue (persistent, same pattern as review queue) ────────
  function loadRenamer() {
    try {
      if (existsSync(RENAMER_PATH)) return JSON.parse(readFileSync(RENAMER_PATH, 'utf8'));
    } catch {}
    return { items: [] };
  }
  function saveRenamer(r) {
    writeJsonAtomic(RENAMER_PATH, r);
  }

  router.get('/renamer', (req, res) => {
    res.json(loadRenamer());
  });

  router.post('/renamer/add', (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
    const r = loadRenamer();
    let added = 0;
    for (const item of items) {
      if (!item.modelId) continue;
      // Dedupe by modelId + versionId
      if (r.items.some(i => String(i.modelId) === String(item.modelId) && String(i.versionId) === String(item.versionId))) continue;
      r.items.push({ id: Math.random().toString(16).slice(2, 10), ...item, addedAt: new Date().toISOString() });
      added++;
    }
    saveRenamer(r);
    res.json({ ok: true, added, total: r.items.length });
  });

  router.put('/renamer/:id', (req, res) => {
    const r = loadRenamer();
    const item = r.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    // Allow updating newDir and newFiles (user edits)
    if (req.body.newDir !== undefined) item.newDir = req.body.newDir;
    if (req.body.newFiles !== undefined) item.newFiles = req.body.newFiles;
    saveRenamer(r);
    res.json({ ok: true });
  });

  router.delete('/renamer/:id', (req, res) => {
    const r = loadRenamer();
    r.items = r.items.filter(i => i.id !== req.params.id);
    saveRenamer(r);
    res.json({ ok: true });
  });

  router.post('/renamer/clear', (req, res) => {
    saveRenamer({ items: [] });
    res.json({ ok: true });
  });

  // ─── CSV Import ───────────────────────────────────────────────────────
  /** POST /csv-import — Search CivitAI for model names and add to queue */
  router.post('/csv-import', async (req, res) => {
    const { names } = req.body;
    if (!names?.length) return res.status(400).json({ error: 'names array required' });

    const civitaiToken = getCivitaiToken();
    const headers = {};
    if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;

    const q = loadQueue();
    const results = [];

    for (const name of names) {
      const trimmed = name.trim();
      if (!trimmed) continue;

      try {
        // Search CivitAI for the model name
        const searchUrl = `https://civitai.com/api/v1/models?query=${encodeURIComponent(trimmed)}&limit=1`;
        const resp = await fetch(searchUrl, { headers });
        if (!resp.ok) {
          results.push({ name: trimmed, status: 'error', error: `API ${resp.status}` });
          continue;
        }
        const data = await resp.json();
        const model = data.items?.[0];
        if (!model) {
          results.push({ name: trimmed, status: 'not-found' });
          continue;
        }

        // Fetch full model data
        const fullResp = await fetch(`https://civitai.com/api/v1/models/${model.id}`, { headers });
        const fullModel = fullResp.ok ? await fullResp.json() : null;

        const id = Math.random().toString(16).slice(2, 10);
        q.items.push({
          id,
          modelId: String(model.id),
          versionId: null,
          pageUrl: `https://civitai.red/models/${model.id}`,
          addedAt: new Date().toISOString(),
          modelData: fullModel || model,
          userDefined: '',
          csvSearchTerm: trimmed,
        });
        results.push({ name: trimmed, status: 'found', modelName: model.name, modelId: model.id });
      } catch (err) {
        results.push({ name: trimmed, status: 'error', error: err.message });
      }
    }

    saveQueue(q);
    console.log(`[civitai] CSV import: ${results.filter(r => r.status === 'found').length}/${names.length} found, queue now ${q.items.length} items`);
    res.json({ ok: true, results, queueLength: q.items.length });
  });

  // ─── Active Download Tracking ─────────────────────────────────────────

  /** GET /downloads — Poll active downloads with live progress */
  // Backend-driven reconciler (mirrors HF reconcileHfDownloads): reap finished civ downloads
  // (dead-PID -> complete/failed/requeue) + advance the pending queue, on a setInterval below so the
  // queue ALWAYS progresses with NO browser tab and across UI restarts (curl runs under systemd-run
  // --scope). The GET /downloads route calls it too, so the live view stays authoritative.
  function reconcileCivDownloads() {
    try {
    const manifest = loadDownloads();
    let changed = false;
    const now = Date.now();

    for (const dl of manifest.downloads) {
      if (dl.status !== 'downloading' || !dl.pid) continue;

      // Check if curl process is still running
      let isRunning = false;
      try { process.kill(dl.pid, 0); isRunning = true; } catch { isRunning = false; }

      // Get current file size on disk — check both .part (in-progress) and final path
      let currentSize = 0;
      try {
        const partFile = dl.targetFile + '.part';
        if (existsSync(partFile)) {
          currentSize = statSync(partFile).size;
        } else if (dl.targetFile && existsSync(dl.targetFile)) {
          currentSize = statSync(dl.targetFile).size;
        }
      } catch {}

      // Track speed: bytes downloaded since last poll
      const lastPoll = dl._lastPollTime || now;
      const lastSize = dl._lastPollSize || 0;
      const elapsed = (now - lastPoll) / 1000;
      if (elapsed > 0 && currentSize > lastSize) {
        dl.speed = Math.round((currentSize - lastSize) / elapsed);
      } else if (elapsed > 10) {
        dl.speed = 0;
      }
      dl._lastPollTime = now;
      dl._lastPollSize = currentSize;

      if (!isRunning) {
        // Require 3 consecutive dead-PID checks before acting.
        // Prevents false positives from transient process states.
        dl._deadChecks = (dl._deadChecks || 0) + 1;
        if (dl._deadChecks < 3) {
          dl.progress = currentSize;
          changed = true;
          continue;
        }

        const finalExists = dl.targetFile && existsSync(dl.targetFile);
        const partExists = existsSync(dl.targetFile + '.part');
        let finalSize = 0;
        try { if (finalExists) finalSize = statSync(dl.targetFile).size; } catch {}

        const expectedSize = dl.size || 0;
        const closeEnough = finalExists && !partExists && (
          expectedSize > 0 ? (finalSize >= expectedSize * 0.95) : (finalSize > 1000)
        );
        if (closeEnough) {
          dl.status = 'complete';
          dl.progress = finalSize;
          dl.completedAt = new Date().toISOString();
          console.log(`[civitai-dl] COMPLETE: ${dl.fileName} (${(finalSize / 1e9).toFixed(2)} GB)`);
        } else if (dl.dlUrl) {
          // Auto-requeue with retry limit — stop after 5 consecutive failures
          // to prevent infinite spawn-die loops (e.g. 401 auth errors).
          dl._retries = (dl._retries || 0) + 1;
          if (dl._retries >= 5) {
            dl.status = 'failed';
            dl.pid = null;
            dl.progress = currentSize;
            dl.error = `Failed after ${dl._retries} retries — download keeps dying immediately`;
            console.log(`[civitai-dl] GIVE UP: ${dl.fileName} — ${dl._retries} retries exhausted`);
          } else {
            dl.status = 'pending';
            dl.pid = null;
            dl.progress = currentSize;
            dl.error = null;
            dl._deadChecks = 0;
            console.log(`[civitai-dl] REQUEUE (${dl._retries}/5): ${dl.fileName} — PID dead, ${(currentSize / 1e9).toFixed(2)}/${(expectedSize / 1e9).toFixed(2)} GB`);
          }
        } else {
          dl.status = 'failed';
          dl.progress = currentSize;
          dl.error = expectedSize > 0
            ? `Incomplete: ${(currentSize / 1e9).toFixed(2)}GB / ${(expectedSize / 1e9).toFixed(2)}GB expected`
            : 'Download process exited with no output';
          console.log(`[civitai-dl] FAILED: ${dl.fileName} — no dlUrl to retry`);
        }
        changed = true;
      } else {
        dl._deadChecks = 0;
        if (dl.progress !== currentSize) {
          // Real progress — reset retry counter
          if (currentSize > (dl.progress || 0)) dl._retries = 0;
          dl.progress = currentSize;
          changed = true;
        }
      }
    }

    if (changed) saveDownloads(manifest);

    // Start pending downloads if slots are available
    processPendingDownloads();

      return manifest;
    } catch (e) {
      console.error('[civitai] reconcile error:', e.message);
      return loadDownloads();
    }
  }
  if (!globalThis.__civReconcileTimer) {
    globalThis.__civReconcileTimer = setInterval(() => { reconcileCivDownloads(); }, 5000);
    if (globalThis.__civReconcileTimer.unref) globalThis.__civReconcileTimer.unref();
  }

  router.get('/downloads', (req, res) => {
    const manifest = reconcileCivDownloads();
    // Annotate pending/downloading items with extra UI info
    const enriched = manifest.downloads.map(dl => {
      const out = { ...dl };
      delete out._lastPollTime;
      delete out._lastPollSize;
      delete out._deadChecks;
      if (dl.status === 'pending') {
        let partialSize = 0;
        try {
          const pf = dl.targetFile + '.part';
          if (existsSync(pf)) partialSize = statSync(pf).size;
          else if (dl.targetFile && existsSync(dl.targetFile)) partialSize = statSync(dl.targetFile).size;
        } catch {}
        out.partialSize = partialSize;
      }
      return out;
    });

    res.json({ downloads: enriched });
  });

  /** DELETE /downloads/:id — Cancel or remove a download */
  router.delete('/downloads/:id', (req, res) => {
    const manifest = loadDownloads();
    const idx = manifest.downloads.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const dl = manifest.downloads[idx];
    // Kill process if still running
    if (dl.status === 'downloading' && dl.pid) {
      try { process.kill(dl.pid, 'SIGTERM'); } catch {}
    }
    manifest.downloads.splice(idx, 1);
    saveDownloads(manifest);
    res.json({ ok: true });
  });

  /** POST /downloads/clear — Clear completed and failed downloads */
  router.post('/downloads/clear', (req, res) => {
    const manifest = loadDownloads();
    manifest.downloads = manifest.downloads.filter(d => d.status === 'downloading' || d.status === 'pending');
    saveDownloads(manifest);
    res.json({ ok: true });
  });

  /** POST /downloads/:id/stop — Stop a download but keep it in queue as pending */
  router.post('/downloads/:id/stop', (req, res) => {
    const manifest = loadDownloads();
    const dl = manifest.downloads.find(d => d.id === req.params.id);
    if (!dl) return res.status(404).json({ error: 'Not found' });
    if (dl.status === 'downloading' && dl.pid) {
      try { process.kill(dl.pid, 'SIGTERM'); } catch {}
      console.log(`[civitai-dl] STOP: ${dl.fileName} PID ${dl.pid}`);
    }
    dl.status = 'pending';
    dl.pid = null;
    dl._deadChecks = 0;
    saveDownloads(manifest);
    res.json({ ok: true });
  });

  /** POST /downloads/:id/force — Force-start a download ignoring concurrency/scheduler */
  router.post('/downloads/:id/force', (req, res) => {
    const manifest = loadDownloads();
    const dl = manifest.downloads.find(d => d.id === req.params.id);
    if (!dl) return res.status(404).json({ error: 'Not found' });
    if (!dl.dlUrl) return res.status(400).json({ error: 'No download URL stored' });
    if (dl.status === 'downloading' && dl.pid) {
      return res.json({ ok: true, message: 'Already downloading' });
    }
    const pid = spawnCurl(dl.dlUrl, dl.targetFile, null);
    if (pid) {
      dl.pid = pid;
      dl.status = 'downloading';
      dl.startedAt = new Date().toISOString();
      dl._deadChecks = 0;
      console.log(`[civitai-dl] FORCE: ${dl.fileName} PID ${pid}`);
      saveDownloads(manifest);
      res.json({ ok: true, pid });
    } else {
      res.status(500).json({ error: 'Failed to spawn curl' });
    }
  });

  /** POST /downloads/reorder — Reorder download queue */
  router.post('/downloads/reorder', (req, res) => {
    const { id, position, targetId, before } = req.body;
    const manifest = loadDownloads();
    const idx = manifest.downloads.findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const [item] = manifest.downloads.splice(idx, 1);

    if (targetId) {
      // Drop relative to another item
      let targetIdx = manifest.downloads.findIndex(d => d.id === targetId);
      if (targetIdx === -1) targetIdx = manifest.downloads.length;
      manifest.downloads.splice(before ? targetIdx : targetIdx + 1, 0, item);
    } else if (position === 'top') {
      const firstNonActive = manifest.downloads.findIndex(d => d.status !== 'downloading');
      manifest.downloads.splice(firstNonActive >= 0 ? firstNonActive : 0, 0, item);
    } else {
      manifest.downloads.push(item);
    }
    saveDownloads(manifest);
    res.json({ ok: true });
  });

  // ─── Download History ──────────────────────────────────────────────────

  /** GET /history — Get download history with optional type filter */
  router.get('/history', (req, res) => {
    const h = loadHistory();
    const type = req.query.type;
    let items = h.items;
    if (type) items = items.filter(i => i.modelType === type);
    // Strip heavy fields for listing — only send what UI needs for display
    const slim = items.map(i => ({
      modelId: i.modelId,
      modelName: i.modelName,
      modelType: i.modelType,
      versionId: i.versionId,
      versionName: i.versionName,
      baseModel: i.baseModel,
      creator: i.creator,
      downloadedAt: i.downloadedAt,
      source: i.source,
      pageUrl: i.pageUrl,
      pathOverride: i.pathOverride || null,
      fileNameOverride: i.fileNameOverride || null,
      primaryTag: i.primaryTag || '',
      hasFiles: !!(i.locatedFiles?.length),
      locatedPath: i.locatedFiles?.[0]?.currentPath || i.currentDir || null,
      inOldFolder: !!(i.currentDir && i.currentDir.includes('/OLD')),
      downloadedVersions: i.downloadedVersions,
    }));
    res.json({ items: slim, total: h.items.length, lastSync: h.lastSync });
  });

  /** POST /history/details — Get full history data for specific model IDs (for renamer) */
  router.post('/history/details', (req, res) => {
    const { modelIds } = req.body;
    if (!modelIds?.length) return res.status(400).json({ error: 'modelIds required' });
    const h = loadHistory();
    const idSet = new Set(modelIds.map(String));
    const items = h.items.filter(i => idSet.has(String(i.modelId)));
    res.json({ items });
  });

  /** POST /history/clear — Clear all history */
  router.post('/history/clear', (req, res) => {
    saveHistory({ items: [], lastSync: null });
    res.json({ ok: true });
  });

  /** POST /history/send-to-queue — Send history items to processing queue */
  router.post('/history/send-to-queue', async (req, res) => {
    const { modelIds } = req.body;
    if (!modelIds?.length) return res.status(400).json({ error: 'modelIds required' });

    const civitaiToken = getCivitaiToken();
    const headers = {};
    if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;

    const q = loadQueue();
    let added = 0;

    const h = loadHistory();
    for (const mid of modelIds) {
      // Skip if already in queue
      if (q.items.some(i => String(i.modelId) === String(mid))) continue;

      try {
        const resp = await fetch(`https://civitai.com/api/v1/models/${mid}`, { headers });
        if (!resp.ok) continue;
        const modelData = await resp.json();

        // Carry over fileNameOverride and pathOverride from history
        const histEntry = h.items.find(i => String(i.modelId) === String(mid));
        const histVid = histEntry?.versionId || null;
        const histOverride = histEntry ? lookupHistoryOverride(mid, histVid) : null;
        const effectivePath = (histOverride?.pathOverride && String(histOverride.versionId) === String(histVid))
          ? histOverride.pathOverride : null;
        const effectiveFn = (histOverride?.fileNameOverride && String(histOverride.versionId) === String(histVid))
          ? histOverride.fileNameOverride : null;

        q.items.push({
          id: Math.random().toString(16).slice(2, 10),
          modelId: String(mid),
          versionId: histVid,
          pageUrl: histEntry?.pageUrl || `https://civitai.red/models/${mid}`,
          addedAt: new Date().toISOString(),
          modelData,
          userDefined: '',
          extensionOverride: effectiveFn,
          pathOverride: effectivePath,
        });
        added++;
      } catch {}
    }

    saveQueue(q);
    res.json({ ok: true, added, queueLength: q.items.length });
  });

  /** POST /history/enrich — One-time: fetch metadata for history entries from CivitAI API */
  router.post('/history/enrich', async (req, res) => {
    const { types } = req.body; // e.g. ['Checkpoint', 'LORA', 'LoCon']
    const filterTypes = types || ['Checkpoint', 'LORA', 'LoCon'];
    const civitaiToken = getCivitaiToken();
    const headers = {};
    if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;

    const h = loadHistory();
    const toEnrich = h.items.filter(i =>
      filterTypes.includes(i.modelType) && !i.files
    );

    res.json({ ok: true, total: toEnrich.length, message: 'Enrichment started in background' });

    // Run in background to avoid timeout
    let enriched = 0;
    for (const item of toEnrich) {
      try {
        const resp = await fetch(`https://civitai.com/api/v1/models/${item.modelId}`, { headers });
        if (!resp.ok) continue;
        const model = await resp.json();

        const version = item.versionId
          ? model.modelVersions?.find(v => String(v.id) === String(item.versionId))
          : model.modelVersions?.[0];

        if (version?.files) {
          item.files = version.files
            .filter(f => f.type !== 'Training Data')
            .map(f => ({
              name: f.name,
              sizeKB: f.sizeKB || 0,
              type: f.type || 'Model',
              hashes: f.hashes || {},
            }));
          item.modelData = {
            name: model.name,
            type: model.type,
            creator: model.creator?.username,
          };
          if (version.baseModel) item.baseModel = version.baseModel;
          if (version.name) item.versionName = version.name;
          if (model.tags?.[0]) item.primaryTag = model.tags[0];
          enriched++;
        }

        // Rate limit: 250ms between calls
        await new Promise(r => setTimeout(r, 250));
      } catch {}

      // Save every 50 entries
      if (enriched % 50 === 0 && enriched > 0) saveHistory(h);
    }
    saveHistory(h);
    console.log(`[civitai] Enrichment complete: ${enriched}/${toEnrich.length} entries updated`);
  });

  /** POST /history/update-override — Update path/filename override for a history entry */
  router.post('/history/update-override', (req, res) => {
    const { modelId, versionId, pathOverride, fileNameOverride } = req.body;
    if (!modelId) return res.status(400).json({ error: 'modelId required' });
    const h = loadHistory();
    const entry = versionId
      ? h.items.find(i => String(i.modelId) === String(modelId) && String(i.versionId) === String(versionId))
      : h.items.find(i => String(i.modelId) === String(modelId));
    if (!entry) return res.status(404).json({ error: 'History entry not found' });
    if (pathOverride !== undefined) entry.pathOverride = pathOverride;
    if (fileNameOverride !== undefined) entry.fileNameOverride = fileNameOverride;
    saveHistory(h);
    res.json({ ok: true });
  });

  /** POST /history/locate — Scan fm-index to find current file locations for history entries */
  router.post('/history/locate', (req, res) => {
    const { types } = req.body;
    const filterTypes = types || ['Checkpoint', 'LORA', 'LoCon'];

    // Load fm-index
    let fmIndex = {};
    try {
      const raw = readFileSync(join(DATA_DIR, 'fm-index.json'), 'utf8');
      fmIndex = JSON.parse(raw);
    } catch { return res.status(500).json({ error: 'Could not load fm-index' }); }

    const treeIndex = fmIndex.treeIndex || {};
    const basePath = getBasePath();

    // Build filename → path[] lookup from tree index (collect ALL matches, filter later)
    const fileMap = new Map(); // filename (lowercase) → [full path, ...]
    for (const [dir, entry] of Object.entries(treeIndex)) {
      if (!entry.files) continue;
      for (const f of entry.files) {
        const key = f.name.toLowerCase();
        if (!fileMap.has(key)) fileMap.set(key, []);
        fileMap.get(key).push(f.path);
      }
    }

    // Pick the best path from candidates: prefer non-OLD, verify exists on disk
    function pickBestPath(candidates) {
      if (!candidates || candidates.length === 0) return null;
      // First pass: non-OLD paths that exist on disk
      for (const p of candidates) {
        if (!p.includes('/OLD/') && existsSync(p)) return p;
      }
      // Second pass: any path that exists on disk
      for (const p of candidates) {
        if (existsSync(p)) return p;
      }
      return null;
    }

    const h = loadHistory();
    let located = 0;
    let cleared = 0;
    const results = [];

    for (const item of h.items) {
      if (!filterTypes.includes(item.modelType)) continue;
      if (!item.files?.length) continue;

      // For each CivitAI file, try to locate it on disk using these names in order:
      //   1. The existing locatedFile name at same index (post-rename)
      //   2. fileNameOverride + original extension (renamed but locatedFiles corrupted)
      //   3. Original CivitAI filename (never renamed)
      const locatedFiles = [];
      for (let i = 0; i < item.files.length; i++) {
        const f = item.files[i];
        // Use lastIndexOf so multi-dot CivitAI filenames (e.g. "Flux.Panties.Down.safetensors")
        // yield only ".safetensors" and don't concatenate phantom tokens onto fileNameOverride.
        const dot = f.name.lastIndexOf('.');
        const ext = dot > 0 ? f.name.substring(dot) : '';

        const namesToTry = [];
        if (item.locatedFiles?.[i]?.name) namesToTry.push(item.locatedFiles[i].name);
        if (item.fileNameOverride) namesToTry.push(item.fileNameOverride + ext);
        namesToTry.push(f.name);

        let found = null;
        for (const name of namesToTry) {
          const candidates = fileMap.get(name.toLowerCase());
          const path = pickBestPath(candidates);
          if (path) { found = { name, path }; break; }
        }
        if (found) {
          locatedFiles.push({
            name: found.name,
            currentPath: found.path,
            indexPath: found.path.replace(basePath, ''),
          });
        }
      }

      if (locatedFiles.length > 0) {
        item.locatedFiles = locatedFiles;
        item.currentDir = locatedFiles[0].currentPath.substring(0, locatedFiles[0].currentPath.lastIndexOf('/'));
        located++;
        results.push({ modelId: item.modelId, modelName: item.modelName, found: locatedFiles.length });
      } else if (item.locatedFiles?.length) {
        // Stale — clear so UI doesn't show phantom OLD paths
        item.locatedFiles = null;
        item.currentDir = null;
        cleared++;
      }
    }

    saveHistory(h);
    res.json({
      ok: true,
      located,
      cleared,
      total: h.items.filter(i => filterTypes.includes(i.modelType) && i.files?.length).length,
      results,
    });
  });

  /** POST /rename — Move/rename files from current location to template-resolved location */
  router.post('/rename', async (req, res) => {
    const { modelId, versionId, pathOverride, userDefined, moves, downloadMeta } = req.body;
    // moves: [{ from: '/ai-assets/imagegen/...', to: '/ai-assets/imagegen/...' }]
    if (!moves?.length) return res.status(400).json({ error: 'No moves specified' });

    const basePath = getBasePath();
    const moved = [];
    const errors = [];
    const deleted = [];

    for (const m of moves) {
      const fromDir = m.from.substring(0, m.from.lastIndexOf('/'));
      const fromBase = m.from.split('/').pop().replace(/\.[^.]+$/, ''); // base name without ext
      const toDir = m.to.substring(0, m.to.lastIndexOf('/'));
      const toBase = m.to.split('/').pop().replace(/\.[^.]+$/, '');

      mkdirSync(toDir, { recursive: true });

      // Scan source directory for all related files (same base name + any extension/suffix)
      let relatedFiles = [];
      try {
        const dirContents = readdirSync(fromDir);
        relatedFiles = dirContents.filter(name => {
          // Match: baseName.ext, baseName_1.ext, baseName.preview.ext, etc.
          // But NOT other models that just happen to start with the same prefix
          return name === fromBase || name.startsWith(fromBase + '.') || name.startsWith(fromBase + '_');
        });
      } catch {}

      for (const relFile of relatedFiles) {
        const relFrom = `${fromDir}/${relFile}`;

        // Skip old civitai metadata files — delete them instead
        if (relFile.endsWith('.civit.info') || relFile.endsWith('.civit.full.info')) {
          try {
            const { unlinkSync } = await import('fs');
            unlinkSync(relFrom);
            deleted.push(relFile);
          } catch {}
          continue;
        }

        // Build the new filename: replace old base name with new base name
        let newRelFile;
        if (relFile === `${fromBase}${relFile.substring(fromBase.length)}`) {
          // Replace the base name portion, keep the rest (suffix + extension)
          newRelFile = toBase + relFile.substring(fromBase.length);
        } else {
          newRelFile = relFile;
        }

        const relTo = `${toDir}/${newRelFile}`;

        // Same path — no-op but still count as "moved" so history gets updated
        if (relFrom === relTo) {
          moved.push({ from: relFrom, to: relTo });
          continue;
        }

        try {
          const { renameSync } = await import('fs');
          renameSync(relFrom, relTo);
          moved.push({ from: relFrom, to: relTo });
        } catch (err) {
          try {
            const { copyFileSync, unlinkSync } = await import('fs');
            copyFileSync(relFrom, relTo);
            unlinkSync(relFrom);
            moved.push({ from: relFrom, to: relTo });
          } catch (err2) {
            errors.push({ from: relFrom, to: relTo, error: err2.message });
          }
        }
      }
    }

    // Fix permissions on new locations
    const newDirs = [...new Set(moved.map(m => m.to.substring(0, m.to.lastIndexOf('/'))))];
    for (const dir of newDirs) {
      fixPermissions(dir, sshService);
    }

    // Clean up empty source directories
    const srcDirs = [...new Set(moves.map(m => m.from.substring(0, m.from.lastIndexOf('/'))))];
    for (const srcDir of srcDirs) {
      try {
        const remaining = readdirSync(srcDir);
        if (remaining.length === 0) {
          const { rmdirSync } = await import('fs');
          rmdirSync(srcDir);
        }
      } catch {}
    }

    // If Apply (downloadMeta=true), download fresh metadata to the new location
    if (downloadMeta && modelId && moved.length > 0) {
      const newDir = moved[0].to.substring(0, moved[0].to.lastIndexOf('/'));
      const newBaseName = moved[0].to.split('/').pop().replace(/\.[^.]+$/, '');
      try {
        const civitaiToken = getCivitaiToken();
        const headers = {};
        if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;
        const modelResp = await fetch(`https://civitai.com/api/v1/models/${modelId}`, { headers });
        if (modelResp.ok) {
          const model = await modelResp.json();
          const version = versionId
            ? model.modelVersions?.find(v => String(v.id) === String(versionId))
            : model.modelVersions?.[0];
          writeFileSync(`${newDir}/${newBaseName}.civit.full.info`, JSON.stringify(model, null, 2));
          if (version) writeFileSync(`${newDir}/${newBaseName}.civit.info`, JSON.stringify(version, null, 2));
          // SDNext-compatible sidecar (same content, expected filename)
          writeFileSync(`${newDir}/${newBaseName}.json`, JSON.stringify(model, null, 2));
          fixPermissions(newDir, sshService);
        }
      } catch (err) { console.error('[civitai] Metadata download after rename failed:', err.message); }
    }

    // Update history entry with new location
    if (modelId && moved.length > 0) {
      const h = loadHistory();
      // Find the specific version entry, or fall back to any entry for this model
      const entry = versionId
        ? h.items.find(i => String(i.modelId) === String(modelId) && String(i.versionId) === String(versionId))
        : h.items.find(i => String(i.modelId) === String(modelId));
      if (entry) {
        const newDir = moved[0].to.substring(0, moved[0].to.lastIndexOf('/'));
        const newBaseName = moved[0].to.split('/').pop().replace(/\.[^.]+$/, '');
        entry.targetDir = newDir;
        entry.currentDir = newDir;
        entry.downloadedAt = new Date().toISOString();
        if (pathOverride) entry.pathOverride = pathOverride;
        entry.fileNameOverride = newBaseName;
        entry.locatedFiles = moved.map(m => ({
          name: m.to.split('/').pop(),
          currentPath: m.to,
          indexPath: m.to.replace(basePath, ''),
        }));
        entry.files = moved.filter(m => {
          const name = m.to.split('/').pop();
          return name.endsWith('.safetensors') || name.endsWith('.ckpt') || name.endsWith('.pt');
        }).map(m => ({
          name: m.to.split('/').pop(),
          sizeKB: 0,
          type: 'Model',
          hashes: {},
        }));
        // Move to top of history list
        const idx = h.items.indexOf(entry);
        if (idx > 0) { h.items.splice(idx, 1); h.items.unshift(entry); }
        saveHistory(h);
      }
    }

    if (errors.length) {
      console.error(`[civitai] Rename errors:`, JSON.stringify(errors));
    }
    console.log(`[civitai] Rename: ${moved.length} moved, ${errors.length} errors`);
    res.json({ ok: true, moved: moved.length, errors });
  });

  /** GET /queue/count — Quick count for sidebar badge */
  router.get('/queue/count', (req, res) => {
    const q = loadQueue();
    res.json({ count: q.items.length });
  });

  /** POST /history/check-updates — Check selected models for new/updated versions */
  router.post('/history/check-updates', async (req, res) => {
    const { modelIds } = req.body;
    if (!modelIds?.length) return res.status(400).json({ error: 'modelIds required' });

    const civitaiToken = getCivitaiToken();
    const headers = {};
    if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;

    const h = loadHistory();
    const q = loadQueue();
    let added = 0;
    const results = [];

    for (const mid of modelIds) {
      try {
        // Find all history entries for this model
        const historyEntries = h.items.filter(i => String(i.modelId) === String(mid));
        if (!historyEntries.length) continue;

        // Collect all previously downloaded version IDs for this model
        const downloadedVersionIds = new Set();
        for (const entry of historyEntries) {
          if (entry.versionId) downloadedVersionIds.add(String(entry.versionId));
          if (entry.downloadedVersions) {
            for (const vid of entry.downloadedVersions) downloadedVersionIds.add(String(vid));
          }
        }

        // Fetch current model data from CivitAI
        const resp = await fetch(`https://civitai.com/api/v1/models/${mid}`, { headers });
        if (!resp.ok) continue;
        const modelData = await resp.json();

        // Find versions not yet downloaded
        const allVersions = modelData.modelVersions || [];
        const newVersions = allVersions.filter(v => !downloadedVersionIds.has(String(v.id)));

        // Also check for updated versions (same ID but newer date)
        const updatedVersions = [];
        for (const v of allVersions) {
          if (!downloadedVersionIds.has(String(v.id))) continue;
          const histEntry = historyEntries.find(e => String(e.versionId) === String(v.id));
          if (histEntry && v.updatedAt && histEntry.downloadedAt) {
            if (new Date(v.updatedAt) > new Date(histEntry.downloadedAt)) {
              updatedVersions.push(v);
            }
          }
        }

        const versionsToQueue = [...newVersions, ...updatedVersions];
        if (versionsToQueue.length === 0) {
          results.push({ modelId: mid, modelName: modelData.name, status: 'up-to-date' });
          continue;
        }

        // Skip if already in queue
        if (q.items.some(i => String(i.modelId) === String(mid))) {
          results.push({ modelId: mid, modelName: modelData.name, status: 'already-queued' });
          continue;
        }

        // Get history override for path
        const histOverride = lookupHistoryOverride(mid);

        q.items.push({
          id: Math.random().toString(16).slice(2, 10),
          modelId: String(mid),
          versionId: null,  // null = user selects which versions to download during review
          pageUrl: `https://civitai.red/models/${mid}`,
          addedAt: new Date().toISOString(),
          modelData,
          userDefined: '',
          pathOverride: histOverride?.pathOverride || null,
          updateInfo: {
            newVersions: newVersions.map(v => ({ id: v.id, name: v.name })),
            updatedVersions: updatedVersions.map(v => ({ id: v.id, name: v.name })),
          },
        });
        added++;
        results.push({
          modelId: mid,
          modelName: modelData.name,
          status: 'updates-found',
          newVersions: newVersions.length,
          updatedVersions: updatedVersions.length,
        });
      } catch (err) {
        results.push({ modelId: mid, status: 'error', error: err.message });
      }
    }

    saveQueue(q);
    res.json({ ok: true, added, queueLength: q.items.length, results });
  });

  // ─── CivitAI History Sync (Playwright scraper) ────────────────────────

  let syncState = { active: false, progress: '', found: 0 };

  /** POST /history/sync — Sync download history from CivitAI using session cookie */
  router.post('/history/sync', async (req, res) => {
    const { sessionCookie, allCookies } = req.body;
    if (!sessionCookie && !allCookies) return res.status(400).json({ error: 'sessionCookie or allCookies required' });

    if (syncState.active) return res.status(409).json({ error: 'Sync already in progress', state: syncState });

    syncState = { active: true, progress: 'Starting browser...', found: 0 };
    res.json({ ok: true, message: 'History sync started' });

    // Run in background
    (async () => {
      try {
        // Try to use playwright — dynamic import to avoid hard dependency
        let playwright;
        try {
          playwright = await import('playwright');
        } catch {
          try {
            playwright = await import('playwright-core');
          } catch {
            syncState = { active: false, progress: 'Playwright not installed. Run: npm install playwright', found: 0 };
            console.error('[civitai] Playwright not available');
            return;
          }
        }

        syncState.progress = 'Launching headless browser...';
        const browser = await playwright.chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

        // Set cookies — either all cookies from CSV or just the session token
        if (allCookies && Array.isArray(allCookies)) {
          // Full cookie set passed from frontend
          await context.addCookies(allCookies);
        } else {
          // Legacy: single token — set all known required cookies
          const cookies = [
            { name: '__Secure-civitai-token', value: sessionCookie, domain: '.civitai.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
          ];
          await context.addCookies(cookies);
        }

        const page = await context.newPage();
        syncState.progress = 'Loading download history page...';

        await page.goto('https://civitai.com/user/downloads', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Load the downloads page to establish session
        syncState.progress = 'Loading CivitAI session...';
        await page.goto('https://civitai.com/user/downloads', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        // Fetch ALL downloads via CivitAI's internal tRPC API (no scrolling needed!)
        syncState.progress = 'Fetching download history via API...';
        const apiData = await page.evaluate(async () => {
          try {
            const resp = await fetch('/api/trpc/download.getAllByUser?input=' + encodeURIComponent(JSON.stringify({json:{authed:true}})));
            if (!resp.ok) return { error: resp.status };
            const data = await resp.json();
            return data?.result?.data?.json || { error: 'unexpected format' };
          } catch (e) {
            return { error: e.message };
          }
        });

        await browser.close();

        if (apiData.error) {
          syncState = { active: false, progress: `Sync failed: API returned ${apiData.error}. Cookie may be expired.`, found: 0 };
          return;
        }

        const downloads = apiData.items || apiData;
        if (!Array.isArray(downloads)) {
          syncState = { active: false, progress: 'Sync failed: unexpected API response format', found: 0 };
          return;
        }

        syncState.progress = `Found ${downloads.length} downloads. Processing...`;
        syncState.found = downloads.length;

        // Add all downloads to history (data is already complete — no extra API calls needed!)
        const h = loadHistory();
        let added = 0;

        for (const dl of downloads) {
          const mv = dl.modelVersion || {};
          const model = mv.model || {};
          const modelId = String(model.id || '');
          const versionId = String(mv.id || '');

          if (!modelId) continue;

          // Skip if already in history (same model + version)
          if (h.items.some(item => item.modelId === modelId && item.versionId === versionId)) continue;

          h.items.push({
            modelId,
            modelName: model.name || '',
            modelType: model.type || '',
            versionId,
            versionName: mv.name || '',
            baseModel: mv.baseModel || '',
            creator: '',  // not in tRPC response
            downloadedAt: dl.downloadAt || new Date().toISOString(),
            source: 'synced',
            pageUrl: `https://civitai.red/models/${modelId}?modelVersionId=${versionId}`,
            fileName: dl.file?.name || '',
            fileFormat: dl.file?.format || '',
          });
          added++;
        }

        h.lastSync = new Date().toISOString();
        saveHistory(h);

        syncState = { active: false, progress: `Sync complete: ${added} new models added (${h.items.length} total in history)`, found: downloads.length };
        console.log(`[civitai] History sync: ${downloads.length} found, ${added} new, ${h.items.length} total`);
      } catch (err) {
        syncState = { active: false, progress: `Sync failed: ${err.message}`, found: 0 };
        console.error('[civitai] History sync failed:', err.message);
      }
    })();
  });

  /** GET /history/sync-status — Check sync progress */
  router.get('/history/sync-status', (req, res) => {
    res.json(syncState);
  });

  // ─── Auto-update check timer ─────────────────────────────────────────
  async function runAutoUpdateCheck() {
    const cfg = loadConfig();
    if (!cfg.autoUpdateDays || cfg.autoUpdateDays <= 0) return;

    const now = new Date();
    const last = cfg.lastAutoUpdate ? new Date(cfg.lastAutoUpdate) : null;
    const intervalMs = cfg.autoUpdateDays * 24 * 60 * 60 * 1000;

    if (last && (now - last) < intervalMs) return;

    console.log('[civitai] Auto-update check starting...');
    const h = loadHistory();
    // Only check models downloaded via proxlab (not synced-only)
    const modelIds = [...new Set(
      h.items.filter(i => i.source === 'proxlab').map(i => i.modelId)
    )];

    if (!modelIds.length) return;

    const civitaiToken = getCivitaiToken();
    const headers = {};
    if (civitaiToken) headers['Authorization'] = `Bearer ${civitaiToken}`;
    const q = loadQueue();
    let added = 0;

    for (const mid of modelIds) {
      try {
        const historyEntries = h.items.filter(i => String(i.modelId) === String(mid));
        const downloadedVersionIds = new Set();
        for (const entry of historyEntries) {
          if (entry.versionId) downloadedVersionIds.add(String(entry.versionId));
          if (entry.downloadedVersions) {
            for (const vid of entry.downloadedVersions) downloadedVersionIds.add(String(vid));
          }
        }

        if (q.items.some(i => String(i.modelId) === String(mid))) continue;

        const resp = await fetch(`https://civitai.com/api/v1/models/${mid}`, { headers });
        if (!resp.ok) continue;
        const modelData = await resp.json();

        const newVersions = (modelData.modelVersions || []).filter(v => !downloadedVersionIds.has(String(v.id)));
        if (!newVersions.length) continue;

        const histOverride = lookupHistoryOverride(mid);
        q.items.push({
          id: Math.random().toString(16).slice(2, 10),
          modelId: String(mid),
          versionId: null,
          pageUrl: `https://civitai.red/models/${mid}`,
          addedAt: new Date().toISOString(),
          modelData,
          userDefined: '',
          pathOverride: histOverride?.pathOverride || null,
          updateInfo: {
            newVersions: newVersions.map(v => ({ id: v.id, name: v.name })),
            updatedVersions: [],
          },
        });
        added++;

        // Rate limit: 200ms between API calls
        await new Promise(r => setTimeout(r, 200));
      } catch {}
    }

    if (added > 0) {
      saveQueue(q);
      console.log(`[civitai] Auto-update found ${added} models with new versions`);
    } else {
      console.log('[civitai] Auto-update: all models up to date');
    }

    // Save last check time
    cfg.lastAutoUpdate = now.toISOString();
    saveConfig(cfg);
  }

  // Run auto-update check on startup (delayed) and every 6 hours
  setTimeout(runAutoUpdateCheck, 60000);
  setInterval(runAutoUpdateCheck, 6 * 60 * 60 * 1000);

  // ─── Download Scheduler ────────────────────────────────────────────────

  router.get('/download-scheduler', (req, res) => {
    const sched = loadScheduler();
    const allowed = { hf: isDownloadAllowed('hf'), civ: isDownloadAllowed('civ') };
    res.json({ ...sched, allowed });
  });

  router.put('/download-scheduler/:source', (req, res) => {
    const { source } = req.params;
    if (!['hf', 'civ'].includes(source)) return res.status(400).json({ error: 'source must be hf or civ' });
    const sched = loadScheduler();
    const { mode, manualState, schedule } = req.body;
    const prevManual = sched[source].manualState;
    if (mode !== undefined) sched[source].mode = mode;
    if (manualState !== undefined) sched[source].manualState = manualState;
    if (schedule !== undefined) sched[source].schedule = schedule;
    saveScheduler(sched);
    // #3 Also SIGSTOP/SIGCONT the already-running downloads (not just gate new starts).
    if (manualState !== undefined && manualState !== prevManual) {
      signalActiveDownloads(source, manualState === 'paused' ? 'SIGSTOP' : 'SIGCONT');
    }
    res.json({ ok: true, allowed: isDownloadAllowed(source) });
  });

  return router;
}
