/**
 * vram-calc.js — VRAM Requirement Estimator
 *
 * Estimates VRAM needed to run an LLM model with a given quantization and
 * context size. Provides model presets for popular architectures so users
 * don't need to know layer/head counts.
 *
 * Estimation formula:
 *   weightVram  = totalParams × bitsPerWeight / 8
 *   kvCacheVram = layers × 2 × kvHeads × headDim × contextSize × kvBytes
 *   overhead    = CUDA context (~300MB) + activation buffer (~5-10%)
 *   totalVram   = weightVram + kvCacheVram + overhead
 *
 * For multi-GPU: see gpu-placer.js which simulates sequential layer packing.
 *
 * @module vram-calc
 */

// ─── Quantization Formats ────────────────────────────────────────────────────
// Bits per weight — approximate averages from llama.cpp measurements.
// These vary slightly by model architecture but are close enough for planning.

const QUANT_BPW = {
  // Full precision
  'FP16':     16.0,
  'BF16':     16.0,
  'F16':      16.0,
  'FP32':     32.0,
  // 8-bit
  'Q8_0':      8.5,
  'Q8_K':      8.5,
  'Q8_K_XL':   8.5,
  // 6-bit
  'Q6_K':      6.57,
  'Q6_K_L':    6.57,
  'Q6_K_XL':   6.57,
  // 5-bit
  'Q5_K_M':    5.69,
  'Q5_K_S':    5.54,
  'Q5_K_L':    5.69,
  'Q5_K_XL':   5.69,
  // 4-bit
  'Q4_K_M':    4.85,
  'Q4_K_S':    4.58,
  'Q4_K_L':    4.85,
  'Q4_K_XL':   4.85,
  'Q4_0':      4.5,
  'Q4_1':      5.0,
  // 3-bit
  'Q3_K_M':    3.91,
  'Q3_K_S':    3.50,
  'Q3_K_L':    3.91,
  // 2-bit
  'Q2_K':      3.35,
  'Q2_K_L':    3.35,
  'Q2_K_S':    2.96,
  'Q2_K_XS':   2.40,
  // IQuants (importance-matrix quants)
  'IQ4_XS':    4.25,
  'IQ4_NL':    4.50,
  'IQ3_M':     3.44,
  'IQ3_S':     3.25,
  'IQ3_XS':    3.13,
  'IQ3_XXS':   3.06,
  'IQ2_M':     2.70,
  'IQ2_S':     2.50,
  'IQ2_XS':    2.31,
  'IQ2_XXS':   2.06,
  'IQ1_M':     1.75,
  'IQ1_S':     1.56,
};

// ─── Model Architecture Presets ──────────────────────────────────────────────
// Architecture details needed for accurate KV cache estimation.
// params = total params in billions (for weight VRAM calculation).
// For MoE models, totalParams is the full model size (all experts loaded).

