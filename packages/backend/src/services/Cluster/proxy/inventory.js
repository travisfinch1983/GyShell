// Cluster Inventory + Hardware + Credential Vault — ported from ProxLab src/routes/inventory.js.
// dataDir -> AILAB_PROXY_DATA_DIR; vector-store (inventory semantic search) stubbed (not migrated).
/* eslint-disable */
// @ts-nocheck
/**
 * inventory.js — Cluster Inventory & Credential Vault
 *
 * Provides:
 *   - PVE cluster inventory with background auto-scan service
 *   - Host hardware catalog
 *   - Credential vault for storing API tokens, logins, SSH keys
 *   - Embedded vector search via local vector store
 *
 * Data files: data/inventory.json, data/hosts.json, data/credentials.json
 *
 * @module routes/inventory
 */

import { Router } from 'express';
import * as fsForState from 'fs';
import { loadJsonState } from './lib/notify.js';
import { emitOnce } from './lib/notify.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.AILAB_PROXY_DATA_DIR || '/tmp';
const vectorStore = {
  search: async () => [], getAll: () => [], getById: () => null,
  getConfig: () => ({ enabled: false }), getStats: () => ({}), updateConfig: (c) => c,
  upsert: () => {}, delete: () => {}, updateData: () => {}, vectorize: async () => {},
  getTextHash: () => null, clearTextHash: () => {},
};

// Announce the stub ONCE at startup. cluster_search sits on this object, so
// agents get a confident empty answer indistinguishable from an empty inventory
// — a capability that looks present but is not must say so at startup, not wait
// to be discovered query by query. Deferred 20s: this runs at module load, and
// the /emit route it posts to is mounted later on this same listener — an
// immediate post would race the mount and the warning itself would be lost.
setTimeout(() => emitOnce('inventory-search-stub', 'warning', 'cluster-inventory',
  'Inventory semantic search is a stub — every query returns zero results',
  'vectorStore in proxy/inventory.js was never migrated: /api/ai/inventory/search always '
  + 'answers 200 with [], and /revectorize does nothing. The cluster_search MCP tool sits '
  + 'on top of this, so agents receive confident empty answers.'), 20000);

const inventoryFile = join(dataDir, 'inventory.json');
const hostsFile = join(dataDir, 'hosts.json');
const credentialsFile = join(dataDir, 'credentials.json');

const INVENTORY = 'proxlab_inventory';
const HOSTS = 'proxlab_hosts';
const CREDENTIALS = 'proxlab_credentials';

// ─── Data Helpers ───────────────────────────────────────────────────────────

function loadInventory() {
  try {
    if (existsSync(inventoryFile)) return JSON.parse(readFileSync(inventoryFile, 'utf-8'));
  } catch {}
  return { entries: [], scanConfig: { enabled: true, intervalMinutes: 15 }, version: 1 };
}

function saveInventory(data) {
  writeFileSync(inventoryFile, JSON.stringify(data, null, 2));
}

function loadHosts() {
  try {
    if (existsSync(hostsFile)) return JSON.parse(readFileSync(hostsFile, 'utf-8'));
  } catch {}
  return { entries: [], version: 1 };
}

function saveHosts(data) {
  writeFileSync(hostsFile, JSON.stringify(data, null, 2));
}

function loadCredentials() {
  return loadJsonState(fsForState, credentialsFile, { entries: [], version: 1 },
    { source: 'cluster-inventory', what: 'Credentials vault' });
}

function saveCredentials(data) {
  writeFileSync(credentialsFile, JSON.stringify(data, null, 2));
}

function genId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

// ─── MAC Address Parsing ────────────────────────────────────────────────────

function parseMac(netStr) {
  if (!netStr) return '';
  const hwMatch = netStr.match(/hwaddr=([A-Fa-f0-9:]+)/i);
  if (hwMatch) return hwMatch[1].toUpperCase();
  const virtioMatch = netStr.match(/^(?:virtio|e1000|rtl8139)=([A-Fa-f0-9:]+)/i);
  if (virtioMatch) return virtioMatch[1].toUpperCase();
  return '';
}

