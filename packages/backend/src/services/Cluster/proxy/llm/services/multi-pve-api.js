/**
 * MultiPveApi — fans PveApi out across SEVERAL independent Proxmox endpoints and
 * presents the merged result behind the exact same interface a single PveApi has.
 *
 * WHY THIS EXISTS
 * ---------------
 * px-nas was rebuilt on 2026-08-09 and left the DeeveeyantLab cluster, so the homelab
 * is now TWO unrelated PVE installations with separate auth databases:
 *   - px-nas   10.0.0.17   standalone, 56 guests, 2 GPUs
 *   - cluster  10.0.0.101  px-epyc + px-gpu + px-micronode + px-vault, 92 guests,
 *                          and every inference GPU (8x V100, 4x 5060Ti, 4090)
 * A single-endpoint client can only ever see one of those. Pointing at px-nas hid all
 * the AI GPUs; pointing at the cluster hid the 56 guests that now run the platform.
 *
 * Each child PveApi keeps its own credentials, cache and refresh timers — this class
 * only merges reads and ROUTES writes to the endpoint that actually owns the node.
 *
 * ⚠ VMID COLLISIONS ARE REAL HERE, not theoretical. The two installations allocate
 * VMIDs independently, so the same id exists on both — e.g. 160/prometheus and
 * 105/grafana run on px-nas while stopped copies of the same ids linger on
 * px-micronode. Consumers (notably inventory.js) key entries as `pve-<vmid>`, so a
 * naive concat would let one silently overwrite the other. See resolveCollisions().
 */

import { PveApi } from './pve-api.js';

export class MultiPveApi {
  /**
   * @param config llm-config.json. Endpoints come from `proxmoxEndpoints` (array).
   *               If absent, falls back to the single legacy `proxmox` block, so an
   *               un-migrated config keeps working unchanged.
   */
  constructor(config) {
    const legacy = config.proxmox || {};
    const list = Array.isArray(config.proxmoxEndpoints) && config.proxmoxEndpoints.length
      ? config.proxmoxEndpoints
      : [legacy];

    this.clients = list
      .filter(ep => ep && ep.host)
      .map((ep, i) => {
        const client = new PveApi({ proxmox: ep });
        client.endpointName = ep.name || ep.host || `endpoint-${i}`;
        return client;
      });

    this.subscribers = new Set();
    this._loggedCollisions = new Set();
    this._unsub = [];

    // Re-broadcast a MERGED view whenever any child refreshes. Without this,
    // subscribers would receive one endpoint's guest list and treat it as the whole
    // world — the exact bug this class exists to remove.
    for (const c of this.clients) {
      if (typeof c.subscribe === 'function') {
        this._unsub.push(c.subscribe(() => this.broadcast({
          type: 'guests-update',
          data: this.getGuests(),
          nodes: this.cachedNodes,
        })));
      }
    }
  }

  /** The endpoint used for cluster-wide reads that aren't node-scoped. */
  get primary() {
    return this.clients[0] || null;
  }

  get configured() {
    return this.clients.some(c => c.configured);
  }

  get host() {
    return this.primary?.host || '';
  }

  get lastRefresh() {
    return this.clients.reduce((max, c) => Math.max(max, c.lastRefresh || 0), 0);
  }

  get cachedCluster() {
    // Only a real (quorate) cluster reports this; a standalone node returns null.
    for (const c of this.clients) if (c.cachedCluster) return c.cachedCluster;
    return null;
  }

  get cachedNodes() {
    const out = [];
    for (const c of this.clients) {
      for (const n of c.cachedNodes || []) out.push({ ...n, endpoint: c.endpointName });
    }
    return out;
  }

  // ---------------------------------------------------------------- routing ----

  /** Which client owns this node? Falls back to primary so callers never get undefined. */
  clientForNode(nodeName) {
    if (nodeName) {
      for (const c of this.clients) {
        if (c.cachedNodeMap && c.cachedNodeMap[nodeName]) return c;
      }
    }
    return this.primary;
  }

  /** Which client owns this vmid? Uses the same precedence as the merged guest list. */
  clientForVmid(vmid) {
    const g = this.getGuests().find(x => String(x.vmid) === String(vmid));
    return g ? this.clientForNode(g.node) : this.primary;
  }

  // ------------------------------------------------------------------ reads ----

  getNodeMap() {
    const map = {};
    for (const c of this.clients) {
      for (const [name, info] of Object.entries(c.cachedNodeMap || {})) {
        // Node NAMES are unique across these installations (px-nas vs px-epyc/px-gpu/
        // px-micronode/px-vault). If that ever stops being true, first-wins and we log.
        if (map[name]) {
          this._warnOnce(`node:${name}`,
            `[multi-pve] node name "${name}" exists on both `
            + `${map[name].endpoint} and ${c.endpointName} — keeping ${map[name].endpoint}`);
          continue;
        }
        map[name] = { ...info, endpoint: c.endpointName };
      }
    }
    return map;
  }

  getGuests() {
    const merged = [];
    for (const c of this.clients) {
      for (const g of c.getGuests() || []) merged.push({ ...g, endpoint: c.endpointName });
    }
    return this.resolveCollisions(merged).sort((a, b) => a.vmid - b.vmid);
  }

