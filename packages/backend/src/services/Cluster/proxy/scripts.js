/**
 * scripts.js — Native Script Execution API routes (ported from ProxLab)
 *
 * Replaces the ProxLab-bridged /api/scripts endpoints with a native AI-Lab
 * router. Ported 1:1 from ProxLab's /root/dv-lab/src/routes/scripts.js
 * (createScriptsRouter(config, sshService)). Lists shell scripts from a local
 * scripts directory, serves their content with parsed header metadata, and
 * runs a script inside a target LXC guest.
 *
 * Request/response shapes are preserved EXACTLY so the AI-Lab ScriptsStore
 * (packages/ui/src/renderer_v2/stores/ScriptsStore.ts) consumes them unchanged:
 *   - GET  /          -> ScriptDef[]   ({ name, size, modified, ...meta })
 *   - GET  /:name     -> { name, content, ...meta }
 *   - POST /:name/run -> { script, target, host, code, stdout, stderr }
 *
 * ── ProxLab → AI-Lab adaptations ──────────────────────────────────────────
 *   - Scripts directory: ProxLab read its own /root/dv-lab/scripts dir relative
 *     to the module. Here it defaults to <dataDir>/scripts (override with
 *     AILAB_SCRIPTS_DIR). Missing dir degrades to [] exactly like the original.
 *   - Target resolution: ProxLab looked the target up in config.containers (a
 *     map of id -> { id, host }) and SSH'd directly into the container's own IP.
 *     AI-Lab has no such map; the ScriptsStore sends `target` = a guest vmid
 *     (string). We resolve the vmid -> PVE node IP via the injected PveApi and
 *     run the script INSIDE the container via `pct exec` over the node host
 *     (same transport system.js uses). `host` in the response = the node IP.
 *
 * Dependency injection (constructed by UniversalProxyService):
 *   - sshExec : (host, cmd, { timeout? }) => Promise<{ code, stdout, stderr }>
 *   - pveApi  : PveApi instance (llmPve) — for vmid -> node-IP resolution
 *   - dataDir : absolute path to the proxy data dir (holds the scripts/ dir)
 *
 * @module proxy/scripts
 */

import { Router } from 'express';
import { readdir, readFile, stat } from 'fs/promises';
import { join, resolve as pathResolve, dirname } from 'path';
import os from 'os';

/**
 * Create the scripts router with list, get, and run endpoints.
 *
 * @param {object}   deps
 * @param {function} deps.sshExec  (host, cmd, opts) => Promise<{ code, stdout, stderr }>
 * @param {object}   deps.pveApi   PveApi instance (vmid -> node resolution)
 * @param {string}   deps.dataDir  absolute path to the proxy data dir
 * @returns {Router}
 */
