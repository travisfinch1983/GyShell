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
LoRAs: merged into each worker's weights at group spawn (raylight RAY_LORA list); the warm group is keyed by
model + LoRAs + GPUs, so changing LoRAs costs a respawn (~16 s + load). Verified 2026-10-10 with a trained Krea 2
LoRA: USP+LoRA matches the single-GPU+LoRA render in content (not pixels), and differs clearly from no-LoRA.

🛑 Ray must be started from a LONG-LIVED thread: its GCS/raylet carry PR_SET_PDEATHSIG, which fires when the
starting THREAD exits. ray.init inside a request handler killed Ray ~1 s after the client disconnected, and Ray's
driver then terminated the whole service. usp.py runs every ray.init/kill on its own `usp-ray` thread, and uses
its own RAYLIGHT_RAY_TMPDIR (raylight rmtree()s that dir on every init, so a shared one is unsafe).

Known gaps: one warm group per service; a client that drops without `usp_end` leaves its run record (the lease
itself is reclaimed by the service's idle revocation); first run after idle is ~8 s slower.

## te_split.py - text encoders held across 2 GPUs

Any text encoder (largest block list by bytes: Qwen/Llama `layers`, T5 `block`, ...) loaded once and pipeline-split
across two cards, balanced by bytes, always resident, outside ComfyUI's model manager. Needs the core hook in
`serve-teclaim-claude1.patch` (`PluginAPI.claim_te`; merged into claude2's serve.py 2026-10-10). Config
`/opt/ailab-modelsvc/te_split-<port>.json`; `GET/POST /te_split`, `POST /te_split/remove {model}`.
Encodes with LoRAs, or for encoders not on the split list, fall through to core.

Verified on svc-9310 (V100 #4+#5), Qwen 2.1 BF16 qwen3vl 8B: 8.66 + 8.88 GB, 0.2 s/encode, output equals an fp32 CPU
reference to 0.0004%; a full ComfyUI render is pixel-identical to core's single-card path.

## fp16 UNets on V100 (`serve-fp16keep-claude1.patch`, core)

ComfyUI lists Qwen 2.1 as bf16/fp32-only, so V100 (no bf16) upcasts its fp16 file to fp32: 28.5 GB, 4.2x slower.
`FP16_KEEP` (env `AILAB_FP16_KEEP`, default Qwen_2.1 *fp16* files) loads them as fp16 on cards without bf16.
Measured (tests/qwen21_fp16_test.py, 2048^2-equivalent latent, 8 steps): fp16 vs fp32 compute 0.20% latent drift,
53.9 dB image PSNR; 14.2 GB. At 1024^2 in the service: 1.1 s/step, fitting beside the te_split half on each card.
Verified on ONE prompt/model (turbo, cfg 1): check high-res / high-CFG base / strong-LoRA runs before widening it.

## qwen_edit.py - Qwen Image 2.1 edits, end to end in the service

`qwen_edit.py` + `qwen_edit_pe_system.md` -> `/opt/ailab-modelsvc/plugins/` on the service holding the Qwen 2.1 UNet
(ai-epyc 9312, installed 2026-10-10). AI-Lab's native tools call it instead of a ComfyUI workflow (Travis: ComfyUI
"is just adding a weak link in a chain"). First user: Training Images -> 🧽 Remove watermark (imagegen.js
`/api/imagegen/watermark*`).

Reproduces Travis's graph `Qwen_21_Watermark_removal_EN_proxyPE` with ComfyUI's LIBRARY code, no ComfyUI server:
prompt enhancer (qwen-image-2.1-pe-i2i via the AI-Lab LLM proxy, sees the image; system prompt = node 633, saved as
the .md) -> `TextEncodeQwenImage21` (image as reference, resolution 1088) -> `nodes.common_ksampler` euler/simple
cfg 1, 35 steps, Image-Consistency LoRA on a per-run clone of the resident UNet -> VAE decode. The text encoder runs
where the AI-Lab catalog says it is resident (9310's te_split today) over the wire `encode` op; tokenizing is local.

`GET /qwen_edit` -> `{ok, unet, te, vae, resident, busy}`. `POST /qwen_edit {path (under /imagegen) | image (b64),
prompt, enhance, seed, steps, cfg, sampler, scheduler, resolution, loras, unet, te, vae, lane, who}` ->
`{image (b64 PNG at model resolution), prompt (as sampled), enhanced, seed, width, height, seconds}`.

Measured on the watermark test image (1570x1600): PE 3.4 s, encode 6.7 s, 35 steps 44 s on the 4090 (1.1 s/step),
~72 s cold. Change map vs Travis's ComfyUI run: correlation 1.00 (8x8 grid of mean |diff|).
