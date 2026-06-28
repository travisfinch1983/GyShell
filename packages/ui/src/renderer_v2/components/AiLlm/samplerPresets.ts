// Ported verbatim from ProxLab public/js/modules/ai.js — built-in sampler presets for llama.cpp /
// ik_llama.cpp launches. Each preset's `values` map directly onto launcher setting keys.
/* eslint-disable */
// @ts-nocheck

  const QWEN_NATIVE_CTX = {
    contextSize: 262144,
    ropeScaling: '',
    ropeScale: 0,
    ropeFreqBase: 0,
    yarnOrigCtx: 0,
  };
  // YaRN factor scales context: 2.0 → ~524K, 4.0 → ~1.01M (HF Qwen3.6-27B
  // model card). rope_theta override 1e7 stays the same across factors;
  // only the factor + matching contextSize change.
  const QWEN36_512K_CTX = {
    contextSize: 524288,
    ropeScaling: 'yarn',
    ropeScale: 2.0,
    yarnOrigCtx: 262144,
    ropeFreqBase: 10000000,
  };
  const QWEN36_1M_CTX = {
    contextSize: 1010000,
    ropeScaling: 'yarn',
    ropeScale: 4.0,
    yarnOrigCtx: 262144,
    ropeFreqBase: 10000000,
  };
