/**
 * gpu-specs.js — GPU Hardware Specs & Cluster Topology
 *
 * Provides GPU specifications and interconnect topology for the AI placement
 * engine. Currently hardcoded for the local cluster — designed so each section
 * can be replaced with auto-discovery functions later.
 *
 * Interface contract (keep stable when swapping in auto-discovery):
 *   getGpuSpec(modelName)          → spec object or null
 *   getClusterGpus(inventory, gpuConfig, aiConfig) → enriched GPU list
 *   getNvlinkGroups(node)          → array of PCI ID arrays
 *
 * @module gpu-specs
 */

// ─── GPU Model Specs Database ────────────────────────────────────────────────
// Hardcoded for cluster GPUs. Replace with auto-discovery later.
//
// Each entry's `matchPatterns` is the authoritative list of strings to match
// against nvidia-smi's productName (and, as a fallback, the user's free-form
// friendlyName from settings). The key is purely descriptive for humans
// reading this file — it does NOT participate in matching, so renaming keys
// or friendly names won't break recognition. When multiple specs share a
// matchPattern (e.g. 8GB vs 16GB SKUs of the same model), the matcher uses
// live nvidia-smi memTotal as a tiebreaker.

const GPU_MODELS = {
  'V100 SXM2 32GB': {
    model:          'Tesla V100 SXM2 32GB',
    matchPatterns:  ['V100 SXM2', 'V100-SXM2', 'V100'],
    arch:           'Volta',
    vramMB:         32768,
    busWidth:       4096,          // HBM2, 4096-bit
    memBandwidthGBs: 900,
    fp16TFLOPS:     31.4,
    fp32TFLOPS:     15.7,
    nvlink:         true,
    nvlinkBandwidthGBs: 300,      // 6 links × 50 GB/s bidirectional
    cudaCores:      5120,
    tensorCores:    640,
    smCount:        80,
    generation:     'datacenter',
    provider:       'nvidia',
    // V100 quirks relevant to LLM inference
    notes:          'No FP8, no BF16. Use FP16. No FlashAttention2 (Triton fallback).',
  },

  'RTX 4090': {
    model:          'GeForce RTX 4090',
    matchPatterns:  ['RTX 4090'],
    arch:           'Ada Lovelace',
    vramMB:         24576,
    busWidth:       384,           // GDDR6X
    memBandwidthGBs: 1008,
    fp16TFLOPS:     82.6,
    fp32TFLOPS:     82.6,
    nvlink:         false,
    nvlinkBandwidthGBs: 0,
    cudaCores:      16384,
    tensorCores:    512,
    smCount:        128,
    generation:     'consumer',
    provider:       'nvidia',
    notes:          'Fastest single-GPU consumer card. No NVLink.',
  },

  'RTX 5060 Ti 16GB': {
    model:          'GeForce RTX 5060 Ti 16GB',
    matchPatterns:  ['RTX 5060 Ti', 'RTX 5060Ti'],
    arch:           'Blackwell',
    vramMB:         16384,
    busWidth:       128,           // GDDR7
    memBandwidthGBs: 512,         // estimated
    fp16TFLOPS:     45.0,         // estimated
    fp32TFLOPS:     22.5,         // estimated
    nvlink:         false,
    nvlinkBandwidthGBs: 0,
    cudaCores:      4608,
    tensorCores:    144,
    smCount:        36,
    generation:     'consumer',
    provider:       'nvidia',
    notes:          'Blackwell consumer. Good VRAM density for size.',
  },

  'Arc A380': {
    model:          'Intel Arc A380',
    matchPatterns:  ['Arc A380'],
    arch:           'Alchemist (Xe-HPG)',
    vramMB:         6144,
    busWidth:       96,            // GDDR6
    memBandwidthGBs: 186,
    fp16TFLOPS:     4.9,
    fp32TFLOPS:     4.9,
    nvlink:         false,
    nvlinkBandwidthGBs: 0,
    cudaCores:      0,
    tensorCores:    0,
    smCount:        0,
    generation:     'consumer',
    provider:       'intel',
    notes:          'Intel Arc. Limited LLM inference support (SYCL/oneAPI).',
  },

  'Arc A310': {
    model:          'Intel Arc A310',
    matchPatterns:  ['Arc A310'],
    arch:           'Alchemist (Xe-HPG)',
    vramMB:         4096,
    busWidth:       64,            // GDDR6
    memBandwidthGBs: 124,
    fp16TFLOPS:     3.5,
    fp32TFLOPS:     3.5,
    nvlink:         false,
    nvlinkBandwidthGBs: 0,
    cudaCores:      0,
    tensorCores:    0,
    smCount:        0,
    generation:     'consumer',
    provider:       'intel',
    notes:          'Intel Arc. Very limited VRAM for LLM inference.',
  },
};