const MODEL_PRESETS = {
  // --- Llama family ---
  'Llama 3 8B': {
    params: 8.03, layers: 32, kvHeads: 8, headDim: 128,
    hiddenSize: 4096, intermediateSize: 14336,
    isMoE: false, category: 'Llama',
  },
  'Llama 3 70B': {
    params: 70.6, layers: 80, kvHeads: 8, headDim: 128,
    hiddenSize: 8192, intermediateSize: 28672,
    isMoE: false, category: 'Llama',
  },
  'Llama 3.3 70B': {
    params: 70.6, layers: 80, kvHeads: 8, headDim: 128,
    hiddenSize: 8192, intermediateSize: 28672,
    isMoE: false, category: 'Llama',
  },

  // --- Qwen family ---
  'Qwen 2.5 7B': {
    params: 7.62, layers: 28, kvHeads: 4, headDim: 128,
    hiddenSize: 3584, intermediateSize: 18944,
    isMoE: false, category: 'Qwen',
  },
  'Qwen 2.5 14B': {
    params: 14.8, layers: 48, kvHeads: 4, headDim: 128,
    hiddenSize: 5120, intermediateSize: 13824,
    isMoE: false, category: 'Qwen',
  },
  'Qwen 2.5 32B': {
    params: 32.8, layers: 64, kvHeads: 8, headDim: 128,
    hiddenSize: 5120, intermediateSize: 27648,
    isMoE: false, category: 'Qwen',
  },
  'Qwen 2.5 72B': {
    params: 72.7, layers: 80, kvHeads: 8, headDim: 128,
    hiddenSize: 8192, intermediateSize: 29568,
    isMoE: false, category: 'Qwen',
  },
  'Qwen 3 8B': {
    params: 8.2, layers: 36, kvHeads: 4, headDim: 128,
    hiddenSize: 4096, intermediateSize: 12288,
    isMoE: false, category: 'Qwen',
  },
  'Qwen 3 14B': {
    params: 14.0, layers: 40, kvHeads: 8, headDim: 128,
    hiddenSize: 5120, intermediateSize: 17408,
    isMoE: false, category: 'Qwen',
  },
  'Qwen 3 32B': {
    params: 32.5, layers: 64, kvHeads: 8, headDim: 128,
    hiddenSize: 5120, intermediateSize: 25600,
    isMoE: false, category: 'Qwen',
  },
  'Qwen 3.5 0.8B': {
    params: 0.8, layers: 24, kvHeads: 2, headDim: 64,
    hiddenSize: 1024, intermediateSize: 3072,
    isMoE: false, category: 'Qwen',
    kvLayers: 6,  // Hybrid attention: only 6 of 24 layers have full KV cache
  },
  'Qwen 3.5 4B': {
    params: 4.0, layers: 36, kvHeads: 4, headDim: 128,
    hiddenSize: 2560, intermediateSize: 9728,
    isMoE: false, category: 'Qwen',
    kvLayers: 10,  // Hybrid attention
  },
  'Qwen 3.5 8B': {
    params: 8.2, layers: 36, kvHeads: 4, headDim: 128,
    hiddenSize: 4096, intermediateSize: 12288,
    isMoE: false, category: 'Qwen',
    kvLayers: 10,  // Hybrid attention
  },
  'Qwen 3.5 14B': {
    params: 14.0, layers: 48, kvHeads: 4, headDim: 128,
    hiddenSize: 5120, intermediateSize: 17408,
    isMoE: false, category: 'Qwen',
    kvLayers: 14,  // Hybrid attention
  },
  'Qwen 3.5 32B': {
    params: 32.5, layers: 64, kvHeads: 8, headDim: 128,
    hiddenSize: 5120, intermediateSize: 25600,
    isMoE: false, category: 'Qwen',
    kvLayers: 18,  // Hybrid attention
  },
  'Qwen3 Coder Next': {
    // 80B total, MoE with 128 experts, 8 active — ~16B active params per token
    params: 80.0, layers: 94, kvHeads: 4, headDim: 128,
    hiddenSize: 3584, intermediateSize: 2560,
    isMoE: true, totalExperts: 128, activeExperts: 8,
    category: 'Qwen',
  },

  // --- Mistral family ---
  'Mistral 7B': {
    params: 7.24, layers: 32, kvHeads: 8, headDim: 128,
    hiddenSize: 4096, intermediateSize: 14336,
    isMoE: false, category: 'Mistral',
  },
  'Mixtral 8x7B': {
    params: 46.7, layers: 32, kvHeads: 8, headDim: 128,
    hiddenSize: 4096, intermediateSize: 14336,
    isMoE: true, totalExperts: 8, activeExperts: 2,
    category: 'Mistral',
  },
  'Mixtral 8x22B': {
    params: 141.0, layers: 56, kvHeads: 8, headDim: 128,
    hiddenSize: 6144, intermediateSize: 16384,
    isMoE: true, totalExperts: 8, activeExperts: 2,
    category: 'Mistral',
  },
  'Mistral Small 24B': {
    params: 24.0, layers: 40, kvHeads: 8, headDim: 128,
    hiddenSize: 5120, intermediateSize: 14336,
    isMoE: false, category: 'Mistral',
  },
  'Mistral Large 2 123B': {
    params: 122.61, layers: 88, kvHeads: 8, headDim: 128,
    hiddenSize: 12288, intermediateSize: 28672,
    isMoE: false, category: 'Mistral',
  },

  // --- Gemma family ---
  'Gemma 2 9B': {
    params: 9.24, layers: 42, kvHeads: 4, headDim: 256,
    hiddenSize: 3584, intermediateSize: 14336,
    isMoE: false, category: 'Google',
  },
  'Gemma 2 27B': {
    params: 27.2, layers: 46, kvHeads: 16, headDim: 128,
    hiddenSize: 4608, intermediateSize: 36864,
    isMoE: false, category: 'Google',
  },
  'Gemma 3 12B': {
    params: 12.2, layers: 48, kvHeads: 4, headDim: 256,
    hiddenSize: 3840, intermediateSize: 16384,
    isMoE: false, category: 'Google',
  },
  'Gemma 3 27B': {
    params: 27.4, layers: 62, kvHeads: 16, headDim: 128,
    hiddenSize: 4608, intermediateSize: 36864,
    isMoE: false, category: 'Google',
  },

  // --- DeepSeek family ---
  'DeepSeek V3 671B': {
    params: 671.0, layers: 61, kvHeads: 128, headDim: 128,
    hiddenSize: 7168, intermediateSize: 2048,
    isMoE: true, totalExperts: 256, activeExperts: 8,
    category: 'DeepSeek',
    // DeepSeek uses Multi-head Latent Attention (MLA) — reduced KV cache
    // This preset uses standard KV formula which overestimates; acceptable for planning
  },

  // --- Phi family ---
  'Phi 3 Mini 3.8B': {
    params: 3.82, layers: 32, kvHeads: 32, headDim: 96,
    hiddenSize: 3072, intermediateSize: 8192,
    isMoE: false, category: 'Microsoft',
  },
  'Phi 3 Medium 14B': {
    params: 14.0, layers: 40, kvHeads: 8, headDim: 128,
    hiddenSize: 5120, intermediateSize: 17920,
    isMoE: false, category: 'Microsoft',
  },
};

