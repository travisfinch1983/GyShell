# CT176 ai-epyc (px-epyc) — hand-placed host files

| File | Why | Deployed |
|---|---|---|
| `opt/conda/envs/faster-whisper/lib/python3.12/site-packages/sitecustomize.py` | faster-whisper's CTranslate2 needs cuBLAS 12 + cuDNN 9 from its pip `nvidia-*` packages (`/usr/local/cuda` is 13.3). Preloaded per-env. **Replaces** the earlier `/etc/ld.so.conf.d/faster-whisper-cuda.conf` (REMOVED 2026-10-12): being global, it fed this env's cuDNN 9.24 to chatterbox TTS (cuDNN 9.20) -> `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`, every TTS request 500'd. Never put a per-env lib dir in ld.so.conf.d. Same step is now in `infra/provider-scripts/providers/faster-whisper.sh`. | 2026-10-12 |

## Qwen-Image PE router: RETIRED 2026-10-16 (same day)
The hand-launched router service llama-server-5007 (`opt/proxlab/presets/qwen-pe-router.sh`, now deleted from
this repo, and `.RETIRED-20261016` on the host) was replaced by the Image Model Service's **pe_llm** plugin
(claude2, ai-lab a7354c4d): imagegen-models-9310 supervises one llama.cpp router on :9390 pinned to 5060 Ti #2,
fed from the modelsvc llm cache tiers. The AI-Lab proxy discovers it via `GET <imagegen-models>/pe/status`
(virtual llm backend) and reports PE use to that service's /cache/warm. The old service also had NO working
GPU pin: its child was spread across all 5 cards (~9 GB).
