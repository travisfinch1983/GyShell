"""claude1 2026-11-03: contact sheet for ANY textured GLB (TRELLIS.2, UniForge3D, ...), drawn with Hunyuan's
rasterizer. Row 1: input + base-colour views at azimuth 0/90/180/270; row 2: normal-shaded geometry.
Usage (hunyuan3d21 env): ailab-preview-glb.py <model.glb> <input.png> <out.png>"""
import os, sys
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hy3dpaint"))
import torch, numpy as np, trimesh
import torch.nn.functional as F
from PIL import Image
from DifferentiableRenderer.MeshRender import MeshRender, RenderConfig
glb, inp_p, out_p = sys.argv[1:4]; R = 512; AZ = (0, 90, 180, 270)
m = trimesh.load(glb, force="mesh", process=False)
mat = m.visual.material
tex = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
mr = MeshRender(default_resolution=R, texture_size=4096, device="cuda"); mr.load_mesh(m)
def albedo(az):
    vs = mr._create_view_state(RenderConfig(elev=15, azim=az, resolution=R))
    rast, _ = mr.raster_rasterize(vs.pos_clip, mr.pos_idx, resolution=vs.resolution)
    uv, _ = mr.raster_interpolate(mr.vtx_uv[None], rast, mr.uv_idx)
    t = torch.from_numpy(np.asarray(tex.convert("RGB")) / 255.0).float().cuda().permute(2, 0, 1)[None]
    col = F.grid_sample(t, (uv[..., :2] * 2 - 1).float(), align_corners=False)[0].permute(1, 2, 0)
    k = (rast[0, ..., -1:] > 0).float()
    return (col * k + (1 - k)).clamp(0, 1).cpu().numpy()
def shaded(az):
    return np.asarray(mr.render_normal(15, az, resolution=R, return_type="np", bg_color=[1, 1, 1]))[..., :3]
ii = Image.open(inp_p).convert("RGBA"); bg = Image.new("RGBA", ii.size, "white"); bg.alpha_composite(ii)
row1 = [np.asarray(bg.convert("RGB").resize((R, R))) / 255.0] + ([albedo(a) for a in AZ] if tex is not None else [np.ones((R, R, 3))] * 4)
row2 = [np.ones((R, R, 3))] + [shaded(a) for a in AZ]
Image.fromarray((np.concatenate([np.concatenate(row1, 1), np.concatenate(row2, 1)], 0) * 255).astype(np.uint8)).save(out_p)
print("wrote", out_p, "texture" if tex is not None else "NO texture")
