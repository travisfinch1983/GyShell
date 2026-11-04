"""claude1 2026-11-03: TRELLIS.2-4B image -> textured GLB on the ai-epyc 4090, all weights local
(/opt/trellis2/ailab-models/TRELLIS.2-4B: pipeline.json rewritten to local DINOv3-ViT-L / RMBG-2.0 / ckpts).
Usage: ailab-run.py <out_root> <image>... [--seed 42] [--pipeline 1024_cascade]
Writes <out_root>/<stem>/{model.glb,input.png,stats.json}."""
import os, sys, time, json, argparse
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID"); os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
sys.path.insert(0, "/opt/trellis2")
ap = argparse.ArgumentParser(); ap.add_argument("out"); ap.add_argument("images", nargs="+")
ap.add_argument("--seed", type=int, default=42); ap.add_argument("--pipeline", default=None)
a = ap.parse_args()
import torch
from PIL import Image, ImageOps
from trellis2.pipelines import Trellis2ImageTo3DPipeline
import o_voxel
t = time.time(); pipe = Trellis2ImageTo3DPipeline.from_pretrained(os.environ.get("TRELLIS_MODEL_DIR", "/opt/trellis2/ailab-models/TRELLIS.2-4B")); pipe.cuda()  # TRELLIS_MODEL_DIR=...-fp16 on V100
load_s = round(time.time() - t, 1)
for img in a.images:
    n = os.path.splitext(os.path.basename(img))[0]; o = os.path.join(a.out, n); os.makedirs(o, exist_ok=True)
    im = ImageOps.exif_transpose(Image.open(img)); im.thumbnail((2048, 2048))
    torch.cuda.reset_peak_memory_stats(); t = time.time()
    kw = {"seed": a.seed}
    if a.pipeline: kw["pipeline_type"] = a.pipeline
    mesh = pipe.run(im, **kw)[0]
    gen_s = round(time.time() - t, 1); peak = round(torch.cuda.max_memory_allocated() / 2**30, 2)
    mesh.simplify(16777216)
    t = time.time()
    glb = o_voxel.postprocess.to_glb(vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs,
        coords=mesh.coords, attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]], decimation_target=1000000, texture_size=4096,
        remesh=True, remesh_band=1, remesh_project=0, verbose=False)
    glb.export(os.path.join(o, "model.glb"))
    st = {"image": img, "load_s": load_s, "gen_s": gen_s, "export_s": round(time.time() - t, 1), "peak_gb": peak,
          "gpu": torch.cuda.get_device_name(0)}
    json.dump(st, open(os.path.join(o, "stats.json"), "w"), indent=2); print(n, st, flush=True)
    del mesh, glb; torch.cuda.empty_cache()
print("TRELLIS-DONE")