// ─── NVLink Topology ─────────────────────────────────────────────────────────
// Hardcoded from `nvidia-smi topo -m`. Replace with auto-discovery later.
// Each group is a set of GPUs connected via NVLink to each other.
// GPUs across groups communicate via PCIe only.

const NVLINK_TOPOLOGY = {
  'px-gpu': {
    // GPU0-3 (8A-8D): NV1/NV2 mesh within group
    // GPU4-7 (B3-B6): NV1/NV2 mesh within group
    // Cross-group: PCIe only (NODE)
    groups: [
      ['0000:8a:00.0', '0000:8b:00.0', '0000:8c:00.0', '0000:8d:00.0'],
      ['0000:b3:00.0', '0000:b4:00.0', '0000:b5:00.0', '0000:b6:00.0'],
    ],
    // Full peer matrix from nvidia-smi topo -m
    // NV1 = 1 NVLink, NV2 = 2 NVLinks, null = PCIe only
    peerLinks: {
      '0000:8a:00.0': { '0000:8b:00.0': 2, '0000:8c:00.0': 2, '0000:8d:00.0': 1, '0000:b3:00.0': 1 },
      '0000:8b:00.0': { '0000:8a:00.0': 2, '0000:8c:00.0': 1, '0000:8d:00.0': 1, '0000:b4:00.0': 2 },
      '0000:8c:00.0': { '0000:8a:00.0': 2, '0000:8b:00.0': 1, '0000:8d:00.0': 2, '0000:b5:00.0': 1 },
      '0000:8d:00.0': { '0000:8a:00.0': 1, '0000:8b:00.0': 1, '0000:8c:00.0': 2, '0000:b6:00.0': 2 },
      '0000:b3:00.0': { '0000:8a:00.0': 1, '0000:b4:00.0': 2, '0000:b5:00.0': 2, '0000:b6:00.0': 1 },
      '0000:b4:00.0': { '0000:8b:00.0': 2, '0000:b3:00.0': 2, '0000:b5:00.0': 1, '0000:b6:00.0': 1 },
      '0000:b5:00.0': { '0000:8c:00.0': 1, '0000:b3:00.0': 2, '0000:b4:00.0': 1, '0000:b6:00.0': 2 },
      '0000:b6:00.0': { '0000:8d:00.0': 2, '0000:b3:00.0': 1, '0000:b4:00.0': 1, '0000:b5:00.0': 2 },
    },
  },
};

// ─── Matching helpers ────────────────────────────────────────────────────────

/**
 * Match a GPU's name/description to a spec entry.
 * Tries friendlyName first, then productName, then raw device string.
 * Returns the first match or null.
 */
