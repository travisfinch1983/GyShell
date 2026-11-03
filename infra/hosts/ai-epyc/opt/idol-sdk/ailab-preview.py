"""claude1 2026-11-03: quick contact sheet for an Idol Gaussian splat: input + 4 views (azimuth 0/90/180/270,
15 deg elevation). Draws each Gaussian centre as an opaque dot with its DC colour, back to front. It's a
sanity check, not a real splat rasterizer (no anisotropy or alpha blending), so open splat.ply in a
splat viewer to judge quality. Usage: ailab-preview.py <out_dir>"""
import os, sys, numpy as np
from plyfile import PlyData
from PIL import Image
o = sys.argv[1]; R = 512
v = PlyData.read(os.path.join(o, "splat.ply"))["vertex"]
P = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float32)
C = np.clip(0.5 + 0.28209479 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1), 0, 1)
A = 1 / (1 + np.exp(-np.asarray(v["opacity"])))
keep = A > 0.3; P, C = P[keep], C[keep]
P -= (P.max(0) + P.min(0)) / 2; P /= np.abs(P).max() * 1.1
def view(az, el=15):
    a, e = np.radians(az), np.radians(el)
    Ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    Rx = np.array([[1, 0, 0], [0, np.cos(e), -np.sin(e)], [0, np.sin(e), np.cos(e)]])
    Q = P @ (Rx @ Ry).T
    img = np.ones((R, R, 3)); zb = np.full((R, R), -np.inf)
    x = ((Q[:, 0] + 1) / 2 * (R - 1)).astype(int); y = (((Q[:, 1] + 1) / 2) * (R - 1)).astype(int)        # the splat PLY is y-DOWN (3DGS/COLMAP convention)
    for dx in (0, 1):
        for dy in (0, 1):
            xx, yy = np.clip(x + dx, 0, R - 1), np.clip(y + dy, 0, R - 1)
            order = np.argsort(Q[:, 2])                       # far -> near, near wins
            img[yy[order], xx[order]] = C[order]
    return img
inp = Image.open(os.path.join(o, "input.png")).convert("RGBA"); bg = Image.new("RGBA", inp.size, "white"); bg.alpha_composite(inp)
tiles = [np.asarray(bg.convert("RGB").resize((R, R))) / 255.0] + [view(az) for az in (0, 90, 180, 270)]
Image.fromarray((np.concatenate(tiles, 1) * 255).astype(np.uint8)).save(os.path.join(o, "preview.png"))
print("wrote", os.path.join(o, "preview.png"), "points", len(P))
