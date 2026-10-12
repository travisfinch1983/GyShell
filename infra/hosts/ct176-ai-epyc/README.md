# CT176 ai-epyc (px-epyc) — hand-placed host files

| File | Why | Deployed |
|---|---|---|
| `opt/conda/envs/faster-whisper/lib/python3.12/site-packages/sitecustomize.py` | faster-whisper's CTranslate2 needs cuBLAS 12 + cuDNN 9 from its pip `nvidia-*` packages (`/usr/local/cuda` is 13.3). Preloaded per-env. **Replaces** the earlier `/etc/ld.so.conf.d/faster-whisper-cuda.conf` (REMOVED 2026-10-12): being global, it fed this env's cuDNN 9.24 to chatterbox TTS (cuDNN 9.20) -> `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`, every TTS request 500'd. Never put a per-env lib dir in ld.so.conf.d. Same step is now in `infra/provider-scripts/providers/faster-whisper.sh`. | 2026-10-12 |
