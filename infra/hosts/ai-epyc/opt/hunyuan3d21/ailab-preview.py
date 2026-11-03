"""claude1 2026-11-03: turntable contact sheet for a Hunyuan3D-2.1 result (no Blender needed).
Usage: ailab-preview.py <out_dir>   -> <out_dir>/preview.png
Row 1: input + textured.obj albedo at azimuth 0/90/180/270. Row 2: shape.glb normal-shaded, same views."""
import os, sys
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
REPO = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(REPO, "hy3dpaint"))
import torch, numpy as np, trimesh
import torch.nn.functional as F
from PIL import Image
from DifferentiableRenderer.MeshRender import MeshRender, RenderConfig
VFLIP = 1.0   # MeshRender UVs already match image row order: do NOT flip v (flipping scrambled the albedo)
out = sys.argv[1]; R = 512; AZ = (0, 90, 180, 270)
def albedo(mr, az):
    vs = mr._create_view_state(RenderConfig(elev=15, azim=az, resolution=R))
    rast, _ = mr.raster_rasterize(vs.pos_clip, mr.pos_idx, resolution=vs.resolution)
    uv, _ = mr.raster_interpolate(mr.vtx_uv[None], rast, mr.uv_idx)
    tex = mr.tex.permute(2, 0, 1)[None].float()
    grid = uv[..., :2] * 2 - 1
    grid = torch.stack([grid[..., 0], grid[..., 1] * VFLIP], -1)
    col = F.grid_sample(tex, grid, align_corners=False)[0].permute(1, 2, 0)
    m = (rast[0, ..., -1:] > 0).float()
    return (col * m + (1 - m)).clamp(0, 1).cpu().numpy()
def shaded(mr, az):
    n = mr.render_normal(15, az, resolution=R, return_type="np", bg_color=[1, 1, 1])
    return np.asarray(n)[..., :3]
tiles = [[], []]
inp = Image.open(os.path.join(out, "input_rgba.png")).convert("RGBA")
bg = Image.new("RGBA", inp.size, "white"); bg.alpha_composite(inp)
tiles[0].append(np.asarray(bg.convert("RGB").resize((R, R))) / 255.0)
tiles[1].append(np.ones((R, R, 3)))
if os.path.exists(os.path.join(out, "textured.obj")):
    mr = MeshRender(default_resolution=R, texture_size=4096, device="cuda")
    mr.load_mesh(trimesh.load(os.path.join(out, "textured.obj"), force="mesh", process=False))
    mr.set_texture(torch.from_numpy(np.asarray(Image.open(os.path.join(out, "textured.jpg")).convert("RGB")) / 255.0), force_set=True)
    tiles[0] += [albedo(mr, a) for a in AZ]
else:
    tiles[0] += [np.ones((R, R, 3))] * 4
sm = trimesh.load(os.path.join(out, "shape.glb"), force="mesh")
sm.visual = trimesh.visual.TextureVisuals(uv=np.zeros((len(sm.vertices), 2)))   # MeshRender requires UVs
mr = MeshRender(default_resolution=R, device="cuda"); mr.load_mesh(sm)
tiles[1] += [shaded(mr, a) for a in AZ]
sheet = np.concatenate([np.concatenate(r, 1) for r in tiles], 0)
Image.fromarray((sheet * 255).astype(np.uint8)).save(os.path.join(out, "preview.png"))
print("wrote", os.path.join(out, "preview.png"))
