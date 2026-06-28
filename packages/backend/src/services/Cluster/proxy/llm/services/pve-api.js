/**
 * Proxmox VE API Client
 * Connects to the PVE cluster API to auto-discover nodes, VMs/CTs, and resources.
 * Maintains a cached, periodically-refreshed guest list.
 */

import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

export class PveApi {
  constructor(config) {
    this.host = config.proxmox?.host || '';
    this.port = config.proxmox?.port || 8006;
    this.tokenId = config.proxmox?.tokenId || '';
    this.tokenSecret = config.proxmox?.tokenSecret || '';

    // Cached cluster data
    this.cachedGuests = [];
    this.cachedNodes = [];
    this.cachedNodeMap = {};
    this.cachedCluster = null;
    this.cachedGuestConfigs = {};
    this.lastRefresh = 0;
    this.refreshTimer = null;
    this.configRefreshTimer = null;
    this.subscribers = new Set();
  }

  get configured() {
    return !!(this.host && this.tokenId && this.tokenSecret);
  }

  configure({ host, port, tokenId, tokenSecret }) {
    if (host) this.host = host;
    if (port) this.port = port;
    if (tokenId) this.tokenId = tokenId;
    if (tokenSecret) this.tokenSecret = tokenSecret;
  }

  /**
   * Start periodic guest list refresh.
   */
  startRefresh(interval = 30000) {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.configRefreshTimer) clearInterval(this.configRefreshTimer);
    if (!this.configured) return;