function parseGpuAssignments(vmid, gpuAssignments) {
  if (!gpuAssignments) return '';
  // gpu-assignments.json shape: { "<vmid>": { "mountStyle": "...", "gpus": ["0000:xx:00.0", ...] } }
  // The previous implementation looked for v.vmid + v.friendlyName, neither of which exist on
  // disk — that bug made every guest's `gpus` come back as "". Fall back to PCI IDs (the
  // only stable identifier we have here) when no friendlyName/device side-channel is present.
  const entry = gpuAssignments[String(vmid)];
  if (!entry) return '';
  // Newer per-GPU shape (defensive — supports a future enrichment to { gpus: [{ pciId, name }] })
  if (Array.isArray(entry.gpus)) {
    return entry.gpus.map(g => {
      if (typeof g === 'string') return g;          // bare PCI ID
      return g.friendlyName || g.name || g.model || g.pciId || g.device || 'GPU';
    }).join(', ');
  }
  // Legacy single-string field
  if (typeof entry.gpu === 'string') return entry.gpu;
  return '';
}

// ─── Text Generators (for embedding) ────────────────────────────────────────

function inventoryToText(entry) {
  const ramGB = entry.ram ? Math.round(entry.ram / 1073741824) : 0;
  const diskGB = entry.diskSize ? Math.round(entry.diskSize / 1073741824) : 0;
  return [
    `${entry.type} ${entry.name}`,
    entry.vmid ? `(VMID ${entry.vmid})` : '',
    entry.node ? `on node ${entry.node}` : '',
    entry.ip ? `IP: ${entry.ip}` : '',
    entry.mac ? `MAC: ${entry.mac}` : '',
    entry.os ? `OS: ${entry.os}` : '',
    entry.primaryUse ? `Use: ${entry.primaryUse}` : '',
    entry.cpu ? `CPU: ${entry.cpu} cores` : '',
    ramGB ? `RAM: ${ramGB}GB` : '',
    diskGB ? `Disk: ${diskGB}GB` : '',
    entry.gpus ? `GPUs: ${entry.gpus}` : '',
    entry.status ? `Status: ${entry.status}` : '',
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '',
    entry.notes ? `Notes: ${entry.notes}` : '',
  ].filter(Boolean).join('. ');
}

function hostToText(entry) {
  const hw = entry.hostHardware || {};
  const parts = [
    `Host: ${entry.name}`,
    entry.ip ? `IP: ${entry.ip}` : '',
    entry.primaryUse ? `Use: ${entry.primaryUse}` : '',
    entry.status ? `Status: ${entry.status}` : '',
    hw.hostType ? `Type: ${hw.hostType}` : '',
  ];
  if (hw.cpus?.length) {
    for (const c of hw.cpus) {
      parts.push(`CPU: ${[c.model, c.cores && `${c.cores} cores`, c.threads && `${c.threads} threads`, c.baseClock, c.boostClock && `boost ${c.boostClock}`, c.tdp && `${c.tdp} TDP`].filter(Boolean).join(', ')}`);
    }
  }
  if (hw.ramType || hw.ramSpeed || hw.ramAmount) {
    parts.push(`RAM: ${[hw.ramAmount && `${hw.ramAmount}GB`, hw.ramType, hw.ramEcc, hw.ramSpeed, hw.ramChannels && `${hw.ramChannels} channels`].filter(Boolean).join(' ')}`);
  }
  if (hw.gpus?.length) {
    for (const g of hw.gpus) {
      parts.push(`GPU: ${[g.brand, g.name, g.model, g.gen, g.vram && `${g.vram}GB VRAM`, g.pcieSize && `PCIe x${g.pcieSize}`, g.pcieGen && `Gen ${g.pcieGen}`].filter(Boolean).join(', ')}`);
    }
  }
  if (hw.zpools?.length) {
    for (const z of hw.zpools) {
      parts.push(`Zpool: ${[z.name, z.type, z.diskCount && `${z.diskCount} disks`, z.useCase, z.description].filter(Boolean).join(', ')}`);
    }
  }
  if (hw.nics?.length) {
    for (const n of hw.nics) {
      const macs = [n.mac1, n.mac2, n.mac3, n.mac4].filter(Boolean);
      const bridges = [n.bridge1, n.bridge2, n.bridge3, n.bridge4].filter(Boolean);
      parts.push(`NIC: ${[n.model, n.speed, macs.length && `MACs: ${macs.join(', ')}`, bridges.length && `Bridges: ${bridges.join(', ')}`].filter(Boolean).join(', ')}`);
    }
  }
  if (hw.pcieCards?.length) {
    for (const p of hw.pcieCards) {
      parts.push(`PCIe Card: ${[p.name, p.type, p.purpose, p.description].filter(Boolean).join(', ')}`);
    }
  }
  if (entry.tags?.length) parts.push(`Tags: ${entry.tags.join(', ')}`);
  if (entry.notes) parts.push(`Notes: ${entry.notes}`);
  return parts.filter(Boolean).join('. ');
}

