import { Router } from 'express';
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync, renameSync, createReadStream } from 'fs';
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
        sam: t.polys?.[0]?.sam_score ?? null, src: t.src, y: t.y,
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
    const p = join(dir, kind, file);
    if (!existsSync(p)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/' + extname(file).slice(1).replace('jpg', 'jpeg'));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(p).pipe(res);
  });

  const VALID = new Set(['auto', 'approved', 'rejected', 'negative']);
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

  return router;
}
