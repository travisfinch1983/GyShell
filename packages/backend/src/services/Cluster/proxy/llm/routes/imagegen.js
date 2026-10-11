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
  copyFileSync, chmodSync, unlinkSync, renameSync, readFileSync, rmSync, cpSync, utimesSync,
} from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { spawn, execFile } from 'child_process';
import { pickForge } from '../../forge-endpoint.js';

// ---- auto-caption (Phase 6): dispatch the tagger to the GPU container (CT 176,
// ai-epyc) over SSH. It sees the same data at /imagegen/training_images/<rel>
// and the models at /imagegen/taggers/. ONNX engine (WD/JoyTag) + BLIP engine.
const TAGGER_SSH = process.env.TAGGER_SSH || 'root@10.0.0.234';
const TAGGER_REMOTE_TI = '/imagegen';   // same root as BASE, on the GPU host
const TAGGER_REMOTE_MODELS = '/imagegen/taggers';        // ONNX tagger model dirs there
const TAGGER_LOCAL_MODELS = '/ai-assets/imagegen/taggers'; // same dir, proxlab-local (for listing)
const ONNX_PY = '/opt/imagegen-tagger/.venv/bin/python';
const ONNX_SCRIPT = '/opt/imagegen-tagger/tagger.py';
// onnxruntime-gpu dlopens libcudnn.so / libcublas.so by BARE name, but the pip nvidia wheels
// drop them under site-packages/nvidia/*/lib -- not on the loader path, and shipped only with
// versioned sonames. Without this the CUDA provider loads and REPORTS ITSELF ACTIVE, then fails
// every image at the first Conv node ("cuDNN is unavailable"). A provider that is available but
// cannot execute is worse than one that is absent, because the status line looks right.
// The glob keeps this correct across python-version bumps in that venv.
const ONNX_LD = `LD_LIBRARY_PATH="$(echo /opt/imagegen-tagger/.venv/lib/python*/site-packages/nvidia/*/lib | tr ' ' ':')"`;
const BLIP_PY = '/opt/photo-upscale/.venv/bin/python';   // has torch cu128 + transformers
const BLIP_SCRIPT = '/opt/imagegen-tagger/blip_caption.py';
const BLIP_MODEL_DIR = '/imagegen/blip/hf-large';
// Instructed natural-language captioner. Sends each image to the AI-Lab proxy's vision model
// rather than a local captioner, so the caption can actually be STEERED (material, how light
// behaves on it, cut, view) instead of the generic scene description BLIP tops out at — on the
// red-satin set BLIP produced "a woman in a pink bikini" (it collapsed a pink tube top and the
// red garment) and elsewhere omitted the garment entirely. ~3s/image, so ~4 min for 90 images.
// Runs under the same venv as BLIP (it only needs PIL + stdlib http).
const VLM_SCRIPT = '/opt/imagegen-tagger/vlm_caption.py';
// The 9B this used to name was retired; the name kept answering only because the proxy fell
// back to the EXTERNAL backup, so training images were being captioned off-box (2026-10-04).
const VLM_MODEL = process.env.IMAGEGEN_VLM_MODEL || 'Qwen3.8-27B-INT8-MM-8_Slot-Think_Preserve-256k';
const VLM_API = process.env.IMAGEGEN_VLM_API || 'http://10.0.0.219:17890/api/proxy/llm/v1/chat/completions';
// CUDA numbers devices by FASTEST_FIRST unless told otherwise, under which index 4 is a
// 5060 Ti and the 4090 is index 0 -- i.e. the exact inverse of what TAGGER_GPU_INDEX means.
// Pin the order so the index below refers to the card its comment names.
const CUDA_ORDER = 'CUDA_DEVICE_ORDER=PCI_BUS_ID';
// Default only — POST /auto-caption accepts a per-request gpu_index. Index 4 = the RTX 4090
// in PCI order. The 5060 Tis (Blackwell, sm_120) DO work: onnxruntime-gpu 1.29.0 ran the real
// wd-eva02 model on device 3 (verified 2026-09-02) — the earlier “CUDA EP n/a” claim was a
// missing-LD_LIBRARY_PATH failure wearing an unsupported-arch costume (see ONNX_LD above).
const TAGGER_GPU_INDEX = 4;
const captionJobs = new Map();   // jobId -> { state, total, done, wrote, skipped, errors, ... }

// Widened 2026-07-28 from .../training_images to the whole imagegen tree so agents
// can inspect outputs (/imagegen/outputs) and the example images shipped alongside
// models/LoRAs — not just curation training sets. Relative paths are now rooted at
// /imagegen, so TAGGER_REMOTE and agent_path below must match this root exactly.
// NOTE: this root is GLOBAL — the routes are caller-anonymous, so every agent gets
// the same view. Per-agent roots are a later piece of work.
const BASE = '/ai-assets/imagegen';
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

// Videos arrive here the same way images do — the Immich tag sync copies whatever carries a
// watched tag, and 7,999 of them were already on disk and INVISIBLE in the browser because
// every listing path was gated on isImage(). They are listed alongside images rather than in
// a separate pane: they live in the same folders and the point is to pull frames OUT of them
// into those folders.
const VID_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi']);
const VID_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
                   '.mkv': 'video/x-matroska', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo' };

function isVideo(name) {
  return VID_EXT.has(path.extname(name).toLowerCase());
}

/** Where a video's cached poster lives.
 *
 *  ONE definition, shared by /vthumb and the background sweep. If these two ever derived the
 *  path separately the sweep would cheerfully fill a cache the request path never reads, and
 *  the only symptom would be that pre-warming silently did nothing.
 */
function posterPathFor(file) {
  return path.join(path.dirname(file), '.vthumb', path.basename(file) + '.jpg');
}

/** A poster is usable only if it was made from THIS EXACT version of the clip.
 *
 *  makePoster stamps the poster's mtime to match its source, so freshness is EQUALITY, not
 *  ">= the source". The old `>=` test asked "was this poster made after the file" -- which is
 *  true for any OLDER file later dropped at the same path, and mv/cp -p/rsync -t all preserve
 *  mtime. Replacing a clip with an older one therefore served the previous video's frame.
 *  1s of tolerance because filesystem timestamp precision is not guaranteed to survive a
 *  round-trip through utimesSync.
 */
function posterFresh(file, cache) {
  try {
    if (!existsSync(cache)) return false;
    return Math.abs(statSync(cache).mtimeMs - statSync(file).mtimeMs) < 1000;
  } catch { return false; }
}

/** Generate one poster frame.
 *
 *  -ss BEFORE -i seeks by keyframe, which is fast and good enough for a poster. 1s in, because
 *  frame 0 of a lot of clips is black. -update 1 tells the image2 muxer this is a single still
 *  and not a numbered sequence; without it ffmpeg writes the file but warns, which makes a real
 *  failure harder to spot.
 *
 *  `polite` runs it behind everything else on the box. The sweep sets it; /vthumb does NOT,
 *  because somebody is waiting on that one.
 */
function makePoster(file, opts, cb) {
  const cache = posterPathFor(file);
  try { mkdirSync(path.dirname(cache), { recursive: true }); } catch { /* ignore */ }
  const polite = !!(opts && opts.polite);
  // `seek` seconds in, because frame 0 of a lot of clips is black. But -ss past the end of a
  // SHORT clip makes ffmpeg encode nothing at all ("Output file is empty"), which is why every
  // sub-second LoRA preview loop under diffusion-models/ failed. So try 1s, then frame 0.
  const attempt = (seek, then) => {
    const args = (seek ? ['-y', '-ss', String(seek)] : ['-y'])
      .concat(['-i', file, '-frames:v', '1', '-update', '1',
               '-vf', `scale=${THUMB_PX}:-2`, '-q:v', '4', cache]);
    const bin = polite ? 'nice' : 'ffmpeg';
    const argv = polite ? ['-n', '19', 'ffmpeg'].concat(args) : args;
    // The file on disk is the verdict, in BOTH directions. ffmpeg exits non-zero for mere
    // warnings, and -- the case that crashed this route -- exits ZERO while writing nothing
    // when -ss lands past the end of a short clip. Never report success without the file.
    execFile(bin, argv, { timeout: 20000 }, (err) => {
      if (!existsSync(cache)) return then(err || new Error('ffmpeg produced no output'));
      // Stamp the poster with its source's mtime — this IS the cache key that posterFresh
      // compares, so a poster that cannot be stamped must not be left looking valid.
      try {
        const st = statSync(file);
        utimesSync(cache, st.atime, st.mtime);
      } catch (e) {
        try { unlinkSync(cache); } catch { /* ignore */ }
        return then(new Error(`could not stamp poster mtime: ${e.message}`));
      }
      then(null);
    });
  };
  attempt(1, (err) => {
    if (!err) return cb(null, cache);
    attempt(0, (err2) => cb(err2 || null, cache));
  });
}

// ---- background poster pre-warm -------------------------------------------------------
// Walks the whole imagegen tree and generates every missing poster, so browsing a video
// folder is never the thing that pays for it. Idempotent and resumable: the posters ARE the
// state, so an interrupted sweep just finds less to do next time.
const SWEEP_CONCURRENCY = Number(process.env.IMAGEGEN_POSTER_CONCURRENCY || 2);
const posterSweep = {
  state: 'idle', scanned: 0, total: 0, done: 0, made: 0, failed: 0, pruned: 0,
  startedAt: null, finishedAt: null, current: null, lastError: null,
};
let sweepStop = false;
// A clip ffmpeg genuinely cannot read would otherwise be retried on every pass, forever.
// Process-lifetime only, so a restart gives each one a fresh chance.
const sweepFailed = new Set();

function walkVideos(dir, out, stats) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;   // skips .vthumb itself, and every other dot-dir
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkVideos(p, out, stats);
    else if (e.isFile() && isVideo(e.name)) out.push(p);
  }
  if (stats) pruneOrphanPosters(dir, ents, stats);
  return out;
}

/** Delete posters whose video is gone.
 *
 *  A poster lives beside its clip in `<dir>/.vthumb/<name>.jpg`, so moving or deleting the video
 *  strands it. Moving aniaspoison's 235 clips into a videos/ subfolder stranded 235 in one go,
 *  and the tree had accumulated 1,329 before anything pruned.
 *
 *  🛑 This DELETES. `ents` is the parent listing the caller already read successfully, so absence
 *  is proven from a read that WORKED — if that read had failed the caller returns before getting
 *  here, and an unreadable directory is never mistaken for an empty one. Only `.jpg` files
 *  directly inside `.vthumb/` are ever touched, and they are a regenerable cache.
 */
function pruneOrphanPosters(dir, ents, stats) {
  const cacheDir = path.join(dir, '.vthumb');
  if (!existsSync(cacheDir)) return;
  let cached;
  try { cached = readdirSync(cacheDir); } catch { return; }
  const present = new Set(ents.filter((e) => e.isFile()).map((e) => e.name));
  for (const c of cached) {
    if (!c.endsWith('.jpg')) continue;
    if (present.has(c.slice(0, -4))) continue;
    try { unlinkSync(path.join(cacheDir, c)); stats.pruned += 1; }
    catch { /* a poster we cannot remove is harmless — it just stays */ }
  }
}

function runPosterSweep() {
  if (posterSweep.state === 'running') return posterSweep;
  sweepStop = false;
  Object.assign(posterSweep, {
    state: 'running', scanned: 0, total: 0, done: 0, made: 0, failed: 0, pruned: 0,
    startedAt: Date.now(), finishedAt: null, current: null, lastError: null,
  });

  // Walk up front so `total` is a real denominator instead of a running guess. The tree is
  // local ZFS (~1600 dirs, measured 0.15s), so this is not the expensive part -- ffmpeg is.
  const all = walkVideos(BASE, [], posterSweep);
  posterSweep.scanned = all.length;
  const todo = all.filter((f) => !sweepFailed.has(f) && !posterFresh(f, posterPathFor(f)));
  posterSweep.total = todo.length;

  if (!todo.length) {
    // Still a real pass: the walk above pruned orphans even with nothing to generate.
    Object.assign(posterSweep, { state: 'done', finishedAt: Date.now() });
    if (posterSweep.pruned) console.log(`[imagegen] poster sweep: ${posterSweep.pruned} orphans pruned, nothing to generate`);
    return posterSweep;
  }
  console.log(`[imagegen] poster sweep: ${todo.length} of ${all.length} videos need a poster`);

  let idx = 0;
  const worker = () => new Promise((resolve) => {
    const next = () => {
      if (sweepStop || idx >= todo.length) return resolve();
      const file = todo[idx++];
      posterSweep.current = path.relative(BASE, file);
      makePoster(file, { polite: true }, (err) => {
        posterSweep.done += 1;
        if (err) {
          posterSweep.failed += 1;
          sweepFailed.add(file);
          posterSweep.lastError = `${path.basename(file)}: ${err.message}`;
        } else {
          posterSweep.made += 1;
        }
        // setImmediate, not recursion: a 12k-item queue must not starve the event loop.
        setImmediate(next);
      });
    };
    next();
  });

  Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker)).then(() => {
    Object.assign(posterSweep, {
      state: sweepStop ? 'stopped' : 'done', finishedAt: Date.now(), current: null,
    });
    console.log(`[imagegen] poster sweep ${posterSweep.state}: ${posterSweep.made} made, `
      + `${posterSweep.failed} failed, ${posterSweep.pruned} orphans pruned, `
      + `of ${posterSweep.scanned} videos`);
  });
  return posterSweep;
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
// A training BATCH is the assembly the trainer actually eats: images COPIED (never moved)
// out of many curated sets into one folder. Same naming convention as sets, batch spelling.
const isTrainingBatchName = (n) => n === 'training_batch' || n.startsWith('training_batch_');
// The square size every training image is cropped to here.
const CROP_TARGET = 1024;
// A batch SUBSECTION is kohya's <repeats>_<concept> convention (20_blue) directly inside a
// training batch: kohya reads the prefix as per-epoch repeats; AI Toolkit ignores the names.
const isSubsectionName = (n) => /^\d+_.+/.test(n);
const subsectionParts = (n) => { const m = /^(\d+)_(.+)$/.exec(n); return m ? { repeats: parseInt(m[1], 10), concept: m[2] } : null; };
/** cwd may be the batch root or a subsection inside it → the batch root, or null. */
const batchRootOf = (dir) => {
  if (isTrainingBatchName(path.basename(dir))) return dir;
  const parent = path.dirname(dir);
  if (isSubsectionName(path.basename(dir)) && isTrainingBatchName(path.basename(parent))) return parent;
  return null;
};
// A path is INSIDE a training set when one of its segments is a training-set folder.
const TS_GUARD = /(^|\/)training_set(_[^/]+)?\//;
// Crop and reset are allowed in a training BATCH too: both are ordinary in-place edits on
// a copy, and a batch is exactly as much a working area as a set is.
const EDITABLE_GUARD = /(^|\/)(training_set|training_batch)(_[^/]+)?\//;

// ---- WHERE DELETION IS ALLOWED -------------------------------------------------
// BASE is the WHOLE /imagegen tree (widened 2026-07-28), which includes checkpoints/,
// loras/, vae/, text-encoders/ and ~80 other model roots holding terabytes of weights.
// A recursive delete rooted there is not a curation feature, it is a way to lose the
// model library to one bad path. So deletion is allow-listed to the folders this
// browser exists to curate. Everything else refuses BY NAME, so a refusal says what to
// do rather than looking like a bug.
const DELETABLE_ROOTS = new Set([
  'training_images', '_batches', '_merged', '_incoming', '_datasets', '_transfer',
  'training', 'outputs', 'overnight', 'photo-upscaled', '_quarantine', '_delete', 'temp',
]);
/**
 * Throws unless `abs` is a path we are willing to MODIFY DESTRUCTIVELY (delete, or move
 * out of). Used by both, so its messages stay operation-neutral.
 * Refuses BASE itself and every top-level root: the shallowest deletable thing is one
 * level INSIDE an allow-listed root (training_images/foo), never the root itself.
 */
function assertDeletable(abs) {
  const rel = path.relative(BASE, abs);
  if (!rel || rel.startsWith('..')) throw new Error('the imagegen root itself cannot be moved or deleted');
  const parts = rel.split(path.sep);
  if (!DELETABLE_ROOTS.has(parts[0])) {
    throw new Error(`'${parts[0]}' is outside the curation area — it holds models, so it is not moveable or deletable here. `
      + `Allowed roots: ${[...DELETABLE_ROOTS].sort().join(', ')}`);
  }
  if (parts.length < 2) {
    throw new Error(`the top-level '${parts[0]}' folder itself cannot be moved or deleted — act on something inside it`);
  }
  return rel;
}

// A folder's preview image. Auto-picked unless the folder carries a .preview file
// naming one (dot-prefixed, so browse/counts/merge never see it).
const PREVIEW_MARKER = '.preview';
/** The manually-pinned preview filename for a folder, or '' if none/stale. */
function pinnedPreview(dir) {
  try {
    const name = readFileSync(path.join(dir, PREVIEW_MARKER), 'utf8').trim();
    if (name && !name.includes('/') && !name.includes('..') && isImage(name)
        && existsSync(path.join(dir, name))) return name;
  } catch { /* no marker */ }
  return '';
}
/**
 * Pick a representative image for a folder tile: the pinned one, else the first image
 * directly inside, else the first image one level down (a folder of subfolders is the
 * common shape here and would otherwise show nothing). Returns a BASE-relative path
 * for /thumb, or '' if the subtree has no image within reach.
 * Deliberately shallow: browse already stats every child, and an unbounded descent
 * would make listing a large tree quadratic.
 */
function folderPreview(dir) {
  const pin = pinnedPreview(dir);
  if (pin) return path.relative(BASE, path.join(dir, pin));
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  const names = entries.filter((e) => !e.name.startsWith('.'));
  const direct = names.filter((e) => e.isFile() && isImage(e.name) && !isCollageFile(e.name))
                      .map((e) => e.name).sort();
  if (direct.length) return path.relative(BASE, path.join(dir, direct[0]));
  const subs = names.filter((e) => e.isDirectory()).map((e) => e.name).sort().slice(0, 6);
  for (const sd of subs) {
    const sp = path.join(dir, sd);
    const pinSub = pinnedPreview(sp);
    if (pinSub) return path.relative(BASE, path.join(sp, pinSub));
    let kids;
    try { kids = readdirSync(sp, { withFileTypes: true }); } catch { continue; }
    const img = kids.filter((e) => e.isFile() && !e.name.startsWith('.')
                                   && isImage(e.name) && !isCollageFile(e.name))
                    .map((e) => e.name).sort()[0];
    if (img) return path.relative(BASE, path.join(sp, img));
  }
  return '';
}

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

// ---- GPU RESERVATIONS FOR BUILT-IN JOBS ------------------------------------------------------
// Travis, 2026-10-11: a built-in AI-Lab job (watermark removal first) reserves the GPUs it runs on. Reserving
// unloads whatever the job does not need from those cards - PINNED models included ("built-in AI-Lab processes
// override everything") - and while it is held nothing else may place work there. On release, pinned models
// are reloaded first, then everything else that was on the cards. Models the job needs stay loaded.
// The hard "nobody else" part is the service core's POST /reservations (claude2); until a service answers it,
// the reservation is SOFT (cards are cleared and the job is bound to them, but other clients could still land).
// Snapshots are written to disk so a crash / restart mid-job still restores the cards (resumeReservations()).
const RES_DIR = process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data';
const RES_FILE = path.join(RES_DIR, 'gpu-reservations.json');
const resLive = new Map();     // id -> handle

function imsServiceList() {
  try {
    const a = JSON.parse(readFileSync(path.join(RES_DIR, 'active-services.json'), 'utf8'));
    return Object.values(a.services || {}).filter((s) => s && s.providerId === 'imagegen-models' && s.containerIp && s.port && !s.suspended);
  } catch (e) { console.warn(`[gpu-reserve] active-services.json unreadable: ${e.message}`); return []; }
}
const svcBase = (id) => { const s = imsServiceList().find((x) => x.id === id); return s ? `http://${s.containerIp}:${s.port}` : null; };
async function svcGet(base, p) {
  const r = await fetch(base + p, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}
async function svcPost(base, p, body, timeoutMs = 120000) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${p}: ${j.error || `HTTP ${r.status}`}`);
  return j;
}
function resSave() {
  try {
    const out = {};
    for (const [id, h] of resLive) out[id] = { owner: h.owner, targets: h.targets, snapshot: h.snapshot, core: h.core, at: h.at };
    writeFileSync(RES_FILE, JSON.stringify(out, null, 2));
  } catch (e) { console.warn(`[gpu-reserve] could not save ${RES_FILE}: ${e.message}`); }
}
function friendlyGpuNames() {
  const out = {};
  try {
    const cfg = JSON.parse(readFileSync(path.join(RES_DIR, 'gpu-config.json'), 'utf8'));
    for (const v of Object.values(cfg)) if (v && v.uuid && v.friendlyName) out[String(v.uuid).replace(/^GPU-/i, '').toLowerCase()] = v.friendlyName;
  } catch { /* names are cosmetic */ }
  return out;
}

/** Every Image Model Service GPU, for pickers: [{service, node, gpu, name, total_gb, free_gb, busy, models[], reservedBy}] */
async function reservableGpus() {
  const names = friendlyGpuNames();
  const out = [];
  for (const s of imsServiceList()) {
    const base = `http://${s.containerIp}:${s.port}`;
    let m;
    try { m = await svcGet(base, '/models'); } catch { continue; }
    const reservations = m.reservations || [];
    for (const g of (m.service && m.service.gpus) || []) {
      const on = (m.resident || []).filter((r) => (r.gpus && r.gpus.length ? r.gpus : [r.gpu]).includes(g.index))
        .map((r) => ({ kind: r.kind, name: r.name, pinned: !!r.pinned, plugin: r.plugin || null }));
      const res = reservations.find((x) => (x.gpus || []).includes(g.index)) || [...resLive.values()].find((h) => h.targets.some((t) => t.service === s.id && t.gpu === g.index));
      out.push({ service: s.id, node: s.node, gpu: g.index, name: names[String(g.uuid || '').toLowerCase()] || g.name, total_gb: g.total_gb, free_gb: g.free_gb,
                 busy: !!g.busy, models: on, reservedBy: res ? (res.owner || res.note || 'a job') : null });
    }
  }
  return out;
}

/**
 * Reserve targets [{service, gpu}] for `owner`. keep = [{kind, name}] the job needs (left loaded if already there).
 * -> handle {id, owner, targets, snapshot, core: {service: reservationId}}
 */