function credentialToText(entry) {
  // NO sensitive fields — only name, type, URL, notes, tags
  return [
    `Credential: ${entry.name}`,
    `Type: ${entry.type}`,
    entry.url ? `URL: ${entry.url}` : '',
    entry.username ? `Username: ${entry.username}` : '',
    entry.notes ? `Notes: ${entry.notes}` : '',
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '',
  ].filter(Boolean).join('. ');
}

// ─── Local Vector Sync ──────────────────────────────────────────────────────

async function syncToLocalStore(collection, entries, toTextFn) {
  if (!entries.length) return;
  const { createHash } = await import('node:crypto');
  const hash = (s) => createHash('sha1').update(s).digest('hex');

  // Partition: entries whose source text changed (need embedding) vs unchanged
  const needsEmbed = [];
  const unchanged = [];
  for (const entry of entries) {
    const text = toTextFn(entry);
    const textHash = hash(text);
    if (textHash === vectorStore.getTextHash(collection, entry.id)) {
      unchanged.push(entry);
    } else {
      needsEmbed.push({ entry, text, textHash });
    }
  }

  // Unchanged entries: just refresh the metadata `data` field (cheap)
  for (const entry of unchanged) {
    const clean = { ...entry };
    delete clean._vectorIds;
    delete clean.userOverrides;
    vectorStore.updateData(collection, entry.id, clean);
  }

  if (needsEmbed.length === 0) {
    console.log(`[inventory] Sync (${collection}): 0 changed, ${unchanged.length} unchanged — no embeddings needed`);
    return;
  }

  // Only embed changed entries, batched to avoid overwhelming the embedder
  const BATCH = 10;
  let synced = 0;
  for (let i = 0; i < needsEmbed.length; i += BATCH) {
    const batch = needsEmbed.slice(i, i + BATCH);
    try {
      const vectors = await vectorStore.vectorize(batch.map(b => b.text));
      for (let j = 0; j < batch.length; j++) {
        const { entry, textHash } = batch[j];
        const clean = { ...entry };
        delete clean._vectorIds;
        delete clean.userOverrides;
        vectorStore.upsert(collection, entry.id, vectors[j], clean, textHash);
      }
      synced += batch.length;
    } catch (e) {
      console.warn(`[inventory] Local vector sync failed batch ${Math.floor(i / BATCH) + 1}: ${e.message}`);
    }
  }
  console.log(`[inventory] Sync (${collection}): ${synced} re-embedded, ${unchanged.length} unchanged (skipped)`);
}

// ─── Scan Service ───────────────────────────────────────────────────────────

let scanTimer = null;
let scanRunning = false;
let lastScanTs = 0;
let lastScanCount = 0;
let pveApiRef = null;

