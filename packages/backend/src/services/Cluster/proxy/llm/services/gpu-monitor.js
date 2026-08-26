/**
 * GPU Monitor Service
 * Auto-discovers GPUs via PVE API on all cluster nodes,
 * polls live stats using proxlab-nvtop (all vendors) with nvidia-smi fallback.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GPU_CONFIG_PATH = process.env.AILAB_PROXY_DATA_DIR ? join(process.env.AILAB_PROXY_DATA_DIR, 'gpu-config.json') : join(__dirname, '../../data/gpu-config.json');

/** Path where proxlab-nvtop is deployed on remote hosts */
const NVTOP_REMOTE_PATH = '/opt/proxlab/bin/proxlab-nvtop';
/** Snapshot command with marker to isolate JSON from MOTD noise */
const NVTOP_CMD = `echo ___NVTOP___;${NVTOP_REMOTE_PATH} -s 2>/dev/null`;
/** Fallback for hosts without proxlab-nvtop */
const NVIDIA_SMI_CMD = "bash --norc --noprofile -c 'nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null'";
const NVIDIA_UUID_CMD = "bash --norc --noprofile -c 'S=$(command -v nvidia-smi-cached || command -v nvidia-smi); \"$S\" --query-gpu=index,uuid,pci.bus_id,name --format=csv,noheader 2>/dev/null'";

export class GpuMonitor {
  constructor(config, sshService, pveApi, { interval = 5000 } = {}) {
    this.config = config;
    this.sshService = sshService;
    this.pveApi = pveApi;
    this.interval = interval;
    this.timer = null;
    this.discoveryTimer = null;
    this.subscribers = new Set();
    this.lastData = {};

    // Discovered GPU inventory: { nodeName: { ip, allGpus, nvidiaGpus, otherGpus, uuidMap } }
    this.gpuInventory = {};
    // Node IP map from PVE cluster status
    this.nodeIpMap = {};
    // Tracks which hosts have proxlab-nvtop deployed: { nodeName: true/false }
    this.nvtopAvailable = {};
    // User-defined GPU config (friendly names)
    this.gpuConfig = this.loadConfig();
    // Path to local proxlab-nvtop binary for deployment
    this.nvtopBinaryPath = join(__dirname, '../../vendor/nvtop/proxlab-nvtop');
    // Callbacks for when hosts come online (e.g. trigger cache validation)
    this.onHostOnlineCallbacks = [];
  }

  loadConfig() {
    try {
      if (existsSync(GPU_CONFIG_PATH)) {
        return JSON.parse(readFileSync(GPU_CONFIG_PATH, 'utf-8'));
      }
    } catch {}
    return {};
  }

