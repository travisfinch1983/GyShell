# Hunyuan3D-2.1 on ai-epyc (RTX 4090)

Image → 3D (shape + PBR texture). Upstream: https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1 @ 82920d6,
cloned to `/opt/hunyuan3d21`; conda env `hunyuan3d21` (py3.10, torch 2.5.1+cu124). Weights are the local
copy in `/imagegen/3d-models/Hunyuan3D-2.1` (no Hub calls, except `facebook/dinov2-giant`, cached once in
`~/.cache/huggingface`). Set up 2026-11-03 by claude1 as the baseline for the image-to-3D bake-off.

| File | What |
|---|---|
| `ailab-install.sh` | Rebuilds the env + both extensions (custom_rasterizer, mesh_inpaint_processor) + RealESRGAN ckpt. Idempotent. |
| `ailab-run.py <image> <out> [--no-texture] [--mesh shape.glb] [--views 6] [--res 512]` | Shape → `shape.glb`, texture → `textured.obj/.jpg` + `_metallic/_roughness` maps + albedo-only `textured.glb`; `stats.json` timings/peak VRAM. |
| `ailab-preview.py <out>` | Contact sheet `preview.png`: input + 4 albedo views, 4 normal-shaded shape views. |

Run on the 4090: `CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=4 /opt/conda/envs/hunyuan3d21/bin/python ailab-run.py ...`

Install traps hit (all handled in `ailab-install.sh`):
- `bpy==4.0` is gone from PyPI → skipped; patch 0001 makes the import optional (GLB via trimesh instead).
- onnxruntime 1.16.3 needs an executable stack; Debian 13 glibc refuses → 1.20.1.
- setuptools 81+ dropped `pkg_resources` (lightning_fabric imports it) → `setuptools<81`.
- `/opt/cuda-12.9` has no cusparse headers → `CPATH` from torch's `nvidia/*/include` wheels.
- `set -e` does not stop inside `a && b && c` chains: one step per line.

Demo (upstream penguin, 4090): shape ~2 min / 9.5 GB; texture 52 s / 13.4 GB peak (+89 s first load).
Outputs: `/imagegen/3d-tests/hunyuan21/<object>/`.
