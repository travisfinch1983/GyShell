import { Router } from 'express';
import { readdirSync, statSync, existsSync, renameSync, readFileSync } from 'fs';
import { join, dirname, basename, extname, resolve, sep } from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * Bulk Renamer backend — /api/files
 *
 * FileBrowser Quantum (the "File Browser" sub-tab) is a binary we cannot extend, so mass
 * renaming lives here instead: a tree, a rule stack, a live preview, and an apply step.
 *
 * THE LOAD-BEARING DESIGN RULE: /plan and /apply both call planRenames(). /apply does NOT
 * accept a client-supplied mapping — it recomputes the plan server-side from the same rules
 * and refuses if anything is unsafe. A preview that can drift from what executes is the bug
 * this shape exists to prevent (the CivitAI namer learned the same lesson the hard way).
 */

const META_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'file-meta.py');

// Roots come from the file-manager config the rest of the app already uses, plus the NAS
// mount FileBrowser serves. Anything outside them is rejected — this is the containment
// boundary for an endpoint whose whole job is to rename files.
function allowedRoots(dataDir) {
  const roots = new Set();
  try {
    const fm = JSON.parse(readFileSync(join(dataDir, 'file-manager.json'), 'utf8'));
    for (const t of Object.values(fm.tabs || {})) {
      if (t?.basePath && t.basePath.startsWith('/')) roots.add(resolve(t.basePath));
    }
  } catch { /* config absent — fall through to the defaults below */ }
  for (const d of ['/ai-assets', '/nas']) if (existsSync(d)) roots.add(d);
  return [...roots];
}

/** Resolve `p` and prove it sits inside an allowed root. Returns null if it does not. */
function safePath(p, roots) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const abs = resolve(p);
  const ok = roots.some((r) => abs === r || abs.startsWith(r + sep));
  return ok ? abs : null;
}

const BAD_NAME = /[/\\\0]/;
/** A filename must be a filename — not a path, not a traversal, not blank-ish. */
function nameError(n) {
  if (!n || !n.trim()) return 'empty name';
  if (BAD_NAME.test(n)) return 'contains a path separator';
  if (n === '.' || n === '..') return 'reserved name';
  if (n !== n.trim()) return 'leading/trailing whitespace';
  if (n.endsWith('.')) return 'trailing dot';
  if (Buffer.byteLength(n) > 255) return 'longer than 255 bytes';
  return null;
}