    this.refreshGuests().then(() => this.refreshGuestConfigs());
    this.refreshTimer = setInterval(() => this.refreshGuests(), interval);
    this.configRefreshTimer = setInterval(() => this.refreshGuestConfigs(), 120000);
    console.log(`PVE API: auto-refreshing guests every ${interval / 1000}s, configs every 120s`);
  }

  stopRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.configRefreshTimer) {
      clearInterval(this.configRefreshTimer);
      this.configRefreshTimer = null;
    }
  }

  restartRefresh(interval) {
    this.stopRefresh();
    this.startRefresh(interval);
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    if (this.cachedGuests.length > 0) {
      fn({ type: 'guests-update', data: this.cachedGuests, nodes: this.cachedNodes });
    }
    return () => this.subscribers.delete(fn);
  }

  broadcast(msg) {
    for (const fn of this.subscribers) {
      try { fn(msg); } catch {}
    }
  }

  // --- HTTP helpers ---

  async request(path, { method = 'GET', body } = {}) {
    if (!this.configured) {
      throw new Error('PVE API not configured');
    }

    const url = `https://${this.host}:${this.port}/api2/json${path}`;

    return new Promise((resolve, reject) => {
      const opts = {
        method,
        agent,
        headers: {
          Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
        },
        timeout: 10000,
      };

      if (body) {
        const payload = typeof body === 'string' ? body : new URLSearchParams(body).toString();
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = https.request(url, opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (!data.trim()) {
              if (res.statusCode >= 400) {
                reject(new Error(`PVE API error: HTTP ${res.statusCode}`));
                return;
              }
              resolve({ data: null });
              return;
            }
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              const msg = parsed.message || parsed.errors || `HTTP ${res.statusCode}`;
              reject(new Error(String(msg).trim()));
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(new Error(`PVE API parse error: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('PVE API request timed out'));
      });

      if (body) {
        const payload = typeof body === 'string' ? body : new URLSearchParams(body).toString();
        req.write(payload);
      }
      req.end();
    });
  }

  // --- Basic API methods ---

  async getVersion() {
    const res = await this.request('/version');
    return res.data;
  }

  async getNodes() {
    const res = await this.request('/nodes');
    if (!res.data) return [];
    return res.data.map((n) => ({
      node: n.node,
      status: n.status || 'unknown',
      cpu: n.cpu || 0,
      maxcpu: n.maxcpu || 0,
      mem: n.mem || 0,
      maxmem: n.maxmem || 0,
      disk: n.disk || 0,
      maxdisk: n.maxdisk || 0,
      uptime: n.uptime || 0,
    }));
  }

  async getClusterStatus() {
    const res = await this.request('/cluster/status');
    if (!res.data) return [];
    return res.data;
  }

  async getResources(type) {
    const path = type ? `/cluster/resources?type=${type}` : '/cluster/resources';
    const res = await this.request(path);
    return res.data || [];
  }

  async getNodeContainers(nodeName) {
    const res = await this.request(`/nodes/${nodeName}/lxc`);
    return res.data || [];
  }

  async getNodeVMs(nodeName) {
    const res = await this.request(`/nodes/${nodeName}/qemu`);
    return res.data || [];
  }

  async getNodeStatus(nodeName) {
    const res = await this.request(`/nodes/${nodeName}/status`);
    return res.data;
  }

  async getGuestConfig(node, type, vmid) {
    const endpoint = type === 'qemu' ? 'qemu' : 'lxc';
    const res = await this.request(`/nodes/${node}/${endpoint}/${vmid}/config`);
    return res.data || {};
  }

  // --- Guest control actions ---

  async guestAction(node, type, vmid, action) {
    const endpoint = type === 'qemu' ? 'qemu' : 'lxc';
    const res = await this.request(
      `/nodes/${node}/${endpoint}/${vmid}/status/${action}`,
      { method: 'POST' }
    );
    return res.data;
  }

  // --- Enriched guest list ---

  /**
   * Fetch all guests from cluster resources, enrich with IPs from tags,
   * and cache the result.
   */
  async refreshGuests() {
    if (!this.configured) return;

    try {
      // Fetch cluster status, nodes, and resources in parallel
      const [clusterStatus, nodeStats, resources] = await Promise.all([
        this.getClusterStatus(),
        this.getNodes(),
        this.getResources('vm'),
      ]);

      // Build node map
      const nodeEntries = clusterStatus.filter(e => e.type === 'node');
      this.cachedCluster = clusterStatus.find(e => e.type === 'cluster') || null;

      this.cachedNodeMap = {};
      for (const entry of nodeEntries) {
        this.cachedNodeMap[entry.name] = {
          name: entry.name,
          ip: entry.ip,
          online: entry.online === 1,
          nodeid: entry.nodeid,
          local: entry.local === 1,
        };
      }

      // Merge node stats with IPs
      this.cachedNodes = nodeStats.map(n => ({
        ...n,
        ip: this.cachedNodeMap[n.node]?.ip || '',
        online: this.cachedNodeMap[n.node]?.online ?? (n.status === 'online'),
      }));

      // Enrich guest resources
      this.cachedGuests = resources.map(g => {
        const rawTags = g.tags || '';
        const { ip, tags } = extractIpAndTags(rawTags);
        const nodeInfo = this.cachedNodeMap[g.node] || {};

        return {
          vmid: g.vmid,
          name: g.name || `${g.type}-${g.vmid}`,
          type: g.type,        // 'lxc' or 'qemu'
          node: g.node,
          nodeIp: nodeInfo.ip || '',
          status: g.status,    // 'running' or 'stopped'
          ip,
          tags,
          cpu: g.cpu || 0,
          maxcpu: g.maxcpu || 0,
          mem: g.mem || 0,
          maxmem: g.maxmem || 0,
          disk: g.disk || 0,
          maxdisk: g.maxdisk || 0,
          uptime: g.uptime || 0,
          netin: g.netin || 0,
          netout: g.netout || 0,
          swap: g.swap || 0,
          maxswap: g.maxswap || 0,
        };
      }).sort((a, b) => a.vmid - b.vmid);

      // Re-apply cached config enrichment (survives between config refresh cycles)
      if (Object.keys(this.cachedGuestConfigs).length > 0) {
        for (const g of this.cachedGuests) {
          const cfg = this.cachedGuestConfigs[g.vmid];
          if (!cfg) continue;
          g.ostype = cfg.ostype || '';
          g.arch = cfg.arch || '';
          g.onboot = cfg.onboot ?? 0;
          g.features = cfg.features || '';
          g.unprivileged = cfg.unprivileged ?? 0;
          g.console = cfg.console ?? 1;
          g.tty = cfg.tty ?? 2;
          g.cmode = cfg.cmode || 'tty';
          g.protection = cfg.protection ?? 0;
          g.startup = cfg.startup || '';
          g.lxcenv = extractLxcEnv(cfg.lxc);
          if (g.type === 'lxc') {
            g.maxswap = (cfg.swap ?? 0) * 1024 * 1024;
          }
        }
      }

      this.lastRefresh = Date.now();
      this.broadcast({
        type: 'guests-update',
        data: this.cachedGuests,
        nodes: this.cachedNodes,
      });

    } catch (err) {
      console.error('PVE guest refresh error:', err.message);
    }
  }

  /**
   * Batch-fetch config for all guests (concurrency-limited).
   * Enriches cachedGuests with ostype, arch, onboot, features.
   */
  async refreshGuestConfigs() {
    if (!this.configured || this.cachedGuests.length === 0) return;

    const CONCURRENCY = 10;
    const guests = [...this.cachedGuests];
    const results = {};

    for (let i = 0; i < guests.length; i += CONCURRENCY) {
      const batch = guests.slice(i, i + CONCURRENCY);
      const configs = await Promise.allSettled(
        batch.map(g => this.getGuestConfig(g.node, g.type, g.vmid))
      );
      batch.forEach((g, idx) => {
        if (configs[idx].status === 'fulfilled') {
          results[g.vmid] = configs[idx].value;
        }
      });
    }

    this.cachedGuestConfigs = results;

    // Enrich cached guests with config data
    for (const g of this.cachedGuests) {
      const cfg = results[g.vmid];
      if (cfg) {
        g.ostype = cfg.ostype || '';
        g.arch = cfg.arch || '';
        g.onboot = cfg.onboot ?? 0;
        g.features = cfg.features || '';
        g.unprivileged = cfg.unprivileged ?? 0;
        g.console = cfg.console ?? 1;
        g.tty = cfg.tty ?? 2;
        g.cmode = cfg.cmode || 'tty';
        g.protection = cfg.protection ?? 0;
        g.startup = cfg.startup || '';
        g.lxcenv = extractLxcEnv(cfg.lxc);
        // Extract swap from config (authoritative value, in MB -> bytes)
        if (g.type === 'lxc') {
          g.maxswap = (cfg.swap ?? 0) * 1024 * 1024;
        }
      }
    }

    console.log(`PVE API: guest configs refreshed (${Object.keys(results).length} guests)`);

    this.broadcast({
      type: 'guests-update',
      data: this.cachedGuests,
      nodes: this.cachedNodes,
    });
  }

  getGuestConfigCached(vmid) {
    return this.cachedGuestConfigs[vmid] || null;
  }

  /**
   * Comprehensive refresh for the cluster panel (legacy compat).
   */
  async refreshAll() {
    if (this.cachedGuests.length === 0) {
      await this.refreshGuests();
    }

    return {
      cluster: this.cachedCluster,
      nodes: this.cachedNodes,
      nodeMap: this.cachedNodeMap,
      containers: this.cachedGuests.filter(g => g.type === 'lxc'),
      vms: this.cachedGuests.filter(g => g.type === 'qemu'),
      timestamp: this.lastRefresh,
    };
  }

  getGuests() {
    return this.cachedGuests;
  }

  getNodeMap() {
    return this.cachedNodeMap;
  }
}

/**
 * Extract IP address and descriptive tags from PVE tag string.
 * Tags format: "10.0.0.155;community-script;media" or "0.155;tag1;tag2"
 * Shortened IPs like "0.155" expand to "10.0.0.155".
 * Docker bridge IPs (172.x) are skipped.
 */
function extractIpAndTags(tagStr) {
  if (!tagStr) return { ip: '', tags: [] };

  const parts = tagStr.split(';').map(t => t.trim()).filter(Boolean);
  let ip = '';
  const tags = [];

  for (const part of parts) {
    if (!ip && isLikelyIp(part)) {
      ip = normalizeIp(part);
    } else if (part.match(/^172\.\d+\.\d+\.\d+$/)) {
      // Skip Docker bridge IPs
      continue;
    } else {
      tags.push(part);
    }
  }

  return { ip, tags };
}

function isLikelyIp(str) {
  // Full IP: 10.0.0.x
  if (/^10\.\d+\.\d+\.\d+$/.test(str)) return true;
  // Shortened: 0.xxx (meaning 10.0.0.xxx)
  if (/^0\.\d{1,3}$/.test(str)) return true;
  return false;
}

function normalizeIp(str) {
  if (str.startsWith('10.')) return str;
  if (str.startsWith('0.')) return `10.0.0.${str.slice(2)}`;
  return str;
}

/**
 * Extract lxc.environment entries from the raw lxc config array.
 * PVE returns lxc as an array of [key, value] pairs.
 * Returns an object like { VAR_NAME: "value", ... }
 */
function extractLxcEnv(lxcArr) {
  if (!Array.isArray(lxcArr)) return {};
  const env = {};
  for (const entry of lxcArr) {
    if (Array.isArray(entry) && entry[0] === 'lxc.environment') {
      const val = entry[1] || '';
      const eqIdx = val.indexOf('=');
      if (eqIdx > 0) {
        env[val.slice(0, eqIdx)] = val.slice(eqIdx + 1);
      }
    }
  }
  return env;
}
