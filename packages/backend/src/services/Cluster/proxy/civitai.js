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
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, renameSync, unlinkSync, copyFileSync, rmdirSync } from 'fs';
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

/**
 * Kill a download for real: the transient scope is the whole cgroup, so stopping it takes
 * the wrapper AND curl together. Signalling the tracked pid alone only kills the wrapper and
 * leaves curl orphaned, still writing, and no longer reapable.
 *
 * `systemctl stop foo` resolves to foo.service -- the .scope suffix is mandatory, and its
 * absence is why an earlier version of this failed silently into an empty catch.
 *
 * Returns true if anything is still alive afterwards.
 */
function killDownloadProcs(dl) {
  if (!dl) return false;
  if (dl.scope) {
    const unit = String(dl.scope).endsWith('.scope') ? String(dl.scope) : `${dl.scope}.scope`;
    try { execSync(`systemctl stop ${unit}`, { timeout: 15000, stdio: 'ignore' }); } catch {}
  }
  if (!dl.pid) return false;
  // Negative pid = the process group, which catches the child curl for entries recorded
  // before scopes were stored.
  try { process.kill(-dl.pid, 'SIGTERM'); } catch {}
  try { process.kill(dl.pid, 'SIGTERM'); } catch {}
  let alive = false;
  try { process.kill(dl.pid, 0); alive = true; } catch { alive = false; }
  if (alive) {
    try { process.kill(-dl.pid, 'SIGKILL'); } catch {}
    try { process.kill(dl.pid, 'SIGKILL'); } catch {}
    try { process.kill(dl.pid, 0); alive = true; } catch { alive = false; }
  }
  return alive;
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
  // Base-model families that ship as a single-file DiT/UNet and belong in
  // diffusion-models/, NOT checkpoints/.  CivitAI declares these as type
  // "Checkpoint" exactly like an SDXL pipeline, so the declared type alone
  // routes them wrong.  Matched case-insensitively as a PREFIX of the
  // version's baseModel ("Flux" covers "Flux.1 D", "Flux.2 Klein 9B"; "Krea"
  // covers "Krea 2").  Deliberately NOT listed, so they stay in checkpoints/:
  // SD 1.5, SD 2.x, SDXL 1.0, SD 3.x, Pony, Illustrious, NoobAI.
  diffusionBaseModels: [
    'Flux', 'Krea', 'Chroma', 'Flex', 'Lumina',
    'Wan Video', 'Hunyuan', 'LTXV', 'MiniMax',
    'ZImage', 'HiDream', 'Qwen', 'CogVideo', 'Mochi', 'Anima',
  ],
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
        diffusionBaseModels: Array.isArray(saved.diffusionBaseModels)
          ? saved.diffusionBaseModels
          : DEFAULT_CONFIG.diffusionBaseModels,
        typeTemplates: { ...DEFAULT_CONFIG.typeTemplates, ...(saved.typeTemplates || {}) },
      };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_PATH, cfg);
}

// ─── Example-image selection ───────────────────────────────────────────────
// Civitai serves the SAME image under different URLs in the version's model-card list and in
// the /images gallery (same UUID path segment, different filename: ".../<uuid>/original=true/
// 141593346.mp4" vs ".../<uuid>/original=true/<uuid>.mp4"), so de-duplicating by URL never
// matched and a showcase image could be saved twice. Key on the UUID instead.
function civImageKey(img) {
  const u = String(img?.url || '');
  const m = u.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
  return m ? m[1].toLowerCase() : (img?.id != null ? `id:${img.id}` : u);
}

/**
 * The images the downloader saves for a version, in order, per cfg.imageSource:
 * 'model-card' | 'gallery' | 'model-card-first' (fill from gallery) | 'gallery-first'.
 * Returns { images, modelCard, gallery } where each image carries `_from`.
 */
