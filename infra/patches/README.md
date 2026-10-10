# Patches to third-party applications

Every local change to an application we run lives here (Travis, 2026-10-10: "any changes we made to any
applications we use, or any patches should be stored in gitea so they are tracked"). One folder per application;
each patch says what it is against, where it is deployed, and how to re-apply it after an upgrade wipes it.

Re-apply: `cd <deployed path> && patch -p1 < <file>` (or `git apply` where the target is a git checkout).
Check first: `patch -p1 --dry-run -R < <file>` succeeding means it is already applied.

| Application | Patch | Against | Deployed at | Why |
|---|---|---|---|---|
| ComfyUI (core) | `comfyui/core-minimax-h3-fp16.patch` | ComfyUI git `7fbcfa8b` (2026-09-28) | ai-gpu `/opt/comfyui` (also the `/opt/comfyui-raylight` worktree base) | MiniMax-H3 fp16 residual-stream overflow on V100 (no bf16 on sm_70). See memory `project_h3_fp16_residual_overflow`. |
| ComfyUI-GGUF | `comfyui-gguf/krea2-arch.patch` | ComfyUI-GGUF 1.1.10 (registry copy, not a git checkout; file has CRLF line endings) | ai-gpu + ai-epyc `/opt/comfyui/custom_nodes/ComfyUI-GGUF/loader.py` | Adds `krea2` to `IMG_ARCH_LIST`, otherwise Krea 2 GGUFs fail with "unexpected architecture". ai-epyc's ComfyUI 8188 picks it up on its next restart. |
| raylight | `raylight/krea2-gguf.patch` | komikndr/raylight `74f5def` | ai-gpu `/opt/ailab-modelsvc/vendor/raylight` (vendored for the USP plugin) and `/opt/comfyui-raylight/custom_nodes/raylight` (test bed) | The same `krea2` arch fix in raylight's bundled copy of the GGUF loader. |

Related, tracked elsewhere in this repo:
- `infra/modelsvc-plugins/` - Image Model Service plugins (USP) + `usp-constraints.txt` (the pip constraints that keep a
  CUDA-13 torch, which has no Volta support, out of the ailab-modelsvc env).
- `infra/hosts/px-epyc/` - host-level files (5060 Ti clock cap, thermal recorder, zram swap).
- Fleet adapter changes go to its own repo (`/opt/fleet-channel`, origin on gitea).
