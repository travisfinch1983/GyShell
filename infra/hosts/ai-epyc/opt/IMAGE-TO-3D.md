# Image-to-3D bake-off on ai-epyc (RTX 4090) — 2026-11-03, claude1

All four run fully offline from Travis's local weights in `/imagegen/3d-models` (CT176 view).
Results: `/imagegen/3d-tests/<model>/<object>/`. Test objects: vape pen, Wi-Fi adapter, thermos
(`/imagegen/3d-tests/photos`, phone shots on cluttered desks).

| Model | Dir / env | Input | Output | Time / VRAM (4090) |
|---|---|---|---|---|
| Hunyuan3D-2.1 | `/opt/hunyuan3d21`, `hunyuan3d21` | 1 image | mesh + PBR (OBJ, GLB) | ~3 min, 9.5 GB shape / 13.4 GB paint |
| TRELLIS.2-4B | `/opt/trellis2`, `trellis2` | 1 image | mesh + PBR GLB | ~25 s gen + 1-2 min GLB export (CPU), 3 GB (low_vram) |
| UniForge3D | `/opt/uniforge3d`, `uniforge3d` (clone of trellis2) | 2+ views, `001` frontal | mesh + PBR GLB | ~2.5-3 min, 12 GB |
| Idol | `/opt/idol-sdk`, `idol` | 1 image | **Gaussian splat .ply (no mesh)** | ~25 s, 5 GB |

Verdicts (each output rendered from 4 sides with `hunyuan3d21/ailab-preview-glb.py` / `idol-sdk/ailab-preview.py`):
- **TRELLIS.2**: the best single-view all-rounder. Colours are right (the vape pen's red→black), the unseen backs are plain and plausible, and the Wi-Fi antennas splay correctly with the cable attached.
- **Hunyuan3D-2.1**: the cleanest geometry on simple shapes (thermos, embossed YETI logo), but it washes out colour and invents detail on unseen sides (a figure embossed on the vape pen's back).
- **UniForge3D**: the only model that uses real detail from the other views (the vape pen's side OLED display). But it takes every photo literally: Travis's hand in thermos-4 became a lump on the handle, and ceiling reflections became paint blotches.
- **Idol**: the most faithful colour, but it outputs splats only, so it's not usable as CAD/mesh. 🛑 Its `optimize=True` default (cuDNN attention + TF32 + batched CFG) produced input-independent purple blobs on torch 2.6/cu124, even for its own demo images, so `ailab-run.py` defaults to eager mode (`IDOL_OPTIMIZE=0`). Not reported upstream yet.

Scale: every model outputs a unit-normalized mesh, never real dimensions. `hunyuan3d21/ailab-scale.py`
scales any GLB/OBJ to a known length/width/height (ft/in/m/mm) and reports each axis's proportion error.

Install traps (handled in each `ailab-install.sh`): an unpinned dep drags torch to 2.14 (pin with `-c`);
transformers 5.x renamed `DINOv3ViTModel.layer` (pin 4.57.3); `/opt/cuda-12.9` lacks cusparse headers
(`CPATH` from torch's nvidia wheels); SMB `/imagegen` can't hold symlinks; `set -e` doesn't stop inside `&&` chains.

## 2026-11-04: every GPU in the lab (AI-Lab "Image → 3D" tab, image model service plugin `image3d`)
One env recipe per model for all cards: `/opt/image3d-envs/build-cu128.sh <model>` (torch 2.9.1+cu128, which ships
sm_70..sm_120; xformers; extensions built for 7.0;8.6;8.9;12.0 with CUDA 12.9, which still supports Volta). Envs are
`<model>-cu128` on ai-epyc and ai-gpu. The plugin uses one only once `.image3d-ready` exists in it: the build writes
the marker after its import check, and the 2026-11-04 rollout wrote it by hand only after an end-to-end test.
Hunyuan's cu128 env uses its own repo copy `/opt/hunyuan3d21-cu128` (in-tree custom_rasterizer build).
Volta (V100) settings, applied by the plugin when compute capability < 8: TRELLIS `TRELLIS_MODEL_DIR=...-fp16`
(configs only; `make-fp16-variants.py`) + `FLEX_GEMM_ALGO=explicit_gemm` + FlexGEMM PR #34; UniForge
`UNIFORGE_AMP_DTYPE=float16` + `pipeline-fp16.json`; Idol `IDOL_VAE_DTYPE=fp32` + `IDOL_DINOV3_DTYPE=fp32`.
Attention is xformers everywhere (flash-attn has no Volta).

Verified 2026-11-04 (thermos / vape pen; each output rendered and compared with the 4090 one):

| Model | RTX 5060 Ti (16 GB) | V100 32 GB |
|---|---|---|
| Hunyuan3D-2.1 | shape 113 s + texture 72 s, 13.5 GB (worker keeps the shape model in RAM while texturing on <22 GB cards) | shape 93 s + texture 87 s, 12.8 GB standalone / 20 GB in the worker |
| TRELLIS.2 | ~2 min gen (first run) + 2 min export, 3 GB | 50 s gen + 9 min CPU export (ai-gpu's CPUs) |
| UniForge3D | 288 s (4 views), 12 GB | 352 s (4 views), 12.2 GB, fp16 + xformers routed attention |
| Idol | 81 s, 5 GB | 76 s, 7.8 GB (fp32 encoders) |

All four models are eligible on all 7 GPUs (4090, 4x 5060 Ti, 2x V100 on ai-gpu's image model service).
The old cu124 envs (`hunyuan3d21`, `trellis2`, `uniforge3d`, `idol` on ai-epyc) are now only the plugin's fallback,
used if a `-cu128` env loses its marker.
