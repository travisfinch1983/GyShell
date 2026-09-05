import { Router } from 'express';
import sharp from 'sharp';
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync, renameSync, createReadStream, mkdirSync, unlinkSync } from 'fs';
import { join, basename, extname } from 'path';

/**
 * Dataset Review — /api/dataset
 *
 * Backs the "Dataset Review" sub-tab under AI · Image Gen. dataset-forge (on ai-epyc) writes
 * auto-annotations into /ai-assets/imagegen/_datasets/<name>/{manifest.json,tiles,overlays};
 * this serves them for accept/reject so bad seeds are culled before they reach the labels.
 *
 * Shared storage is the reason this works: forge runs on ai-epyc for the GPU, but /imagegen
 * there is /ai-assets/imagegen here, so the backend reads the same files with no transfer.
 */
const ROOT = '/ai-assets/imagegen/_datasets';
const NAME_OK = /^[A-Za-z0-9._-]{1,64}$/;

const setDir = (name) => (NAME_OK.test(name) ? join(ROOT, name) : null);
const manPath = (dir) => join(dir, 'manifest.json');

function loadMan(dir) {
  return JSON.parse(readFileSync(manPath(dir), 'utf8'));
}
/** write-then-rename: a torn manifest would lose every review decision made so far */
function saveMan(dir, man) {
  const tmp = manPath(dir) + '.tmp';
  writeFileSync(tmp, JSON.stringify(man, null, 1));
  renameSync(tmp, manPath(dir));
}

const tally = (tiles) => tiles.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});


/**
 * Redraw <overlays>/<tile> from the tile plus its polygons.
 *
 * Without this the manifest holds the corrected mask while the overlay PNG still shows the
 * SEED mask — so a hand-corrected tile looks unchanged when you come back to it, which is
 * exactly what it looked like: "saved, but nothing happened".
 */
