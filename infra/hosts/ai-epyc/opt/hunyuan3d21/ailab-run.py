"""claude1 2026-11-03: Hunyuan3D-2.1 image->3D runner for the ai-epyc 4090.
Usage: ailab-run.py <image> <out_dir> [--no-texture] [--mesh shape.glb] [--views 6] [--res 512]
Writes shape.glb (+ textured.glb), and timings/peak VRAM to stats.json."""
import os, sys, time, json, argparse
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
REPO = os.path.dirname(os.path.abspath(__file__))
MODELS = "/imagegen/3d-models"
os.environ.setdefault("HY3DGEN_MODELS", MODELS)
sys.path[:0] = [os.path.join(REPO, "hy3dshape"), os.path.join(REPO, "hy3dpaint")]
os.chdir(REPO)
ap = argparse.ArgumentParser()
ap.add_argument("image"); ap.add_argument("out")
ap.add_argument("--no-texture", action="store_true")
ap.add_argument("--views", type=int, default=6); ap.add_argument("--res", type=int, default=512)
ap.add_argument("--steps", type=int, default=50); ap.add_argument("--octree", type=int, default=384)
ap.add_argument("--seed", type=int, default=1234)
ap.add_argument("--mesh", help="skip the shape stage and texture this existing mesh")
a = ap.parse_args()
import torch
from PIL import Image
try:
    from torchvision_fix import apply_fix; apply_fix()
except Exception as e:
    print("torchvision fix:", e)
from hy3dshape.rembg import BackgroundRemover
from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
os.makedirs(a.out, exist_ok=True)
stats = {"image": a.image, "gpu": torch.cuda.get_device_name(0), "args": vars(a)}
img = Image.open(a.image)
if img.mode != "RGBA" or img.getextrema()[3][0] == 255:
    img = BackgroundRemover()(img.convert("RGB"))
img.save(os.path.join(a.out, "input_rgba.png"))
shape_glb = os.path.join(a.out, "shape.glb")
if a.mesh:
    shape_glb = a.mesh
else:
  t = time.time()
  shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained("Hunyuan3D-2.1")
  stats["shape_load_s"] = round(time.time() - t, 1); t = time.time()
  mesh = shape(image=img, num_inference_steps=a.steps, octree_resolution=a.octree,
               generator=torch.manual_seed(a.seed))[0]
  stats["shape_s"] = round(time.time() - t, 1)
  stats["faces"] = int(len(mesh.faces)); stats["shape_peak_gb"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
  mesh.export(shape_glb)
  json.dump(stats, open(os.path.join(a.out, "stats.json"), "w"), indent=2)
  del shape; torch.cuda.empty_cache(); torch.cuda.reset_peak_memory_stats()
if not a.no_texture:
    from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig
    conf = Hunyuan3DPaintConfig(a.views, a.res)
    conf.realesrgan_ckpt_path = "hy3dpaint/ckpt/RealESRGAN_x4plus.pth"
    conf.multiview_cfg_path = "hy3dpaint/cfgs/hunyuan-paint-pbr.yaml"
    conf.custom_pipeline = "hy3dpaint/hunyuanpaintpbr"
    conf.multiview_pretrained_path = os.path.join(MODELS, "Hunyuan3D-2.1")
    t = time.time(); paint = Hunyuan3DPaintPipeline(conf); stats["paint_load_s"] = round(time.time() - t, 1)
    t = time.time()
    paint(mesh_path=shape_glb, image_path=os.path.join(a.out, "input_rgba.png"),
          output_mesh_path=os.path.join(a.out, "textured.obj"))
    stats["paint_s"] = round(time.time() - t, 1)
    # Blender (bpy) is not installed, so build the viewer GLB with trimesh: albedo only.
    # The full PBR set (metallic/roughness maps) stays next to textured.obj.
    import trimesh
    tm = trimesh.load(os.path.join(a.out, "textured.obj"), force="mesh")
    tm.export(os.path.join(a.out, "textured.glb"))
    stats["paint_peak_gb"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
json.dump(stats, open(os.path.join(a.out, "stats.json"), "w"), indent=2)
print(json.dumps(stats, indent=2))