export const SAMPLER_PRESETS_BUILTIN = [
    {
      id: 'builtin-qwen36-thinking-general',
      name: 'Qwen 3.6 — Thinking, General',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 1.0, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'deepseek', specType: 'mtp', draftMax: 3 },
    },
    {
      id: 'builtin-qwen36-thinking-code',
      name: 'Qwen 3.6 — Thinking, Code/Web',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 0.6, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'deepseek', specType: 'mtp', draftMax: 3 },
    },
    {
      id: 'builtin-qwen36-instruct',
      name: 'Qwen 3.6 — Instruct (Non-Thinking)',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek', reasoningBudget: 0, chatTemplateKwargs: '', specType: 'mtp', draftMax: 3 },
    },
    {
      id: 'builtin-qwen36-512k-thinking-general',
      name: 'Qwen 3.6 — 512K Ctx · Thinking, General',
      readOnly: true,
      values: { ...QWEN36_512K_CTX, temp: 1.0, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'deepseek', specType: 'mtp', draftMax: 3 },
    },
    {
      id: 'builtin-qwen36-512k-thinking-code',
      name: 'Qwen 3.6 — 512K Ctx · Thinking, Code/Web',
      readOnly: true,
      values: { ...QWEN36_512K_CTX, temp: 0.6, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'deepseek', specType: 'mtp', draftMax: 3 },
    },
    {
      id: 'builtin-qwen36-512k-instruct',
      name: 'Qwen 3.6 — 512K Ctx · Instruct (Non-Thinking)',
      readOnly: true,
      values: { ...QWEN36_512K_CTX, temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek', reasoningBudget: 0, chatTemplateKwargs: '', specType: 'mtp', draftMax: 3 },
    },
    {
      id: 'builtin-qwen36-1m-thinking-general',
      name: 'Qwen 3.6 — 1M Ctx · Thinking, General',
      readOnly: true,
      values: { ...QWEN36_1M_CTX, temp: 1.0, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'deepseek', specType: 'mtp', draftMax: 3 },
    },
    {
      id: 'builtin-qwen36-1m-thinking-code',
      name: 'Qwen 3.6 — 1M Ctx · Thinking, Code/Web',
      readOnly: true,
      values: { ...QWEN36_1M_CTX, temp: 0.6, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'deepseek', specType: 'mtp', draftMax: 3 },
    },
    {
      id: 'builtin-qwen36-1m-instruct',
      name: 'Qwen 3.6 — 1M Ctx · Instruct (Non-Thinking)',
      readOnly: true,
      values: { ...QWEN36_1M_CTX, temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek', reasoningBudget: 0, chatTemplateKwargs: '', specType: 'mtp', draftMax: 3 },
    },

    // Agent presets — instruct sampling + parallel slots pre-set + thinking
    // suppressed via reasoning-format=deepseek + reasoning-budget=0 (parser
    // strips the chat template's structural <think></think> wrapper into an
    // empty reasoning_content field, leaving content clean). chatTemplateKwargs
    // is explicitly cleared so a stale 'enable_thinking: false' kwarg doesn't
    // re-inject empty think tags. Tuned for tool-call/agent loops where
    // determinism matters and visible thinking wastes tokens.
    //
    // CONTEXT MATH: --ctx-size is the TOTAL KV pool, divided across --parallel
    // slots. To give each of 4 slots the full Qwen 3.6 native 256K window,
    // total ctx-size must be 4 × 262144 = 1048576. These presets follow the
    // "per slot" convention so each slot gets the named window size.
    // - "256K/slot" → 4 × 262144 = 1048576 total, no YaRN (256K is native)
    // - "512K/slot" → 4 × 524288 = 2097152 total, YaRN factor 2.0
    // - "1M/slot"   → 4 × 1010000 = 4040000 total, YaRN factor 4.0 (very VRAM-heavy)
    {
      id: 'builtin-qwen36-agent',
      name: 'Qwen 3.6 — Agent (4 slots × 256K each)',
      readOnly: true,
      values: {
        contextSize: 1048576,    // 4 × 262144 native ctx
        ropeScaling: '',          // native — no YaRN needed
        ropeScale: 0,
        ropeFreqBase: 0,
        yarnOrigCtx: 0,
        parallel: 4,
        reasoning: 'off',
        temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0,
        reasoningFormat: 'deepseek',
        reasoningBudget: 0,
        chatTemplateKwargs: '',
        specType: 'mtp',
        draftMax: 3,
      },
    },
    {
      id: 'builtin-qwen36-512k-agent',
      name: 'Qwen 3.6 — Agent (4 slots × 512K each, YaRN)',
      readOnly: true,
      values: {
        contextSize: 2097152,    // 4 × 524288
        ropeScaling: 'yarn',
        ropeScale: 2.0,
        yarnOrigCtx: 262144,
        ropeFreqBase: 10000000,
        parallel: 4,
        reasoning: 'off',
        temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0,
        reasoningFormat: 'deepseek',
        reasoningBudget: 0,
        chatTemplateKwargs: '',
        specType: 'mtp',
        draftMax: 3,
      },
    },
    {
      id: 'builtin-qwen36-1m-agent',
      name: 'Qwen 3.6 — Agent (4 slots × 1M each, YaRN — VRAM-heavy)',
      readOnly: true,
      values: {
        contextSize: 4040000,    // 4 × 1010000
        ropeScaling: 'yarn',
        ropeScale: 4.0,
        yarnOrigCtx: 262144,
        ropeFreqBase: 10000000,
        parallel: 4,
        reasoning: 'off',
        temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0,
        reasoningFormat: 'deepseek',
        reasoningBudget: 0,
        chatTemplateKwargs: '',
        specType: 'mtp',
        draftMax: 3,
      },
    },

    // ─── Qwen 3.5 ─────────────────────────────────────────────────────────
    // Same recipes apply to ALL Qwen 3.5 sizes (verified across dense 27B
    // and sparse 122B-A10B — identical recommendations). All Qwen 3.5
    // models use 262144 native ctx, so the same YaRN extension config
    // (factor 4.0, theta 1e7) reaches ~1M.
    //
    // Mode notes:
    //   - Thinking General : chat / Q&A / conversation. presence 1.5 (vs
    //                         Qwen 3.6's 0.0) — 3.5 needs more push to
    //                         keep think+reply blocks from echoing.
    //   - Thinking Code/Web: precise code generation. Lower temp = more
    //                         determinism for syntactically-tight output.
    //   - Instruct General : non-thinking, short tasks.
    //   - Instruct Reasoning: non-thinking math/logic. New in 3.5 — 3.6
    //                         doesn't have a separate recipe for this.
    {
      id: 'builtin-qwen35-thinking-general',
      name: 'Qwen 3.5 — Thinking, General',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 1.0, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek' },
    },
    {
      id: 'builtin-qwen35-thinking-code',
      name: 'Qwen 3.5 — Thinking, Code/Web',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 0.6, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'deepseek' },
    },
    {
      id: 'builtin-qwen35-instruct-general',
      name: 'Qwen 3.5 — Instruct (Non-Thinking), General',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek', reasoningBudget: 0, chatTemplateKwargs: '' },
    },
    {
      id: 'builtin-qwen35-instruct-reasoning',
      name: 'Qwen 3.5 — Instruct (Non-Thinking), Reasoning',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 1.0, topK: 40, topP: 1.0, minP: 0.0, presencePenalty: 2.0, repeatPenalty: 1.0, reasoningFormat: 'deepseek', reasoningBudget: 0, chatTemplateKwargs: '' },
    },
    {
      id: 'builtin-qwen35-512k-thinking-general',
      name: 'Qwen 3.5 — 512K Ctx · Thinking, General',
      readOnly: true,
      values: { ...QWEN36_512K_CTX, temp: 1.0, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek' },
    },
    {
      id: 'builtin-qwen35-512k-instruct-general',
      name: 'Qwen 3.5 — 512K Ctx · Instruct (Non-Thinking), General',
      readOnly: true,
      values: { ...QWEN36_512K_CTX, temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek', reasoningBudget: 0, chatTemplateKwargs: '' },
    },
    {
      id: 'builtin-qwen35-1m-thinking-general',
      name: 'Qwen 3.5 — 1M Ctx · Thinking, General',
      readOnly: true,
      values: { ...QWEN36_1M_CTX, temp: 1.0, topK: 20, topP: 0.95, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek' },
    },
    {
      id: 'builtin-qwen35-1m-instruct-general',
      name: 'Qwen 3.5 — 1M Ctx · Instruct (Non-Thinking), General',
      readOnly: true,
      values: { ...QWEN36_1M_CTX, temp: 0.7, topK: 20, topP: 0.80, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningFormat: 'deepseek', reasoningBudget: 0, chatTemplateKwargs: '' },
    },

    // ─── Gemma 4 ──────────────────────────────────────────────────────────
    // Google's model card prescribes ONE universal sampling recipe across
    // all use cases (chat, code, thinking, non-thinking): temp=1.0,
    // top_p=0.95, top_k=64. No min_p / presence / repetition penalties
    // recommended. Both 31B Dense and 26B-A4B sparse share native 256K ctx
    // (262144) and use Proportional RoPE (p-RoPE) — no YaRN variants
    // documented, so we omit extended-context presets.
    //
    // Thinking mode on the 26B-A4B is controlled via the chat template
    // (`enable_thinking` jinja kwarg or `<|think|>` system token), not
    // sampling — so a single preset covers both modes.
    {
      id: 'builtin-gemma4-31b',
      name: 'Gemma 4 — 31B Dense',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 1.0, topK: 64, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'none' },
    },
    {
      id: 'builtin-gemma4-26b-a4b',
      name: 'Gemma 4 — 26B-A4B Sparse',
      readOnly: true,
      values: { ...QWEN_NATIVE_CTX, temp: 1.0, topK: 64, topP: 0.95, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0, reasoningFormat: 'none' },
    },
  ];
