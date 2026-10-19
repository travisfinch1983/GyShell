# Qwen3.8-27B: llama.cpp vs 1Cat-vLLM battery (2026-10-19)

HauhauCS Qwen3.8-27B-Uncensored-Aggressive on 4x V100 (ai-gpu 8a-8d). llama.cpp ran the Q8_K_P
GGUF; 1Cat ran the gguf2hf-converted W8A16 (`infra/quant/gguf2hf`). `bench27.py` is engine-agnostic:
real agent-session prompts at random offsets, gen 1536, TTFT counts reasoning tokens, and the
concurrency test reports a STEADY aggregate (the window where every stream is decoding).
Results: `summary.json`, Postgres `benchmarks.runs` ids 39-47, RAG
`qwen38_27b_hauhau_llamacpp_vs_1cat_bench_20261019`. `python3 summarize.py` rebuilds the tables.
The `after_*.sh` scripts are the one-off sequencing used on the day.