  saveConfig(config) {
    this.gpuConfig = config;
    writeFileSync(GPU_CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  getConfig() {
    return this.gpuConfig;
  }

  /**
   * Get a friendly name for a GPU by node:pciId key.
   */
  getFriendlyName(node, pciId) {
    const key = `${node}:${pciId}`;
    return this.gpuConfig[key]?.friendlyName || null;
  }

  async start() {
    if (this.discoveryTimer) return;

    // Run initial GPU discovery (PVE-API inventory + UUID/PCI map — needed for placement & the GPU-pool UI)
    await this.discoverGpus();

    const totalGpus = Object.values(this.gpuInventory)
      .reduce((sum, h) => sum + h.allGpus.length, 0);
    const totalHosts = Object.keys(this.gpuInventory).length;

    // NOTE: the live-stats poller (proxlab-nvtop / nvidia-smi SSH loop) and proxlab-nvtop deployment
    // are intentionally DISABLED — live GPU metrics now come from Prometheus/DCGM, not this SSH poller.
    // The constant nvidia-smi polling also held /dev/nvidia* open and fought driver swaps. We keep only
    // the periodic inventory discovery below (getEnrichedInventory / getConfig stay populated).
    console.log(`GPU Monitor: ${totalGpus} GPUs across ${totalHosts} nodes (inventory-only; live metrics via Prometheus)`);

    // Re-discover GPUs every 5 minutes (in case hardware changes or nodes come online)
    this.discoveryTimer = setInterval(() => this.discoverGpus(true), 300000);
  }

  /** Register a callback for when new hosts come online during periodic re-discovery. */
  onHostOnline(fn) {
    this.onHostOnlineCallbacks.push(fn);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  /**
   * Deploy proxlab-nvtop binary to each GPU host if not already present.
   * Uses base64 transfer via SSH exec to avoid MOTD/SFTP issues.
   */
  async deployNvtop() {
    if (!existsSync(this.nvtopBinaryPath)) {
      console.warn('GPU Monitor: proxlab-nvtop binary not found at', this.nvtopBinaryPath);
      return;
    }
    const binary = readFileSync(this.nvtopBinaryPath);

    await Promise.all(
      Object.entries(this.gpuInventory).map(async ([nodeName, info]) => {
        try {
          // Check if already deployed with correct version
          const { stdout: ver } = await this.sshService.exec(info.ip,
            `${NVTOP_REMOTE_PATH} --version 2>/dev/null || echo MISSING`, { timeout: 5000 });
          if (ver.includes('nvtop version')) {
            this.nvtopAvailable[nodeName] = true;
            return;
          }
          // Deploy: pipe binary through stdin to avoid command-line length limits
          const deployCmd = `mkdir -p /opt/proxlab/bin && cat > ${NVTOP_REMOTE_PATH} && chmod +x ${NVTOP_REMOTE_PATH} && ${NVTOP_REMOTE_PATH} --version 2>/dev/null`;
          const { stdout } = await this.sshService.execWithStdin(info.ip, deployCmd, binary, { timeout: 30000 });
          if (stdout.includes('nvtop version')) {
            this.nvtopAvailable[nodeName] = true;
            console.log(`GPU Monitor: deployed proxlab-nvtop to ${nodeName}`);
          } else {
            this.nvtopAvailable[nodeName] = false;
            console.warn(`GPU Monitor: proxlab-nvtop deploy to ${nodeName} failed — using nvidia-smi fallback`);
          }
        } catch (err) {
          this.nvtopAvailable[nodeName] = false;
          console.warn(`GPU Monitor: deploy to ${nodeName} failed: ${err.message}`);
        }
      })
    );
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    if (Object.keys(this.lastData).length > 0) {
      fn({ type: 'gpu-update', data: this.lastData });
    }
    return () => this.subscribers.delete(fn);
  }

  broadcast(msg) {
    for (const fn of this.subscribers) {
      try { fn(msg); } catch {}
    }
  }

  /**
   * Normalize PCI bus ID to the 4-char domain lowercase format used by PVE.
   * nvidia-smi: "00000000:82:00.0" or "00000000:C7:00.0"
   * PVE API:    "0000:82:00.0" or "0000:c7:00.0"
   */
  static normalizePci(pci) {
    if (!pci) return pci;
    // Strip leading zeros from domain, lowercase
    return pci.replace(/^0+(?=\d{4}:)/, '').toLowerCase().replace(/^(\d+:)?/, (m) => {
      // Ensure 4-char domain prefix
      if (m.length > 5) return '0000:';
      return m || '0000:';
    });
  }

  /**
   * Discover GPUs on all PVE nodes via the hardware/pci API endpoint,
   * then query nvidia-smi for UUIDs on NVIDIA hosts.
   */
  async discoverGpus(isRediscovery = false) {
    if (!this.pveApi?.configured) return;

    try {
      // Get node list with IPs
      const clusterStatus = await this.pveApi.getClusterStatus();
      const nodeEntries = clusterStatus.filter(e => e.type === 'node' && e.online === 1);

      this.nodeIpMap = {};
      for (const entry of nodeEntries) {
        this.nodeIpMap[entry.name] = entry.ip;
      }

      // Track previously known hosts for detecting newly-online hosts
      const previousHosts = new Set(Object.keys(this.gpuInventory));

      // Query PCI devices on each node
      const inventory = {};

      await Promise.all(nodeEntries.map(async (entry) => {
        try {
          const res = await this.pveApi.request(`/nodes/${entry.name}/hardware/pci`);
          const devices = res.data || [];

          // Filter for GPU devices (PCI class 0x03xxxx = display controllers)
          // Exclude ASPEED BMC graphics (server management, not useful for compute)
          const gpuDevices = devices.filter(d => {
            const cls = d.class || '';
            const vendor = (d.vendor_name || '').toUpperCase();
            return cls.startsWith('0x03') && !vendor.includes('ASPEED');
          });

          const nvidiaGpus = gpuDevices.filter(d =>
            (d.vendor_name || '').toUpperCase().includes('NVIDIA')
          );

          const otherGpus = gpuDevices.filter(d =>
            !(d.vendor_name || '').toUpperCase().includes('NVIDIA')
          );

          // Skip nodes with no relevant GPUs (ASPEED-only, etc.)
          if (gpuDevices.length === 0) return;

          inventory[entry.name] = {
            node: entry.name,
            ip: entry.ip,
            allGpus: gpuDevices.map(d => ({
              pciId: d.id,
              vendor: d.vendor_name || 'Unknown',
              device: d.device_name || 'Unknown',
              productName: extractGpuName(d.device_name, d.vendor_name),
              class: d.class || '',
              subsystem: d.subsystem_device_name || '',
              iommugroup: d.iommugroup ?? -1,
            })),
            nvidiaGpus: nvidiaGpus.map(d => d.id),
            otherGpus: otherGpus.map(d => ({
              pciId: d.id,
              vendor: d.vendor_name || 'Unknown',
              device: d.device_name || 'Unknown',
            })),
            uuidMap: {}, // pciId → uuid, populated below for NVIDIA
          };
        } catch {
          // Node may be offline or API unreachable
        }
      }));

      // Query nvidia-smi for UUIDs on NVIDIA hosts
      await Promise.all(Object.entries(inventory).map(async ([nodeName, info]) => {
        if (info.nvidiaGpus.length === 0) return;
        try {
          const { stdout } = await this.sshService.exec(info.ip, NVIDIA_UUID_CMD, { timeout: 10000 });
          const parsedMap = parseNvidiaUuids(stdout);

          // Build legacy uuidMap (pciId → uuid string) for backward compat
          const uuidMap = {};
          for (const [pci, data] of Object.entries(parsedMap)) {
            uuidMap[pci] = data.uuid;
          }
          info.uuidMap = uuidMap;

          // Enrich allGpus with UUID and nvidia-smi index
          for (const gpu of info.allGpus) {
            const data = parsedMap[gpu.pciId];
            if (data) {
              gpu.uuid = data.uuid;
              gpu.smiIndex = data.smiIndex;
            }
          }
        } catch {
          // UUID query failed, PCI-only fallback
        }
      }));

      this.gpuInventory = inventory;

      // On periodic re-discovery: deploy nvtop to newly-found hosts and notify callbacks
      if (isRediscovery) {
        const newHosts = Object.keys(inventory).filter(h => !previousHosts.has(h));
        if (newHosts.length > 0) {
          const totalGpus = Object.values(inventory)
            .reduce((sum, h) => sum + h.allGpus.length, 0);
          console.log(`GPU Monitor: re-discovered ${newHosts.length} new host(s) [${newHosts.join(', ')}] — ${totalGpus} GPUs total`);

          // Deploy nvtop to new hosts
          await this.deployNvtop();

          // Notify listeners (e.g. cache validation)
          for (const cb of (this.onHostOnlineCallbacks || [])) {
            try { cb(newHosts); } catch (err) {
              console.error('GPU Monitor: onHostOnline callback error:', err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error('GPU discovery error:', err.message);
    }
  }

  /**
   * Poll GPU stats on all nodes. Uses proxlab-nvtop where deployed (all vendors),
   * falls back to nvidia-smi + static entries for hosts without it.
   */
  async poll() {
    const results = {};

    await Promise.all(
      Object.entries(this.gpuInventory).map(async ([nodeName, info]) => {
        try {
          if (this.nvtopAvailable[nodeName]) {
            results[nodeName] = await this.pollNvtop(nodeName, info);
          } else if (info.nvidiaGpus.length > 0) {
            results[nodeName] = await this.pollNvidiaSmi(nodeName, info);
          } else if (info.allGpus.length > 0) {
            // No nvtop, no NVIDIA — static entries only
            results[nodeName] = this.buildStaticResult(nodeName, info);
          }
        } catch (err) {
          results[nodeName] = {
            hostId: nodeName, hostName: nodeName, hostIp: info.ip,
            gpus: [], discoveredGpus: info.allGpus,
            timestamp: Date.now(), error: err.message,
          };
        }
      })
    );

    this.lastData = results;
    this.broadcast({ type: 'gpu-update', data: results });
  }

  /**
   * Poll a host using proxlab-nvtop -s (snapshot JSON, all GPU vendors).
   * Parses the JSON output and maps PCI addresses to our inventory.
   */
  async pollNvtop(nodeName, info) {
    const { stdout } = await this.sshService.exec(info.ip, NVTOP_CMD, { timeout: 15000 });

    // Extract JSON after our marker (avoids MOTD contamination)
    const marker = '___NVTOP___';
    const mIdx = stdout.indexOf(marker);
    const jsonStr = mIdx >= 0 ? stdout.slice(mIdx + marker.length).trim() : stdout.trim();

    // proxlab-nvtop outputs "No GPU to monitor" (not JSON) when no GPUs found
    if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) {
      return this.buildStaticResult(nodeName, info);
    }
    const snapshot = JSON.parse(jsonStr);

    const gpus = snapshot.map((entry, i) => {
      // Normalize PCI address to lowercase PVE format
      const pciAddr = entry.pci_addr ? entry.pci_addr.toLowerCase() : null;
      const pciGpu = pciAddr ? info.allGpus.find(g => g.pciId === pciAddr) : null;

      // Parse nvtop string values to numbers
      const gpuUtil = parseNvtopPct(entry.gpu_util);
      const memUtil = parseNvtopPct(entry.mem_util);
      const memUsed = entry.mem_used ? Math.round(parseInt(entry.mem_used, 10) / (1024 * 1024)) : 0; // bytes → MB
      const memTotal = entry.mem_total ? Math.round(parseInt(entry.mem_total, 10) / (1024 * 1024)) : 0;
      const temp = parseNvtopInt(entry.temp);
      const powerDraw = parseNvtopInt(entry.power_draw);
      const encode = parseNvtopPct(entry.encode ?? entry.encode_decode);
      const decode = parseNvtopPct(entry.decode ?? entry.encode_decode);

      const processes = (entry.processes || []).map(proc => ({
        pid: proc.pid,
        cmdline: proc.cmdline || '',
        gpuUtil: parseNvtopPct(proc.gpu_usage),
        memBytes: parseInt(proc.gpu_mem_bytes_alloc, 10) || 0,
        memPct: parseNvtopPct(proc.gpu_mem_usage),
      }));

      return {
        index: i,
        name: entry.device_name || 'Unknown',
        pciId: pciAddr || `unknown-${i}`,
        productName: pciGpu?.productName || entry.device_name || 'Unknown',
        friendlyName: pciAddr ? this.getFriendlyName(nodeName, pciAddr) : null,
        gpuUtil: gpuUtil >= 0 ? gpuUtil : 0,
        memUtil: memUtil >= 0 ? memUtil : 0,
        memUsed,
        memTotal,
        temp: temp >= 0 ? temp : 0,
        powerDraw: powerDraw >= 0 ? powerDraw : 0,
        powerLimit: 0,
        encode,
        decode,
        static: false,
        processes,
      };
    });

    return {
      hostId: nodeName, hostName: nodeName, hostIp: info.ip,
      gpus, discoveredGpus: info.allGpus,
      timestamp: Date.now(), error: null,
    };
  }

  /**
   * Fallback: poll a host using nvidia-smi (NVIDIA GPUs only).
   * Non-NVIDIA GPUs on the same host are added as static entries.
   */
  async pollNvidiaSmi(nodeName, info) {
    const { stdout } = await this.sshService.exec(info.ip, NVIDIA_SMI_CMD, { timeout: 15000 });
    const gpus = parseNvidiaSmi(stdout);

    // Match nvidia-smi index to NVIDIA-only PCI IDs
    for (const gpu of gpus) {
      const nvidiaId = info.nvidiaGpus[gpu.index];
      const pciGpu = nvidiaId ? info.allGpus.find(g => g.pciId === nvidiaId) : null;
      if (pciGpu) {
        gpu.pciId = pciGpu.pciId;
        gpu.productName = pciGpu.productName;
        gpu.friendlyName = this.getFriendlyName(nodeName, pciGpu.pciId);
      }
    }

    // Add non-NVIDIA GPUs as static entries
    const allGpus = [...gpus];
    for (const g of info.otherGpus) {
      allGpus.push({
        index: allGpus.length,
        name: `${g.vendor.split(',')[0]} ${g.device}`,
        pciId: g.pciId,
        productName: extractGpuName(g.device, g.vendor),
        friendlyName: this.getFriendlyName(nodeName, g.pciId),
        gpuUtil: -1, memUtil: -1, memUsed: 0, memTotal: 0,
        temp: -1, powerDraw: 0, powerLimit: 0, static: true, processes: [],
      });
    }

    return {
      hostId: nodeName, hostName: nodeName, hostIp: info.ip,
      gpus: allGpus, discoveredGpus: info.allGpus,
      timestamp: Date.now(), error: null,
    };
  }

  /** Build a static-only result for hosts with no polling tool available */
  buildStaticResult(nodeName, info) {
    return {
      hostId: nodeName, hostName: nodeName, hostIp: info.ip,
      gpus: info.otherGpus.map((g, i) => ({
        index: i,
        name: `${g.vendor.split(',')[0]} ${g.device}`,
        pciId: g.pciId,
        productName: extractGpuName(g.device, g.vendor),
        friendlyName: this.getFriendlyName(nodeName, g.pciId),
        gpuUtil: -1, memUtil: -1, memUsed: 0, memTotal: 0,
        temp: -1, powerDraw: 0, powerLimit: 0, static: true, processes: [],
      })),
      discoveredGpus: info.allGpus,
      timestamp: Date.now(), error: null,
    };
  }

  getLatest() {
    return this.lastData;
  }

  getInventory() {
    return this.gpuInventory;
  }

  /**
   * Get enriched inventory with friendly names for the settings UI.
   */
  getEnrichedInventory() {
    const result = {};
    for (const [nodeName, info] of Object.entries(this.gpuInventory)) {
      result[nodeName] = {
        ...info,
        allGpus: info.allGpus.map(gpu => ({
          ...gpu,
          friendlyName: this.getFriendlyName(nodeName, gpu.pciId) || null,
        })),
      };
    }
    return result;
  }
}

/**
 * Extract a clean GPU marketing name from PVE API device_name.
 * PVE format: "GB206 [GeForce RTX 5060 Ti]" → "GeForce RTX 5060 Ti"
 * Also handles: "DG2 [Arc A380]" → "Arc A380", "GV100GL [Tesla V100S PCIe 32GB]" → "Tesla V100S PCIe 32GB"
 */
function extractGpuName(deviceName, vendorName) {
  if (!deviceName) return 'Unknown GPU';
  const match = deviceName.match(/\[(.+?)\]/);
  if (match) return match[1];
  // No brackets — strip chip codenames and clean up
  return deviceName
    .replace(/Corporation\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Unknown GPU';
}

function parseNvidiaSmi(output) {
  if (!output?.trim()) return [];

  return output.trim().split('\n').map((line) => {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 9) return null;
    // Skip non-data lines (MOTD, etc)
    if (isNaN(parseInt(parts[0], 10))) return null;

    return {
      index: parseInt(parts[0], 10),
      name: parts[1],
      gpuUtil: parseFloat(parts[2]) || 0,
      memUtil: parseFloat(parts[3]) || 0,
      memUsed: parseInt(parts[4], 10) || 0,
      memTotal: parseInt(parts[5], 10) || 0,
      temp: parseInt(parts[6], 10) || 0,
      powerDraw: parseFloat(parts[7]) || 0,
      powerLimit: parseFloat(parts[8]) || 0,
      processes: [],
    };
  }).filter(Boolean);
}

/** Parse nvtop percentage string (e.g. "85%") to integer, or -1 if null/invalid */
function parseNvtopPct(val) {
  if (val == null) return -1;
  const n = parseInt(val, 10);
  return isNaN(n) ? -1 : n;
}

/** Parse nvtop integer string with unit suffix (e.g. "65C", "250W") to integer, or -1 */
function parseNvtopInt(val) {
  if (val == null) return -1;
  const n = parseInt(val, 10);
  return isNaN(n) ? -1 : n;
}

/**
 * Parse nvidia-smi UUID output (index, uuid, pci.bus_id, name).
 * Returns { normalizedPciId: { uuid, smiIndex } } map.
 */
function parseNvidiaUuids(output) {
  if (!output?.trim()) return {};

  const map = {};
  for (const line of output.trim().split('\n')) {
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 4) continue;
    const smiIndex = parseInt(parts[0], 10);
    if (isNaN(smiIndex)) continue;

    const uuid = parts[1]; // e.g. "GPU-a33cd194-..."
    const rawPci = parts[2]; // e.g. "00000000:82:00.0"

    if (!uuid?.startsWith('GPU-') || !rawPci) continue;

    // Normalize nvidia-smi PCI format to PVE format
    // 00000000:82:00.0 → 0000:82:00.0, uppercase → lowercase
    const normalizedPci = rawPci
      .replace(/^0{8}:/, '0000:')
      .toLowerCase();

    map[normalizedPci] = { uuid, smiIndex };
  }
  return map;
}
