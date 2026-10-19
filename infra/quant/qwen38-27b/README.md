# Qwen3.8-27B W8A16 quants for 1Cat-vLLM on the V100s

Scripts run on **ai-gpu** (CT177). The quant runs CPU-only in `/opt/conda/envs/llmc`
(llmcompressor 0.13, transformers 5.14.1). Serving uses `/opt/conda/envs/1cat-vllm-sm70-150`.

| script | what it does |
|---|---|
| `quantize_38_uncensored.py` | BF16 → compressed-tensors W8A16 (INT8 sym, group 128, RTN, ~4 min). Ignore list mirrors production (`lm_head`, vision, MTP, GDN `in_proj_a`/`in_proj_b`). Grafts the BF16 MTP head back as `model_mtp.safetensors`. Writes to local disk, never to CIFS. |
| `restore_unquantized.py <out> <src>` | Copies every unquantized tensor back bit-exact from the source. Repairs the norm damage from llmcompressor's (1+w) offset round trip. |
| `ppl_score.py` | Scores realised-token logprobs (`prompt_logprobs=0`) on filtered held-out agent prose. `--compare` gives the paired ratio and 95% CI. |
| `ppl_chain.sh` | Runs five TP4 perplexity legs back to back on GPUs 8a-8d. Production 5003 must be suspended first. |

## Results (2026-10-18, 47,351 tokens)

| comparison | paired ratio | 95% CI |
|---|---|---|
| production quant vs stock BF16 | 1.00119x | [1.00039, 1.00199] |
| production with norms repaired vs damaged | 0.99973x | [0.99912, 1.00034], not distinguishable |
| Uncensored (Heretic) BF16 vs stock BF16 | 1.01971x | [1.01726, 1.02218] (cost of the abliteration) |
| Uncensored W8A16 vs its BF16 | 1.00114x | [1.00015, 1.00213] |

Output: `/models/Qwen3.8/27B-Uncensored/W8A16-Int8-MTP`. It is a drop-in for `1cat-vllm-5003.sh`
(DFlash2 works: 81-95 tok/s, mean acceptance 2.7-3.0).
