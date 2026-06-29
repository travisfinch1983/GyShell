/**
 * imagegen.js — AI Imagegen / LoRA training-set browser API.
 *
 * Self-contained router (does NOT touch ai.js). ProxLab has the dataset
 * bind-mounted locally at /ai-assets/imagegen/training_images, so all ops are
 * direct local FS + sharp (no SSH). Mounted at /api/imagegen.
 *
 * Routes (Phase 2):
 *   GET /browse?path=<rel>      -> { path, parent, crumbs, folders[], images[] }
 *   GET /thumb?path=<rel/file>  -> cached ~320px webp thumbnail
 *   GET /image?path=<rel/file>  -> full image (streamed)
 *
 * @module routes/imagegen
 */
import express, { Router } from 'express';
import {
  existsSync, readdirSync, statSync, mkdirSync, createReadStream, writeFileSync,
  copyFileSync, chmodSync, unlinkSync, renameSync, readFileSync, rmSync,
} from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { spawn } from 'child_process';

// ---- auto-caption (Phase 6): dispatch the tagger to the GPU container (CT 176,
// ai-epyc) over SSH. It sees the same data at /imagegen/training_images/<rel>
// and the models at /imagegen/taggers/. ONNX engine (WD/JoyTag) + BLIP engine.
const TAGGER_SSH = process.env.TAGGER_SSH || 'root@10.0.0.234';
const TAGGER_REMOTE_TI = '/imagegen/training_images';   // training_images on the GPU host
const TAGGER_REMOTE_MODELS = '/imagegen/taggers';        // ONNX tagger model dirs there
const TAGGER_LOCAL_MODELS = '/ai-assets/imagegen/taggers'; // same dir, proxlab-local (for listing)
const ONNX_PY = '/opt/imagegen-tagger/.venv/bin/python';
const ONNX_SCRIPT = '/opt/imagegen-tagger/tagger.py';
const BLIP_PY = '/opt/photo-upscale/.venv/bin/python';   // has torch cu128 + transformers
const BLIP_SCRIPT = '/opt/imagegen-tagger/blip_caption.py';
const BLIP_MODEL_DIR = '/imagegen/blip/hf-large';
const TAGGER_GPU_INDEX = 4;   // the RTX 4090 (5060 Tis are Blackwell — onnxruntime CUDA EP n/a)
const captionJobs = new Map();   // jobId -> { state, total, done, wrote, skipped, errors, ... }

const BASE = '/ai-assets/imagegen/training_images';
const THUMB_DIR = '/tmp/imagegen-thumbs';
const THUMB_PX = 320;
const COMPANION = process.env.COMPANION_URL || 'http://10.0.0.231:8080';  // upscale companion (shares the mount)
// Re-upscaling a (clean, already-cropped) training image benefits from the SHARP
// SeedVR2 variant — more visible detail/sharpening than the soft default.
const REUPSCALE_MODEL = process.env.REUPSCALE_MODEL || 'seedvr2-7b-sharp-fp8';
const upscaleJobs = new Map();   // jobId -> { state:'running'|'done'|'error', w, h, error }
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

function isImage(name) {
  return IMG_EXT.has(path.extname(name).toLowerCase());
}

/**
 * Recursively walk a tag-folder subtree. Records into `removals` any image in a
 * folder that ALSO exists (by filename = asset id) in a descendant tag folder —
 * i.e. an image the old hierarchical-search sync over-downloaded into a parent.
 * `training_set/` folders are skipped entirely (curated copies, never touched).
 * Returns the set of all image filenames anywhere in this subtree.
 */
function walkDedup(dir, removals) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return new Set(); }
  const direct = new Set();
  const subdirs = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (isTrainingSetName(e.name)) continue;   // curated copies — not part of the tag tree
      subdirs.push(e.name);
    } else if (isImage(e.name)) {
      direct.add(e.name);
    }
  }
  const descendant = new Set();
  for (const sd of subdirs) {
    for (const n of walkDedup(path.join(dir, sd), removals)) descendant.add(n);
  }
  for (const name of direct) {
    if (descendant.has(name)) removals.push({ folder: path.relative(BASE, dir), name });
  }
  const all = new Set(descendant);
  for (const n of direct) all.add(n);
  return all;
}

/** Resolve a caller-supplied relative path safely under BASE (no traversal). */
function safeResolve(rel) {
  const clean = (rel || '').replace(/^\/+/, '');
  const abs = path.resolve(BASE, clean);
  if (abs !== BASE && !abs.startsWith(BASE + path.sep)) {
    throw new Error('path escapes base');
  }
  return abs;
}

const DIMS_CAP = 800;   // skip per-image dimension reads for folders larger than this (perf)
const MERGED_ROOT = '_merged';   // top-level home for merged (independent) training sets
const COLLAGE_NAME = '_collage.jpg';   // single-page collage; paged sets use _collage-N.jpg
const RATINGS_NAME = '_ratings.json';  // Cinder's per-folder { file: {score,comment,rated_at} }
const COLLAGE_PER_PAGE = 100;          // images per collage page above this -> paged
// _collage.jpg or _collage-3.jpg — excluded from the numbered grid + counts
const isCollageFile = (n) => /^_collage(-\d+)?\.jpg$/i.test(n);

// A "training set" is any folder named training_set or training_set_<suffix>.
const isTrainingSetName = (n) => n === 'training_set' || n.startsWith('training_set_');
// A path is INSIDE a training set when one of its segments is a training-set folder.
const TS_GUARD = /(^|\/)training_set(_[^/]+)?\//;

/**
 * Pristine baseline for a training-set working copy, used by reset + cropped-flag:
 *   1. <set>/.orig/<name>   (merged sets snapshot their as-merged state here)
 *   2. <parent of set>/<name>  (tag-folder sets: the synced original one level up)
 */
function baselinePath(file) {
  const tsDir = path.dirname(file);
  const o1 = path.join(tsDir, '.orig', path.basename(file));
  if (existsSync(o1)) return o1;
  const o2 = path.join(path.dirname(tsDir), path.basename(file));
  if (existsSync(o2)) return o2;
  return null;
}

/** Caption sidecar for an image: same basename, .txt extension
 *  (the kohya_ss / sd-scripts LoRA convention — image.png -> image.txt). */
function captionPath(file) {
  return file.replace(/\.[^/.]+$/, '') + '.txt';
}

