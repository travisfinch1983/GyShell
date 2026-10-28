# CT198 ai-nas (px-nas) — AI-Lab agent container for the RTX 5060

Built 2026-10-28 (roadmap proj-mvsfbjthb9t). Registered as the px-nas agent
(`PUT /api/ai/agents/px-nas {vmid:198}`); the 5060 (`px-nas:0000:c1:00.0`) is pool mode
**`shared`** with `reserveMB: 2560` — Frigate CT170 (hand-configured NVIDIA mounts, ~1.9 GB) keeps
using the same card.

## What's inside (so the AI-Lab launch path works unchanged)
- Debian 13, NVIDIA **userspace only** = host driver 610.57.04, from the local store
  (`/mnt/zpoolalpha/nvidiadrivers/nvidia-driver-local-repo-debian13-610.57.04_*.deb`;
  packages `libcuda1 libnvidia-ml1 nvidia-smi libnvidia-ptxjitcompiler1`). **Bump it with the host driver.**
- vLLM **0.18.0** (torch 2.10+cu128, sm_120 OK) in a uv venv at `/opt/vllm`;
  `/opt/conda/envs/vllm -> /opt/vllm` so the UI's vllm template path resolves.
- `gcc libc6-dev` (Triton/inductor needs a C compiler), `tmux`, `iproute2` (`ss` for port allocation).
- `/models` = **rbind**, read-only, of `/mnt/flashpool/ai-assets/llm` (local, not CIFS). It must be
  rbind: every model family is its own ZFS dataset and a plain bind shows them empty.
- No `/model-cache`; `mc()` falls back to `/models`.

## Services
- `ailab-vllm-5013`: nvidia/llama-nemotron-rerank-vl-1b-v2, fp16, `--gpu-memory-utilization 0.60`,
  `--limit-mm-per-prompt '{"image":0}'` (text-only reranking), max-num-seqs 64. Weights alone are
  3.1 GiB, so 0.40 was too small. Steady at ~2.7–3.8 GB.
  - Bench vs the V100 (32 docs, same requests, 2026-10-28): short query 0.67 s vs 2.27 s (3.4x),
    1500-char query 1.17 s vs 7.40 s (6.3x); scores agree within 0.001.
  - The V100 copy (CT177 vllm-5013) stays registered with `poolPriority: 10` = standby: it takes
    traffic only when this one is benched or at its in-flight cap.

## px-nas host quirk fixed alongside
`/mnt/pve/px-data` on px-nas was an empty local dir while the real px-data storage is
`/mnt/zpoolalpha/pxdata`; AI-Lab writes hookscript vars to `/mnt/pve/px-data/snippets`, so they
landed nowhere. It is now a symlink to `/mnt/zpoolalpha/pxdata`.