async function reserveGpus(owner, targets, keep, note) {
  const id = `${owner}-${crypto.randomBytes(3).toString('hex')}`;
  const h = { id, owner, targets, snapshot: [], core: {}, at: Date.now(), timer: null };
  const bySvc = {};
  for (const t of targets) (bySvc[t.service] = bySvc[t.service] || []).push(t.gpu);
  const keepKey = new Set(keep.map((k) => `${k.kind}|${k.name}`));
  for (const [service, gpus] of Object.entries(bySvc)) {
    const base = svcBase(service);
    if (!base) throw new Error(`no running Image Model Service ${service}`);
    // 1. the hard reservation (core, claude2) - soft if this service does not have it yet
    try {
      const r = await svcPost(base, '/reservations', { owner, gpus, note: note || owner, ttl_s: 600 });
      if (r.id) h.core[service] = r.id;
    } catch (e) {
      console.warn(`[gpu-reserve] ${service}: no core reservation (${e.message}) - SOFT reservation: cards cleared + job bound, others not excluded`);
    }
    // 2. snapshot what is on each reserved card
    const m = await svcGet(base, '/models');
    for (const r of m.resident || []) {
      const on = (r.gpus && r.gpus.length ? r.gpus : [r.gpu]);
      if (!on.some((g) => gpus.includes(g))) continue;
      h.snapshot.push({ service, kind: r.kind, name: r.name, clip_type: r.clip_type || null, gpu: on[0], gpus: on, pinned: !!r.pinned,
                        plugin: r.plugin || null, keep: keepKey.has(`${r.kind}|${r.name}`) && !r.plugin && on.length === 1 });
    }
  }
  resLive.set(id, h); resSave();
  // 3. clear: everything the job does not need leaves the reserved cards (pins are lifted first - built-in jobs win)
  for (const x of h.snapshot) {
    if (x.keep) continue;
    const base = svcBase(x.service);
    const ct = x.clip_type ? { clip_type: x.clip_type } : {};
    try {
      if (x.plugin === 'te_split') { await svcPost(base, '/te_split/remove', { model: x.name }); continue; }
      if (x.pinned) await svcPost(base, '/models/pin', { kind: x.kind, name: x.name, gpu: x.gpu, pinned: false, ...ct });
      await svcPost(base, '/models/unload', { kind: x.kind, name: x.name, gpu: x.gpu, ...ct, ...(h.core[x.service] ? { reservation: h.core[x.service] } : {}) });
    } catch (e) { console.warn(`[gpu-reserve] ${id}: could not clear ${x.kind} ${x.name} from GPU ${x.gpu}: ${e.message}`); }
  }
  // 4. keep the core reservation alive while the job runs (its TTL frees the cards if AI-Lab dies)
  // Core reservations are NOT persisted: a service restart drops them (claude2). A failed touch re-reserves the same
  // cards, and streams read h.core[service] at each call, so they carry the new id.
  h.timer = setInterval(() => {
    for (const [service, rid] of Object.entries(h.core)) {
      const base = svcBase(service);
      if (!base) continue;
      svcPost(base, `/reservations/${encodeURIComponent(rid)}/touch`, { ttl_s: 600 }).catch(async (e) => {
        console.warn(`[gpu-reserve] touch ${rid}: ${e.message} - re-reserving`);
        try {
          const r = await svcPost(base, '/reservations', { owner: h.owner, gpus: h.targets.filter((t) => t.service === service).map((t) => t.gpu), note: note || h.owner, ttl_s: 600 });
          if (r.id) { h.core[service] = r.id; resSave(); console.log(`[gpu-reserve] ${h.id}: re-reserved on ${service} as ${r.id}`); }
        } catch (e2) { console.warn(`[gpu-reserve] ${h.id}: re-reserve on ${service} failed: ${e2.message}`); }
      });
    }
  }, 60000);
  console.log(`[gpu-reserve] ${id}: reserved ${targets.map((t) => `${t.service}:${t.gpu}`).join(', ')} (${Object.keys(h.core).length ? 'core' : 'SOFT'}); `
    + `cleared ${h.snapshot.filter((x) => !x.keep).length}, kept ${h.snapshot.filter((x) => x.keep).length}`);
  return h;
}

/** Release + restore: pinned models first, then split encoders, then everything else that was on the cards. */
async function releaseGpus(h) {
  if (!h) return;
  if (h.timer) clearInterval(h.timer);
  for (const [service, rid] of Object.entries(h.core || {})) {
    const base = svcBase(service);
    if (base) await svcPost(base, `/reservations/${encodeURIComponent(rid)}/release`, {}).catch((e) => console.warn(`[gpu-reserve] release ${rid}: ${e.message}`));
  }
  const back = (h.snapshot || []).filter((x) => !x.keep);
  const order = [...back.filter((x) => x.pinned), ...back.filter((x) => !x.pinned && x.plugin === 'te_split'), ...back.filter((x) => !x.pinned && x.plugin !== 'te_split')];
  for (const x of order) {
    const base = svcBase(x.service);
    if (!base) continue;
    const ct = x.clip_type ? { clip_type: x.clip_type } : {};
    try {
      if (x.plugin === 'te_split') await svcPost(base, '/te_split', { model: x.name, clip_type: x.clip_type || 'qwen_image', gpus: x.gpus }, 300000);
      else if (x.plugin) continue;   // other plugin-held copies come back on their own use
      else if (x.pinned) await svcPost(base, '/models/pin', { kind: x.kind, name: x.name, gpu: x.gpu, pinned: true, ...ct });
      else await svcPost(base, '/models/load', { kind: x.kind, name: x.name, gpu: x.gpu, ...ct });
    } catch (e) { console.warn(`[gpu-reserve] ${h.id}: could not restore ${x.kind} ${x.name} on GPU ${x.gpu}: ${e.message}`); }
  }
  resLive.delete(h.id); resSave();
  console.log(`[gpu-reserve] ${h.id}: released; restored ${order.length} model(s) (${order.filter((x) => x.pinned).length} pinned first)`);
}

/** After a restart: anything still in the snapshot file was never released - release + restore it now. */
async function resumeReservations() {
  let saved = {};
  try { if (existsSync(RES_FILE)) saved = JSON.parse(readFileSync(RES_FILE, 'utf8')); } catch (e) { console.warn(`[gpu-reserve] ${RES_FILE} unreadable: ${e.message}`); }
  for (const [id, h] of Object.entries(saved)) {
    console.log(`[gpu-reserve] ${id} was still held at startup - releasing and restoring its cards`);
    resLive.set(id, { ...h, id, timer: null });
    await releaseGpus(resLive.get(id)).catch((e) => console.warn(`[gpu-reserve] resume ${id}: ${e.message}`));
  }
}

// ---- WATERMARK REMOVAL (native) ---------------------------------------------------
// Travis, 2026-10-10: a baked-in tool, NOT a ComfyUI workflow - "relying on ComfyUI just adds a weak link".
// The edit itself (prompt enhancer -> Qwen Image 2.1 edit with the image as reference -> VAE) runs inside an
// Image Model Service, which already holds the models; this side picks the service, then pastes the result
// back onto the ORIGINAL at full resolution and keeps an undo copy.
//
// Undo, per image, two dot-dirs beside it (they travel with renames / subsection moves / deletes like .orig):
//   .prewm/<name>  the pristine pre-removal original. Written once, never overwritten by a later run.
//   .wmalt/<name>  the cleaned version, present ONLY while the original is the one on display (after a swap).
// So "cleaned is showing" = .prewm exists and .wmalt does not. A re-run on a cleaned image refines it and
// leaves .prewm alone; a re-run after swapping back starts again from the original.
const WM_ORIG = '.prewm';
const WM_ALT = '.wmalt';
const WM_ROUTE = '/qwen_edit';              // the Image Model Service route that runs the edit
const WM_STEPS = 35;                         // Travis's workflow: euler / simple, cfg 1, 35 steps
// The models a watermark stream uses - kept loaded on reserved cards (qwen_edit's defaults + the SeedVR2 restore)
const WM_KEEP = [{ kind: 'unet', name: 'Qwen_2.1/qwen_image_2.1_int8_convrot.safetensors' }, { kind: 'vae', name: 'Qwen_2.1/qwen_image_2.1_vae_bf16.safetensors' }];
const WM_SEEDVR2 = { kind: 'seedvr2', name: 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors' };
const WM_LORAS = [['Qwen_2.1/Edit-TOOL-Image_Consistency-Edits_That_Dont_Move-V1.0-3364470.safetensors', 1.0]];
export const WM_DEFAULT_PROMPT = 'Remove every watermark, signature, logo, website address and overlaid text from the image. '
  + 'Fill the vacated areas seamlessly so they match their surroundings. Change nothing else.';
// Paste-back: where the edit actually changed the picture. The VAE round trip + resize leave a faint
// everywhere-difference (median ~2/255, measured on Travis's run); a watermark is tens of levels.
// 9, not 14: Travis's test image carries a SEMI-TRANSPARENT script mark whose blurred difference sits at ~8-10;
// 14 left half of it behind. At 9 the mask still stays on the marks (quiet regions <2% masked). One image so far - tune here.
const WM_THRESH = 9;           // blurred mean-abs difference (0-255) that counts as "changed here"
const WM_FULL_PCT = 40;        // more than this much of the frame changed = the edit moved the image; use it whole

const wmJobs = new Map();      // id -> job (see POST /watermark)
let wmChain = Promise.resolve();   // jobs run one after another: they share the same GPUs

/** Image Model Services that serve the edit route, best first: the edit UNet resident + idle, then any. */
async function wmServices() {
  let svcs = [];
  try {
    const a = JSON.parse(readFileSync(path.join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'active-services.json'), 'utf8'));
    svcs = Object.values(a.services || {}).filter((s) => s && s.providerId === 'imagegen-models' && s.containerIp && s.port && !s.suspended);
  } catch (e) { console.warn(`[watermark] active-services.json unreadable: ${e.message}`); }
  const probed = await Promise.all(svcs.map(async (s) => {
    const base = `http://${s.containerIp}:${s.port}`;
    try {
      const r = await fetch(base + WM_ROUTE, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return null;
      const info = await r.json().catch(() => ({}));
      // The service core answers ANY unknown GET with its /status page and HTTP 200, so 200 alone proved nothing
      // (9310, without the plugin, was listed as able to edit). Only the plugin's own reply carries `unet`.
      if (!info || info.ok !== true || !info.unet) return null;
      return { base, id: s.id, rank: info.resident ? (info.busy ? 1 : 0) : 2, info };
    } catch { return null; }
  }));
  return probed.filter(Boolean).sort((a, b) => a.rank - b.rank);
}

/** One image through the service: -> { png: Buffer (the edit at the model's resolution), prompt, service }. */
async function wmEdit(rel, prompt, seed, opt = {}) {
  let s;
  if (opt.target) {      // a reserved card: that service, that GPU
    const base = svcBase(opt.target.service);
    if (!base) throw new Error(`reserved service ${opt.target.service} is not running`);
    s = { base, id: opt.target.service };
  } else {
    const svcs = await wmServices();
    if (!svcs.length) {
      throw new Error(`no Image Model Service serves ${WM_ROUTE} yet - the watermark pipeline plugin is not deployed on any imagegen-models service`);
    }
    s = svcs[0];
  }
  const bind = opt.target ? { gpu: opt.target.gpu, ...(opt.reservation ? { reservation: opt.reservation } : {}) } : {};
  const r = await fetch(s.base + WM_ROUTE, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // path is relative to the shared /imagegen root, which every GPU host mounts at the same place
    body: JSON.stringify({ path: rel, prompt, enhance: true, seed, steps: WM_STEPS, loras: WM_LORAS, who: 'ai-lab:watermark', ...bind }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`${s.id}: ${j.error || `HTTP ${r.status}`}`);
  }
  const j = await r.json();
  if (!j.image) throw new Error(`${s.id}: answered without an image`);
  return { png: Buffer.from(j.image, 'base64'), prompt: j.prompt || '', service: s.id };
}

// The edit comes back at ~1 MP. When the original is clearly bigger, SeedVR2 (claude2's seedvr2 plugin on the
// Image Model Service) upscales the edit first, so the repaired regions carry real detail instead of a stretched
// patch; then the paste-back below takes only those regions. Capped: past this the last step is a plain resize.
const WM_UPSCALE_RATIO = 1.3;     // original's shortest edge / the edit's, above which SeedVR2 runs
const WM_UPSCALE_MAX = 2160;      // shortest-edge cap for the SeedVR2 pass

/** -> PNG Buffer from SeedVR2 at `short` px shortest edge, on a service offering the seedvr2 kind. */
async function wmUpscale(png, short, seed, opt = {}) {
  let svcs = [];
  try {
    const a = JSON.parse(readFileSync(path.join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'active-services.json'), 'utf8'));
    svcs = Object.values(a.services || {}).filter((s) => s && s.providerId === 'imagegen-models' && s.containerIp && s.port && !s.suspended);
  } catch (e) { throw new Error(`active-services.json unreadable: ${e.message}`); }
  let base = opt.target ? svcBase(opt.target.service) : null;
  for (const s of (base ? [] : svcs)) {
    try {
      const r = await fetch(`http://${s.containerIp}:${s.port}/models`, { signal: AbortSignal.timeout(3000) });
      const m = r.ok ? await r.json() : null;
      if (m && ((m.service && m.service.kinds) || []).includes('seedvr2')) { base = `http://${s.containerIp}:${s.port}`; break; }
    } catch { /* unreachable: next */ }
  }
  if (!base) throw new Error('no Image Model Service offers seedvr2');
  const r = await fetch(`${base}/seedvr2/upscale`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // seed sent explicitly: the route documents it as optional but failed without one (2026-10-10)
    body: JSON.stringify({ image: png.toString('base64'), resolution: short, seed,
      ...(opt.target ? { gpu: opt.target.gpu, ...(opt.reservation ? { reservation: opt.reservation } : {}) } : {}) }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `seedvr2 HTTP ${r.status}`); }
  return Buffer.from(await r.arrayBuffer());
}

/** How many images a watermark job runs at once: the number of SeedVR2 copies loaded across the Image Model
 *  Services (each is its own worker process on its own card), capped at WM_PARALLEL_MAX; 1 when none is loaded. */
const WM_PARALLEL_MAX = 4;
async function wmParallel() {
  let n = 0;
  try {
    const a = JSON.parse(readFileSync(path.join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'active-services.json'), 'utf8'));
    const svcs = Object.values(a.services || {}).filter((s) => s && s.providerId === 'imagegen-models' && s.containerIp && s.port && !s.suspended);
    for (const s of svcs) {
      try {
        const r = await fetch(`http://${s.containerIp}:${s.port}/models`, { signal: AbortSignal.timeout(3000) });
        const m = r.ok ? await r.json() : null;
        n += ((m && m.resident) || []).filter((x) => x.kind === 'seedvr2').length;
      } catch { /* unreachable: counts as no copies */ }
    }
  } catch (e) { console.warn(`[watermark] could not count seedvr2 copies: ${e.message}`); }
  return Math.max(1, Math.min(n, WM_PARALLEL_MAX));
}

/** Encode a sharp pipeline in the file's own format (same rules as crop / upscale). */
function wmEncodeLike(file, pipe) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return pipe.png().toBuffer();
  if (ext === '.webp') return pipe.webp({ quality: 95 }).toBuffer();
  return pipe.jpeg({ quality: 95 }).toBuffer();
}

/**
 * Put the cleaned pixels back onto the ORIGINAL, only where the edit changed something.
 * The edit runs at ~1 MP and can squash the aspect a little; pasting the whole thing would cost every
 * image its resolution and detail. So: scale the edit to the original's size, find the regions that
 * differ (blurred difference over WM_THRESH), grow + feather that mask, and blend. Everywhere else the
 * original's own pixels stay. -> { buf, maskPct, whole }
 * `fill` (optional): where the pasted pixels come FROM - the SeedVR2-upscaled edit. The mask is still measured on
 * the plain edit: SeedVR2 sharpens and shifts colour across the whole frame, and measuring on it marked 21% of
 * the test image as changed instead of 7.5% (2026-10-10).
 */
export async function wmPasteBack(file, png, fill = null) {
  const meta = await sharp(file).metadata();
  const W = meta.width, H = meta.height, n = W * H;
  const o = await sharp(file).removeAlpha().toColourspace('srgb').raw().toBuffer();
  const c = await sharp(png).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
  const f = fill ? await sharp(fill).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().toColourspace('srgb').raw().toBuffer() : c;
  const raw1 = { raw: { width: W, height: H, channels: 1 } };
  const d = Buffer.alloc(n);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    d[i] = (Math.abs(o[p] - c[p]) + Math.abs(o[p + 1] - c[p + 1]) + Math.abs(o[p + 2] - c[p + 2])) / 3;
  }
  const s1 = Math.max(2, Math.round(Math.max(W, H) / 400));
  // extractChannel(0): sharp hands a 1-channel raw input back as 3-channel sRGB after blur(), which
  // indexed the mask 3x too short and took nothing from the edit (caught in the first test).
  const db = await sharp(d, raw1).blur(s1).extractChannel(0).raw().toBuffer();
  const bin = Buffer.alloc(n); let on = 0;
  for (let i = 0; i < n; i++) if (db[i] > WM_THRESH) { bin[i] = 255; on++; }
  const maskPct = Math.round((on / n) * 1000) / 10;
  let rgb;
  if (maskPct > WM_FULL_PCT) {
    rgb = f;   // the edit changed most of the frame (re-composed, shifted): blending would ghost it
  } else {
    const fb = await sharp(bin, raw1).blur(s1 * 3).extractChannel(0).raw().toBuffer();   // grow + feather
    rgb = Buffer.alloc(n * 3);
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const a = Math.min(1, fb[i] / 96);
      rgb[p] = o[p] + (f[p] - o[p]) * a; rgb[p + 1] = o[p + 1] + (f[p + 1] - o[p + 1]) * a; rgb[p + 2] = o[p + 2] + (f[p + 2] - o[p + 2]) * a;
    }
  }
  let pipe = sharp(rgb, { raw: { width: W, height: H, channels: 3 } });
  if (meta.hasAlpha) pipe = pipe.joinChannel(await sharp(file).extractChannel('alpha').raw().toBuffer(), raw1);
  return { buf: await wmEncodeLike(file, pipe), maskPct, whole: maskPct > WM_FULL_PCT };
}

