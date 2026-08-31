/**
 * cluster.js — Native Cluster-management API routes (ported from ProxLab)
 *
 * Replaces the ProxLab-bridged Proxmox cluster/guest/GPU endpoints with a
 * native AI-Lab router. Ported 1:1 from ProxLab's inline routes in
 * /root/dv-lab/server.js (the `/api/guests`, `/api/pve`, `/api/gpu`,
 * `/api/storages` block). Request/response shapes are preserved EXACTLY so
 * the AI-Lab ClusterStore consumes them unchanged.
 *
 * Mounted at `app.use('/api', createClusterRouter({ ... }))`, so the route
 * paths below are declared at their real public paths (`/pve/status`,
 * `/guests`, `/gpu/assignments/:vmid`, …).
 *
 * Dependency injection (constructed by UniversalProxyService):
 *   - pveApi           : PveApi instance (llmPve)            — cluster/guest cache + PVE API client
 *   - gpuMonitor       : GpuMonitor instance (llmGpuMon)     — GPU metrics / inventory / config
 *   - hookscriptDeploy : HookscriptDeploy instance (llmHook) — GPU hookscript deploy/remove on PVE storage
 *   - sshExec          : (host, cmd, { timeout? }) => Promise<{ code, stdout, stderr }>
 *   - dataDir          : absolute path to the proxy data dir (holds gpu-assignments.json)
 *
 * @module proxy/cluster
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { checkAndAutoSync } from './llm/routes/ai.js';

/**
 * Create the cluster-management router.
 *
 * @param {object}   deps
 * @param {object}   deps.pveApi
 * @param {object}   deps.gpuMonitor
 * @param {object}   deps.hookscriptDeploy
 * @param {function} deps.sshExec  (host, cmd, opts) => Promise<{ code, stdout, stderr }>
 * @param {string}   deps.dataDir
 * @returns {Router}
 */