export function createScriptsRouter({ sshExec, pveApi, dataDir }) {
  const router = Router();

  // Local scripts directory. Defaults to <dataDir>/scripts; overridable.
  const SCRIPTS_DIR = process.env.AILAB_SCRIPTS_DIR || join(dataDir, 'scripts');

  // ─── List available scripts ─────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const files = await readdir(SCRIPTS_DIR);
      const scripts = [];

      for (const file of files) {
        if (file.startsWith('.') || file === 'README.md') continue;
        const filePath = join(SCRIPTS_DIR, file);
        const info = await stat(filePath);
        if (!info.isFile()) continue;

        // Try to read metadata from script header comments
        const content = await readFile(filePath, 'utf-8');
        const meta = parseScriptMeta(content);

        scripts.push({
          name: file,
          size: info.size,
          modified: info.mtime,
          ...meta,
        });
      }

      res.json(scripts);
    } catch (err) {
      // Missing dir / unreadable -> empty list (matches ProxLab behaviour)
      res.json([]);
    }
  });

  // ─── Browse the AI-Lab container's local filesystem (folder picker) ──────────
  // The backend runs INSIDE the AI-Lab LXC where the NAS pools are mounted, so it
  // lists directories directly. Returns subfolders under `path` (default /nas),
  // a count of ebooks in the current folder, and the AI-Lab's own guest vmid so
  // the UI can auto-select it as the run target. MUST be registered before /:name.
  router.get('/browse', async (req, res) => {
    const EBOOK_RE = /\.(epub|mobi|azw3?|azw4|prc|kf8)$/i;
    let dir = (typeof req.query.path === 'string' && req.query.path) ? req.query.path : '/nas';
    try {
      dir = pathResolve(dir);
      const ents = await readdir(dir, { withFileTypes: true });
      const dirs = ents
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const ebookCount = ents.filter((e) => e.isFile() && EBOOK_RE.test(e.name)).length;
      res.json({ path: dir, parent: dir === '/' ? null : dirname(dir), dirs, ebookCount, localVmid: resolveOwnVmid(pveApi) });
    } catch (err) {
      const msg = err.code === 'ENOENT' ? 'Folder not found'
        : err.code === 'EACCES' ? 'Permission denied' : err.message;
      res.status(400).json({ error: msg, path: dir });
    }
  });

  // ─── Get script content ───────────────────────────────────────────────────
  router.get('/:name', async (req, res) => {
    try {
      const filePath = join(SCRIPTS_DIR, req.params.name);
      const content = await readFile(filePath, 'utf-8');
      const meta = parseScriptMeta(content);
      res.json({ name: req.params.name, content, ...meta });
    } catch (err) {
      res.status(404).json({ error: 'Script not found' });
    }
  });

  // ─── Execute a script inside a target guest ─────────────────────────────────
  // NOTE: real-world destructive — actually runs the script inside the LXC. The
  // ScriptsStore posts { target: <vmid>, args }. Response shape preserved:
  // { script, target, host, code, stdout, stderr }.
  router.post('/:name/run', async (req, res) => {
    const { target, args } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target container id is required' });

    // Resolve the vmid -> PVE node IP (AI-Lab runs the script via `pct exec`
    // on the owning node rather than SSHing straight into the container).
    const vmid = parseInt(target, 10);
    if (!pveApi || !pveApi.configured) {
      return res.status(503).json({ error: 'PVE API not configured' });
    }
    const guest = (pveApi.getGuests() || []).find(g => g.vmid === vmid);
    if (!guest) return res.status(404).json({ error: `Container '${target}' not found` });
    if (guest.type && guest.type !== 'lxc') {
      return res.status(400).json({ error: 'Script run is only supported for LXC containers' });
    }

    const nodeMap = pveApi.getNodeMap ? pveApi.getNodeMap() : {};
    const nodeIp = nodeMap[guest.node]?.ip || pveApi.host;
    if (!nodeIp) return res.status(400).json({ error: `Cannot resolve IP for node ${guest.node}` });

    try {
      const filePath = join(SCRIPTS_DIR, req.params.name);
      const content = await readFile(filePath, 'utf-8');

      // Pipe the script over stdin into the container's bash via the node host.
      // base64 keeps the payload shell-safe; `bash -s -- <args>` forwards args
      // as positional params ($1, $2, …) exactly like the original `'<path>' <args>`.
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      const runCmd = `echo ${b64} | base64 -d | pct exec ${vmid} -- bash -s -- ${args || ''}`;
      const result = await sshExec(nodeIp, runCmd, { timeout: 300000 });

      res.json({
        script: req.params.name,
        target: vmid,
        host: nodeIp,
        ...result,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Resolve the AI-Lab's own guest vmid by matching this host's non-internal IPv4
 * addresses against the PVE guest list. Lets the folder picker auto-select the
 * container whose filesystem it is browsing as the run target. null if unknown.
 */
function resolveOwnVmid(pveApi) {
  try {
    const own = new Set(
      Object.values(os.networkInterfaces()).flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal)
        .map((i) => i.address)
    );
    const g = (pveApi?.getGuests?.() || []).find((gg) =>
      [gg.ip, ...(gg.ips || [])].filter(Boolean)
        .some((ip) => own.has(String(ip).split('/')[0])));
    return g ? g.vmid : null;
  } catch {
    return null;
  }
}

/**
 * Parse script metadata from header comments.
 * Supports: # @description, # @target, # @args (repeatable)
 */
function parseScriptMeta(content) {
  const meta = {};
  const lines = content.split('\n').slice(0, 30);
  for (const line of lines) {
    const match = line.match(/^#\s*@(\w+)\s+(.+)/);
    if (match) {
      const [, key, value] = match;
      if (key === 'args') {
        meta.args = meta.args || [];
        meta.args.push(value.trim());
      } else {
        meta[key] = value.trim();
      }
    }
  }
  return meta;
}
