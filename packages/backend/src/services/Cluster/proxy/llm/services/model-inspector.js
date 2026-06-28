/**
 * model-inspector.js — Model File Header Parser
 *
 * Reads GGUF and SafeTensors file headers to extract:
 *   - Model metadata (architecture, quant, context length, etc.)
 *   - Per-tensor info (name, shape, type, size in bytes)
 *   - Per-layer grouping with size totals
 *   - Summary statistics for VRAM planning
 *
 * Designed to work with raw Buffer data — the caller is responsible for
 * reading the bytes (locally or via SSH from a remote host).
 *
 * GGUF format reference: https://github.com/ggerganov/ggml/blob/master/docs/gguf.md
 * SafeTensors format: 8-byte LE header length + JSON header + tensor data
 *
 * @module model-inspector
 */

// ─── GGML Type Definitions ──────────────────────────────────────────────────
// Maps ggml_type enum → { name, blockSize, typeSize }
// typeSize = bytes per block. To get tensor bytes: (elements / blockSize) * typeSize

const GGML_TYPES = {
  0:  { name: 'F32',       blockSize: 1,   typeSize: 4 },
  1:  { name: 'F16',       blockSize: 1,   typeSize: 2 },
  2:  { name: 'Q4_0',      blockSize: 32,  typeSize: 18 },
  3:  { name: 'Q4_1',      blockSize: 32,  typeSize: 20 },
  6:  { name: 'Q5_0',      blockSize: 32,  typeSize: 22 },
  7:  { name: 'Q5_1',      blockSize: 32,  typeSize: 24 },
  8:  { name: 'Q8_0',      blockSize: 32,  typeSize: 34 },
  9:  { name: 'Q8_1',      blockSize: 32,  typeSize: 36 },
  10: { name: 'Q2_K',      blockSize: 256, typeSize: 84 },
  11: { name: 'Q3_K',      blockSize: 256, typeSize: 110 },
  12: { name: 'Q4_K',      blockSize: 256, typeSize: 144 },
  13: { name: 'Q5_K',      blockSize: 256, typeSize: 176 },
  14: { name: 'Q6_K',      blockSize: 256, typeSize: 210 },
  15: { name: 'Q8_K',      blockSize: 256, typeSize: 292 },
  16: { name: 'IQ2_XXS',   blockSize: 256, typeSize: 66 },
  17: { name: 'IQ2_XS',    blockSize: 256, typeSize: 74 },
  18: { name: 'IQ3_XXS',   blockSize: 256, typeSize: 98 },
  19: { name: 'IQ1_S',     blockSize: 256, typeSize: 50 },
  20: { name: 'IQ4_NL',    blockSize: 32,  typeSize: 18 },
  21: { name: 'IQ3_S',     blockSize: 256, typeSize: 110 },
  22: { name: 'IQ2_S',     blockSize: 256, typeSize: 82 },
  23: { name: 'IQ4_XS',    blockSize: 256, typeSize: 136 },
  24: { name: 'IQ1_M',     blockSize: 256, typeSize: 56 },
  25: { name: 'BF16',      blockSize: 1,   typeSize: 2 },
  26: { name: 'Q4_0_4_4',  blockSize: 32,  typeSize: 18 },
  27: { name: 'Q4_0_4_8',  blockSize: 32,  typeSize: 18 },
  28: { name: 'Q4_0_8_8',  blockSize: 32,  typeSize: 18 },
  29: { name: 'TQ1_0',     blockSize: 256, typeSize: 54 },
  30: { name: 'TQ2_0',     blockSize: 256, typeSize: 66 },
};

// SafeTensors dtype → bytes per element
const SAFETENSOR_DTYPES = {
  'F64': 8, 'F32': 4, 'F16': 2, 'BF16': 2,
  'I64': 8, 'I32': 4, 'I16': 2, 'I8': 1,
  'U8': 1, 'BOOL': 1,
};

// GGUF metadata value type enum
const GGUF_VALUE_TYPES = {
  0: 'uint8', 1: 'int8', 2: 'uint16', 3: 'int16',
  4: 'uint32', 5: 'int32', 6: 'float32', 7: 'bool',
  8: 'string', 9: 'array', 10: 'uint64', 11: 'int64', 12: 'float64',
};

// ─── Buffer Reader ──────────────────────────────────────────────────────────
// Sequential reader over a Buffer with position tracking.

