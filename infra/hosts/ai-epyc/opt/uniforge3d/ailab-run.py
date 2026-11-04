"""claude1 2026-11-03: UniForge3D multi-view photos -> textured GLB on the ai-epyc 4090, all weights local.
Usage: ailab-run.py <out_root> <case_dir>...   (each case_dir holds 001.*, 002.*, ... with 001 = frontal)
Config: /opt/uniforge3d/ailab-models/pipeline.json (HF copy, every Hub reference rewritten to a local path);
weights root /imagegen/3d-models/UniForge3D. Writes <out_root>/<case>/{prediction.glb,stats.json}."""
import os, sys, time, json
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID"); os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
from pathlib import Path
import torch
from uniforge3d import UniForge3DImageTo3DPipeline
SUF = {".png", ".jpg", ".jpeg", ".webp"}
out_root = Path(sys.argv[1])
t = time.time()
pipe = UniForge3DImageTo3DPipeline.from_config(os.environ.get("UNIFORGE_CONFIG", "/opt/uniforge3d/ailab-models/pipeline.json"),  # pipeline-fp16.json on V100
                                              
                                               weights_root="/imagegen/3d-models/UniForge3D", low_vram=True,
                                               local_files_only=True)
load_s = round(time.time() - t, 1)
for case in map(Path, sys.argv[2:]):
    imgs = sorted(p for p in case.iterdir() if p.suffix.lower() in SUF)
    o = out_root / case.name; o.mkdir(parents=True, exist_ok=True)
    torch.cuda.reset_peak_memory_stats(); t = time.time()
    pipe.run(imgs, o / "prediction.glb", overwrite=True)
    st = {"case": str(case), "views": [p.name for p in imgs], "load_s": load_s, "run_s": round(time.time() - t, 1),
          "peak_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}
    json.dump(st, open(o / "stats.json", "w"), indent=2); print(case.name, st, flush=True)
print("UNIFORGE-DONE")
