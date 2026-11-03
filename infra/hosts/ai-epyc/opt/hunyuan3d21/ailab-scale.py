"""claude1 2026-11-03: give a generated (unit-normalized) mesh real-world size.
Image-to-3D models output meshes normalized to a ~unit box; scale comes from a known dimension (spec sheet).
Usage: ailab-scale.py <in.glb|obj> <out.glb> [--length L] [--width W] [--height H] [--units ft|in|m|mm] [--stretch]
  Axes (Hunyuan/TRELLIS convention): height = Y (up), length = longest horizontal extent, width = the other one.
  Default: ONE uniform scale factor (keeps the model's proportions); with several dims given it uses their
  average ratio and prints how far each axis is off, so you can see the model's proportion error.
  --stretch: scale each axis independently to hit every given dimension exactly (distorts details).
Output is in METRES (glTF's unit), base on the ground plane, centred."""
import sys, argparse
import numpy as np, trimesh
U = {"m": 1.0, "mm": 0.001, "ft": 0.3048, "in": 0.0254}
ap = argparse.ArgumentParser(); ap.add_argument("src"); ap.add_argument("dst")
for k in ("length", "width", "height"): ap.add_argument("--" + k, type=float)
ap.add_argument("--units", default="ft", choices=U); ap.add_argument("--stretch", action="store_true")
a = ap.parse_args()
scene = trimesh.load(a.src)                       # keep materials/textures
geo = scene.dump(concatenate=True) if isinstance(scene, trimesh.Scene) else scene
ext = geo.bounding_box.extents                    # x, y, z
horiz = [0, 2]; li = horiz[int(np.argmax(ext[horiz]))]; wi = horiz[0] if li == 2 else 2
axis = {"length": li, "width": wi, "height": 1}
want = {k: getattr(a, k) * U[a.units] for k in axis if getattr(a, k)}
if not want: sys.exit("give at least one of --length/--width/--height")
S = np.ones(3)
if a.stretch:
    ratios = {k: v / ext[axis[k]] for k, v in want.items()}
    s = float(np.mean(list(ratios.values()))); S[:] = s
    for k, r in ratios.items(): S[axis[k]] = r
else:
    S[:] = float(np.mean([v / ext[axis[k]] for k, v in want.items()]))
M = np.diag(list(S) + [1.0])
scene.apply_transform(M)
b = scene.bounds; scene.apply_translation([-(b[0][0] + b[1][0]) / 2, -b[0][1], -(b[0][2] + b[1][2]) / 2])
scene.export(a.dst)
new = ext * S
print("result (%s): length %.2f  width %.2f  height %.2f" % (a.units, *(new[[li, wi, 1]] / U[a.units])))
for k, v in want.items():
    print("  %-6s wanted %.2f, got %.2f (%+.1f%%)" % (k, v / U[a.units], new[axis[k]] / U[a.units], 100 * (new[axis[k]] / v - 1)))