class BufferReader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }

  remaining() { return this.buf.length - this.pos; }

  readUint8()   { const v = this.buf.readUInt8(this.pos);         this.pos += 1; return v; }
  readInt8()    { const v = this.buf.readInt8(this.pos);           this.pos += 1; return v; }
  readUint16()  { const v = this.buf.readUInt16LE(this.pos);      this.pos += 2; return v; }
  readInt16()   { const v = this.buf.readInt16LE(this.pos);        this.pos += 2; return v; }
  readUint32()  { const v = this.buf.readUInt32LE(this.pos);      this.pos += 4; return v; }
  readInt32()   { const v = this.buf.readInt32LE(this.pos);        this.pos += 4; return v; }
  readFloat32() { const v = this.buf.readFloatLE(this.pos);        this.pos += 4; return v; }
  readFloat64() { const v = this.buf.readDoubleLE(this.pos);       this.pos += 8; return v; }

  readUint64() {
    // Read as BigInt, convert to Number (safe for values < 2^53)
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }

  readInt64() {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }

  readBool() {
    return this.readUint8() !== 0;
  }

  readString() {
    const len = this.readUint64();
    if (len > 10_000_000) throw new Error(`String too long: ${len}`);
    const str = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return str;
  }

  readBytes(n) {
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
}

// ─── GGUF Parser ────────────────────────────────────────────────────────────

/**
 * Compute tensor size in bytes from element count and GGML type.
 */
function ggmlTensorBytes(elements, typeId) {
  const t = GGML_TYPES[typeId];
  if (!t) return 0;
  return Math.ceil(elements / t.blockSize) * t.typeSize;
}

/**
 * Read a single GGUF metadata value from the reader.
 */
function readGgufValue(reader, typeId) {
  switch (typeId) {
    case 0:  return reader.readUint8();
    case 1:  return reader.readInt8();
    case 2:  return reader.readUint16();
    case 3:  return reader.readInt16();
    case 4:  return reader.readUint32();
    case 5:  return reader.readInt32();
    case 6:  return reader.readFloat32();
    case 7:  return reader.readBool();
    case 8:  return reader.readString();
    case 9: {
      // Array: element type (uint32) + count (uint64) + values
      const elemType = reader.readUint32();
      const count = reader.readUint64();
      if (count > 10_000_000) throw new Error(`Array too large: ${count}`);
      const arr = [];
      for (let i = 0; i < count; i++) {
        arr.push(readGgufValue(reader, elemType));
      }
      return arr;
    }
    case 10: return reader.readUint64();
    case 11: return reader.readInt64();
    case 12: return reader.readFloat64();
    default:
      throw new Error(`Unknown GGUF value type: ${typeId}`);
  }
}

/**
 * Parse a GGUF file header from a Buffer.
 *
 * @param {Buffer} buffer - At least the first N bytes of the GGUF file
 *                          (header + tensor info; typically 1-10 MB is enough)
 * @returns {Object} { metadata, tensors, version }
 */
export function parseGguf(buffer) {
  const reader = new BufferReader(buffer);

  // Magic number: "GGUF"
  const magic = reader.readBytes(4).toString('ascii');
  if (magic !== 'GGUF') {
    throw new Error(`Not a GGUF file (magic: ${magic})`);
  }

  const version = reader.readUint32();
  if (version < 2 || version > 3) {
    throw new Error(`Unsupported GGUF version: ${version} (expected 2 or 3)`);
  }

  const tensorCount = reader.readUint64();
  const metadataKvCount = reader.readUint64();

  // Parse metadata key-value pairs
  const metadata = {};
  for (let i = 0; i < metadataKvCount; i++) {
    if (reader.remaining() < 16) {
      throw new Error(`Buffer too small: ran out at metadata entry ${i}/${metadataKvCount} (pos ${reader.pos})`);
    }
    const key = reader.readString();
    const valueType = reader.readUint32();
    const value = readGgufValue(reader, valueType);
    metadata[key] = value;
  }

  // Parse tensor info entries
  const tensors = [];
  for (let i = 0; i < tensorCount; i++) {
    if (reader.remaining() < 16) {
      throw new Error(`Buffer too small: ran out at tensor entry ${i}/${tensorCount} (pos ${reader.pos})`);
    }
    const name = reader.readString();
    const nDims = reader.readUint32();
    const dims = [];
    for (let d = 0; d < nDims; d++) {
      dims.push(reader.readUint64());
    }
    const typeId = reader.readUint32();
    const offset = reader.readUint64();

    // Compute element count and byte size
    const elements = dims.reduce((a, b) => a * b, 1);
    const sizeBytes = ggmlTensorBytes(elements, typeId);
    const typeName = GGML_TYPES[typeId]?.name || `unknown_${typeId}`;

    tensors.push({ name, dims, typeId, typeName, offset, elements, sizeBytes });
  }

  return { version, metadata, tensors, headerEndPos: reader.pos };
}

