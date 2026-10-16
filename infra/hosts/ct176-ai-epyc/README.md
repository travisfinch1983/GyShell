# CT176 ai-epyc (px-epyc) — hand-placed host files

| File | Why | Deployed |
|---|---|---|
| `opt/conda/envs/faster-whisper/lib/python3.12/site-packages/sitecustomize.py` | faster-whisper's CTranslate2 needs cuBLAS 12 + cuDNN 9 from its pip `nvidia-*` packages (`/usr/local/cuda` is 13.3). Preloaded per-env. **Replaces** the earlier `/etc/ld.so.conf.d/faster-whisper-cuda.conf` (REMOVED 2026-10-12): being global, it fed this env's cuDNN 9.24 to chatterbox TTS (cuDNN 9.20) -> `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`, every TTS request 500'd. Never put a per-env lib dir in ld.so.conf.d. Same step is now in `infra/provider-scripts/providers/faster-whisper.sh`. | 2026-10-12 |

## Qwen-Image PE router (2026-10-16)
`opt/proxlab/presets/qwen-pe-router.sh`: launcher for AI-Lab service **llama-server-5007** on RTX 5060 Ti #2.
It runs one llama-server in llama.cpp **router mode** (`--models-max 1`) serving both
`qwen-image-2.1-pe-t2i-heretic` and `qwen-image-2.1-pe-i2i-heretic`. Both IDs are always listed, and requesting
the unloaded one swaps it in (~3.5 s direct, ~5 s via the proxy). It replaces the always-on V100 pair (5001/5005)
and the suspend/start pair (5006/5009), which are kept suspended for rollback.
Launched via `POST /api/ai/launch-service` with command
`/opt/proxlab/presets/qwen-pe-router.sh --host 0.0.0.0 --port 5007 --models-max 1` and no aliasOverride, so the
proxy learns both IDs from the router's /v1/models. Files resolve `/model-cache/<rel>` → `/models/<rel>`
(claude2 is extending the image model service's RAM+disk tiers to manage them unpinned).
