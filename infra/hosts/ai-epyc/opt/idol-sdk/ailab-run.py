"""claude1 2026-11-03: Idol image -> Gaussian splat (.ply) on the ai-epyc 4090, fully local weights.
Usage: ailab-run.py <out_dir> <image>... [--mode real|synthetic] [--gaussians N]
(IdolPipeline.from_pretrained always calls the Hub, so this builds the pipeline from the local folder directly.)
IDOL_OPTIMIZE defaults to 0: on this box (torch 2.6+cu124, RTX 4090) optimize=True (cuDNN attention + TF32 +
batched CFG) produced input-independent purple blobs, even for the bundled demo images. Eager mode is correct."""
import os, sys, time, json, argparse
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID"); os.environ.setdefault("HF_HUB_OFFLINE", "1")
ap = argparse.ArgumentParser(); ap.add_argument("out"); ap.add_argument("images", nargs="+")
ap.add_argument("--mode", default="real"); ap.add_argument("--gaussians", type=int, default=1_048_576)
ap.add_argument("--seed", type=int, default=42)
a = ap.parse_args()
import torch
from idol.pipeline import IdolPipeline
t = time.time(); pipe = IdolPipeline("/opt/idol-sdk/ailab-models/idol", optimize=os.environ.get("IDOL_OPTIMIZE", "0") == "1", dinov3_dtype=os.environ.get("IDOL_DINOV3_DTYPE", "bf16")); load_s = round(time.time() - t, 1)
for img in a.images:
    n = os.path.splitext(os.path.basename(img))[0]; o = os.path.join(a.out, n); os.makedirs(o, exist_ok=True)
    torch.cuda.reset_peak_memory_stats(); t = time.time()
    out = pipe(img, mode=a.mode, seed=a.seed, num_gaussians=a.gaussians, verbose=False)
    st = {"image": img, "mode": a.mode, "gaussians": a.gaussians, "load_s": load_s, "run_s": round(time.time() - t, 1),
          "peak_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}
    out.gaussian.save_ply(os.path.join(o, "splat.ply")); out.preprocessed_image.save(os.path.join(o, "input.png"))
    json.dump(st, open(os.path.join(o, "stats.json"), "w"), indent=2); print(n, st, flush=True)
print("IDOL-DONE")
