# Model-service plugins (claude1)

`usp.py` -> `/opt/ailab-modelsvc/plugins/usp.py` on a host whose Image Model Service has NVLinked GPUs (px-gpu V100s).
Sequence-parallel (xDiT Ulysses via raylight) UNet runs, driven by the Remote UNET node's `multi_gpu: usp (N GPUs)`.

Install on a host (done on ai-gpu 2026-10-10):
1. Env: `ray==2.59.0 xfuser==0.7.0 yunchang==0.6.4` into `/opt/conda/envs/ailab-modelsvc`, with
   `-c /opt/ailab-modelsvc/usp-constraints.txt` (`torch==2.10.0+cu128`, `nvidia-nccl-cu12==2.27.5`) so pip
   cannot pull a CUDA-13 torch (no Volta). Snapshot first (`conda list --explicit`, `pip freeze`).
2. Vendor raylight at `/opt/ailab-modelsvc/vendor/raylight` (commit 74f5def, see VENDORED_FROM_COMMIT) with
   `"krea2"` added to `IMG_ARCH_LIST` in `src/raylight/expansion/comfyui_gguf/loader.py`.
3. Restart the service; the log shows `usp plugin ready`. `GET /usp/status` shows the warm group.

Measured (2x V100 NV2, Krea 2 Turbo int8, 8 steps, 1024^2): sampling 15.3 s USP vs 25.1 s one GPU (1.64x).
Output is not bit-identical to one GPU (fp16 split). Allowed models: env `USP_MODELS` (default Krea 2).
Known gaps: no LoRAs; one warm group per service; a client that drops without `usp_end` leaves its run
record (the lease itself is reclaimed by the service's idle revocation); first run after idle is ~8 s slower.
