# CT172 `blender` (px-epyc, 10.0.0.31, DHCP)

Headless Blender 5.2.3 LTS for mesh processing. 16 cores, 32 GB, CPU only, no GPU. Created 2026-11-06.

- Blender: official tarball at `/opt/blender`. `pct exec` has no `/usr/local/bin` on PATH, so call `/opt/blender/blender`.
- Mounts: `/3d-outputs` read-only (imagegen 3D job outputs), `/blender` read-write (= `/imagegen/blender` on ai-epyc).
- `pynanoinstantmeshes` lives in `/opt/blender-tools/lib` (pip --target with Blender's own Python 3.13).
- `mesh_lines.py`: GLB -> voxel fuse -> smooth -> quads -> white-on-black line renders, 4 views.
  QuadriFlow cancels on the voxel output even with 0 non-manifold edges, so Instant Meshes is what actually runs.
  Instant Meshes' count argument is a vertex target and overshoots: `--faces 8000` gave about 31,000 quads.

Run:
`blender -b --factory-startup --python /opt/blender-tools/mesh_lines.py -- IN.glb OUT_DIR --faces 8000`