// ─── Constants ───────────────────────────────────────────────────────────────

// Per-GPU CUDA driver/runtime context — fixed cost per device (MiB).
// Covers CUDA context init, cuBLAS handles, device memory allocator overhead.
// Measured at ~200-400 MiB per GPU; 300 is a practical middle-ground.
export const CUDA_CONTEXT_PER_GPU_MB = 300;

// Inference scratch/compute buffer — per model instance (MiB).
// Scales with model size: small models need much less scratch space than large ones.
// Range: 800 MiB (tiny) → 4200 MiB (>100B). Based on empirical measurements:
//   0.8B → ~1400 MiB, 8B → ~2600 MiB, 70B → ~4100 MiB, 123B+ → 4200 MiB cap.
export function inferenceBufferMB(params) {
  if (!params || params <= 0) return 2000;
  return Math.min(4200, Math.max(800, Math.round(1000 + 500 * Math.log2(params + 1))));
}

// KV cache data type sizes (bytes per element)
const KV_DTYPE_BYTES = {
  'fp16': 2,
  'q8_0': 1.0625,  // 8.5 bits
  'q4_0': 0.5625,  // 4.5 bits
};

// ─── Calculator ──────────────────────────────────────────────────────────────

/**
 * Estimate VRAM required to run a model.
 *
 * @param {Object} opts
 * @param {number}  opts.params       - Total model params in billions
 * @param {string}  opts.quant        - Quantization format (e.g. 'Q4_K_M')
 * @param {number}  opts.contextSize  - Context window in tokens
 * @param {number}  [opts.layers]     - Number of transformer layers
 * @param {number}  [opts.kvHeads]    - Number of KV attention heads (for GQA)
 * @param {number}  [opts.headDim]    - Dimension per attention head
 * @param {string}  [opts.kvDtype='fp16'] - KV cache data type
 * @param {number}  [opts.numGpus=1]  - Number of GPUs (for tensor parallel split)
 * @param {number}  [opts.bpw]        - Direct bits-per-weight override (skips QUANT_BPW lookup)
 * @param {number}  [opts.kvLayers]   - Number of layers with traditional KV cache (for hybrid attention models)
 * @returns {Object} { totalMB, weightsMB, kvCacheMB, overheadMB, perGpuMB, breakdown }
 */