function startInventoryScan(intervalMinutes) {
  if (scanTimer) return;
  const ms = (intervalMinutes || 15) * 60 * 1000;
  // Delayed first run to let PVE cache populate
  setTimeout(() => {
    performScan().catch(e => console.error('[inventory] Initial scan failed:', e.message));
  }, 30000);
  scanTimer = setInterval(() => {
    performScan().catch(e => console.error('[inventory] Scan failed:', e.message));
  }, ms);
  console.log(`[inventory] Auto-scan started (every ${intervalMinutes}min)`);
}

function stopInventoryScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

function loadGpuAssignments() {
  try {
    const gpuFile = join(dataDir, 'gpu-assignments.json');
    if (existsSync(gpuFile)) return JSON.parse(readFileSync(gpuFile, 'utf-8'));
  } catch {}
  return null;
}

/**
 * Build a fresh inventory entry from a PVE guest record, preserving any
 * user-overridden fields on top of the scanned state.
 * @param {object} g - guest from pveApi.getGuests()
 * @param {object} config - guest config from pveApi.getGuestConfigCached()
 * @param {object|null} gpuAssignments - contents of data/gpu-assignments.json
 * @param {object|null} old - existing entry (for preserving userOverrides + createdAt)
 */
function buildEntryFromGuest(g, config, gpuAssignments, old) {
  const id = `pve-${g.vmid}`;
  const entry = {
    id,
    type: g.type === 'qemu' ? 'vm' : 'lxc',
    name: g.name || `CT ${g.vmid}`,
    vmid: g.vmid,
    primaryUse: '',
    cpu: g.maxcpu || 0,
    ram: g.maxmem || 0,
    mac: parseMac(config.net0),
    ip: g.ip || '',
    gpus: parseGpuAssignments(g.vmid, gpuAssignments),
    diskSize: g.maxdisk || 0,
    node: g.node || '',
    status: g.status || 'unknown',
    os: config.ostype || '',
    tags: g.tags || [],
    source: 'pve-scan',
    userOverrides: [],
    lastScanTs: Date.now(),
  };

  if (old) {
    for (const field of (old.userOverrides || [])) {
      if (old[field] !== undefined) entry[field] = old[field];
    }
    entry.userOverrides = old.userOverrides || [];
    entry.createdAt = old.createdAt;
  } else {
    entry.createdAt = new Date().toISOString();
  }
  entry.updatedAt = new Date().toISOString();
  return entry;
}