// ─── SafeTensors Parser ─────────────────────────────────────────────────────

/**
 * Parse a SafeTensors file header from a Buffer.
 *
 * @param {Buffer} buffer - At least 8 + headerLength bytes of the file
 * @returns {Object} { metadata, tensors }
 */
export function parseSafetensors(buffer) {
  if (buffer.length < 8) throw new Error('Buffer too small for SafeTensors header');

  const headerLen = Number(buffer.readBigUInt64LE(0));
  if (headerLen > 100_000_000) throw new Error(`SafeTensors header too large: ${headerLen}`);
  if (buffer.length < 8 + headerLen) {
    throw new Error(`Buffer too small: need ${8 + headerLen} bytes, got ${buffer.length}`);
  }

  const headerJson = buffer.toString('utf8', 8, 8 + headerLen);
  const header = JSON.parse(headerJson);

  const metadata = header.__metadata__ || {};
  const tensors = [];

  for (const [name, info] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const { dtype, shape, data_offsets } = info;
    const elements = shape.reduce((a, b) => a * b, 1);
    const sizeBytes = data_offsets ? (data_offsets[1] - data_offsets[0]) : 0;
    const bytesPerElement = SAFETENSOR_DTYPES[dtype] || 0;

    tensors.push({
      name,
      dims: shape,
      typeName: dtype,
      elements,
      sizeBytes,
      bytesPerElement,
    });
  }

  return { metadata, tensors, headerBytes: 8 + headerLen };
}

// ─── Layer Grouping ─────────────────────────────────────────────────────────

// Pattern matchers for extracting layer index from tensor names
const LAYER_PATTERNS = [
  /^blk\.(\d+)\./,                    // GGUF: blk.0.attn_q.weight
  /^model\.layers\.(\d+)\./,          // HF SafeTensors: model.layers.0.self_attn.q_proj.weight
  /^transformer\.h\.(\d+)\./,         // GPT-2/GPT-J style
  /^encoder\.layer\.(\d+)\./,         // BERT-style encoder
  /^decoder\.layers?\.(\d+)\./,       // Decoder layers
  /^layers\.(\d+)\./,                 // Simple layers.N prefix
];

/**
 * Extract layer index from a tensor name, or null if it's a non-layer tensor.
 */
