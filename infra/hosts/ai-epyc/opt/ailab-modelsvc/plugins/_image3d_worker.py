"""Image -> 3D worker for the image model service's image3d plugin (claude1 2026-11-03).
Runs INSIDE the model's own conda env (hunyuan3d21 / trellis2 / uniforge3d / idol), one process per (model, GPU), pinned with
CUDA_VISIBLE_DEVICES = the card's UUID. Protocol: JSON lines. stdin {"cmd": "run", "inputs": [paths], "out": dir, "options": {}}
or {"cmd": "quit"}; stdout lines prefixed "@@" are protocol: @@{"ready": true} once loaded, @@{"progress": stage, "frac": x}
during a run, @@{"done": {...}} / @@{"error": "..."} at the end. Everything else on stdout/stderr is log text.
The adapters mirror the runners verified in the 2026-11-03 bake-off (infra/hosts/ai-epyc/opt/*/ailab-run.py)."""
import json, os, sys, time, traceback, argparse
ap = argparse.ArgumentParser(); ap.add_argument("--model", required=True); A = ap.parse_args()
os.environ.setdefault("HF_HUB_OFFLINE", "1"); os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
_out = sys.stdout; sys.stdout = sys.stderr            # library prints go to the log, the protocol has stdout to itself


def emit(**kw):
    try:    # VRAM this process holds (allocator reserve + ~0.5 GB CUDA context): the plugin reports it to the service
        import torch as _t
        if _t.cuda.is_initialized():
            kw["mem"] = int(_t.cuda.memory_reserved(0) + 0.5e9)
    except Exception:  # noqa: BLE001
        pass
    _out.write("@@" + json.dumps(kw) + "\n"); _out.flush()


def progress(stage, frac=None):
    emit(progress=stage, frac=frac)


import torch
from PIL import Image, ImageOps


def open_rgb(p, side=2048):
    im = ImageOps.exif_transpose(Image.open(p)); im.thumbnail((side, side)); return im


def peak():
    return round(torch.cuda.max_memory_allocated() / 2**30, 2)


