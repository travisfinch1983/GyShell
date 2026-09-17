/**
 * Model library manager — browse, inspect, reorganise and bulk-rename the local model
 * collection (LoRAs, checkpoints, VAEs, embeddings, ...).
 *
 * WHY A SEPARATE ROUTER: civitai.js is already ~3k lines and is about TALKING TO CIVITAI.
 * This is about the files on disk afterwards. Mounted at /api/model-library.
 *
 * 🛑 THE CONTRACT: every move and rename here goes through applyModelMoves() from civitai.js,
 * the same function POST /rename uses. That is what keeps civitai-history.json pointing at
 * the files after they move, so the downloader still recognises them as downloaded. A second
 * history-updating implementation would drift from the first the moment either changed —
 * which already happened once with the file mover.
 *
 * Preview images are NOT served here: /api/imagegen/thumb and /api/imagegen/image already
 * serve anything under /ai-assets/imagegen with path-escape protection, and the model tree
 * lives inside it.
 */
import { Router } from 'express';
import express from 'express';
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'fs';
import { join, basename, dirname, extname } from 'path';
import { applyModelMoves, getBasePath, loadHistory, loadCivitaiConfig,
         resolveTemplateName, fixPermissions } from './civitai.js';

const MODEL_EXT = new Set(['.safetensors', '.ckpt', '.gguf', '.pt', '.bin', '.pth', '.onnx']);
const IMAGE_EXT = new Set(['.jpeg', '.jpg', '.png', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm']);
// Directories that are not part of the browsable model library.
const HIDDEN_DIRS = new Set(['outputs', 'training_images', 'temp', 'wildcards', 'skills']);
// Top-level `_`-prefixed folders are working areas (training batches, staging, organiser
// logs), not the model library — `_batches` alone holds 3344 files and would swamp the tree.
const isQuarantine = (name) => name.startsWith('_');

/** Resolve a caller-supplied relative path, refusing anything that escapes the library. */
function safeDir(rel) {
  const base = getBasePath();
  const clean = String(rel || '').replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
  const abs = clean ? join(base, clean) : base;
  if (abs !== base && !abs.startsWith(base + '/')) throw new Error('path escapes library');
  return abs;
}

/**
 * Index history ONCE per request by the on-disk path it claims, so joining a directory
 * listing to its metadata is a lookup rather than a scan per file. With ~1800 rows and a few
 * hundred files in a folder the naive version is a million string compares.
 */
function buildHistoryIndex() {
  const byPath = new Map();
  const byBase = new Map();
  for (const it of loadHistory().items || []) {
    for (const lf of it.locatedFiles || []) {
      if (!lf?.currentPath) continue;
      byPath.set(lf.currentPath, it);
      const b = basename(lf.currentPath).replace(/\.[^.]+$/, '');
      if (!byBase.has(b)) byBase.set(b, it);
    }
  }
  return { byPath, byBase };
}

/** The sidecars a model file owns: previews, metadata, everything sharing its base name. */
function siblingsOf(dir, base) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n !== base && (n.startsWith(base + '.') || n.startsWith(base + '_')));
}

function pickPreview(dir, base, sibs) {
  // `<base>.jpeg` is the primary preview the downloader writes; numbered ones follow.
  const imgs = sibs.filter((n) => IMAGE_EXT.has(extname(n).toLowerCase())).sort();
  const primary = imgs.find((n) => n.replace(/\.[^.]+$/, '') === base);
  return primary || imgs[0] || null;
}