async function selectVersionImages(version, cfg, headers) {
  const imageCount = cfg.imageCount || 10;
  const imageSource = cfg.imageSource || 'model-card-first';
  const modelCard = (version?.images || []).filter((i) => i.url).map((i) => ({ ...i, _from: 'model-card' }));
  let gallery = [];
  if (imageSource !== 'model-card') {
    // Over-fetch: gallery entries that duplicate model-card images are dropped below, and a
    // limit of exactly imageCount then fell short of filling the remainder.
    const limit = Math.min(100, imageCount + modelCard.length + 10);
    try {
      const r = await fetch(`https://civitai.com/api/v1/images?modelVersionId=${version.id}&limit=${limit}&nsfw=true`, { headers });
      if (r.ok) gallery = ((await r.json()).items || []).filter((i) => i.url).map((i) => ({ ...i, _from: 'gallery' }));
      else console.warn(`[civitai] gallery fetch for version ${version.id}: HTTP ${r.status}`);
    } catch (e) {
      console.warn(`[civitai] gallery fetch for version ${version.id} failed: ${e?.message || e}`);
    }
  }
  const primary = (imageSource === 'gallery' || imageSource === 'gallery-first') ? gallery : modelCard;
  const secondary = imageSource === 'model-card-first' ? gallery : imageSource === 'gallery-first' ? modelCard : [];
  const seen = new Set();
  const images = [];
  for (const img of [...primary, ...secondary]) {
    if (images.length >= imageCount) break;
    const k = civImageKey(img);
    if (seen.has(k)) continue;
    seen.add(k);
    images.push(img);
  }
  return { images, modelCard, gallery };
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
 * Family override: a single-file DiT finetune belongs in diffusion-models/, but
 * CivitAI declares it type "Checkpoint" exactly like an SDXL pipeline.
 *
 * Fires ONLY when the declared type already resolved to 'checkpoints' — a Krea 2
 * LORA stays in loras/, a Flux VAE stays in vae/.  Returns null otherwise so the
 * caller falls through to the declared type unchanged.
 */
/**
 * CivitAI labels every FILE with its own role: 'Model', 'Diffusion Model', 'Text Encoder',
 * 'VAE'. A single version often bundles all three (most Anima checkpoints ship the model,
 * a `_txt` text encoder and qwen_image_vae together). Routing used to look only at the
 * version, so the encoder and VAE followed the model into checkpoints/. An explicit
 * non-'Model' label is authoritative; 'Model' (or no label) defers to the other rules.
 */
const FILE_TYPE_FOLDERS = {
  'vae': 'vae',
  'text encoder': 'text-encoders',
  'textencoder': 'text-encoders',
  'diffusion model': 'diffusion-models',
};
function componentFromFileType(file) {
  const t = String(file?.type || '').trim().toLowerCase();
  return FILE_TYPE_FOLDERS[t] || null;
}

function detectDiffusionFamily(baseModel, declaredFolder, cfg) {
  if (declaredFolder !== 'checkpoints') return null;
  const bm = String(baseModel || '').trim().toLowerCase();
  if (!bm) return null;
  const families = cfg?.diffusionBaseModels || DEFAULT_CONFIG.diffusionBaseModels;
  for (const fam of families) {
    if (bm.startsWith(String(fam).trim().toLowerCase())) return 'diffusion-models';
  }
  return null;
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

export function getBasePath() {
  try {
    const fmCfg = JSON.parse(readFileSync(join(DATA_DIR, 'file-manager.json'), 'utf8'));
    return fmCfg.tabs?.['image-gen']?.basePath || '/ai-assets/imagegen';
  } catch {}
  return '/ai-assets/imagegen';
}

// ─── Download History ────────────────────────────────────────────────────────
// Each entry: { modelId, modelName, modelType, versionId, versionName, baseModel,
//               creator, downloadedAt, source ('proxlab'|'synced'), pageUrl }

export function loadHistory() {
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
  if (Array.isArray(extra.downloadedFiles) && extra.downloadedFiles.length) {
    // The names the downloader ACTUALLY wrote. Re-deriving them below was a third
    // independent derivation of the same path, and it drifted the moment the downloader
    // started disambiguating same-named files: every file in the version got recorded
    // under one bare name that existed nowhere on disk, so check-existing reported the
    // model missing, the badge stayed dark, and the history looked like the files had
    // overwritten each other. Never re-derive a path that has already been decided.
    const basePath = getBasePath();
    locatedFiles = extra.downloadedFiles.map((d) => ({
      name: d.name,
      currentPath: d.path,
      indexPath: String(d.path).replace(basePath, ''),
    }));
  } else if (extra.targetDir && filesArray) {
    const basePath = getBasePath();
    const override = extra.fileNameOverride;
    // Sanitised the same way the downloader sanitises it, or this fallback records a name
    // that was never written — check-existing then reports the model missing.
    const _sep = (loadConfig().separator) || '-';
    locatedFiles = filesArray.map(f => {
      let onDiskName = f.name;
      if (override) {
        const _dot = f.name.lastIndexOf('.');
        const ext = _dot > 0 ? f.name.substring(_dot) : '';
        onDiskName = sanitizeNameOverride(override, _sep) + ext;
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
 * Move a model file and every sidecar that belongs to it (previews, .json, metadata)
 * from one path to another.
 *
 * This is the per-move body of POST /rename lifted to module scope: the downloader needs
 * exactly the same behaviour, and a second copy of it would drift the moment either side
 * learned about a new sidecar suffix. Never throws - returns what happened.
 */
function moveModelFamily(fromPath, toPath) {
  const moved = []; const deleted = []; const errors = [];
  const fromDir = fromPath.substring(0, fromPath.lastIndexOf('/'));
  const fromBase = fromPath.split('/').pop().replace(/\.[^.]+$/, '');
  const toDir = toPath.substring(0, toPath.lastIndexOf('/'));
  const toBase = toPath.split('/').pop().replace(/\.[^.]+$/, '');

  mkdirSync(toDir, { recursive: true });

  // Same rule the renamer uses: the model file plus anything sharing its base name, and
  // NOT another model that merely starts with the same prefix.
  let relatedFiles = [];
  try {
    relatedFiles = readdirSync(fromDir).filter((name) =>
      name === fromBase || name.startsWith(fromBase + '.') || name.startsWith(fromBase + '_'));
  } catch {}

  for (const relFile of relatedFiles) {
    const relFrom = `${fromDir}/${relFile}`;
    // 🛑 These used to be DELETED here, on the assumption that a re-download would
    // regenerate them. That only holds for POST /rename with downloadMeta; the library
    // manager's drag-and-drop does no download, so a plain move destroyed the CivitAI
    // metadata — including the trigger words the inspector reads. Move them like any other
    // sidecar instead; /rename's downloadMeta overwrites them afterwards either way.
    const relTo = `${toDir}/${toBase}${relFile.substring(fromBase.length)}`;
    if (relFrom === relTo) { moved.push({ from: relFrom, to: relTo }); continue; }
    try {
      renameSync(relFrom, relTo);
      moved.push({ from: relFrom, to: relTo });
    } catch {
      // rename() fails across filesystems; copy+unlink is the portable fallback.
      try {
        copyFileSync(relFrom, relTo);
        unlinkSync(relFrom);
        moved.push({ from: relFrom, to: relTo });
      } catch (err2) {
        errors.push({ from: relFrom, to: relTo, error: err2.message });
      }
    }
  }
  return { moved, deleted, errors };
}

/**
 * Apply a batch of model moves and re-point history at the new locations.
 *
 * Exported because the model-library manager performs the same operation: every move or
 * rename it makes must leave history tracking the file, and a second implementation of that
 * would drift from this one. POST /rename is now a thin wrapper over it.
 *
 * @param moves  [{ from, to }] absolute paths
 * @param opts   { modelId, versionId, pathOverride, fixPerms }  fixPerms is injected so this
 *               stays free of the router's ssh closure.
 */
export function applyModelMoves(moves, opts = {}) {
  const { modelId = null, versionId = null, pathOverride = null, fixPerms = null } = opts;
  const basePath = getBasePath();
  const moved = []; const deleted = []; const errors = [];

  for (const m of moves || []) {
    const r = moveModelFamily(m.from, m.to);
    moved.push(...r.moved);
    deleted.push(...r.deleted);
    errors.push(...r.errors);
  }

  if (fixPerms) {
    for (const dir of new Set(moved.map((m) => m.to.substring(0, m.to.lastIndexOf('/'))))) {
      try { fixPerms(dir); } catch {}
    }
  }

  // Drop source directories the move emptied, so the tree does not fill with husks.
  for (const dir of new Set((moves || []).map((m) => m.from.substring(0, m.from.lastIndexOf('/'))))) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {}
  }

  if (modelId && moved.length) {
    const h = loadHistory();
    const entry = versionId
      ? h.items.find((i) => String(i.modelId) === String(modelId) && String(i.versionId) === String(versionId))
      : h.items.find((i) => String(i.modelId) === String(modelId));
    if (entry) {
      const newDir = moved[0].to.substring(0, moved[0].to.lastIndexOf('/'));
      const newBaseName = moved[0].to.split('/').pop().replace(/\.[^.]+$/, '');
      entry.targetDir = newDir;
      entry.currentDir = newDir;
      if (pathOverride) entry.pathOverride = pathOverride;
      entry.fileNameOverride = newBaseName;
      // Only the ON-DISK locations move. `entry.files` is upstream CivitAI metadata (real
      // sizeKB + hashes) and is NOT affected by a rename — overwriting it with stubs, as
      // this used to, destroyed the sizes and hashes every other feature reads.
      // MODEL files only, matching addToHistory's semantics — it builds locatedFiles from
      // the downloaded model files, not from previews and sidecars. Recording all twelve
      // moved files here made one LoRA look like twelve entries to everything that counts
      // or iterates locatedFiles.
      const movedModels = moved.filter((m) => /\.(safetensors|ckpt|gguf|pt|bin|pth|onnx)$/i.test(m.to));
      entry.locatedFiles = (movedModels.length ? movedModels : moved).map((m) => ({
        name: m.to.split('/').pop(),
        currentPath: m.to,
        indexPath: m.to.replace(basePath, ''),
      }));
      const idx = h.items.indexOf(entry);
      if (idx > 0) { h.items.splice(idx, 1); h.items.unshift(entry); }
      saveHistory(h);
    }
  }
  return { moved, deleted, errors };
}

/**
 * Find a copy of THIS EXACT version+file already on disk under a different name or folder,
 * so a re-download with a new name can MOVE it instead of fetching the same bytes again.
 *
 * Identity is (modelId, versionId) out of history, and the candidate paths come from
 * `locatedFiles` - the paths the downloader already DECIDED and recorded. Re-deriving them
 * here would be a third independent derivation of the same path, which is precisely how
 * history and disk drifted apart before.
 *
 * Returns null unless EXACTLY ONE candidate matches by size: a version routinely ships
 * several files of near-identical size (fp8 / bf16 / GGUF quants), and moving the wrong one
 * would be worse than the duplicate this is trying to avoid.
 */
function findExistingVersionCopy(modelId, versionId, file, targetFile) {
  const expected = (file?.sizeKB || 0) * 1024;
  if (!expected) return null;
  const h = loadHistory();
  const entry = h.items.find((i) =>
    String(i.modelId) === String(modelId) && String(i.versionId) === String(versionId));
  if (!entry) return null;

  const seen = new Set();
  const candidates = [];
  for (const lf of (entry.locatedFiles || [])) {
    const p = lf?.currentPath;
    if (!p || p === targetFile || seen.has(p)) continue;
    seen.add(p);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    // 1% tolerance: the same file, not merely a similar one.
    if (Math.abs(st.size - expected) > expected * 0.01) continue;
    candidates.push(p);
  }
  return candidates.length === 1 ? candidates[0] : null;
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

/**
 * Clean a USER-TYPED filename override the same way applyTemplate() cleans a variable's
 * value: whitespace and slashes become the configured separator, and characters the
 * filesystem will not take are dropped.
 *
 * Without this the typed name was the ONE name-producing path that skipped sanitising, so a
 * library configured with '_' quietly collected filenames containing spaces — and the live
 * preview correctly showed them, which is how it was spotted.
 *
 * Case is deliberately NOT transformed. applyTemplate applies caseMode to values it
 * substitutes, but this string was typed deliberately and re-casing it would be overreach.
 */
function sanitizeNameOverride(raw, separator = '-') {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  // A '/' would silently create phantom subdirectories — same reason applyTemplate folds it.
  s = s.replace(/\s+/g, separator).replace(/\//g, separator);
  s = s.replace(/[:"|?*\\<>]/g, '');
  if (separator !== ' ') {
    const esc = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`${esc}{2,}`, 'g'), separator);
  }
  return s;
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
 * Build a filename from a TEMPLATE and a HISTORY ROW.
 *
 * The library manager renames files that are already on disk, offline — there is no live
 * CivitAI response to hand to resolveVars(). This adapts a history row into the same shapes
 * resolveVars expects and then runs the downloader's own applyTemplate, so a name produced
 * here is byte-identical to one the downloader would produce. Deriving names separately is
 * exactly how the live preview and the actual download drifted apart before.
 *
 * Returns the base name WITHOUT extension; the caller re-attaches the real one.
 */
export function resolveTemplateName(template, histEntry, separator = '-', caseMode = 'standard') {
  const cfg = loadConfig();
  const file = (histEntry.files || [])[0]
    || { name: `${histEntry.fileNameOverride || 'model'}.safetensors`, metadata: {} };
  const model = {
    id: histEntry.modelId,
    name: histEntry.modelName || '',
    type: histEntry.modelType || '',
    creator: { username: histEntry.creator || '' },
    tags: histEntry.primaryTag ? [histEntry.primaryTag] : [],
  };
  const version = {
    id: histEntry.versionId,
    name: histEntry.versionName || '',
    baseModel: histEntry.baseModel || '',
    createdAt: histEntry.downloadedAt || '',
    files: histEntry.files || [],
  };
  const vars = resolveVars(model, version, file, cfg);
  const resolved = applyTemplate(template, vars, separator, caseMode);
  const lastSlash = resolved.lastIndexOf('/');
  let name = lastSlash >= 0 ? resolved.substring(lastSlash + 1) : resolved;
  // The template may carry $EXTENSION; the caller owns the real extension.
  name = name.replace(/\$EXTENSION/g, '').replace(/\.[^.]+$/, '').replace(/\.$/, '');
  return name;
}

export { loadConfig as loadCivitaiConfig };

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
  // --fail-with-body, not --fail. Both make a 4xx abort (without either, curl writes the error
  // body to .part and exits 0, so `&& mv` renames a few KB of JSON into place as if it were the
  // model). But plain --fail DISCARDS the body, and CivitAI puts the actual reason in it:
  //   {"error":"Unauthorized","message":"The creator of this asset has disabled downloads..."}
  // Throwing that away is what turned a precise, actionable refusal into "download keeps dying
  // immediately" five retries later. Keep the body; the reconciler reads it and reports it.
  // --retry still covers transient 5xx/429.
  const args = ['-L', '--fail-with-body', '-o', partPath, '--retry', '3', '--retry-delay', '5'];
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
  // The scope name matters as much as the pid: realPid is the outer bash, and curl is its
  // child inside this transient cgroup. Signalling the pid alone leaves curl running.
  return { pid: realPid, scope: scopeName, log: logPath };
}

/**
 * Why did this download die? Reads what curl actually left behind.
 *
 * Two sources, in order of usefulness:
 *   1. the .part file — with --fail-with-body this holds the SERVER's JSON on a 4xx, e.g.
 *      {"error":"Unauthorized","message":"The creator of this asset has disabled downloads"}
 *   2. the curl log — "curl: (22) The requested URL returned error: 401"
 *
 * Returns { permanent, http, message } or null when nothing conclusive is on disk.
 * `permanent` marks failures that retrying cannot fix: the answer is "no", not "not yet".
 */
function diagnoseDownloadFailure(dl) {
  let http = 0, message = '';
  // The body: only ever a few hundred bytes for an error. A real model part is huge, so a
  // size cap keeps us from reading a partial safetensors as if it were an error document.
  try {
    const p = (dl.targetFile || '') + '.part';
    if (p && existsSync(p) && statSync(p).size > 0 && statSync(p).size < 8192) {
      const raw = readFileSync(p, 'utf8').trim();
      if (raw.startsWith('{')) {
        const j = JSON.parse(raw);
        message = j.message || j.error || '';
      } else if (raw) {
        message = raw.slice(0, 200);
      }
    }
  } catch { /* not JSON, or unreadable — fall through to the log */ }
  try {
    if (dl.logFile && existsSync(dl.logFile)) {
      const log = readFileSync(dl.logFile, 'utf8');
      const m = /The requested URL returned error:\s*(\d{3})/.exec(log);
      if (m) http = parseInt(m[1], 10);
    }
  } catch { /* no log */ }
  if (!http && !message) return null;
  // 401/403/404/410 are verdicts, not hiccups. 5xx and 429 are worth retrying.
  const permanent = [401, 402, 403, 404, 410].includes(http) || /disabled downloads|early access|purchase|unauthorized/i.test(message);
  return { permanent, http, message };
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
    const sp = spawnCurl(dl.dlUrl, dl.targetFile, null);
    if (sp) {
      dl.pid = sp.pid;
      dl.scope = sp.scope;
      dl.logFile = sp.log;
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
export function fixPermissions(targetDir, _sshService) {
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
/**
 * Derive a human-meaningful discriminator for files that would otherwise share a name.
 * Preference order, best first:
 *   1. the part of the ORIGINAL upstream filenames that actually differs
 *      (krea2_identity_edit_v1_2{,_r128,_r64} -> '', 'r128', 'r64')
 *   2. the metadata fields that differ within the group (fp16 / fp8 / nf4, pruned / full)
 *   3. the CivitAI file id -- a meaningless number, and the last resort
 * Returns one string per file, aligned with `group`; '' means "needs nothing".
 */
function deriveAutoSuffixes(group) {
  const clean = (s) => String(s || '')
    .replace(/^[_\-. ]+/, '')
    .replace(/[_\-. ]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_');

  // 1 ── differing tail of the upstream names
  const stems = group.map((f) => String(f.name || '').replace(/\.[^.]+$/, ''));
  let pre = 0;
  if (stems.length > 1) {
    const min = Math.min(...stems.map((s) => s.length));
    while (pre < min && stems.every((s) => s[pre] === stems[0][pre])) pre++;
  }
  let out = stems.map((s) => clean(s.substring(pre)));
  if (new Set(out).size === group.length) return out;

  // 2 ── differing metadata
  const fields = ['fp', 'size', 'format'].filter((k) => {
    const vals = new Set(group.map((f) => String(f.metadata?.[k] ?? '')));
    return vals.size > 1;
  });
  if (fields.length) {
    out = group.map((f) => clean(fields.map((k) => f.metadata?.[k]).filter(Boolean).join('-')));
    if (new Set(out).size === group.length) return out;
  }

  // 3 ── file id
  return group.map((f) => String(f.id));
}

/**
 * Resolve the final on-disk name for every file in a version.
 *
 * `autoDisambiguate` false means: apply ONLY what the caller asked for and never invent a
 * suffix. The UI passes false once it has seeded its per-file suffix boxes, so that every
 * component of the previewed name exists in a field the user can actually edit -- silently
 * appending a tag the Filename box could not remove is exactly the bug this replaced.
 * Collisions that remain are reported via `outCollisions` instead of being papered over.
 */
function resolveVersionFileNames(files, baseNameFor, fnOverride, fileOpts, selectedKeys, opts) {
  const { autoDisambiguate = true, outAuto = null, outCollisions = null, dirOf = null } = opts || {};
  // Separator for the typed filename override. Callers pass cfg.separator. Per-TYPE
  // separator overrides (cfg.typeTemplates[type].separator) are not threaded here because
  // the type is only known inside baseNameFor(); every type currently shares the global
  // value, and a divergence would cost a cosmetic inconsistency in the typed name, not a
  // wrong path.
  const _overrideSep = (opts && opts.separator) || '-';
  const keyOf = (f) => String(f.id != null ? f.id : f.name);
  const splitExt = (n) => {
    const d = n.lastIndexOf('.');
    return d > 0 ? [n.substring(0, d), n.substring(d)] : [n, ''];
  };
  const names = new Map();

  for (const f of files || []) {
    const o = (fileOpts && (fileOpts[keyOf(f)] || fileOpts[String(f.name)])) || {};
    let name;
    if (o.noRename) {
      name = f.name;                                  // upstream name, verbatim
    } else {
      name = baseNameFor(f);
      if (fnOverride) {
        const [, e] = splitExt(name);
        // Same treatment the template gives every other name — see sanitizeNameOverride().
        const _clean = sanitizeNameOverride(fnOverride, _overrideSep);
        if (_clean) name = _clean + e;
      }
    }
    if (o.suffix) {
      const [b, e] = splitExt(name);
      const sfx = String(o.suffix).trim()
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^[_-]+|[_-]+$/g, '');
      if (sfx) name = `${b}-${sfx}${e}`;
    }
    names.set(keyOf(f), name);
  }

  // A collision only matters between files that are ACTUALLY BEING WRITTEN. Counting every
  // file in the version meant ticking one of three same-named files still looked like a
  // three-way conflict. selectedKeys null = all files.
  const isSel = (f) => !selectedKeys || selectedKeys.has(keyOf(f));
  const counts = {};
  for (const f of files || []) {
    if (!isSel(f)) continue;
    // Same name in DIFFERENT folders is not a clash (model / text encoder / VAE of one
    // version routinely share a name and land in checkpoints/, text-encoders/, vae/).
    const n = (dirOf ? `${dirOf(keyOf(f)) || ''}/` : '') + names.get(keyOf(f));
    counts[n] = (counts[n] || 0) + 1;
  }

  const groups = new Map();
  for (const f of files || []) {
    if (!isSel(f)) continue;
    const n = (dirOf ? `${dirOf(keyOf(f)) || ''}/` : '') + names.get(keyOf(f));
    if (counts[n] > 1) {
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(f);
    }
  }

  for (const [n, group] of groups) {
    const suffixes = deriveAutoSuffixes(group);
    if (outAuto) group.forEach((f, i) => outAuto.set(keyOf(f), suffixes[i]));
    if (outCollisions) outCollisions.push(group.map(keyOf));
    if (!autoDisambiguate) continue;                  // report only; never invent
    // n may carry the destination dir (see dirOf); the name itself is the file's own.
    const [base, ext] = splitExt(names.get(keyOf(group[0])));
    group.forEach((f, i) => {
      names.set(keyOf(f), suffixes[i] ? `${base}-${suffixes[i]}${ext}` : `${base}${ext}`);
    });
  }
  return names;
}

function resolveTargetPath(model, version, file, cfg, pathOverride, userDefined, extensionOverride, componentOverride) {
    const vars = resolveVars(model, version, file, cfg);
    if (userDefined) vars['$USER_DEFINED'] = userDefined;
    if (extensionOverride) vars['$EXTENSION_OVERRIDE'] = extensionOverride;
    // Use contextual component override if provided, else per-file detection
    // A file's own CivitAI type beats the version-level guess: a VAE packed inside a
    // checkpoint version is still a VAE.
    const detectedComponent = componentFromFileType(file) || componentOverride || detectComponentType(version?.name, file?.name);
    // Component detection wins; family override only rescues a declared "Checkpoint"
    // that is really a single-file DiT (Krea 2, Flux, Wan, ...).
    const _aio = /(^|[^a-z])(aio|all.?in.?one)([^a-z]|$)/i.test(`${version?.name || ''} ${file?.name || ''}`);
    const familyFolder = _aio ? null : detectDiffusionFamily(version?.baseModel, vars['$TYPE_FOLDER'], cfg);
    const typeFolder = detectedComponent || familyFolder || vars['$TYPE_FOLDER'] || 'other';
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

  // ─── GET /preview-images?versionId= — the images a download of this version will save ──
  router.get('/preview-images', async (req, res) => {
    const versionId = String(req.query.versionId || '');
    if (!/^\d+$/.test(versionId)) return res.status(400).json({ error: 'versionId required' });
    const cfg = loadConfig();
    const headers = {};
    const tok = getCivitaiToken();
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    try {
      const vr = await fetch(`https://civitai.com/api/v1/model-versions/${versionId}`, { headers });
      if (!vr.ok) return res.status(502).json({ error: `CivitAI API: ${vr.status}` });
      const version = await vr.json();
      const sel = await selectVersionImages(version, cfg, headers);
      res.json({
        imageSource: cfg.imageSource || 'model-card-first',
        imageCount: cfg.imageCount || 10,
        modelCardCount: sel.modelCard.length,
        galleryCount: sel.gallery.length,
        images: sel.images.map((i) => ({ url: i.url, type: i.type || 'image', from: i._from, nsfwLevel: i.nsfwLevel })),
      });
    } catch (e) {
      console.warn(`[civitai] preview-images ${versionId} failed: ${e?.message || e}`);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

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
    const { modelId, versionId, modelType, modelName, versionName, baseModel, creatorName, primaryTag, tags, files, pathOverride, userDefined, fileNameOverride, fileOpts, fileIds, autoDisambiguate } = req.body;
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
    // The template's own output for the first file, BEFORE any per-file suffix or
    // auto-disambiguation tag. This — not the decorated newName — is what the UI's
    // Filename box must be seeded with, or the tag becomes part of the override the
    // user sends back and can never be deleted.
    let baseFileName = '';
    // The preview must disambiguate over exactly what the download will write, or the
    // name shown is not the name that lands on disk.
    const selectedKeys = (Array.isArray(fileIds) && fileIds.length)
      ? new Set(fileIds.map(String))
      : null;
    // Suffixes the UI seeds its per-file boxes with, and any collision that survives the
    // user's own choices -- surfaced so the UI can warn instead of silently renaming.
    const _autoSuffixes = new Map();
    const _collisions = [];
    const _finalNames = resolveVersionFileNames(files, (f) => {
      const fake = { id: f.id, name: f.name, type: f.type, sizeKB: f.sizeKB || 0, metadata: f.metadata || {}, hashes: {} };
      const r = resolveTargetPath(model, version, fake, cfg, effectiveOverride, userDefined || '');
      lastTypeFolder = r.typeFolder || lastTypeFolder;
      lastFolderPart = r.folderPart || '';
      _dirs.set(String(f.id != null ? f.id : f.name), r.targetDir);
      if (!baseFileName) baseFileName = r.fileName;
      return r.fileName;
    }, effectiveFnOverride, fileOpts, selectedKeys, {
      separator: cfg.separator || '-',
      autoDisambiguate: autoDisambiguate !== false,
      outAuto: _autoSuffixes,
      outCollisions: _collisions,
      dirOf: (k) => _dirs.get(k),
    });

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
      // Undecorated template name for seeding the Filename box (see baseFileName above).
      baseFileName,
      // Per-file discriminators for files that would otherwise share a name. The UI seeds
      // its editable suffix boxes with these so every part of the previewed name lives in
      // a field the user can change or clear.
      autoSuffixes: Object.fromEntries(_autoSuffixes),
      // Groups of file ids that STILL resolve to the same name. Non-empty means the user
      // cleared the discriminators; warn, do not silently rename.
      collisions: _collisions,
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
        // ONE naming pass, shared with the downloader via resolveVersionFileNames, so the
        // two cannot drift. This endpoint used to keep its OWN copy of the collision rule
        // and they did drift the moment the rule changed. We cannot know which files were
        // selected at download time, so accept EITHER name: the undecorated one (file
        // fetched on its own, no collision) or the disambiguated one (whole version).
        const _keyOf = (f) => String(f.id != null ? f.id : f.name);
        const _dirs = new Map();
        const _mk = (f) => {
          const r = resolveTargetPath(model, version, f, cfg, effectiveOverride, '', null);
          _dirs.set(_keyOf(f), r.targetDir);
          return r.fileName;
        };
        const _sepOpt = { separator: cfg.separator || '-', dirOf: (k) => _dirs.get(k) };
        const _namesAll = resolveVersionFileNames(v.files, _mk, fnOverride, null, null, _sepOpt);
        const _namesBare = resolveVersionFileNames(v.files, _mk, fnOverride, null, new Set(), _sepOpt);

        for (const file of v.files) {
          try {
            const _k = _keyOf(file);
            const targetDir = _dirs.get(_k);
            const fileName = _namesBare.get(_k) || file.name;
            const fullPath = `${targetDir}/${fileName}`;

            const _cands = [];
            for (const n of [_namesBare.get(_k), _namesAll.get(_k), file.name]) {
              if (n && !_cands.includes(n)) _cands.push(n);
            }
            const _hit = _cands
              .map((n) => ({ n, p: `${targetDir}/${n}` }))
              .find((c) => existsSync(c.p));

            if (_hit) {
              const st = statSync(_hit.p);
              existingFiles.push({ name: _hit.n, path: _hit.p, size: st.size });
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
      const _dlCollisions = [];
      const _dlNames = resolveVersionFileNames(version.files, (f) => {
        const r = resolveTargetPath(model, version, f, cfg, effectiveOverride, userDefined, extensionOverride, versionComponent);
        _dlDirs.set(String(f.id != null ? f.id : f.name), r.targetDir);
        return r.fileName;
      }, fileNameOverride, fileOpts, (Array.isArray(fileIds) && fileIds.length)
        ? new Set(fileIds.map(String))
        : null, { autoDisambiguate: req.body.autoDisambiguate !== false, outCollisions: _dlCollisions,
                  separator: cfg.separator || '-', dirOf: (k) => _dlDirs.get(k) });

      // With auto-disambiguation off the user owns every part of the name, so two selected
      // files CAN now resolve to the same path. Writing both is precisely what corrupted
      // downloads before this guard existed: N files interleaving into ONE .part, each
      // deleting the previous one's, progress reading past 100%. Refuse loudly instead.
      if (req.body.autoDisambiguate === false && _dlCollisions.length) {
        const _sel = (Array.isArray(fileIds) && fileIds.length) ? new Set(fileIds.map(String)) : null;
        const _clash = _dlCollisions
          .map((g) => g.filter((k) => !_sel || _sel.has(k)))
          .filter((g) => g.length > 1);
        if (_clash.length) {
          return res.status(409).json({
            error: 'Files would overwrite each other',
            detail: 'These selected files resolve to the same filename. Give them different '
              + 'suffixes, turn renaming off for some, or deselect all but one.',
            collisions: _clash.map((g) => ({ fileIds: g, name: _dlNames.get(g[0]) })),
          });
        }
      }

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

          // Same version already on disk under a different name or folder? MOVE it.
          // The check above only asks whether the NEW path exists, so renaming a model
          // always missed and re-fetched the identical bytes - one LoRA ended up as three
          // 57 MB copies. History is keyed on modelId+versionId, so the new row then
          // overwrote the old one and the leftover copy became untracked.
          if (conflictMode !== 'overwrite') {
            const _existing = findExistingVersionCopy(modelId, version.id, file, targetFile);
            if (_existing) {
              const _mv = moveModelFamily(_existing, targetFile);
              if (!_mv.errors.length && existsSync(targetFile)) {
                fixPermissions(targetDir, sshService);
                console.log(`[civitai] Relocated instead of re-downloading: ${_existing} -> ${targetFile}`);
                // Same shape the downloader pushes, so addToHistory records the new
                // location and the old path stops being referenced.
                queued.push({ type: 'model', fileName, targetDir, relocated: true, from: _existing });
                continue;
              }
              if (_mv.errors.length) {
                console.error('[civitai] Relocate failed, downloading instead:', _mv.errors);
              }
            }
          }

          mkdirSync(targetDir, { recursive: true });

          // Add token to download URL if needed
          let dlUrl = file.downloadUrl;
          if (civitaiToken && !dlUrl.includes('token=')) {
            dlUrl += (dlUrl.includes('?') ? '&' : '?') + `token=${civitaiToken}`;
          }

          const _sp = downloadFile(dlUrl, targetFile, null, cfg);
          const pid = _sp?.pid || null;

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
            scope: _sp?.scope || null,
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
      // Sanitised exactly like the model filename. Missing this made the sidecars stop
      // sharing the model's base name the moment the model name was cleaned, and
      // moveModelFamily() matches on that base name — the previews would be left behind.
      if (fileNameOverride) metaBaseName = sanitizeNameOverride(fileNameOverride, metaSep);
      const metaDir = `${basePath}/${metaTypeFolder}/${metaFolder}`;

      const modelType = model.type || 'Unknown';
      addToHistory(model, version, 'proxlab', {
        pathOverride: effectiveOverride,
        targetDir: metaDir,
        fileNameOverride: fileNameOverride || extensionOverride || null,
        // Only the files this download actually wrote, under the names it used. Previously
        // every file in the version was recorded, all under one re-derived name.
        downloadedFiles: queued
          .filter((q) => q.type === 'model' && q.fileName && q.targetDir)
          .map((q) => ({ name: q.fileName, path: `${q.targetDir}/${q.fileName}` })),
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

          // Model card first / gallery fill etc. — shared with GET /preview-images so the
          // downloader's preview strip shows exactly the images that will be saved.
          const _sel = await selectVersionImages(version, cfg, headers);
          allImages = _sel.images;
          const galleryImages = _sel.gallery;
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
    const gone = q.items.find(i => i.id === req.params.id);
    if (!gone) {
      // Used to answer ok:true for an id that was not present, so a double-delete or a
      // stale id from the UI was indistinguishable from a real removal.
      console.warn(`[civitai] REMOVE queue MISS: id=${req.params.id} not present (${q.items.length} in queue)`);
      return res.status(404).json({ error: 'Queue item not found' });
    }
    q.items = q.items.filter(i => i.id !== req.params.id);
    saveQueue(q);
    // Name what went. Removals were silent, so when a UI bug deleted the wrong review rows
    // on 2026-09-15 nothing on the server recorded WHAT had gone — and with no backup of
    // civitai-queue.json those entries were simply unrecoverable.
    console.log(`[civitai] REMOVED queue item: ${gone.modelData?.name || gone.modelId} (id=${gone.id}, modelId=${gone.modelId}, versionId=${gone.versionId ?? '-'}) — ${q.items.length} left`);
    res.json({ ok: true, queueLength: q.items.length,
      removed: { id: gone.id, modelId: gone.modelId, versionId: gone.versionId ?? null, name: gone.modelData?.name ?? null } });
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
    const q = loadQueue();
    const n = q.items.length;
    // Every row by name, not just a count: this is the one call that can destroy the whole
    // review queue, and a bare total tells you nothing about what to put back.
    for (const i of q.items) {
      console.log(`[civitai] REMOVED queue item (clear): ${i.modelData?.name || i.modelId} (id=${i.id}, modelId=${i.modelId}, versionId=${i.versionId ?? '-'})`);
    }
    saveQueue({ items: [] });
    console.warn(`[civitai] REVIEW QUEUE CLEARED — ${n} item(s) removed`);
    res.json({ ok: true, removed: n });
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
    const gone = r.items.find(i => i.id === req.params.id);
    if (!gone) {
      console.warn(`[civitai] REMOVE renamer MISS: id=${req.params.id} not present (${r.items.length} queued)`);
      return res.status(404).json({ error: 'Renamer item not found' });
    }
    r.items = r.items.filter(i => i.id !== req.params.id);
    saveRenamer(r);
    console.log(`[civitai] REMOVED renamer item: ${gone.fileName || gone.name || gone.id} (id=${gone.id}) — ${r.items.length} left`);
    res.json({ ok: true, queueLength: r.items.length });
  });

  router.post('/renamer/clear', (req, res) => {
    const r = loadRenamer();
    const n = r.items.length;
    for (const i of r.items) {
      console.log(`[civitai] REMOVED renamer item (clear): ${i.fileName || i.name || i.id} (id=${i.id})`);
    }
    saveRenamer({ items: [] });
    console.warn(`[civitai] RENAMER QUEUE CLEARED — ${n} item(s) removed`);
    res.json({ ok: true, removed: n });
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
          // A permanent refusal must not be retried: five spawn/die cycles turn a clear
          // "the creator disabled downloads on this file" into a generic timeout-shaped
          // error, and the real reason was on disk the whole time.
          const why = diagnoseDownloadFailure(dl);
          if (why && why.permanent) {
            killDownloadProcs(dl);
            dl.status = 'failed';
            dl.pid = null;
            dl.scope = null;
            dl.progress = 0;
            dl.error = why.message
              ? `CivitAI refused this file${why.http ? ` (HTTP ${why.http})` : ''}: ${why.message}`
              : `CivitAI refused this file (HTTP ${why.http}) — not retryable`;
            try { const p = dl.targetFile + '.part'; if (existsSync(p) && statSync(p).size < 8192) unlinkSync(p); } catch {}
            console.log(`[civitai-dl] REFUSED: ${dl.fileName} — ${dl.error}`);
            changed = true;
            continue;
          }
          dl._retries = (dl._retries || 0) + 1;
          if (dl._retries >= 5) {
            dl.status = 'failed';
            dl.pid = null;
            dl.progress = currentSize;
            const last = diagnoseDownloadFailure(dl);
            dl.error = last && (last.message || last.http)
              ? `Failed after ${dl._retries} retries — last error${last.http ? ` HTTP ${last.http}` : ''}: ${last.message || 'no message'}`
              : `Failed after ${dl._retries} retries — download keeps dying immediately`;
            console.log(`[civitai-dl] GIVE UP: ${dl.fileName} — ${dl._retries} retries exhausted`);
          } else {
            // "PID dead" is judged from the WRAPPER pid, and curl is its child: the wrapper can
            // exit while curl keeps downloading. Requeueing then spawns a SECOND curl onto the
            // same .part -- two writers, one file. Seen in the wild as REQUEUE lines whose
            // reported progress kept climbing (12.6 GB -> 24.5 GB) between "dead" verdicts.
            // Tear the whole scope down first so the requeue has exactly one writer.
            killDownloadProcs(dl);
            dl.scope = null;
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
    // Stopping must actually stop it. This used to SIGTERM dl.pid -- the OUTER BASH WRAPPER --
    // which leaves curl (its child, in the same transient scope) orphaned and still writing,
    // and then spliced the record out regardless. The reconciler could no longer see the
    // orphan, nothing could stop it again, and on completion its `&& mv` would rename the
    // file into place as a finished download the user had cancelled. Observed: a cancelled
    // 26 GB checkpoint still growing, untracked, requeued curls sharing one .part.
    const stillAlive = killDownloadProcs(dl);
    if (stillAlive) {
      // Keep the record. Something we cannot kill must stay visible and reapable rather than
      // becoming an invisible orphan -- that is the whole bug this replaced.
      dl.error = `Stop requested but PID ${dl.pid} survived SIGKILL`;
      saveDownloads(manifest);
      return res.status(500).json({ error: dl.error, id: dl.id });
    }
    // A cancelled download should not leave its partial behind: it holds the space the user
    // was reclaiming, and a stale .part is what a later attempt would resume onto.
    if (dl.targetFile) {
      try { unlinkSync(`${dl.targetFile}.part`); } catch {}
    }
    manifest.downloads.splice(idx, 1);
    saveDownloads(manifest);
    console.log(`[civitai-dl] STOPPED: ${dl.fileName || dl.id} (scope ${dl.scope || 'n/a'}, pid ${dl.pid || 'n/a'})`);
    res.json({ ok: true });
  });

  /** POST /downloads/clear — Clear completed and failed downloads */
  router.post('/downloads/clear', (req, res) => {
    const manifest = loadDownloads();
    const before = manifest.downloads.length;
    manifest.downloads = manifest.downloads.filter(d => d.status === 'downloading' || d.status === 'pending');
    saveDownloads(manifest);
    console.log(`[civitai-dl] Cleared ${before - manifest.downloads.length} finished/failed row(s) — ${manifest.downloads.length} still active`);
    res.json({ ok: true, removed: before - manifest.downloads.length });
  });

  /** POST /downloads/:id/stop — Stop a download and leave it stopped until forced. */
  router.post('/downloads/:id/stop', (req, res) => {
    const manifest = loadDownloads();
    const dl = manifest.downloads.find(d => d.id === req.params.id);
    if (!dl) return res.status(404).json({ error: 'Not found' });
    // This used to SIGTERM the wrapper pid and set status back to 'pending' -- and 'pending'
    // is exactly what processPendingDownloads() picks up, so the reconciler respawned the
    // download within 5 seconds. Pressing Stop killed the wrapper, orphaned curl, and started
    // a SECOND curl onto the same .part. Observed: a cancelled 26 GB checkpoint still growing.
    // 'stopped' is the status the UI already renders (with a Force-start button); the pump
    // ignores it, so stopped now means stopped.
    const stillAlive = killDownloadProcs(dl);
    console.log(`[civitai-dl] STOP: ${dl.fileName} pid ${dl.pid || 'n/a'} scope ${dl.scope || 'n/a'}`
      + (stillAlive ? ' — PROCESS SURVIVED' : ''));
    if (stillAlive) {
      dl.error = `Stop requested but PID ${dl.pid} survived SIGKILL`;
      saveDownloads(manifest);
      return res.status(500).json({ error: dl.error, id: dl.id });
    }
    dl.status = 'stopped';
    dl.pid = null;
    dl.scope = null;
    dl.error = null;
    dl._deadChecks = 0;
    saveDownloads(manifest);
    res.json({ ok: true, status: 'stopped' });
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
    const sp = spawnCurl(dl.dlUrl, dl.targetFile, null);
    if (sp) {
      dl.pid = sp.pid;
      dl.scope = sp.scope;
      dl.logFile = sp.log;
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
    const h = loadHistory();
    const n = (h.items || []).length;
    // Loudest of the lot on purpose. This is the index the downloader uses to locate an
    // existing copy of a version (findExistingVersionCopy) and to keep re-downloads from
    // duplicating files; wiping it silently makes every later model look like a new one.
    console.warn(`[civitai] DOWNLOAD HISTORY CLEARED — ${n} entr${n === 1 ? 'y' : 'ies'} destroyed; relocation and de-duplication lose their index`);
    saveHistory({ items: [], lastSync: null });
    res.json({ ok: true, removed: n });
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
        // A remembered override whose directory is GONE is a leftover from a config
        // change, not a preference. Adding baseModelMap "Krea 2" -> "Krea-2" left 117
        // history rows pointing at a retired /Krea_2; re-downloading from history
        // recreated that folder and filed the new copy into it. Fall back to the
        // template when the folder the override names no longer exists.
        const _histDir = histEntry?.currentDir || histEntry?.targetDir || null;
        const _histDirAlive = !!(_histDir && existsSync(_histDir));
        if (_histDir && !_histDirAlive) {
          console.log(`[civitai] Ignoring stale path override for model ${mid}: ${_histDir} no longer exists`);
        }
        const effectivePath = (histOverride?.pathOverride && String(histOverride.versionId) === String(histVid) && _histDirAlive)
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
    } catch { fmIndex = {}; }

    const basePath = getBasePath();
    let treeIndex = fmIndex.treeIndex || {};
    // NOTHING IN THIS CODEBASE WRITES fm-index.json. The route read it, found nothing and
    // answered 500 every time, so /history/locate has never actually run. Walk the library
    // instead when the index is absent — a stale index is also worse than useless here,
    // since locate exists precisely to repair paths after files have moved.
    if (!Object.keys(treeIndex).length) {
      treeIndex = {};
      const stack = [basePath];
      while (stack.length) {
        const dir = stack.pop();
        let ents = [];
        try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        const files = [];
        for (const e of ents) {
          const full = `${dir}/${e.name}`;
          if (e.isDirectory()) {
            if (e.name.startsWith('_sweep-quarantine-')) continue; // quarantined = not live
            stack.push(full);
          } else if (e.isFile()) {
            files.push({ name: e.name, path: full });
          }
        }
        if (files.length) treeIndex[dir] = { files };
      }
      console.log(`[civitai] locate: built tree index live (${Object.keys(treeIndex).length} dirs)`);
    }

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
        if (item.fileNameOverride) {
          // Both spellings: files written BEFORE the override was sanitised still carry
          // the raw spaces, so dropping the raw form would orphan every one of them.
          namesToTry.push(item.fileNameOverride + ext);
          const _s = sanitizeNameOverride(item.fileNameOverride, (loadConfig().separator) || '-') + ext;
          if (_s !== item.fileNameOverride + ext) namesToTry.push(_s);
        }
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
    const { modelId, versionId, pathOverride, moves, downloadMeta } = req.body;
    if (!moves?.length) return res.status(400).json({ error: 'No moves specified' });
  
    // Shared with the model-library manager — see applyModelMoves(). It performs the moves,
    // fixes permissions, prunes emptied directories and re-points history in one place.
    const { moved, deleted, errors } = applyModelMoves(moves, {
      modelId, versionId, pathOverride, fixPerms: (dir) => fixPermissions(dir, sshService),
    });
  
    // Apply (downloadMeta) refreshes the CivitAI sidecars at the new name/location.
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
          writeFileSync(`${newDir}/${newBaseName}.json`, JSON.stringify(model, null, 2));
          fixPermissions(newDir, sshService);
        }
      } catch (err) { console.error('[civitai] Metadata download after rename failed:', err.message); }
    }
  
    if (errors.length) console.error('[civitai] Rename errors:', JSON.stringify(errors));
    console.log(`[civitai] Rename: ${moved.length} moved, ${errors.length} errors`);
    res.json({ ok: true, moved: moved.length, deleted: deleted.length, errors });
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