export function estimateVram(opts) {
  const {
    params,
    quant,
    contextSize,
    layers,
    kvHeads,
    headDim,
    kvDtype = 'fp16',
    numGpus = 1,
    bpw: bpwOverride,
    kvLayers,
  } = opts;

  // Use direct bpw override if provided, otherwise look up from quant name
  const bpw = bpwOverride || QUANT_BPW[quant];
  if (!bpw) throw new Error(`Unknown quant format: ${quant}`);

  // Weight VRAM: params (billions) × bpw / 8 → GB → MB
  const weightsMB = (params * 1e9 * bpw / 8) / (1024 * 1024);

  // KV cache VRAM (if architecture details provided)
  let kvCacheMB = 0;
  if (layers && kvHeads && headDim) {
    const kvBytesPerElement = KV_DTYPE_BYTES[kvDtype] || 2;
    // For hybrid attention models (e.g. Qwen3.5), only some layers have traditional KV cache.
    // Use kvLayers when provided, otherwise all layers have KV cache.
    const effectiveKvLayers = kvLayers || layers;
    // Per token: effectiveKvLayers × 2 (K+V) × kvHeads × headDim × bytesPerElement
    const bytesPerToken = effectiveKvLayers * 2 * kvHeads * headDim * kvBytesPerElement;
    kvCacheMB = (bytesPerToken * contextSize) / (1024 * 1024);
  } else {
    // Heuristic fallback when architecture details aren't available.
    // Use empirical reference points from common model families to estimate
    // layers and KV heads from parameter count. Most modern models use GQA
    // (grouped query attention) with 4-8 KV heads and 128-dim heads.
    let estLayers, estKvHeads;
    if      (params <= 3)   { estLayers = 26;  estKvHeads = 4;  }
    else if (params <= 8)   { estLayers = 32;  estKvHeads = 8;  }
    else if (params <= 14)  { estLayers = 40;  estKvHeads = 8;  }
    else if (params <= 27)  { estLayers = 48;  estKvHeads = 8;  }
    else if (params <= 35)  { estLayers = 64;  estKvHeads = 8;  }
    else if (params <= 72)  { estLayers = 80;  estKvHeads = 8;  }
    else if (params <= 140) { estLayers = 88;  estKvHeads = 8;  }
    else                    { estLayers = 96;  estKvHeads = 8;  }
    const estHeadDim = 128;
    const kvBytesPerElement = KV_DTYPE_BYTES[kvDtype] || 2;
    const bytesPerToken = estLayers * 2 * estKvHeads * estHeadDim * kvBytesPerElement;
    kvCacheMB = (bytesPerToken * contextSize) / (1024 * 1024);
  }

  // Overhead: inference buffer (scales with model size) + CUDA context per GPU
  const infBuf = inferenceBufferMB(params);
  const overheadMB = infBuf + CUDA_CONTEXT_PER_GPU_MB * numGpus;

  // Total VRAM across all GPUs
  const totalMB = weightsMB + kvCacheMB + overheadMB;

  // Per-GPU estimate (even-split ideal — informational only).
  // The gpu-placer refines this with sequential layer packing simulation
  // that models how ExLlamaV2/llama.cpp auto-split actually distributes load.
  const perGpuWeightsMB = weightsMB / numGpus;
  const perGpuKvMB = kvCacheMB / numGpus;
  const perGpuMB = perGpuWeightsMB + perGpuKvMB + CUDA_CONTEXT_PER_GPU_MB + infBuf;

  return {
    totalMB:    Math.ceil(totalMB),
    weightsMB:  Math.ceil(weightsMB),
    kvCacheMB:  Math.ceil(kvCacheMB),
    overheadMB: Math.ceil(overheadMB),
    perGpuMB:   Math.ceil(perGpuMB),
    numGpus,
    breakdown: {
      params,
      quant: quant || null,
      bpw,
      contextSize,
      kvDtype,
      layers: layers || null,
      kvHeads: kvHeads || null,
      headDim: headDim || null,
      kvLayers: kvLayers || null,
    },
  };
}

/**
 * Estimate VRAM using a model preset name.
 *
 * @param {string} presetName - Key from MODEL_PRESETS
 * @param {string} quant      - Quantization format
 * @param {number} contextSize - Context window in tokens
 * @param {Object} [overrides] - Override any preset fields
 * @returns {Object} Same as estimateVram() return
 */
export function estimateFromPreset(presetName, quant, contextSize, overrides = {}) {
  const preset = MODEL_PRESETS[presetName];
  if (!preset) throw new Error(`Unknown model preset: ${presetName}`);

  return estimateVram({
    params: preset.params,
    quant,
    contextSize,
    layers: preset.layers,
    kvHeads: preset.kvHeads,
    headDim: preset.headDim,
    kvLayers: preset.kvLayers || null,
    ...overrides,
  });
}

/**
 * Get all available model presets.
 * @returns {Object} Map of preset name → architecture details
 */
export function getModelPresets() {
  return { ...MODEL_PRESETS };
}

/**
 * Get all available quantization formats with their bits-per-weight.
 * @returns {Object} Map of format name → bpw
 */
export function getQuantFormats() {
  return { ...QUANT_BPW };
}
