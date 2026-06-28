/**
 * gpu-placer.js — GPU Placement Solver
 *
 * Given a VRAM requirement and a list of available GPUs, returns ranked
 * placement options. Prefers:
 *   1. Single GPU with enough VRAM (least waste)
 *   2. Multi-GPU on same node, same NVLink group
 *   3. Multi-GPU on same node, mixed NVLink (PCIe interconnect)
 *   4. Multi-GPU across nodes (worst: network overhead)
 *
 * Multi-GPU VRAM estimation uses sequential layer packing to model how
 * inference engines (ExLlamaV2, llama.cpp) actually distribute layers.
 * Auto-split fills each GPU to capacity before moving to the next, so
 * earlier GPUs get packed tight while later ones may be mostly empty.
 * This is more conservative than even-split but matches real behavior.
 *
 * @module gpu-placer
 */

import { estimateVram, CUDA_CONTEXT_PER_GPU_MB, inferenceBufferMB } from './vram-calc.js';
import { areInSameNvlinkGroup, getNvlinkGroups } from './gpu-specs.js';

// Per-GPU compute overhead that scales with model size (MiB).
// Single GPU: full inference buffer + CUDA context.
// Multi-GPU: distribute buffer across GPUs with 30% margin for primary GPU imbalance.
function computeBufferPerGpu(params, numGpus) {
  const totalBuf = inferenceBufferMB(params);
  if (!numGpus || numGpus <= 1) return CUDA_CONTEXT_PER_GPU_MB + totalBuf;
  const perGpu = Math.round(totalBuf / numGpus * 1.3);
  return CUDA_CONTEXT_PER_GPU_MB + Math.min(perGpu, totalBuf);
}

// Score weights
const SCORE_SINGLE_GPU_BONUS  = 100;  // strongly prefer single GPU
const SCORE_NVLINK_BONUS      = 40;   // prefer NVLink-connected GPUs
const SCORE_SAME_NODE_BONUS   = 20;   // prefer same-node over cross-node
const SCORE_VRAM_FIT_WEIGHT   = 10;   // reward tighter fit (less waste)
const SCORE_PERF_WEIGHT       = 5;    // reward faster GPUs
const SCORE_NVIDIA_BONUS      = 15;   // prefer NVIDIA (best inference support)

// Headroom risk thresholds (MiB)
export const HEADROOM_TIGHT_BELOW = 1024;   // < 1 GiB = high OOM risk
export const HEADROOM_SAFE_BELOW  = 4096;   // 1-4 GiB = comfortable

export function headroomRisk(headroomMB, type) {
  if (type === 'single') return null;          // single GPU = always optimal
  if (headroomMB < HEADROOM_TIGHT_BELOW) return 'tight';
  if (headroomMB < HEADROOM_SAFE_BELOW)  return 'safe';
  return 'spacious';
}

/**
 * Find all viable GPU placement options for a given VRAM requirement.
 *
 * @param {Object} opts
 * @param {number} opts.requiredMB     - Total VRAM needed (from vram-calc)
 * @param {number} opts.weightsMB      - Weight portion of VRAM
 * @param {number} opts.kvCacheMB      - KV cache portion of VRAM
 * @param {Array}  opts.availableGpus  - GPU list from getClusterGpus(), each must have:
 *                                       { node, pciId, vramMB, spec, friendlyName, configKey }
 * @param {Object} [opts.modelOpts]    - Original model options (for re-estimating per-GPU VRAM)
 * @param {number} [opts.maxGpus=8]    - Max GPUs to consider in a single placement
 * @returns {Array<Object>} Ranked placement options, best first
 */