function extractLayerIndex(tensorName) {
  for (const pat of LAYER_PATTERNS) {
    const m = tensorName.match(pat);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Categorize a non-layer tensor into a meaningful group.
 */
function categorizeNonLayerTensor(name) {
  const n = name.toLowerCase();
  if (n.includes('embd') || n.includes('embed_tokens') || n.includes('wte') || n.includes('word_embedding'))
    return 'embedding';
  if (n.includes('output_norm') || n.includes('ln_f') || n.includes('final_layernorm') || n.includes('model.norm'))
    return 'final_norm';
  if (n === 'output.weight' || n.includes('lm_head') || n.includes('output.weight'))
    return 'output_head';
  return 'other';
}

/**
 * Build a layer map from a list of tensors.
 *
 * Groups tensors by layer index, computes per-layer totals,
 * and separates out non-layer tensors (embeddings, output head, etc.).
 *
 * @param {Array} tensors - Array of { name, dims, typeName, sizeBytes, ... }
 * @returns {Object} { layers, nonLayerGroups, summary }
 */
export function buildLayerMap(tensors) {
  const layerMap = {};     // layerIndex → { tensors, totalBytes }
  const nonLayerGroups = { // category → { tensors, totalBytes }
    embedding:  { tensors: [], totalBytes: 0 },
    output_head: { tensors: [], totalBytes: 0 },
    final_norm: { tensors: [], totalBytes: 0 },
    other:      { tensors: [], totalBytes: 0 },
  };

  for (const t of tensors) {
    const layerIdx = extractLayerIndex(t.name);
    if (layerIdx !== null) {
      if (!layerMap[layerIdx]) layerMap[layerIdx] = { index: layerIdx, tensors: [], totalBytes: 0 };
      layerMap[layerIdx].tensors.push(t);
      layerMap[layerIdx].totalBytes += t.sizeBytes;
    } else {
      const cat = categorizeNonLayerTensor(t.name);
      nonLayerGroups[cat].tensors.push(t);
      nonLayerGroups[cat].totalBytes += t.sizeBytes;
    }
  }

  // Sort layers by index
  const layers = Object.values(layerMap).sort((a, b) => a.index - b.index);

  // Summary stats
  const layerSizes = layers.map(l => l.totalBytes);
  const totalLayerBytes = layerSizes.reduce((a, b) => a + b, 0);
  const totalNonLayerBytes = Object.values(nonLayerGroups).reduce((a, g) => a + g.totalBytes, 0);
  const totalModelBytes = totalLayerBytes + totalNonLayerBytes;

  const summary = {
    totalTensors: tensors.length,
    totalLayers: layers.length,
    totalModelBytes,
    totalModelMB: Math.round(totalModelBytes / (1024 * 1024)),
    layerBytes: {
      min: layerSizes.length ? Math.min(...layerSizes) : 0,
      max: layerSizes.length ? Math.max(...layerSizes) : 0,
      avg: layerSizes.length ? Math.round(layerSizes.reduce((a, b) => a + b, 0) / layerSizes.length) : 0,
    },
    layerMB: {
      min: layerSizes.length ? Math.round(Math.min(...layerSizes) / (1024 * 1024) * 10) / 10 : 0,
      max: layerSizes.length ? Math.round(Math.max(...layerSizes) / (1024 * 1024) * 10) / 10 : 0,
      avg: layerSizes.length ? Math.round(layerSizes.reduce((a, b) => a + b, 0) / layerSizes.length / (1024 * 1024) * 10) / 10 : 0,
    },
    embeddingBytes: nonLayerGroups.embedding.totalBytes,
    outputHeadBytes: nonLayerGroups.output_head.totalBytes,
    nonLayerBytes: totalNonLayerBytes,
  };

  return { layers, nonLayerGroups, summary };
}

// ─── GGUF Metadata Extraction ───────────────────────────────────────────────

// Useful metadata keys and their short names for the API response
const GGUF_META_KEYS = {
  'general.architecture':       'architecture',
  'general.name':               'modelName',
  'general.file_type':          'fileType',
  'general.quantization_version': 'quantVersion',
  // Architecture-specific keys use {arch} prefix — we handle dynamically
};

// Architecture-specific keys we want (replace {arch} with actual architecture)
const GGUF_ARCH_KEYS = [
  '{arch}.block_count',
  '{arch}.context_length',
  '{arch}.embedding_length',
  '{arch}.feed_forward_length',
  '{arch}.attention.head_count',
  '{arch}.attention.head_count_kv',
  '{arch}.attention.layer_norm_rms_epsilon',
  '{arch}.expert_count',
  '{arch}.expert_used_count',
  '{arch}.rope.dimension_count',
  '{arch}.rope.freq_base',
  '{arch}.vocab_size',
];

/**
 * Extract useful metadata from raw GGUF metadata dict.
 * Flattens architecture-prefixed keys into short names.
 */
export function extractGgufMetadata(raw) {
  const result = {};
  const arch = raw['general.architecture'] || '';

  // General keys
  for (const [fullKey, shortKey] of Object.entries(GGUF_META_KEYS)) {
    if (raw[fullKey] !== undefined) result[shortKey] = raw[fullKey];
  }

  // Architecture-specific keys
  for (const template of GGUF_ARCH_KEYS) {
    const fullKey = template.replace('{arch}', arch);
    if (raw[fullKey] !== undefined) {
      // Convert "llama.block_count" → "blockCount"
      const parts = template.replace('{arch}.', '').split('.');
      const shortKey = parts.map((p, i) => {
        if (i === 0) return p.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        return p.charAt(0).toUpperCase() + p.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      }).join('');
      result[shortKey] = raw[fullKey];
    }
  }

  // Tokenizer info
  if (raw['tokenizer.ggml.model']) result.tokenizerModel = raw['tokenizer.ggml.model'];
  if (raw['tokenizer.ggml.tokens']) result.vocabSize = raw['tokenizer.ggml.tokens'].length;

  return result;
}

// ─── High-Level Inspection ──────────────────────────────────────────────────

/**
 * Detect file format from magic bytes.
 * @param {Buffer} buffer - At least the first 8 bytes
 * @returns {'gguf' | 'safetensors' | 'unknown'}
 */
export function detectFormat(buffer) {
  if (buffer.length < 8) return 'unknown';
  const magic4 = buffer.toString('ascii', 0, 4);
  if (magic4 === 'GGUF') return 'gguf';
  // SafeTensors: first 8 bytes are the header length (small number, < 100MB)
  // Then the next byte should be '{' (start of JSON)
  const headerLen = Number(buffer.readBigUInt64LE(0));
  if (headerLen > 0 && headerLen < 100_000_000 && buffer.length > 8 && buffer[8] === 0x7B) {
    return 'safetensors';
  }
  return 'unknown';
}

/**
 * Inspect a model file from a Buffer containing the header.
 *
 * @param {Buffer} buffer - File header bytes (GGUF: ~10MB usually enough;
 *                          SafeTensors: 8 + headerLength bytes)
 * @param {Object} [opts]
 * @param {string} [opts.fileName] - Original file name for reference
 * @param {number} [opts.fileSize] - Total file size in bytes
 * @returns {Object} Full inspection result
 */
export function inspectModel(buffer, opts = {}) {
  const format = detectFormat(buffer);

  if (format === 'gguf') {
    const parsed = parseGguf(buffer);
    const metadata = extractGgufMetadata(parsed.metadata);
    const { layers, nonLayerGroups, summary } = buildLayerMap(parsed.tensors);

    return {
      format: 'gguf',
      fileName: opts.fileName || null,
      fileSize: opts.fileSize || null,
      ggufVersion: parsed.version,
      metadata,
      layers: layers.map(l => ({
        index: l.index,
        totalBytes: l.totalBytes,
        totalMB: Math.round(l.totalBytes / (1024 * 1024) * 10) / 10,
        tensors: l.tensors.map(t => ({
          name: t.name, dims: t.dims, type: t.typeName, sizeBytes: t.sizeBytes,
        })),
      })),
      nonLayerGroups: Object.fromEntries(
        Object.entries(nonLayerGroups)
          .filter(([, g]) => g.tensors.length > 0)
          .map(([cat, g]) => [cat, {
            totalBytes: g.totalBytes,
            totalMB: Math.round(g.totalBytes / (1024 * 1024) * 10) / 10,
            tensors: g.tensors.map(t => ({
              name: t.name, dims: t.dims, type: t.typeName, sizeBytes: t.sizeBytes,
            })),
          }])
      ),
      summary,
    };
  }

  if (format === 'safetensors') {
    const parsed = parseSafetensors(buffer);
    const { layers, nonLayerGroups, summary } = buildLayerMap(parsed.tensors);

    return {
      format: 'safetensors',
      fileName: opts.fileName || null,
      fileSize: opts.fileSize || null,
      metadata: parsed.metadata,
      layers: layers.map(l => ({
        index: l.index,
        totalBytes: l.totalBytes,
        totalMB: Math.round(l.totalBytes / (1024 * 1024) * 10) / 10,
        tensors: l.tensors.map(t => ({
          name: t.name, dims: t.dims, type: t.typeName, sizeBytes: t.sizeBytes,
        })),
      })),
      nonLayerGroups: Object.fromEntries(
        Object.entries(nonLayerGroups)
          .filter(([, g]) => g.tensors.length > 0)
          .map(([cat, g]) => [cat, {
            totalBytes: g.totalBytes,
            totalMB: Math.round(g.totalBytes / (1024 * 1024) * 10) / 10,
            tensors: g.tensors.map(t => ({
              name: t.name, dims: t.dims, type: t.typeName, sizeBytes: t.sizeBytes,
            })),
          }])
      ),
      summary,
    };
  }

  throw new Error(`Unknown model format (not GGUF or SafeTensors)`);
}

/**
 * Estimate how many bytes of header to read for a GGUF file.
 * For most models, 10MB is more than enough for the metadata + tensor info table.
 * Very large models (600B+) with many tensors might need up to 50MB.
 *
 * @param {number} fileSize - Total file size in bytes
 * @returns {number} Recommended header read size in bytes
 */
export function recommendedHeaderSize(fileSize) {
  // Heuristic: header is typically < 0.1% of file size, but at least 2MB, at most 50MB
  const estimate = Math.ceil(fileSize * 0.002);
  return Math.max(2 * 1024 * 1024, Math.min(estimate, 50 * 1024 * 1024));
}

/**
 * For multi-shard SafeTensors models, estimate header size.
 * SafeTensors headers are typically 50KB-500KB, so 2MB is always safe.
 */
export function safetensorsHeaderSize() {
  return 2 * 1024 * 1024;
}
