import { computeKvFingerprint, computeVllmKvFingerprint } from './fingerprint.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const fp = (cmd, opts) => computeKvFingerprint(cmd, opts).fp;

const base =
  "/opt/llama-server/llama-server --model $(mc '/models/Qwen3.6/27B-MTP/GGUF/Q8_K_XL/Qwen3.6-27B-UD-Q8_K_XL.gguf') " +
  '--port 5001 --host 0.0.0.0 --ctx-size 528244 --gpu-layers 999 --tensor-split 1.00,1.00 --flash-attn auto ' +
  '--parallel 2 --cache-type-k q8_0 --cache-type-v q8_0 --split-mode tensor --spec-type draft-mtp --ctx-checkpoints 64';

const b = fp(base, { port: 5001 });

// 1) identical config on a DIFFERENT port/GPU still shares (cross-instance) — this is 5001 vs 5007
const inst2 = base.replace('--port 5001', '--port 5007').replace('--main-gpu 0', '--main-gpu 2');
ok(fp(inst2, { port: 5007 }) === b, 'identical config, different port → SAME fp (cross-instance sharing preserved)');

// 2) ctx-size still ignored (ctx-agnostic restore)
ok(fp(base.replace('--ctx-size 528244', '--ctx-size 262144'), { port: 5001 }) === b, 'ctx-size change → SAME fp (still ignored)');

// 3) tensor-split / parallel / gpu-layers still ignored
ok(fp(base.replace('--parallel 2', '--parallel 4').replace('--tensor-split 1.00,1.00', '--tensor-split 0.5,1.5'), { port: 5001 }) === b, 'parallel/tensor-split change → SAME fp');

// 4) NEW: spec-type discriminates
ok(fp(base.replace('--spec-type draft-mtp', '--spec-type none'), { port: 5001 }) !== b, 'different spec-type → DIFFERENT fp');
ok(fp(base.replace(' --spec-type draft-mtp', ''), { port: 5001 }) !== b, 'spec-type removed → DIFFERENT fp');

// 5) NEW: ctx-checkpoints discriminates
ok(fp(base.replace('--ctx-checkpoints 64', '--ctx-checkpoints 32'), { port: 5001 }) !== b, 'different ctx-checkpoints → DIFFERENT fp');

// 6) existing discriminators still work
ok(fp(base.replace('--flash-attn auto', '--flash-attn off'), { port: 5001 }) !== b, 'flash-attn change → DIFFERENT fp');
ok(fp(base.replace('--cache-type-k q8_0', '--cache-type-k f16'), { port: 5001 }) !== b, 'cache-type-k change → DIFFERENT fp');

// 7) checkpoint-min-step (content, not structure) must NOT be picked up by the ctx-checkpoints regex
const withMinStep = base + ' --checkpoint-min-step 4096';
ok(fp(withMinStep, { port: 5001 }) === fp(withMinStep.replace('--checkpoint-min-step 4096', '--checkpoint-min-step 8192'), { port: 5001 }), 'checkpoint-min-step ignored (not a KV_LAYOUT_PARAM, no regex bleed)');


// ─────────────────────────────────────────────────────────────────────────────
// vLLM fingerprint — the model is POSITIONAL (`vllm serve <path>`), so unlike the
// llama.cpp `--model <path>` form it is exposed to line-continuation formatting.
// ─────────────────────────────────────────────────────────────────────────────
const vfp = (cmd) => computeVllmKvFingerprint(cmd);

// A generated launcher: every flag on its own line, trailing backslashes, model wrapped in the
// model-cache helper. This is the shape that actually reaches computeVllmKvFingerprint.
const vBase = [
  "/opt/conda/envs/1cat-vllm-sm70-130/bin/vllm serve \\",
  "  $(mc '/models/Qwen3.8/27B-INT8-W8A16-MTP') \\",
  '  --port 5003 \\',
  '  --tensor-parallel-size 4 \\',
  '  --dtype half \\',
  '  --served-model-name Qwen3.8-27B-INT8-MM-Think_Preserve-256k',
].join('\n');

// 8) REGRESSION: `serve` is followed by "\<newline>", and a backslash is not \s. Before the fix
// the match failed, modelName came back '', and the key collapsed to a generic `vllm-tp4-<hash>`
// SHARED by every vLLM service at that TP/dtype. Block keys hash tokens rather than weights, so
// a shared pool can hand a rank another model's KV for identical text.
ok(vfp(vBase).modelName === 'Qwen3.8/27B-INT8-W8A16-MTP', 'multi-line launcher → model name parsed (line continuations unfolded)');
ok(!vfp(vBase).dirName.startsWith('vllm-tp'), 'multi-line launcher → model-specific dir, not the generic fallback');

// 9) the single-line form must keep working
const vOneLine = "/opt/.../bin/vllm serve /models/Qwen3.8/27B-INT8-W8A16-MTP --tensor-parallel-size 4 --dtype half";
ok(vfp(vOneLine).modelName === 'Qwen3.8/27B-INT8-W8A16-MTP', 'single-line launcher → model name parsed');

// 10) two DIFFERENT models at the same TP/dtype must never land in the same pool — the exact
// collision the empty-name fallback used to cause.
const vOther = vBase.replace('Qwen3.8/27B-INT8-W8A16-MTP', 'Qwen3.5/9B-INT8');
ok(vfp(vOther).optaneDir !== vfp(vBase).optaneDir, 'different model → DIFFERENT optane dir');

// 11) TP is part of the key: offloaded blocks are written per rank, so a TP4 pool is not
// reusable at TP1.
ok(vfp(vBase.replace('--tensor-parallel-size 4', '--tensor-parallel-size 1')).fp !== vfp(vBase).fp, 'different TP → DIFFERENT fp');

// 12) dtype changes the bytes on disk
ok(vfp(vBase.replace('--dtype half', '--dtype bfloat16')).fp !== vfp(vBase).fp, 'different dtype → DIFFERENT fp');

// 13) port must NOT be in the key — a service that returns on another port still finds its blocks
ok(vfp(vBase.replace('--port 5003', '--port 5011')).optaneDir === vfp(vBase).optaneDir, 'different port → SAME optane dir');

// 14) --served-model-name is cosmetic and must not shift the key
ok(vfp(vBase.replace('Qwen3.8-27B-INT8-MM-Think_Preserve-256k', 'some-alias')).optaneDir === vfp(vBase).optaneDir, 'served-model-name change → SAME optane dir');

console.log(`\nfingerprint: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