// ─── rule engine ────────────────────────────────────────────────────────────
const TITLE = (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

function tokens(ctx) {
  const m = ctx.meta || {};
  return {
    name: ctx.stem, ext: ctx.ext.replace(/^\./, ''), parent: basename(dirname(ctx.abs)),
    task: m.task || '', head: m.head || '', arch: m.arch || m.stArch || '',
    proto: m.proto ? 'proto' : '', nc: m.nc != null ? String(m.nc) : '',
    imgsz: m.imgsz || '', kind: m.kind || '', top_tag: m.top_tag || '',
    i: String(ctx.i + 1), n: String(ctx.total),
    size: m.size != null ? String(m.size) : '',
  };
}

/** Expand {token} refs. Unknown tokens are left verbatim so a typo is visible, not silent. */
function expand(tpl, ctx) {
  const t = tokens(ctx);
  return String(tpl).replace(/\{(\w+)(?::(\d+))?\}/g, (full, key, pad) => {
    if (!(key in t)) return full;
    let v = t[key];
    if (pad) v = v.padStart(Number(pad), '0');
    return v;
  });
}

/**
 * Apply the rule stack to one file. Operates on stem + ext separately so a suffix never
 * lands after the extension and a case rule never lowercases ".PT" into a different file
 * type by accident.
 */
function applyRules(ctx, rules) {
  let stem = ctx.stem;
  let ext = ctx.ext;
  for (const r of rules || []) {
    if (!r || r.enabled === false) continue;
    const c = { ...ctx, stem, ext };
    switch (r.type) {
      case 'replace': {
        if (!r.find) break;
        const to = expand(r.to ?? '', c);
        if (r.regex) {
          let re;
          try { re = new RegExp(r.find, (r.all === false ? '' : 'g') + (r.ci ? 'i' : '')); }
          catch (e) { return { error: 'bad regex: ' + e.message }; }
          stem = stem.replace(re, to);
        } else if (r.all === false) {
          const i = r.ci ? stem.toLowerCase().indexOf(r.find.toLowerCase()) : stem.indexOf(r.find);
          if (i >= 0) stem = stem.slice(0, i) + to + stem.slice(i + r.find.length);
        } else {
          stem = stem.split(r.find).join(to);
        }
        break;
      }
      case 'prefix': stem = expand(r.text ?? '', c) + stem; break;
      case 'suffix': stem = stem + expand(r.text ?? '', c); break;
      case 'template': stem = expand(r.pattern ?? '{name}', c); break;
      case 'case':
        stem = r.mode === 'upper' ? stem.toUpperCase()
             : r.mode === 'lower' ? stem.toLowerCase()
             : r.mode === 'title' ? TITLE(stem)
             : r.mode === 'snake' ? stem.replace(/\s+/g, '_').toLowerCase()
             : r.mode === 'kebab' ? stem.replace(/\s+/g, '-').toLowerCase()
             : stem;
        break;
      case 'spaces': stem = stem.replace(/\s+/g, r.to ?? '_'); break;
      case 'strip': {
        if (r.chars) stem = stem.split('').filter((ch) => !r.chars.includes(ch)).join('');
        if (r.collapse !== false) stem = stem.replace(/([_\-.])\1+/g, '$1');
        break;
      }
      case 'number': {
        const num = String(ctx.i + 1).padStart(Number(r.pad ?? 2), '0');
        const s = r.sep ?? '_';
        stem = r.position === 'prefix' ? num + s + stem : stem + s + num;
        break;
      }
      case 'extension': if (r.to) ext = '.' + String(r.to).replace(/^\./, ''); break;
      default: return { error: 'unknown rule type: ' + r.type };
    }
  }
  return { name: stem + ext };
}

/**
 * Build the full rename plan. Pure: reads the filesystem for collision checks but mutates
 * nothing. Both /plan and /apply go through here.
 */
function planRenames(files, rules, opts = {}) {
  const rows = [];
  const claimed = new Map(); // lowercased target -> first row that claimed it

  files.forEach((f, i) => {
    const ext = extname(f.abs);
    const ctx = { abs: f.abs, stem: basename(f.abs, ext), ext, meta: f.meta, i, total: files.length };
    const out = applyRules(ctx, rules);
    const row = { from: f.abs, dir: dirname(f.abs), oldName: basename(f.abs) };

    if (out.error) { row.error = out.error; rows.push(row); return; }
    row.newName = out.name;
    row.changed = row.newName !== row.oldName;

    const ne = nameError(row.newName);
    if (ne) { row.error = ne; rows.push(row); return; }

    row.to = join(row.dir, row.newName);

    // collision with an unrelated file already on disk
    if (row.changed && existsSync(row.to)) {
      row.error = 'target already exists';
    }
    // collision with another row in this same batch
    const key = row.to.toLowerCase();
    if (!row.error && row.changed) {
      if (claimed.has(key)) row.error = 'two files would get the same name (' + claimed.get(key) + ')';
      else claimed.set(key, row.oldName);
    }

    // sidecars: same stem, any extension — previews, .json, .civit.info, .metadata.json
    if (opts.includeSidecars && row.changed && !row.error) {
      const oldStem = basename(f.abs, ext);
      try {
        row.sidecars = readdirSync(row.dir)
          .filter((n) => n !== row.oldName && (n === oldStem || n.startsWith(oldStem + '.') || n.startsWith(oldStem + '_')))
          .map((n) => ({ from: join(row.dir, n), to: join(row.dir, basename(row.newName, extname(row.newName)) + n.slice(oldStem.length)) }));
      } catch { row.sidecars = []; }
    }
    rows.push(row);
  });
  return rows;
}

function readMeta(paths) {
  return new Promise((res) => {
    if (!paths.length) return res({});
    execFile('python3', [META_SCRIPT, ...paths], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
      (err, stdout) => {
        if (err && !stdout) return res({});
        try { res(JSON.parse(stdout)); } catch { res({}); }
      });
  });
}

export function createFilesRouter({ dataDir } = {}) {
  const router = Router();
  const roots = () => allowedRoots(dataDir || process.cwd() + '/data');

  router.get('/roots', (req, res) => res.json({ roots: roots() }));

  router.get('/list', (req, res) => {
    const rs = roots();
    const abs = safePath(String(req.query.path || rs[0] || '/'), rs);
    if (!abs) return res.status(400).json({ error: 'path outside the allowed roots' });
    let ents;
    try { ents = readdirSync(abs, { withFileTypes: true }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const dirs = [], files = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = join(abs, e.name);
      let st; try { st = statSync(p); } catch { continue; }
      if (e.isDirectory()) dirs.push({ name: e.name, path: p });
      else files.push({ name: e.name, path: p, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), ext: extname(e.name).toLowerCase() });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: abs, parent: abs === '/' ? null : dirname(abs), dirs, files });
  });

  router.post('/metadata', async (req, res) => {
    const rs = roots();
    const paths = (req.body?.paths || []).map((p) => safePath(p, rs)).filter(Boolean);
    res.json({ meta: await readMeta(paths.slice(0, 500)) });
  });

  router.post('/plan', async (req, res) => {
    const rs = roots();
    const paths = (req.body?.paths || []).map((p) => safePath(p, rs)).filter(Boolean);
    if (!paths.length) return res.json({ rows: [] });
    const meta = req.body?.withMeta === false ? {} : await readMeta(paths.slice(0, 500));
    const files = paths.map((p) => ({ abs: p, meta: meta[p] || {} }));
    res.json({ rows: planRenames(files, req.body?.rules || [], { includeSidecars: !!req.body?.includeSidecars }) });
  });

  router.post('/apply', async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm:true required' });
    const rs = roots();
    const paths = (req.body?.paths || []).map((p) => safePath(p, rs)).filter(Boolean);
    if (!paths.length) return res.status(400).json({ error: 'no valid paths' });

    // Recompute server-side. The client cannot hand us a mapping to execute.
    const meta = await readMeta(paths.slice(0, 500));
    const files = paths.map((p) => ({ abs: p, meta: meta[p] || {} }));
    const rows = planRenames(files, req.body?.rules || [], { includeSidecars: !!req.body?.includeSidecars });

    const bad = rows.filter((r) => r.error);
    if (bad.length && !req.body?.skipErrors) {
      return res.status(409).json({ error: 'plan has ' + bad.length + ' unsafe row(s); nothing was renamed', rows });
    }

    const done = [], failed = [];
    for (const r of rows) {
      if (r.error || !r.changed) continue;
      try {
        renameSync(r.from, r.to);
        done.push({ from: r.from, to: r.to });
        for (const sc of r.sidecars || []) {
          try { renameSync(sc.from, sc.to); done.push(sc); } catch (e) { failed.push({ from: sc.from, error: e.message }); }
        }
      } catch (e) {
        // EXDEV would mean a cross-dataset move; this endpoint only renames in place, so it
        // should be unreachable — surface it rather than silently copy+delete.
        failed.push({ from: r.from, to: r.to, error: e.code === 'EXDEV' ? 'cross-device rename refused' : e.message });
      }
    }
    res.json({ ok: failed.length === 0, renamed: done.length, skipped: bad.length, done, failed });
  });

  return router;
}
