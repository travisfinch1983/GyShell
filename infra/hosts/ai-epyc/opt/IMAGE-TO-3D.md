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