export function createModelLibraryRouter(_opts = {}, sshService = null) {
  const router = Router();
  const json = express.json({ limit: '4mb' });
  const rel = (abs) => abs.replace(getBasePath(), '').replace(/^\//, '');

  /** GET /tree — folder tree with model counts, for the drag-and-drop target pane. */
  router.get('/tree', (req, res) => {
    const base = getBasePath();
    const walk = (abs, depth) => {
      let ents = [];
      try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return null; }
      let models = 0;
      const children = [];
      for (const e of ents) {
        if (e.isDirectory()) {
          if (isQuarantine(e.name)) continue;
          if (depth === 0 && HIDDEN_DIRS.has(e.name)) continue;
          const c = depth < 6 ? walk(join(abs, e.name), depth + 1) : null;
          if (c) { children.push(c); models += c.totalModels; }
        } else if (MODEL_EXT.has(extname(e.name).toLowerCase())) {
          models += 1;
        }
      }
      return {
        name: basename(abs), path: rel(abs), ownModels: models - children.reduce((a, c) => a + c.totalModels, 0),
        totalModels: models, children: children.sort((a, b) => a.name.localeCompare(b.name)),
      };
    };
    try {
      const t = walk(base, 0);
      res.json({ root: t, base });
    } catch (e) { res.status(500).json({ error: String(e.message) }); }
  });

  /** GET /list?dir= — model files in one folder, joined with their history metadata. */
  router.get('/list', (req, res) => {
    let abs;
    try { abs = safeDir(req.query.dir); } catch (e) { return res.status(400).json({ error: String(e.message) }); }
    if (!existsSync(abs)) return res.status(404).json({ error: 'no such folder' });
    const { byPath, byBase } = buildHistoryIndex();
    let names = [];
    try { names = readdirSync(abs); } catch { names = []; }

    const items = [];
    for (const n of names) {
      if (!MODEL_EXT.has(extname(n).toLowerCase())) continue;
      const full = join(abs, n);
      let st; try { st = statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      const base = n.replace(/\.[^.]+$/, '');
      const sibs = siblingsOf(abs, base);
      const prev = pickPreview(abs, base, sibs);
      // Path first, then base name: a file the user renamed by hand outside the app still
      // matches on its name, which is how most of the library's older rows are reachable.
      const h = byPath.get(full) || byBase.get(base) || null;
      items.push({
        name: n, base, path: rel(full), dir: rel(abs), size: st.size, mtime: st.mtimeMs,
        preview: prev ? rel(join(abs, prev)) : null,
        imageCount: sibs.filter((s) => IMAGE_EXT.has(extname(s).toLowerCase())
          || VIDEO_EXT.has(extname(s).toLowerCase())).length,
        tracked: !!h,
        modelId: h?.modelId ?? null, versionId: h?.versionId ?? null,
        modelName: h?.modelName ?? null, versionName: h?.versionName ?? null,
        modelType: h?.modelType ?? null, baseModel: h?.baseModel ?? null,
        creator: h?.creator ?? null, downloadedAt: h?.downloadedAt ?? null,
        pageUrl: h?.pageUrl ?? null,
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));

    const subdirs = names.filter((n) => {
      try { return statSync(join(abs, n)).isDirectory() && !isQuarantine(n); } catch { return false; }
    }).sort();
    res.json({ dir: rel(abs), items, subdirs, count: items.length });
  });

  /** GET /detail?path= — everything known about one model, for the inspector pane. */
  router.get('/detail', (req, res) => {
    let full;
    try { full = safeDir(req.query.path); } catch (e) { return res.status(400).json({ error: String(e.message) }); }
    if (!existsSync(full) || !statSync(full).isFile()) return res.status(404).json({ error: 'no such file' });
    const dir = dirname(full);
    const base = basename(full).replace(/\.[^.]+$/, '');
    // siblingsOf matches `<base>.<anything>`, which includes the model file itself.
    const self = basename(full);
    const sibs = siblingsOf(dir, base).filter((n) => n !== self);
    const { byPath, byBase } = buildHistoryIndex();
    const h = byPath.get(full) || byBase.get(base) || null;

    // Sidecars carry what CivitAI knew at download time — trigger words, description, the
    // full version record. Read them rather than re-fetching: this must work offline.
    const readJson = (suffix) => {
      const p = join(dir, base + suffix);
      try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; }
    };
    const versionInfo = readJson('.civit.info');
    const modelInfo = readJson('.civit.full.info') || readJson('.json');

    const media = sibs
      .filter((n) => IMAGE_EXT.has(extname(n).toLowerCase()) || VIDEO_EXT.has(extname(n).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((n) => ({ name: n, path: rel(join(dir, n)),
                     kind: VIDEO_EXT.has(extname(n).toLowerCase()) ? 'video' : 'image' }));

    const st = statSync(full);
    res.json({
      path: rel(full), dir: rel(dir), name: basename(full), base, size: st.size, mtime: st.mtimeMs,
      media,
      sidecars: sibs.filter((n) => !IMAGE_EXT.has(extname(n).toLowerCase())
        && !VIDEO_EXT.has(extname(n).toLowerCase())).sort(),
      history: h ? {
        modelId: h.modelId, versionId: h.versionId, modelName: h.modelName, versionName: h.versionName,
        modelType: h.modelType, baseModel: h.baseModel, creator: h.creator, primaryTag: h.primaryTag,
        downloadedAt: h.downloadedAt, pageUrl: h.pageUrl, pathOverride: h.pathOverride,
        fileNameOverride: h.fileNameOverride, files: h.files || [], downloadedVersions: h.downloadedVersions || [],
      } : null,
      // Only the fields worth showing — the raw records are megabytes of nested JSON.
      version: versionInfo ? {
        id: versionInfo.id, name: versionInfo.name, baseModel: versionInfo.baseModel,
        trainedWords: versionInfo.trainedWords || [], description: versionInfo.description || null,
        createdAt: versionInfo.createdAt, publishedAt: versionInfo.publishedAt,
        files: (versionInfo.files || []).map((f) => ({
          id: f.id, name: f.name, sizeKB: f.sizeKB, type: f.type,
          fp: f.metadata?.fp, format: f.metadata?.format, hashes: f.hashes || {},
        })),
        stats: versionInfo.stats || null,
      } : null,
      model: modelInfo ? {
        id: modelInfo.id, name: modelInfo.name, type: modelInfo.type, nsfw: modelInfo.nsfw,
        tags: modelInfo.tags || [], creator: modelInfo.creator?.username || null,
        description: modelInfo.description || null, stats: modelInfo.stats || null,
      } : null,
    });
  });

  /**
   * POST /move — drag-and-drop. Moves each model (with every sidecar) into `destDir`,
   * keeping its name. History follows via applyModelMoves.
   */
  router.post('/move', json, (req, res) => {
    const { paths, destDir } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'paths[] required' });
    let dest;
    try { dest = safeDir(destDir); } catch (e) { return res.status(400).json({ error: String(e.message) }); }
    try { mkdirSync(dest, { recursive: true }); } catch (e) { return res.status(500).json({ error: String(e.message) }); }

    const { byPath, byBase } = buildHistoryIndex();
    const results = [];
    for (const p of paths) {
      let from;
      try { from = safeDir(p); } catch { results.push({ path: p, ok: false, error: 'bad path' }); continue; }
      if (!existsSync(from)) { results.push({ path: p, ok: false, error: 'missing' }); continue; }
      const to = join(dest, basename(from));
      if (to === from) { results.push({ path: p, ok: true, skipped: 'already there' }); continue; }
      if (existsSync(to)) { results.push({ path: p, ok: false, error: 'name already exists in destination' }); continue; }
      const h = byPath.get(from) || byBase.get(basename(from).replace(/\.[^.]+$/, '')) || null;
      const r = applyModelMoves([{ from, to }], {
        modelId: h?.modelId || null, versionId: h?.versionId || null,
        // The folder segment beneath the type dir — what pathOverride means to the downloader,
        // so a later re-download lands where the user just dragged this.
        pathOverride: rel(dest).split('/').slice(1).join('/') || null,
        fixPerms: (d) => fixPermissions(d),
      });
      results.push({ path: p, ok: !r.errors.length, moved: r.moved.length,
                     tracked: !!h, errors: r.errors });
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`[model-library] move -> ${rel(dest)}: ${results.length - failed.length} ok, ${failed.length} failed`);
    res.json({ ok: !failed.length, dest: rel(dest), results });
  });

  /**
   * POST /rename-preview — what a template WOULD produce for each selected model.
   * Nothing is written. The manager shows this before anything moves, because a bulk rename
   * across a few hundred LoRAs is not something to discover was wrong afterwards.
   */
  router.post('/rename-preview', json, (req, res) => {
    const { paths, template, separator, caseMode } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'paths[] required' });
    if (!template) return res.status(400).json({ error: 'template required' });
    const { byPath, byBase } = buildHistoryIndex();
    const cfg = loadCivitaiConfig();
    const sep = separator || cfg.separator || '-';
    const cm = caseMode || cfg.caseMode || 'standard';

    const seen = new Map();
    const rows = paths.map((p) => {
      let from;
      try { from = safeDir(p); } catch { return { path: p, error: 'bad path' }; }
      if (!existsSync(from)) return { path: p, error: 'missing' };
      const h = byPath.get(from) || byBase.get(basename(from).replace(/\.[^.]+$/, '')) || null;
      if (!h) return { path: p, name: basename(from), error: 'not in download history — no metadata to build a name from' };
      const ext = extname(from);
      let newBase;
      try { newBase = resolveTemplateName(template, h, sep, cm); }
      catch (e) { return { path: p, error: String(e.message) }; }
      const to = join(dirname(from), newBase + ext);
      const row = { path: p, name: basename(from), newName: newBase + ext,
                    unchanged: to === from, modelName: h.modelName, versionName: h.versionName };
      // Two models resolving to one name would silently overwrite each other; surface it.
      if (seen.has(to)) row.collision = seen.get(to);
      else seen.set(to, basename(from));
      return row;
    });
    const collisions = rows.filter((r) => r.collision).length;
    res.json({ rows, collisions, changed: rows.filter((r) => r.newName && !r.unchanged && !r.error).length });
  });

  /** POST /rename-apply — perform the renames the preview showed. */
  router.post('/rename-apply', json, (req, res) => {
    const { renames } = req.body || {};   // [{ path, newName }]
    if (!Array.isArray(renames) || !renames.length) return res.status(400).json({ error: 'renames[] required' });
    const { byPath, byBase } = buildHistoryIndex();
    const results = [];
    for (const r of renames) {
      let from;
      try { from = safeDir(r.path); } catch { results.push({ path: r.path, ok: false, error: 'bad path' }); continue; }
      if (!existsSync(from)) { results.push({ path: r.path, ok: false, error: 'missing' }); continue; }
      const newName = String(r.newName || '').trim();
      if (!newName || newName.includes('/')) { results.push({ path: r.path, ok: false, error: 'bad name' }); continue; }
      const to = join(dirname(from), newName);
      if (to === from) { results.push({ path: r.path, ok: true, skipped: 'unchanged' }); continue; }
      if (existsSync(to)) { results.push({ path: r.path, ok: false, error: 'target name exists' }); continue; }
      const h = byPath.get(from) || byBase.get(basename(from).replace(/\.[^.]+$/, '')) || null;
      const out = applyModelMoves([{ from, to }], {
        modelId: h?.modelId || null, versionId: h?.versionId || null,
      });
      results.push({ path: r.path, ok: !out.errors.length, newName, moved: out.moved.length,
                     tracked: !!h, errors: out.errors });
    }
    const failed = results.filter((x) => !x.ok);
    console.log(`[model-library] rename: ${results.length - failed.length} ok, ${failed.length} failed`);
    res.json({ ok: !failed.length, results });
  });

  /** POST /mkdir — create a folder so things can be dragged into it. */
  router.post('/mkdir', json, (req, res) => {
    const { dir } = req.body || {};
    let abs;
    try { abs = safeDir(dir); } catch (e) { return res.status(400).json({ error: String(e.message) }); }
    try { mkdirSync(abs, { recursive: true }); res.json({ ok: true, dir: rel(abs) }); }
    catch (e) { res.status(500).json({ error: String(e.message) }); }
  });

  return router;
}