export function findPlacements(opts) {
  const {
    requiredMB,
    weightsMB,
    kvCacheMB,
    availableGpus,
    modelOpts,
    maxGpus = 8,
  } = opts;

  // Filter to NVIDIA GPUs only for now (CUDA inference)
  // Intel Arc can't run llama.cpp/vLLM without special builds
  const nvidiaGpus = availableGpus.filter(g => g.provider === 'nvidia' && g.vramMB > 0);

  if (nvidiaGpus.length === 0) return [];

  const placements = [];

  // --- 1. Single-GPU options ---
  for (const gpu of nvidiaGpus) {
    const gpuAvail = gpu.availableVramMB ?? gpu.vramMB;
    if (gpuAvail >= requiredMB) {
      const wasteRatio = (gpuAvail - requiredMB) / gpuAvail;
      const perfScore = (gpu.spec?.fp16TFLOPS || 10) / 100;

      let score = SCORE_SINGLE_GPU_BONUS;
      score += SCORE_VRAM_FIT_WEIGHT * (1 - wasteRatio);   // tighter fit = better
      score += SCORE_PERF_WEIGHT * perfScore;               // faster GPU = better
      score += SCORE_NVIDIA_BONUS;

      const mixedPlacement = (gpu.liveUsedMB || 0) > 500;
      placements.push({
        type: 'single',
        gpus: [gpu],
        node: gpu.node,
        totalVramMB: gpu.vramMB,
        availableVramMB: gpuAvail,
        requiredMB,
        headroomMB: gpuAvail - requiredMB,
        gpuCount: 1,
        riskLabel: null,
        score: Math.round(score * 10) / 10,
        nvlink: false,
        mixedPlacement,
        notes: `Single GPU — no parallelism overhead`,
      });
    }
  }

  // --- 2. Multi-GPU options (same node) ---
  // Group GPUs by node
  const byNode = {};
  for (const gpu of nvidiaGpus) {
    if (!byNode[gpu.node]) byNode[gpu.node] = [];
    byNode[gpu.node].push(gpu);
  }

  // Resolve layer count for sequential packing simulation
  const numLayers = resolveLayerCount(modelOpts);

  for (const [node, nodeGpus] of Object.entries(byNode)) {
    if (nodeGpus.length < 2) continue;

    // Try combinations of 2..maxGpus GPUs on this node
    const combos = getCombinations(nodeGpus, Math.min(maxGpus, nodeGpus.length));

    for (const combo of combos) {
      if (combo.length < 2) continue;

      // Simulate sequential layer packing (models ExLlamaV2/llama.cpp auto-split)
      const modelParams = modelOpts?.params || 7;
      const packing = simulateLayerPacking(combo, weightsMB, kvCacheMB, numLayers, modelParams);
      if (!packing.fits) continue;

      const pciIds = combo.map(g => g.pciId);
      const nvlink = areInSameNvlinkGroup(node, pciIds);
      const totalVramMB = combo.reduce((s, g) => s + g.vramMB, 0);
      const totalAvailMB = combo.reduce((s, g) => s + (g.availableVramMB ?? g.vramMB), 0);

      // Even-split headroom: what TP engines (vLLM, SGLang, LMDeploy) actually use.
      // Each GPU gets an equal share of weights + KV cache, plus its own compute buffer.
      const cbPerGpu = computeBufferPerGpu(modelParams, combo.length);
      const perGpuLoadEvenSplit = (weightsMB + kvCacheMB) / combo.length + cbPerGpu;
      const smallestGpuAvailMB = Math.min(...combo.map(g => g.availableVramMB ?? g.vramMB));
      const evenSplitHeadroomMB = Math.floor(smallestGpuAvailMB - perGpuLoadEvenSplit);

      // Proportional split: distribute load proportional to usable VRAM per GPU
      // This models how KoboldCpp/TabbyAPI tensor_split/gpu-split actually works
      const usablePerGpu = combo.map(g => {
        const avail = g.availableVramMB ?? g.vramMB;
        return Math.max(0, avail - cbPerGpu);
      });
      const totalUsable = usablePerGpu.reduce((a, b) => a + b, 0);
      const modelPayload = weightsMB + kvCacheMB;

      let proportionalHeadroomMB;
      if (totalUsable <= 0 || totalUsable < modelPayload) {
        proportionalHeadroomMB = Math.floor(totalUsable - modelPayload);
      } else {
        let minH = Infinity;
        for (let i = 0; i < combo.length; i++) {
          const gpuAvail = combo[i].availableVramMB ?? combo[i].vramMB;
          const load = modelPayload * (usablePerGpu[i] / totalUsable) + cbPerGpu;
          minH = Math.min(minH, gpuAvail - load);
        }
        proportionalHeadroomMB = Math.floor(minH);
      }

      const avgPerf = combo.reduce((s, g) => s + (g.spec?.fp16TFLOPS || 10), 0) / combo.length;
      const perfScore = avgPerf / 100;
      const wasteRatio = Math.max(0, evenSplitHeadroomMB) / smallestGpuAvailMB;

      let score = 0;
      score += nvlink ? SCORE_NVLINK_BONUS : 0;
      score += SCORE_SAME_NODE_BONUS;
      score += SCORE_VRAM_FIT_WEIGHT * (1 - wasteRatio);
      score += SCORE_PERF_WEIGHT * perfScore;
      score += SCORE_NVIDIA_BONUS;
      // Penalize more GPUs (communication overhead)
      score -= (combo.length - 1) * 3;

      const mixedPlacement = combo.some(g => (g.liveUsedMB || 0) > 500);
      const interconnect = nvlink ? 'NVLink' : 'PCIe';
      const activeCount = packing.gpuLoads.filter(g => g.layerCount > 0).length;
      placements.push({
        type: 'multi-gpu',
        gpus: combo,
        node,
        totalVramMB,
        availableVramMB: totalAvailMB,
        requiredMB,
        perGpuRequiredMB: Math.ceil(perGpuLoadEvenSplit),
        headroomMB: evenSplitHeadroomMB,
        proportionalHeadroomMB,
        splitRatios: usablePerGpu,
        gpuCount: combo.length,
        riskLabel: headroomRisk(evenSplitHeadroomMB, 'multi-gpu'),
        score: Math.round(score * 10) / 10,
        nvlink,
        mixedPlacement,
        notes: activeCount < combo.length
          ? `${combo.length} GPUs assigned, ${activeCount} active (pipeline parallel via ${interconnect})`
          : `${combo.length}-GPU split via ${interconnect}`,
      });
    }
  }

  // --- 3. Cross-node options (worst case, only if no single-node option works) ---
  // Skip for now — cross-node tensor parallelism over network is rarely practical
  // for home labs. Can add later if needed.

  // Sort by score descending
  placements.sort((a, b) => b.score - a.score);

  return deduplicatePlacements(placements);
}

