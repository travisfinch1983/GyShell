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

  return router;
}
