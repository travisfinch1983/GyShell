// ─────────────────────────────────────────────────────────────────────────────
// Stable KV-cache fingerprint
// ─────────────────────────────────────────────────────────────────────────────
// A fingerprint is a pure function of (model file identity + the launch params that
// change the *bytes/semantics* of a saved KV state). It deliberately EXCLUDES anything
// that does not change KV compatibility — port, pid, GPUs / node, tensor-split,
// n-gpu-layers, --parallel/slot-count, ctx-size, and cosmetic name/alias overrides. Two
// separate llama.cpp instances that run the same model with the same KV-affecting params
// therefore derive the SAME fingerprint and share one Optane snapshot pool + one prefix
// index (the cross-instance capability, plan §4a).
//
// FP inputs are authoritative per Fable's b8100-9 source audit (busSeq 750). llama's seq
// state files DO NOT self-describe two things, so the fp MUST carry them or restores
// silently corrupt:
//   • model file identity  — seq files store arch only, never the model. (basename here;
//     see MODEL_IDENTITY_TODO for the requant hardening.)
//   • rope / yarn params    — UNCHECKED on load but change K semantics.
// It must also carry what IS checked, so "identical" instances don't fail to share:
//   • cache-type-k / cache-type-v (per-layer dtype + row-size are load-gated)
//   • flash-attn (drives v_trans, which IS load-gated → FA mismatch kills sharing)
//   • spec-type / ctx-checkpoints — drive the ~150 MB of AUXILIARY saved-state (MTP draft
//     context + checkpoint ring). A full-state save/restore carries these, so instances with
//     different speculative/checkpoint configs have structurally different saved states →
//     must NOT share a pool (fail-safe: separate fp = separate pool = no cross-restore).
// And the state format version, stored per-row so a llama upgrade reads old rows as
// regenerate rather than mis-restoring:
//   • LLAMA_STATE_SEQ_VERSION (=2, llama.h:48) — carried on the index row, not the hash.
//
// ctx-size is NOT in the fp: Fable Q1 confirmed restore is ctx-agnostic (load gate is
// cell_count ≤ capacity, an inequality; server-context.cpp:1840). The replacement safety
// is a RUNTIME guard in the orchestration: never restore a snapshot whose n_tokens exceeds
// the destination slot's n_ctx. INCLUDE_CTX stays as an escape hatch only.

import { createHash } from 'crypto';

// llama.cpp seq-state format version (llama.h:48). Stored per index row; a restore whose
// row version != this is treated as a miss (regenerate) rather than attempted.
export const STATE_SEQ_VERSION = 2;

// ctx-size participates in the fingerprint? FALSE per Fable Q1 (ctx-agnostic restore);
// the runtime guard (saved_n ≤ slot n_ctx) replaces it. Leave as an escape hatch.
export const INCLUDE_CTX = false;

// MODEL_IDENTITY_TODO: fp uses the model file *basename*. A requant reusing the same name
// (different bytes) would wrongly reuse snapshots (llama won't catch it — model identity
// isn't in seq files). Cheap hardening: fold in the model file size (stat on the llama
// host); deferred because it needs a remote stat at launch. Descriptive quant-in-name
// (…-UD-Q8_K_XL.gguf) makes collisions unlikely in practice.

// Regexes for the params that affect saved-KV compatibility. `--flag value` or `--flag=value`.
const P = (flag) => new RegExp(`--${flag}[ =]+"?([^"\\s\\\\]+)"?`);

// KV-compatibility-affecting params, fixed order (order matters for the hash).
const KV_LAYOUT_PARAMS = [
  'cache-type-k',      // KV key quantization dtype — load-gated (dtype + row-size)
  'cache-type-v',      // KV value quantization dtype — load-gated
  'flash-attn',        // drives v_trans, which IS load-gated → must match to share
  'rope-scaling',      // positional encoding baked into K — UNCHECKED on load, must be in fp
  'rope-freq-base',
  'rope-freq-scale',
  'yarn-ext-factor',
  'yarn-attn-factor',
  'yarn-beta-fast',
  'yarn-beta-slow',
  'yarn-orig-ctx',
  'spec-type',         // speculative decode type (e.g. draft-mtp) — changes AUX saved-state structure
  'ctx-checkpoints',   // checkpoint ring size — changes AUX saved-state structure
];

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);

/**
 * Extract the real model file name from a llama-server command line, unwrapping the
 * model-cache helper: --model $(mc '/models/.../file.gguf').
 */
export function extractModelName(finalCommand) {
  const cmd = String(finalCommand || '');
  const mcMatch = cmd.match(/--model[ =]+\$\(mc\s+'([^']+)'\)/);
  const plainMatch = cmd.match(/--model[ =]+"?([^"\s\\]+)"?/);
  const modelPath = mcMatch ? mcMatch[1] : (plainMatch ? plainMatch[1] : '');
  return modelPath.split('/').filter(Boolean).pop() || '';
}

/**
 * Compute the stable KV fingerprint for a llama-server launch command.
 * @param {string} finalCommand  the fully-resolved llama-server command line
 * @param {object} [opts]
 * @param {string} [opts.optaneBase='/optane-sock0/kvcache']  base dir for slot-save
 * @param {string|number} [opts.port]  last-resort slug only when model name is empty
 * @returns {{
 *   modelName: string, slug: string, fp: string, slotName: string, optanePath: string,
 *   layout: Record<string,string>, ctx: string, stateSeqVersion: number
 * }}
 */
export function computeKvFingerprint(finalCommand, opts = {}) {
  const cmd = String(finalCommand || '');
  const optaneBase = opts.optaneBase || '/optane-sock0/kvcache';

  const modelName = extractModelName(cmd);
  const ctx = (cmd.match(/--ctx-size[ =]+(\d+)/) || [])[1] || '';

  const layout = {};
  const hashParts = [modelName];
  for (const flag of KV_LAYOUT_PARAMS) {
    const v = (cmd.match(P(flag)) || [])[1] || '';
    layout[flag] = v;
    hashParts.push(v);
  }
  if (INCLUDE_CTX) hashParts.push(`ctx:${ctx}`);

  const fp = createHash('sha1').update(hashParts.join('|')).digest('hex').slice(0, 8);
  const base = slug(modelName);
  const slotName = base ? `${base}-${fp}` : `svc-${opts.port || 'x'}-${fp}`;
  const optanePath = `${optaneBase}/${slotName}`;

  return { modelName, slug: base, fp, slotName, optanePath, layout, ctx, stateSeqVersion: STATE_SEQ_VERSION };
}