/**
 * Deduplicate placements by (node, gpuCount) for multi-GPU,
 * or (node, friendlyName) for single-GPU. Since placements are
 * already sorted by score, first-seen per key = best-scored.
 */
function deduplicatePlacements(placements) {
  const seen = new Set();
  const deduped = [];
  for (const p of placements) {
    const mixedTag = p.mixedPlacement ? 'mixed' : 'fresh';
    const key = p.type === 'single'
      ? `${p.node}:single:${p.gpus[0]?.friendlyName || 'gpu'}:${mixedTag}`
      : `${p.node}:${p.gpuCount}:${mixedTag}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(p);
    }
  }
  return deduped;
}

/**
 * Resolve the number of transformer layers from model options.
 * Uses provided layers if available, otherwise estimates from param count
 * using the same heuristic as vram-calc.js.
 */
function resolveLayerCount(modelOpts) {
  if (modelOpts?.layers) return modelOpts.layers;
  const params = modelOpts?.params || 7;
  if      (params <= 3)   return 26;
  else if (params <= 8)   return 32;
  else if (params <= 14)  return 40;
  else if (params <= 27)  return 48;
  else if (params <= 35)  return 64;
  else if (params <= 72)  return 80;
  else if (params <= 140) return 88;
  else                    return 96;
}

/**
 * Simulate sequential layer packing across GPUs.
 *
 * Models how ExLlamaV2 / llama.cpp auto-split actually distributes layers:
 * fill each GPU to capacity (minus compute buffer) before moving to the next.
 * Earlier GPUs get packed tight, later ones may be mostly empty or unused.
 *
 * This is more conservative than even-split but matches real-world behavior.
 * If a model fits under this model, it will also fit with tensor-parallel
 * (even split), so it's safe for all backends.
 *
 * @param {Array}  gpus       - GPU objects with vramMB
 * @param {number} weightsMB  - Total model weight VRAM
 * @param {number} kvCacheMB  - Total KV cache VRAM
 * @param {number} layers     - Number of transformer layers
 * @param {number} [params=7] - Model params in billions (for scaling compute buffer)
 * @returns {Object} { fits, gpuLoads[], worstGpuMB, headroomMB }
 */
function simulateLayerPacking(gpus, weightsMB, kvCacheMB, layers, params = 7) {
  const perLayerWeightMB = weightsMB / layers;
  const perLayerKvMB = kvCacheMB / layers;
  const perLayerMB = perLayerWeightMB + perLayerKvMB;
  const cbPerGpu = computeBufferPerGpu(params, gpus.length);

  let layersRemaining = layers;
  const gpuLoads = [];

  for (const gpu of gpus) {
    if (layersRemaining <= 0) {
      gpuLoads.push({ layerCount: 0, loadMB: 0 });
      continue;
    }

    // Reserve compute buffer on any GPU that will hold layers
    const gpuCapacity = gpu.availableVramMB ?? gpu.vramMB;
    const availableForLayers = gpuCapacity - cbPerGpu;
    if (availableForLayers <= 0) {
      gpuLoads.push({ layerCount: 0, loadMB: 0 });
      continue;
    }

    const maxLayersFit = Math.floor(availableForLayers / perLayerMB);
    const assigned = Math.min(maxLayersFit, layersRemaining);
    const loadMB = assigned * perLayerMB + cbPerGpu;

    gpuLoads.push({ layerCount: assigned, loadMB: Math.ceil(loadMB) });
    layersRemaining -= assigned;
  }

  if (layersRemaining > 0) {
    return { fits: false, gpuLoads, worstGpuMB: Infinity, headroomMB: -1 };
  }

  // Headroom = minimum free VRAM across active GPUs (ones with layers).
  // This is the bottleneck — the tightest GPU determines if inference will OOM.
  let minHeadroom = Infinity;
  let worstGpuMB = 0;
  for (let i = 0; i < gpus.length; i++) {
    if (gpuLoads[i].layerCount > 0) {
      const headroom = (gpus[i].availableVramMB ?? gpus[i].vramMB) - gpuLoads[i].loadMB;
      if (headroom < minHeadroom) minHeadroom = headroom;
      if (gpuLoads[i].loadMB > worstGpuMB) worstGpuMB = gpuLoads[i].loadMB;
    }
  }

  return {
    fits: true,
    gpuLoads,
    worstGpuMB: Math.ceil(worstGpuMB),
    headroomMB: Math.floor(minHeadroom),
  };
}

/**
 * Generate all combinations of size 2..maxSize from the input array.
 * Returns array of arrays. Limited to reasonable sizes to avoid explosion.
 */
function getCombinations(arr, maxSize) {
  const results = [];

  function combine(start, current) {
    if (current.length >= 2) {
      results.push([...current]);
    }
    if (current.length >= maxSize) return;
    // Limit total combinations to prevent slow computation
    if (results.length > 200) return;

    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      combine(i + 1, current);
      current.pop();
    }
  }

  combine(0, []);
  return results;
}

/**
 * Convenience: estimate VRAM and find placements in one call.
 *
 * @param {Object} modelOpts - Options for estimateVram (params, quant, contextSize, etc.)
 * @param {Array}  availableGpus - From getClusterGpus()
 * @returns {Object} { estimate, placements }
 */
export function estimateAndPlace(modelOpts, availableGpus) {
  const estimate = estimateVram(modelOpts);
  const placements = findPlacements({
    requiredMB: estimate.totalMB,
    weightsMB: estimate.weightsMB,
    kvCacheMB: estimate.kvCacheMB,
    availableGpus,
    modelOpts,
  });
  return { estimate, placements };
}