# ── RMBG-2.0 cutout (shared by Hunyuan) ──────────────────────────────────────
_rmbg = None
def cutout(im):
    global _rmbg
    from torchvision import transforms
    if _rmbg is None:
        from transformers import AutoModelForImageSegmentation
        _rmbg = AutoModelForImageSegmentation.from_pretrained("/imagegen/3d-models/RMBG-2.0", trust_remote_code=True).cuda().eval().half()
    if im.mode == "RGBA" and im.getextrema()[3][0] < 255:
        return im                                     # already cut out
    im = im.convert("RGB")
    tf = transforms.Compose([transforms.Resize((1024, 1024)), transforms.ToTensor(),
                             transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    with torch.no_grad():
        p = _rmbg(tf(im)[None].cuda().half())[-1].sigmoid()[0, 0].float().cpu()
    im.putalpha(transforms.ToPILImage()(p).resize(im.size)); return im


# ── adapters: load() -> state; run(state, inputs, out, opt) -> {"files": {...}, ...} ──
class Hunyuan:
    REPO = os.environ.get("IMAGE3D_REPO", "/opt/hunyuan3d21")     # cu128 envs use their own copy (in-tree extension)
    def load(self):
        # the repo root too: torchvision_fix.py lives there, and without it basicsr/realesrgan (texture stage) import
        # torchvision.transforms.functional_tensor, which newer torchvision removed (2026-11-04: a worker job died on it)
        sys.path[:0] = [self.REPO, f"{self.REPO}/hy3dshape", f"{self.REPO}/hy3dpaint"]; os.chdir(self.REPO)
        os.environ["HY3DGEN_MODELS"] = "/imagegen/3d-models"
        from torchvision_fix import apply_fix
        apply_fix()
        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
        self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained("Hunyuan3D-2.1")
        self.paint = None
        # shape (~8 GB) + paint (~13 GB) together peak ~20 GB (measured on a V100): on cards under 22 GB (5060 Ti 16 GB)
        # the shape pipeline waits in RAM while painting, and the paint pipeline is dropped after each job
        self.small = torch.cuda.get_device_properties(0).total_memory < 22e9
    def run(self, inputs, out, o):
        im = cutout(open_rgb(inputs[0])); im.save(f"{out}/input_rgba.png")
        if self.small:
            self.shape.to("cuda")
        progress("shape", 0.1)
        mesh = self.shape(image=im, num_inference_steps=int(o.get("steps", 50)), octree_resolution=int(o.get("octree", 384)),
                          generator=torch.manual_seed(int(o.get("seed", 1234))))[0]
        mesh.export(f"{out}/shape.glb")
        res = {"faces": int(len(mesh.faces))}
        if not o.get("texture", True):
            os.replace(f"{out}/shape.glb", f"{out}/model.glb"); return res
        progress("texture", 0.5)
        if self.small:
            self.shape.to("cpu"); torch.cuda.empty_cache()
        if self.paint is None:
            from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig
            c = Hunyuan3DPaintConfig(int(o.get("views", 6)), int(o.get("res", 512)))
            c.realesrgan_ckpt_path = "hy3dpaint/ckpt/RealESRGAN_x4plus.pth"; c.multiview_cfg_path = "hy3dpaint/cfgs/hunyuan-paint-pbr.yaml"
            c.custom_pipeline = "hy3dpaint/hunyuanpaintpbr"; c.multiview_pretrained_path = "/imagegen/3d-models/Hunyuan3D-2.1"
            if os.path.isdir("/imagegen/3d-models/dinov2-giant"):    # local copy: every host runs HF_HUB_OFFLINE
                c.dino_ckpt_path = "/imagegen/3d-models/dinov2-giant"
            self.paint = Hunyuan3DPaintPipeline(c)
        self.paint(mesh_path=f"{out}/shape.glb", image_path=f"{out}/input_rgba.png", output_mesh_path=f"{out}/textured.obj")
        if self.small:
            import gc
            self.paint = None; gc.collect(); torch.cuda.empty_cache()
        progress("export", 0.9)
        pbr_glb(f"{out}/textured.obj", f"{out}/textured.jpg", f"{out}/textured_metallic.jpg", f"{out}/textured_roughness.jpg", f"{out}/model.glb")
        return res


def pbr_glb(obj, albedo, metal, rough, dst):
    """Hunyuan's OBJ + separate maps -> one glTF PBR GLB (glTF packs roughness in G, metallic in B)."""
    import numpy as np, trimesh
    m = trimesh.load(obj, force="mesh", process=False)
    mr = None
    if os.path.exists(metal) and os.path.exists(rough):
        g = np.asarray(Image.open(rough).convert("L")); b = np.asarray(Image.open(metal).convert("L"))
        if g.shape != b.shape:
            b = np.asarray(Image.open(metal).convert("L").resize(g.shape[::-1]))
        mr = Image.fromarray(np.stack([np.zeros_like(g), g, b], -1))
    mat = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.open(albedo).convert("RGB"), metallicRoughnessTexture=mr,
                                              metallicFactor=1.0 if mr is not None else 0.0, roughnessFactor=1.0)
    m.visual = trimesh.visual.TextureVisuals(uv=m.visual.uv, material=mat)
    m.export(dst)


class Trellis:
    def load(self):
        sys.path.insert(0, "/opt/trellis2"); os.chdir("/opt/trellis2"); os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        # TRELLIS_MODEL_DIR = .../TRELLIS.2-4B-fp16 on cards without bf16 (V100): same weights, configs say float16
        self.pipe = Trellis2ImageTo3DPipeline.from_pretrained(os.environ.get("TRELLIS_MODEL_DIR", "/opt/trellis2/ailab-models/TRELLIS.2-4B"))
        self.pipe.cuda()
    def run(self, inputs, out, o):
        import o_voxel
        im = open_rgb(inputs[0])
        progress("generate", 0.1)
        kw = {"seed": int(o.get("seed", 42))}
        if o.get("pipeline"):
            kw["pipeline_type"] = o["pipeline"]
        mesh = self.pipe.run(im, **kw)[0]
        mesh.simplify(16777216)
        progress("export", 0.6)
        glb = o_voxel.postprocess.to_glb(vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
                                         attr_layout=mesh.layout, voxel_size=mesh.voxel_size, aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                                         decimation_target=int(o.get("faces", 1000000)), texture_size=int(o.get("texture_size", 4096)),
                                         remesh=True, remesh_band=1, remesh_project=0, verbose=False)
        glb.export(f"{out}/model.glb")
        del mesh, glb
        return {}


class UniForge:
    def load(self):
        sys.path.insert(0, "/opt/uniforge3d"); os.chdir("/opt/uniforge3d")
        from uniforge3d import UniForge3DImageTo3DPipeline
        self.pipe = UniForge3DImageTo3DPipeline.from_config(os.environ.get("UNIFORGE_CONFIG", "/opt/uniforge3d/ailab-models/pipeline.json"),
                                                            weights_root="/imagegen/3d-models/UniForge3D", low_vram=True, local_files_only=True)
    def run(self, inputs, out, o):
        from pathlib import Path
        progress("generate", 0.1)
        self.pipe.run([Path(p) for p in inputs], Path(out) / "model.glb", overwrite=True)
        return {}


class Idol:
    def load(self):
        sys.path.insert(0, "/opt/idol-sdk")
        from idol.pipeline import IdolPipeline
        # optimize=True produced input-independent purple blobs on torch 2.6/cu124 (2026-11-03); eager is correct
        self.pipe = IdolPipeline("/opt/idol-sdk/ailab-models/idol", optimize=False,
                                 dinov3_dtype=os.environ.get("IDOL_DINOV3_DTYPE", "bf16"))   # fp32 on V100 (no bf16)
    def run(self, inputs, out, o):
        progress("generate", 0.1)
        r = self.pipe(inputs[0], mode=o.get("mode", "real"), seed=int(o.get("seed", 42)),
                      num_gaussians=int(o.get("gaussians", 1048576)), verbose=False)
        r.gaussian.save_ply(f"{out}/model.ply"); r.preprocessed_image.save(f"{out}/input_rgba.png")
        return {}


ADAPTERS = {"hunyuan3d21": Hunyuan, "trellis2": Trellis, "uniforge3d": UniForge, "idol": Idol}

try:
    t = time.time(); ad = ADAPTERS[A.model](); ad.load()
    emit(ready=True, load_s=round(time.time() - t, 1), gpu=torch.cuda.get_device_name(0), torch=torch.__version__,
         cc=".".join(map(str, torch.cuda.get_device_capability(0))))
except Exception as e:  # noqa: BLE001
    traceback.print_exc(); emit(error=f"load failed: {type(e).__name__}: {e}"); sys.exit(1)

for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    if req.get("cmd") == "quit":
        break
    try:
        os.makedirs(req["out"], exist_ok=True); torch.cuda.reset_peak_memory_stats(); t = time.time()
        res = ad.run(req["inputs"], req["out"], req.get("options") or {}) or {}
        torch.cuda.empty_cache()
        emit(done={**res, "run_s": round(time.time() - t, 1), "peak_gb": peak()})
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(); torch.cuda.empty_cache()
        msg = f"{type(e).__name__}: {e}"
        emit(error=msg, fatal=any(w in msg for w in ("illegal memory access", "device-side assert", "unspecified launch failure")))