async function performScan() {
  if (!pveApiRef || scanRunning) return;
  scanRunning = true;

  try {
    const guests = pveApiRef.getGuests();
    const nodeMap = pveApiRef.getNodeMap();
    const inv = loadInventory();
    const existing = new Map(inv.entries.map(e => [e.id, e]));
    const seenIds = new Set();

    const gpuAssignments = loadGpuAssignments();

    // Process guests
    for (const g of guests) {
      const id = `pve-${g.vmid}`;
      seenIds.add(id);
      const config = pveApiRef.getGuestConfigCached(g.vmid) || {};
      const entry = buildEntryFromGuest(g, config, gpuAssignments, existing.get(id));
      existing.set(id, entry);
    }

    // Sync host nodes
    const hosts = loadHosts();
    const existingHosts = new Map(hosts.entries.map(h => [h.id, h]));
    for (const [nodeName, nodeInfo] of Object.entries(nodeMap)) {
      const id = `host-${nodeName}`;
      const old = existingHosts.get(id);
      if (old) {
        old.status = nodeInfo.online ? 'online' : 'offline';
        old.ip = nodeInfo.ip || old.ip;
        delete old.cpu;
        delete old.ram;
        old.lastScanTs = Date.now();
      } else {
        existingHosts.set(id, {
          id,
          name: nodeName,
          primaryUse: '',
          ip: nodeInfo.ip || '',
          status: nodeInfo.online ? 'online' : 'offline',
          tags: [],
          hostHardware: { hostType: '', cpus: [], ramType: '', ramEcc: '', ramSpeed: '', ramChannels: '', ramBandwidth: '', gpus: [], zpools: [], nics: [], pcieCards: [], psus: [] },
          source: 'pve-scan',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastScanTs: Date.now(),
        });
      }
    }
    hosts.entries = Array.from(existingHosts.values());
    saveHosts(hosts);

    // Remove entries that are no longer in PVE (deleted containers/VMs)
    for (const [id, entry] of existing) {
      if (entry.source === 'pve-scan' && !seenIds.has(id)) {
        existing.delete(id);
        vectorStore.delete(INVENTORY, id);
      }
    }

    inv.entries = Array.from(existing.values());
    lastScanTs = Date.now();
    lastScanCount = inv.entries.length;
    inv.scanConfig.lastScanTs = lastScanTs;
    inv.scanConfig.lastScanCount = lastScanCount;
    saveInventory(inv);

    console.log(`[inventory] Scan complete: ${inv.entries.length} entries (${guests.length} guests, ${Object.keys(nodeMap).length} hosts)`);

    // Sync to local vector store (best-effort, sequential to avoid overwhelming embedder)
    try {
      await syncToLocalStore(HOSTS, hosts.entries, hostToText);
      await syncToLocalStore(INVENTORY, inv.entries, inventoryToText);
      // Sync credentials on first scan only (they're user-managed, don't change per scan)
      if (!vectorStore.getAll(CREDENTIALS).length) {
        const creds = loadCredentials();
        if (creds.entries.length) {
          await syncToLocalStore(CREDENTIALS, creds.entries, credentialToText);
        }
      }
    } catch (e) {
      console.warn(`[inventory] Vector sync error: ${e.message}`);
    }
  } finally {
    scanRunning = false;
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export function createInventoryRouter(pveApi) {
  pveApiRef = pveApi;
  const invRouter = Router();
  const hostRouter = Router();
  const credRouter = Router();

  // ─── Search Endpoint ───

  invRouter.post('/search', async (req, res) => {
    const { query, collection, limit = 5 } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    try {
      const [queryVector] = await vectorStore.vectorize([query]);
      const collections = collection
        ? [collection]
        : [INVENTORY, HOSTS, CREDENTIALS];

      let allResults = [];
      for (const col of collections) {
        const results = vectorStore.search(col, queryVector, limit);
        allResults.push(...results.map(r => ({ ...r, collection: col })));
      }

      allResults.sort((a, b) => b.score - a.score);
      allResults = allResults.slice(0, limit);

      res.json({ query, results: allResults });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Vector Store Config ───

  invRouter.get('/vector-config', (req, res) => {
    res.json({ ...vectorStore.getConfig(), stats: vectorStore.getStats() });
  });

  invRouter.put('/vector-config', (req, res) => {
    vectorStore.updateConfig(req.body);
    res.json(vectorStore.getConfig());
  });

  invRouter.get('/vector-browse/:collection', (req, res) => {
    const entries = vectorStore.getAll(req.params.collection);
    res.json({ collection: req.params.collection, count: entries.length, entries });
  });

  invRouter.get('/vector-browse/:collection/:id', (req, res) => {
    const data = vectorStore.getById(req.params.collection, req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found in vector store' });
    res.json({ id: req.params.id, collection: req.params.collection, data });
  });

  invRouter.post('/revectorize', async (req, res) => {
    res.json({ status: 'started' });
    const inv = loadInventory();
    const hosts = loadHosts();
    const creds = loadCredentials();
    syncToLocalStore(INVENTORY, inv.entries, inventoryToText).catch(e => console.warn(`[revectorize] ${e.message}`));
    syncToLocalStore(HOSTS, hosts.entries, hostToText).catch(e => console.warn(`[revectorize] ${e.message}`));
    syncToLocalStore(CREDENTIALS, creds.entries, credentialToText).catch(e => console.warn(`[revectorize] ${e.message}`));
  });

  // ─── Inventory Routes ───

  invRouter.get('/', (req, res) => {
    res.json(loadInventory());
  });

  invRouter.post('/', (req, res) => {
    const inv = loadInventory();
    const entry = {
      id: genId('manual'),
      type: req.body.type || 'external',
      name: req.body.name || 'Unnamed',
      vmid: req.body.vmid || null,
      primaryUse: req.body.primaryUse || '',
      cpu: req.body.cpu || 0,
      ram: req.body.ram || 0,
      mac: req.body.mac || '',
      ip: req.body.ip || '',
      gpus: req.body.gpus || '',
      diskSize: req.body.diskSize || 0,
      node: req.body.node || '',
      status: req.body.status || 'unknown',
      os: req.body.os || '',
      tags: req.body.tags || [],
      source: 'manual',
      userOverrides: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    inv.entries.push(entry);
    saveInventory(inv);
    syncToLocalStore(INVENTORY, [entry], inventoryToText).catch((e) => console.warn(`[inventory] local-store sync failed (write succeeded; index side-effect lost): ${e?.message}`));
    res.json(entry);
  });

  invRouter.put('/:id', (req, res) => {
    const inv = loadInventory();
    const idx = inv.entries.findIndex(e => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });

    const entry = inv.entries[idx];
    const updatable = ['primaryUse', 'name', 'type', 'vmid', 'cpu', 'ram', 'mac', 'ip', 'gpus', 'diskSize', 'node', 'os', 'tags', 'status', 'notes'];
    const overrides = new Set(entry.userOverrides || []);

    for (const field of updatable) {
      if (req.body[field] !== undefined) {
        const oldVal = JSON.stringify(entry[field]);
        const newVal = JSON.stringify(req.body[field]);
        entry[field] = req.body[field];
        if (entry.source === 'pve-scan' && oldVal !== newVal) {
          overrides.add(field);
        }
      }
    }
    entry.userOverrides = Array.from(overrides);
    entry.updatedAt = new Date().toISOString();
    inv.entries[idx] = entry;
    saveInventory(inv);
    syncToLocalStore(INVENTORY, [entry], inventoryToText).catch((e) => console.warn(`[inventory] local-store sync failed (write succeeded; index side-effect lost): ${e?.message}`));
    res.json(entry);
  });

  invRouter.delete('/:id', (req, res) => {
    const inv = loadInventory();
    vectorStore.delete(INVENTORY, req.params.id);
    inv.entries = inv.entries.filter(e => e.id !== req.params.id);
    saveInventory(inv);
    res.json({ ok: true });
  });

  invRouter.post('/scan', async (req, res) => {
    if (scanRunning) return res.json({ status: 'already running' });
    try {
      await performScan();
      res.json({ status: 'complete', count: lastScanCount, timestamp: lastScanTs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /:id/rescan — re-pull fresh PVE data for one entry + re-sync vectors.
  // Body: { force?: boolean } — if true, drops the stored textHash so the
  // embedding gets regenerated even when the text representation didn't change.
  invRouter.post('/:id/rescan', async (req, res) => {
    const inv = loadInventory();
    const idx = inv.entries.findIndex(e => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const old = inv.entries[idx];
    let entry = old;

    if (old.source === 'pve-scan') {
      if (!pveApiRef) return res.status(500).json({ error: 'pveApi not available' });
      const guest = pveApiRef.getGuests().find(g => `pve-${g.vmid}` === old.id);
      if (!guest) return res.status(410).json({ error: 'Guest no longer present in PVE — it may have been deleted. Use the full scan to reconcile.' });
      const config = pveApiRef.getGuestConfigCached(guest.vmid) || {};
      entry = buildEntryFromGuest(guest, config, loadGpuAssignments(), old);
      inv.entries[idx] = entry;
      saveInventory(inv);
    }

    if (req.body?.force) vectorStore.clearTextHash(INVENTORY, entry.id);
    await syncToLocalStore(INVENTORY, [entry], inventoryToText);
    res.json({ ok: true, entry, source: old.source });
  });

  invRouter.get('/scan/status', (req, res) => {
    const inv = loadInventory();
    res.json({
      running: scanRunning,
      lastScanTs: inv.scanConfig.lastScanTs || 0,
      lastScanCount: inv.scanConfig.lastScanCount || 0,
      enabled: inv.scanConfig.enabled,
      intervalMinutes: inv.scanConfig.intervalMinutes || 15,
    });
  });

  invRouter.put('/scan/config', (req, res) => {
    const inv = loadInventory();
    if (req.body.enabled !== undefined) inv.scanConfig.enabled = req.body.enabled;
    if (req.body.intervalMinutes) inv.scanConfig.intervalMinutes = req.body.intervalMinutes;
    saveInventory(inv);

    stopInventoryScan();
    if (inv.scanConfig.enabled) {
      startInventoryScan(inv.scanConfig.intervalMinutes);
    }
    res.json(inv.scanConfig);
  });

  // ─── Host Routes ───

  hostRouter.get('/', (req, res) => {
    res.json(loadHosts());
  });

  hostRouter.get('/:id', (req, res) => {
    const hosts = loadHosts();
    const entry = hosts.entries.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  });

  hostRouter.post('/', (req, res) => {
    const hosts = loadHosts();
    const entry = {
      id: genId('host'),
      name: req.body.name || 'Unnamed Host',
      primaryUse: req.body.primaryUse || '',
      ip: req.body.ip || '',
      status: req.body.status || 'unknown',
      tags: req.body.tags || [],
      hostHardware: req.body.hostHardware || {
        hostType: '', cpus: [], ramType: '', ramEcc: '', ramSpeed: '', ramChannels: '',
        gpus: [], zpools: [], nics: [], pcieCards: [],
      },
      source: 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    hosts.entries.push(entry);
    saveHosts(hosts);
    syncToLocalStore(HOSTS, [entry], hostToText).catch((e) => console.warn(`[inventory] local-store sync failed (write succeeded; index side-effect lost): ${e?.message}`));
    res.json(entry);
  });

  hostRouter.put('/:id', (req, res) => {
    const hosts = loadHosts();
    const idx = hosts.entries.findIndex(e => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });

    const entry = hosts.entries[idx];
    for (const f of ['name', 'primaryUse', 'ip', 'status', 'tags', 'notes']) {
      if (req.body[f] !== undefined) entry[f] = req.body[f];
    }
    if (req.body.hostHardware) {
      entry.hostHardware = req.body.hostHardware;
    }
    entry.updatedAt = new Date().toISOString();
    hosts.entries[idx] = entry;
    saveHosts(hosts);
    syncToLocalStore(HOSTS, [entry], hostToText).catch((e) => console.warn(`[inventory] local-store sync failed (write succeeded; index side-effect lost): ${e?.message}`));
    res.json(entry);
  });

  hostRouter.delete('/:id', (req, res) => {
    const hosts = loadHosts();
    vectorStore.delete(HOSTS, req.params.id);
    hosts.entries = hosts.entries.filter(e => e.id !== req.params.id);
    saveHosts(hosts);
    res.json({ ok: true });
  });

  // POST /:id/rescan — refresh host liveness/IP from pveApi + re-sync vectors.
  // Body: { force?: boolean } — drops stored textHash to force re-embedding.
  hostRouter.post('/:id/rescan', async (req, res) => {
    const hosts = loadHosts();
    const idx = hosts.entries.findIndex(e => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const entry = hosts.entries[idx];

    if (pveApiRef) {
      const nodeMap = pveApiRef.getNodeMap();
      const nodeName = entry.name || entry.id.replace(/^host-/, '');
      const nodeInfo = nodeMap[nodeName];
      if (nodeInfo) {
        entry.status = nodeInfo.online ? 'online' : 'offline';
        entry.ip = nodeInfo.ip || entry.ip;
        entry.lastScanTs = Date.now();
        entry.updatedAt = new Date().toISOString();
        hosts.entries[idx] = entry;
        saveHosts(hosts);
      }
    }

    if (req.body?.force) vectorStore.clearTextHash(HOSTS, entry.id);
    await syncToLocalStore(HOSTS, [entry], hostToText);
    res.json({ ok: true, entry });
  });

  // ─── Credential Routes ───

  credRouter.get('/', (req, res) => {
    const creds = loadCredentials();
    const masked = creds.entries.map(e => ({
      ...e,
      password: e.password ? '••••••••' : '',
      tokenSecret: e.tokenSecret ? '••••••••' : '',
      bearerToken: e.bearerToken ? '••••••••' : '',
      sshPrivateKey: e.sshPrivateKey ? '••••••••' : '',
      sshPublicKey: e.sshPublicKey ? '••••••••' : '',
    }));
    res.json({ entries: masked });
  });

  credRouter.get('/:id', (req, res) => {
    const creds = loadCredentials();
    const entry = creds.entries.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  });

  credRouter.post('/', (req, res) => {
    const creds = loadCredentials();
    const entry = {
      id: genId('cred'),
      name: req.body.name || 'Unnamed',
      type: req.body.type || 'login',
      url: req.body.url || '',
      username: req.body.username || '',
      password: req.body.password || '',
      tokenId: req.body.tokenId || '',
      tokenSecret: req.body.tokenSecret || '',
      sshKeyPath: req.body.sshKeyPath || '',
      sshPrivateKey: req.body.sshPrivateKey || '',
      sshPublicKey: req.body.sshPublicKey || '',
      bearerToken: req.body.bearerToken || '',
      notes: req.body.notes || '',
      tags: req.body.tags || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    creds.entries.push(entry);
    saveCredentials(creds);
    syncToLocalStore(CREDENTIALS, [entry], credentialToText).catch((e) => console.warn(`[inventory] local-store sync failed (write succeeded; index side-effect lost): ${e?.message}`));
    res.json({ ...entry, password: entry.password ? '••••••••' : '', tokenSecret: entry.tokenSecret ? '••••••••' : '', bearerToken: entry.bearerToken ? '••••••••' : '', sshPrivateKey: entry.sshPrivateKey ? '••••••••' : '', sshPublicKey: entry.sshPublicKey ? '••••••••' : '' });
  });

  credRouter.put('/:id', (req, res) => {
    const creds = loadCredentials();
    const idx = creds.entries.findIndex(e => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });

    const entry = creds.entries[idx];
    const updatable = ['name', 'type', 'url', 'username', 'password', 'tokenId', 'tokenSecret', 'sshKeyPath', 'sshPrivateKey', 'sshPublicKey', 'bearerToken', 'notes', 'tags'];
    for (const field of updatable) {
      if (req.body[field] !== undefined) entry[field] = req.body[field];
    }
    entry.updatedAt = new Date().toISOString();
    creds.entries[idx] = entry;
    saveCredentials(creds);
    syncToLocalStore(CREDENTIALS, [entry], credentialToText).catch((e) => console.warn(`[inventory] local-store sync failed (write succeeded; index side-effect lost): ${e?.message}`));
    res.json({ ...entry, password: entry.password ? '••••••••' : '', tokenSecret: entry.tokenSecret ? '••••••••' : '', bearerToken: entry.bearerToken ? '••••••••' : '', sshPrivateKey: entry.sshPrivateKey ? '••••••••' : '', sshPublicKey: entry.sshPublicKey ? '••••••••' : '' });
  });

  credRouter.delete('/:id', (req, res) => {
    const creds = loadCredentials();
    vectorStore.delete(CREDENTIALS, req.params.id);
    creds.entries = creds.entries.filter(e => e.id !== req.params.id);
    saveCredentials(creds);
    res.json({ ok: true });
  });

  // Start scan if enabled
  const inv = loadInventory();
  if (inv.scanConfig.enabled) {
    startInventoryScan(inv.scanConfig.intervalMinutes);
  }

  return { invRouter, hostRouter, credRouter, startInventoryScan, stopInventoryScan, performScan };
}
