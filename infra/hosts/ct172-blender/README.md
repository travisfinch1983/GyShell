# CT172 `blender` (px-epyc, 10.0.0.31, DHCP)

Headless Blender 5.2.3 LTS for mesh processing. 16 cores, 32 GB, CPU only, no GPU. Created 2026-11-06.

- Blender: official tarball at `/opt/blender`. `pct exec` has no `/usr/local/bin` on PATH, so call `/opt/blender/blender`.
- Mounts: `/3d-outputs` read-only (imagegen 3D job outputs), `/blender` read-write (= `/imagegen/blender` on ai-epyc).
- `pynanoinstantmeshes` lives in `/opt/blender-tools/lib` (pip --target with Blender's own Python 3.13).
- `mesh_lines.py`: GLB -> voxel fuse -> smooth -> quads -> white-on-black line renders, 4 views.
  QuadriFlow cancels on the voxel output even with 0 non-manifold edges, so Instant Meshes is what actually runs.
  `--faces` is divided by 4 before Instant Meshes: 8000 asked gave about 7,100 quads. Below about 30,000, wings and horns break up.

Run:
`blender -b --factory-startup --python /opt/blender-tools/mesh_lines.py -- IN.glb OUT_DIR --faces 8000`

## MCP server

`blender-mcp.service`, streamable HTTP on :8765 (`/mcp`), `blender_mcp.py` in a venv at `/opt/blender-tools/venv`, pinned to `mcp<2`.

- Access: bearer token AND client IP allowlist, both in `/etc/blender-mcp.env` (mode 600, never commit). Token is in the credential vault as "Blender MCP (CT172)".
- Allowed client: CT181 (10.0.0.161) only. Registered in CT181 root's local Claude config, NOT in MCPJungle, so no agent gets it through the gateway.
- Tools: list_meshes, render_lines, job_status, list_jobs, get_image, run_script.
- `run_script` runs arbitrary Blender Python. Before opening this to agents, set `BLENDER_MCP_ALLOW_SCRIPT=0`.
- Jobs write to `/blender/jobs/<id>` (= `/imagegen/blender/jobs` on ai-epyc). Job state is in memory; finished jobs persist as job.json.
