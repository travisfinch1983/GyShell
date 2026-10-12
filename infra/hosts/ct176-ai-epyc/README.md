# CT176 ai-epyc (px-epyc) — hand-placed host files

| File | Why | Deployed |
|---|---|---|
| `etc/ld.so.conf.d/faster-whisper-cuda.conf` | `/usr/local/cuda` is CUDA 13.3 (no `libcublas.so.12`). CTranslate2 loads cuBLAS lazily, so faster-whisper started clean and 500'd on EVERY transcription. This is the step `scripts/providers/faster-whisper.sh` performs on install; this env predated it. Run `ldconfig` after placing. | 2026-10-12 |
