/**
 * system.js — System API Routes
 *
 * Provides endpoints for system-level operations like reading persistent
 * log files from active and past AI services running in LXC containers.
 *
 * Log files are written by tmux pipe-pane to /var/log/proxlab/{session}.log
 * inside the container. For services launched before pipe-pane was added,
 * falls back to tmux capture-pane.
 *
 * @module routes/system
 */

import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const dataDir = process.env.AILAB_PROXY_DATA_DIR || (process.cwd() + '/data');
const activeServicesFile = join(dataDir, 'active-services.json');
const serviceHistoryFile = join(dataDir, 'service-history.json');

function loadActiveServices() {
  try {
    if (existsSync(activeServicesFile)) return JSON.parse(readFileSync(activeServicesFile, 'utf-8'));
  } catch {}
  return { services: {} };
}

function loadServiceHistory() {
  try {
    if (existsSync(serviceHistoryFile)) return JSON.parse(readFileSync(serviceHistoryFile, 'utf-8'));
  } catch {}
  return { services: [] };
}

/**
 * Create the system router.
 * @param {import('../services/ssh.js').SSHService} sshService
 * @returns {Router}
 */
export function createSystemRouter(sshService) {
  const router = Router();

  /**
   * GET /logs/services
   * Returns list of active and past services with log-relevant metadata.
   * Active services are listed first, then archived (most recent first).
   */
  router.get('/logs/services', (req, res) => {
    const { services: active } = loadActiveServices();
    const { services: history } = loadServiceHistory();

    const mapSvc = (svc, status) => ({
      id: svc.id,
      providerId: svc.providerId,
      providerName: svc.providerName,
      model: svc.model || null,
      aliasOverride: svc.aliasOverride || null,
      node: svc.node,
      tmuxSession: svc.tmuxSession,
      vmid: svc.vmid,
      pveHostIp: svc.pveHostIp,
      startedAt: svc.startedAt,
      stoppedAt: svc.stoppedAt || null,
      port: svc.port,
      logFile: svc.logFile || `/var/log/proxlab/${svc.tmuxSession}.log`,
      status,
      exitReason: svc.exitReason || null,
    });

    const list = [
      ...Object.values(active).map(s => mapSvc(s, 'running')),
      ...history.map(s => mapSvc(s, 'stopped')),
    ];

    res.json(list);
  });

  /**
   * GET /logs/:serviceId
   * Reads the persistent log file for a service. Falls back to tmux
   * capture-pane for active services without a log file (pre-pipe-pane).
   * Query params: lines (default 1000, max 5000)
   */
  router.get('/logs/:serviceId', async (req, res) => {
    const { services: active } = loadActiveServices();
    const { services: history } = loadServiceHistory();

    // Look up in active first, then history
    const svc = active[req.params.serviceId]
      || history.find(s => s.id === req.params.serviceId);

    if (!svc) {
      return res.json({ alive: false, output: '', error: 'Service not found' });
    }

    const isActive = !!active[req.params.serviceId];
    const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 1000, 1), 5000);
    const { pveHostIp, vmid, tmuxSession } = svc;
    const logFile = svc.logFile || `/var/log/proxlab/${tmuxSession}.log`;

    try {
      // Try the persistent log file first
      const tailCmd = `pct exec ${vmid} -- tail -n ${lines} "${logFile}" 2>/dev/null`;
      const result = await sshService.exec(pveHostIp, tailCmd, { timeout: 15000 });

      if (result.code === 0 && result.stdout.length > 0) {
        return res.json({
          alive: isActive,
          output: result.stdout,
          source: 'logfile',
          capturedAt: new Date().toISOString(),
        });
      }

      // Fallback: tmux capture-pane (only works for active services with a live session)
      if (isActive) {
        const captureCmd = `pct exec ${vmid} -- tmux capture-pane -t "${tmuxSession}" -e -p -S -${lines}`;
        const captureResult = await sshService.exec(pveHostIp, captureCmd, { timeout: 15000 });

        if (captureResult.code === 0) {
          return res.json({
            alive: true,
            output: captureResult.stdout,
            source: 'tmux',
            capturedAt: new Date().toISOString(),
          });
        }
      }

      // No log file and no tmux session
      res.json({
        alive: false,
        output: '',
        source: 'none',
        error: isActive ? 'Log file not found and tmux session unavailable' : 'Log file no longer available',
        capturedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.json({
        alive: false,
        output: '',
        source: 'none',
        error: err.message,
        capturedAt: new Date().toISOString(),
      });
    }
  });

  /**
   * POST /logs/sweep-orphans
   * STATE-CHANGING (with ?apply=true): deletes /var/log/proxlab log files, in
   * the agent containers, that no active-services or service-history entry
   * references — the 100-entry history cap silently drops old services while
   * their log files stay on disk forever.
   *
   * Default is a DRY RUN: reports what would be deleted, removes nothing.
   * Query params:
   *   apply=true    — actually delete (every removal is logged server-side)
   *   minAgeDays=N  — skip files modified in the last N days (default 7)
   *
   * A referenced service keeps its whole rotation family (name.log, .log.1,
   * .log.2.gz, …); an orphan's family is removed together.
   */
  router.post('/logs/sweep-orphans', async (req, res) => {
    const apply = String(req.query.apply) === 'true';
    const minAgeDays = Math.max(parseInt(req.query.minAgeDays, 10) || 7, 0);
    const cutoff = Date.now() / 1000 - minAgeDays * 86400;

    const { services: active } = loadActiveServices();
    const { services: history } = loadServiceHistory();
    const all = [...Object.values(active), ...history];

    // A log's "stem" is the filename minus rotation suffixes: name.log,
    // name.log.1, name.log.2.gz all belong to stem "name".
    const stemOf = (name) => name.replace(/\.log(\.\d+(\.gz)?)?$/, '');
    const referenced = new Set();
    for (const svc of all) {
      const base = (svc.logFile || `/var/log/proxlab/${svc.tmuxSession}.log`).split('/').pop();
      referenced.add(stemOf(base));
    }

    // Sweep every container any known service ran in.
    const targets = new Map();
    for (const svc of all) {
      if (svc.pveHostIp && svc.vmid) targets.set(`${svc.pveHostIp}:${svc.vmid}`, svc);
    }

    const containers = [];
    for (const svc of targets.values()) {
      const { pveHostIp, vmid } = svc;
      const entry = { pveHostIp, vmid, orphans: [], skipped: [], freedBytes: 0, deleted: false };
      containers.push(entry);
      try {
        const listCmd = `pct exec ${vmid} -- sh -c 'cd /var/log/proxlab 2>/dev/null || exit 0; stat -c "%n|%s|%Y" -- * 2>/dev/null'`;
        const result = await sshService.exec(pveHostIp, listCmd, { timeout: 20000 });
        if (result.code !== 0) {
          entry.error = `list failed: ${result.stderr || `exit ${result.code}`}`;
          continue;
        }
        for (const line of result.stdout.split('\n')) {
          const [name, sizeStr, mtimeStr] = line.trim().split('|');
          if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || !/\.log(\.\d+(\.gz)?)?$/.test(name)) continue;
          if (referenced.has(stemOf(name))) continue;
          const orphan = { file: name, bytes: parseInt(sizeStr, 10) || 0 };
          if ((parseInt(mtimeStr, 10) || 0) > cutoff) {
            entry.skipped.push({ ...orphan, reason: `modified <${minAgeDays}d ago` });
            continue;
          }
          entry.orphans.push(orphan);
          entry.freedBytes += orphan.bytes;
        }

        if (apply && entry.orphans.length) {
          const files = entry.orphans.map((o) => `"/var/log/proxlab/${o.file}"`).join(' ');
          const rmCmd = `pct exec ${vmid} -- sh -c 'rm -f -- ${files}'`;
          const rm = await sshService.exec(pveHostIp, rmCmd, { timeout: 20000 });
          if (rm.code === 0) {
            entry.deleted = true;
            for (const o of entry.orphans) {
              console.log(`[logs/sweep-orphans] deleted ${pveHostIp} CT${vmid} /var/log/proxlab/${o.file} (${o.bytes} bytes)`);
            }
          } else {
            entry.error = `delete failed: ${rm.stderr || `exit ${rm.code}`}`;
          }
        }
      } catch (err) {
        entry.error = err.message;
      }
    }

    const totalOrphans = containers.reduce((n, c) => n + c.orphans.length, 0);
    const totalBytes = containers.reduce((n, c) => n + c.freedBytes, 0);
    res.json({
      dryRun: !apply,
      minAgeDays,
      referencedStems: referenced.size,
      totalOrphans,
      totalBytes,
      containers,
    });
  });

  return router;
}