async function redrawOverlay(dir, tile, polys) {
  const src = join(dir, 'tiles', tile);
  if (!existsSync(src)) return false;
  const { width = 768, height = 768 } = await sharp(src).metadata();
  if (!polys.length) {
    // no polygons left -> no overlay; a stale one would keep showing a mask that is gone
    const p = join(dir, 'overlays', tile);
    if (existsSync(p)) { try { unlinkSync(p); } catch { /* best effort */ } }
    return true;
  }
  const shapes = polys.map((p) => {
    const pts = p.pts.map(([x, y]) => `${(x * width).toFixed(1)},${(y * height).toFixed(1)}`).join(' ');
    return `<polygon points="${pts}" fill="#00ff00" fill-opacity="0.25" stroke="#00ff00" stroke-width="3"/>`;
  }).join('');
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`);
  mkdirSync(join(dir, 'overlays'), { recursive: true });
  const tmp = join(dir, 'overlays', tile + '.tmp.png');
  await sharp(src).composite([{ input: svg }]).png().toFile(tmp);
  renameSync(tmp, join(dir, 'overlays', tile));
  return true;
}

export function createDatasetRouter() {
  const router = Router();

  router.get('/sets', (req, res) => {
    if (!existsSync(ROOT)) return res.json({ sets: [] });
    const sets = [];
    for (const name of readdirSync(ROOT)) {
      const dir = setDir(name);
      if (!dir || !existsSync(manPath(dir))) continue;
      try {
        const man = loadMan(dir);
        const tiles = man.tiles || [];
        sets.push({
          name, tiles: tiles.length, sources: (man.items || []).length,
          polygons: tiles.reduce((n, t) => n + (t.polys?.length || 0), 0),
          status: tally(tiles), terms: man.terms || [],
          modified: Math.floor(statSync(manPath(dir)).mtimeMs / 1000),
        });
      } catch { /* a half-written manifest simply does not list */ }
    }
    sets.sort((a, b) => b.modified - a.modified);
    res.json({ sets });
  });

  router.get('/:name/tiles', (req, res) => {
    const dir = setDir(req.params.name);
    if (!dir || !existsSync(manPath(dir))) return res.status(404).json({ error: 'no such dataset' });
    const man = loadMan(dir);
    let tiles = man.tiles || [];
    const want = String(req.query.status || '').trim();
    if (want) {
      const set = new Set(want.split(',').filter(Boolean));
      tiles = tiles.filter((t) => set.has(t.status));
    }
    if (req.query.masked === 'true') tiles = tiles.filter((t) => (t.polys?.length || 0) > 0);
    const total = tiles.length;
    const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit ?? '120', 10) || 120));
    res.json({
      total, offset, limit, status: tally(man.tiles || []),
      tiles: tiles.slice(offset, offset + limit).map((t) => ({
        tile: t.tile, status: t.status, polys: t.polys?.length || 0,
        sam: t.polys?.[0]?.sam_score ?? null, src: t.src, y: t.y, rev: t.rev ?? 0,
      })),
    });
  });

  // Images are served from disk rather than base64'd through JSON — a review grid pulls
  // hundreds of 768x768 PNGs and inlining them would be absurd.
  router.get('/:name/image/:kind/:file', (req, res) => {
    const { kind, file } = req.params;
    const dir = setDir(req.params.name);
    if (!dir || !['tiles', 'overlays'].includes(kind)) return res.status(400).end();
    if (basename(file) !== file || !['.png', '.jpg', '.webp'].includes(extname(file).toLowerCase())) {
      return res.status(400).end();                       // no traversal, no arbitrary reads
    }
    let p = join(dir, kind, file);
    // Only tiles WITH a mask get an overlay written, so negatives and unlabelled tiles have
    // none — and the grid asked for the overlay unconditionally, producing a broken-image
    // icon for 203 of 277 tiles. Fall back to the raw tile: the caller wants to SEE the
    // image, and "no overlay" is a legitimate state, not an error.
    if (kind === 'overlays' && !existsSync(p)) p = join(dir, 'tiles', file);
    if (!existsSync(p)) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).end(); }
    res.setHeader('Content-Type', 'image/' + extname(file).slice(1).replace('jpg', 'jpeg'));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(p).pipe(res);
  });

  const VALID = new Set(['auto', 'approved', 'rejected', 'negative', 'unlabelled', 'manual']);
  router.post('/:name/status', (req, res) => {
    const dir = setDir(req.params.name);
    if (!dir || !existsSync(manPath(dir))) return res.status(404).json({ error: 'no such dataset' });
    const status = String(req.body?.status || '');
    if (!VALID.has(status)) return res.status(400).json({ error: 'bad status' });
    const names = new Set(req.body?.tiles || []);
    if (!names.size) return res.status(400).json({ error: 'no tiles given' });
    const man = loadMan(dir);
    let n = 0;
    for (const t of man.tiles || []) {
      if (!names.has(t.tile)) continue;
      // A tile with no polygons is a negative by construction; approving it would claim a
      // mask that does not exist, and rejecting it would throw away a valid background.
      if (!(t.polys?.length) && status !== 'negative') continue;
      t.status = status; n++;
    }
    saveMan(dir, man);
    res.json({ ok: true, updated: n, status: tally(man.tiles || []) });
  });

  // ── click-to-annotate ──────────────────────────────────────────────────
  // SAM lives on ai-epyc because it needs the GPU; this proxies to it. The point of the
  // whole feature: a tile the DETECTOR missed has no seed, and calling it "negative" would
  // teach the new model that the target is background. A human click fixes exactly that.
  const SAMD = process.env.FORGE_SAMD || 'http://10.0.0.234:8791';
  // Seed detector for new images. Held here rather than in the UI so a dataset is
  // always seeded by the same model, whoever adds to it.
  const DEFAULT_DETECTOR = process.env.FORGE_DETECTOR ||
    '/imagegen/ultralytics/segm/Panty-detailer-3b-(segm)-(y8)-(segment).pt';

  router.post('/:name/segment', async (req, res) => {
    const dir = setDir(req.params.name);
    if (!dir || !existsSync(manPath(dir))) return res.status(404).json({ error: 'no such dataset' });
    try {
      const r = await fetch(SAMD + '/segment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req.body, dataset: req.params.name }),
        signal: AbortSignal.timeout(60000),
      });
      res.status(r.status).json(await r.json());
    } catch (e) {
      // Say WHERE it failed — "fetch failed" alone sends people looking in the browser.
      res.status(502).json({ error: 'SAM service unreachable at ' + SAMD + ' (' + e.message +
        '). On ai-epyc: systemctl status forge-samd' });
    }
  });

  /** Replace a tile's polygons with human-authored ones and mark it reviewed. */
  router.post('/:name/polys', (req, res) => {
    const dir = setDir(req.params.name);
    if (!dir || !existsSync(manPath(dir))) return res.status(404).json({ error: 'no such dataset' });
    const tile = String(req.body?.tile || '');
    const polys = req.body?.polys;
    if (!tile || !Array.isArray(polys)) return res.status(400).json({ error: 'tile and polys required' });
    for (const p of polys) {
      if (!Array.isArray(p?.pts) || p.pts.length < 3) return res.status(400).json({ error: 'a polygon needs >= 3 points' });
      for (const [x, y] of p.pts) {
        if (!(x >= -0.01 && x <= 1.01 && y >= -0.01 && y <= 1.01)) {
          return res.status(400).json({ error: 'points must be normalised 0..1' });
        }
      }
    }
    const man = loadMan(dir);
    const t = (man.tiles || []).find((x) => x.tile === tile);
    if (!t) return res.status(404).json({ error: 'no such tile' });
    t.polys = polys.map((p) => ({ pts: p.pts, sam_score: p.score ?? null, manual: true }));
    // "manual" so a later `annotate --append` will not overwrite hand-drawn work
    t.status = polys.length ? 'manual' : 'negative';
    // rev busts the browser cache — the overlay is served with max-age=3600, so without a
    // changing URL the corrected mask would stay invisible even once redrawn
    t.rev = Date.now();
    saveMan(dir, man);
    redrawOverlay(dir, tile, t.polys).catch(() => {});
    res.json({ ok: true, tile, polys: t.polys.length, status: t.status, rev: t.rev,
               statusCounts: tally(man.tiles || []) });
  });

  // ── ingest from the Training Images browser ────────────────────────────
  // Paths arrive RELATIVE to the imagegen root (what the browser already deals in), so the
  // same request is valid on either host: /ai-assets/imagegen here, /imagegen on ai-epyc.
  router.post('/:name/ingest', async (req, res) => {
    const name = req.params.name;
    if (!NAME_OK.test(name)) return res.status(400).json({ error: 'bad dataset name' });
    const paths = (req.body?.paths || []).filter((p) => typeof p === 'string' && !p.includes('..'));
    if (!paths.length) return res.status(400).json({ error: 'no paths' });
    try {
      const r = await fetch(SAMD + '/ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset: name, paths,
          detector: req.body?.detector || DEFAULT_DETECTOR,
          unseeded: req.body?.unseeded || 'unlabelled',
        }),
        signal: AbortSignal.timeout(30000),
      });
      res.status(r.status).json(await r.json());
    } catch (e) {
      res.status(502).json({ error: 'forge service unreachable at ' + SAMD + ' (' + e.message +
        '). On ai-epyc: systemctl status forge-samd' });
    }
  });

  router.get('/job/:id', async (req, res) => {
    try {
      const r = await fetch(SAMD + '/job/' + encodeURIComponent(req.params.id), { signal: AbortSignal.timeout(15000) });
      res.status(r.status).json(await r.json());
    } catch (e) { res.status(502).json({ error: String(e.message) }); }
  });

  /**
   * Remove tiles from a dataset — for source images that are warped or otherwise unfit to
   * train on. Deletes the tile and overlay files as well as the manifest records, and drops
   * a source from `items` once none of its tiles remain, so a later `annotate --append`
   * does not silently re-add it.
   */
  router.post('/:name/remove', (req, res) => {
    const dir = setDir(req.params.name);
    if (!dir || !existsSync(manPath(dir))) return res.status(404).json({ error: 'no such dataset' });
    const names = new Set((req.body?.tiles || []).filter((t) => typeof t === 'string' && basename(t) === t));
    if (!names.size) return res.status(400).json({ error: 'no tiles given' });
    const man = loadMan(dir);
    const all = man.tiles || [];

    // bySource: one bad render produces 4 bad tiles; removing them one at a time is busywork
    let doomed = all.filter((t) => names.has(t.tile));
    if (req.body?.bySource) {
      const srcs = new Set(doomed.map((t) => t.src));
      doomed = all.filter((t) => srcs.has(t.src));
    }
    const doomedNames = new Set(doomed.map((t) => t.tile));
    man.tiles = all.filter((t) => !doomedNames.has(t.tile));

    for (const t of doomed) {
      for (const sub of ['tiles', 'overlays']) {
        const f = join(dir, sub, t.tile);
        if (existsSync(f)) { try { unlinkSync(f); } catch { /* best effort; the record is gone regardless */ } }
      }
    }
    // Drop ONLY the sources whose tiles we just removed, and only once none remain.
    // Filtering `items` by "has any tile" instead purged 32 sources that were merely
    // PENDING — added to the dataset but not yet annotated — silently discarding queued
    // work that had nothing to do with the removal.
    const doomedSrcs = new Set(doomed.map((t) => t.src));
    const remaining = new Set(man.tiles.map((t) => t.src));
    const before = (man.items || []).length;
    man.items = (man.items || []).filter((i) => !(doomedSrcs.has(i.path) && !remaining.has(i.path)));
    saveMan(dir, man);
    res.json({ ok: true, removedTiles: doomed.length,
               removedSources: before - man.items.length,
               statusCounts: tally(man.tiles) });
  });

  return router;
}
