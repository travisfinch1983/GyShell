# gguf2hf: GGUF-only releases → 1Cat-vLLM W8A16

For models that ship only as GGUF (for example HauhauCS abliterations). Covers the llama.cpp
`qwen35` architecture, which is Qwen3.5/3.6/3.8 dense (`Qwen3_5ForConditionalGeneration`).
Everything runs on CPU on ai-gpu, with env `/opt/conda/envs/llmc` and
`PYTHONPATH=/opt/llama-fastmtp/src/gguf-py`.

| file | role |
|---|---|
| `gguf2hf_qwen35.py <model.gguf> <template_hf_dir> <out> [--check-mmproj <mmproj.gguf>]` | Dequantizes the GGUF to HF BF16 safetensors and inverts every transform llama.cpp applies (see the docstring). Takes config, tokenizer and the vision tower from the template dir. `--check-mmproj` first proves the release's mmproj equals the template's vision tower. |
| `validate_roundtrip.py <stock.gguf> <stock_hf_dir>` | Runs the converter on a stock GGUF and compares every tensor against stock BF16. Run it after any llama.cpp converter change. |
| `quantize_hauhau.py` | Dequantized dir → W8A16 with the production layout. Grafts the BF16 MTP head from the GGUF's `nextn` tensors. |
| `double_rounding.py` | Simulates the Q8_0→g128 double rounding on stock weights. |

Pipeline: run `gguf2hf_qwen35.py`, then `quantize_hauhau.py`, then
`../qwen38-27b/restore_unquantized.py <quant> <dequantized dir>`.

## Validation (stock unsloth Qwen3.8-27B Q8_K_XL vs stock BF16, 2026-10-18)

- **BF16/F32-stored tensors:** bit-exact. That covers attention q/k/v, `lm_head`, `mtp.fc`,
  `A_log`, `dt_bias`, conv1d and every norm. Input/post norms differ by ≤1.3e-7 from the f32 −1.
- **Q8_0 tensors:** cosine ≥ 0.999975, global max relative error ≤ 0.6%. Per-block error is within
  the 8-bit bound, except blocks whose fp16 scale is subnormal (blockmax < 7.8e-3). Those show
  absolute error ~3e-6. That is the GGUF's own rounding, not the converter.
- A V-head reorder or norm-offset bug would show as cosine far below 0.999 on whole row ranges.
  None did.

## Double rounding (Q8_0 → W8A16 g128)

RMS weight error is **1.21×** that of quantizing the original BF16 directly (six tensor kinds,
range 1.20–1.22). Directly quantized W8A16 measured 1.0011× perplexity against BF16, so a
GGUF-sourced W8A16 should still land well under 1% (an estimate, not a measurement).

## Gotchas

- llama.cpp splits the vision Conv3d patch embed into `v.patch_embd.weight` and `.weight.1`
  (temporal halves). Stack them on dim 2.
- gguf-py's generic Q8_0 dequant is about 100× too slow for 27B. Use the vectorized path in `dequant()`.
- Never name a script `inspect.py` next to these files: it shadows the stdlib and breaks numpy's import.