  /**
   * De-duplicate guests that share a vmid across endpoints.
   *
   * Policy: a RUNNING guest beats a stopped one; otherwise the earlier endpoint wins.
   * Rationale — the observed real case is a live container on px-nas alongside a
   * leftover stopped copy of the same vmid on px-micronode. Showing the stopped ghost
   * instead of the running service would be actively misleading, so "running wins"
   * matches what an operator means. Every collision is logged once so the duplicate
   * gets cleaned up rather than silently tolerated forever.
   */
  resolveCollisions(guests) {
    const byId = new Map();
    for (const g of guests) {
      const prev = byId.get(g.vmid);
      if (!prev) { byId.set(g.vmid, g); continue; }

      const prevRunning = prev.status === 'running';
      const nextRunning = g.status === 'running';
      const winner = (!prevRunning && nextRunning) ? g : prev;
      const loser = winner === g ? prev : g;

      this._warnOnce(`vmid:${g.vmid}`,
        `[multi-pve] VMID ${g.vmid} exists on BOTH `
        + `${prev.endpoint}/${prev.node} (${prev.name}, ${prev.status}) and `
        + `${g.endpoint}/${g.node} (${g.name}, ${g.status}) — `
        + `using ${winner.endpoint}/${winner.node}, hiding ${loser.endpoint}/${loser.node}. `
        + `Consumers key on vmid, so resolve this duplicate.`);

      byId.set(g.vmid, winner);
    }
    return Array.from(byId.values());
  }

  getGuestConfigCached(vmid) {
    // Ask the owning endpoint first so a collision can't return the wrong config.
    const owner = this.clientForVmid(vmid);
    const fromOwner = owner?.getGuestConfigCached(vmid);
    if (fromOwner) return fromOwner;
    for (const c of this.clients) {
      const cfg = c.getGuestConfigCached(vmid);
      if (cfg) return cfg;
    }
    return null;
  }

  getGuestConfig(node, type, vmid) {
    return this.clientForNode(node).getGuestConfig(node, type, vmid);
  }

  /**
   * Merged /cluster/status — node entries from EVERY endpoint, plus the first real
   * cluster entry (a standalone node has none).
   *
   * ⚠ This MUST merge, not delegate to primary. GpuMonitor.discoverGpus() derives its
   * whole node list from here and then probes /nodes/<name>/hardware/pci per node. When
   * this returned only the primary's view, px-nas being standalone meant "1 node" and
   * every GPU on px-gpu (8x V100) and px-epyc (4x 5060Ti + 4090) stayed invisible even
   * though the cluster endpoint was configured and healthy.
   */
  async getClusterStatus() {
    const results = await Promise.allSettled(this.clients.map(c => c.getClusterStatus()));

    const nodes = new Map();
    let cluster = null;
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') {
        console.warn(`[multi-pve] cluster status failed for `
          + `${this.clients[i].endpointName}: ${r.reason?.message || r.reason}`);
        return;
      }
      for (const e of r.value || []) {
        if (e.type === 'cluster') { cluster = cluster || e; continue; }
        if (e.type !== 'node') continue;
        if (nodes.has(e.name)) continue;   // first endpoint wins; see getNodeMap()
        nodes.set(e.name, { ...e, endpoint: this.clients[i].endpointName });
      }
    });

    return [...(cluster ? [cluster] : []), ...nodes.values()];
  }

  /**
   * Raw API passthrough. Node-scoped paths (/nodes/<name>/...) route to the endpoint
   * owning that node; everything else goes to the primary. Without this, a request for
   * a px-gpu path would be sent to px-nas and 401/404 in a way that looks like the
   * node is down rather than misrouted.
   */
  request(path, opts) {
    const m = typeof path === 'string' && path.match(/^\/nodes\/([^/]+)/);
    const client = m ? this.clientForNode(decodeURIComponent(m[1])) : this.primary;
    return client.request(path, opts);
  }

  guestAction(node, type, vmid, action) {
    return this.clientForNode(node).guestAction(node, type, vmid, action);
  }

  // ---------------------------------------------------------------- refresh ----

  async refreshGuests() {
    await Promise.allSettled(this.clients.map(c => c.refreshGuests()));
  }

  async refreshGuestConfigs() {
    await Promise.allSettled(this.clients.map(c => c.refreshGuestConfigs()));
  }

  startRefresh(interval = 30000) {
    for (const c of this.clients) c.startRefresh(interval);
  }

  stopRefresh() {
    for (const c of this.clients) c.stopRefresh();
  }

  restartRefresh(interval) {
    for (const c of this.clients) c.restartRefresh(interval);
  }

  async refreshAll() {
    await Promise.allSettled(this.clients.map(c => c.refreshAll()));
    const guests = this.getGuests();
    return {
      cluster: this.cachedCluster,
      nodes: this.cachedNodes,
      nodeMap: this.getNodeMap(),
      containers: guests.filter(g => g.type === 'lxc'),
      vms: guests.filter(g => g.type === 'qemu'),
      timestamp: this.lastRefresh,
    };
  }

  // ------------------------------------------------------------ subscribers ----

  subscribe(fn) {
    this.subscribers.add(fn);
    const guests = this.getGuests();
    if (guests.length > 0) fn({ type: 'guests-update', data: guests, nodes: this.cachedNodes });
    return () => this.subscribers.delete(fn);
  }

  broadcast(msg) {
    for (const fn of this.subscribers) {
      try {
        fn(msg);
      } catch (err) {
        // A broken subscriber must not take down the refresh loop for every other one.
        console.error('[multi-pve] subscriber threw:', err.message);
      }
    }
  }

  /** Log a given condition once, not on every 10s refresh. */
  _warnOnce(key, msg) {
    if (this._loggedCollisions.has(key)) return;
    this._loggedCollisions.add(key);
    console.warn(msg);
  }

  /** Per-endpoint health, for diagnostics. */
  status() {
    return this.clients.map(c => ({
      name: c.endpointName,
      host: c.host,
      configured: c.configured,
      nodes: Object.keys(c.cachedNodeMap || {}),
      guests: (c.getGuests() || []).length,
      lastRefresh: c.lastRefresh || 0,
    }));
  }
}