// ---- friendly-name helpers (Cinder-friendly <base>-N.ext naming) ----
/** Slug for filenames: lowercase, keep [a-z0-9_-], collapse the rest to '-'. */
function slugify(s) {
  return String(s).trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'img';
}
/** The name-base for files in a folder:
 *  training_set_<suffix> -> <suffix>;  bare training_set -> parent folder name;
 *  any other folder -> the folder's own name. All slugified. */
function folderBaseName(absFolder) {
  const name = path.basename(absFolder);
  if (name === 'training_set') return slugify(path.basename(path.dirname(absFolder)));
  if (name.startsWith('training_set_')) return slugify(name.slice('training_set_'.length));
  return slugify(name);
}
/** Next free "<base>-N.<ext>" in a folder, considering both on-disk files and
 *  names already handed out this pass (`taken`). N continues past the max in use. */
function nextFriendlyName(folder, base, ext, taken) {
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)\\.');
  let max = 0;
  const scan = (names) => { for (const n of names) { const m = n.match(re); if (m) max = Math.max(max, +m[1]); } };
  try { scan(readdirSync(folder)); } catch { /* ignore */ }
  scan(taken);
  let n = max + 1, nm;
  do { nm = `${base}-${n}.${ext}`; n++; } while (taken.has(nm) || existsSync(path.join(folder, nm)));
  return nm;
}
const NAMEMAP = '.aig-names.json';   // per-tag-folder { asset_id: friendly_name }
function loadNameMap(folder) {
  try { return JSON.parse(readFileSync(path.join(folder, NAMEMAP), 'utf8')) || {}; } catch { return {}; }
}
function saveNameMap(folder, m) {
  try { const p = path.join(folder, NAMEMAP); writeFileSync(p, JSON.stringify(m)); chmodSync(p, 0o664); } catch { /* ignore */ }
}
/** Reverse-lookup: which asset_id currently maps to this filename (or null). */
function assetIdForName(map, name) {
  for (const k of Object.keys(map)) if (map[k] === name) return k;
  return null;
}

/** Resolve a filename within a folder, tolerant of a wrong/missing extension.
 *  Agents reading the numbered collage only know "red-6" and guess .png/.jpg —
 *  so if the exact name isn't there, match the real <stem>.<imgext> on disk. */
function resolveImageName(dir, name) {
  if (!name || name.includes('/') || name.includes('..')) return null;
  if (existsSync(path.join(dir, name)) && isImage(name)) return name;
  const stem = name.replace(/\.[^/.]+$/, '');
  try {
    for (const f of readdirSync(dir)) {
      if (isImage(f) && !isCollageFile(f) && f.replace(/\.[^/.]+$/, '') === stem) return f;
    }
  } catch { /* ignore */ }
  return null;
}
/** Same, for an absolute image path: returns the real path or null. */
function resolveImageFile(absFile) {
  if (existsSync(absFile) && isImage(path.basename(absFile))) return absFile;
  const r = resolveImageName(path.dirname(absFile), path.basename(absFile));
  return r ? path.join(path.dirname(absFile), r) : null;
}

// ---- ratings (_ratings.json per folder: { file: {score 1-10, comment, rated_at} }) ----
function loadRatings(folder) {
  try { return JSON.parse(readFileSync(path.join(folder, RATINGS_NAME), 'utf8')) || {}; } catch { return {}; }
}
function saveRatings(folder, m) {
  try {
    const p = path.join(folder, RATINGS_NAME);
    if (!Object.keys(m).length) { if (existsSync(p)) unlinkSync(p); return; }
    writeFileSync(p, JSON.stringify(m, null, 2)); chmodSync(p, 0o664);
  } catch { /* ignore */ }
}

/** Header-only dimension read (fast; does not decode the image). */
async function dimsOf(abs) {
  try { const m = await sharp(abs).metadata(); return { w: m.width || 0, h: m.height || 0 }; }
  catch { return { w: 0, h: 0 }; }
}