export function createClusterRouter({ pveApi, gpuMonitor, hookscriptDeploy, sshExec, dataDir }) {
  const router = Router();

  // gpu-assignments.json lives in the proxy data dir (same file ai.js reads/writes).
  const gpuAssignFile = join(dataDir, 'gpu-assignments.json');

  /** Load GPU assignments from disk (returns {} if file missing) */
  function loadGpuAssignments() {
    try {
      if (existsSync(gpuAssignFile)) {
        return JSON.parse(readFileSync(gpuAssignFile, 'utf-8'));
      }
    } catch {}
    return {};
  }

  /** Persist GPU assignments to disk */
  function saveGpuAssignments(data) {
    writeFileSync(gpuAssignFile, JSON.stringify(data, null, 2));
  }

  /**
   * Edit an LXC container's conf file directly over SSH.
   *
   * Ported from ProxLab's editLxcConf(). For each key in `changes`, removes
   * ALL existing lines for that key (handles duplicate entries) and appends
   * the new value (skipped when the value is null/undefined/empty → delete).
   * Falls back to the PVE API host when the node IP can't be resolved.
   * Also updates the in-memory config cache so subsequent reads reflect the
   * change before the next refresh cycle.
   */
  async function editLxcConf(vmid, changes, nodeHostOverride) {
    const nodeMap = pveApi.getNodeMap();
    const guest = pveApi.getGuests().find(g => g.vmid === vmid);
    const nodeName = guest?.node;
    const nodeIp = nodeHostOverride || nodeMap[nodeName]?.ip || pveApi.host;
    if (!nodeIp) throw new Error('Cannot determine PVE node IP for SSH');

    const confPath = `/etc/pve/lxc/${vmid}.conf`;
    const cmds = [];

    for (const [key, value] of Object.entries(changes)) {
      // Remove ALL existing lines for this key first (handles duplicate entries)
      cmds.push(`sed -i '/^${key}:/d' ${confPath}`);
      // Append the new value (skip if deleting — null/undefined/empty)
      if (value !== null && value !== undefined && value !== '') {
        cmds.push(`echo '${key}: ${value}' >> ${confPath}`);
      }
    }

    const result = await sshExec(nodeIp, cmds.join(' && '));
    if (result.code !== 0 && result.stderr) {
      throw new Error(`SSH conf edit failed: ${result.stderr.trim()}`);
    }

    // Immediately update the in-memory config cache so subsequent reads
    // reflect our changes before the next PVE API refresh cycle (120s)
    const cachedCfg = pveApi.getGuestConfigCached(vmid);
    if (cachedCfg) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === undefined || value === '') {
          delete cachedCfg[key];
        } else {
          cachedCfg[key] = value;
        }
      }
    }

    return result;
  }

  // ─── Guest API Endpoints ────────────────────────────────────────────────

  /** GET /guests — All guests with node/cluster metadata (cached, refreshed on timer) */
  router.get('/guests', (req, res) => {
    res.json({
      guests: pveApi.getGuests(),
      nodes: pveApi.cachedNodes,
      cluster: pveApi.cachedCluster,
      lastRefresh: pveApi.lastRefresh,
    });
  });

  /** GET /guests/:vmid/config — On-demand detailed config for a single guest */
  router.get('/guests/:vmid/config', async (req, res) => {
    try {
      const vmid = parseInt(req.params.vmid, 10);
      const guest = pveApi.getGuests().find(g => g.vmid === vmid);
      if (!guest) return res.status(404).json({ error: 'Guest not found' });

      const config = await pveApi.getGuestConfig(guest.node, guest.type, vmid);
      res.json({ guest, config });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /guests/:vmid/config — Update guest configuration fields.
   *
   * Allowed fields: onboot, features, console, tty, cmode, protection, startup.
   * LXC containers use direct SSH conf editing; QEMU VMs use the PVE API.
   */
  router.put('/guests/:vmid/config', async (req, res) => {
    try {
      const vmid = parseInt(req.params.vmid, 10);
      const guest = pveApi.getGuests().find(g => g.vmid === vmid);
      if (!guest) return res.status(404).json({ error: 'Guest not found' });

      // Whitelist of allowed config keys to prevent arbitrary writes
      const allowed = ['onboot', 'features', 'console', 'tty', 'cmode', 'protection', 'startup'];
      const params = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) params[key] = req.body[key];
      }

      if (Object.keys(params).length === 0) {
        return res.status(400).json({ error: 'No config changes specified' });
      }

      if (guest.type === 'lxc') {
        await editLxcConf(vmid, params);
      } else {
        await pveApi.request(`/nodes/${guest.node}/qemu/${vmid}/config`, {
          method: 'PUT',
          body: params,
        });
      }

      // Update the in-memory guest cache for immediate UI consistency
      if (params.onboot !== undefined) guest.onboot = parseInt(params.onboot, 10);
      if (params.features !== undefined) guest.features = params.features;
      if (params.console !== undefined) guest.console = parseInt(params.console, 10);
      if (params.tty !== undefined) guest.tty = parseInt(params.tty, 10);
      if (params.cmode !== undefined) guest.cmode = params.cmode;
      if (params.protection !== undefined) guest.protection = parseInt(params.protection, 10);
      if (params.startup !== undefined) guest.startup = params.startup;

      res.json({ ok: true, vmid, applied: params });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /guests/:vmid/features — Update LXC feature flags.
   *
   * Convenience endpoint that validates the features string format
   * (e.g. "nesting=1,fuse=1,mount=nfs;cifs") and writes via SSH.
   * LXC-only; returns 400 for QEMU VMs.
   */
  router.put('/guests/:vmid/features', async (req, res) => {
    try {
      const vmid = parseInt(req.params.vmid, 10);
      const guest = pveApi.getGuests().find(g => g.vmid === vmid);
      if (!guest) return res.status(404).json({ error: 'Guest not found' });
      if (guest.type !== 'lxc') return res.status(400).json({ error: 'Features only apply to LXC containers' });

      const featStr = req.body.features;
      if (featStr === undefined) return res.status(400).json({ error: 'Missing features string' });

      // Validate PVE features format: key=value pairs separated by commas
      if (featStr && !/^[a-z]+=[\w;]+(,[a-z]+=[\w;]+)*$/.test(featStr)) {
        return res.status(400).json({ error: 'Invalid features format' });
      }

      await editLxcConf(vmid, { features: featStr || null });
      guest.features = featStr;

      res.json({ ok: true, vmid, features: featStr });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /guests/:vmid/lxc-env — Set LXC environment variables.
   *
   * Environment variables are stored as raw lxc.environment entries in the
   * container config. This endpoint reads the current config, preserves
   * non-environment lxc entries, and replaces all environment entries with
   * the provided vars object.
   *
   * Uses the PVE API (not SSH) because lxc.* entries require special
   * array parameter encoding.
   */
  router.put('/guests/:vmid/lxc-env', async (req, res) => {
    try {
      const vmid = parseInt(req.params.vmid, 10);
      const guest = pveApi.getGuests().find(g => g.vmid === vmid);
      if (!guest) return res.status(404).json({ error: 'Guest not found' });
      if (guest.type !== 'lxc') return res.status(400).json({ error: 'Only LXC containers have environment variables' });

      const { vars } = req.body;
      if (!vars || typeof vars !== 'object') {
        return res.status(400).json({ error: 'vars object required' });
      }

      // Read current config to preserve non-environment lxc entries
      const cfg = await pveApi.getGuestConfig(guest.node, guest.type, vmid);
      const existingLxc = Array.isArray(cfg.lxc) ? cfg.lxc : [];

      const nonEnvEntries = existingLxc.filter(
        e => Array.isArray(e) && e[0] !== 'lxc.environment'
      );

      const newEnvEntries = Object.entries(vars)
        .filter(([k, v]) => k && v !== undefined && v !== null)
        .map(([k, v]) => ['lxc.environment', `${k}=${v}`]);

      const allEntries = [...nonEnvEntries, ...newEnvEntries];

      // PVE API expects lxc config as indexed params: lxc0=key=value&lxc1=...
      if (allEntries.length === 0) {
        await pveApi.request(`/nodes/${guest.node}/lxc/${vmid}/config`, {
          method: 'PUT',
          body: { delete: 'lxc' },
        });
      } else {
        const params = new URLSearchParams();
        allEntries.forEach((entry, i) => {
          params.append(`lxc${i}`, `${entry[0]}=${entry[1]}`);
        });
        await pveApi.request(`/nodes/${guest.node}/lxc/${vmid}/config`, {
          method: 'PUT',
          body: params.toString(),
        });
      }

      guest.lxcenv = vars;
      res.json({ ok: true, vmid, envCount: Object.keys(vars).length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /guests/:vmid/migrate — Migrate a container/VM to another node.
   * MUST be defined before the generic /:action route to avoid being caught by it.
   * Body: { target, targetStorage?, gpuReassign?, mode? }
   * gpuReassign: { sourcePciId: targetPciId | null } — remap GPU assignments post-migration
   * mode: 'online' | 'offline' | 'shutdown' (shutdown is handled by frontend)
   */
  router.post('/guests/:vmid/migrate', async (req, res) => {
    try {
      const vmid = parseInt(req.params.vmid, 10);
      const { target, targetStorage, gpuReassign, mode } = req.body;
      if (!target) return res.status(400).json({ error: 'target node is required' });

      const guest = pveApi.getGuests().find(g => g.vmid === vmid);
      if (!guest) return res.status(404).json({ error: 'Guest not found' });

      const doOnline = mode === 'online' && guest.status === 'running';
      const isLxc = guest.type !== 'qemu';
      const sourceNode = guest.node;

      if (sourceNode === target) return res.status(400).json({ error: 'Already on target node' });

      const nodeMap = pveApi.getNodeMap();
      const hostIp = nodeMap[sourceNode]?.ip;
      if (!hostIp) return res.status(400).json({ error: `Cannot resolve IP for node ${sourceNode}` });

      let cmd;
      if (isLxc) {
        const storageFlag = targetStorage ? ` --target-storage ${targetStorage}` : '';
        if (doOnline) {
          cmd = `pct migrate ${vmid} ${target} --online 1 --restart 1${storageFlag}`;
        } else {
          cmd = `pct migrate ${vmid} ${target}${storageFlag}`;
        }
      } else {
        const storageFlag = targetStorage ? ` --targetstorage ${targetStorage}` : '';
        if (doOnline) {
          cmd = `qm migrate ${vmid} ${target} --online 1${storageFlag}`;
        } else {
          cmd = `qm migrate ${vmid} ${target}${storageFlag}`;
        }
      }

      console.log(`[migrate] ${isLxc ? 'CT' : 'VM'} ${vmid} from ${sourceNode} to ${target} (mode: ${mode || 'auto'})${targetStorage ? ' storage: ' + targetStorage : ''}`);

      // For LXC: detect and temporarily remove bind mounts that block migration
      const removedMounts = [];
      if (isLxc) {
        try {
          const cfgResult = await sshExec(hostIp, `pct config ${vmid} 2>/dev/null | grep '^mp'`, { timeout: 10000 });
          const mountLines = cfgResult.stdout.trim().split('\n').filter(Boolean);
          for (const line of mountLines) {
            const match = line.match(/^(mp\d+):\s*(\/.+)/);
            if (match) {
              // This is a bind mount (starts with / not a storage ID)
              const mpKey = match[0].split(':')[0].trim();
              const mpVal = line.substring(line.indexOf(':') + 1).trim();
              removedMounts.push({ key: mpKey, value: mpVal });
              console.log(`[migrate] Temporarily removing bind mount ${mpKey}: ${mpVal}`);
              await sshExec(hostIp, `pct set ${vmid} --delete ${mpKey}`, { timeout: 10000 });
            }
          }
        } catch (err) {
          console.warn(`[migrate] Bind mount check failed: ${err.message}`);
        }
      }

      const result = await sshExec(hostIp, cmd, { timeout: 600000 });

      setTimeout(() => pveApi.refreshAll(), 3000);

      if (result.code !== 0) {
        // Migration failed — re-add any bind mounts we removed
        if (removedMounts.length) {
          console.log(`[migrate] Migration failed, restoring ${removedMounts.length} bind mount(s)`);
          for (const mp of removedMounts) {
            try {
              await sshExec(hostIp, `pct set ${vmid} --${mp.key} ${mp.value}`, { timeout: 10000 });
            } catch (e) {
              // A container left permanently missing a mount, with only the
              // earlier "Migration failed" line, was undiagnosable — name the
              // exact mount and the manual repair.
              console.error(`[migrate] FAILED to restore bind mount --${mp.key} on CT ${vmid} after aborted migration (${e?.message}). Restore manually: pct set ${vmid} --${mp.key} ${mp.value}`);
            }
          }
        }
        return res.status(500).json({ error: result.stderr || result.stdout || 'Migration failed', code: result.code });
      }

      // Re-add bind mounts on the target node (container config moved there)
      if (removedMounts.length) {
        const targetHostIp = nodeMap[target]?.ip;
        if (targetHostIp) {
          for (const mp of removedMounts) {
            try {
              await sshExec(targetHostIp, `pct set ${vmid} --${mp.key} ${mp.value}`, { timeout: 10000 });
              console.log(`[migrate] Restored bind mount ${mp.key} on ${target}`);
            } catch (err) {
              console.warn(`[migrate] Failed to restore ${mp.key} on ${target}: ${err.message}`);
            }
          }
        }
      }

      // Update GPU assignments if gpuReassign was provided
      if (gpuReassign && typeof gpuReassign === 'object') {
        try {
          const assignments = loadGpuAssignments();
          const current = assignments[String(vmid)];
          if (current?.gpus?.length) {
            const newGpus = [];
            for (const oldPci of current.gpus) {
              const newPci = gpuReassign[oldPci];
              if (newPci) newGpus.push(newPci);
            }
            if (newGpus.length) {
              assignments[String(vmid)] = { ...current, gpus: newGpus };
            } else {
              delete assignments[String(vmid)];
            }
            saveGpuAssignments(assignments);
            console.log(`[migrate] GPU reassignment for CT ${vmid}: ${JSON.stringify(gpuReassign)}`);
          }
        } catch (err) {
          console.warn(`[migrate] GPU reassignment failed: ${err.message}`);
        }
      }

      res.json({ ok: true, from: sourceNode, to: target, output: result.stdout });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /guests/:vmid/:action — Execute a power action on a guest.
   * Allowed actions: start, stop, shutdown, reboot.
   */
  router.post('/guests/:vmid/:action', async (req, res) => {
    try {
      const vmid = parseInt(req.params.vmid, 10);
      const action = req.params.action;
      const allowed = ['start', 'stop', 'shutdown', 'reboot'];
      if (!allowed.includes(action)) {
        return res.status(400).json({ error: `Invalid action: ${action}` });
      }

      const guest = pveApi.getGuests().find(g => g.vmid === vmid);
      if (!guest) return res.status(404).json({ error: 'Guest not found' });

      const result = await pveApi.guestAction(guest.node, guest.type, vmid, action);

      // Schedule a PVE cache refresh after power actions so uptime/status is current
      if (['start', 'reboot'].includes(action)) {
        setTimeout(() => pveApi.refreshGuests(), 5000);
      }

      res.json({ ok: true, task: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /guests/:vmid/resize — Resize a guest's disk (increase only).
   *
   * Uses the PVE API resize endpoint (not SSH) because disk resize is a
   * storage-level operation that requires PVE to resize the underlying
   * ZFS/LVM/raw volume.
   *
   * @body {string} disk - Disk identifier (e.g. "rootfs" for LXC, "scsi0" for QEMU)
   * @body {string} size - Relative size increase (e.g. "+5G", "+500M")
   */
  router.put('/guests/:vmid/resize', async (req, res) => {
    try {
      const vmid = parseInt(req.params.vmid, 10);
      const guest = pveApi.getGuests().find(g => g.vmid === vmid);
      if (!guest) return res.status(404).json({ error: 'Guest not found' });

      const { disk, size } = req.body;
      if (!disk || !size) {
        return res.status(400).json({ error: 'disk and size are required' });
      }

      // Validate relative increase format (e.g. "+5G", "+512M", "+1T")
      if (!/^\+\d+(\.\d+)?[KMGT]$/.test(size)) {
        return res.status(400).json({ error: 'size must be relative increase like "+5G"' });
      }

      const endpoint = guest.type === 'qemu' ? 'qemu' : 'lxc';
      await pveApi.request(`/nodes/${guest.node}/${endpoint}/${vmid}/resize`, {
        method: 'PUT',
        body: { disk, size },
      });

      res.json({ ok: true, vmid, disk, size });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /guests/:vmid/resources — Modify CPU cores, memory, or swap.
   *
   * For LXC containers, writes directly to the conf file via SSH.
   * For QEMU VMs, uses the PVE API (changes require VM reboot).
   *
   * @body {number} [cores]  - Number of CPU cores
   * @body {number} [memory] - Memory in MB
   * @body {number} [swap]   - Swap in MB (LXC only)
   */
  router.put('/guests/:vmid/resources', async (req, res) => {
    try {
      const vmid = parseInt(req.params.vmid, 10);
      const guest = pveApi.getGuests().find(g => g.vmid === vmid);
      if (!guest) return res.status(404).json({ error: 'Guest not found' });

      const { cores, memory, swap } = req.body;
      const params = {};
      if (cores !== undefined) params.cores = parseInt(cores, 10);
      if (memory !== undefined) params.memory = parseInt(memory, 10);
      if (swap !== undefined) params.swap = parseInt(swap, 10);

      if (Object.keys(params).length === 0) {
        return res.status(400).json({ error: 'No resource changes specified' });
      }

      if (guest.type === 'lxc') {
        await editLxcConf(vmid, params);
      } else {
        await pveApi.request(`/nodes/${guest.node}/qemu/${vmid}/config`, {
          method: 'PUT',
          body: params,
        });
      }

      res.json({ ok: true, vmid, applied: params });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Storages ─────────────────────────────────────────────────────────────

  /** GET /storages — List available storages per node for migration target selection. */
  router.get('/storages', async (req, res) => {
    try {
      const storages = await pveApi.request('/storage');
      res.json(storages);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GPU Endpoints ──────────────────────────────────────────────────────

  /** GET /gpu — Latest GPU metrics from all monitored nodes */
  router.get('/gpu', (req, res) => {
    res.json(gpuMonitor.getLatest());
  });

  /** GET /gpu/inventory — All discovered GPUs grouped by node */
  router.get('/gpu/inventory', (req, res) => {
    res.json(gpuMonitor.getEnrichedInventory());
  });

  /** GET /gpu/config — GPU friendly name mappings (keyed by node:pciId) */
  router.get('/gpu/config', (req, res) => {
    res.json(gpuMonitor.getConfig());
  });

  /** PUT /gpu/config — Save GPU name/visibility configuration */
  router.put('/gpu/config', (req, res) => {
    gpuMonitor.saveConfig(req.body);
    res.json({ ok: true });
  });

  // ─── GPU Assignments ──────────────────────────────────────────────────────
  // GPU-to-container assignments are persisted in <dataDir>/gpu-assignments.json.
  // When saved, hookscripts are automatically deployed to PVE storage.

  /** GET /gpu/assignments — All per-container GPU assignments */
  router.get('/gpu/assignments', (req, res) => {
    res.json(loadGpuAssignments());
  });

  /**
   * PUT /gpu/assignments/:vmid — Set GPU assignments for a container.
   *
   * Expects { mountStyle: "old"|"new", gpus: ["pciId1", ...] }.
   * After saving, deploys hookscripts to PVE storage so the GPU devices
   * are mounted/unmounted on container start/stop.
   */
  router.put('/gpu/assignments/:vmid', async (req, res) => {
    try {
      const vmid = req.params.vmid;
      const { mountStyle, gpus } = req.body;

      if (!mountStyle || !Array.isArray(gpus)) {
        return res.status(400).json({ error: 'mountStyle and gpus[] are required' });
      }

      const assignments = loadGpuAssignments();
      if (gpus.length === 0) {
        delete assignments[vmid];
      } else {
        assignments[vmid] = { mountStyle, gpus };
      }
      saveGpuAssignments(assignments);

      // Deploy hookscript + variable files to PVE shared storage
      let hookResult = {};
      try {
        if (gpus.length > 0) {
          hookResult = await hookscriptDeploy.saveAndDeploy(vmid, { mountStyle, gpus });
        } else {
          hookResult = await hookscriptDeploy.saveAndRemove(vmid);
        }
      } catch (hookErr) {
        hookResult = { error: hookErr.message };
      }

      // Auto-sync: freeing a GPU may clear the last conflict for an AI agent
      try {
        const { synced } = await checkAndAutoSync({ pveApi, hookscriptDeploy });
        if (synced.length > 0) hookResult.autoSynced = synced;
      } catch (err) {
        console.error('Auto-sync check failed:', err.message);
      }

      res.json({ ok: true, hookscript: hookResult });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** DELETE /gpu/assignments/:vmid — Remove all GPU assignments for a container */
  router.delete('/gpu/assignments/:vmid', (req, res) => {
    const assignments = loadGpuAssignments();
    delete assignments[req.params.vmid];
    saveGpuAssignments(assignments);
    res.json({ ok: true });
  });

  // ─── PVE Cluster Endpoints ────────────────────────────────────────────────

  /** GET /pve/status — Full cluster status refresh (nodes, guests, cluster info) */
  router.get('/pve/status', async (req, res) => {
    try {
      if (!pveApi.configured) {
        return res.json({ configured: false, error: 'PVE API not configured' });
      }
      const cluster = await pveApi.refreshAll();
      // Trigger config refresh in background (enriches guest data without blocking)
      pveApi.refreshGuestConfigs().catch(() => {});
      res.json({ configured: true, ...cluster });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
