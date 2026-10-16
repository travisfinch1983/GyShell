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
| comfyui-ailab-pack | `0001-lora-loaders-forward-lora_metadata.patch` | pack files dated 2026-10-11 (not a git checkout), ComfyUI core `7fbcfa8b` | ai-epyc `/opt/comfyui/custom_nodes/comfyui-ailab-pack/remote_models.py` (8189/8190/8191 restarted) | Pack's LoRA monkey-patches had the old 5-arg signature; core now calls `load_lora_for_models(..., lora_metadata=)`, so EVERY stock LoraLoader/ModelOnly died with a TypeError. Wrappers now forward `*a, **kw`. Deployed 2026-10-14 by claude1. |
| comfyui-ailab-pack | `0002-lora-stack-weight-alias.patch` | pack after 0001 | ai-epyc + ai-gpu `/opt/comfyui/custom_nodes/comfyui-ailab-pack/lora_stack.py` | AILabLoraStack silently used 1.0 when an entry said `weight` (or `strength`); those now set both strength_model and strength_clip, explicit strengths still win. claude2, 2026-10-15. |
| comfyui-ailab-pack | `0003-pe-heretic-router.patch` | pack after 0002 | ai-epyc + ai-gpu pack: `pe_proxy.py`, `prompt_builder.py`, new `pe_common.py` | Qwen-Image 2.1 PE moved to two Heretic builds behind one llama.cpp router (`qwen-image-2.1-pe-t2i-heretic` / `-i2i-heretic`, AI-Lab llama-server-5007); old id gone. PE node model `auto` (t2i without images, i2i with; the retired id maps the same way), bundled `system_prompt.txt` sent when no system prompt is wired (the Heretic builds ramble without it), `X-AILab-No-Fallback: 1`, model check accepts any t2i/i2i PE, new outputs `wh_ratio` / `ratio_follow`. Prompt Builder: retired id mapped, bundled system prompt when the section's is empty, no-fallback header. claude2, 2026-10-16. |
| ailab-modelsvc (our own image model service, not a git checkout) | `ailab-modelsvc/0001-llm-cache-kind.patch` | `/opt/ailab-modelsvc` of 2026-10-11 | ai-epyc (9312 restarted 2026-10-16) + ai-gpu (9310: takes effect at its next restart) `serve.py`, `modelsvc/tiers.py` | Cache-only kind `llm`: files another server loads (the Qwen PE router's GGUFs), names relative to `/models`, not listed in the catalog, refused by /models/load. /models is a CIFS mount inside the CT the host copy can't read, so `llm` files are staged into the disk tier first and RAM is filled from there. `POST /cache/warm {kind,name,use,wait}`: `use` counts a use (score/last), `wait` replies with {path, tier}. RAM quota for llm set to 24 GB on ai-epyc. claude2, 2026-10-16. |

Related, tracked elsewhere in this repo:
- `infra/modelsvc-plugins/` - Image Model Service plugins (USP) + `usp-constraints.txt` (the pip constraints that keep a
  CUDA-13 torch, which has no Volta support, out of the ailab-modelsvc env).
- `infra/hosts/px-epyc/` - host-level files (5060 Ti clock cap, thermal recorder, zram swap).
- Fleet adapter changes go to its own repo (`/opt/fleet-channel`, origin on gitea).