/** Throws unless rel is an image this tool may rewrite: inside the curation area, a still image. */
function wmCheck(rel) {
  const file = safeResolve(rel);
  const top = path.relative(BASE, file).split(path.sep)[0];
  if (!DELETABLE_ROOTS.has(top)) throw new Error(`${rel}: outside the training-image area`);
  if (!/\.(png|jpe?g|webp)$/i.test(file)) throw new Error(`${rel}: only png / jpg / webp images`);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${rel}: no such file`);
  return file;
}

/** Clean one image in place, keeping the undo copies. -> { maskPct, whole, prompt, service } */
async function wmOne(rel, prompt, opt = {}) {
  const file = wmCheck(rel);
  const dir = path.dirname(file), name = path.basename(file);
  const seed = crypto.randomInt(0, 2 ** 31);
  const ed = await wmEdit(rel, prompt, seed, opt);
  let fill = null, upscaled = false, upscaleError = '';
  const om = await sharp(file).metadata(), em = await sharp(ed.png).metadata();
  const oShort = Math.min(om.width, om.height), eShort = Math.min(em.width, em.height);
  if (opt.upscale !== false && oShort / eShort > WM_UPSCALE_RATIO) {
    try { fill = await wmUpscale(ed.png, Math.min(oShort, WM_UPSCALE_MAX), seed, opt); upscaled = true; } catch (e) {
      upscaleError = String(e.message || e);   // not fatal: the paste-back resizes, the region is just softer
      console.warn(`[watermark] ${rel}: SeedVR2 upscale failed, pasting back a resized edit: ${upscaleError}`);
    }
  }
  const pb = await wmPasteBack(file, ed.png, fill);
  const orig = path.join(dir, WM_ORIG, name), alt = path.join(dir, WM_ALT, name);
  if (!existsSync(orig)) {       // first removal on this image: keep the pristine original
    mkdirSync(path.dirname(orig), { recursive: true });
    copyFileSync(file, orig);
  }
  writeFileSync(file, pb.buf);
  try { chmodSync(file, 0o664); } catch { /* ignore */ }
  try { if (existsSync(alt)) unlinkSync(alt); } catch (e) { console.warn(`[watermark] stale ${alt}: ${e.message}`); }
  return { maskPct: pb.maskPct, whole: pb.whole, prompt: ed.prompt, service: ed.service, upscaled, upscaleError };
}

export function createImagegenRouter(config) {
  const router = Router();
  // AI-Lab: CT152 has no default SSH identity for the tagger host, so pass its managed key explicitly.
  const SSH_KEY = (config && config.keyPath) || process.env.AILAB_SSH_KEY || '';
  // Central Task Progress registry (notifications panel). Caption jobs report their
  // lifecycle here so progress is visible from ANY page — including jobs started by
  // agents through this API, which no browser tab was ever watching. No-op when the
  // registry isn't wired (tests construct this router bare).
  const taskReport = (config && config.taskReport) || (() => {});
  try { mkdirSync(THUMB_DIR, { recursive: true }); } catch { /* ignore */ }
  // GPU reservations a previous run never released (crash / restart mid-job): restore those cards now
  setTimeout(() => { resumeReservations().catch((e) => console.warn(`[gpu-reserve] resume: ${e.message}`)); }, 15000);

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
          // A representative image so the folder renders as a square tile with a
          // picture rather than a bar with a name: you can see what is inside
          // without opening it. '' when the subtree has none within reach.
          preview: folderPreview(path.join(dir, name)),
          preview_pinned: !!pinnedPreview(path.join(dir, name)),
          is_training_set: isTrainingSetName(name), has_training_set: hasTS,
          is_training_batch: isTrainingBatchName(name),
          ...(isTrainingBatchName(path.basename(dir)) && isSubsectionName(name)
            ? { is_batch_subsection: true, ...subsectionParts(name) } : {}),
        });
      } else if (isVideo(name)) {
        images.push({
          name, size: st.size,
          mtime: Math.round(st.mtimeMs),
          ctime: Math.round(st.ctimeMs),
          birthtime: Math.round(st.birthtimeMs || st.ctimeMs),
          is_video: true,
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
      // Videos are skipped: dimsOf() is sharp, which throws on a media container. Their
      // dimensions come from ffprobe in /vthumb, and the grid does not need them to lay out.
      const dims = await mapLimit(images, 16,
        (im) => (im.is_video ? Promise.resolve({ w: 0, h: 0 }) : dimsOf(path.join(dir, im.name))));
      images.forEach((im, k) => { im.w = dims[k].w; im.h = dims[k].h; });
      // Caption sidecars are NOT a training-set mechanic — every captioner writes
      // <image>.txt / <image>.caption next to the image in whatever folder it sits in. These
      // used to live in the isTS branch below, so any folder not literally named training_set*
      // (rule34's slug-named sets, samples, satin) reported has_caption=false for every image
      // while the .txt files were right there. Costs the same 2xN existsSync a training set
      // already paid, and is bounded by the same DIMS_CAP as the dimension reads.
      images.forEach((im) => {
        im.has_caption = existsSync(captionPath(path.join(dir, im.name)));                          // .txt tags
        im.has_nl_caption = existsSync(path.join(dir, im.name).replace(/\.[^/.]+$/, '') + '.caption'); // BLIP/NL
        // Already the training size. The ✓ badge used to mean "differs from its baseline", so an
        // image that ARRIVED square at 1024 — never cropped because it never needed to be — read
        // as outstanding forever, which is backwards for a badge whose job is finding what is
        // left to do.
        im.at_target = im.w === CROP_TARGET && im.h === CROP_TARGET;
      });
      { // Watermark-removal undo state, in ANY folder: one readdir per dot-dir, not a stat per image.
        // wm = 'cleaned' (the removal is showing) | 'original' (swapped back; the cleaned copy is parked).
        const ls = (d) => { try { return new Set(readdirSync(path.join(dir, d))); } catch { return null; } };
        const wo = ls(WM_ORIG);
        if (wo) { const wa = ls(WM_ALT) || new Set(); images.forEach((im) => { if (wo.has(im.name)) im.wm = wa.has(im.name) ? 'original' : 'cleaned'; }); }
      }
      // cropped / has_alt STAY here: both are training-set mechanics. `cropped` compares against
      // the pristine baseline copy, and has_alt reads the .preup upscale dir — neither exists
      // outside a set, so asking for them elsewhere would be a wasted stat per image.
      if (isTS || isTrainingBatchName(path.basename(dir))) {
        const od = await mapLimit(images, 16, (im) => {
          const b = baselinePath(path.join(dir, im.name));
          return b ? dimsOf(b) : Promise.resolve(null);
        });
        images.forEach((im, k) => {
          const o = od[k];
          im.cropped = !!(o && (o.w !== im.w || o.h !== im.h));
          im.has_alt = existsSync(path.join(dir, '.preup', im.name));   // an upscale swap is available
        });
      }
    }
    // Auto-crop outcomes (see /auto-crop). needs_review clears by itself once the image is cropped
    // by hand (or reaches the target size); auto_cropped only shows while the auto crop is in place.
    if (images.length) {
      const ac = loadAutoCrop(dir);
      if (Object.keys(ac).length) {
        images.forEach((im) => {
          const e = ac[im.name]; if (!e) return;
          if (e.status === 'review' && !im.cropped && !im.at_target) im.needs_review = true;
          // NOT `im.cropped` alone: that is only computed for training sets / the batch root, never in
          // a batch subsection, so blue never showed there. A hand crop deletes this record (see /crop)
          // and a restore takes the file off 1024, so "auto record + at target" = still the auto crop.
          if (e.status === 'auto' && (im.cropped || im.at_target)) { im.auto_cropped = true; im.auto_score = e.score; }
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
  /** GET /video?path= — byte-range streaming. Range support is NOT optional: without it the
   *  browser cannot seek, and a <video> element given a non-range response will often refuse
   *  to scrub at all, which makes frame-grabbing useless. */
  router.get('/video', (req, res) => {
    let file;
    try { file = safeResolve(req.query.path); } catch { return res.status(400).end(); }
    if (!existsSync(file) || !statSync(file).isFile() || !isVideo(path.basename(file))) {
      return res.status(404).end();
    }
    const st = statSync(file);
    const type = VID_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // ?download=1 -> attachment under the real filename (range handling below is unchanged).
    if (req.query.download === '1' || req.query.download === 'true') res.attachment(path.basename(file));
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      return createReadStream(file).pipe(res);
    }
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (!(start >= 0 && end < st.size && start <= end)) {
      return res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    });
    createReadStream(file, { start, end }).pipe(res);
  });

  /** GET /vthumb?path= — poster frame, cached in a dot-dir beside the video so browse (which
   *  skips dotfiles) never lists it. Re-extracted when the video is newer than the cache. */
  router.get('/vthumb', (req, res) => {
    let file;
    try { file = safeResolve(req.query.path); } catch { return res.status(400).end(); }
    if (!existsSync(file) || !isVideo(path.basename(file))) return res.status(404).end();
    const cache = posterPathFor(file);
    // 🛑 STREAM IT, DO NOT sendFile(). express/send defaults to dotfiles:'ignore' and 404s any
    // path containing a dot-SEGMENT — and the cache deliberately lives in `.vthumb/` so browse
    // (which skips dotfiles) never lists it. sendFile threw ENOENT-shaped 404s with an HTML body
    // for a file that was demonstrably on disk.
    // An unhandled 'error' on a ReadStream terminates the PROCESS, not the request -- a single
    // missing poster took the whole backend down. Always handle it.
    const serve = () => {
      const s = createReadStream(cache);
      s.on('error', (e) => {
        console.warn(`[imagegen] vthumb read failed for ${path.basename(file)}: ${e.message}`);
        if (!res.headersSent) res.status(404).end(); else res.destroy();
      });
      res.type('image/jpeg');
      s.pipe(res);
    };
    if (posterFresh(file, cache)) return serve();
    // Not polite: this one is blocking a render. The background sweep is the polite caller.
    makePoster(file, { polite: false }, (err) => {
      if (err) {
        console.warn(`[imagegen] vthumb failed for ${path.basename(file)}: ${err.message}`);
        return res.status(404).end();
      }
      serve();
    });
  });

  /** GET /poster-sweep — progress of the background pre-warm. */
  router.get('/poster-sweep', (req, res) => {
    res.json({ ...posterSweep, concurrency: SWEEP_CONCURRENCY, pending: sweepFailed.size });
  });

  /** POST /poster-sweep {action:'start'|'stop'} — kick one off by hand, or call it off. */
  router.post('/poster-sweep', express.json(), (req, res) => {
    const action = String((req.body || {}).action || 'start');
    if (action === 'stop') {
      sweepStop = true;
      return res.json({ ok: true, ...posterSweep, state: 'stopping' });
    }
    return res.json({ ok: true, ...runPosterSweep() });
  });

  /** POST /screenshot — save a frame grabbed client-side from the <video> element.
   *
   *  The frame is captured in the BROWSER (canvas.toDataURL) rather than re-extracted here
   *  with ffmpeg at a timestamp: what gets saved is then exactly the frame that was on screen
   *  when the button was pressed. Seeking to "the same" timestamp server-side lands on a
   *  different frame often enough to be maddening when you are picking a specific moment.
   */
  router.post('/screenshot', express.json({ limit: '32mb' }), (req, res) => {
    const b = req.body || {};
    let video;
    try { video = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(video) || !isVideo(path.basename(video))) {
      return res.status(404).json({ error: 'not a video' });
    }
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
    if (!m) return res.status(400).json({ error: 'data must be a PNG data URL' });
    const buf = Buffer.from(m[1], 'base64');
    if (!buf.length) return res.status(400).json({ error: 'empty image' });
    const dir = path.join(path.dirname(video), 'screenshots');
    try { mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o777); } catch { /* ignore */ }
    // <video stem>-N.png: the source clip stays readable from the filename, which matters when
    // a folder ends up holding grabs from several videos.
    const stem = path.basename(video).replace(/\.[^.]+$/, '');
    let n = 0;
    try {
      for (const f of readdirSync(dir)) {
        const mm = new RegExp('^' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)\\.png$').exec(f);
        if (mm) n = Math.max(n, parseInt(mm[1], 10));
      }
    } catch { /* new folder */ }
    const name = `${stem}-${n + 1}.png`;
    const out = path.join(dir, name);
    try {
      writeFileSync(out, buf);
      try { chmodSync(out, 0o664); } catch { /* best effort */ }
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    console.log(`[imagegen] screenshot ${name} (${(buf.length / 1024).toFixed(0)} KB) from ${path.basename(video)} @ ${b.time ?? '?'}s`);
    res.json({ ok: true, name, dir: path.relative(BASE, dir), rel: path.relative(BASE, out) });
  });

  router.get('/image', async (req, res) => {
    let file;
    try { file = safeResolve(req.query.path); } catch { return res.status(400).end(); }
    if (!existsSync(file) || !statSync(file).isFile()) return res.status(404).end();
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';
    // Optional downscale: ?maxdim=N caps the longest side (fit inside, no enlargement) and returns
    // webp. Used by the agent view_image tool to keep vision-token / KV cost sane on long runs.
    // NB: only clamp when maxdim was ACTUALLY supplied. Folding the floor into the
    // no-param case turns "serve the original" into Math.max(64, 0) === 64, i.e. every
    // full-image request silently came back as a 64px thumbnail (smaller than /thumb).
    // ?download=1 -> the ORIGINAL bytes as an attachment under the real filename. Never combined
    // with maxdim: a "download" that silently handed back a webp thumbnail is the failure to avoid.
    const wantDownload = req.query.download === '1' || req.query.download === 'true';
    if (wantDownload) {
      res.attachment(path.basename(file));
      res.set('Cache-Control', 'no-store');
      res.type(type);
      return createReadStream(file).pipe(res);
    }
    const maxdimRaw = parseInt(String(req.query.maxdim || ''), 10);
    const maxdim = Number.isFinite(maxdimRaw) && maxdimRaw > 0
      ? Math.max(64, Math.min(4096, maxdimRaw))
      : 0;
    if (maxdim) {
      try {
        const buf = await sharp(file).rotate()
          .resize(maxdim, maxdim, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 }).toBuffer();
        res.set('Cache-Control', 'private, max-age=3600');
        res.type('image/webp');
        return res.end(buf);
      } catch { /* fall through to original */ }
    }
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

  /**
   * Crop `rect` (source px) out of `src` and write it, resized to tw x th, to `file`.
   * Shared by the crop editor (/crop) and Auto-crop, so both snapshot and encode identically.
   * `src` is normally `file`; Auto-crop passes the pristine baseline when re-cropping, so a
   * second pass crops the ORIGINAL rather than an already-cropped image.
   * Throws Error with .status for request errors.
   */
  async function cropToTarget(file, rect, tw, th, src = file) {
    const meta = await sharp(src).metadata();
    let left = Math.max(0, Math.round(+rect.left || 0));
    let top = Math.max(0, Math.round(+rect.top || 0));
    let width = Math.round(+rect.width), height = Math.round(+rect.height);
    width = Math.min(width, meta.width - left);
    height = Math.min(height, meta.height - top);
    if (!(width > 0 && height > 0)) throw Object.assign(new Error('bad crop rect'), { status: 400 });
    const ext = path.extname(file).toLowerCase();
    let pipe = sharp(src).extract({ left, top, width, height })
      .resize(tw, th, { fit: 'fill' });
    if (ext === '.png') pipe = pipe.png();
    else if (ext === '.webp') pipe = pipe.webp({ quality: 95 });
    else pipe = pipe.jpeg({ quality: 95 });
    const buf = await pipe.toBuffer();
    // 🛑 SNAPSHOT BEFORE OVERWRITING. A set gets its .orig from send-to-set; a batch has no
    // baseline at all, so without this the first crop in a batch is irreversible and
    // reset-crop has nothing to restore. Taken only once — a second crop must not overwrite
    // the pristine copy with an already-cropped one.
    if (!baselinePath(file)) {
      try {
        const od = path.join(path.dirname(file), '.orig');
        mkdirSync(od, { recursive: true });
        copyFileSync(file, path.join(od, path.basename(file)));
      } catch (e) {
        throw Object.assign(new Error(`could not snapshot the original, refusing to crop: ${String(e.message || e)}`), { status: 500 });
      }
    }
    writeFileSync(file, buf);
    try { chmodSync(file, 0o664); } catch { /* ignore */ }
    return { w: tw, h: th, src: { left, top, width, height } };
  }

  // ---- Crop/resize a training_set working copy (non-destructive: only ever
  // overwrites a file inside a */training_set/ folder; the pristine original
  // lives one level up). Body: { path, left, top, width, height (source px),
  // target_w, target_h }. sharp extracts the region then resizes to target.
  router.post('/crop', express.json(), async (req, res) => {
    const b = req.body || {};
    let file;
    try { file = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!EDITABLE_GUARD.test((b.path || '').replace(/^\/+/, ''))) {
      return res.status(400).json({ error: 'crop only allowed inside a training set or training batch' });
    }
    if (!existsSync(file) || !statSync(file).isFile()) return res.status(404).json({ error: 'no such file' });
    const tw = Math.round(+b.target_w), th = Math.round(+b.target_h);
    if (!(tw > 0 && th > 0)) return res.status(400).json({ error: 'bad target' });
    try {
      const r = await cropToTarget(file, b, tw, th);
      // A hand crop supersedes any Auto-crop outcome: drop its record so the tile stops showing as
      // auto-cropped (blue) or needs-review (yellow). loadAutoCrop is defined further down this
      // factory; it is only CALLED at request time, after the whole router has been built.
      const dir = path.dirname(file), nm = path.basename(file);
      const ac = loadAutoCrop(dir);
      if (ac[nm]) { delete ac[nm]; saveAutoCrop(dir, ac); }
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(e.status || 500).json({ error: String(e.message || e) });
    }
  });

  // ---- Auto-crop: a segmentation detector finds the subject, a TARGET x TARGET crop is centred
  // on it. Detection runs in samd on ai-epyc (it owns the GPUs and already caches ultralytics
  // models); cropping goes through cropToTarget, so every auto-crop snapshots the original and
  // /reset-crop undoes it exactly like a manual crop. Images with NO detection are written to
  // .autocrop.json as status "review": the listing turns that into needs_review (yellow border,
  // "Needs review" filter). Cropped ones are status "auto" (badge), so the results can be checked.
  const AUTOCROP_FILE = '.autocrop.json';
  const loadAutoCrop = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, AUTOCROP_FILE), 'utf8')) || {}; } catch { return {}; } };
  const saveAutoCrop = (dir, obj) => {
    const f = path.join(dir, AUTOCROP_FILE);
    try { writeFileSync(f, JSON.stringify(obj, null, 1)); try { chmodSync(f, 0o664); } catch { /* ignore */ } }
    catch (e) { console.warn(`[auto-crop] could not write ${f}: ${e.message}`); }
  };
  /** Square TARGET crop centred on the detection. The side grows to fit a large detection (+15%
   *  margin), never exceeds the image, and the square is shifted (not shrunk) to stay inside. */
  function autoCropRect(w, h, box, target) {
    const [x1, y1, x2, y2] = box;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    let side = Math.max(target, Math.max(x2 - x1, y2 - y1) * 1.15);
    side = Math.floor(Math.min(side, w, h));
    const left = Math.round(Math.min(Math.max(cx - side / 2, 0), w - side));
    const top = Math.round(Math.min(Math.max(cy - side / 2, 0), h - side));
    return { left, top, width: side, height: side };
  }
  let autoCropJob = null;
  async function runAutoCrop(job, rels, detectorRel, conf, overwrite) {
    const CHUNK = 8;
    const T = CROP_TARGET;
    console.log(`[auto-crop] ${job.id}: ${rels.length} image(s), detector=${path.basename(detectorRel)} conf=${conf} overwrite=${overwrite}`);
    try {
      for (let i = 0; i < rels.length && !job.cancel; i += CHUNK) {
        const todo = [];                                  // { rel, file, src, srcRel }
        for (const rel of rels.slice(i, i + CHUNK)) {
          let file;
          try { file = safeResolve(rel); } catch { job.errors.push(`${rel}: bad path`); job.done++; continue; }
          if (!EDITABLE_GUARD.test(rel.replace(/^\/+/, '')) || !existsSync(file)) { job.errors.push(`${rel}: not an editable training image`); job.done++; continue; }
          if (!overwrite) {
            const d = await dimsOf(file).catch(() => ({ w: 0, h: 0 }));
            if (d.w === T && d.h === T) { job.skipped++; job.done++; continue; }   // cropped already, or arrived at size
          }
          const src = baselinePath(file) || file;         // always detect + crop from the ORIGINAL
          todo.push({ rel, file, src, srcRel: path.relative(BASE, src) });
        }
        if (!todo.length) continue;
        let results = [];
        let target = null;
        try {
          // Per chunk: a service with this detector resident and idle, so copies on several image model
          // services share a long Auto-crop run.
          target = await pickForge('detector', detectorRel);
          const r = await fetch(`${target.base}/detect`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ detector: detectorRel, rels: todo.map((t) => t.srcRel), conf }),
            signal: AbortSignal.timeout(180000),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          results = d.results || [];
        } catch (e) {
          throw new Error(`detector service (${target?.base || 'no image model service'}) failed: ${e.message}`);
        }
        const byRel = new Map(results.map((x) => [x.rel, x]));
        const touched = new Map();                        // dir -> autocrop map
        for (const t of todo) {
          const dir = path.dirname(t.file), name = path.basename(t.file);
          if (!touched.has(dir)) touched.set(dir, loadAutoCrop(dir));
          const ac = touched.get(dir);
          const res = byRel.get(t.srcRel);
          job.done++;
          if (!res || res.error) { job.errors.push(`${t.rel}: ${res?.error || 'no result'}`); continue; }
          const best = (res.dets || [])[0];
          if (!best) {
            ac[name] = { status: 'review', detector: path.basename(detectorRel), conf, at: new Date().toISOString() };
            job.review++; continue;
          }
          try {
            const rect = autoCropRect(res.w, res.h, best.box, T);
            await cropToTarget(t.file, rect, T, T, t.src);
            ac[name] = { status: 'auto', detector: path.basename(detectorRel), score: best.conf, box: best.box, rect, at: new Date().toISOString() };
            job.cropped++;
          } catch (e) { job.errors.push(`${t.rel}: ${e.message}`); }
        }
        for (const [dir, ac] of touched) saveAutoCrop(dir, ac);
      }
      job.state = job.cancel ? 'cancelled' : 'done';
    } catch (e) {
      job.state = 'error'; job.error = e.message;
      console.warn(`[auto-crop] ${job.id} failed: ${e.message}`);
    }
    job.finishedAt = new Date().toISOString();
    console.log(`[auto-crop] ${job.id} ${job.state}: cropped ${job.cropped}, review ${job.review}, skipped ${job.skipped}, errors ${job.errors.length}`);
  }

  router.get('/auto-crop/detectors', (_req, res) => {
    const out = [];
    for (const sub of ['segm', 'bbox']) {
      const d = path.join(BASE, 'ultralytics', sub);
      try { for (const f of readdirSync(d)) if (f.endsWith('.pt')) out.push({ rel: `ultralytics/${sub}/${f}`, name: f.replace(/\.pt$/, ''), kind: sub }); } catch { /* none */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    const def = out.find((x) => /pant/i.test(x.name) && /travis/i.test(x.name)) || out.find((x) => /pant/i.test(x.name)) || out[0];
    res.json({ detectors: out, default: def ? def.rel : null });
  });
  router.get('/auto-crop/status', (_req, res) => res.json({ job: autoCropJob }));
  router.post('/auto-crop/cancel', (_req, res) => { if (autoCropJob && autoCropJob.state === 'running') autoCropJob.cancel = true; res.json({ ok: true, job: autoCropJob }); });
  router.post('/auto-crop', express.json({ limit: '4mb' }), (req, res) => {
    const b = req.body || {};
    if (autoCropJob && autoCropJob.state === 'running') return res.status(409).json({ error: 'an auto-crop is already running', job: autoCropJob });
    const rels = (Array.isArray(b.files) ? b.files : []).map(String).filter(Boolean);
    if (!rels.length) return res.status(400).json({ error: 'files required' });
    const det = String(b.detector || '').replace(/^\/+/, '');
    if (!/^ultralytics\/(segm|bbox)\/[^/]+\.pt$/.test(det) || !existsSync(path.join(BASE, det))) return res.status(400).json({ error: 'unknown detector' });
    const conf = Math.min(0.95, Math.max(0.05, +b.conf || 0.25));
    autoCropJob = { id: crypto.randomBytes(4).toString('hex'), state: 'running', total: rels.length, done: 0, cropped: 0, review: 0, skipped: 0, errors: [], detector: path.basename(det), conf, startedAt: new Date().toISOString() };
    void runAutoCrop(autoCropJob, rels, det, conf, !!b.overwrite);
    res.json({ ok: true, job: autoCropJob });
  });

  // ---- Reset a training_set copy back to its pristine original (one level up).
  router.post('/reset-crop', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    let file;
    try { file = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!EDITABLE_GUARD.test(rel)) {
      return res.status(400).json({ error: 'not a training set or training batch file' });
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
  /** GET /model-files?root=diffusion-models|text-encoders|vae|checkpoints|loras|ultralytics|sam - weight files under one model root,
   *  as paths relative to it (= the names ComfyUI lists). Feeds the --preload dropdown on the image-gen
   *  model-service launch cards. Whitelisted roots only; dot-dirs skipped; depth-limited. */
  // + checkpoints / loras / ultralytics / sam for the Model Cache & Placement "Add to cache" picker.
  const MODEL_FILE_ROOTS = new Set(['diffusion-models', 'text-encoders', 'vae', 'checkpoints', 'loras', 'ultralytics', 'sam']);
  const MODEL_FILE_EXT = /\.(safetensors|sft|gguf|pt|pth|ckpt|bin)$/i;
  router.get('/model-files', async (req, res) => {
    const root = String(req.query.root || '');
    if (!MODEL_FILE_ROOTS.has(root)) return res.status(400).json({ error: `root must be one of ${[...MODEL_FILE_ROOTS].join(', ')}` });
    const top = path.join(BASE, root);
    const files = [];
    const walk = async (dir, depth) => {
      let ents;
      try { ents = readdirSync(dir, { withFileTypes: true }); }
      catch (e) { console.warn(`[imagegen] model-files: cannot read ${dir}: ${e.message}`); return; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 4) await walk(full, depth + 1); }
        else if (MODEL_FILE_EXT.test(e.name)) files.push(path.relative(top, full));
      }
    };
    await walk(top, 0);
    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    res.json({ root, files });
  });

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
    // Not pinned to one model: the vlm engine takes ANY chat model the proxy serves (body.vlm_model).
    // The 9B is only the DEFAULT, and it is not always running — the UI offers the full proxy list.
    out.push({ id: 'vlm-custom', label: 'Custom — instructed natural language (any proxy model)', kind: 'vlm', engine: 'vlm' });
    // GPU roster for the picker. nvidia-smi enumerates in PCI order — the same order the
    // dispatched jobs see under CUDA_DEVICE_ORDER=PCI_BUS_ID — so the index shown IS the
    // index used. Free VRAM ships with each row because “exists” is not “usable”: a probe
    // on a full card fails with a BFC arena error that reads like a driver fault.
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8'];
    if (SSH_KEY) sshArgs.push('-i', SSH_KEY);
    sshArgs.push(TAGGER_SSH, 'nvidia-smi --query-gpu=index,name,memory.free,memory.total,uuid --format=csv,noheader,nounits 2>/dev/null');
    const names = friendlyByUuid();
    execFile('ssh', sshArgs, { timeout: 10000 }, (err, stdout) => {
      let gpus = [];
      if (!err) {
        gpus = String(stdout).trim().split('\n').filter(Boolean).map((l) => {
          const [idx, name, free, total, uuid] = l.split(',').map((s) => s.trim());
          return { index: parseInt(idx, 10), name, friendlyName: friendlyFor(names, uuid), uuid,
                   free_mib: parseInt(free, 10), total_mib: parseInt(total, 10) };
        }).filter((g) => Number.isInteger(g.index) && g.name);
      }
      // gpus: [] means the host could not be read — the UI must say “unknown”, not render
      // an empty-but-confident picker (cannot-check ≠ no GPUs).
      res.json({ taggers: out, default_gpu_index: TAGGER_GPU_INDEX, vlm_default_model: VLM_MODEL, gpus,
                 gpus_error: err ? String(err.message || err) : undefined });
    });
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
    const engine = b.engine === 'blip' ? 'blip' : (b.engine === 'vlm' ? 'vlm' : 'onnx');
    const model = String(b.model || '');
    if (engine === 'onnx' && !/^[\w.-]+$/.test(model)) {   // guard: no shell-meta / traversal
      return res.status(400).json({ error: 'bad model' });
    }
    const device = b.device === 'cuda' ? 'cuda' : 'cpu';
    // Optional subset: caption only these images (selection, or ONE image from the crop
    // editor) instead of the whole folder. Validated here so the remote --files filter
    // only ever sees clean names; a name that vanished between select and run is refused
    // rather than silently skipped by the remote filter.
    let onlyFiles = [];
    if (Array.isArray(b.files) && b.files.length) {
      for (const name of b.files) {
        if (typeof name !== 'string' || !name || name.includes('/') || name.includes('..') || name.startsWith('.') || name.includes(',')) {
          return res.status(400).json({ error: `bad filename: ${name}` });
        }
        if (!existsSync(path.join(dir, name))) return res.status(404).json({ error: `not found: ${name}` });
      }
      onlyFiles = b.files.map(String);
    }

    // Per-request GPU pick (PCI/nvidia-smi order, same as the /taggers roster — CUDA_ORDER
    // pins the dispatched process to that numbering). Absent -> the default card.
    let gpuIndex = TAGGER_GPU_INDEX;
    if (b.gpu_index !== undefined && b.gpu_index !== null && b.gpu_index !== '') {
      const gi = parseInt(b.gpu_index, 10);
      if (!Number.isInteger(gi) || gi < 0 || gi > 15 || String(gi) !== String(b.gpu_index).trim()) {
        return res.status(400).json({ error: 'bad gpu_index' });
      }
      gpuIndex = gi;
    }
    // Separate sidecars per engine so booru tags + natural-language captions co-exist:
    // WD/JoyTag -> .txt (training tags), BLIP -> .caption. Override via body.caption_ext.
    // NL engines (blip, vlm) share the .caption sidecar so either can produce it; booru tags
    // stay in .txt. Both co-exist on the same image.
    const isNl = engine === 'blip' || engine === 'vlm';
    let ext = String(b.caption_ext || (isNl ? 'caption' : 'txt'));
    if (!/^[a-z0-9]{1,8}$/i.test(ext)) ext = isNl ? 'caption' : 'txt';
    const remoteFolder = `${TAGGER_REMOTE_TI}/${rel}`;
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;   // single-quote for the remote shell
    const filesArg = onlyFiles.length ? ` --files ${q(onlyFiles.join(','))}` : '';   // q must exist first (TDZ)
    let cmd;
    if (engine === 'vlm') {
      // --context carries the domain hint ("these are all X") so the model knows what it is
      // looking at. --avoid keeps the trigger phrase OUT of the prose: the trigger is prepended
      // separately, and saying it twice is redundant. Defaults to the trigger when not given.
      cmd = `${BLIP_PY} ${VLM_SCRIPT} --folder ${q(remoteFolder)}${filesArg} --caption-ext ${ext} `
          + `--api ${q(VLM_API)} --model ${q(String(b.vlm_model || VLM_MODEL))}`
          + (b.instruction ? ` --instruction ${q(String(b.instruction))}` : '')
          + (b.context ? ` --context ${q(String(b.context))}` : '')
          // Subject fields. The captioner composes these onto a permanent discipline prompt
          // rather than a garment-shaped default that the UI could never replace.
          + (b.naming ? ` --naming ${q(String(b.naming))}` : '')
          // Size is mode-driven; the captioner's universal text is size-NEUTRAL so the two
          // cannot disagree. Default omit: the model is measurably unreliable at size, so for
          // most sets it is stamped deterministically instead of asked for.
          + ` --size-mode ${b.size_mode === 'state' ? 'state' : 'omit'}`
          + (b.size_mode === 'state' && b.size_word ? ` --size-word ${q(String(b.size_word))}` : '')
          + (b.emphasize ? ` --emphasize ${q(String(b.emphasize))}` : '')
          // A literal format exemplar. Measured as the strongest lever available: a model
          // imitates a concrete example far better than it obeys a rule. 🛑 It must carry no
          // trigger prefix — the trigger is prepended separately, so an exemplar showing one
          // teaches the model to write it twice.
          + (b.example ? ` --example ${q(String(b.example))}` : '')
          + (b.preset ? ` --preset ${q(String(b.preset))}` : '')
          // Per-set person handling: off = never describe the person (bulge sets); brief = one neutral
          // gender + hair clause, so recurring models are described instead of absorbed into the trigger.
          + ` --describe-person ${b.describe_person === 'brief' ? 'brief' : 'off'}`
          // An EDITED base prompt replaces only the discipline; subject fields still compose on top.
          + (b.discipline ? ` --discipline ${q(String(b.discipline))}` : '')
          + (b.avoid ? ` --avoid ${q(String(b.avoid))}` : '')
          + (b.max_side ? ` --max-side ${parseInt(b.max_side, 10)}` : '')
          + (b.trigger ? ` --trigger ${q(b.trigger)}` : '')
          // Runtime reasoning control. enable_thinking is a QWEN chat-template kwarg, silently
          // ignored by DeepSeek — which then reasons at full length until the reply either
          // blows the timeout or comes back as reasoning prose the validator rejects, leaving
          // the sidecar BLANK. 'off' sends {"thinking":{"type":"disabled"}}, which is the field
          // that actually turns it off; a level alone only sets HOW MUCH, not whether.
          // Whitelisted, not passed through: it reaches a remote shell, and an unrecognised
          // value is rejected by some providers anyway.
          + (['off', 'none', 'low', 'high', 'max'].includes(String(b.reasoning || ''))
              ? ` --reasoning ${q(String(b.reasoning))}` : '')
          // Per-image HTTP timeout. A reasoning model on a large image can exceed the 180s
          // default, and the failure looks identical to a bad caption: an empty sidecar.
          + (b.timeout ? ` --timeout ${Math.max(30, Math.min(1800, parseInt(b.timeout, 10) || 180))}` : '')
          // 1 = sequential (unchanged). API models are stateless so concurrency is nearly free;
          // a LOCAL model serving one stream can be slower under parallel load, which is why
          // this is the caller's choice and not a heuristic. Capped again on the remote side.
          + (b.concurrency ? ` --concurrency ${Math.max(1, Math.min(16, parseInt(b.concurrency, 10) || 1))}` : '')
          + (b.overwrite ? ' --overwrite' : '') + ' --json';
    } else if (engine === 'blip') {
      cmd = `${CUDA_ORDER} ${BLIP_PY} ${BLIP_SCRIPT} --folder ${q(remoteFolder)}${filesArg} --model-dir ${q(BLIP_MODEL_DIR)} `
          + `--device cuda --gpu-index ${gpuIndex} --caption-ext ${ext}`
          + (b.trigger ? ` --trigger ${q(b.trigger)}` : '')
          + (b.overwrite ? ' --overwrite' : '') + ' --json';
    } else {
      cmd = `${CUDA_ORDER} ${ONNX_LD} ${ONNX_PY} ${ONNX_SCRIPT} --folder ${q(remoteFolder)}${filesArg} --model-dir ${q(`${TAGGER_REMOTE_MODELS}/${model}`)} `
          + `--device ${device} --gpu-index ${gpuIndex} --caption-ext ${ext} `
          + `--threshold ${Number(b.threshold) || 0.35} --char-threshold ${Number(b.char_threshold) || 0.85}`
          + (b.trigger ? ` --trigger ${q(b.trigger)}` : '')
          + (b.spaces ? ' --spaces' : '')
          + (b.max_tags ? ` --max-tags ${parseInt(b.max_tags, 10)}` : '')
          + (b.overwrite ? ' --overwrite' : '') + ' --json';
    }
    const jobId = crypto.randomBytes(6).toString('hex');
    const jobModel = engine === 'blip' ? 'blip-large' : (engine === 'vlm' ? String(b.vlm_model || VLM_MODEL) : model);
    captionJobs.set(jobId, { state: 'running', total: 0, done: 0, wrote: 0, skipped: 0, errors: 0, gpu_index: gpuIndex, model: jobModel });
    const taskId = `auto-caption:${jobId}`;
    taskReport({ id: taskId, source: 'auto-caption', state: 'running', done: 0, total: 0,
                 label: `Auto-caption · ${jobModel} · ${rel.split('/').pop() || rel}`
                   + (onlyFiles.length ? ` (${onlyFiles.length} selected)` : '') });
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=20'];
    if (SSH_KEY) sshArgs.push('-i', SSH_KEY);
    sshArgs.push(TAGGER_SSH, cmd);
    const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Held so a cancel can reach them. `child` is the ssh here, NOT the worker: the worker
    // runs on the GPU host and reports its own pid in the start event below.
    { const j = captionJobs.get(jobId); if (j) j.child = child; }
    let ebuf = '', tail = '', raw = '';
    child.stderr.on('data', (d) => {
      const chunk = d.toString();
      raw = (raw + chunk).slice(-4000);      // keep the tail for diagnosis, bounded
      ebuf += chunk;
      let i;
      while ((i = ebuf.indexOf('\n')) >= 0) {
        const line = ebuf.slice(0, i).trim(); ebuf = ebuf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const j = captionJobs.get(jobId); if (!j) continue;
        if (ev.event === 'start') { j.total = ev.total; j.engine = ev.engine; j.provider = ev.provider || ev.device;
                                    if (ev.pid) j.remote_pid = ev.pid; }
        else if (ev.event === 'img') { j.done = ev.done; if (ev.status === 'error' && ev.error) j.lastError = `${ev.file}: ${ev.error}`; }
        else if (ev.event === 'done') { j.wrote = ev.wrote; j.skipped = ev.skipped; j.errors = ev.errors; }
        taskReport({ id: taskId, done: j.done, total: j.total,
                     detail: j.provider ? `on ${j.provider}` : undefined });
      }
    });
    child.stdout.on('data', (d) => { tail += d.toString(); });
    child.on('close', (code) => {
      const j = captionJobs.get(jobId); if (!j) return;
      if (code === 0) {
        j.state = 'done';
        try { Object.assign(j, JSON.parse(tail.trim().split('\n').pop())); } catch { /* keep parsed-from-stderr */ }
        taskReport({ id: taskId, state: 'done', done: j.done, total: j.total,
                     detail: `wrote ${j.wrote}, skipped ${j.skipped}, errors ${j.errors}` + (j.provider ? ` · ran on ${j.provider}` : '') });
      } else {
        // Say WHAT failed. ssh exits 255 for its own failures, and with the raw stderr
        // dropped the notification read "tagger exited 255" with no cause recoverable
        // anywhere — the tagger may never have run at all.
        // A cancel kills the worker, so ssh reports a non-zero exit. Saying "tagger exited 255
        // (ssh transport failure)" for a deliberate stop is the tool blaming itself for
        // obeying — the user KNOWS why it stopped, and a false failure hides real ones.
        if (j.cancelled) {
          j.state = 'cancelled';
          j.error = 'cancelled';
          taskReport({ id: taskId, state: 'failed', done: j.done, total: j.total,
                       detail: `cancelled after ${j.done}/${j.total || '?'}` });
          setTimeout(() => captionJobs.delete(jobId), 120000);
          return;
        }
        const why = raw.trim().split('\n').filter((l) => !l.startsWith('{')).slice(-4).join(' | ');
        j.state = 'error';
        j.error = `tagger exited ${code}` + (code === 255 ? ' (ssh transport failure — the tagger may not have run)' : '');
        j.stderr = why || '(no stderr captured)';
        console.error('[auto-caption] job %s exited %s; cmd %d bytes; stderr: %s',
                      jobId, code, cmd.length, j.stderr);
        taskReport({ id: taskId, state: 'failed', detail: `${j.error} — ${j.stderr}`.slice(0, 300) });
      }
      setTimeout(() => captionJobs.delete(jobId), 120000);
    });
    child.on('error', (e) => {
      const j = captionJobs.get(jobId); if (j) { j.state = 'error'; j.error = String(e.message || e); }
      taskReport({ id: taskId, state: 'failed', detail: String(e.message || e) });
    });
    res.json({ jobId });
  });

  // ---- Model-based caption correction.
  // The captioner's DEFAULT base prompt, per describe-person mode, straight from vlm_caption.py on the
  // tagger host (--print-default), so the UI shows exactly what will be sent instead of a copy that
  // drifts. Cached 5 min; ?refresh=1 re-reads after the script changes.
  let captionDefaultCache = { at: 0, data: null };
  router.get('/caption-default', (req, res) => {
    if (captionDefaultCache.data && !req.query.refresh && Date.now() - captionDefaultCache.at < 300000) return res.json(captionDefaultCache.data);
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8'];
    if (SSH_KEY) args.push('-i', SSH_KEY);
    args.push(TAGGER_SSH, `${BLIP_PY} ${VLM_SCRIPT} --print-default`);
    execFile('ssh', args, { timeout: 20000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return res.status(502).json({ error: `could not read the captioner default on ${TAGGER_SSH}: ${String(stderr || err.message).slice(0, 300)}` });
      try {
        const data = JSON.parse(String(stdout));
        captionDefaultCache = { at: Date.now(), data };
        res.json(data);
      } catch (e) {
        res.status(502).json({ error: `captioner printed something that is not JSON (an older vlm_caption.py without --print-default?): ${String(stdout).slice(0, 200)}` });
      }
    });
  });

  // POST { path, files?, instruction, model, exts?:['caption'], dry_run?, max_files? } -> { jobId }
  // Poll with /auto-caption-status (shared job map). Only sidecars that ALREADY exist are
  // touched — there is nothing to correct otherwise.
  router.post('/caption-correct', express.json(), (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });

    const instruction = String(b.instruction || '').trim();
    const model = String(b.model || '').trim();
    if (!instruction) return res.status(400).json({ error: 'instruction is required' });
    if (!model) return res.status(400).json({ error: 'model is required' });
    const exts = Array.isArray(b.exts) && b.exts.length
      ? b.exts.filter((e) => e === 'txt' || e === 'caption') : ['caption'];
    if (!exts.length) return res.status(400).json({ error: "exts must include 'txt' and/or 'caption'" });
    const dryRun = !!b.dry_run;
    const maxFiles = Math.max(0, parseInt(b.max_files, 10) || 0);

    let names;
    if (Array.isArray(b.files) && b.files.length) {
      names = b.files.map((n) => resolveImageName(dir, String(n || ''))).filter(Boolean);
    } else {
      try { names = readdirSync(dir).filter((f) => isImage(f) && !isCollageFile(f)); }
      catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }

    // Only sidecars that exist. Building this list UP FRONT makes `total` a real denominator
    // rather than a guess that the progress bar has to walk back.
    const units = [];
    for (const nm of names) {
      for (const ext of exts) {
        const p = ext === 'txt'
          ? captionPath(path.join(dir, nm))
          : path.join(dir, nm).replace(/\.[^/.]+$/, '') + '.caption';
        if (existsSync(p)) units.push({ nm, ext, p });
      }
    }
    if (!units.length) return res.status(400).json({ error: 'no existing ' + exts.join('/') + ' sidecars to correct here' });
    const work = maxFiles ? units.slice(0, maxFiles) : units;

    const jobId = crypto.randomBytes(6).toString('hex');
    const taskId = `caption-correct:${jobId}`;
    const job = { state: 'running', total: work.length, done: 0, wrote: 0, skipped: 0, errors: 0,
                  dry_run: dryRun, samples: [], model, provider: 'llm-proxy' };
    captionJobs.set(jobId, job);
    taskReport({ id: taskId, source: 'caption-correct', state: 'running', done: 0, total: work.length,
                 label: `Correct captions · ${model} · ${(b.path || '').split('/').pop() || 'folder'}`
                   + (dryRun ? ' (preview)' : '') });
    res.json({ jobId });

    const SYS = 'You correct image-training captions. Output ONLY the corrected caption and '
      + 'nothing else: no preamble, no explanation, no quotes, no markdown. Change ONLY what the '
      + "instruction requires and preserve everything else exactly, including the leading trigger "
      + 'token and the existing comma-separated structure. If nothing needs changing, output the '
      + 'caption unchanged.';

    /** Strip a reasoning model's think block and any stray wrapper. */
    const clean = (t) => String(t || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```[a-z]*\n?|```$/gim, '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();

    const one = async (u) => {
      let raw;
      try { raw = readFileSync(u.p, 'utf8'); } catch { job.errors++; return; }
      const before = raw.trim();
      if (!before) { job.skipped++; return; }
      let out;
      try {
        const r = await fetch('http://127.0.0.1:17890/api/proxy/llm/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature: 0, max_tokens: 1200, messages: [
            { role: 'system', content: SYS },
            { role: 'user', content: `Instruction: ${instruction}\nCaption: ${before}` },
          ] }),
          signal: AbortSignal.timeout(180000),
        });
        const d = await r.json();
        if (!r.ok || !d?.choices?.[0]) throw new Error(d?.error?.message || `HTTP ${r.status}`);
        out = clean(d.choices[0].message?.content);
      } catch (e) {
        job.errors++; job.lastError = `${u.nm}: ${String(e.message || e).slice(0, 160)}`; return;
      }
      // 🛑 NEVER write an empty correction. A model that refuses, returns only a think block, or
      // answers with prose we stripped to nothing would otherwise DELETE the caption — the one
      // outcome that loses work the user cannot get back.
      if (!out) { job.errors++; job.lastError = `${u.nm}: model returned nothing usable`; return; }
      if (out === before) { job.skipped++; return; }
      if (job.samples.length < 10) job.samples.push({ file: u.nm, ext: u.ext, before: before.slice(0, 300), after: out.slice(0, 300) });
      if (dryRun) { job.wrote++; return; }        // counted as "would write"
      try {
        writeFileSync(u.p, out, 'utf8');
        try { chmodSync(u.p, 0o664); } catch { /* not owner */ }
        job.wrote++;
      } catch { job.errors++; job.lastError = `${u.nm}: write failed`; }
    };

    // Small pool: the proxy is shared with chat and agents, and 300 simultaneous completions
    // would starve them. Sequentialish is fine — this is a background job with a progress bar.
    (async () => {
      const POOL = 3;
      let next = 0;
      const worker = async () => {
        while (next < work.length) {
          if (job.cancelled) return;      // checked between images, so a cancel lands within one
          const u = work[next++];
          await one(u);
          job.done++;
          taskReport({ id: taskId, done: job.done, total: job.total,
                       detail: `${job.wrote} ${dryRun ? 'proposed' : 'written'}, ${job.skipped} unchanged, ${job.errors} errors` });
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(POOL, work.length) }, worker));
        if (job.cancelled) {
          job.state = 'cancelled';
          taskReport({ id: taskId, state: 'failed', done: job.done, total: job.total,
                       detail: `cancelled after ${job.done}/${job.total}` });
          setTimeout(() => captionJobs.delete(jobId), 120000);
          return;
        }
        job.state = 'done';
        taskReport({ id: taskId, state: 'done', done: job.done, total: job.total,
                     detail: `${job.wrote} ${dryRun ? 'proposed (preview — nothing written)' : 'written'}, ${job.skipped} unchanged, ${job.errors} errors` });
      } catch (e) {
        job.state = 'error'; job.error = String(e.message || e);
        taskReport({ id: taskId, state: 'failed', detail: job.error.slice(0, 300) });
      }
      setTimeout(() => captionJobs.delete(jobId), 120000);
    })();
  });

  // ---- Cancel a running caption or correction job. POST { jobId }
  router.post('/auto-caption-cancel', express.json(), (req, res) => {
    const jobId = String((req.body && req.body.jobId) || '');
    const j = captionJobs.get(jobId);
    if (!j) return res.status(404).json({ error: 'no such job' });
    if (j.state !== 'running') return res.json({ ok: true, already: j.state });
    j.cancelled = true;

    // 🛑 REMOTE FIRST. ssh without a PTY does not forward signals, so killing the local ssh
    // leaves the worker captioning against a dead channel — an orphan holding the GPU that
    // nothing on this host can see. Verified the hard way.
    if (j.remote_pid) {
      const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10'];
      if (SSH_KEY) args.push('-i', SSH_KEY);
      // An explicit numeric pid the worker reported about ITSELF — never a pattern match,
      // which on a shared host can kill somebody else's identical-looking command.
      args.push(TAGGER_SSH, `kill -TERM ${parseInt(j.remote_pid, 10)} 2>/dev/null || true`);
      try { spawn('ssh', args, { stdio: 'ignore' }); } catch { /* best effort */ }
    }
    // The correction jobs have no child — they poll this between images.
    try { if (j.child) j.child.kill('SIGTERM'); } catch { /* already gone */ }

    res.json({ ok: true, jobId, cancelled: true, done: j.done, total: j.total,
               remote_pid: j.remote_pid || null });
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

  // ---- Watermark removal (see WATERMARK REMOVAL above). One job = a list of images, processed one at a
  // time; jobs queue behind each other. Reports to the bell like captions do, so a job started here (or by
  // an agent) is visible from any page.
  router.get('/watermark/info', async (req, res) => {
    const svcs = await wmServices();
    res.json({ ok: true, available: svcs.length > 0, services: svcs.map((s) => s.id), defaultPrompt: WM_DEFAULT_PROMPT });
  });

  // GPUs a job can reserve (every Image Model Service card, its models, who holds it)
  router.get('/watermark/gpus', async (req, res) => {
    // only cards whose service runs the edit (qwen_edit) - a V100 on 9310 would just fail the stream
    try {
      const ok = new Set((await wmServices()).map((x) => x.id));
      res.json({ ok: true, gpus: (await reservableGpus()).filter((g) => ok.has(g.service)) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  router.post('/watermark', express.json(), (req, res) => {
    const files = (req.body && req.body.files) || [];
    const prompt = String((req.body && req.body.prompt) || '').trim() || WM_DEFAULT_PROMPT;
    const upscale = !(req.body && req.body.upscale === false);
    // targets = GPUs to RESERVE for this job, one stream each ([{service, gpu}]); none = automatic routing
    const targets = Array.isArray(req.body && req.body.targets) ? req.body.targets.map((t) => ({ service: String(t.service || ''), gpu: Number(t.gpu) }))
      .filter((t) => t.service && Number.isInteger(t.gpu) && t.gpu >= 0) : [];
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'no files' });
    const rels = [];
    for (const f of files) {
      const rel = String(f || '').replace(/^\/+/, '');
      try { wmCheck(rel); } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
      rels.push(rel);
    }
    const id = crypto.randomBytes(6).toString('hex');
    const label = rels.length === 1 ? path.basename(rels[0]) : `${rels.length} images in ${path.dirname(rels[0])}`;
    const job = { id, state: 'queued', total: rels.length, done: 0, cleaned: 0, failed: 0, current: '', errors: [], results: {},
                  prompt, label, started: Date.now(), cancel: false, upscale, targets };
    wmJobs.set(id, job);
    const taskId = `watermark-${id}`;
    taskReport({ id: taskId, source: 'watermark', state: 'running', done: 0, total: job.total, label: `Remove watermark · ${label}`, detail: 'queued' });
    wmChain = wmChain.then(async () => {
      // cancelled while still QUEUED: report it, or its bell task stays 'running' forever - and a running task makes
      // ailab-restart refuse (2026-10-11: a ghost test job blocked a deploy)
      if (job.cancel) { job.state = 'cancelled'; job.finished = Date.now(); taskReport({ id: taskId, state: 'done', done: 0, total: job.total, detail: 'cancelled before it started' }); return; }
      job.state = 'running';
      // One image per loaded SeedVR2 copy at a time (Travis, 2026-10-11): since claude2's per-GPU seedvr2 workers,
      // copies on different cards really run in parallel, and qwen_edit routes each edit to an idle card itself.
      // Workers start a few seconds apart so each one's card choice sees the previous one already holding its card.
      const queue = [...rels];
      const inFlight = new Set();
      // Reserved cards: one stream per card, bound to it; the cards are cleared first and restored in finally.
      let held = null;
      if (targets.length) {
        taskReport({ id: taskId, done: 0, total: job.total, detail: `reserving ${targets.length} GPU(s)` });
        try {
          held = await reserveGpus(`watermark-${id}`, targets, upscale ? [...WM_KEEP, WM_SEEDVR2] : WM_KEEP, `Remove watermark · ${label}`);
          job.reservation = { id: held.id, soft: !Object.keys(held.core).length, targets };
        } catch (e) {
          job.errors.push(`could not reserve the GPUs: ${String(e.message || e)}`);
          queue.length = 0;
        }
      }
      const nWorkers = targets.length ? targets.length : Math.max(1, Math.min(queue.length, await wmParallel()));
      job.parallel = nWorkers;
      console.log(`[watermark] job ${id}: ${queue.length} image(s), ${nWorkers} at a time${targets.length ? ` on reserved ${targets.map((t) => `${t.service}:${t.gpu}`).join(', ')}` : ''}`);
      try {
      await Promise.all(Array.from({ length: nWorkers }, (_, k) => (async () => {
        await new Promise((r) => setTimeout(r, k * 4000));
        // NOT via object spread: spreading evaluates a getter once; the id must be read live (re-reserve swaps it)
        const opt = { upscale };
        if (targets.length) {
          opt.target = targets[k];
          Object.defineProperty(opt, 'reservation', { enumerable: true, get: () => held && held.core[targets[k].service] });
        }
        while (queue.length && !job.cancel) {
          const rel = queue.shift();
          inFlight.add(rel); job.current = [...inFlight].map((x) => path.basename(x)).join(', ');
          taskReport({ id: taskId, done: job.done, total: job.total, detail: job.current });
          try {
            job.results[rel] = await wmOne(rel, prompt, opt);
            job.cleaned++;
          } catch (e) {
            job.failed++;
            job.errors.push(`${path.basename(rel)}: ${String(e.message || e)}`);
            console.warn(`[watermark] ${rel}: ${e.message || e}`);
          }
          job.done++;
          inFlight.delete(rel); job.current = [...inFlight].map((x) => path.basename(x)).join(', ');
        }
      })()));
      } finally {
        if (held) {
          taskReport({ id: taskId, done: job.done, total: job.total, detail: 'releasing the GPUs and restoring their models' });
          await releaseGpus(held).catch((e) => job.errors.push(`release failed: ${e.message}`));
        }
      }
      job.current = '';
      job.state = job.cancel ? 'cancelled' : (job.cleaned === 0 && job.failed > 0 ? 'error' : 'done');
      job.finished = Date.now();
      taskReport({ id: taskId, state: job.state === 'error' ? 'failed' : 'done', done: job.done, total: job.total,
                   detail: `${job.cleaned} cleaned${job.failed ? `, ${job.failed} failed - ${job.errors[0]}` : ''}${job.state === 'cancelled' ? ' (cancelled)' : ''}` });
      setTimeout(() => wmJobs.delete(id), 6 * 3600 * 1000);
    }).catch((e) => { job.state = 'error'; job.errors.push(String(e.message || e)); console.error('[watermark] job', id, e); });
    res.json({ ok: true, job: { ...job, cancel: undefined } });
  });

  router.get('/watermark/status', (req, res) => {
    const j = wmJobs.get(String(req.query.job || ''));
    if (!j) return res.status(404).json({ error: 'unknown job' });
    res.json({ ok: true, job: { ...j, cancel: undefined } });
  });

  // Jobs still queued or running - lets a reopened page re-attach to them.
  router.get('/watermark/jobs', (req, res) => {
    res.json({ ok: true, jobs: [...wmJobs.values()].filter((j) => j.state === 'queued' || j.state === 'running').map((j) => ({ ...j, cancel: undefined })) });
  });

  router.post('/watermark/cancel', express.json(), (req, res) => {
    const j = wmJobs.get(String((req.body && req.body.job) || ''));
    if (!j) return res.status(404).json({ error: 'unknown job' });
    j.cancel = true;   // checked between images; the image in flight finishes
    res.json({ ok: true });
  });

  // Toggle between the cleaned image and its pre-removal original.
  router.post('/watermark/swap', express.json(), (req, res) => {
    const rel = String((req.body && req.body.path) || '').replace(/^\/+/, '');
    let file;
    try { file = wmCheck(rel); } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
    const dir = path.dirname(file), name = path.basename(file);
    const orig = path.join(dir, WM_ORIG, name), alt = path.join(dir, WM_ALT, name);
    if (!existsSync(orig)) return res.status(404).json({ error: 'this image has no watermark-removal history' });
    try {
      if (existsSync(alt)) {          // the original is showing: bring the cleaned one back
        copyFileSync(alt, file); unlinkSync(alt);
        res.json({ ok: true, showing: 'cleaned' });
      } else {                        // the cleaned one is showing: park it, show the original
        mkdirSync(path.dirname(alt), { recursive: true });
        copyFileSync(file, alt); copyFileSync(orig, file);
        res.json({ ok: true, showing: 'original' });
      }
      try { chmodSync(file, 0o664); } catch { /* ignore */ }
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- Move selected images into a kohya <repeats>_<concept> SUBSECTION of a training
  // batch (creating it if needed). Sidecars + ratings move with them. Same-concept
  // subsections are unified regardless of the repeats passed — repeats are edited via
  // /subsection-repeats, not by accidentally minting 10_blue beside 20_blue.
  router.post('/subsection', express.json(), (req, res) => {
    const rel = (req.body && req.body.path) || '';
    const files = req.body && req.body.files;
    const name = String((req.body && req.body.name) || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    const repeats = parseInt(req.body && req.body.repeats, 10);
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    const root = batchRootOf(dir);
    if (!root) return res.status(400).json({ error: 'subsections live inside a training batch (training_batch…)' });
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'no files' });
    if (!name || /^\d+_/.test(name)) return res.status(400).json({ error: 'name must be a concept like "blue" — the repeats prefix is added for you' });
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 999) return res.status(400).json({ error: 'repeats must be 1-999' });
    // Reuse an existing subsection with this concept, whatever its repeats.
    let destName = `${repeats}_${name}`;
    try {
      const existing = readdirSync(root).find((d) => {
        const sp = subsectionParts(d);
        return sp && sp.concept === name && statSync(path.join(root, d)).isDirectory();
      });
      if (existing) destName = existing;
    } catch { /* root readable — safeResolve passed */ }
    const dest = path.join(root, destName);
    try { mkdirSync(dest, { recursive: true }); chmodSync(dest, 0o777); } catch { /* best-effort */ }
    // Members are named <concept>-<n> and NUMBERING CONTINUES from the highest already
    // there — a later add picks up where the last one stopped (Travis, 2026-09-02).
    const concept = subsectionParts(destName).concept;
    let seq = 0;
    try {
      for (const f of readdirSync(dest)) {
        const m = new RegExp('^' + concept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)\\.').exec(f);
        if (m) seq = Math.max(seq, parseInt(m[1], 10));
      }
    } catch { /* fresh dir */ }
    const srcRatings = loadRatings(dir);
    const destRatings = loadRatings(dest);
    let moved = 0; const notFound = []; const alreadyThere = []; const renamed = []; let ratingsMoved = 0;
    for (const nm of files) {
      if (typeof nm !== 'string' || !nm || nm.includes('/') || nm.includes('..') || nm.startsWith('.')) { notFound.push(nm); continue; }
      const f = path.join(dir, nm);
      if (!existsSync(f)) { notFound.push(nm); continue; }
      if (dir === dest) { alreadyThere.push(nm); continue; }   // re-assigning members must not renumber them
      const newName = `${concept}-${++seq}${path.extname(nm).toLowerCase()}`;
      renameSync(f, path.join(dest, newName));
      const stem = nm.replace(/\.[^.]+$/, '');
      const newStem = newName.replace(/\.[^.]+$/, '');
      for (const ext of ['.txt', '.caption']) {
        const car = path.join(dir, stem + ext);
        if (existsSync(car)) renameSync(car, path.join(dest, newStem + ext));
      }
      // Per-image sidecar DIRS travel too: .orig = the crop baseline (restore), .preup = the upscale
      // alternate. Leaving them behind (as this did until 2026-10-08) cost every moved image its
      // restore point - and a stale dest/.orig/<newName> from some earlier, deleted image would make
      // restore bring back a DIFFERENT picture. So: move ours, and clear any stale one in the way.
      for (const sd of ['.orig', '.preup', WM_ORIG, WM_ALT]) {
        const from = path.join(dir, sd, nm), to = path.join(dest, sd, newName);
        try {
          if (existsSync(to)) unlinkSync(to);                      // stale: belongs to no live image
          if (existsSync(from)) { mkdirSync(path.join(dest, sd), { recursive: true }); renameSync(from, to); }
        } catch (e) { console.warn(`[imagegen] subsection move: ${sd} sidecar for ${nm}: ${e.message}`); }
      }
      { // Auto-crop outcome follows the image (blue / yellow border survives the move).
        const sAc = loadAutoCrop(dir);
        if (sAc[nm]) {
          const dAc = loadAutoCrop(dest); dAc[newName] = sAc[nm]; delete sAc[nm];
          saveAutoCrop(dir, sAc); saveAutoCrop(dest, dAc);
        }
      }
      if (srcRatings[nm]) { destRatings[newName] = srcRatings[nm]; delete srcRatings[nm]; ratingsMoved++; }
      renamed.push({ from: nm, to: newName });
      moved++;
    }
    if (ratingsMoved) { saveRatings(dir, srcRatings); saveRatings(dest, destRatings); }
    // Drop sidecar dirs this move emptied, so a fully-merged-away subsection is not left holding
    // nothing but an empty .orig/.preup.
    for (const sd of ['.orig', '.preup', WM_ORIG, WM_ALT]) {
      const d = path.join(dir, sd);
      try { if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: false, force: true }); } catch { /* not empty / gone */ }
    }
    res.json({ ok: true, subsection: destName, reused: destName !== `${repeats}_${name}`,
               path: path.relative(BASE, dest), moved, renamed, already_in_section: alreadyThere,
               not_found: notFound, ratings_moved: ratingsMoved });
  });

  // ---- Change a subsection's kohya repeats: rename <N>_<concept> → <M>_<concept>. ----
  // ---- Per-subsection caption variables -------------------------------------------------
  // One dot-file at the BATCH ROOT holds both the field DEFINITIONS (batch-wide) and the
  // per-subsection VALUES. Batch-level rather than one file per subsection because adding a
  // field is a batch-wide act — "give every subsection a Colour box" — and two subsections
  // disagreeing about which fields exist is not a state worth being able to represent.
  // Dot-prefixed so browse/counts/merge never see it, same as .preview.
  const CAPTION_VARS = '.caption-vars.json';
  const VAR_KEY_RE = /^[A-Z][A-Z0-9_]{0,31}$/;   // referenced as {$KEY} in the captioner

  /** Resolve `rel` and require it to BE a training batch. Returns the dir or throws. */
  function batchDirOf(rel) {
    const dir = safeResolve(rel || '');
    if (!isTrainingBatchName(path.basename(dir))) {
      const e = new Error('not a training batch'); e.status = 400; throw e;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      const e = new Error('no such batch'); e.status = 404; throw e;
    }
    return dir;
  }

  function readCaptionVars(dir) {
    try {
      const d = JSON.parse(readFileSync(path.join(dir, CAPTION_VARS), 'utf8'));
      const fields = Array.isArray(d.fields) ? d.fields.filter(
        (f) => f && VAR_KEY_RE.test(String(f.key))).map((f) => ({ key: String(f.key), label: String(f.label || f.key) })) : [];
      const values = (d.values && typeof d.values === 'object') ? d.values : {};
      return { fields, values };
    } catch { return { fields: [], values: {} }; }
  }

  router.get('/caption-vars', (req, res) => {
    let dir;
    try { dir = batchDirOf(req.query.path); }
    // A non-batch folder is NOT an error here: the browser asks on every navigation and an
    // empty answer is the honest one for a folder that cannot hold subsections.
    catch (e) { return e.status === 404 ? res.status(404).json({ error: e.message })
                                        : res.json({ fields: [], values: {}, applicable: false }); }
    res.json({ ...readCaptionVars(dir), applicable: true });
  });

  router.post('/caption-vars', express.json(), (req, res) => {
    let dir;
    try { dir = batchDirOf(req.body && req.body.path); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const b = req.body || {};
    if (!Array.isArray(b.fields)) return res.status(400).json({ error: 'fields must be an array' });
    const seen = new Set();
    const fields = [];
    for (const f of b.fields) {
      const key = String((f && f.key) || '').toUpperCase();
      // Rejected rather than coerced: a silently-renamed key breaks every {$KEY} that
      // referenced it, and the caption that results still looks plausible.
      if (!VAR_KEY_RE.test(key)) return res.status(400).json({ error: `bad variable name "${key}" — A-Z, 0-9 and _ only, starting with a letter` });
      if (seen.has(key)) return res.status(400).json({ error: `duplicate variable "${key}"` });
      seen.add(key);
      fields.push({ key, label: String((f && f.label) || key).slice(0, 64) });
    }
    // Values are keyed by SUBSECTION FOLDER NAME. Anything that is not a real subsection of
    // this batch is dropped, so a renamed or deleted subsection cannot leave a value behind
    // that silently applies to a later folder of the same name.
    const real = new Set(readdirSync(dir).filter(
      (n) => subsectionParts(n) && statSync(path.join(dir, n)).isDirectory()));
    const values = {};
    for (const [sub, vals] of Object.entries(b.values || {})) {
      if (!real.has(sub) || !vals || typeof vals !== 'object') continue;
      const keep = {};
      for (const k of seen) if (typeof vals[k] === 'string' && vals[k].trim()) keep[k] = String(vals[k]).slice(0, 500);
      if (Object.keys(keep).length) values[sub] = keep;
    }
    try {
      writeFileSync(path.join(dir, CAPTION_VARS), JSON.stringify({ fields, values }, null, 2));
      try { chmodSync(path.join(dir, CAPTION_VARS), 0o664); } catch { /* best effort */ }
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    console.log(`[imagegen] caption-vars saved for ${path.relative(BASE, dir)}: ${fields.length} field(s), ${Object.keys(values).length} subsection(s) populated`);
    res.json({ ok: true, fields, values });
  });

  router.post('/subsection-repeats', express.json(), (req, res) => {
    const rel = (req.body && req.body.path) || '';
    const repeats = parseInt(req.body && req.body.repeats, 10);
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    const sp = subsectionParts(path.basename(dir));
    if (!sp || !isTrainingBatchName(path.basename(path.dirname(dir)))) {
      return res.status(400).json({ error: 'not a training-batch subsection (<repeats>_<concept> inside a training_batch folder)' });
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such subsection' });
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 999) return res.status(400).json({ error: 'repeats must be 1-999' });
    const dest = path.join(path.dirname(dir), `${repeats}_${sp.concept}`);
    if (dest === dir) return res.json({ ok: true, unchanged: true, path: path.relative(BASE, dir) });
    if (existsSync(dest)) return res.status(409).json({ error: 'a subsection with those repeats + concept already exists' });
    try { renameSync(dir, dest); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    res.json({ ok: true, path: path.relative(BASE, dest), repeats, concept: sp.concept });
  });

  // ---- Batch-rename a selection to <base>-1..N (display order = caller's list order).
  // "Select 20, name them White, get white-1..white-20" (Travis, 2026-09-02). Everything
  // that KNOWS the old name travels with it: .txt/.caption sidecars, .orig/.preup backups,
  // the _ratings.json entry. TWO-PHASE (all to temp, then to final) because a batch like
  // white-3.png -> white-1.png overlaps its own targets — single-phase would clobber.
  router.post('/rename-files', express.json(), (req, res) => {
    const rel = (req.body && req.body.path) || '';
    const files = req.body && req.body.files;
    let base = String((req.body && req.body.base) || '').trim().toLowerCase();
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'no files' });
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(base)) {
      return res.status(400).json({ error: 'base must be letters/digits/_/- (it becomes <base>-1..N, lowercased)' });
    }
    for (const name of files) {
      if (typeof name !== 'string' || !name || name.includes('/') || name.includes('..') || name.startsWith('.')) {
        return res.status(400).json({ error: `bad filename: ${name}` });
      }
      if (!existsSync(path.join(dir, name))) return res.status(404).json({ error: `not found: ${name}` });
    }
    const targets = files.map((name, i) => `${base}-${i + 1}${path.extname(name).toLowerCase()}`);
    // A target that already exists and is NOT itself being renamed away would be clobbered.
    const srcSet = new Set(files);
    const clash = targets.filter((t, i) => t !== files[i] && existsSync(path.join(dir, t)) && !srcSet.has(t));
    if (clash.length) return res.status(409).json({ error: 'target names already exist in this folder', clash });
    const dupTargets = new Set(targets);
    if (dupTargets.size !== targets.length) return res.status(400).json({ error: 'duplicate target names (same extension order collision)' });

    const stem = (n) => n.replace(/\.[^.]+$/, '');
    const companionsOf = (name) => {
      const out = [[path.join(dir, name), null]];
      for (const ext of ['.txt', '.caption']) {
        const c = path.join(dir, stem(name) + ext);
        if (existsSync(c)) out.push([c, ext]);
      }
      for (const sub of ['.orig', '.preup', WM_ORIG, WM_ALT]) {
        const c = path.join(dir, sub, name);
        if (existsSync(c)) out.push([c, sub]);
      }
      return out;
    };
    const ratings = loadRatings(dir);
    const plan = [];   // [tmpPath, finalPath]
    try {
      // Phase A: everything out of the namespace.
      files.forEach((name, i) => {
        for (const [from, kind] of companionsOf(name)) {
          const tmp = path.join(path.dirname(from), `.__ren${i}__${path.basename(from)}`);
          renameSync(from, tmp);
          const finalName = kind === '.txt' || kind === '.caption'
            ? stem(targets[i]) + kind
            : targets[i];
          plan.push([tmp, path.join(path.dirname(from), finalName)]);
        }
      });
      // Phase B: temp -> final.
      for (const [tmp, fin] of plan) renameSync(tmp, fin);
    } catch (e) {
      // Roll temps back to their original names so a half-failure leaves no .__ren litter.
      for (const [tmp] of plan) {
        if (existsSync(tmp)) {
          try { renameSync(tmp, path.join(path.dirname(tmp), path.basename(tmp).replace(/^\.__ren\d+__/, ''))); } catch { /* report below */ }
        }
      }
      return res.status(500).json({ error: `rename failed and was rolled back: ${String(e.message || e)}` });
    }
    // Ratings follow the image.
    let ratingsMoved = 0;
    files.forEach((name, i) => {
      // Self-renames must be skipped: assign-then-delete on the SAME key destroys the
      // rating (caught live — white-2 -> white-2 in a reversal batch lost its score).
      if (name !== targets[i] && ratings[name]) { ratings[targets[i]] = ratings[name]; delete ratings[name]; ratingsMoved++; }
    });
    if (ratingsMoved) saveRatings(dir, ratings);
    res.json({ ok: true, renamed: files.map((name, i) => ({ from: name, to: targets[i] })), ratings_moved: ratingsMoved });
  });

  // ---- Delete images from a training set (working copies only; never originals).
  router.post('/delete', express.json(), (req, res) => {
    const rel = (req.body && req.body.path) || '';
    const files = req.body && req.body.files;
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    // Was training-sets-only, which meant a wrong image in a root tag folder could not
    // be removed at all (Travis, 2026-09-08). Now anywhere in the curation area; the
    // model roots still refuse, by name.
    try { assertDeletable(dir); } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
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
        for (const sd of [WM_ORIG, WM_ALT]) { const w = path.join(dir, sd, name); if (existsSync(w)) unlinkSync(w); }   // watermark undo copies
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
    // Sets, batches and batch SUBSECTIONS all take collages — a subsection collage is how
    // an agent reviews one concept's images in a single view (Travis, 2026-09-02).
    const cbase = path.basename(dir);
    if (!isTrainingSetName(cbase) && !isTrainingBatchName(cbase) && !batchRootOf(dir)) {
      return res.status(400).json({ error: 'only for training sets, batches, or batch subsections' });
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    const all = readdirSync(dir).filter((n) => !n.startsWith('.') && isImage(n) && !isCollageFile(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));   // red-2 before red-10
    if (!all.length) {
      // A sectioned batch root has no loose images BY DESIGN — point at the subsections
      // instead of claiming emptiness (the root-only-counting family, third instance).
      let subs = [];
      try { subs = readdirSync(dir).filter((n) => isSubsectionName(n) && statSync(path.join(dir, n)).isDirectory()); } catch { /* fall through */ }
      return res.status(400).json(subs.length
        ? { error: 'no loose images at this level — generate collages per subsection', subsections: subs }
        : { error: 'no images in this set' });
    }
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
        pages.push({ path: outRel, agent_path: `/imagegen/${outRel}`,
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
  // ---- Delete a FOLDER and everything under it. ---------------------------------
  // TWO-PHASE ON PURPOSE. Without confirm:true this deletes NOTHING and reports what
  // is inside; the caller has to send the count back. A recursive delete whose blast
  // radius the caller never saw is how you lose a folder you meant to rename, and the
  // UI cannot show a meaningful warning for a number it was never given.
  // ---- Move/copy whole FOLDERS. -------------------------------------------------
  // Separate from /transfer on purpose: that renames every incoming file into the
  // destination's <base>-N scheme, which is right for loose images and wrong for a
  // folder, where keeping the folder and its contents intact IS the operation.
  // ---- POSE LIBRARY -------------------------------------------------------------
  // The ComfyUI Krea2 Pose Gallery reads /imagegen/pose_library (symlinked into its
  // custom-node dir), which is inside BASE — so the existing /thumb and /image routes
  // already serve pose thumbnails with no extra code, and everything here only has to
  // manage the JSON and the image files.
  //
  // `name` is treated as a STABLE ID: it is what the node's dropdown lists and what a
  // saved workflow stores in Gallery mode, so renaming one would silently break those
  // workflows. Editing prompt/category/view is free; name is set once, at creation.
  const POSE_DIR = path.join(BASE, 'pose_library');
  const POSE_FILE = path.join(POSE_DIR, 'poses.json');
  const POSE_IMAGES = path.join(POSE_DIR, 'pose_images');
  const POSE_W = 224, POSE_H = 284;   // every shipped thumbnail is exactly this
  // 🛑 CONTAIN, NOT COVER. A pose reference is only useful if the whole body is in frame,
  // and source references here range from 0.34 to 2.11 aspect ratio against a 0.79 tile.
  // `cover` fills the tile by CROPPING, so a tall standing shot lost its head and feet and
  // a wide crawling shot lost its sides — the pose was cut out of the very thumbnail whose
  // job is to show it. `contain` letterboxes instead: every pose stays whole, and the tiles
  // stay a uniform size, which the canvas gallery's fixed grid needs.
  // Transparent background rather than a colour, so the bars take the node's own backdrop
  // instead of stamping a grey block that looks like part of the image.
  const POSE_FIT = { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } };

  function loadPoses() {
    return JSON.parse(readFileSync(POSE_FILE, 'utf8'));
  }
  /** Write atomically, and keep ONE backup of the last good state. A half-written
   *  poses.json breaks the node for every workflow at once, so the rename is the
   *  commit point and the .bak is the way back. */
  function savePoses(list) {
    try { copyFileSync(POSE_FILE, POSE_FILE + '.bak'); } catch { /* first write */ }
    const tmp = POSE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    renameSync(tmp, POSE_FILE);
    try { chmodSync(POSE_FILE, 0o664); } catch { /* not owner */ }
  }

  // ---- POSE → MANNEQUIN ---------------------------------------------------------
  // Converts pose references (real photos / drawings, which leak their art style into a
  // generation) into a featureless grey mannequin in the SAME pose with Qwen-Image 2.1, and
  // outpaints bodies that run off the frame. Each chosen GPU gets its own short-lived,
  // core-only ComfyUI "pose worker" (/opt/pose-mannequin/worker.py on that host, pinned with
  // CUDA_DEVICE_ORDER=PCI_BUS_ID + CUDA_VISIBLE_DEVICES), so the managed ComfyUI services and
  // the GPUs nobody picked are never touched. Same ssh/remote-pid/cancel pattern as auto-caption.
  // Results: pose_library/mannequin_images/<id>.png + pose.mannequin in poses.json; the
  // original pose image is never modified.
  const MQ_DIR = path.join(POSE_DIR, 'mannequin_images');
  const MQ_JOBS_DIR = path.join(POSE_DIR, '.mq-jobs');
  const MQ_SETTINGS_FILE = path.join(POSE_DIR, 'mannequin_settings.json');
  const MQ_REMOTE_POSE_DIR = '/imagegen/pose_library';
  // prom = the `host` label the nvidia_smi exporter uses for that machine.
  const MQ_HOSTS = {
    'ai-epyc': { label: 'ai-epyc (RTX 4090 / 5060 Ti)', prom: 'px-epyc', ssh: 'root@10.0.0.234',
                 worker: '/opt/pose-mannequin/worker.py', python: '/opt/conda/envs/comfyui/bin/python', comfyRoot: '/opt/comfyui' },
    'ai-gpu':  { label: 'ai-gpu (V100)', prom: 'px-gpu', ssh: 'root@10.0.0.235',
                 worker: '/opt/pose-mannequin/worker.py', python: '/opt/conda/envs/comfyui/bin/python', comfyRoot: '/opt/comfyui' },
  };
  // Cards to keep jobs off ({ host: { index: reason } }). Empty: the old ai-gpu GPU7 Xid 74 note was stale
  // (no Xid 74 on px-gpu since the 2026-09-22 boot; Travis repasted/reseated the V100s).
  const MQ_AVOID = {};
  const MQ_MIN_FREE_MB = 15000;   // int8 model + int8 encoder are loaded one at a time; ~15 GB is the floor
  const mqJobs = new Map();       // jobId -> { state, total, done, ok, errors, results, workers[], ... }
  const sshBase = () => {
    const a = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=20'];
    if (SSH_KEY) a.push('-i', SSH_KEY);
    return a;
  };
  const mqRel = (p) => (p && p.mannequin ? `pose_library/mannequin_images/${p.mannequin}` : null);
  const withRels = (p) => ({ ...p, rel: `pose_library/pose_images/${p.image}`, mannequin_rel: mqRel(p),
                              skeleton_rel: skRel(p, 'overlay'), skeleton_only_rel: skRel(p, 'skel') });

  function loadMqSettings() {
    try { return { auto: false, host: 'ai-epyc', gpus: [], quant: 'int8', te: 'int8', steps: 25, outpaint: 'auto', ...JSON.parse(readFileSync(MQ_SETTINGS_FILE, 'utf8')) }; }
    catch { return { auto: false, host: 'ai-epyc', gpus: [], quant: 'int8', te: 'int8', steps: 25, outpaint: 'auto' }; }
  }

  /** GPU friendly names by UUID (gpu-config.json entries carry the card's uuid). The nvidia-smi index
   *  shown in pickers is SLOT order, so without this "#1" read as friendly "#1" on a different card. */
  function friendlyByUuid() {
    const out = {};
    try {
      const dir = process.env.AILAB_PROXY_DATA_DIR || path.join(process.cwd(), '.gybackend-data');
      const cfg = JSON.parse(readFileSync(path.join(dir, 'gpu-config.json'), 'utf8'));
      for (const v of Object.values(cfg)) {
        if (v && v.uuid && v.friendlyName) out[String(v.uuid).replace(/^GPU-/i, '').toLowerCase()] = v.friendlyName;
      }
    } catch (e) { console.warn(`[imagegen] gpu friendly names unavailable: ${e.message}`); }
    return out;
  }
  const friendlyFor = (names, uuid) => (uuid ? names[String(uuid).replace(/^GPU-/i, '').toLowerCase()] : null) || null;

  /** Live per-GPU free VRAM from Prometheus (never nvidia-smi on ai-gpu - a stalled V100 can wedge the host). */
  async function mqGpuInventory() {
    const promBase = process.env.PROMETHEUS_URL || 'http://10.0.0.79:9090';
    const q = async (query) => {
      const r = await fetch(`${promBase}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(8000) });
      const d = await r.json(); return (d && d.data && d.data.result) || [];
    };
    const [info, used, total] = await Promise.all([q('nvidia_smi_gpu_info'), q('nvidia_smi_memory_used_bytes'), q('nvidia_smi_memory_total_bytes')]);
    const key = (r) => `${r.metric.host}|${r.metric.uuid}`;
    const usedB = Object.fromEntries(used.map((r) => [key(r), Number(r.value[1]) || 0]));
    const totB = Object.fromEntries(total.map((r) => [key(r), Number(r.value[1]) || 0]));
    const hosts = {};
    const names = friendlyByUuid();
    for (const [name, h] of Object.entries(MQ_HOSTS)) {
      const gpus = info.filter((r) => r.metric.host === h.prom).map((r) => {
        const index = parseInt(r.metric.index, 10);
        const totalMB = Math.round((totB[key(r)] || 0) / 1048576), usedMB = Math.round((usedB[key(r)] || 0) / 1048576);
        const cc = parseFloat(r.metric.compute_cap || '0');
        const warn = [];
        if (cc && cc < 8) warn.push('no bf16 (sm_' + String(r.metric.compute_cap).replace('.', '') + ') - runs in fp16, may produce blank images');
        const avoid = MQ_AVOID[name] && MQ_AVOID[name][index];
        if (avoid) warn.push(avoid);
        const freeMB = totalMB - usedMB;
        if (freeMB < MQ_MIN_FREE_MB) warn.push(`only ${(freeMB / 1024).toFixed(1)} GB free - suspend what runs on it first (~15 GB needed)`);
        return { index, name: String(r.metric.name || '').replace(/^NVIDIA (GeForce )?/, ''), uuid: r.metric.uuid,
                 friendlyName: friendlyFor(names, r.metric.uuid), totalMB, usedMB, freeMB,
                 computeCap: r.metric.compute_cap, warn, avoid: !!avoid };
      }).sort((a, b) => a.index - b.index);
      hosts[name] = { label: h.label, disabled: h.disabled || null, gpus };
    }
    return hosts;
  }

  /** Source for a pose: the full-size original when the pose recorded one, else the 224px library image. */
  function mqSourceFor(p) {
    if (p.source) {
      try { const abs = safeResolve(p.source); if (existsSync(abs)) return `/imagegen/${path.relative(BASE, abs)}`; } catch { /* fall back */ }
    }
    return `${MQ_REMOTE_POSE_DIR}/pose_images/${p.image}`;
  }

  function mqStart(ids, opts) {
    const host = MQ_HOSTS[opts.host];
    if (!host) throw new Error(`unknown host ${opts.host}`);
    if (host.disabled) throw new Error(`${opts.host}: ${host.disabled}`);
    const gpus = [...new Set((opts.gpus || []).map((g) => parseInt(g, 10)))].filter((g) => Number.isInteger(g) && g >= 0 && g <= 15);
    if (!gpus.length) throw new Error('pick at least one GPU');
    for (const g of gpus) if (MQ_AVOID[opts.host] && MQ_AVOID[opts.host][g]) throw new Error(`GPU ${g}: ${MQ_AVOID[opts.host][g]}`);
    const running = [...mqJobs.values()].filter((j) => j.state === 'running' && j.host === opts.host);
    for (const j of running) for (const g of gpus) if (j.gpus.includes(g)) throw new Error(`GPU ${g} on ${opts.host} is already converting (job ${j.id})`);
    const poses = loadPoses();
    const list = ids.map((id) => poses.find((p) => p.id === id)).filter(Boolean);
    if (!list.length) throw new Error('no matching poses');
    const quant = opts.quant === 'bf16' ? 'bf16' : 'int8';
    const te = opts.te === 'bf16' ? 'bf16' : 'int8';
    const steps = Math.max(4, Math.min(60, parseInt(opts.steps, 10) || 25));
    const outpaint = ['auto', 'off', 'always'].includes(opts.outpaint) ? opts.outpaint : 'auto';
    const extra = String(opts.extra_prompt || '').slice(0, 1000);

    const jobId = crypto.randomBytes(6).toString('hex');
    const job = { id: jobId, state: 'running', host: opts.host, gpus, total: list.length, done: 0, ok: 0, errors: 0,
                  results: {}, workers: [], startedAt: Date.now(), ids: list.map((p) => p.id), auto: !!opts.auto };
    mqJobs.set(jobId, job);
    const taskId = `pose-mannequin:${jobId}`;
    const report = (extraFields = {}) => taskReport({ id: taskId, source: 'pose-mannequin', done: job.done, total: job.total, ...extraFields });
    report({ state: 'running', label: `Pose → mannequin · ${list.length} pose${list.length === 1 ? '' : 's'} · ${opts.host} GPU ${gpus.join(',')}` + (job.auto ? ' (auto)' : '') });

    mkdirSync(MQ_JOBS_DIR, { recursive: true }); mkdirSync(MQ_DIR, { recursive: true });
    try { chmodSync(MQ_DIR, 0o777); chmodSync(MQ_JOBS_DIR, 0o777); } catch { /* not owner */ }
    // Round-robin split so every GPU gets a similar mix of easy and hard poses.
    const shards = gpus.map(() => []);
    list.forEach((p, i) => shards[i % gpus.length].push(p));
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    gpus.forEach((gpu, wi) => {
      if (!shards[wi].length) return;
      const manifestName = `${jobId}-gpu${gpu}.json`;
      writeFileSync(path.join(MQ_JOBS_DIR, manifestName), JSON.stringify({
        poses: shards[wi].map((p) => ({ id: p.id, src: mqSourceFor(p) })),
        out_dir: `${MQ_REMOTE_POSE_DIR}/mannequin_images`, quant, te, steps, outpaint, extra_prompt: extra,
      }));
      const cmd = `${host.python} ${host.worker} --manifest ${q(`${MQ_REMOTE_POSE_DIR}/.mq-jobs/${manifestName}`)} --gpu ${gpu} --port ${8300 + gpu} `
                + `--comfy-root ${q(host.comfyRoot)} --python ${q(host.python)}`;
      const child = spawn('ssh', [...sshBase(), host.ssh, cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      const w = { gpu, child, remote_pid: null, state: 'starting', total: shards[wi].length, done: 0, raw: '' };
      job.workers.push(w);
      let ebuf = '';
      child.stderr.on('data', (d) => {
        const chunk = d.toString(); w.raw = (w.raw + chunk).slice(-4000); ebuf += chunk;
        let i;
        while ((i = ebuf.indexOf('\n')) >= 0) {
          const line = ebuf.slice(0, i).trim(); ebuf = ebuf.slice(i + 1);
          if (!line.startsWith('{')) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.event === 'start') { w.remote_pid = ev.pid; w.state = 'loading ComfyUI'; }
          else if (ev.event === 'ready') w.state = 'converting';
          else if (ev.event === 'fatal') { w.state = 'failed'; w.error = ev.error; }
          // worker v2 (claude2, 2026-10-05): the landmark pass failed and the plain mannequin was kept.
          else if (ev.event === 'warn') {
            job.warnings = (job.warnings || 0) + 1;
            (job.warnById = job.warnById || {})[ev.id] = String(ev.warning || 'landmark pass failed');
            job.lastWarning = `${ev.id}: ${ev.warning}`;
          }
          else if (ev.event === 'img') {
            w.done = ev.done; job.done += 1;
            if (ev.status === 'ok') {
              job.ok += 1;
              job.results[ev.id] = { status: 'ok', secs: ev.secs, sides: ev.sides, landmarks: ev.landmarks,
                                     ...(job.warnById?.[ev.id] ? { warning: job.warnById[ev.id] } : {}) };
              try {   // record it on the pose immediately, so a cancel keeps everything finished so far
                const all = loadPoses(); const p = all.find((x) => x.id === ev.id);
                if (p) {
                  p.mannequin = `${ev.id}.png`; p.mannequin_at = Date.now();
                  if (typeof ev.landmarks === 'boolean') p.mannequin_landmarks = ev.landmarks;   // false = landmark pass failed, plain kept
                  savePoses(all);
                }
              } catch (e) { job.results[ev.id] = { status: 'error', error: 'saved image but could not update poses.json: ' + String(e.message || e) }; }
            } else { job.errors += 1; job.results[ev.id] = { status: 'error', error: ev.error }; job.lastError = `${ev.id}: ${ev.error}`; }
            report({ detail: `${job.ok} done${job.errors ? `, ${job.errors} failed` : ''}${job.warnings ? `, ${job.warnings} without landmarks` : ''}` });
          } else if (ev.event === 'done') w.state = 'done';
        }
      });
      child.on('close', (code) => {
        if (w.state !== 'done' && w.state !== 'failed') w.state = job.cancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed');
        if (w.state === 'failed' && !w.error) w.error = `worker exited ${code}: ` + w.raw.trim().split('\n').filter((l) => !l.startsWith('{')).slice(-3).join(' | ');
        try { unlinkSync(path.join(MQ_JOBS_DIR, manifestName)); } catch { /* ignore */ }
        if (job.workers.every((x) => ['done', 'failed', 'cancelled'].includes(x.state))) {
          job.state = job.cancelled ? 'cancelled' : (job.ok ? 'done' : 'error');
          job.finishedAt = Date.now();
          const failed = job.workers.filter((x) => x.state === 'failed').map((x) => `GPU ${x.gpu}: ${x.error}`);
          if (failed.length) job.error = failed.join(' · ').slice(0, 800);
          // New/regenerated mannequins get their skeleton detected (CPU); hand-edited ones are kept and marked stale.
          const okIds = Object.entries(job.results).filter(([, r]) => r.status === 'ok').map(([id]) => id);
          job.skeletonJob = skAutoDetect(okIds);
          report({ state: job.state === 'done' ? 'done' : 'failed',
                   detail: job.cancelled ? `cancelled after ${job.done}/${job.total}` : `${job.ok} converted${job.errors ? `, ${job.errors} failed` : ''}${failed.length ? ` — ${job.error}` : ''}`.slice(0, 300) });
          setTimeout(() => mqJobs.delete(jobId), 6 * 3600_000);
        }
      });
      child.on('error', (e) => { w.state = 'failed'; w.error = String(e.message || e); });
    });
    return job;
  }
  const mqPublic = (j) => ({ id: j.id, state: j.state, host: j.host, gpus: j.gpus, total: j.total, done: j.done, ok: j.ok, errors: j.errors,
    results: j.results, error: j.error || null, lastError: j.lastError || null, warnings: j.warnings || 0, lastWarning: j.lastWarning || null, auto: j.auto, ids: j.ids, startedAt: j.startedAt, finishedAt: j.finishedAt || null,
    workers: j.workers.map((w) => ({ gpu: w.gpu, state: w.state, done: w.done, total: w.total, error: w.error || null })) });

  router.get('/poses/mannequin/gpus', async (_req, res) => {
    try { res.json({ ok: true, hosts: await mqGpuInventory(), min_free_mb: MQ_MIN_FREE_MB }); }
    catch (e) { res.status(502).json({ error: 'GPU inventory unavailable: ' + String(e.message || e) }); }
  });
  router.post('/poses/mannequin/start', express.json(), (req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'select at least one pose' });
    try { res.json({ ok: true, job: mqPublic(mqStart(ids, b)) }); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
  router.get('/poses/mannequin/status', (req, res) => {
    const j = mqJobs.get(String(req.query.jobId || ''));
    if (!j) return res.status(404).json({ error: 'unknown job' });
    res.json({ ok: true, job: mqPublic(j) });
  });
  router.get('/poses/mannequin/jobs', (_req, res) => {
    res.json({ ok: true, jobs: [...mqJobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(mqPublic) });
  });
  router.post('/poses/mannequin/cancel', express.json(), (req, res) => {
    const j = mqJobs.get(String((req.body || {}).jobId || ''));
    if (!j) return res.status(404).json({ error: 'unknown job' });
    if (j.state !== 'running') return res.json({ ok: true, already: j.state });
    j.cancelled = true;
    const host = MQ_HOSTS[j.host];
    for (const w of j.workers) {
      // 🛑 REMOTE FIRST, by the numeric pid the worker reported about itself (its SIGTERM handler
      // stops its private ComfyUI). ssh doesn't forward signals; killing only the local ssh would
      // orphan a worker that keeps holding the GPU.
      if (w.remote_pid) {
        try { spawn('ssh', [...sshBase(), host.ssh, `kill -TERM ${parseInt(w.remote_pid, 10)} 2>/dev/null || true`], { stdio: 'ignore' }); } catch { /* best effort */ }
      }
      setTimeout(() => { try { w.child.kill('SIGTERM'); } catch { /* gone */ } }, 4000);
    }
    res.json({ ok: true, cancelled: true, done: j.done, total: j.total });
  });
  router.post('/poses/mannequin/remove', express.json(), (req, res) => {
    const id = String((req.body || {}).id || '');
    let poses;
    try { poses = loadPoses(); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const p = poses.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: `no such pose: ${id}` });
    const file = p.mannequin;
    delete p.mannequin; delete p.mannequin_at;
    skClear(p);   // the skeleton was drawn on that mannequin
    try { savePoses(poses); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    if (file) { try { unlinkSync(path.join(MQ_DIR, file)); } catch { /* already gone */ } }
    skRemoveFiles(id);
    res.json({ ok: true, pose: withRels(p) });
  });
  router.get('/poses/mannequin/settings', (_req, res) => res.json({ ok: true, settings: loadMqSettings() }));
  router.post('/poses/mannequin/settings', express.json(), (req, res) => {
    const b = req.body || {}; const cur = loadMqSettings();
    const next = { ...cur };
    if (typeof b.auto === 'boolean') next.auto = b.auto;
    if (typeof b.host === 'string' && MQ_HOSTS[b.host]) next.host = b.host;
    if (Array.isArray(b.gpus)) next.gpus = b.gpus.map((g) => parseInt(g, 10)).filter((g) => Number.isInteger(g) && g >= 0 && g <= 15);
    for (const k of ['quant', 'te']) if (b[k] === 'int8' || b[k] === 'bf16') next[k] = b[k];
    if (b.steps !== undefined) next.steps = Math.max(4, Math.min(60, parseInt(b.steps, 10) || 25));
    if (['auto', 'off', 'always'].includes(b.outpaint)) next.outpaint = b.outpaint;
    if (next.auto && !next.gpus.length) return res.status(400).json({ error: 'pick the GPU(s) auto-convert should use' });
    try { writeFileSync(MQ_SETTINGS_FILE, JSON.stringify(next, null, 2)); try { chmodSync(MQ_SETTINGS_FILE, 0o664); } catch { /* */ } }
    catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    res.json({ ok: true, settings: next });
  });
  /** Called after poses are added: converts them right away when auto-convert is on. Never throws. */
  function mqAutoConvert(ids) {
    const s = loadMqSettings();
    if (!s.auto || !ids.length || !s.gpus.length) return null;
    try { return mqStart(ids, { ...s, auto: true }).id; }
    catch (e) { taskReport({ id: `pose-mannequin:auto-${Date.now()}`, source: 'pose-mannequin', state: 'failed',
                             label: 'Pose → mannequin (auto)', detail: String(e.message || e).slice(0, 300) }); return null; }
  }

  // ---- POSE SKELETONS (OpenPose) -----------------------------------------------------
  // An OpenPose skeleton drawn over each MANNEQUIN tells an edit model the pose and - through the
  // fixed left/right limb colours - which way the body faces, which a bare grey mannequin doesn't.
  // Detected with DWPose on the mannequin itself (never the original photo: outpainting and hand
  // corrections make the two differ) by /opt/pose-mannequin/skeleton.py on ai-epyc, CPU-only, so it
  // never competes with a generation. DWPose misreads some folded/lying mannequins, so anything
  // doubtful is flagged and fixed by hand in the Pose Manager skeleton editor.
  //   skeletons/<id>.json          canonical keypoints (see SK_SCHEMA below) - the only source of truth
  //   skeletons/<id>_overlay.png   mannequin + skeleton (what an edit model gets)
  //   skeletons/<id>_skel.png      skeleton alone on black (ControlNet-style)
  // A hand-edited skeleton is never overwritten by automatic detection: when its mannequin is
  // regenerated it is only marked stale, and the editor offers to re-detect.
  // SK_SCHEMA: { version, width, height, body: [[x,y,score]|null] x18 (OpenPose/COCO-18 order),
  //   hand_left|hand_right: [[x,y,score]|null] x21 | null, hidden: [body indices not drawn],
  //   source: 'auto'|'edited', framing, review: [reasons], reviewed: bool, mannequin_at, saved_at }
  const SK_DIR = path.join(POSE_DIR, 'skeletons');
  const SK_HOST = 'ai-epyc';
  const SK_WORKER = '/opt/pose-mannequin/skeleton.py';
  const skJobs = new Map();
  const skRel = (p, kind) => (p && p.skeleton_at ? `pose_library/skeletons/${p.id}_${kind}.png` : null);
  // Rear views: DWPose still puts eyes and a nose on the back of the head, which reads as "the face is
  // here". The left/right limb colours already carry the facing; hide the face points by default.
  /**
   * Which eye + ear are on the FAR side of the head (hidden from the camera), from the skeleton itself.
   * f = nose - ear midpoint (where the face points), u = ear midpoint - neck (head "up"); the sign of the
   * 2-D cross product f x u says whether the figure's right side faces away (cross > 0) or toward the
   * camera, for any head orientation (upright, lying, head back). Returns null when the head isn't
   * clearly in profile. Checked against Travis's hand edits on 2026-10-04 (4/4 agree).
   * Body indices: 14 right eye, 15 left eye, 16 right ear, 17 left ear.
   */
  function skFarFace(sk) {
    const b = sk && sk.body; if (!b) return null;
    const mid = (a, c) => (a && c ? [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2] : (a || c || null));
    const nose = b[0], neck = b[1], ear = mid(b[16], b[17]) || mid(b[14], b[15]);
    if (!nose || !neck || !ear) return null;
    const fx = nose[0] - ear[0], fy = nose[1] - ear[1], ux = ear[0] - neck[0], uy = ear[1] - neck[1];
    const sin = (fx * uy - fy * ux) / ((Math.hypot(fx, fy) * Math.hypot(ux, uy)) || 1);
    return sin > 0.35 ? [14, 16] : sin < -0.35 ? [15, 17] : null;
  }
  /**
   * Far ear on a REAR view. From behind, DWPose still invents a face on the back of the head, but it
   * puts it on the side the head is turned toward: the invented nose sits off the neck in the turn
   * direction. Nose to the figure's image-right (upright frame) -> the LEFT ear is the hidden one, and
   * vice versa. Matched all 6 of Travis's own rear-view ear choices (poses 20-25, 2026-10-04).
   * The offset is measured across the body axis (neck - hip midpoint), in shoulder widths, so lying and
   * crawling poses work too; under 0.35 shoulder widths = head straight, both ears stay.
   */
  function skRearFarEar(sk) {
    const b = sk && sk.body; if (!b) return [];
    const nose = b[0], neck = b[1], rs = b[2], ls = b[5];
    const hips = [b[8], b[11]].filter(Boolean);
    if (!nose || !neck || !rs || !ls || !hips.length) return [];
    const hx = hips.reduce((a, k) => a + k[0], 0) / hips.length, hy = hips.reduce((a, k) => a + k[1], 0) / hips.length;
    let ux = neck[0] - hx, uy = neck[1] - hy; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    const px = -uy, py = ux;                                  // "image-right" when the body is upright
    const sw = Math.hypot(rs[0] - ls[0], rs[1] - ls[1]) || 1;
    const off = ((nose[0] - neck[0]) * px + (nose[1] - neck[1]) * py) / sw;
    return off > 0.35 ? [17] : off < -0.35 ? [16] : [];
  }

  /**
   * Points drawn hidden by default, from the view named in the label/prompt (a comma-separated list
   * whose first part is usually the view: "Rear 3/4 view, high angle, ..."). Matched only as a phrase
   * ending in "view" within one comma part - never a bare "back": prompts say "lying on back",
   * "leaning back", "head back" on front/profile poses (that hid ~40 faces wrongly, fixed 2026-10-04).
   *   rear / back view, incl. rear 3/4  -> nose + both eyes hidden, plus the far ear if the head is turned
   *   front or side 3/4                 -> far ear hidden
   *   profile / side view               -> far eye + far ear hidden
   */
  const skDefaultHidden = (p, sk) => {
    const parts = `${p.view || ''},${p.prompt || ''}`.toLowerCase().split(',').map((x) => x.trim());
    const view = (re) => parts.some((x) => re.test(x) && /\bview\b/.test(x));
    const far = () => skFarFace(sk);
    if (view(/\b(rear|back)\b/)) return [0, 14, 15, ...skRearFarEar(sk)];
    if (view(/(3\/4|three[- ]quarter)/)) { const f = far(); return f ? [f[1]] : []; }
    if (view(/\b(profile|side)\b/)) return far() || [];
    return [];
  };

  // OpenPose drawing standard (controlnet_aux util.draw_bodypose / draw_handpose).
  const SK_LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
  const SK_COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170],
    [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]];
  const SK_HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]];
  const hsvRgb = (h) => { const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f; const [r, g, b] = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][i % 6]; return [r, g, b].map((v) => Math.round(v * 255)); };
  function skSvg(sk) {
    const W = sk.width, H = sk.height, u = Math.max(W, H) / 512;        // OpenPose sizes are for a 512 canvas
    const stick = Math.max(2, 4 * u), dot = Math.max(2, 4 * u), hdot = Math.max(1.5, 2 * u), hline = Math.max(1, 1.5 * u);
    const hidden = new Set(sk.hidden || []);
    const B = (i) => (!hidden.has(i) && sk.body[i]) || null;
    const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    let s = '';
    SK_LIMBS.forEach(([a, b], i) => {
      const p = B(a), q = B(b); if (!p || !q) return;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]), ang = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI;
      s += `<ellipse cx="${(p[0] + q[0]) / 2}" cy="${(p[1] + q[1]) / 2}" rx="${len / 2}" ry="${stick}" transform="rotate(${ang} ${(p[0] + q[0]) / 2} ${(p[1] + q[1]) / 2})" fill="${rgb(SK_COLORS[i], 0.6)}"/>`;
    });
    sk.body.forEach((k, i) => { if (B(i)) s += `<circle cx="${k[0]}" cy="${k[1]}" r="${dot}" fill="${rgb(SK_COLORS[i])}"/>`; });
    for (const hand of [sk.hand_left, sk.hand_right]) {
      if (!hand) continue;
      SK_HAND_EDGES.forEach(([a, b], i) => { const p = hand[a], q = hand[b]; if (p && q) s += `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${rgb(hsvRgb(i / SK_HAND_EDGES.length))}" stroke-width="${hline}"/>`; });
      hand.forEach((k) => { if (k) s += `<circle cx="${k[0]}" cy="${k[1]}" r="${hdot}" fill="rgb(0,0,255)"/>`; });
    }
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`);
  }
  async function skRender(p, sk) {
    mkdirSync(SK_DIR, { recursive: true }); try { chmodSync(SK_DIR, 0o777); } catch { /* not owner */ }
    const svg = skSvg(sk);
    const mq = path.join(MQ_DIR, p.mannequin);
    await sharp(mq).resize(sk.width, sk.height, { fit: 'fill' }).composite([{ input: svg }]).png().toFile(path.join(SK_DIR, `${p.id}_overlay.png`));
    await sharp({ create: { width: sk.width, height: sk.height, channels: 3, background: '#000' } }).composite([{ input: svg }]).png().toFile(path.join(SK_DIR, `${p.id}_skel.png`));
  }
  function skLoad(id) { try { return JSON.parse(readFileSync(path.join(SK_DIR, `${id}.json`), 'utf8')); } catch { return null; } }
  /** Write a skeleton + its images and record the summary on the pose (the list never reads 180 JSON files). */
  async function skStore(id, sk) {
    const poses = loadPoses(); const p = poses.find((x) => x.id === id);
    if (!p) throw new Error(`no such pose: ${id}`);
    if (!p.mannequin) throw new Error(`${id} has no mannequin to draw the skeleton on`);
    const full = { version: 1, ...sk, mannequin_at: p.mannequin_at || null, saved_at: Date.now() };
    await skRender(p, full);
    const tmp = path.join(SK_DIR, `${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(full)); renameSync(tmp, path.join(SK_DIR, `${id}.json`));
    p.skeleton_at = full.saved_at; p.skeleton_source = full.source;
    p.skeleton_review = full.reviewed ? 0 : (full.review || []).length; p.skeleton_stale = false;
    savePoses(poses);
    return { pose: withRels(p), skeleton: full };
  }
  function skRemoveFiles(id) { for (const f of [`${id}.json`, `${id}_overlay.png`, `${id}_skel.png`]) { try { unlinkSync(path.join(SK_DIR, f)); } catch { /* gone */ } } }
  const skClear = (p) => { delete p.skeleton_at; delete p.skeleton_source; delete p.skeleton_review; delete p.skeleton_stale; };

  /** Detect on ai-epyc (CPU). keepEdited: automatic runs leave a hand-edited skeleton alone and mark it stale. */
  function skStart(ids, { keepEdited = false, auto = false, hints = null } = {}) {
    const host = MQ_HOSTS[SK_HOST];
    const all = loadPoses();
    const list = ids.map((id) => all.find((p) => p.id === id)).filter((p) => p && p.mannequin);
    if (!list.length) throw new Error('none of those poses has a mannequin yet - convert them first');
    const jobId = crypto.randomBytes(6).toString('hex');
    const job = { id: jobId, state: 'running', total: list.length, done: 0, ok: 0, errors: 0, flagged: 0, kept: 0, results: {},
                  ids: list.map((p) => p.id), auto, startedAt: Date.now(), child: null, remote_pid: null };
    skJobs.set(jobId, job);
    const taskId = `pose-skeleton:${jobId}`;
    const report = (x = {}) => taskReport({ id: taskId, source: 'pose-skeleton', done: job.done, total: job.total, ...x });
    report({ state: 'running', label: `Pose skeletons · ${list.length} pose${list.length === 1 ? '' : 's'} · ${SK_HOST} CPU` + (auto ? ' (auto)' : '') });
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    // hints: joints placed by hand in the editor; the worker keeps them and detects the rest around them.
    const hintArg = hints ? ` --hints-b64 ${q(Buffer.from(JSON.stringify(hints)).toString('base64'))}` : '';
    const cmd = `${host.python} ${SK_WORKER} --pose-dir ${q(MQ_REMOTE_POSE_DIR)} --ids ${job.ids.map(q).join(' ')}${hintArg}`;
    const child = spawn('ssh', [...sshBase(), host.ssh, cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    job.child = child;
    let ebuf = '', raw = '';
    const onResult = async (ev) => {
      job.done = ev.done;
      if (ev.status !== 'ok') { job.errors += 1; job.results[ev.id] = { status: 'error', error: ev.error }; return; }
      try {
        const old = skLoad(ev.id);
        if (keepEdited && old && old.source === 'edited') {
          const poses = loadPoses(); const p = poses.find((x) => x.id === ev.id);
          // Stale = drawn on an older mannequin than the current one (not merely "detection was asked for").
          const stale = !!(p && p.mannequin_at && old.mannequin_at !== p.mannequin_at);
          if (p && stale !== !!p.skeleton_stale) { p.skeleton_stale = stale; savePoses(poses); }
          job.kept += 1; job.results[ev.id] = { status: 'kept', note: `hand-edited skeleton kept${stale ? ' - its mannequin changed, check it' : ''}` };
          return;
        }
        const p = all.find((x) => x.id === ev.id);
        const r = await skStore(ev.id, { ...ev.skeleton, hidden: skDefaultHidden(p, ev.skeleton), source: hints?.[ev.id] ? 'edited' : 'auto', reviewed: false });
        job.ok += 1; if (r.skeleton.review.length) job.flagged += 1;
        job.results[ev.id] = { status: 'ok', review: r.skeleton.review };
      } catch (e) { job.errors += 1; job.results[ev.id] = { status: 'error', error: String(e.message || e) }; }
    };
    let chain = Promise.resolve();          // results are stored one at a time (poses.json is rewritten per result)
    child.stderr.on('data', (d) => {
      const chunk = d.toString(); raw = (raw + chunk).slice(-4000); ebuf += chunk;
      let i;
      while ((i = ebuf.indexOf('\n')) >= 0) {
        const line = ebuf.slice(0, i).trim(); ebuf = ebuf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === 'start') job.remote_pid = ev.pid;
        else if (ev.event === 'sk') chain = chain.then(() => onResult(ev)).then(() => report({ detail: `${job.ok} done${job.flagged ? `, ${job.flagged} to review` : ''}${job.errors ? `, ${job.errors} failed` : ''}` }));
      }
    });
    child.on('close', (code) => chain.then(() => {
      job.state = job.cancelled ? 'cancelled' : (job.ok || job.kept ? 'done' : 'error');
      if (job.state === 'error') job.error = `worker exited ${code}: ` + raw.trim().split('\n').filter((l) => !l.startsWith('{')).slice(-3).join(' | ');
      job.finishedAt = Date.now();
      report({ state: job.state === 'done' ? 'done' : 'failed',
               detail: job.cancelled ? `cancelled after ${job.done}/${job.total}` : `${job.ok} detected, ${job.flagged} to review${job.kept ? `, ${job.kept} hand-edited kept` : ''}${job.errors ? `, ${job.errors} failed` : ''}${job.error ? ` - ${job.error}` : ''}`.slice(0, 300) });
      setTimeout(() => skJobs.delete(jobId), 6 * 3600_000);
    }));
    child.on('error', (e) => { job.error = String(e.message || e); });
    return job;
  }
  const skPublic = (j) => ({ id: j.id, state: j.state, total: j.total, done: j.done, ok: j.ok, errors: j.errors, flagged: j.flagged, kept: j.kept,
    results: j.results, ids: j.ids, auto: j.auto, error: j.error || null, startedAt: j.startedAt, finishedAt: j.finishedAt || null });
  /** After mannequins are (re)made: detect their skeletons, keeping hand-edited ones. Never throws. */
  function skAutoDetect(ids) {
    if (!ids.length) return null;
    try { return skStart(ids, { keepEdited: true, auto: true }).id; }
    catch (e) { taskReport({ id: `pose-skeleton:auto-${Date.now()}`, source: 'pose-skeleton', state: 'failed', label: 'Pose skeletons (auto)', detail: String(e.message || e).slice(0, 300) }); return null; }
  }

  router.post('/poses/skeleton/detect', express.json(), (req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'select at least one pose' });
    // An explicit request overwrites hand edits only when asked to (the editor's "Re-detect" does).
    // hints: {poseId: [18 x ([x, y] | null)]} - "Detect from my points" in the editor.
    let hints = null;
    if (b.hints != null) {
      const okPt = (k) => k === null || (Array.isArray(k) && k.length >= 2 && k.slice(0, 2).every((v) => Number.isFinite(v)));
      const bad = typeof b.hints !== 'object' || Object.entries(b.hints).some(([id, arr]) => !ids.includes(id) || !Array.isArray(arr) || arr.length !== 18 || !arr.every(okPt));
      if (bad) return res.status(400).json({ error: 'hints must be {poseId: 18 x ([x, y] | null)} for the requested poses' });
      hints = Object.fromEntries(Object.entries(b.hints).map(([id, arr]) => [id, arr.map((k) => (k ? [k[0], k[1]] : null))]));
    }
    try { res.json({ ok: true, job: skPublic(skStart(ids, { keepEdited: !b.overwriteEdited && !hints, hints })) }); }
    catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
  router.get('/poses/skeleton/jobs', (_req, res) => {
    res.json({ ok: true, jobs: [...skJobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(skPublic) });
  });
  router.post('/poses/skeleton/cancel', express.json(), (req, res) => {
    const j = skJobs.get(String((req.body || {}).jobId || ''));
    if (!j) return res.status(404).json({ error: 'unknown job' });
    if (j.state !== 'running') return res.json({ ok: true, already: j.state });
    j.cancelled = true;
    if (j.remote_pid) { try { spawn('ssh', [...sshBase(), MQ_HOSTS[SK_HOST].ssh, `kill -TERM ${parseInt(j.remote_pid, 10)} 2>/dev/null || true`], { stdio: 'ignore' }); } catch { /* best effort */ } }
    setTimeout(() => { try { j.child.kill('SIGTERM'); } catch { /* gone */ } }, 3000);
    res.json({ ok: true, cancelled: true });
  });
  router.get('/poses/skeleton/:id', (req, res) => {
    const p = (() => { try { return loadPoses().find((x) => x.id === req.params.id); } catch { return null; } })();
    if (!p) return res.status(404).json({ error: `no such pose: ${req.params.id}` });
    const sk = skLoad(p.id);
    res.json({ ok: true, pose: withRels(p), skeleton: sk, default_hidden: skDefaultHidden(p, sk),
               stale: !!(sk && p.mannequin_at && sk.mannequin_at !== p.mannequin_at) });
  });
  const skPoint = (k) => (k === null ? null : (Array.isArray(k) && k.length >= 2 && k.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))
    ? [Math.round(k[0] * 10) / 10, Math.round(k[1] * 10) / 10, k.length > 2 ? Math.max(0, Math.min(1, k[2])) : 1] : undefined));
  /** Save a hand-edited skeleton (from the editor). "OK as is" saves the detected one unchanged with reviewed=true. */
  router.post('/poses/skeleton/save', express.json({ limit: '2mb' }), async (req, res) => {
    const b = req.body || {}; const id = String(b.id || ''); const s = b.skeleton || {};
    const body = Array.isArray(s.body) && s.body.length === 18 ? s.body.map(skPoint) : null;
    const hand = (h) => (h == null ? null : Array.isArray(h) && h.length === 21 ? h.map(skPoint) : undefined);
    const hl = hand(s.hand_left), hr = hand(s.hand_right);
    if (!body || body.includes(undefined) || hl === undefined || hr === undefined || (hl && hl.includes(undefined)) || (hr && hr.includes(undefined)))
      return res.status(400).json({ error: 'skeleton must have 18 body points and 21-point hands (null = missing)' });
    const W = parseInt(s.width, 10), H = parseInt(s.height, 10);
    if (!(W > 0 && H > 0)) return res.status(400).json({ error: 'width/height required' });
    const hidden = Array.isArray(s.hidden) ? [...new Set(s.hidden.map((i) => parseInt(i, 10)).filter((i) => i >= 0 && i < 18))] : [];
    try {
      const r = await skStore(id, { width: W, height: H, body, hand_left: hl, hand_right: hr, hidden, framing: s.framing || null,
                                    review: Array.isArray(s.review) ? s.review.map(String).slice(0, 20) : [], reviewed: true,
                                    source: b.unchanged ? (s.source || 'auto') : 'edited' });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });
  router.post('/poses/skeleton/remove', express.json(), (req, res) => {
    const id = String((req.body || {}).id || '');
    let poses; try { poses = loadPoses(); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const p = poses.find((x) => x.id === id);
    if (!p) return res.status(404).json({ error: `no such pose: ${id}` });
    skClear(p);
    try { savePoses(poses); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    skRemoveFiles(id);
    res.json({ ok: true, pose: withRels(p) });
  });

  router.get('/poses', (_req, res) => {
    try {
      const poses = loadPoses();
      res.json({
        ok: true,
        count: poses.length,
        categories: [...new Set(poses.map((p) => p.category).filter(Boolean))].sort(),
        views: [...new Set(poses.map((p) => p.view).filter(Boolean))].sort(),
        // rel is what /thumb and /image want, so the UI never builds a path itself
        poses: poses.map(withRels),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  router.post('/poses/update', express.json(), (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    let poses;
    try { poses = loadPoses(); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const pose = poses.find((p) => p.id === id);
    if (!pose) return res.status(404).json({ error: `no such pose: ${id}` });
    // name and image are deliberately NOT editable: name is the workflow-facing id, and
    // image is managed by add/delete so the JSON can never name a file that is not there.
    for (const field of ['prompt', 'category', 'view']) {
      if (typeof b[field] === 'string') pose[field] = b[field].trim();
    }
    if (!pose.prompt) return res.status(400).json({ error: 'prompt cannot be empty — it is what the node emits' });
    try { savePoses(poses); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    res.json({ ok: true, pose: withRels(pose) });
  });

  router.post('/poses/add', express.json({ limit: '25mb' }), async (req, res) => {
    const b = req.body || {};
    const prompt = String(b.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    let poses;
    try { poses = loadPoses(); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }

    // Next free numeric slot, not length+1: deleting pose 60 and adding one must not
    // reuse an id that an old workflow might still name.
    const used = new Set(poses.map((p) => parseInt(String(p.id).replace(/\D/g, ''), 10)).filter(Number.isFinite));
    let n = 1; while (used.has(n)) n += 1;
    const num = String(n).padStart(3, '0');
    const id = `pose_${num}`;
    const view = String(b.view || '').trim();
    const category = String(b.category || '').trim();
    const title = (word) => word.replace(/\b\w/g, (c) => c.toUpperCase());
    const name = String(b.name || '').trim()
      || [num, title(view || 'custom'), title(category || 'pose')].join(' | ');
    if (poses.some((p) => p.name === name)) {
      return res.status(409).json({ error: `a pose named "${name}" already exists — names are ids here` });
    }

    // Source: an image already in the imagegen tree (the normal case — Travis browses
    // his own references), or raw base64 for anything else.
    let buf;
    try {
      if (b.source_path) {
        const src = safeResolve(String(b.source_path));
        if (!existsSync(src) || !statSync(src).isFile()) return res.status(404).json({ error: 'source_path not found' });
        buf = readFileSync(src);
      } else if (b.image_b64) {
        buf = Buffer.from(String(b.image_b64).replace(/^data:[^,]+,/, ''), 'base64');
      } else {
        return res.status(400).json({ error: 'source_path or image_b64 required' });
      }
    } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }

    const file = `${id}.webp`;
    try {
      // Normalised to the exact size every shipped thumbnail uses, so the canvas gallery
      // lays out uniformly instead of one tile being a different shape.
      const out = await sharp(buf).rotate()
        .resize(POSE_W, POSE_H, POSE_FIT)
        .webp({ quality: 82 }).toBuffer();
      mkdirSync(POSE_IMAGES, { recursive: true });
      writeFileSync(path.join(POSE_IMAGES, file), out);
      try { chmodSync(path.join(POSE_IMAGES, file), 0o664); } catch { /* not owner */ }
    } catch (e) { return res.status(400).json({ error: 'could not read that image: ' + String(e.message || e) }); }

    const pose = { id, index: n, category, view, name, prompt, image: file,
                   ...(b.source_path ? { source: String(b.source_path) } : {}) };
    poses.push(pose);
    poses.sort((a, c) => (a.index || 0) - (c.index || 0));
    try { savePoses(poses); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const autoJob = mqAutoConvert([id]);
    res.json({ ok: true, pose: { ...pose, rel: `pose_library/pose_images/${file}` }, restart_required: true, mannequin_job: autoJob });
  });

  // ---- Add a SELECTION of browsed images as poses, captions becoming the prompts. ----
  // The pose-only captioner already produces exactly the text a pose entry wants
  // ("low angle, rear view, bent over, legs apart"), so a captioned reference folder is
  // a pose library that has not been imported yet. This is that import.
  router.post('/poses/add-from-images', express.json(), async (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    const files = Array.isArray(b.files) ? b.files : [];
    if (!files.length) return res.status(400).json({ error: 'no files' });
    const ext = b.caption_ext === 'txt' ? 'txt' : 'caption';
    const category = String(b.category || '').trim();
    const view = String(b.view || '').trim();
    const dryRun = !!b.dry_run;

    let poses;
    try { poses = loadPoses(); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const used = new Set(poses.map((p) => parseInt(String(p.id).replace(/\D/g, ''), 10)).filter(Number.isFinite));
    const names = new Set(poses.map((p) => p.name));
    const title = (w) => w.replace(/\b\w/g, (c) => c.toUpperCase());

    const added = []; const skipped = [];
    for (const raw of files) {
      const nm = resolveImageName(dir, String(raw || ''));
      if (!nm) { skipped.push({ file: String(raw), why: 'not an image in this folder' }); continue; }
      const src = path.join(dir, nm);
      const capPath = src.replace(/\.[^/.]+$/, '') + '.' + ext;
      let prompt = '';
      try { prompt = readFileSync(capPath, 'utf8').trim(); } catch { /* no sidecar */ }
      // A pose with no prompt is useless — the node would emit an empty string — so an
      // uncaptioned image is REPORTED rather than imported as a blank entry that looks
      // fine in the grid and silently contributes nothing.
      if (!prompt) { skipped.push({ file: nm, why: `no .${ext} caption` }); continue; }

      let n = 1; while (used.has(n)) n += 1;
      const num = String(n).padStart(3, '0');
      const name = [num, title(view || 'custom'), title(category || 'pose')].join(' | ');
      if (names.has(name)) { skipped.push({ file: nm, why: `name "${name}" already exists` }); continue; }

      if (dryRun) {
        added.push({ file: nm, id: `pose_${num}`, name, prompt });
        used.add(n); names.add(name);
        continue;
      }

      const id = `pose_${num}`;
      const out = `${id}.webp`;
      try {
        const buf = await sharp(readFileSync(src)).rotate()
          .resize(POSE_W, POSE_H, POSE_FIT)
          .webp({ quality: 82 }).toBuffer();
        mkdirSync(POSE_IMAGES, { recursive: true });
        writeFileSync(path.join(POSE_IMAGES, out), buf);
        try { chmodSync(path.join(POSE_IMAGES, out), 0o664); } catch { /* not owner */ }
      } catch (e) { skipped.push({ file: nm, why: 'image failed: ' + String(e.message || e) }); continue; }

      // Record the source. Without it an import is irreversible: the stored file is the
      // only copy and any resize mistake (as `cover` was) can never be undone in place.
      const pose = { id, index: n, category, view, name, prompt, image: out,
                     source: path.relative(BASE, src) };
      poses.push(pose);
      used.add(n); names.add(name);
      added.push({ file: nm, id, name, prompt });
    }

    if (!dryRun && added.length) {
      poses.sort((a, c) => (a.index || 0) - (c.index || 0));
      try { savePoses(poses); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }
    const autoJob = !dryRun && added.length ? mqAutoConvert(added.map((a) => a.id)) : null;
    res.json({ ok: true, dry_run: dryRun, added: added.length, skipped: skipped.length,
               added_poses: added, skipped_files: skipped, restart_required: !dryRun && added.length > 0, mannequin_job: autoJob });
  });

  router.post('/poses/delete', express.json(), (req, res) => {
    const id = String((req.body || {}).id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    let poses;
    try { poses = loadPoses(); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const pose = poses.find((p) => p.id === id);
    if (!pose) return res.status(404).json({ error: `no such pose: ${id}` });
    const rest = poses.filter((p) => p.id !== id);
    try { savePoses(rest); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    // Image removed only AFTER the JSON commit: if the write failed the pose still
    // exists and must still have its picture.
    try { unlinkSync(path.join(POSE_IMAGES, pose.image)); } catch { /* already gone */ }
    if (pose.mannequin) { try { unlinkSync(path.join(MQ_DIR, pose.mannequin)); } catch { /* already gone */ } }
    skRemoveFiles(id);
    res.json({ ok: true, deleted: id, remaining: rest.length, restart_required: true });
  });

  router.post('/transfer-folders', express.json(), (req, res) => {
    const { op, src: srcRel, dest: destRel, folders } = req.body || {};
    if (op !== 'move' && op !== 'copy') return res.status(400).json({ error: 'op must be move|copy' });
    let srcDir, destDir;
    try { srcDir = safeResolve(srcRel); destDir = safeResolve(destRel); }
    catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) return res.status(404).json({ error: 'src not a directory' });
    if (!Array.isArray(folders) || !folders.length) return res.status(400).json({ error: 'no folders' });
    // The destination must be in the curation area too — this browser shows the whole
    // /imagegen tree, and relocating a model directory here would break the paths
    // ComfyUI resolves by name.
    const destParts = path.relative(BASE, destDir).split(path.sep).filter(Boolean);
    if (!destParts.length || !DELETABLE_ROOTS.has(destParts[0])) {
      return res.status(400).json({ error: `destination must be inside one of: ${[...DELETABLE_ROOTS].sort().join(', ')}` });
    }
    try { mkdirSync(destDir, { recursive: true }); chmodSync(destDir, 0o777); } catch { /* ignore */ }

    let done = 0; const errors = []; const moved = [];
    for (const name of folders) {
      if (typeof name !== 'string' || !name || name.includes('/') || name.includes('..') || name.startsWith('.')) {
        errors.push({ name, why: 'bad name' }); continue;
      }
      const from = path.join(srcDir, name);
      // assertDeletable also enforces depth >= 2, so a top-level root can never be moved.
      try { assertDeletable(from); } catch (e) { errors.push({ name, why: String(e.message || e) }); continue; }
      if (!existsSync(from) || !statSync(from).isDirectory()) { errors.push({ name, why: 'not a folder' }); continue; }
      const to = path.join(destDir, name);
      // 🛑 Moving a folder INTO ITSELF (or into its own descendant) is the one way this
      // loses data outright — rename() would either fail or bury the tree inside itself.
      if (to === from || destDir === from || destDir.startsWith(from + path.sep)) {
        errors.push({ name, why: 'cannot move a folder into itself' }); continue;
      }
      if (existsSync(to)) { errors.push({ name, why: 'a folder of that name already exists there' }); continue; }
      try {
        if (op === 'move') {
          try { renameSync(from, to); }
          catch { cpSync(from, to, { recursive: true }); rmSync(from, { recursive: true, force: true }); }  // cross-device
        } else {
          cpSync(from, to, { recursive: true });
        }
        moved.push(name); done++;
      } catch (e) { errors.push({ name, why: String(e.message || e) }); }
    }
    res.json({ ok: true, op, done, moved, errors, dest: path.relative(BASE, destDir) });
  });

  router.post('/delete-folder', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    const confirm = !!(req.body && req.body.confirm);
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    try { assertDeletable(dir); } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });

    // Count the whole subtree, not just the top level: "3 images" on a folder that also
    // holds four training sets would understate what is about to go.
    let nImages = 0, nOther = 0, nFolders = 0;
    const walk = (d) => {
      let ents;
      try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isDirectory()) { nFolders++; walk(path.join(d, e.name)); }
        else if (isImage(e.name)) nImages++;
        else nOther++;
      }
    };
    walk(dir);
    if (!confirm) {
      return res.json({ needs_confirm: true, path: rel, n_images: nImages,
                        n_subfolders: nFolders, n_other_files: nOther });
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      res.json({ ok: true, deleted: rel, n_images: nImages, n_subfolders: nFolders, n_other_files: nOther });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- Pin (or clear) which image represents a folder in the browser. ------------
  // Stored as a dot-file INSIDE the folder it describes, so it travels with the folder
  // on a move/rename and cannot go stale in a central index. file:'' clears the pin
  // and returns the folder to auto-pick.
  router.post('/folder-preview', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    const file = (req.body && req.body.file) || '';
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    const marker = path.join(dir, PREVIEW_MARKER);
    if (!file) {
      try { if (existsSync(marker)) unlinkSync(marker); } catch { /* best effort */ }
      return res.json({ ok: true, pinned: '', preview: folderPreview(dir) });
    }
    if (typeof file !== 'string' || file.includes('/') || file.includes('..') || !isImage(file)) {
      return res.status(400).json({ error: 'file must be an image name inside this folder' });
    }
    if (!existsSync(path.join(dir, file))) return res.status(404).json({ error: `no such image: ${file}` });
    try {
      writeFileSync(marker, file, 'utf8');
      res.json({ ok: true, pinned: file, preview: path.relative(BASE, path.join(dir, file)) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

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

  // ---- wipe ALL ratings + comments for a folder / training set (both live in _ratings.json).
  // body: { path:<folder>, files?:[names] }  — omit files to clear the whole folder. ----
  router.post('/wipe-ratings', express.json(), (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });
    const ratings = loadRatings(dir);
    const before = Object.keys(ratings).length;
    let cleared = 0;
    if (Array.isArray(b.files) && b.files.length) {
      for (const raw of b.files) {
        const file = resolveImageName(dir, String(raw || ''));
        if (file && file in ratings) { delete ratings[file]; cleared++; }
      }
      saveRatings(dir, ratings);
    } else {
      cleared = before;
      saveRatings(dir, {});   // empty map -> unlinks _ratings.json
    }
    res.json({ ok: true, cleared, before });
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
    // A comma is the SEPARATOR here, so it can never be part of a tag: strip it from both
    // ends. Without this, typing "large bulge," carried its own comma into the token and the
    // rejoin wrote "large bulge,," — whether the user remembered the comma changed the result.
    const norm = (t) => String(t).replace(/^[\s,]+|[\s,]+$/g, '');
    const remove = new Set((b.remove || []).map(norm));
    tags = tags.filter((t) => !remove.has(t));
    for (const t of (b.add || []).map(norm)) { if (t && !tags.includes(t)) tags.push(t); }
    try {
      if (!tags.length) { if (existsSync(txt)) unlinkSync(txt); }
      else { writeFileSync(txt, tags.join(', '), 'utf8'); try { chmodSync(txt, 0o664); } catch { /* not owner; already 0664 */ } }
      res.json({ ok: true, tags });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---- tags-batch: add/remove the SAME tags across many images in one call ----
  // POST { path:<folder rel>, files?:[names], add?:[], remove?:[],
  //        position?:'start'|'after_trigger'|'end', exts?:['txt','caption'] }
  // `files` omitted = every image in the folder. Per-image round-trips (POST /tags) were the
  // only way to do this, which is 650+ requests on a real set and no way to put a trigger word
  // FIRST -- and position matters: kohya reads the leading token as the trigger, so a blanket
  // trigger must prepend, not append.
  router.post('/tags-batch', express.json(), (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });

    // A comma is the SEPARATOR here, so it can never be part of a tag: strip it from both
    // ends. Without this, typing "large bulge," carried its own comma into the token and the
    // rejoin wrote "large bulge,," — whether the user remembered the comma changed the result.
    const norm = (t) => String(t).replace(/^[\s,]+|[\s,]+$/g, '');
    const add = (Array.isArray(b.add) ? b.add : []).map(norm).filter(Boolean);
    const remove = new Set((Array.isArray(b.remove) ? b.remove : []).map(norm).filter(Boolean));
    if (!add.length && !remove.size) return res.status(400).json({ error: 'nothing to add or remove' });
    // 'start' prepends (in FRONT of the trigger), 'after_trigger' slots in at index 1 so the
    // leading token keeps being the trigger, 'end' appends. Default stays 'start'.
    const position = b.position === 'end' || b.position === 'after_trigger' ? b.position : 'start';
    // WHICH sidecars to write. .caption is treated as the same comma-separated list as .txt:
    // that is what makes 'after the trigger' mean anything in a natural-language caption, and
    // the rejoin is what writes the comma AFTER an inserted term. Defaults to .txt alone, so a
    // direct API caller keeps the behaviour this endpoint has always had.
    const exts = Array.isArray(b.exts) && b.exts.length
      ? b.exts.filter((e) => e === 'txt' || e === 'caption') : ['txt'];
    if (!exts.length) return res.status(400).json({ error: "exts must include 'txt' and/or 'caption'" });

    let names;
    if (Array.isArray(b.files) && b.files.length) {
      names = b.files.map((n) => resolveImageName(dir, String(n || ''))).filter(Boolean);
    } else {
      try { names = readdirSync(dir).filter((f) => isImage(f) && !isCollageFile(f)); }
      catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }

    let changed = 0, unchanged = 0, cleared = 0; const errors = [];
    for (const nm of names) {
     for (const ext of exts) {
      const txt = path.join(dir, nm).replace(/\.[^/.]+$/, '') + '.' + ext;
      let tags = [];
      try { if (existsSync(txt)) tags = readFileSync(txt, 'utf8').split(',').map(norm).filter(Boolean); }
      catch { errors.push(nm + '.' + ext); continue; }
      // An absent .caption is nothing to blanket-tag: writing one would invent a
      // natural-language caption out of a tag list. An absent .txt is still created, which is
      // how a blanket trigger gets applied to a freshly-added folder.
      if (ext === 'caption' && !tags.length) { unchanged++; continue; }
      const before = tags.join(', ');
      tags = tags.filter((t) => !remove.has(t));
      // Re-seat rather than skip: a tag already present but in the wrong place still needs to
      // move when the caller asked for it at the start.
      const addSet = new Set(add);
      tags = tags.filter((t) => !addSet.has(t));
      if (position === 'end') tags = [...tags, ...add];
      // after_trigger degrades sensibly at both edges: an empty caption has no trigger to
      // follow, so the tags simply become the caption; a trigger-only caption keeps the
      // trigger leading and the additions land behind it.
      else if (position === 'after_trigger') tags = tags.length ? [tags[0], ...add, ...tags.slice(1)] : [...add];
      else tags = [...add, ...tags];
      const after = tags.join(', ');
      if (after === before) { unchanged++; continue; }
      try {
        if (!tags.length) { if (existsSync(txt)) { unlinkSync(txt); cleared++; } }
        else { writeFileSync(txt, after, 'utf8'); try { chmodSync(txt, 0o664); } catch { /* not owner */ } }
        changed++;
      } catch { errors.push(nm + '.' + ext); }
     }
    }
    res.json({ ok: true, total: names.length, changed, unchanged, cleared, errors, exts });
  });

  // ---- Find & replace across caption sidecars.
  // POST { path, files?, find, replace, exts?:['txt','caption'], whole_tag?, case_sensitive?, dry_run? }
  // .txt is comma-tokenised; .caption is free prose. See the two modes below.
  /** Images a caption operation covers: the folder's own images, plus every subfolder's when
   *  recursive. Skips hidden and `_`-prefixed folders (trash, quarantine, batches). */
  function captionScopeEntries(dir, recursive) {
    const out = [];
    (function walk(d, depth) {
      const ents = readdirSync(d, { withFileTypes: true });
      for (const e of ents) {
        if (e.isFile() && isImage(e.name) && !isCollageFile(e.name)) out.push({ d, nm: e.name });
        else if (recursive && e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && depth < 8) walk(path.join(d, e.name), depth + 1);
      }
    })(dir, 0);
    return out;
  }

  // ---- Which triggers are in use: the leading comma token of every sidecar in scope, counted.
  // GET ?path=<folder rel>&recursive=1[&files=a.jpg,b.jpg] -> { triggers: [{ trigger, count, txt, caption, folders }] }
  // Lets the find & replace dialog show "wrong_trigger x 162" instead of making the user guess.
  router.get('/caption-triggers', (req, res) => {
    let dir;
    try { dir = safeResolve(String(req.query.path || '')); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });
    let entries;
    try {
      const files = String(req.query.files || '').split(',').map((x) => x.trim()).filter(Boolean);
      entries = files.length
        ? files.map((n) => resolveImageName(dir, n)).filter(Boolean).map((nm) => ({ d: dir, nm }))
        : captionScopeEntries(dir, req.query.recursive === '1' || req.query.recursive === 'true');
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    const map = new Map();
    let scanned = 0;
    for (const { d, nm } of entries) {
      for (const ext of ['txt', 'caption']) {
        const p = ext === 'txt' ? captionPath(path.join(d, nm)) : path.join(d, nm).replace(/\.[^/.]+$/, '') + '.caption';
        if (!existsSync(p)) continue;
        let raw; try { raw = readFileSync(p, 'utf8'); } catch { continue; }
        scanned++;
        const lead = raw.split(',')[0].trim();
        if (!lead || lead.length > 60 || /\s{1}\S+\s+\S+\s+\S+/.test(lead)) continue;   // a long / sentence-like first "token" is prose, not a trigger
        const t = map.get(lead) || { trigger: lead, count: 0, txt: 0, caption: 0, folders: new Set() };
        t.count++; t[ext]++; t.folders.add(path.relative(dir, d) || '.');
        map.set(lead, t);
      }
    }
    const triggers = [...map.values()].sort((a, b) => b.count - a.count).slice(0, 40)
      .map((t) => ({ ...t, folders: [...t.folders].slice(0, 6) }));
    res.json({ ok: true, scanned, triggers });
  });

  router.post('/caption-replace', express.json(), (req, res) => {
    const b = req.body || {};
    let dir;
    try { dir = safeResolve(b.path); } catch { return res.status(400).json({ error: 'bad path' }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'not a directory' });

    const find = String(b.find == null ? '' : b.find);
    const replace = String(b.replace == null ? '' : b.replace);
    // TRIGGER MODE targets the LEADING token only — the trigger word every caption starts
    // with ("futanari_bulge, Rear view..."). Ordinary replace can't express that: whole_tag
    // matches a token in ANY position and only applies to .txt, and .caption is a plain
    // substring replace, so a trigger that also occurs mid-sentence would be rewritten too.
    // It is also the only mode that can change a trigger you don't know: with find empty it
    // replaces whatever leads the file. A LoRA's trigger IS whatever the captions say, so
    // being able to rewrite it exactly is the difference between a working trigger and one
    // the model never saw.
    const triggerMode = String(b.mode || '') === 'trigger';
    // An empty `find` would match at every position and rewrite every caption to noise —
    // except in trigger mode, where empty means "whatever token is currently first".
    if (!find && !triggerMode) return res.status(400).json({ error: 'find is required' });
    const exts = Array.isArray(b.exts) && b.exts.length
      ? b.exts.filter((e) => e === 'txt' || e === 'caption')
      : ['txt', 'caption'];
    if (!exts.length) return res.status(400).json({ error: "exts must include 'txt' and/or 'caption'" });
    const wholeTag = !!b.whole_tag;
    const cs = !!b.case_sensitive;
    const dryRun = !!b.dry_run;

    // entries: [{ d: folder, nm: image name }]. `recursive` (folder scope only) walks every
    // subfolder too, so one run covers all the training sets under a parent folder - without it a
    // replace started from the parent touched only images sitting directly in it.
    let entries;
    if (Array.isArray(b.files) && b.files.length) {
      entries = b.files.map((n) => resolveImageName(dir, String(n || ''))).filter(Boolean).map((nm) => ({ d: dir, nm }));
    } else {
      try { entries = captionScopeEntries(dir, !!b.recursive); }
      catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }

    const eq = (a, x) => (cs ? a === x : a.toLowerCase() === x.toLowerCase());
    // Escaped: `find` is literal user text, not a pattern. Without this a stray ( or * is a
    // syntax error at best and a wrong match at worst.
    const rx = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi');

    /** -> { text, hits } for one sidecar body. */
    const applyTxt = (raw) => {
      if (!wholeTag) {
        const hits = (raw.match(rx) || []).length;
        return { text: hits ? raw.replace(rx, replace) : raw, hits };
      }
      const toks = raw.split(',').map((t) => t.trim()).filter(Boolean);
      let hits = 0;
      const out = [];
      for (const t of toks) {
        if (!eq(t, find)) { out.push(t); continue; }
        hits++;
        if (replace) out.push(replace);      // empty replacement DROPS the token
      }
      // De-dup only when a replacement collapsed two tokens into the same one.
      const seen = new Set();
      const dedup = out.filter((t) => { const k = cs ? t : t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
      return { text: dedup.join(', '), hits };
    };

    /**
     * Replace ONLY the leading token. The remainder is preserved byte-for-byte — the tail is
     * sliced from the original including its comma, never re-joined from parsed tokens, so a
     * trigger rename cannot quietly renormalise spacing or drop a duplicate elsewhere in the
     * caption the way the whole_tag path deliberately does.
     */
    // A trigger can be several comma tokens ("evegladden, satin_panties"): Find with commas
    // matches that many LEADING tokens, all of them, in order.
    const findToks = find.split(',').map((t) => t.trim()).filter(Boolean);
    const applyTrigger = (raw) => {
      const k = Math.max(1, findToks.length);
      let idx = -1;
      for (let i = 0, from = 0; i < k; i++) { idx = raw.indexOf(',', from); if (idx === -1) break; from = idx + 1; }
      if (idx === -1 && k > 1) {
        // fewer than k commas: the whole caption must BE the k tokens to match
        const all = raw.split(',').map((t) => t.trim()).filter(Boolean);
        if (all.length !== k || !all.every((t, i) => eq(t, findToks[i]))) return { text: raw, hits: 0 };
        return { text: replace, hits: 1 };
      }
      const head = idx === -1 ? raw : raw.slice(0, idx);
      const tail = idx === -1 ? '' : raw.slice(idx);      // keeps the comma + original spacing
      const cur = head.trim();
      if (!cur) return { text: raw, hits: 0 };
      if (find) {
        const curToks = head.split(',').map((t) => t.trim());
        if (curToks.length !== findToks.length || !curToks.every((t, i) => eq(t, findToks[i]))) return { text: raw, hits: 0 };
      } else if (idx === -1) {
        // No comma and no `find` to confirm intent: this is a one-line caption, not a
        // trigger + body. Replacing here would overwrite the ENTIRE caption, so refuse.
        return { text: raw, hits: 0 };
      }
      if (!replace) return { text: tail.replace(/^,\s*/, ''), hits: 1 };   // drop the trigger
      return { text: replace + tail, hits: 1 };
    };

    let filesScanned = 0, filesChanged = 0, occurrences = 0;
    const samples = []; const errors = [];
    for (const { d, nm } of entries) {
      const shown = path.relative(dir, path.join(d, nm));
      for (const ext of exts) {
        const p = ext === 'txt'
          ? captionPath(path.join(d, nm))
          : path.join(d, nm).replace(/\.[^/.]+$/, '') + '.caption';
        if (!existsSync(p)) continue;
        let raw;
        try { raw = readFileSync(p, 'utf8'); } catch { errors.push(shown + '.' + ext); continue; }
        filesScanned++;
        // whole_tag is a TAG-LIST concept; .caption is prose with no token boundaries, so it
        // is always a substring replace there whatever the flag says.
        // The trigger leads BOTH sidecar kinds, so trigger mode applies identically to each —
        // unlike whole_tag, which is a tag-list concept and is meaningless in prose.
        const { text, hits } = triggerMode
          ? applyTrigger(raw)
          : (ext === 'txt')
            ? applyTxt(raw)
            : (() => { const h = (raw.match(rx) || []).length; return { text: h ? raw.replace(rx, replace) : raw, hits: h }; })();
        if (!hits || text === raw) continue;
        occurrences += hits;
        filesChanged++;
        if (samples.length < 5) samples.push({ file: shown, ext, before: raw.slice(0, 200), after: text.slice(0, 200) });
        if (dryRun) continue;
        try {
          if (!text.trim()) { unlinkSync(p); }        // an emptied sidecar is removed, not left blank
          else { writeFileSync(p, text, 'utf8'); try { chmodSync(p, 0o664); } catch { /* not owner */ } }
        } catch { errors.push(shown + '.' + ext); filesChanged--; occurrences -= hits; }
      }
    }
    res.json({ ok: true, dry_run: dryRun, mode: triggerMode ? 'trigger' : 'text',
               files_scanned: filesScanned, files_changed: filesChanged,
               occurrences, samples, errors });
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
  // ---- Rename an ORDINARY folder. ------------------------------------------------
  // Training sets/batches keep using /rename-set, which rebuilds the name from the kind
  // prefix so a rename can never turn a set into a batch. This route is for everything
  // else, where the name is just a name.
  router.post('/rename-folder', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    const raw = String((req.body && req.body.name) || '').trim();
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    try { assertDeletable(dir); } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    const cur = path.basename(dir);
    if (isTrainingSetName(cur) || isTrainingBatchName(cur)) {
      return res.status(400).json({ error: 'training sets and batches rename by suffix — use the set rename' });
    }
    if (!raw || raw.includes('/') || raw.includes('..') || raw.startsWith('.')) {
      return res.status(400).json({ error: 'name cannot be empty, contain / or .., or start with a dot' });
    }
    // Leading UNDERSCORE is allowed and common here (_merged, _batches, _incoming); only a
    // leading DOT is refused, since dot-folders are hidden from browse and every count.
    if (!/^[A-Za-z0-9_][A-Za-z0-9._ -]*$/.test(raw)) {
      return res.status(400).json({ error: 'name must start with a letter, digit or underscore, and may use letters, digits, spaces, dot, dash and underscore' });
    }
    // Renaming INTO the set/batch convention would silently change what the folder is
    // to every other route that tests the name.
    if (isTrainingSetName(raw) || isTrainingBatchName(raw)) {
      return res.status(400).json({ error: `"${raw}" is the training set/batch naming convention — pick another name` });
    }
    const dest = path.join(path.dirname(dir), raw);
    if (dest === dir) return res.json({ ok: true, path: path.relative(BASE, dir), unchanged: true });
    if (existsSync(dest)) return res.status(409).json({ error: 'a folder with that name already exists here' });
    try {
      renameSync(dir, dest);
      res.json({ ok: true, path: path.relative(BASE, dest) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  router.post('/rename-set', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    const suffix = (req.body && req.body.suffix || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    let dir;
    try { dir = safeResolve(rel); } catch { return res.status(400).json({ error: 'bad path' }); }
    // Sets AND batches rename the same way: the prefix comes from what the folder IS
    // (so a rename can never turn one kind into the other), the suffix from the user.
    const kindPrefix = isTrainingSetName(path.basename(dir)) ? 'training_set'
      : (isTrainingBatchName(path.basename(dir)) ? 'training_batch' : null);
    if (!kindPrefix) return res.status(400).json({ error: 'not a training set or training batch' });
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(404).json({ error: 'no such folder' });
    const newName = kindPrefix + (suffix ? `_${suffix}` : '');
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

  // ---- List every training batch in the tree (for the add-to-batch picker). ----
  router.get('/training-batches', (_req, res) => {
    const out = [];
    (function walk(dir) {
      let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') || !e.isDirectory()) continue;
        const abs = path.join(dir, e.name);
        if (isTrainingBatchName(e.name)) {
          let n = 0;
          try { for (const c of readdirSync(abs)) if (!c.startsWith('.') && isImage(c)) n++; } catch { /* ignore */ }
          out.push({ path: path.relative(BASE, abs), name: e.name, parent: path.relative(BASE, dir), count: n });
        } else if (!isTrainingSetName(e.name)) {
          walk(abs);   // batches never live inside curated sets
        }
      }
    })(BASE);
    out.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ training_batches: out });
  });

  // ---- Additively copy selected images (+ .txt/.caption sidecars) into a training batch. ----
  // ADDITIVE by design: the whole point is accumulating picks from MANY sets into one batch,
  // so nothing here removes what an earlier add put in. (The MCP create_training_batch is the
  // opposite — convergent from a single source list — and is deliberately not reused.)
  router.post('/batch-add', express.json(), (req, res) => {
    const rel = (req.body && req.body.path || '').replace(/^\/+/, '');
    const files = Array.isArray(req.body && req.body.files) ? req.body.files : [];
    const batchRel = (req.body && req.body.batch || '').replace(/^\/+/, '');
    const create = !!(req.body && req.body.create);
    if (!files.length) return res.status(400).json({ error: 'no files' });
    let srcDir, batchDir;
    try { srcDir = safeResolve(rel); batchDir = safeResolve(batchRel); } catch { return res.status(400).json({ error: 'bad path' }); }
    // Sets and batches take the same additive copy — the guard only refuses folders that
    // are NEITHER, so a stray path can't silently become a fake set/batch via create:true.
    const destBase = path.basename(batchDir);
    if (!isTrainingBatchName(destBase) && !isTrainingSetName(destBase)) {
      return res.status(400).json({ error: 'destination is not a training batch or training set (training_batch…/training_set…)' });
    }
    if (!existsSync(batchDir)) {
      if (!create) return res.status(404).json({ error: 'no such batch' });
      try { mkdirSync(batchDir, { recursive: true }); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
    }
    // Same shared-mount uid drift as auto-caption: the tagger may caption INSIDE the batch later.
    try { chmodSync(batchDir, 0o777); } catch { /* best-effort */ }
    let copied = 0, replaced = 0; const missingTags = [], notFound = [];
    for (const name0 of files) {
      const name = String(name0);
      // Collage pages are contact sheets, not training data — the grid never offers them,
      // but agents hit this endpoint directly.
      if (!name || name.startsWith('.') || name.includes('/') || name.includes('..') || isCollageFile(name)) { notFound.push(name); continue; }
      const img = path.join(srcDir, name);
      if (!existsSync(img)) { notFound.push(name); continue; }
      const had = existsSync(path.join(batchDir, name));
      try { copyFileSync(img, path.join(batchDir, name)); } catch (e) {
        return res.status(500).json({ error: `copy failed at ${name}: ${String(e.message || e)}` });
      }
      if (had) replaced++; else copied++;
      const stem = name.replace(/\.[^.]+$/, '');
      let hasTags = false;
      for (const carExt of ['.txt', '.caption']) {
        const car = path.join(srcDir, stem + carExt);
        if (existsSync(car)) {
          try { copyFileSync(car, path.join(batchDir, stem + carExt)); if (carExt === '.txt') hasTags = true; } catch { /* sidecar best-effort */ }
        }
      }
      // An image without .txt trains UNLABELED — reported, never silently passed over.
      if (!hasTags) missingTags.push(name);
    }
    res.json({ ok: true, batch: path.relative(BASE, batchDir), copied, replaced, not_found: notFound, missing_tags: missingTags });
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

  // Pre-warm posters in the background so the first visit to a video folder is not the thing
  // that pays for them. Delayed 60s so it never competes with backend startup, then HOURLY to
  // pick up clips the Immich tag sync has pulled in since. A pass with nothing to do is just a
  // tree walk plus a stat per video (local ZFS, ~0.15s for the directories), so the only real
  // cost is on a pass that genuinely has posters to make. Both timers are unref()'d: a pre-warm
  // must never be the reason this process stays alive.
  if (process.env.IMAGEGEN_POSTER_SWEEP !== '0') {
    setTimeout(() => { try { runPosterSweep(); } catch (e) { console.warn('[imagegen] poster sweep failed to start:', e.message); } }, 60_000).unref();
    setInterval(() => {
      if (posterSweep.state !== 'running') {
        try { runPosterSweep(); } catch (e) { console.warn('[imagegen] poster sweep failed to start:', e.message); }
      }
    }, 3600 * 1000).unref();
  }

  return router;
}