/** Run `fn` over items with bounded concurrency, preserving order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

export function createImagegenRouter(config) {
  const router = Router();
  // AI-Lab: CT152 has no default SSH identity for the tagger host, so pass its managed key explicitly.
  const SSH_KEY = (config && config.keyPath) || process.env.AILAB_SSH_KEY || '';
  try { mkdirSync(THUMB_DIR, { recursive: true }); } catch { /* ignore */ }

  // ---- browse a folder ----
  router.get('/browse', async (req, res) => {
    let dir;
    try { dir = safeResolve(req.query.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return res.status(404).json({ error: 'not a directory' });
    }
    const rel = path.relative(BASE, dir);
    const folders = [];
    const images = [];
    let collageFirst = '';   // first collage page filename (for the UI "view" button)
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      let st;
      try { st = statSync(path.join(dir, name)); } catch { continue; }
      if (st.isDirectory()) {
        // peek for quick counts + whether it has a training_set child
        let nImg = 0, nSub = 0, hasTS = false;
        try {
          for (const c of readdirSync(path.join(dir, name))) {
            if (c.startsWith('.')) continue;
            let cst; try { cst = statSync(path.join(dir, name, c)); } catch { continue; }
            if (cst.isDirectory()) { nSub++; if (isTrainingSetName(c)) hasTS = true; }
            else if (isImage(c) && !isCollageFile(c)) nImg++;
          }
        } catch { /* ignore */ }
        folders.push({
          name, n_images: nImg, n_subfolders: nSub,
          is_training_set: isTrainingSetName(name), has_training_set: hasTS,
        });
      } else if (isImage(name) && !isCollageFile(name)) {
        // mtime = content modified; birthtime = created; ctime = inode change
        // (best proxy for "added to this folder/training set" — updates on the
        // move/copy that placed the file here). birthtime can be 0 on some FS;
        // fall back to ctime so created-sort still behaves.
        images.push({
          name, size: st.size,
          mtime: Math.round(st.mtimeMs),
          ctime: Math.round(st.ctimeMs),
          birthtime: Math.round(st.birthtimeMs || st.ctimeMs),
        });
      } else if (isCollageFile(name)) {
        if (!collageFirst || name < collageFirst) collageFirst = name;   // _collage-1.jpg < _collage.jpg
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    images.sort((a, b) => a.name.localeCompare(b.name));
    // Per-image dimensions (header-only) for training sets or modest folders.
    // In a training set, also flag images whose size differs from their pristine
    // baseline (== they've been cropped/resized since send/merge).
    const isTS = isTrainingSetName(path.basename(dir));
    if (images.length && (isTS || images.length <= DIMS_CAP)) {
      const dims = await mapLimit(images, 16, (im) => dimsOf(path.join(dir, im.name)));
      images.forEach((im, k) => { im.w = dims[k].w; im.h = dims[k].h; });
      if (isTS) {
        const od = await mapLimit(images, 16, (im) => {
          const b = baselinePath(path.join(dir, im.name));
          return b ? dimsOf(b) : Promise.resolve(null);
        });
        images.forEach((im, k) => {
          const o = od[k];
          im.cropped = !!(o && (o.w !== im.w || o.h !== im.h));
          im.has_alt = existsSync(path.join(dir, '.preup', im.name));   // an upscale swap is available
          im.has_caption = existsSync(captionPath(path.join(dir, im.name)));   // .txt tag sidecar
          im.has_nl_caption = existsSync(path.join(dir, im.name).replace(/\.[^/.]+$/, '') + '.caption');   // BLIP/NL
        });
      }
    }
    // attach Cinder's ratings (score/comment) to images when present
    if (images.length) {
      const ratings = loadRatings(dir);
      if (Object.keys(ratings).length) {
        images.forEach((im) => { const r = ratings[im.name]; if (r) { im.score = r.score; im.comment = r.comment; } });
      }
    }
    // breadcrumbs
    const crumbs = [];
    if (rel) {
      const parts = rel.split(path.sep);
      let acc = '';
      for (const p of parts) { acc = acc ? `${acc}/${p}` : p; crumbs.push({ name: p, path: acc }); }
    }
    const parent = rel ? path.dirname(rel) : null;
    res.json({
      path: rel, parent: parent === '.' ? '' : parent, crumbs,
      is_training_set: isTS, is_merged: rel.split('/')[0] === MERGED_ROOT,
      has_collage: !!collageFirst, collage_first: collageFirst,
      folders, images,
    });
  });

  // ---- thumbnail (cached) ----
  router.get('/thumb', async (req, res) => {
    let file;
    try { file = safeResolve(req.query.path); } catch { return res.status(400).end(); }
    if (!existsSync(file) || !statSync(file).isFile()) return res.status(404).end();
    const st = statSync(file);
    const key = crypto.createHash('sha1')
      .update(`${file}:${st.mtimeMs}:${st.size}:${THUMB_PX}`).digest('hex');
    const cached = path.join(THUMB_DIR, `${key}.webp`);
    res.set('Cache-Control', 'private, max-age=86400');
    res.type('image/webp');
    if (existsSync(cached)) return createReadStream(cached).pipe(res);
    try {
      const buf = await sharp(file)
        .rotate()
        .resize(THUMB_PX, THUMB_PX, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      try { writeFileSync(cached, buf); } catch { /* best effort */ }
      res.end(buf);
    } catch (e) {
      res.status(500).end();
    }
  });

  // ---- full image ----
  router.get('/image', (req, res) => {
    let file;
    try { file = safeResolve(req.query.path); } catch { return res.status(400).end(); }
    if (!existsSync(file) || !statSync(file).isFile()) return res.status(404).end();
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';
    res.set('Cache-Control', 'private, max-age=3600');
    res.type(type);
    createReadStream(file).pipe(res);
  });

  // ---- Send to Training Set: copy selected images into <folder>/training_set/ ----
  router.post('/send-to-training-set', express.json(), (req, res) => {
    const { path: rel, files, suffix } = req.body || {};
    let folder;
    try { folder = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      return res.status(404).json({ error: 'not a directory' });
    }
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'no files' });
    const sfx = (suffix || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');   // safe suffix
    const ts = path.join(folder, 'training_set' + (sfx ? `_${sfx}` : ''));
    try { mkdirSync(ts, { recursive: true }); chmodSync(ts, 0o777); } catch { /* ignore */ }
    const base = folderBaseName(ts);                     // <suffix>-N naming
    const taken = new Set();
    try { mkdirSync(path.join(ts, '.orig'), { recursive: true }); } catch { /* ignore */ }
    let copied = 0; const errors = [];
    for (const name of files) {
      if (typeof name !== 'string' || name.includes('/') || name.includes('..') || !isImage(name)) {
        errors.push(name); continue;
      }
      const src = path.join(folder, name);
      if (!existsSync(src) || !statSync(src).isFile()) { errors.push(name); continue; }
      try {
        const ext = (path.extname(name).slice(1) || 'png').toLowerCase();
        const newName = nextFriendlyName(ts, base, ext, taken);
        taken.add(newName);
        const dst = path.join(ts, newName);
        copyFileSync(src, dst);
        chmodSync(dst, 0o664);   // readable by Samba/agents (same convention as sync)
        // Baseline snapshot under the NEW name — the parent-original baseline no
        // longer matches by filename, so reset-crop + cropped-flag rely on this.
        try {
          const ob = path.join(ts, '.orig', newName);
          copyFileSync(src, ob); chmodSync(ob, 0o664);
        } catch { /* ignore */ }
        // Carry an existing caption sidecar across to the new name.
        const capSrc = captionPath(src);
        if (existsSync(capSrc)) {
          try { const cd = captionPath(dst); copyFileSync(capSrc, cd); chmodSync(cd, 0o664); } catch { /* ignore */ }
        }
        copied++;
      } catch { errors.push(name); }
    }
    res.json({ ok: true, copied, errors, training_set: path.relative(BASE, ts) });
  });

  // ---- Move/Copy selected images into another folder (reorganizing the tree).
  // POST { op:'move'|'copy', src:<rel folder>, dest:<rel folder>, files:[...] }
  // dest is created if missing. Move uses rename (same FS) w/ copy+unlink fallback.
  router.post('/transfer', express.json(), (req, res) => {
    const { op, src: srcRel, dest: destRel, files } = req.body || {};
    if (op !== 'move' && op !== 'copy') return res.status(400).json({ error: 'op must be move|copy' });
    let srcDir, destDir;
    try { srcDir = safeResolve(srcRel); destDir = safeResolve(destRel); }
    catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
      return res.status(404).json({ error: 'src not a directory' });
    }
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'no files' });
    if (srcDir === destDir) return res.status(400).json({ error: 'src and dest are the same' });
    try { mkdirSync(destDir, { recursive: true }); chmodSync(destDir, 0o777); } catch { /* ignore */ }
    // Every destination renames incoming files to its own <base>-N scheme so a
    // folder's contents are always named after that folder. Training-set dests
    // also snapshot a baseline; captions follow in all cases. The companion's
    // asset_id->name maps are kept coherent (entry follows the file on move).
    const destIsTS = isTrainingSetName(path.basename(destDir));
    const base = folderBaseName(destDir);
    const taken = new Set();
    if (destIsTS) { try { mkdirSync(path.join(destDir, '.orig'), { recursive: true }); } catch { /* ignore */ } }
    const srcMap = loadNameMap(srcDir);
    const destMap = destIsTS ? null : loadNameMap(destDir);   // TS folders aren't sync-tracked
    let srcMapDirty = false, destMapDirty = false;
    let done = 0; const errors = [];
    for (const name of files) {
      if (typeof name !== 'string' || name.includes('/') || name.includes('..') || !isImage(name)) {
        errors.push(name); continue;
      }
      const from = path.join(srcDir, name);
      if (!existsSync(from) || !statSync(from).isFile()) { errors.push(name); continue; }
      const ext = (path.extname(name).slice(1) || 'png').toLowerCase();
      const outName = nextFriendlyName(destDir, base, ext, taken);
      taken.add(outName);
      const to = path.join(destDir, outName);
      const capFrom = captionPath(from);
      const aid = assetIdForName(srcMap, name);   // asset id of the moved file, if known
      try {
        if (destIsTS) {   // baseline under the new name (source bytes = pristine)
          try { const ob = path.join(destDir, '.orig', outName); copyFileSync(from, ob); chmodSync(ob, 0o664); } catch { /* ignore */ }
        }
        if (op === 'move') {
          try { renameSync(from, to); }
          catch { copyFileSync(from, to); unlinkSync(from); }   // cross-device fallback
          if (existsSync(capFrom)) {
            try { renameSync(capFrom, captionPath(to)); }
            catch { try { copyFileSync(capFrom, captionPath(to)); unlinkSync(capFrom); } catch { /* ignore */ } }
          }
          if (aid && srcMap[aid] !== undefined) { delete srcMap[aid]; srcMapDirty = true; }   // entry leaves source
        } else {
          copyFileSync(from, to);
          if (existsSync(capFrom)) { try { copyFileSync(capFrom, captionPath(to)); } catch { /* ignore */ } }
        }
        try { chmodSync(to, 0o664); } catch { /* ignore */ }
        try { const ct = captionPath(to); if (existsSync(ct)) chmodSync(ct, 0o664); } catch { /* ignore */ }
        if (destMap && aid) { destMap[aid] = outName; destMapDirty = true; }   // dest tag folder now holds this asset
        done++;
      } catch { errors.push(name); }
    }
    if (srcMapDirty) saveNameMap(srcDir, srcMap);
    if (destMapDirty) saveNameMap(destDir, destMap);
    res.json({
      ok: true, op, moved: op === 'move' ? done : 0, copied: op === 'copy' ? done : 0,
      done, errors, dest: path.relative(BASE, destDir),
    });
  });

  // ---- Crop/resize a training_set working copy (non-destructive: only ever
  // overwrites a file inside a */training_set/ folder; the pristine original
  // lives one level up). Body: { path, left, top, width, height (source px),
  // target_w, target_h }. sharp extracts the region then resizes to target.
  router.post('/crop', express.json(), async (req, res) => {
    const b = req.body || {};
    let file;
    try { file = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!TS_GUARD.test((b.path || '').replace(/^\/+/, ''))) {
      return res.status(400).json({ error: 'crop only allowed inside a training set' });
    }
    if (!existsSync(file) || !statSync(file).isFile()) return res.status(404).json({ error: 'no such file' });
    const tw = Math.round(+b.target_w), th = Math.round(+b.target_h);
    if (!(tw > 0 && th > 0)) return res.status(400).json({ error: 'bad target' });
    try {
      const meta = await sharp(file).metadata();
      let left = Math.max(0, Math.round(+b.left || 0));
      let top = Math.max(0, Math.round(+b.top || 0));
      let width = Math.round(+b.width), height = Math.round(+b.height);
      width = Math.min(width, meta.width - left);
      height = Math.min(height, meta.height - top);
      if (!(width > 0 && height > 0)) return res.status(400).json({ error: 'bad crop rect' });
      const ext = path.extname(file).toLowerCase();
      let pipe = sharp(file).extract({ left, top, width, height })
        .resize(tw, th, { fit: 'fill' });
      if (ext === '.png') pipe = pipe.png();
      else if (ext === '.webp') pipe = pipe.webp({ quality: 95 });
      else pipe = pipe.jpeg({ quality: 95 });
      const buf = await pipe.toBuffer();
      writeFileSync(file, buf);
      try { chmodSync(file, 0o664); } catch { /* ignore */ }
      res.json({ ok: true, w: tw, h: th, src: { left, top, width, height } });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- Reset a training_set copy back to its pristine original (one level up).
  router.post('/reset-crop', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    let file;
    try { file = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!TS_GUARD.test(rel)) {
      return res.status(400).json({ error: 'not a training set file' });
    }
    const base = baselinePath(file);
    if (!base) return res.status(404).json({ error: 'no pristine baseline found' });
    try {
      copyFileSync(base, file);
      try { chmodSync(file, 0o664); } catch { /* ignore */ }
      const pu = path.join(path.dirname(file), '.preup', path.basename(file));   // stale after full reset
      if (existsSync(pu)) { try { unlinkSync(pu); } catch { /* ignore */ } }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- read a caption sidecar (.txt next to the image) ----
  // ext = txt (booru tags, default) | caption (natural-language / BLIP)
  const sidecarFor = (file, ext) => file.replace(/\.[^/.]+$/, '') + '.' + (ext === 'caption' ? 'caption' : 'txt');
  router.get('/caption', (req, res) => {
    let file;
    try { file = safeResolve(req.query.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    file = resolveImageFile(file);   // tolerant of guessed extension
    if (!file) return res.status(404).json({ error: 'image not found' });
    const ext = req.query.ext === 'caption' ? 'caption' : 'txt';
    const txt = sidecarFor(file, ext);
    let caption = '';
    try { if (existsSync(txt)) caption = readFileSync(txt, 'utf8'); } catch { /* ignore */ }
    res.json({ caption, has_caption: existsSync(txt), ext });
  });

  // ---- write/save (or clear) a caption sidecar (ext: txt | caption) ----
  router.post('/caption', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    let file;
    try { file = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    file = resolveImageFile(file);   // tolerant of guessed extension
    if (!file) return res.status(404).json({ error: 'image not found' });
    const ext = (req.body && req.body.ext) === 'caption' ? 'caption' : 'txt';
    const txt = sidecarFor(file, ext);
    const caption = String((req.body && req.body.caption) ?? '');
    try {
      if (caption.trim() === '') {
        // empty caption -> remove the sidecar so it doesn't pollute training
        if (existsSync(txt)) unlinkSync(txt);
        return res.json({ ok: true, has_caption: false });
      }
      writeFileSync(txt, caption, 'utf8');
      try { chmodSync(txt, 0o664); } catch { /* ignore */ }
      res.json({ ok: true, has_caption: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- list available auto-caption models (ONNX taggers + BLIP) ----
  router.get('/taggers', (_req, res) => {
    const out = [];
    try {
      for (const name of readdirSync(TAGGER_LOCAL_MODELS).sort()) {
        if (name.startsWith('.')) continue;
        const d = path.join(TAGGER_LOCAL_MODELS, name);
        let st; try { st = statSync(d); } catch { continue; }
        if (!st.isDirectory()) continue;
        let files; try { files = readdirSync(d); } catch { continue; }
        if (!files.some((f) => f.endsWith('.onnx'))) continue;
        const kind = files.includes('top_tags.txt') ? 'joytag' : 'wd';
        out.push({ id: name, label: name, kind, engine: 'onnx' });
      }
    } catch { /* ignore */ }
    out.push({ id: 'blip-large', label: 'BLIP large — natural language (GPU)', kind: 'blip', engine: 'blip' });
    res.json({ taggers: out, default_gpu_index: TAGGER_GPU_INDEX });
  });

  // ---- run an auto-caption job over a folder (async; dispatched to the GPU host) ----
  router.post('/auto-caption', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return res.status(404).json({ error: 'not a directory' });
    }
    // The tagger writes .txt as the GPU host's root, whose uid differs from ours
    // on the shared mount — so the folder must be world-writable. NAS perms drift,
    // so force it open before dispatch (best-effort; we own training-set folders).
    try { chmodSync(dir, 0o777); } catch { /* ignore */ }
    const b = req.body || {};
    const engine = b.engine === 'blip' ? 'blip' : 'onnx';
    const model = String(b.model || '');
    if (engine === 'onnx' && !/^[\w.-]+$/.test(model)) {   // guard: no shell-meta / traversal
      return res.status(400).json({ error: 'bad model' });
    }
    const device = b.device === 'cuda' ? 'cuda' : 'cpu';
    // Separate sidecars per engine so booru tags + natural-language captions co-exist:
    // WD/JoyTag -> .txt (training tags), BLIP -> .caption. Override via body.caption_ext.
    let ext = String(b.caption_ext || (engine === 'blip' ? 'caption' : 'txt'));
    if (!/^[a-z0-9]{1,8}$/i.test(ext)) ext = engine === 'blip' ? 'caption' : 'txt';
    const remoteFolder = `${TAGGER_REMOTE_TI}/${rel}`;
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;   // single-quote for the remote shell
    let cmd;
    if (engine === 'blip') {
      cmd = `${BLIP_PY} ${BLIP_SCRIPT} --folder ${q(remoteFolder)} --model-dir ${q(BLIP_MODEL_DIR)} `
          + `--device cuda --gpu-index ${TAGGER_GPU_INDEX} --caption-ext ${ext}`
          + (b.trigger ? ` --trigger ${q(b.trigger)}` : '')
          + (b.overwrite ? ' --overwrite' : '') + ' --json';
    } else {
      cmd = `${ONNX_PY} ${ONNX_SCRIPT} --folder ${q(remoteFolder)} --model-dir ${q(`${TAGGER_REMOTE_MODELS}/${model}`)} `
          + `--device ${device} --gpu-index ${TAGGER_GPU_INDEX} --caption-ext ${ext} `
          + `--threshold ${Number(b.threshold) || 0.35} --char-threshold ${Number(b.char_threshold) || 0.85}`
          + (b.trigger ? ` --trigger ${q(b.trigger)}` : '')
          + (b.spaces ? ' --spaces' : '')
          + (b.max_tags ? ` --max-tags ${parseInt(b.max_tags, 10)}` : '')
          + (b.overwrite ? ' --overwrite' : '') + ' --json';
    }
    const jobId = crypto.randomBytes(6).toString('hex');
    captionJobs.set(jobId, { state: 'running', total: 0, done: 0, wrote: 0, skipped: 0, errors: 0, model: engine === 'blip' ? 'blip-large' : model });
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=20'];
    if (SSH_KEY) sshArgs.push('-i', SSH_KEY);
    sshArgs.push(TAGGER_SSH, cmd);
    const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let ebuf = '', tail = '';
    child.stderr.on('data', (d) => {
      ebuf += d.toString();
      let i;
      while ((i = ebuf.indexOf('\n')) >= 0) {
        const line = ebuf.slice(0, i).trim(); ebuf = ebuf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const j = captionJobs.get(jobId); if (!j) continue;
        if (ev.event === 'start') { j.total = ev.total; j.engine = ev.engine; j.provider = ev.provider || ev.device; }
        else if (ev.event === 'img') { j.done = ev.done; if (ev.status === 'error' && ev.error) j.lastError = `${ev.file}: ${ev.error}`; }
        else if (ev.event === 'done') { j.wrote = ev.wrote; j.skipped = ev.skipped; j.errors = ev.errors; }
      }
    });
    child.stdout.on('data', (d) => { tail += d.toString(); });
    child.on('close', (code) => {
      const j = captionJobs.get(jobId); if (!j) return;
      if (code === 0) {
        j.state = 'done';
        try { Object.assign(j, JSON.parse(tail.trim().split('\n').pop())); } catch { /* keep parsed-from-stderr */ }
      } else { j.state = 'error'; j.error = `tagger exited ${code}`; }
      setTimeout(() => captionJobs.delete(jobId), 120000);
    });
    child.on('error', (e) => {
      const j = captionJobs.get(jobId); if (j) { j.state = 'error'; j.error = String(e.message || e); }
    });
    res.json({ jobId });
  });

  router.get('/auto-caption-status', (req, res) => {
    const j = captionJobs.get(req.query.jobId);
    if (!j) return res.status(404).json({ error: 'no such job' });
    res.json(j);
  });

  // ---- Re-upscale a training-set working copy through the companion's GPU
  // pipeline. Async job (the GPU run can take ~30-60s): start -> poll status.
  // On success the current file is backed up to <set>/.preup/<name> and replaced
  // with the upscaled result (swap-upscale toggles between the two).
  router.post('/upscale', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    let file;
    try { file = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!TS_GUARD.test(rel)) return res.status(400).json({ error: 'only inside a training set' });
    if (!existsSync(file) || !statSync(file).isFile()) return res.status(404).json({ error: 'no such file' });
    const jobId = crypto.randomBytes(6).toString('hex');
    upscaleJobs.set(jobId, { state: 'running' });
    (async () => {
      try {
        const resp = await fetch(`${COMPANION}/api/upscale-file`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: rel, model: REUPSCALE_MODEL }),
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || !j.ok) throw new Error(j.detail || j.error || `companion ${resp.status}`);
        const tmpAbs = path.join(BASE, j.out);
        if (!existsSync(tmpAbs)) throw new Error('upscaled output not found on shared mount');
        const tsDir = path.dirname(file), name = path.basename(file);
        const preupDir = path.join(tsDir, '.preup');
        mkdirSync(preupDir, { recursive: true });
        copyFileSync(file, path.join(preupDir, name));        // pre-upscale backup (for swap-back)
        const ext = path.extname(file).toLowerCase();
        let pipe = sharp(tmpAbs);
        if (ext === '.png') pipe = pipe.png();
        else if (ext === '.webp') pipe = pipe.webp({ quality: 95 });
        else pipe = pipe.jpeg({ quality: 95 });
        writeFileSync(file, await pipe.toBuffer());
        try { chmodSync(file, 0o664); } catch { /* ignore */ }
        try { unlinkSync(tmpAbs); } catch { /* ignore */ }
        const m = await sharp(file).metadata();
        upscaleJobs.set(jobId, { state: 'done', w: m.width, h: m.height, gpu: j.gpu });
      } catch (e) {
        upscaleJobs.set(jobId, { state: 'error', error: String(e.message || e) });
      }
    })();
    res.json({ ok: true, jobId });
  });

  router.get('/upscale-status', (req, res) => {
    const j = upscaleJobs.get(req.query.jobId);
    if (!j) return res.status(404).json({ error: 'unknown job' });
    res.json(j);
    if (j.state !== 'running') setTimeout(() => upscaleJobs.delete(req.query.jobId), 60000);
  });

  // ---- Toggle a working copy between its current and pre-upscale versions.
  router.post('/swap-upscale', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    let file;
    try { file = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!TS_GUARD.test(rel)) return res.status(400).json({ error: 'not a training set file' });
    const alt = path.join(path.dirname(file), '.preup', path.basename(file));
    if (!existsSync(alt)) return res.status(404).json({ error: 'no alternate version to swap' });
    const tmp = alt + '.swap';
    try {
      copyFileSync(file, tmp); copyFileSync(alt, file); copyFileSync(tmp, alt);
      unlinkSync(tmp);
      try { chmodSync(file, 0o664); } catch { /* ignore */ }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- Delete images from a training set (working copies only; never originals).
  router.post('/delete', express.json(), (req, res) => {
    const rel = (req.body && req.body.path) || '';
    const files = req.body && req.body.files;
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!isTrainingSetName(path.basename(dir))) {
      return res.status(400).json({ error: 'delete only allowed inside a training set' });
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'no files' });
    let deleted = 0; const errors = []; const gone = [];
    for (const name of files) {
      if (typeof name !== 'string' || name.includes('/') || name.includes('..')) { errors.push(name); continue; }
      try {
        const f = path.join(dir, name);
        if (existsSync(f)) unlinkSync(f);
        const o = path.join(dir, '.orig', name); if (existsSync(o)) unlinkSync(o);          // merged baseline
        const pu = path.join(dir, '.preup', name); if (existsSync(pu)) unlinkSync(pu);       // upscale swap backup
        const cap = f.replace(/\.[^.]+$/, '.txt'); if (existsSync(cap)) unlinkSync(cap);     // tag sidecar
        const nlcap = f.replace(/\.[^.]+$/, '.caption'); if (existsSync(nlcap)) unlinkSync(nlcap);   // NL caption
        gone.push(name); deleted++;
      } catch { errors.push(name); }
    }
    if (gone.length) {   // prune Cinder's ratings for the removed images
      const ratings = loadRatings(dir);
      let changed = false;
      for (const n of gone) if (n in ratings) { delete ratings[n]; changed = true; }
      if (changed) saveRatings(dir, ratings);
    }
    res.json({ ok: true, deleted, errors });
  });

  // ---- Generate a contact-sheet collage of a training set (numbered grid) so a
  // human / LLM can eyeball the whole set at once. Saved as <set>/.collage.jpg
  // (dot-hidden -> excluded from browse, merge, dedup, training image counts).
  router.post('/collage', express.json(), async (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!isTrainingSetName(path.basename(dir))) return res.status(400).json({ error: 'only for training sets' });
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    const all = readdirSync(dir).filter((n) => !n.startsWith('.') && isImage(n) && !isCollageFile(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));   // red-2 before red-10
    if (!all.length) return res.status(400).json({ error: 'no images in this set' });
    // Above PER_PAGE images, split into pages (_collage-1.jpg, -2, ...) so no single
    // sheet gets too huge to load and cells stay big enough to read. Fixed cell size.
    const PER_PAGE = Math.max(16, Math.min(150, parseInt(req.body && req.body.per_page, 10) || COLLAGE_PER_PAGE));
    const CELL = 224, pad = 4, cw = CELL + pad * 2;
    const paged = all.length > PER_PAGE;
    const pageCount = paged ? Math.ceil(all.length / PER_PAGE) : 1;

    const renderPage = async (names) => {
      const cols = Math.ceil(Math.sqrt(names.length));
      const rows = Math.ceil(names.length / cols);
      const W = cols * cw, H = rows * cw;
      const comps = await mapLimit(names, 8, async (nm, i) => {
        const left = (i % cols) * cw + pad, top = Math.floor(i / cols) * cw + pad;
        let buf;
        try {
          buf = await sharp(path.join(dir, nm)).rotate()
            .resize(CELL, CELL, { fit: 'contain', background: { r: 24, g: 24, b: 24 } }).toBuffer();
        } catch { return null; }
        // label each cell with the image's OWN number (red-3 -> "3") for reference
        const stem = nm.replace(/\.[^.]+$/, '');
        const mnum = stem.match(/(\d+)$/);
        const lblText = (mnum ? mnum[1] : stem).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const lbl = Buffer.from(
          `<svg width="${CELL}" height="18"><rect width="100%" height="100%" fill="rgba(0,0,0,0.6)"/>` +
          `<text x="4" y="13" font-size="13" font-weight="bold" fill="#fff" font-family="sans-serif">${lblText}</text></svg>`);
        return [{ input: buf, left, top }, { input: lbl, left, top }];
      });
      const flat = comps.filter(Boolean).flat();
      const out = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 18, g: 18, b: 18 } } })
        .composite(flat).jpeg({ quality: 80 }).toBuffer();
      return { out, cols, rows, w: W, h: H };
    };

    try {
      // clear stale collage file(s) first so old pages don't linger
      for (const f of readdirSync(dir)) { if (isCollageFile(f)) { try { unlinkSync(path.join(dir, f)); } catch { /* ignore */ } } }
      const pages = [];
      for (let p = 0; p < pageCount; p++) {
        const chunk = all.slice(p * PER_PAGE, (p + 1) * PER_PAGE);
        const fn = paged ? `_collage-${p + 1}.jpg` : COLLAGE_NAME;
        const r = await renderPage(chunk);
        const outRel = `${rel}/${fn}`;
        writeFileSync(path.join(BASE, outRel), r.out);
        try { chmodSync(path.join(BASE, outRel), 0o664); } catch { /* ignore */ }
        pages.push({ path: outRel, agent_path: `/imagegen/training_images/${outRel}`,
          n: chunk.length, cols: r.cols, rows: r.rows, w: r.w, h: r.h });
      }
      res.json({ ok: true, total: all.length, per_page: PER_PAGE, paged, page_count: pageCount, pages });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- delete a folder's collage ----
  router.post('/collage-delete', express.json(), (req, res) => {
    let dir;
    try { dir = safeResolve(req.body && req.body.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    try {
      let removed = 0;
      for (const f of readdirSync(dir)) {
        if (isCollageFile(f)) { try { unlinkSync(path.join(dir, f)); removed++; } catch { /* ignore */ } }
      }
      res.json({ ok: true, removed });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- delete a whole training set (the folder + all its contents) ----
  router.post('/delete-set', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!isTrainingSetName(path.basename(dir))) {
      return res.status(400).json({ error: 'only training sets can be deleted' });
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such set' });
    try { rmSync(dir, { recursive: true, force: true }); res.json({ ok: true, deleted: rel }); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- ratings: read all for a folder (+ which images are unscored) ----
  router.get('/ratings', (req, res) => {
    let dir;
    try { dir = safeResolve(req.query.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });
    const ratings = loadRatings(dir);
    const imgs = readdirSync(dir).filter((n) => isImage(n) && n !== COLLAGE_NAME).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const unscored = imgs.filter((n) => !(n in ratings));
    res.json({ ratings, unscored, total: imgs.length, scored: imgs.length - unscored.length });
  });

  // ---- ratings: set/clear one image's score + comment ----
  router.post('/rating', express.json(), (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });
    const file = resolveImageName(dir, String(b.file || ''));   // tolerant of guessed extension
    if (!file) return res.status(404).json({ error: 'no such image' });
    const ratings = loadRatings(dir);
    // score 0 / null / '' clears the rating entirely (a rating implies a score).
    if (b.score === null || b.score === undefined || b.score === '' || Number(b.score) === 0) {
      delete ratings[file];
    } else {
      const score = Math.max(1, Math.min(10, Math.round(Number(b.score))));
      ratings[file] = { score, comment: String(b.comment || ''), rated_at: Date.now() };
    }
    saveRatings(dir, ratings);
    res.json({ ok: true, file, rating: ratings[file] || null });
  });

  // ---- batch rate many images in one call (one structured dict -> many writes).
  // body: { path:<folder>, ratings: { "<file>": {score 1-10, comment}, ... } } ----
  router.post('/ratings-batch', express.json(), (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });
    const r = b.ratings || {};
    if (typeof r !== 'object' || Array.isArray(r)) return res.status(400).json({ error: 'ratings must be an object' });
    const ratings = loadRatings(dir);
    let set = 0, cleared = 0; const errors = [];
    for (const [rawName, val] of Object.entries(r)) {
      const file = resolveImageName(dir, rawName);
      if (!file) { errors.push(rawName); continue; }
      const sc = (val && typeof val === 'object') ? val.score : val;
      if (sc === null || sc === undefined || sc === '' || Number(sc) === 0) { delete ratings[file]; cleared++; }
      else {
        const score = Math.max(1, Math.min(10, Math.round(Number(sc))));
        ratings[file] = { score, comment: String((val && val.comment) || ''), rated_at: Date.now() };
        set++;
      }
    }
    saveRatings(dir, ratings);
    res.json({ ok: true, set, cleared, errors });
  });

  // ---- batch write captions for many images (ext: txt | caption).
  // body: { path:<folder>, captions: { "<file>": "<text>", ... }, ext } ----
  router.post('/captions-batch', express.json(), (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });
    const caps = b.captions || {};
    if (typeof caps !== 'object' || Array.isArray(caps)) return res.status(400).json({ error: 'captions must be an object' });
    const ext = b.ext === 'caption' ? 'caption' : 'txt';
    let wrote = 0, cleared = 0; const errors = [];
    for (const [rawName, text] of Object.entries(caps)) {
      const file = resolveImageName(dir, rawName);
      if (!file) { errors.push(rawName); continue; }
      const sc = path.join(dir, file).replace(/\.[^/.]+$/, '') + '.' + ext;
      try {
        if (String(text || '').trim() === '') { if (existsSync(sc)) unlinkSync(sc); cleared++; }
        else { writeFileSync(sc, String(text), 'utf8'); try { chmodSync(sc, 0o664); } catch { /* not owner */ } wrote++; }
      } catch { errors.push(rawName); }
    }
    res.json({ ok: true, wrote, cleared, ext, errors });
  });

  // ---- tags: add/remove individual tags in an image's .txt caption ----
  router.post('/tags', express.json(), (req, res) => {
    const b = req.body || {};
    let file;
    try { file = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    file = resolveImageFile(file);   // tolerant of guessed extension
    if (!file) return res.status(404).json({ error: 'image not found' });
    const txt = captionPath(file);
    let tags = [];
    try { if (existsSync(txt)) tags = readFileSync(txt, 'utf8').split(',').map((t) => t.trim()).filter(Boolean); } catch { /* ignore */ }
    const norm = (t) => String(t).trim();
    const remove = new Set((b.remove || []).map(norm));
    tags = tags.filter((t) => !remove.has(t));
    for (const t of (b.add || []).map(norm)) { if (t && !tags.includes(t)) tags.push(t); }
    try {
      if (!tags.length) { if (existsSync(txt)) unlinkSync(txt); }
      else { writeFileSync(txt, tags.join(', '), 'utf8'); try { chmodSync(txt, 0o664); } catch { /* not owner; already 0664 */ } }
      res.json({ ok: true, tags });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- Strip booru-tag (.txt) sidecars. POST { path:<folder rel>, files?:[names] }.
  // Removes ONLY .txt tag files — never images, never .caption (natural-language).
  // Folder-wide when `files` omitted; otherwise just the named images' .txt.
  router.post('/strip-tags', express.json(), (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });
    let removed = 0; const files = [];
    const rmTxtFor = (imgName) => {
      const txt = path.join(dir, imgName.replace(/\.[^/.]+$/, '') + '.txt');
      try { if (existsSync(txt)) { unlinkSync(txt); removed++; files.push(path.basename(txt)); } } catch { /* ignore */ }
    };
    try {
      if (Array.isArray(b.files) && b.files.length) {
        for (const nm of b.files) {
          const r = resolveImageName(dir, String(nm || ''));   // tolerant of guessed ext
          if (r) rmTxtFor(r);
        }
      } else {
        for (const f of readdirSync(dir)) {
          if (isImage(f) && !isCollageFile(f)) rmTxtFor(f);
        }
      }
      res.json({ ok: true, removed, files });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- Rename a training set's suffix (or add one to a legacy 'training_set').
  // POST { path:<set folder rel>, suffix } -> renames to training_set[_suffix]
  // in the same parent. Keeps merged sets under _merged/.
  router.post('/rename-set', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    const suffix = (req.body && req.body.suffix || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!isTrainingSetName(path.basename(dir))) return res.status(400).json({ error: 'not a training set' });
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    const newName = 'training_set' + (suffix ? `_${suffix}` : '');
    const dest = path.join(path.dirname(dir), newName);
    if (dest === dir) return res.json({ ok: true, path: path.relative(BASE, dir), unchanged: true });
    if (existsSync(dest)) return res.status(409).json({ error: 'a set with that name already exists here' });
    try {
      renameSync(dir, dest);
      res.json({ ok: true, path: path.relative(BASE, dest) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- List every training set in the tree (for the merge picker + agents).
  router.get('/training-sets', (req, res) => {
    const out = [];
    (function walk(dir) {
      let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') || !e.isDirectory()) continue;
        const abs = path.join(dir, e.name);
        if (isTrainingSetName(e.name)) {
          let n = 0;
          try { for (const c of readdirSync(abs)) if (!c.startsWith('.') && isImage(c)) n++; } catch { /* ignore */ }
          const relp = path.relative(BASE, abs);
          out.push({ path: relp, name: e.name, parent: path.relative(BASE, dir), count: n,
            merged: relp.split('/')[0] === MERGED_ROOT });
        } else {
          walk(abs);     // don't descend into a training set
        }
      }
    })(BASE);
    out.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ training_sets: out });
  });

  // ---- Merge multiple training sets into one new INDEPENDENT set under _merged/.
  // Copies each source image (+ an .orig snapshot so it's self-contained for
  // crop/reset). Filename collisions get a -N suffix so nothing is lost.
  router.post('/merge', express.json(), (req, res) => {
    const name = (req.body && req.body.name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    const sources = req.body && req.body.sources;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!Array.isArray(sources) || !sources.length) return res.status(400).json({ error: 'no sources' });
    const srcDirs = [];
    for (const s of sources) {
      let d; try { d = safeResolve(s); } catch { return res.status(400).json({ error: 'bad source: ' + s }); }
      if (!isTrainingSetName(path.basename(d)) || !existsSync(d)) {
        return res.status(400).json({ error: 'not a training set: ' + s });
      }
      srcDirs.push(d);
    }
    const dest = path.join(BASE, MERGED_ROOT, 'training_set_' + name);
    if (existsSync(dest)) return res.status(409).json({ error: 'a merged set with that name already exists' });
    try { mkdirSync(path.join(dest, '.orig'), { recursive: true }); chmodSync(dest, 0o777); } catch { /* ignore */ }
    let copied = 0; const errors = []; const used = new Set();
    for (const d of srcDirs) {
      let names; try { names = readdirSync(d); } catch { continue; }
      for (const nm of names) {
        if (nm.startsWith('.') || !isImage(nm)) continue;
        const from = path.join(d, nm);
        try { if (!statSync(from).isFile()) continue; } catch { continue; }
        let target = nm;
        if (used.has(target) || existsSync(path.join(dest, target))) {
          const ext = path.extname(nm); const stem = nm.slice(0, nm.length - ext.length);
          let k = 2; while (used.has(`${stem}-${k}${ext}`) || existsSync(path.join(dest, `${stem}-${k}${ext}`))) k++;
          target = `${stem}-${k}${ext}`;
        }
        used.add(target);
        try {
          copyFileSync(from, path.join(dest, target)); chmodSync(path.join(dest, target), 0o664);
          copyFileSync(from, path.join(dest, '.orig', target));   // as-merged baseline for reset
          copied++;
        } catch { errors.push(nm); }
      }
    }
    res.json({ ok: true, dest: path.relative(BASE, dest), copied, errors, sources: sources.length });
  });

  // ---- One-time dedup: remove images from parent folders that also live in a
  // child tag folder (over-downloaded by the old hierarchical-search sync).
  // POST { dryRun: true } -> report only; { dryRun: false } -> actually delete.
  router.post('/dedup-parents', express.json(), (req, res) => {
    const dryRun = !(req.body && req.body.dryRun === false);   // safe default: dry-run
    const removals = [];
    try { walkDedup(BASE, removals); }
    catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const folders = {};
    for (const r of removals) folders[r.folder] = (folders[r.folder] || 0) + 1;
    let deleted = 0; const errors = [];
    if (!dryRun) {
      for (const r of removals) {
        try { unlinkSync(path.join(BASE, r.folder, r.name)); deleted++; }
        catch { errors.push(`${r.folder}/${r.name}`); }
      }
    }
    const top = Object.entries(folders).sort((a, b) => b[1] - a[1]).slice(0, 30)
      .map(([folder, count]) => ({ folder, count }));
    res.json({
      ok: true, dryRun, candidates: removals.length, deleted,
      folders_affected: Object.keys(folders).length, top_folders: top, errors,
    });
  });

  return router;
}