/** Normalize GPU name for fuzzy matching — collapse spaces, strip # suffixes */
function normalizeGpuName(s) {
  return s.toUpperCase().replace(/\s+/g, ' ').replace(/#\d+$/, '').trim();
}

/**
 * Match a GPU's reported names to a spec entry.
 *
 * Source-of-truth chain:
 *   1. nvidia-smi `productName` is the canonical hardware identifier and the
 *      primary signal — it doesn't change when the user renames anything.
 *   2. `friendlyName` (from proxlab settings) is free-form display text and
 *      checked as a fallback for cases where productName is missing.
 *   3. `deviceName` (raw device string) is a last-resort fallback.
 *
 * Each spec entry's `matchPatterns` array lists the strings that identify it
 * — typically a bare model name (e.g. "RTX 5060 Ti") that appears in any
 * reasonable nvidia-smi or user-typed string. The spec key is purely
 * descriptive and does NOT participate in matching, so the database is
 * decoupled from how operators label their GPUs.
 *
 * When multiple specs match (e.g. 8GB vs 16GB SKUs sharing "RTX 5060 Ti"),
 * `liveVramMB` (typically gpu.memTotal from nvidia-smi) breaks the tie by
 * picking the spec whose vramMB is numerically closest to the live total.
 */
function matchGpuSpec(friendlyName, productName, deviceName, liveVramMB) {
  // Order: productName first (canonical), then friendlyName (user-set),
  // then deviceName (raw). This keeps matching robust against renamed
  // friendly labels.
  const candidates = [productName, friendlyName, deviceName].filter(Boolean);

  for (const name of candidates) {
    const norm = normalizeGpuName(name);
    const normNoSpace = norm.replace(/ /g, '');
    const matches = [];
    for (const spec of Object.values(GPU_MODELS)) {
      const patterns = Array.isArray(spec.matchPatterns) && spec.matchPatterns.length > 0
        ? spec.matchPatterns
        : [spec.model || ''];
      for (const p of patterns) {
        const np = normalizeGpuName(p);
        if (norm.includes(np) || normNoSpace.includes(np.replace(/ /g, ''))) {
          matches.push(spec);
          break;
        }
      }
    }
    if (matches.length === 0) continue;
    if (matches.length === 1) return matches[0];
    if (typeof liveVramMB === 'number' && liveVramMB > 0) {
      return matches.reduce((best, cur) =>
        Math.abs((cur.vramMB || 0) - liveVramMB) < Math.abs((best.vramMB || 0) - liveVramMB)
          ? cur
          : best,
      );
    }
    return matches[0];
  }
  return null;
}

// ─── Public Interface ────────────────────────────────────────────────────────

/**
 * Get spec for a GPU model by name substring match.
 * @param {string} name - GPU name to search (friendlyName, productName, etc.)
 * @returns {Object|null} GPU spec object or null
 */
export function getGpuSpec(name) {
  if (!name) return null;
  return matchGpuSpec(name);
}

/**
 * Get all GPU models in the specs database.
 * @returns {Object} Map of model key → spec
 */
export function getAllGpuSpecs() {
  return { ...GPU_MODELS };
}

/**
 * Build an enriched list of AI-pool-eligible GPUs from inventory + config.
 * Each entry includes: node, pciId, configKey, friendlyName, spec, poolMode.
 *
 * @param {Object} inventory - GPU inventory from gpuMonitor.getEnrichedInventory()
 * @param {Object} gpuConfig - GPU config (friendly names) from gpu-config.json
 * @param {Object} aiConfig  - AI config from ai-config.json
 * @returns {Array<Object>} Enriched GPU list
 */
export function getClusterGpus(inventory, gpuConfig, aiConfig, vramUsage = null) {
  const pools = aiConfig?.pools || {};
  const gpus = [];

  for (const [nodeName, info] of Object.entries(inventory || {})) {
    for (const gpu of (info.allGpus || [])) {
      const configKey = `${nodeName}:${gpu.pciId}`;
      const cfg = gpuConfig?.[configKey] || {};
      const friendlyName = cfg.friendlyName || gpu.productName || gpu.device || 'Unknown';
      const spec = matchGpuSpec(cfg.friendlyName, gpu.productName, gpu.device, gpu.memTotal);
      const poolMode = pools[configKey]?.mode || null;

      const totalVram = spec?.vramMB || 0;
      const usage = vramUsage?.get(`${nodeName}:${gpu.pciId}`);

      gpus.push({
        node: nodeName,
        pciId: gpu.pciId,
        configKey,
        friendlyName,
        spec,
        poolMode,
        vramMB: totalVram,
        availableVramMB: usage ? usage.availableMB : totalVram,
        liveUsedMB: usage?.liveUsedMB || 0,
        reservedMB: usage?.reservedMB || 0,
        provider: spec?.provider || 'unknown',
      });
    }
  }

  return gpus;
}

/**
 * Get NVLink groups for a node.
 * @param {string} node - PVE node name
 * @returns {Array<Array<string>>} Array of PCI ID groups, or empty array
 */
export function getNvlinkGroups(node) {
  return NVLINK_TOPOLOGY[node]?.groups || [];
}

/**
 * Get NVLink peer link count between two GPUs on a node.
 * @param {string} node - PVE node name
 * @param {string} pciA - PCI ID of first GPU
 * @param {string} pciB - PCI ID of second GPU
 * @returns {number} Number of NVLink connections (0 = PCIe only)
 */
export function getNvlinkPeerCount(node, pciA, pciB) {
  return NVLINK_TOPOLOGY[node]?.peerLinks?.[pciA]?.[pciB] || 0;
}

/**
 * Compute per-GPU VRAM usage from live metrics + active service reservations.
 *
 * @param {Object} gpuMetrics   - From gpuMonitor.getLatest(): { node: { gpus: [{ pciId, memUsed, memTotal }] } }
 * @param {Object} activeServices - From loadActiveServices(): { services: { id: { gpuPciIds, reservedVramMB, ... } } }
 * @param {Object} gpuSpecLookup - Map of configKey → { vramMB } for GPU total VRAM lookup
 * @returns {Map<string, Object>} Map of "node:pciId" → { liveUsedMB, reservedMB, effectiveUsedMB, availableMB, totalMB }
 */
export function getGpuVramUsage(gpuMetrics, activeServices, gpuSpecLookup) {
  const usage = new Map();

  // Pass 1: Populate from live nvidia-smi / nvtop data
  for (const [nodeName, nodeData] of Object.entries(gpuMetrics || {})) {
    for (const gpu of (nodeData.gpus || [])) {
      const key = `${nodeName}:${gpu.pciId}`;
      const specTotal = gpuSpecLookup[key]?.vramMB || gpu.memTotal || 0;
      usage.set(key, {
        liveUsedMB: gpu.memUsed || 0,
        reservedMB: 0,
        effectiveUsedMB: 0,
        availableMB: specTotal,
        totalMB: specTotal,
      });
    }
  }

  // Pass 2: Sum service reservations per GPU
  const services = activeServices?.services || {};
  for (const svc of Object.values(services)) {
    const pciIds = svc.gpuPciIds;
    if (!pciIds?.length) continue;

    for (const pciId of pciIds) {
      // Find the usage entry for this PCI ID (search all nodes)
      let entry = null;
      for (const [key, val] of usage) {
        if (key.endsWith(`:${pciId}`)) { entry = val; break; }
      }
      if (!entry) continue;

      if (svc.reservedVramMB === null || svc.reservedVramMB === undefined) {
        // Static LLM: use live memUsed as the reservation (trust nvidia-smi)
        entry.reservedMB = Math.max(entry.reservedMB, entry.liveUsedMB);
      } else if (svc.reservedVramMB === -1) {
        // Dynamic (Ollama): reserve full GPU VRAM
        entry.reservedMB = entry.totalMB;
      } else {
        // Fixed reservation (TTS/STT): additive
        entry.reservedMB += svc.reservedVramMB;
      }
    }
  }

  // Pass 3: Compute effective usage and available VRAM
  for (const entry of usage.values()) {
    entry.effectiveUsedMB = Math.max(entry.liveUsedMB, entry.reservedMB);
    entry.availableMB = Math.max(0, entry.totalMB - entry.effectiveUsedMB);
  }

  return usage;
}

/**
 * Check if a set of GPUs are all in the same NVLink group.
 * @param {string} node - PVE node name
 * @param {string[]} pciIds - Array of PCI IDs
 * @returns {boolean}
 */
export function areInSameNvlinkGroup(node, pciIds) {
  const groups = getNvlinkGroups(node);
  if (groups.length === 0 || pciIds.length <= 1) return false;
  return groups.some(group => pciIds.every(id => group.includes(id)));
}
